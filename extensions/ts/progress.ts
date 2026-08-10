// What a worker is doing, as records.
//
// A worker that claims work publishes a `progress` record keyed to the call the caller awaits; the
// caller reads those and renders a live status line. No ops-plane access is involved, which is the
// point: watches wake only on available records and take/ack transitions live in the grant-gated
// event log, so a scoped principal has no other way to see that its work was picked up.
//
// The ABSENCE of a progress record is a signal too. A call nobody has claimed produces none, which
// is how a caller tells "no worker serves this" from "still thinking".

import type { KindDef, RadiaClient } from "../../sdk/ts/client.ts";

export const PROGRESS = "progress";

/** Retention is declared on the KIND, so no writer has to remember it: a status line's usefulness
 *  ends with the turn it describes. */
export const PROGRESS_KIND: KindDef = {
  kind: PROGRESS,
  indexedPaths: [
    { path: "callId", type: "keyword" },
    { path: "conversationId", type: "keyword" },
    { path: "owner", type: "keyword" },
  ],
  claimable: false,
  defaultRetentionSeconds: 3600,
};

export interface ProgressBody {
  conversationId: string;
  /** The call the CALLER awaits. For a re-dispatched call that is `replyTo`, not the new record id. */
  callId: string;
  /** routing | routed | generating | escalating | running. Short, renderable verbatim. */
  stage: string;
  /** The emitting worker's principal, so a reader sees WHO is doing the work. */
  by: string;
  note?: string;
}

/**
 * Publish one progress record.
 *
 * Best-effort by design: a status line must never fail the work it describes, and a call with no
 * conversation (a raw-prompt classifier, say) has nothing to report to.
 */
export async function progress(
  client: RadiaClient,
  p: Omit<ProgressBody, "conversationId"> & { conversationId?: string; owner?: string },
  parentIds: string[] = [],
): Promise<void> {
  if (!p.conversationId) return;
  try {
    await client.put({ kind: PROGRESS, body: { ...p, conversationId: p.conversationId }, parentIds });
  } catch { /* no grant, space hiccup: the work continues without a status line */ }
}
