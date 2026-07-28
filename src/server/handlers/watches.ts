// Watch endpoints (M1). POST /v0/watches creates an ephemeral, pattern-scoped watch;
// GET /v0/watches/{id}/events is an SSE stream of wakeups for matching records that are
// available. Resumption: reconnect with `Last-Event-ID` (or ?cursor=) and delivery
// continues after that seq. A cursor older than the retained log → 410 cursor_expired
// (dormant until event-log GC lands in M2; the floor is 0 for now). The event log is the
// source of truth; the Notifier is only a wakeup.

import type { Space } from "../../core/space.ts";
import { combineMatch, type Pattern } from "../../core/matching.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem, statusFor } from "../problem.ts";

export async function handleCreateWatch(space: Space, req: Request, principal: string): Promise<Response> {
  let j: Record<string, unknown> | null;
  try {
    const parsed = await req.json();
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    j = null;
  }
  if (!j || typeof j.kind !== "string") {
    return problem(400, "invalid_pattern", "watch requires a pattern with a kind");
  }
  const pattern: Pattern = { kind: j.kind, match: j.match as Record<string, unknown> | undefined, orderBy: undefined };
  try {
    // Authorize like a read: the principal must hold a grant on the kind, and a pattern-scoped
    // grant confines the watch to records it could observe (grant ∧ request), same as query/take.
    const { constraint, createdBy } = await space.authorizeWatch(principal, pattern.kind);
    if (constraint) pattern.match = combineMatch(pattern.match, constraint);
    // The watch is bound to its creator and carries that principal's author scope: the stream is
    // reached by id alone, and ids are monotonic ULIDs — guessable from any adjacent record.
    const { watchId } = await space.createWatch(pattern, principal, createdBy);
    return new Response(JSON.stringify({ watchId }), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}

export function handleWatchEvents(space: Space, watchId: string, principal: string, req: Request): Response {
  // Only the creator may attach. A watch carries a scope compiled from ITS creator's grants, so
  // handing the stream to whoever knows the id hands them that scope. 404, not 403 — a non-owner
  // is not entitled to learn the id exists.
  const watch = space.getWatch(watchId, principal);
  if (!watch) return problem(404, "not_found", `no watch ${watchId}`);

  const url = new URL(req.url);
  const raw = req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursor");
  // The cursor is an opaque, adapter-issued token (a seq or an xid watermark) — the transport
  // only echoes it, never interprets it. Resume from it verbatim, else the watch's start cursor.
  // Cursor-expiry (410 cursor_expired) validation returns with event-log GC (M2).
  let cursor = raw != null && raw.length > 0 ? raw : watch.cursor0;

  const enc = new TextEncoder();
  // Detect client disconnect via the stream's cancel() callback (Deno invokes it when the
  // client goes away), NOT req.signal — under Deno.serve's legacy semantics req.signal also
  // aborts on a fully-delivered response, which would falsely tear down a live stream.
  let closed = false;
  let wake: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch { /* stream closed */ }
      };
      send(": connected\n\n");
      while (!closed) {
        let events;
        try {
          events = await space.getEvents(cursor, 200);
        } catch {
          break;
        }
        for (const e of events) {
          if (closed) break;
          cursor = e.cursor; // gap-safe resume key (xid on pooled pg; seq on embedded)
          if (await space.matchesEvent(watch, e)) {
            send(`id: ${e.cursor}\ndata: ${JSON.stringify({ seq: e.seq, recordId: e.recordId, kind: e.kind })}\n\n`);
          }
        }
        if (closed) break;
        // Wake on a mutation or the 15s keepalive — but resolve immediately on disconnect.
        await Promise.race([space.waitForEvents(15_000), new Promise<void>((r) => (wake = r))]);
        if (closed) break;
        send(": keepalive\n\n");
      }
      try {
        controller.close();
      } catch { /* already closed */ }
    },
    cancel() {
      closed = true;
      wake(); // stop waiting and exit the loop promptly
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
