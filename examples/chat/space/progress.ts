// Turn progress expressed as RECORDS. A worker that claims work publishes what it is doing as a
// `progress` record keyed to the call the chat awaits; the chat reads those and renders a live
// status line. Progress is therefore content-routed like everything else — any client (or the
// console Feed) sees the same stream, and no ops-plane access is needed: watches only wake on
// available records, and take/ack transitions live in the grant-gated event log, so a scoped
// session principal could not observe claims any other way.
//
// The absence of a progress record is itself the signal the chat uses: a call nobody has claimed
// produces no progress, which is how "no worker serves this" is distinguished from "still thinking".

import type { RadiaClient } from "../../../sdk/ts/client.ts";

/** Progress is ephemeral chatter — mark it GC-eligible rather than keeping it forever.
 *  (Retention GC lands in M2; `retentionUntil` is stored today, not yet swept.) */
const TTL_MS = 60 * 60 * 1000;

export interface ProgressBody {
  conversationId: string;
  /** The call the CHAT awaits — for a re-dispatched call that is `replyTo`, not the new record id. */
  callId: string;
  /** routing | routed | generating | escalating | running — short, renderable verbatim. */
  stage: string;
  /** The emitting worker's principal, so the user sees WHO is doing the work. */
  by: string;
  note?: string;
}

/** Publish one progress record. Best-effort: a status line must never fail the work it describes,
 *  and a call with no conversation (the router's raw-prompt classifier) has nothing to report to. */
export async function progress(
  client: RadiaClient,
  p: Omit<ProgressBody, "conversationId"> & { conversationId?: string; owner?: string },
  parentIds: string[] = [],
): Promise<void> {
  if (!p.conversationId) return;
  try {
    await client.put({
      kind: "progress",
      body: { ...p, conversationId: p.conversationId },
      parentIds,
      retentionUntil: new Date(Date.now() + TTL_MS).toISOString(),
    });
  } catch { /* no grant, space hiccup — the turn continues without a status line */ }
}
