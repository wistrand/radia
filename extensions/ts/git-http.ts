// A workspace's git history, over HTTP, for `git clone`.
//
// BOTH PROTOCOLS, and the order they were built in is the point. The DUMB one needs no protocol
// code at all — `writeBareRepo` already emits every file it asks for — so it shipped first and
// answered whether a URL works end to end. It costs one HTTP round trip per object: measured on a
// realistic code-generation history (22 versions of a 9-file tree) that is 96 objects and 98
// requests, which is nothing locally and five seconds at 50ms.
//
// The SMART one replaces that with two requests and a packfile, and is what git actually uses here:
// a client asks for `info/refs?service=git-upload-pack` and takes the smart path whenever the
// response is an `x-git-upload-pack-advertisement`. The dumb routes stay served, because they cost
// two `if`s and they are what anything without a git client (curl, a browser, a static mirror) can
// still read. See `git-pack.ts` for the protocol itself.
//
// READ-ONLY, and `git push` is refused in words rather than by 404. Push means reading packfiles —
// delta chains, the half of git's complexity export never touches — and it reopens the export-only
// decision from the outside, which rests on SHA-1 staying out of the attestation chain and on git
// history being rewritable while records are not.
//
// NO RUNTIME CHANGE AND NO WIRE-CONTRACT CHANGE. This binds its own port and talks `/v0` like any
// other client, which is what keeps `src/server` from learning what a workspace is. The same
// reasoning made `workspace-git` a client verb rather than an endpoint.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { buildWorkspaceRepo, type GitExportOptions, type GitRepo, gitLooseBytes } from "./git.ts";
import { advertisement, parseUploadPack, uploadPackError, uploadPackResponse } from "./git-pack.ts";

export interface GitServeOptions extends GitExportOptions {
  /** How many built repositories to keep. Each holds one workspace's whole object set in memory. */
  cache?: number;
}

/** What a request resolved to, for the caller's log. `bytes` is 0 for anything but a body. */
export interface GitServeLog {
  status: number;
  workspace?: string;
  path: string;
  bytes: number;
  /**
   * A 401 that offered NO credentials, which is the ordinary opening move of HTTP Basic rather than
   * a refusal: git asks, gets challenged, and asks again with the password. Reporting it as an error
   * turned every successful clone into a wall of alarming lines and buried the ones that mattered.
   */
  challenge?: true;
}

/**
 * How a request resolves to a client.
 *
 * `startsFetch` is true for `info/refs`, which git always asks for first, and it is how revocation
 * stays prompt without costing a round trip per object. A resolver that caches clients (it should:
 * otherwise every object request exchanges the credential and writes an `agent_run` record) must
 * RE-AUTHENTICATE when this is set, and may reuse a cached client otherwise.
 *
 * The resulting guarantee is exact and worth stating: a revoked credential cannot START a fetch, and
 * one already in flight finishes. Anything stronger would mean re-verifying per object, and anything
 * weaker leaves a clone URL working after `radia revoke` for as long as the cache lives.
 */
export type ClientFor = (req: Request, opts: { startsFetch: boolean }) => RadiaClient | null | Promise<RadiaClient | null>;

/**
 * Serve one space's workspaces at `/<name>.git/…`.
 *
 * `clientFor` is asked on every request, so authorization is the CALLER's rather than the server's:
 * a clone reads exactly the workspaces and artifacts that credential could read. Returning `null` is
 * a 401.
 */
export function gitHandler(
  clientFor: ClientFor,
  opts: GitServeOptions = {},
  onLog?: (entry: GitServeLog) => void,
): (req: Request) => Promise<Response> {
  const cache = new RepoCache(opts.cache ?? 4);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const log = (status: number, workspace?: string, bytes = 0) =>
      onLog?.({
        status,
        workspace,
        path,
        bytes,
        // A 401 is only news when the caller actually presented something.
        ...(status === 401 && !req.headers.get("authorization") ? { challenge: true as const } : {}),
      });

    // `git push` runs `git-receive-pack`, which is the one thing this will never do. Say so: a 404
    // reads as a missing feature and sends the person looking for a flag.
    if (path.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack") {
      log(403);
      return text(
        403,
        "this repository is export-only: a Radia workspace is the storage of record and git is a projection of it.\n" +
          "Change the tree with edit_workspace (or the workspace SDK); the next version appears here as a new commit.\n",
      );
    }

    const route = parse(path, url.searchParams.get("service"));
    if (!route) {
      log(404);
      return text(404, "expected /<workspace>.git/info/refs, /<workspace>.git/HEAD or /<workspace>.git/objects/xx/…\n");
    }
    // A POST, for the one route that is one: `git-upload-pack` carries the client's wants in its
    // body. Everything else is a read and stays a read.
    const wantsPost = route.kind === "upload-pack";
    if (wantsPost ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") {
      log(405, route.workspace);
      return text(405, "read-only\n");
    }

    let client: RadiaClient | null;
    try {
      // Both advertisement routes start a fetch. The `git-upload-pack` POST that follows does not:
      // it is the second half of one the advertisement already authenticated, and re-authenticating
      // there would mint a second run per clone for no extra guarantee.
      client = await clientFor(req, { startsFetch: route.kind === "refs" || route.kind === "smart-refs" });
    } catch {
      // A credential that cannot be exchanged (revoked, expired, wrong) is an authentication
      // failure, not a server error. Anything else here would tell a clone to retry.
      client = null;
    }
    if (!client) {
      log(401, route.workspace);
      return new Response(
        "authenticate with a definition token as the password:\n" +
          "  git clone http://<you>:<definition-token>@<host>/<workspace>.git\n" +
          "`radia login <principal>` mints and stores one.\n",
        // The realm is what makes `git` prompt rather than fail, and what a credential helper keys on.
        { status: 401, headers: { "www-authenticate": `Basic realm="radia"`, "content-type": "text/plain" } },
      );
    }

    let repo: GitRepo;
    try {
      repo = await cache.get(route.workspace, client, opts);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      // A workspace this credential cannot see and one that does not exist are the same answer, on
      // purpose: a clone URL must not become an existence oracle for somebody else's trees.
      const missing = /no workspace named/.test(message);
      log(missing ? 404 : 500, route.workspace);
      return text(missing ? 404 : 500, `${message}\n`);
    }

    if (route.kind === "smart-refs") {
      const body = advertisement(repo.branches, repo.head);
      log(200, route.workspace, body.length);
      return new Response(body as Uint8Array<ArrayBuffer>, {
        headers: {
          // The content type IS the protocol negotiation: a client that does not see exactly this
          // falls back to the dumb walk, silently and slowly.
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        },
      });
    }

    if (route.kind === "upload-pack") {
      const asked = parseUploadPack(new Uint8Array(await req.arrayBuffer()));
      // A want this repository does not hold means the client is working from an advertisement that
      // has moved on, or asking for somebody else's history. Say so rather than sending a pack that
      // silently lacks it, which git reports as a confusing "did not send all necessary objects".
      const missing = asked.wants.filter((w) => !repo.objects.has(w));
      if (asked.wants.length === 0 || missing.length > 0) {
        const body = uploadPackError(
          missing.length > 0
            ? `${missing[0]} is not in this workspace's history (it may have moved; fetch again)`
            : "no wants",
        );
        log(200, route.workspace, body.length);
        return new Response(body as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" },
        });
      }
      // EVERY object, not just the ones reachable from the wants. The repository is one workspace's
      // whole history and every object in it is reachable from some branch head, so the difference
      // is a fetch that already has some of them receiving a few it did not need.
      const body = await uploadPackResponse(repo.objects.values());
      log(200, route.workspace, body.length);
      return new Response(body as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" },
      });
    }

    if (route.kind === "refs") {
      // `<sha>\t<ref>` per line, sorted. Every head, so a forked workspace clones with its forks
      // visible as branches rather than silently collapsing to one.
      const body = Object.entries(repo.branches)
        .map(([branch, commit]) => `${commit}\trefs/heads/${branch}\n`)
        .sort()
        .join("");
      log(200, route.workspace, body.length);
      // `no-cache` on every route: a workspace gains versions, and a client that cached the old
      // advertisement asks for objects while believing an older head.
      return text(200, body);
    }

    if (route.kind === "head") {
      const body = `ref: refs/heads/${repo.head}\n`;
      log(200, route.workspace, body.length);
      return text(200, body);
    }

    const object = repo.objects.get(route.id!);
    if (!object) {
      log(404, route.workspace);
      return text(404, "no such object\n");
    }
    const bytes = await gitLooseBytes(object.type, object.payload);
    log(200, route.workspace, bytes.length);
    return new Response(req.method === "HEAD" ? null : (bytes as Uint8Array<ArrayBuffer>), {
      headers: {
        // What git's dumb walker expects for a loose object. `x-git-loose-object` is the documented
        // type; the bytes are zlib either way.
        "content-type": "application/x-git-loose-object",
        "content-length": String(bytes.length),
        // A loose object is named by the hash of its contents, so it can never change. This is the
        // one thing here worth caching hard, and it is what makes a re-clone cheap.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  };
}

interface Route {
  workspace: string;
  kind: "refs" | "smart-refs" | "upload-pack" | "head" | "object";
  id?: string;
}

/** `/<name>.git/<rest>` → what was asked for. `.git` is optional, since people type both. */
function parse(path: string, service: string | null): Route | null {
  const m = path.match(/^\/([^/]+?)(?:\.git)?\/(.+)$/);
  if (!m) return null;
  const [, workspace, rest] = m;
  if (!workspace || workspace.startsWith(".")) return null;
  if (rest === "git-upload-pack") return { workspace, kind: "upload-pack" };
  if (rest === "info/refs") return { workspace, kind: service === "git-upload-pack" ? "smart-refs" : "refs" };
  if (rest === "HEAD") return { workspace, kind: "head" };
  // Exactly git's layout: two hex characters of the id as a directory, the other 38 as the file.
  const object = rest.match(/^objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
  if (object) return { workspace, kind: "object", id: object[1] + object[2] };
  // `objects/info/packs` is not served: it lists PACKFILES and there are none. Git treats a 404
  // here as "no packs", which is the truth, so answering it would only be a slower way to say so.
  return null;
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
  });
}

/**
 * Built repositories, kept in memory.
 *
 * Git object ids are recomputed at build time and thrown away (never stored, so SHA-1 stays out of
 * the attestation chain), which means every clone would otherwise re-fetch and re-hash the entire
 * history — once per OBJECT REQUEST under the dumb protocol, which is unusable. So the build is
 * cached, keyed by the workspace and by the credential that built it, because two callers may be
 * allowed to see different histories of the same tree.
 *
 * A SNAPSHOT PER BUILD, deliberately. The advertisement and the objects have to describe one version
 * set: a version landing between them makes the client ask for a commit the server does not have and
 * the clone dies halfway. Freshness is bounded by the entry's age instead, so a `git pull` a minute
 * later sees the new head.
 */
class RepoCache {
  private readonly entries = new Map<string, { at: number; repo: Promise<GitRepo> }>();
  /** How long a built repository stays authoritative. Long enough to serve a whole clone from one
   *  snapshot; short enough that a pull after an edit sees it. */
  private readonly ttlMs = 60_000;

  constructor(private readonly max: number) {}

  get(workspace: string, client: RadiaClient, opts: GitExportOptions): Promise<GitRepo> {
    const key = `${workspace} ${credentialKey(client)}`;
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.repo;
    // Stored before it resolves, so the burst of object requests a clone makes shares ONE build
    // rather than starting one each.
    const repo = buildWorkspaceRepo(client, workspace, opts);
    repo.catch(() => this.entries.delete(key)); // a failed build must not be cached
    this.entries.set(key, { at: Date.now(), repo });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return repo;
  }
}

/** Which credential built a repository. Not the token: only enough to tell two callers apart, since
 *  this lives in a map that is dumped in a stack trace like anything else. */
function credentialKey(client: RadiaClient): string {
  const auth = (client as unknown as { auth?: { token?: string; definitionToken?: string } }).auth ?? {};
  const secret = auth.definitionToken ?? auth.token ?? "";
  let h = 2166136261;
  for (let i = 0; i < secret.length; i++) h = Math.imul(h ^ secret.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** The password from an `Authorization: Basic` header, which is where git puts a token. */
export function basicPassword(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return undefined;
  try {
    // `user:password`, and only the password matters: the space authenticates a TOKEN, and the
    // username is whatever the person typed into the URL.
    const decoded = atob(encoded);
    const colon = decoded.indexOf(":");
    return colon < 0 ? undefined : decoded.slice(colon + 1) || undefined;
  } catch {
    return undefined;
  }
}
