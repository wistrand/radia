// Watch endpoints (M1). POST /v0/watches creates an ephemeral, pattern-scoped watch;
// GET /v0/watches/{id}/events is an SSE stream of wakeups for matching records that are
// available. Resumption: reconnect with `Last-Event-ID` (or ?cursor=) and delivery
// continues after that seq. An explicit cursor below the event-GC horizon → 410
// cursor_expired; the "0"/absent sentinel never 410s (see the check below for why). The
// horizon stays null until the M2 event sweep exists, so the check is live but finds
// nothing to refuse today. The event log is the source of truth; the Notifier is only a
// wakeup.

import type { Space, Watch } from "../../core/space.ts";
import type { Pattern } from "../../core/matching.ts";
import { AUTHORIZATION_KINDS } from "../../core/kinds.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem, statusFor } from "../problem.ts";

/** Backstop re-check interval. The event-log trigger below is exact, so this only bounds the damage
 *  if a future authorization-bearing kind is added and left out of `AUTHORIZATION_KINDS`. A local
 *  interval, not a comparison of stored timestamps, so it does not want the database clock. */
const AUTH_RECHECK_MS = 30_000;

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
    // `createWatch` does that itself, because the same derivation has to run again on every
    // revalidation and the handler is not where a policy with two callers belongs.
    //
    // The watch is bound to its creator and carries that principal's author scope: the stream is
    // reached by id alone, and ids are monotonic ULIDs (guessable from any adjacent record).
    const { watchId } = await space.createWatch(pattern, principal);
    return new Response(JSON.stringify({ watchId }), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}

/**
 * The SSE stream.
 *
 * `credentialValid` re-resolves the CREDENTIAL the caller presented, through the same path the
 * request came in on. A stream outlives the one authentication that opened it, so a stopped run or
 * a revoked definition token would otherwise keep the connection fed; passing the check back in as
 * a closure means there is no second implementation of "is this token still good" to drift.
 */
export async function handleWatchEvents(
  space: Space,
  watchId: string,
  principal: string,
  req: Request,
  credentialValid: () => Promise<boolean>,
): Promise<Response> {
  // Only the creator may attach. A watch carries a scope compiled from ITS creator's grants, so
  // handing the stream to whoever knows the id hands them that scope. 404, not 403: a non-owner
  // is not entitled to learn the id exists.
  if (!space.getWatch(watchId, principal)) return problem(404, "not_found", `no watch ${watchId}`);

  // Re-authorize on ATTACH, not only on create. A reconnect (Last-Event-ID resume) is a fresh
  // request under a possibly-changed authorization state, and OWNERSHIP IS NOT AUTHORIZATION: the
  // ownership check above passes for the creator forever, so a grant revoked between two
  // connections was previously restored by reconnecting.
  let watch: Watch;
  try {
    watch = await space.revalidateWatch(watchId, principal);
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 403), e.code, e.message);
    throw e;
  }

  const url = new URL(req.url);
  const raw = req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursor");
  // The cursor is an opaque, adapter-issued token (a seq or an xid watermark). The transport
  // echoes it to the adapter, the only side that can compare it: a cursor below the event-GC
  // horizon would silently jump the swept gap, which is the one failure worse than deletion.
  // Never 410 the sentinel: "0" and absent mean "from the beginning", and both SDKs recover from
  // a 410 by resetting to "0" and reconnecting immediately, so refusing it would hot-loop every
  // shipped client. A sentinel on a truncated log starts at the oldest retained event, which is
  // what the resetting client asked for; the 410 already told it to re-sync by query.
  if (raw != null && raw.length > 0 && raw !== "0") {
    const h = await space.eventHorizon(raw);
    if (h.expired && h.horizon) {
      return problem(
        410,
        "cursor_expired",
        `cursor ${raw} predates the retained event log (${h.horizon.swept} events swept; the log resumes after ${h.horizon.cursor}); re-sync by query, then reconnect`,
        { horizon: h.horizon.cursor, swept: h.horizon.swept },
      );
    }
  }
  let cursor = raw != null && raw.length > 0 ? raw : watch.cursor0;

  const enc = new TextEncoder();
  // Detect client disconnect via the stream's cancel() callback (Deno invokes it when the
  // client goes away), NOT req.signal: under Deno.serve's legacy semantics req.signal also
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
      // Re-derive the scope from the credential and grants that exist NOW. Returns false when the
      // stream must end, having already told the client why: a bare disconnect is indistinguishable
      // from a network drop, and a client that cannot tell them apart reconnects forever.
      let lastCheck = Date.now();
      const stillAuthorized = async (): Promise<boolean> => {
        lastCheck = Date.now();
        let reason: string;
        if (!await credentialValid()) reason = "credential_invalid";
        else {
          try {
            watch = await space.revalidateWatch(watchId, principal);
            return true;
          } catch (e) {
            reason = e instanceof RadiaError ? e.code : "forbidden";
          }
        }
        send(`event: revoked\ndata: ${JSON.stringify({ reason })}\n\n`);
        return false;
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
          // Authorization state IS records, so the log this loop already reads carries every change
          // that could revoke the stream. Trigger on the write rather than polling for it.
          //
          // Re-scope BEFORE the events that follow it in the batch, not after the batch: a
          // revocation and a record the OLD scope matched can arrive together, and deferring the
          // re-check to the end of the batch delivers a record written after the grant was gone.
          if (e.kind && AUTHORIZATION_KINDS.has(e.kind) && !await stillAuthorized()) {
            closed = true;
            break;
          }
          if (await space.matchesEvent(watch, e)) {
            send(`id: ${e.cursor}\ndata: ${JSON.stringify({ seq: e.seq, recordId: e.recordId, kind: e.kind })}\n\n`);
          }
        }
        if (closed) break;
        // Wake on a mutation or the 15s keepalive. A disconnect resolves immediately.
        await Promise.race([space.waitForEvents(15_000), new Promise<void>((r) => (wake = r))]);
        if (closed) break;
        if (Date.now() - lastCheck >= AUTH_RECHECK_MS && !await stillAuthorized()) break;
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
