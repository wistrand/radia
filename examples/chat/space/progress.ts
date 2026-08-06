// Turn progress expressed as RECORDS. A worker that claims work publishes what it is doing as a
// `progress` record keyed to the call the chat awaits; the chat reads those and renders a live
// status line. Progress is therefore content-routed like everything else. Any client (or the
// console Feed) sees the same stream, and no ops-plane access is needed: watches only wake on
// available records, and take/ack transitions live in the grant-gated event log, so a scoped
// session principal could not observe claims any other way.
//
// The absence of a progress record is itself the signal the chat uses: a call nobody has claimed
// produces no progress, which is how "no worker serves this" is distinguished from "still thinking".

import type { RadiaClient } from "../../../sdk/ts/client.ts";

export interface ProgressBody {
  conversationId: string;
  /** The call the CHAT awaits. For a re-dispatched call that is `replyTo`, not the new record id. */
  callId: string;
  /** routing | routed | generating | escalating | running. Short, renderable verbatim. */
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
      // Retention comes from the KIND: `progress` declares defaultRetentionSeconds in kinds.ts and
      // the runtime stamps it at commit. This file used to stamp its own per put, which was the
      // per-call-site memory the kind-level default exists to retire.
      parentIds,
    });
  } catch { /* no grant, space hiccup: the turn continues without a status line */ }
}
