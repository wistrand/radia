// HTTP surface. Deno.serve, no framework (minimal-deps invariant). Two planes under /v0:
//   - coordination (frozen v0-stable): records (put/read_one/query), takes, leases, watches,
//     health — what agents use to do work. Kinds are declared THROUGH this plane: a kind is a
//     kind_def record (POST /v0/records), discovered by query — no dedicated kinds endpoint.
//   - observability + control (experimental, grant-gated with real auth): /v0/ops/* —
//     stats, events, diagnostics, record + envelope introspection (records[/{id}[/envelope|
//     lineage|graph]]), and remediation (reclaim/dead-letter/requeue). Reading/operating the
//     space. The prefix split carries both the stability boundary and the (future) auth boundary.

import type { Space } from "../core/space.ts";
import { handlePut, handleQuery, handleReadOne } from "./handlers/records.ts";
import { handleAck, handleNack, handleRelease, handleRenew, handleTake } from "./handlers/leases.ts";
import { handleAdmin, handleDiagnostics, handleEnvelope, handleEnvelopeQuery, handleEvents, handleGetRecord, handleGraph, handleLineage, handleStats } from "./handlers/dev.ts";
import { handleCreateWatch, handleWatchEvents } from "./handlers/watches.ts";
import { problem } from "./problem.ts";

export interface ServerOptions {
  port: number;
  space: Space;
  signal?: AbortSignal;
}

/** The dev UI, loaded once at startup. Self-contained single file (see src/ui/index.html). */
function loadUi(): string {
  try {
    return Deno.readTextFileSync(new URL("../ui/index.html", import.meta.url));
  } catch {
    return "<!doctype html><title>radia</title><p>dev UI not found (src/ui/index.html).</p>";
  }
}

export function startServer(opts: ServerOptions): { finished: Promise<void> } {
  const handler = makeHandler(opts.space, loadUi());
  const server = Deno.serve({ port: opts.port, signal: opts.signal }, handler);
  console.log(`radia dev listening on http://localhost:${opts.port} (web console at /)`);
  return { finished: server.finished };
}

/**
 * Resolve the calling principal. M1-minimal, auto-provisioned local auth (NOT production):
 * default is the operator `human:local`, so unauthenticated dev/UI/examples stay fully open.
 * The `X-Radia-Principal` header lets a dev client ASSUME an agent/run principal to exercise
 * grant enforcement — insecure by design (a client shouldn't pick its own identity); real run
 * tokens + the agent-definition/agent-run bootstrap chain are deferred (see design-auth.md).
 */
function resolvePrincipal(req: Request): string {
  const assumed = req.headers.get("X-Radia-Principal");
  return assumed && assumed.length > 0 ? assumed : "human:local";
}

function makeHandler(space: Space, ui: string) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const principal = resolvePrincipal(req);

    // The observe-and-operate plane is grant-gated: operator (human/supervisor) only.
    if (url.pathname.startsWith("/v0/ops/") && !space.isPrivileged(principal)) {
      return problem(403, "forbidden", `principal '${principal}' may not access the ops plane`);
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
        if (req.method === "GET" && !tail) return await handleGetRecord(space, id);
        if (req.method === "GET" && tail === "envelope") return await handleEnvelope(space, id);
        if (req.method === "GET" && tail === "lineage") return await handleLineage(space, id);
        if (req.method === "GET" && tail === "graph") return await handleGraph(space, id, url);
        if (req.method === "POST" && (tail === "reclaim" || tail === "dead-letter" || tail === "requeue")) {
          return await handleAdmin(space, id, tail);
        }
      }
    }

    switch (route) {
      case "GET /":
        return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });

      // --- coordination plane (frozen v0-stable) ---
      case "GET /v0/health":
        return Response.json({
          status: "ok",
          version: "0.0.0",
          api: "v0",
          storage: space.storageName,
          now: await space.now(),
        });
      case "POST /v0/records":
        return await handlePut(space, req, principal);
      case "POST /v0/records/read-one":
        return await handleReadOne(space, req, principal);
      case "POST /v0/records/query":
        return await handleQuery(space, req, principal);
      case "POST /v0/takes":
        return await handleTake(space, req, principal);
      case "POST /v0/leases/renew":
        return await handleRenew(space, req);
      case "POST /v0/leases/ack":
        return await handleAck(space, req);
      case "POST /v0/leases/nack":
        return await handleNack(space, req);
      case "POST /v0/leases/release":
        return await handleRelease(space, req);
      case "POST /v0/watches":
        return await handleCreateWatch(space, req);

      // --- observability + control plane (experimental) ---
      case "GET /v0/ops/records":
        return await handleEnvelopeQuery(space, url);
      case "GET /v0/ops/stats":
        return await handleStats(space);
      case "GET /v0/ops/events":
        return await handleEvents(space, url);
      case "GET /v0/ops/diagnostics":
        return await handleDiagnostics(space);

      default:
        return problem(404, "not_found", `no route for ${route}`);
    }
  };
}
