// Watch endpoints (M1). POST /v0/watches creates an ephemeral, template-scoped watch;
// GET /v0/watches/{id}/events is an SSE stream of wakeups for matching records that are
// available. Resumption: reconnect with `Last-Event-ID` (or ?cursor=) and delivery
// continues after that seq. A cursor older than the retained log → 410 cursor_expired
// (dormant until event-log GC lands in M2; the floor is 0 for now). The event log is the
// source of truth; the Notifier is only a wakeup.

import type { Space } from "../../core/space.ts";
import type { Template } from "../../core/matching.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem } from "../problem.ts";

export async function handleCreateWatch(space: Space, req: Request): Promise<Response> {
  let j: Record<string, unknown> | null;
  try {
    const parsed = await req.json();
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    j = null;
  }
  if (!j || typeof j.kind !== "string") {
    return problem(400, "invalid_template", "watch requires a template with a kind");
  }
  const template: Template = { kind: j.kind, match: j.match as Record<string, unknown> | undefined, orderBy: undefined };
  try {
    const { watchId } = await space.createWatch(template);
    return new Response(JSON.stringify({ watchId }), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(400, e.code, e.message);
    throw e;
  }
}

const EVENT_FLOOR = 0; // smallest fully-serviceable cursor; rises when event-log GC lands (M2)

export function handleWatchEvents(space: Space, watchId: string, req: Request): Response {
  const watch = space.getWatch(watchId);
  if (!watch) return problem(404, "not_found", `no watch ${watchId}`);

  const url = new URL(req.url);
  const raw = req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursor");
  let cursor = raw != null ? Number(raw) : watch.cursor0;
  if (!Number.isFinite(cursor) || cursor < 0) {
    return problem(400, "invalid_cursor", "cursor must be a non-negative integer");
  }
  if (cursor < EVENT_FLOOR) {
    return problem(410, "cursor_expired", "cursor is older than the retained event log; catch up with a query and re-watch");
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch { /* stream closed */ }
      };
      send(": connected\n\n");
      while (!req.signal.aborted) {
        let events;
        try {
          events = await space.getEvents(cursor, 200);
        } catch {
          break;
        }
        for (const e of events) {
          cursor = e.seq;
          if (await space.matchesEvent(watch.match, e)) {
            send(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, recordId: e.recordId, kind: e.kind })}\n\n`);
          }
        }
        if (req.signal.aborted) break;
        await space.waitForEvents(15_000); // wake on a mutation, else keepalive
        send(": keepalive\n\n");
      }
      try {
        controller.close();
      } catch { /* already closed */ }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
