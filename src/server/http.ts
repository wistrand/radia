// HTTP surface. No framework (minimal-deps invariant); the server binding lives behind
// `src/platform.ts`. Two planes under /v0:
//   - coordination (frozen v0-stable): records (put/read_one/query), takes, leases, watches,
//     health — what agents use to do work. Kinds are declared THROUGH this plane: a kind is a
//     kind_def record (POST /v0/records), discovered by query — no dedicated kinds endpoint.
//   - observability + control (experimental, grant-gated with real auth): /v0/ops/* —
//     stats, events, diagnostics, record + envelope introspection (records[/{id}[/envelope|
//     lineage|graph]]), and remediation (reclaim/dead-letter/requeue). Reading/operating the
//     space. The prefix split carries both the stability boundary and the (future) auth boundary.
//   - bootstrap chain: POST /v0/agent-definitions (operator → mint token + grants), POST
//     /v0/agent-runs (definition token → short-lived run token), POST /v0/agent-runs/{id}/stop.
//     Requests authenticate with `Authorization: Bearer <run-token>`; see design-auth.md.

import type { Space } from "../core/space.ts";
import { handlePut, handleQuery, handleReadOne } from "./handlers/records.ts";
import { handleAck, handleNack, handleRelease, handleRenew, handleTake } from "./handlers/leases.ts";
import { handleCreateDefinition, handleCreateRun, handleStopRun } from "./handlers/agents.ts";
import { handleGetArtifact, handleMintCapability, handlePutArtifact } from "./handlers/artifacts.ts";
import { handleRemediate, handleAdmin, handleChildren, handleDeclassify, handleDiagnostics, handleEnvelope, handleEnvelopeQuery, handleEvents, handleGetRecord, handleGraph, handleLineage, handleStats } from "./handlers/ops.ts";
import { handleCreateWatch, handleWatchEvents } from "./handlers/watches.ts";
import { problem, statusFor } from "./problem.ts";
import { RadiaError } from "../core/errors.ts";
import type { StatsScope } from "../storage/adapter.ts";
import { moduleRelative, readTextFile, serve } from "../platform.ts";

export interface ServerOptions {
  port: number;
  space: Space;
  signal?: AbortSignal;
  /** Bind address. Defaults to loopback (`127.0.0.1`) — the API's no-header operator default is
   *  only safe locally; pass `0.0.0.0` to deliberately expose it (and prefer `authRequired`). */
  host?: string;
  /** When true, a request with no `Authorization` is rejected (`401`) instead of resolving to the
   *  operator. `GET /` (console) and `GET /v0/health` stay public so the console can bootstrap. */
  authRequired?: boolean;
  /** Operator token injected into the served console so it authenticates via `Authorization:
   *  Bearer` like any client (instead of relying on the no-header operator default). */
  operatorToken?: string;
}

/** The dev UI, loaded once at startup. Single file (see src/ui/index.html); the only asset it
 *  pulls is the vendored bundle below, lazily, when the Space tab is first opened. */
function loadUi(operatorToken?: string): string {
  const html = readTextFile(moduleRelative(import.meta.url, "../ui/index.html"));
  if (html === undefined) {
    return "<!doctype html><title>radia</title><p>dev UI not found (src/ui/index.html).</p>";
  }
  // Bake the operator token into the page. If absent, the placeholder stays and the console's
  // guard falls back to the no-header operator default (e.g. UI opened as a static file).
  return operatorToken ? html.replaceAll("__RADIA_OPERATOR_TOKEN__", operatorToken) : html;
}

/** Vendored browser assets served under `/ui/` (see src/ui/vendor/README.md). Prebuilt and
 *  checked in — no build step. Loaded once at startup; empty string if the file is missing
 *  (the Space tab then reports the asset as unavailable and the rest of the console works). */
function loadVendor(name: string): string {
  return readTextFile(moduleRelative(import.meta.url, `../ui/vendor/${name}`)) ?? "";
}

/** The ops paths a SELF-SCOPED (non-operator) principal may reach: reads only. Everything else on
 *  the plane — remediate, reclaim/dead-letter/requeue, declassify — is the interrupt half and stays
 *  operator-only. */
const READ_ONLY_OPS =
  /^\/v0\/ops\/(stats|events|diagnostics|records(\/[^/]+(\/(envelope|lineage|children|graph))?)?)$/;

export function startServer(opts: ServerOptions): { finished: Promise<void> } {
  const hostname = opts.host ?? "127.0.0.1"; // loopback by default; --host 0.0.0.0 to expose
  const handler = makeHandler(opts.space, loadUi(opts.operatorToken), opts.authRequired ?? false);
  const { finished } = serve({ port: opts.port, hostname, signal: opts.signal }, handler);
  console.log(`radia dev listening on http://${hostname}:${opts.port} (web console at /) — auth ${opts.authRequired ? "required" : "open (no-header → operator)"}`);
  return { finished };
}

type Auth = { principal: string } | { error: string; detail: string };

/**
 * Resolve the calling principal from a request. `Authorization: Bearer <run-token>` (minted via
 * the bootstrap chain) is the ONLY auth channel: a valid, unexpired RUN token yields its `run:*`
 * principal; any invalid/expired/stopped token is a hard error (never a silent fall-through to
 * operator). Definition tokens do not authorize coordination — only `POST /v0/agent-runs` reads
 * those, before this check. With NO Authorization header the caller is the operator `human:local`
 * (open mode), so unauthenticated local dev/UI/examples stay fully open — UNLESS `authRequired`, in
 * which case a missing header is an error. To act as a scoped principal, mint a real run token —
 * there is no impersonation shortcut.
 */
async function resolveAuth(req: Request, space: Space, authRequired: boolean): Promise<Auth> {
  const authz = req.headers.get("Authorization");
  if (authz?.startsWith("Bearer ")) {
    const r = await space.resolveToken(authz.slice("Bearer ".length).trim());
    if (r.ok && r.kind === "run") return { principal: r.principal };
    if (r.ok && r.kind === "def") return { error: "invalid_token", detail: "a definition token does not authorize coordination; mint a run first" };
    return { error: r.reason, detail: `bearer token ${r.reason}` };
  }
  if (authRequired) return { error: "auth_required", detail: "this space requires Authorization: Bearer <run-token>" };
  return { principal: "human:local" };
}

/** Vendored console JS, read on first request (never on import) and held for the process life. */
let blitzoomJs: string | null = null;

function makeHandler(space: Space, ui: string, authRequired: boolean) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
    // Minting a run reads its DEFINITION token directly (a def token isn't a coordination
    // principal), so it runs before principal resolution rejects non-run bearer tokens.
    if (route === "POST /v0/agent-runs") return await handleCreateRun(space, req);
    // Stop a run: `/v0/agent-runs/{id}/stop` (own token or operator — checked in the handler).
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
    const capability = url.searchParams.get("capability");
    if (req.method === "GET" && capability && url.pathname.startsWith("/v0/artifacts/")) {
      const id = decodeURIComponent(url.pathname.slice("/v0/artifacts/".length));
      if (!space.checkDownloadCapability(capability, id)) {
        return problem(
          403,
          "forbidden",
          `download capability is invalid, for another artifact, or expired — capabilities last ` +
            `${space.downloadCapabilitySeconds}s and do not survive a restart. The artifact id is stable; ` +
            `re-open it from the console, or GET /v0/artifacts/{id} with a token.`,
        );
      }
      return await handleGetArtifact(space, id, null);
    }

    const auth = await resolveAuth(req, space, authRequired);
    // The console (GET /) and health stay public so the console can bootstrap even in required
    // mode (it authenticates thereafter with its baked operator token); everything else 401s.
    const isPublic = route === "GET /" || route === "GET /v0/health" || route === "GET /ui/blitzoom.bundle.js";
    if ("error" in auth && !isPublic) return problem(401, auth.error, auth.detail);
    const principal = "principal" in auth ? auth.principal : "anonymous";

    // The observe-and-operate plane is grant-gated. Operator (human/supervisor) sees everything;
    // anyone else sees the plane only through a SELF SCOPE — the kinds they hold a
    // `scope.createdBy:"self"` grant on, restricted to their own records. `opsScope` throws
    // `forbidden` when nothing is scoped to them, which is the answer the plane gave before.
    //
    // A scope does NOT open the whole plane: the write half (remediate/admin/declassify) stays
    // operator-only below, because those are the interrupt half and taint clears only via
    // privileged declassify.
    let opsScope: StatsScope | null = null;
    if (url.pathname.startsWith("/v0/ops/")) {
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

    // --- coordination plane, path-param: artifact bytes + capability minting ---
    if (url.pathname.startsWith("/v0/artifacts/")) {
      const parts = url.pathname.slice("/v0/artifacts/".length).split("/");
      const id = decodeURIComponent(parts[0] ?? "");
      if (id) {
        if (req.method === "GET" && !parts[1]) return await handleGetArtifact(space, id, principal);
        if (req.method === "POST" && parts[1] === "capability") return await handleMintCapability(space, id, principal);
      }
    }

    // --- coordination plane, path-param: watch SSE stream ---
    if (req.method === "GET" && url.pathname.startsWith("/v0/watches/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.slice("/v0/watches/".length, -"/events".length);
      return handleWatchEvents(space, decodeURIComponent(id), req);
    }

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
        if (req.method === "POST" && (tail === "reclaim" || tail === "dead-letter" || tail === "requeue")) {
          return await handleAdmin(space, id, tail);
        }
        if (req.method === "POST" && tail === "declassify") return await handleDeclassify(space, id);
      }
    }

    switch (route) {
      case "GET /":
        return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });

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
      case "GET /v0/ops/records":
        return await handleEnvelopeQuery(space, url, opsScope);
      case "GET /v0/ops/stats":
        return await handleStats(space, opsScope);
      case "GET /v0/ops/events":
        return await handleEvents(space, url, opsScope);
      case "GET /v0/ops/diagnostics":
        return await handleDiagnostics(space, opsScope);

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
