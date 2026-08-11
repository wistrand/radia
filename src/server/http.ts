// HTTP surface. No framework (minimal-deps invariant); the server binding lives behind
// `src/platform.ts`. Two planes under /v0:
//   - coordination (frozen v0-stable): records (put/read_one/query), takes, leases, watches,
//     health. This is what agents use to do work. Kinds are declared THROUGH this plane: a kind
//     is a kind_def record (POST /v0/records), discovered by query. There is no dedicated kinds
//     endpoint.
//   - observability + control (experimental, grant-gated with real auth): /v0/ops/* covers
//     stats, events, diagnostics, record + envelope introspection (records[/{id}[/envelope|
//     lineage|graph]]), and remediation (reclaim/dead-letter/requeue). Reading/operating the
//     space. The prefix split carries both the stability boundary and the (future) auth boundary.
//   - bootstrap chain: POST /v0/agent-definitions (operator → mint token + grants), POST
//     /v0/agent-runs (definition token → short-lived run token), POST /v0/agent-runs/{id}/stop.
//     Requests authenticate with `Authorization: Bearer <run-token>`; see design-auth.md.

import type { Space } from "../core/space.ts";
import type { OpsPower } from "../core/kinds.ts";
import { handlePut, handleQuery, handleReadOne } from "./handlers/records.ts";
import { handleAck, handleNack, handleRelease, handleRenew, handleTake } from "./handlers/leases.ts";
import { handleCreateDefinition, handleCreateRun, handleRenewRun, handleRevokeDefinition, handleStopRun } from "./handlers/agents.ts";
import { handleGetArtifact, handleMintCapability, handleMintPathCapability, handlePutArtifact, handleShredArtifact } from "./handlers/artifacts.ts";
import { handleRemediate, handleAdmin, handleGc, handleChildren, handleDeclassify, handleDiagnostics, handleEnvelope, handleErasures, handleEnvelopeQuery, handleEvents, handleDigest, handleDryRun, handleFlows, handleIntegrity, handleGetRecord, handleGraph, handleLineage, handleThread, handlePermissions, handleStats } from "./handlers/ops.ts";
import { handleCreateWatch, handleWatchEvents } from "./handlers/watches.ts";
import { problem, statusFor } from "./problem.ts";
import { RadiaError } from "../core/errors.ts";
import type { StatsScope } from "../storage/adapter.ts";
import { moduleRelative, readTextFile, serve } from "../platform.ts";

export interface ServerOptions {
  port: number;
  space: Space;
  signal?: AbortSignal;
  /** Bind address. Defaults to loopback (`127.0.0.1`). The API's no-header operator default is
   *  only safe locally; pass `0.0.0.0` to deliberately expose it (and prefer `authRequired`). */
  host?: string;
  /** When true, a request with no `Authorization` is rejected (`401`) instead of resolving to the
   *  operator. `GET /` (console) and `GET /v0/health` stay public so the console can bootstrap. */
  authRequired?: boolean;
  /** Port for the isolated artifact origin. Omit to serve artifact bytes only from the main
   *  origin, where scriptable types stay downloads. */
  artifactPort?: number;
}

/** The dev UI, loaded once at startup. Single file (see src/ui/index.html); the only asset it
 *  pulls is the vendored bundle below, lazily, when the Space tab is first opened.
 *
 *  Never inject a credential into this page. `GET /` is public so the console can bootstrap in
 *  required mode, which means anything baked in is readable by anyone who can reach the port.
 *  An operator token harvested that way authorizes every verb. The console asks for one and
 *  keeps it in `sessionStorage` instead. */
function loadUi(): string {
  return readTextFile(moduleRelative(import.meta.url, "../ui/index.html")) ??
    "<!doctype html><title>radia</title><p>dev UI not found (src/ui/index.html).</p>";
}

/** Vendored browser assets served under `/ui/` (see src/ui/vendor/README.md). Prebuilt and
 *  checked in (no build step). Loaded once at startup; empty string if the file is missing
 *  (the Space tab then reports the asset as unavailable and the rest of the console works). */
function loadVendor(name: string): string {
  return readTextFile(moduleRelative(import.meta.url, `../ui/vendor/${name}`)) ?? "";
}

/** The ops paths a SELF-SCOPED (non-operator) principal may reach: reads only. Everything else on
 *  the plane (remediate, reclaim/dead-letter/requeue, declassify) is the interrupt half and stays
 *  operator-only. */
const READ_ONLY_OPS =
  /^\/v0\/ops\/(stats|events|diagnostics|digest|flows|records(\/[^/]+(\/(envelope|lineage|children|graph|thread))?)?)$/;

/** The ops WRITE half, each verb mapped to the power it demands (architecture-ops-tiers.md). Everything
 *  unmapped is a read and needs `observe` (or falls to the self-scope tier). `POST /v0/ops/gc` is
 *  deliberately absent: its dry run is a read, so the live/dry split is decided in `handleGc`
 *  after the body is parsed. `POST /v0/ops/dry-run` is a read despite the method. */
function requiredOpsPower(method: string, path: string): OpsPower | null {
  if (method !== "POST") return null;
  if (path === "/v0/ops/remediate") return "remediate";
  const m = path.match(/^\/v0\/ops\/records\/[^/]+\/(reclaim|dead-letter|requeue|declassify|shred)$/);
  if (!m) return null;
  if (m[1] === "declassify") return "declassify";
  if (m[1] === "shred") return "purge";
  return "remediate";
}

export function startServer(opts: ServerOptions): { finished: Promise<void> } {
  const hostname = opts.host ?? "127.0.0.1"; // loopback by default; --host 0.0.0.0 to expose
  const handler = makeHandler(opts.space, loadUi(), opts.authRequired ?? false);
  const { finished } = serve({ port: opts.port, hostname, signal: opts.signal }, handler);
  console.log(`radia dev listening on http://${hostname}:${opts.port} (web console at /). Auth ${opts.authRequired ? "required" : "open (no-header → operator)"}`);

  // Artifact BYTES get their own origin. An origin is scheme + host + PORT, so a second port is a
  // different origin to a browser: content served here cannot read the console's storage and its
  // requests back to the API are cross-origin, which no CORS header permits. That is what makes it
  // safe to render an artifact someone's agent generated.
  //
  // Capability URLs are the ONLY way in. No bearer token is ever presented to this origin, so
  // there is no credential here to steal, and a capability names one artifact and expires.
  if (opts.artifactPort !== undefined) {
    // Tell the space where to point capability URLs. Loopback is reachable as-is; a wildcard bind
    // has no single public name, so 127.0.0.1 is the honest default for a local console.
    const advertised = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
    opts.space.artifactOrigin = `http://${advertised}:${opts.artifactPort}`;
    const bytes = makeArtifactHandler(opts.space);
    serve({ port: opts.artifactPort, hostname, signal: opts.signal }, bytes);
    console.log(`radia dev: artifact origin http://${hostname}:${opts.artifactPort} (capability URLs only, isolated from the console)`);
  }
  return { finished };
}

/**
 * The isolated artifact origin: capability-authenticated bytes, and nothing else.
 *
 * Deliberately tiny. It serves one route and rejects everything else, so no control-plane surface
 * is reachable from the origin that renders untrusted content. Never add a route here that reads a
 * token: the value of this origin is that presenting a credential to it is impossible.
 */
export function makeArtifactHandler(space: Space) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // SHORT FORM, and the one anybody is actually given: `/a/<capability>`. The capability already
    // names exactly one record, so repeating the id and spelling out `?capability=` added ~70
    // characters to a URL a person is shown, pastes, and occasionally reads aloud. The long form
    // below still works; this is the one that gets handed over.
    if (req.method === "GET" && url.pathname.startsWith(SHORT_ARTIFACT_PREFIX)) {
      const cap = decodeURIComponent(url.pathname.slice(SHORT_ARTIFACT_PREFIX.length));
      const id = space.resolveDownloadCapability(cap);
      if (!id) return capabilityRefused(space);
      return await handleGetArtifact(space, id, null, true);
    }
    // A TREE, addressed by path: `/v0/w/<capability>/<path>`. A browser resolves `./style.css`
    // against the URL PATH, so one opaque token per artifact cannot serve a multi-file page however
    // many capabilities you mint. The runtime knows nothing about workspaces here — a capability
    // carries a path index somebody else built, and this looks a path up in it.
    //
    // Traversal is not defended against because it cannot happen: the lookup is an exact match in a
    // fixed map. `..`, an absolute path and an encoded separator all simply miss.
    if (req.method === "GET" && url.pathname.startsWith(TREE_PREFIX)) {
      const rest = url.pathname.slice(TREE_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return capabilityRefused(space);
      const cap = decodeURIComponent(rest.slice(0, slash));
      // A bare directory serves `index.html`, the one convention a site needs and the only one.
      const raw = rest.slice(slash + 1);
      const path = decodeURIComponent(raw === "" || raw.endsWith("/") ? `${raw}index.html` : raw);
      // A browser asks for this on every navigation and it is never in a tree. Answering 404 is
      // correct and fills the console with a blocked-resource warning that looks like a real fault;
      // 204 says "there isn't one" without the noise.
      if (path === "favicon.ico" && !space.resolveCapabilityPath(cap, path)) {
        return new Response(null, { status: 204 });
      }
      const id = space.resolveCapabilityPath(cap, path);
      // One answer for an unknown capability, an expired one and a path that is not in the tree: a
      // probe must not be able to map what a tree contains.
      if (!id) return capabilityRefused(space);
      // The origin is passed so the page may load ITS OWN files: `'self'` matches nothing in a
      // sandboxed opaque document, so the policy has to name the host.
      return await handleGetArtifact(space, id, null, true, space.artifactOrigin);
    }
    const capability = url.searchParams.get("capability");
    if (req.method !== "GET" || !url.pathname.startsWith("/v0/artifacts/")) {
      return problem(404, "not_found", "this origin serves artifact bytes by capability URL only");
    }
    const id = decodeURIComponent(url.pathname.slice("/v0/artifacts/".length));
    if (!capability || !space.checkDownloadCapability(capability, id)) {
      return problem(
        403,
        "forbidden",
        `this origin accepts only capability URLs, and this one is missing, wrong or expired. ` +
          `Capabilities last ${space.downloadCapabilitySeconds}s and do not survive a restart; mint a fresh one.`,
      );
    }
    return await handleGetArtifact(space, id, null, true);
  };
}

/** The short capability route, on both origins. Terse because it is the visible half of the URL
 *  length problem, but still under `/v0`: a root-level path would save three characters and buy an
 *  unversioned public surface with no evolution story. */
export const SHORT_ARTIFACT_PREFIX = "/v0/a/";
/** `/v0/w/<capability>/<path>`: a SET of artifacts addressed by path. `w` for the shape a caller
 *  sees (a working tree), not for anything the runtime knows about one. */
export const TREE_PREFIX = "/v0/w/";

/** One wording for a capability that is missing, wrong or lapsed, so the two origins cannot drift
 *  into explaining the same failure differently. */
function capabilityRefused(space: Space): Response {
  return problem(
    403,
    "forbidden",
    `this capability is missing, wrong or expired. Capabilities last ` +
      `${space.downloadCapabilitySeconds}s and do not survive a restart; mint a fresh one. The ` +
      `artifact id is stable, so nothing was lost.`,
  );
}

type Auth = { principal: string } | { error: string; detail: string };

/**
 * Resolve the calling principal from a request. `Authorization: Bearer <token>` is the ONLY auth
 * channel, and exactly two kinds of token authorize coordination: a valid, unexpired RUN token
 * (minted via the bootstrap chain) yields its `run:*` principal, and the local OPERATOR token
 * yields the space's own principal. Any invalid/expired/stopped token is a hard error. It is never
 * a silent fall-through to operator.
 *
 * Definition tokens authorize one thing only, minting a run, which `POST /v0/agent-runs` reads
 * before this check. Never accept one here: a definition token is long-lived, so accepting it
 * would hand out unexpiring coordination authority.
 *
 * With NO Authorization header the caller is the operator `human:local` (open mode), so
 * unauthenticated local dev/UI/examples stay fully open. That holds UNLESS `authRequired`, in
 * which case a missing header is an error. To act as a scoped principal, mint a real run token.
 * There is no impersonation shortcut.
 */
async function resolveAuth(req: Request, space: Space, authRequired: boolean): Promise<Auth> {
  const authz = req.headers.get("Authorization");
  if (authz?.startsWith("Bearer ")) {
    const r = await space.resolveToken(authz.slice("Bearer ".length).trim());
    if (r.ok && (r.kind === "run" || r.kind === "operator")) return { principal: r.principal };
    if (r.ok && r.kind === "def") return { error: "invalid_token", detail: "a definition token does not authorize coordination; mint a run first" };
    return { error: r.reason, detail: `bearer token ${r.reason}` };
  }
  if (authRequired) return { error: "auth_required", detail: "this space requires Authorization: Bearer <run-token>" };
  return { principal: "human:local" };
}

/** Vendored console JS, read on first request (never on import) and held for the process life. */
let blitzoomJs: string | null = null;

/** A record claimed out of a space: three waiting, one taken. The same mark as `docs/favicon.svg`
 *  (kept byte-equal by http.test.ts) and the chat banner's text rendering of it. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <!-- A record claimed out of a space: three waiting, one taken. The console's own palette. -->
  <rect width="64" height="64" rx="12" fill="#0e0e11"/>
  <circle cx="21" cy="21" r="6" fill="#60a5fa"/>
  <circle cx="43" cy="21" r="6" fill="#60a5fa"/>
  <circle cx="21" cy="43" r="6" fill="#60a5fa"/>
  <circle cx="43" cy="43" r="8" fill="#818cf8"/>
</svg>`;


/**
 * The whole HTTP surface as one `(Request) => Response` function.
 *
 * Exported because it is the testable seam: the boundary rules that live here (a bad bearer is a
 * 401 and never a fall-through to the operator, a wrong-typed field is a 400 and never a 500, an
 * artifact's disposition) are exactly the ones a Space-level test cannot reach, and binding a real
 * port to check them buys nothing but flakes. See `conformance/http.test.ts`.
 */
export function makeHandler(space: Space, ui: string, authRequired: boolean) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
    // Minting a run reads its DEFINITION token directly (a def token isn't a coordination
    // principal), so it runs before principal resolution rejects non-run bearer tokens.
    if (route === "POST /v0/agent-runs") return await handleCreateRun(space, req);
    // Mint a capability over a SET of artifacts, addressed by path. Generic: the runtime is handed
    // {path, artifactId} pairs and never learns what they are, so a workspace is one caller rather
    // than a concept in here.
    if (route === "POST /v0/capabilities") {
      const auth = await resolveAuth(req, space, authRequired);
      if ("error" in auth) return problem(401, auth.error, auth.detail);
      return await handleMintPathCapability(space, req, auth.principal);
    }
    // Renew a run: `/v0/agent-runs/{id}/renew` (own token or operator, checked in the handler).
    //
    // An EXPIRED token cannot renew itself: `resolveAuth` rejects it before this, so the answer is
    // 401 and the holder has to authenticate again. That is the property that keeps renewal from
    // being a long-lived token in disguise, and it is why a client renews at HALF-LIFE rather than
    // on failure.
    if (req.method === "POST" && url.pathname.startsWith("/v0/agent-runs/") && url.pathname.endsWith("/renew")) {
      const renewAuth = await resolveAuth(req, space, authRequired);
      if ("error" in renewAuth) return problem(401, renewAuth.error, renewAuth.detail);
      const runId = decodeURIComponent(url.pathname.slice("/v0/agent-runs/".length, -"/renew".length));
      return await handleRenewRun(space, req, renewAuth.principal, runId);
    }
    // Revoke a definition: `/v0/agent-definitions/{agent}/revoke` (operator only, in the handler).
    // The one credential in the chain that had no off switch, so a leaked definition token minted
    // fresh runs forever and rotating the subject left the old one working beside the new.
    if (req.method === "POST" && url.pathname.startsWith("/v0/agent-definitions/") && url.pathname.endsWith("/revoke")) {
      const revokeAuth = await resolveAuth(req, space, authRequired);
      if ("error" in revokeAuth) return problem(401, revokeAuth.error, revokeAuth.detail);
      const agent = decodeURIComponent(url.pathname.slice("/v0/agent-definitions/".length, -"/revoke".length));
      return await handleRevokeDefinition(space, req, revokeAuth.principal, agent);
    }
    // Stop a run: `/v0/agent-runs/{id}/stop` (own token or operator, checked in the handler).
    if (req.method === "POST" && url.pathname.startsWith("/v0/agent-runs/") && url.pathname.endsWith("/stop")) {
      const auth = await resolveAuth(req, space, authRequired);
      const principal = "principal" in auth ? auth.principal : "";
      const runId = decodeURIComponent(url.pathname.slice("/v0/agent-runs/".length, -"/stop".length));
      return await handleStopRun(space, req, principal, runId);
    }

    // --- artifact bytes by CAPABILITY: the one authenticated path that carries no token ---
    // A browser cannot put an Authorization header on `<img src>`, so a short-lived, single-artifact
    // capability stands in for the read grant its holder already had. Checked before token
    // resolution because there is deliberately no token to resolve.
    // The short capability form, here too: with `--artifact-port 0` there is no isolated origin, so
    // this is where the link points.
    if (req.method === "GET" && url.pathname.startsWith(SHORT_ARTIFACT_PREFIX)) {
      const cap = decodeURIComponent(url.pathname.slice(SHORT_ARTIFACT_PREFIX.length));
      const id = space.resolveDownloadCapability(cap);
      if (!id) return capabilityRefused(space);
      return await handleGetArtifact(space, id, null);
    }
    const capability = url.searchParams.get("capability");
    if (req.method === "GET" && capability && url.pathname.startsWith("/v0/artifacts/")) {
      const id = decodeURIComponent(url.pathname.slice("/v0/artifacts/".length));
      if (!space.checkDownloadCapability(capability, id)) {
        return problem(
          403,
          "forbidden",
          `download capability is invalid, for another artifact, or expired. Capabilities last ` +
            `${space.downloadCapabilitySeconds}s and do not survive a restart. The artifact id is stable; ` +
            `re-open it from the console, or GET /v0/artifacts/{id} with a token.`,
        );
      }
      return await handleGetArtifact(space, id, null);
    }

    const auth = await resolveAuth(req, space, authRequired);
    // The console (GET /) and health stay public so the console can bootstrap even in required
    // mode; everything else 401s. These carry no credential. Keep it that way (see `loadUi`).
    const isPublic = route === "GET /" || route === "GET /v0/health" || route === "GET /ui/blitzoom.bundle.js" ||
      route === "GET /favicon.ico" || route === "GET /favicon.svg";
    // "Public" means NO credential is needed. It does not mean a presented one is ignored. Only
    // `auth_required` (nothing was presented) is exempt; a token that failed to resolve is a 401
    // even here. Never exempt both: health is the one endpoint a client calls to ask "am I
    // authenticated?", and answering `200 {principal: "anonymous"}` to an expired or stopped
    // token makes a dead credential indistinguishable from an open space.
    if ("error" in auth && !(isPublic && auth.error === "auth_required")) {
      return problem(401, auth.error, auth.detail);
    }
    const principal = "principal" in auth ? auth.principal : "anonymous";

    // Asking what YOU may do is not an operator question, and it must be checked BEFORE the plane's
    // gate rather than inside it. A principal with no grants at all is exactly the one that needs
    // the answer, and `opsScope` refuses that principal outright. An agent that cannot read its own
    // permissions cannot tell an approved grant from a pending one. Reading ANOTHER principal's
    // authorization stays operator-only.
    const asksAboutSelf = url.pathname === "/v0/ops/permissions" &&
      [principal, space.grantSubject(principal)].includes(url.searchParams.get("principal") ?? "");

    // The observe-and-operate plane is a THREE-WAY gate (architecture-ops-tiers.md). A privileged
    // principal holds every power. Anyone else holds exactly the powers its `ops_grant` records
    // assign: `observe` opens every READ unscoped, and each write verb demands its own power
    // (`remediate`/`sweep`/`declassify`/`purge`), refused BY NAME so the caller is not sent off
    // to request a kind grant that cannot help. Below that sits the self-scope tier unchanged:
    // the kinds a `scope.createdBy:"self"` grant covers, own records, reads only. No power ever
    // opens the coordination plane; `authorize` never consults this.
    let opsScope: StatsScope | null = null;
    let opsPowers: ReadonlySet<OpsPower> | null = null;
    if (url.pathname.startsWith("/v0/ops/") && !asksAboutSelf) {
      opsPowers = await space.opsPowers(principal);
      const need = requiredOpsPower(req.method, url.pathname);
      if (need) {
        if (!opsPowers.has(need)) {
          return problem(403, "forbidden", `'${need}' ops power required for ${url.pathname}; an operator assigns it as an ops_grant record`);
        }
      } else if (req.method === "POST" && url.pathname === "/v0/ops/gc") {
        // Either power reaches the verb; the live/dry split is decided in the handler, where the
        // body is parsed. A sweep-only holder may also dry-run: a preview of its own power.
        if (!opsPowers.has("sweep") && !opsPowers.has("observe")) {
          return problem(403, "forbidden", "'sweep' (live) or 'observe' (dryRun) ops power required for /v0/ops/gc");
        }
      } else if (!opsPowers.has("observe")) {
        try {
          opsScope = await space.opsScope(principal);
        } catch (e) {
          if (e instanceof RadiaError) return problem(403, e.code, e.message);
          throw e;
        }
        if (opsScope && !READ_ONLY_OPS.test(url.pathname)) {
          return problem(403, "forbidden", `principal '${principal}' may only READ the ops plane, and only its own records`);
        }
      }
    }

    // --- coordination plane, path-param: artifact bytes + capability minting ---
    if (url.pathname.startsWith("/v0/artifacts/")) {
      const parts = url.pathname.slice("/v0/artifacts/".length).split("/");
      const id = decodeURIComponent(parts[0] ?? "");
      if (id) {
        if (req.method === "GET" && !parts[1]) return await handleGetArtifact(space, id, principal);
        // HEAD is the METADATA read this plane was missing. An artifact's digest, media type and
        // size live in a record, and the only way to reach a record by id was `/v0/ops/records/{id}`
        // — the operator plane. So an ordinary worker could not learn an artifact's digest without
        // downloading it, which is how attaching one to a workspace shipped broken: it worked under
        // an operator client and failed for every worker. Same grant as GET, no body.
        if (req.method === "HEAD" && !parts[1]) return await handleGetArtifact(space, id, principal, false, null, true);
        if (req.method === "POST" && parts[1] === "capability") return await handleMintCapability(space, id, principal);
      }
    }

    // --- coordination plane, path-param: watch SSE stream ---
    if (req.method === "GET" && url.pathname.startsWith("/v0/watches/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.slice("/v0/watches/".length, -"/events".length);
      // The stream re-checks the credential for as long as it runs, through this exact path: a
      // long-lived connection is one request that never ends, so it re-resolves rather than
      // trusting the single resolution that opened it.
      return await handleWatchEvents(space, decodeURIComponent(id), principal, req, async () => {
        return !("error" in await resolveAuth(req, space, authRequired));
      });
    }

    // Dry run: which interests would receive a record of this shape? A read, gated with the rest of
    // the observe plane, and deliberately ABSENT from READ_ONLY_OPS: it reports what OTHER
    // principals are listening for, which is the whole routing table and not a self-scoped fact. A
    // principal reading its OWN interests does it with an ordinary self-scoped query on the kind.
    if (route === "POST /v0/ops/dry-run") return await handleDryRun(space, req);
    // The orientation read. Self-scoped callers get it too: it reports the caller's OWN
    // permissions, and the kind list is not a secret (a scoped principal already learns kinds by
    // being refused). Interests are the one cross-principal part, so they follow the same scope.
    if (route === "GET /v0/ops/digest") return await handleDigest(space, principal, opsScope);
    // Mined shapes. Self-scoped for the same reason `stats` is: the scan runs over the records the
    // caller may read, so a narrowed caller mines its own work rather than being refused.
    if (route === "GET /v0/ops/flows") return await handleFlows(space, url, opsScope);
    // Integrity is NOT in READ_ONLY_OPS: the chain covers every principal's activity, so it is an
    // operator answer even though it is a read, exactly like the dry-run matcher.
    if (route === "GET /v0/ops/integrity") return await handleIntegrity(space);

    // --- observability + control plane: /v0/ops/records/{id}[/{envelope|lineage|graph}|/{reclaim|dead-letter|requeue}] ---
    if (url.pathname.startsWith("/v0/ops/records/")) {
      const parts = url.pathname.slice("/v0/ops/records/".length).split("/");
      const id = decodeURIComponent(parts[0] ?? "");
      const tail = parts[1];
      if (id) {
        if (req.method === "GET" && !tail) return await handleGetRecord(space, id, opsScope);
        if (req.method === "GET" && tail === "envelope") return await handleEnvelope(space, id, opsScope);
        if (req.method === "GET" && tail === "lineage") return await handleLineage(space, id, opsScope);
        if (req.method === "GET" && tail === "children") return await handleChildren(space, id, opsScope, url);
        if (req.method === "GET" && tail === "graph") return await handleGraph(space, id, url, opsScope);
        if (req.method === "GET" && tail === "thread") return await handleThread(space, id, opsScope);
        if (req.method === "POST" && (tail === "reclaim" || tail === "dead-letter" || tail === "requeue")) {
          return await handleAdmin(space, id, tail);
        }
        if (req.method === "POST" && tail === "declassify") return await handleDeclassify(space, req, id, principal);
        // Erasure. On the ops plane because it is irreversible and operator-only, and beside
        // declassify because both are carve-outs from an invariant: one clears a classification,
        // the other destroys a payload. Neither is something a participant may do to itself.
        if (req.method === "POST" && tail === "shred") return await handleShredArtifact(space, req, id, principal);
      }
    }

    switch (route) {
      case "GET /":
        return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });

      // The mark, at the path browsers probe unprompted. Every console load fired a 401 here in
      // required mode, which is noise wearing an error's clothes. Public like the page itself: it
      // is the same four dots the docs site ships, and `http.test.ts` holds the two files equal so
      // the browser tab and the published site cannot drift apart.
      case "GET /favicon.ico":
      case "GET /favicon.svg":
        return new Response(FAVICON_SVG, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        });

      // Vendored console asset, loaded lazily by the Space tab. Immutable: the bundle is a
      // checked-in build artifact pinned to an upstream commit (src/ui/vendor/README.md).
      case "GET /ui/blitzoom.bundle.js": {
        blitzoomJs ??= loadVendor("blitzoom.bundle.js");
        if (!blitzoomJs) return problem(404, "not_found", "vendored asset blitzoom.bundle.js not found");
        return new Response(blitzoomJs, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
        });
      }

      // --- coordination plane (frozen v0-stable) ---
      case "GET /v0/health":
        return Response.json({
          status: "ok",
          version: "0.0.0",
          api: "v0",
          storage: space.storageName,
          now: await space.now(),
          principal, // the resolved caller (so the console can show who it's authenticated as)
        });
      case "POST /v0/artifacts":
        return await handlePutArtifact(space, req, principal);
      case "POST /v0/records":
        return await handlePut(space, req, principal);
      case "POST /v0/records/read-one":
        return await handleReadOne(space, req, principal);
      case "POST /v0/records/query":
        return await handleQuery(space, req, principal);
      case "POST /v0/takes":
        return await handleTake(space, req, principal);
      case "POST /v0/leases/renew":
        return await handleRenew(space, req, principal);
      case "POST /v0/leases/ack":
        return await handleAck(space, req, principal);
      case "POST /v0/leases/nack":
        return await handleNack(space, req, principal);
      case "POST /v0/leases/release":
        return await handleRelease(space, req, principal);
      case "POST /v0/watches":
        return await handleCreateWatch(space, req, principal);

      // --- bootstrap chain: operator creates a definition (assigns grants + gets a mint token) ---
      case "POST /v0/agent-definitions":
        return await handleCreateDefinition(space, req, principal);

      // --- observability + control plane (experimental) ---
      case "POST /v0/ops/remediate":
        return await handleRemediate(space, req);
      case "POST /v0/ops/gc":
        // The dry/live split is body-dependent, so the gate could not decide it: a dry run is a
        // read (`observe` reached here), a live one needs `sweep`, checked in the handler.
        return await handleGc(space, req, principal, opsPowers?.has("sweep") ?? false);
      case "GET /v0/ops/records":
        return await handleEnvelopeQuery(space, url, opsScope);
      case "GET /v0/ops/permissions":
        // Absent from READ_ONLY_OPS on purpose: reading ANOTHER principal's authorization is an
        // operator question. The one exception is reading your own, allowed above.
        return await handlePermissions(space, url);
      case "GET /v0/ops/stats":
        return await handleStats(space, opsScope);
      case "GET /v0/ops/events":
        return await handleEvents(space, url, opsScope);
      case "GET /v0/ops/diagnostics":
        return await handleDiagnostics(space, opsScope);
      // Erasures, and whether they still hold. On the ops plane because a shred record names what
      // somebody destroyed, and because only an operator can act on the answer.
      case "GET /v0/ops/erasures":
        return await handleErasures(space, url);

      default:
        return problem(404, "not_found", `no route for ${route}`);
    }
    } catch (e) {
      // Any uncaught error becomes problem+json, never a plain-text 500 the client can't parse.
      // A RadiaError a handler didn't translate maps by its code; anything else is unexpected.
      if (e instanceof RadiaError) return problem(statusFor(e.code, 422), e.code, e.message);
      console.error(`unhandled error on ${route}:`, e);
      return problem(500, "internal", "unexpected server error");
    }
  };
}
