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
// PUSH TOO, fast-forward only (`git-push.ts`). A pushed commit's tree becomes the next version
// through `writeWorkspace`, so the space keeps receiving sha256 artifacts and manifests and never a
// git object; a non-fast-forward, a merge or a new branch is refused in the `ng` line git prints,
// which is a protected branch's behaviour and why no merge exists here. The pack reader that makes
// this possible (`git-pack.ts`) recomputes every id from the bytes, so a pack cannot
// alias objects, and the commit bytes ride on the version so the re-export reproduces the pusher's
// ids: `git fetch` after `git push` is a no-op.
//
// NO RUNTIME CHANGE AND NO WIRE-CONTRACT CHANGE. This binds its own port and talks `/v0` like any
// other client, which is what keeps `src/server` from learning what a workspace is. The same
// reasoning made `workspace-git` a client verb rather than an endpoint.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { buildWorkspaceRepo, type GitExportOptions, type GitObject, type GitRepo, gitLooseBytes } from "./git.ts";
import {
  advertisement,
  parseReceivePack,
  parseUploadPack,
  readPack,
  receiveAdvertisement,
  receiveReport,
  uploadPackError,
  uploadPackResponse,
} from "./git-pack.ts";
import { acceptPush } from "./git-push.ts";

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
 * The password in a clone or push URL, as a client. Either half of a credential works:
 *
 *   - a DEFINITION token, durable and mint-only, exchanged here for a run per fetch. What `radia
 *     login <principal>` stores and what belongs in a `.git/config` that outlives a session;
 *   - a RUN token, which is all an SSO sign-in has (`radia login --sso`): no durable half exists for
 *     it on purpose, so IdP deprovisioning bites within one run ceiling. It is used as it is, and
 *     when it lapses git meets a 401 and the person signs in again.
 *
 * Tried in that order: a run token cannot mint, so presenting one as a definition fails and falls
 * through; a live definition never reaches the second step, and a revoked one resolves to nothing
 * there. The second step also admits the operator credential `radia dev` wrote, which is what the
 * CLI's own verbs use on a laptop with no login. Throws when the space resolves the password to no
 * principal at all, which the caller turns into a 401.
 */
export async function clientForPassword(base: string, password: string): Promise<RadiaClient> {
  const asDefinition = new RadiaClient(base, { definitionToken: password });
  try {
    await asDefinition.ensureCredential();
    return asDefinition;
  } catch {
    // not a live definition token; a run or operator token is the other thing a URL can carry
  }
  const asIs = new RadiaClient(base, { token: password });
  const h = await asIs.health(); // 401 for a token that resolves to nothing, or to a stopped run
  if (!h.principal) throw new Error("the password resolves to no principal");
  return asIs;
}

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

    const route = parse(path, url.searchParams.get("service"));
    if (!route) {
      log(404);
      return text(404, "expected /<workspace>.git/info/refs, /<workspace>.git/HEAD or /<workspace>.git/objects/xx/…\n");
    }
    // A POST for the two routes that carry a body: `git-upload-pack` (the client's wants) and
    // `git-receive-pack` (ref updates and a pack). Everything else is a read and stays a read.
    const wantsPost = route.kind === "upload-pack" || route.kind === "receive-pack";
    if (wantsPost ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") {
      log(405, route.workspace);
      return text(405, wantsPost ? "POST only\n" : "read-only\n");
    }

    let client: RadiaClient | null;
    try {
      // Both advertisement routes start a fetch. The `git-upload-pack` POST that follows does not:
      // it is the second half of one the advertisement already authenticated, and re-authenticating
      // there would mint a second run per clone for no extra guarantee.
      client = await clientFor(req, { startsFetch: route.kind === "refs" || route.kind === "smart-refs" || route.kind === "receive-refs" });
    } catch {
      // A credential that cannot be exchanged (revoked, expired, wrong) is an authentication
      // failure, not a server error. Anything else here would tell a clone to retry.
      client = null;
    }
    if (!client) {
      log(401, route.workspace);
      return new Response(
        "authenticate with a token as the password:\n" +
          "  git clone http://<you>:<token>@<host>/<workspace>.git\n" +
          "A definition token (`radia login <principal> --compact-definition`) outlives a session;\n" +
          "an SSO run token (`radia login --sso --compact`) lasts until its run ceiling.\n",
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

    if (route.kind === "receive-refs") {
      const body = receiveAdvertisement(repo.branches);
      log(200, route.workspace, body.length);
      return new Response(body as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-cache" },
      });
    }

    if (route.kind === "receive-pack") {
      // Answers travel in the report, per ref, because that is what git prints beside the ref. A
      // pack that cannot be read fails every ref at once and says why in the `unpack` line.
      const headers = { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" };
      let parsed: ReturnType<typeof parseReceivePack>;
      try {
        parsed = parseReceivePack(new Uint8Array(await req.arrayBuffer()));
      } catch (e) {
        const body = receiveReport((e as Error).message, []);
        log(200, route.workspace, body.length);
        return new Response(body as Uint8Array<ArrayBuffer>, { headers });
      }
      let objects = new Map<string, GitObject>();
      if (parsed.pack) {
        try {
          objects = await readPack(parsed.pack, (id) => repo.objects.get(id));
        } catch (e) {
          const body = receiveReport((e as Error).message, parsed.commands.map((c) => ({ ref: c.ref, ok: false, message: "pack rejected" })));
          log(200, route.workspace, body.length);
          return new Response(body as Uint8Array<ArrayBuffer>, { headers });
        }
      }
      let results;
      try {
        results = await acceptPush(client, repo, route.workspace, objects, parsed.commands, opts);
      } finally {
        // The snapshot every build here is has been overtaken, for EVERY credential: by the versions
        // a push wrote, or by whatever made it stale enough to refuse. Either way the next
        // advertisement must be rebuilt, or the pusher's own fetch keeps seeing the old tip.
        cache.invalidate(route.workspace);
      }
      const body = receiveReport("ok", results);
      log(200, route.workspace, body.length);
      return new Response(body as Uint8Array<ArrayBuffer>, { headers });
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
  kind: "refs" | "smart-refs" | "upload-pack" | "receive-refs" | "receive-pack" | "head" | "object";
  id?: string;
}

/** `/<name>.git/<rest>` → what was asked for. `.git` is optional, since people type both. */
function parse(path: string, service: string | null): Route | null {
  const m = path.match(/^\/([^/]+?)(?:\.git)?\/(.+)$/);
  if (!m) return null;
  const [, workspace, rest] = m;
  if (!workspace || workspace.startsWith(".")) return null;
  if (rest === "git-upload-pack") return { workspace, kind: "upload-pack" };
  if (rest === "git-receive-pack") return { workspace, kind: "receive-pack" };
  if (rest === "info/refs") {
    return { workspace, kind: service === "git-upload-pack" ? "smart-refs" : service === "git-receive-pack" ? "receive-refs" : "refs" };
  }
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

  /** Drop every build of one workspace, whoever built it: its history just grew. */
  invalidate(workspace: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${workspace}\0`)) this.entries.delete(key);
    }
  }

  get(workspace: string, client: RadiaClient, opts: GitExportOptions): Promise<GitRepo> {
    const key = `${workspace}\0${credentialKey(client)}`; // NUL: a workspace name can hold a space
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
    // username is whatever the person typed into the URL. Split at the LAST colon: a token never
    // holds one, a principal does (`human:oidc-…`), and splitting at the first handed the server
    // `oidc-…:<token>` as the password and refused every SSO clone.
    const decoded = atob(encoded);
    const colon = decoded.lastIndexOf(":");
    return colon < 0 ? undefined : decoded.slice(colon + 1) || undefined;
  } catch {
    return undefined;
  }
}
