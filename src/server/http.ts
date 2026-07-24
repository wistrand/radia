// HTTP surface. Deno.serve, no framework (minimal-deps invariant). All routes are under
// the /v0/ prefix so clients pin the frozen data-plane version. Phase 1 serves health +
// the record data plane (put, read_one); the remaining operations land in Phases 3-7.

import type { Space } from "../core/space.ts";
import { handlePut, handleQuery, handleReadOne } from "./handlers/records.ts";
import { handleRegisterKind } from "./handlers/kinds.ts";
import { handleAck, handleNack, handleRelease, handleRenew, handleTake } from "./handlers/leases.ts";
import { handleEnvelope, handleEvents, handleLineage, handleListKinds, handleStats } from "./handlers/dev.ts";
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

function makeHandler(space: Space, ui: string) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    // Path-param routes.
    if (req.method === "GET" && url.pathname.startsWith("/v0/envelopes/")) {
      return await handleEnvelope(space, decodeURIComponent(url.pathname.slice("/v0/envelopes/".length)));
    }
    if (req.method === "GET" && url.pathname.startsWith("/v0/records/") && url.pathname.endsWith("/lineage")) {
      const id = url.pathname.slice("/v0/records/".length, -"/lineage".length);
      return await handleLineage(space, decodeURIComponent(id));
    }
    if (req.method === "GET" && url.pathname.startsWith("/v0/watches/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.slice("/v0/watches/".length, -"/events".length);
      return handleWatchEvents(space, decodeURIComponent(id), req);
    }

    switch (route) {
      case "GET /":
        return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "POST /v0/watches":
        return await handleCreateWatch(space, req);
      case "GET /v0/events":
        return await handleEvents(space, url);
      case "GET /v0/health":
        return Response.json({
          status: "ok",
          version: "0.0.0",
          api: "v0",
          storage: space.storageName,
          now: await space.now(),
        });
      case "GET /v0/stats":
        return await handleStats(space);
      case "GET /v0/kinds":
        return handleListKinds(space);
      case "POST /v0/kinds":
        return await handleRegisterKind(space, req);
      case "POST /v0/records":
        return await handlePut(space, req);
      case "POST /v0/records/read-one":
        return await handleReadOne(space, req);
      case "POST /v0/records/query":
        return await handleQuery(space, req);
      case "POST /v0/takes":
        return await handleTake(space, req);
      case "POST /v0/leases/renew":
        return await handleRenew(space, req);
      case "POST /v0/leases/ack":
        return await handleAck(space, req);
      case "POST /v0/leases/nack":
        return await handleNack(space, req);
      case "POST /v0/leases/release":
        return await handleRelease(space, req);
      default:
        return problem(404, "not_found", `no route for ${route}`);
    }
  };
}
