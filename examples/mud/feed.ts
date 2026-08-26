// A room's feed: writing an event, and reading one room's stream.
//
// Shared by the narrator, the NPCs and (phase 2) the page, so the three cannot disagree about how a
// feed is ordered. Ordering is by RECORD ID, ascending, with `after` as the cursor: see kinds.ts on
// why there is no `index` field.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

export interface EventBody {
  worldId: string;
  roomId: string;
  /** The principal that caused this, or `"world"` for something nobody did. */
  actor: string;
  /** What to call the actor in prose. Denormalized so a renderer needs no second read. */
  actorName: string;
  verb: string;
  text: string;
  /** `"room"`, or one actor's principal for something only they perceive (the answer to `look`).
   *  A display convention; see kinds.ts. */
  audience: string;
  /** The `command` (or `npc_turn`) this line came out of. Indexed, so "has this already been
   *  narrated" is a query on the coordination plane: `parent_ids` answers the same question but
   *  only through lineage, which is the ops plane and no worker holds. */
  causedBy: string;
}

/**
 * Append to a room's feed.
 *
 * `key` is REQUIRED, and it is the whole of what makes at-least-once delivery survivable here.
 * Both writers reach this from inside a claim, so a lease expiry redelivers the work and the
 * handler runs again; without a key stable ACROSS attempts the room fills with doubled lines. Both
 * callers derive it from the id of the record they claimed, which is stable by construction and is
 * scoped to one agent, which is the granularity an idempotency key actually has.
 */
export function writeEvent(
  client: RadiaClient,
  body: EventBody,
  key: string,
  parentIds: string[] = [],
): Promise<{ id: string }> {
  return client.put({ kind: "event", body, parentIds }, key);
}

/** The newest `limit` events in a room, oldest first. What a client seeds its view from: a fresh
 *  join wants the tail, never the beginning of a room's history. */
export async function recentEvents(
  client: RadiaClient,
  worldId: string,
  roomId: string,
  limit = 30,
): Promise<RadiaRecord<EventBody>[]> {
  const rows = await client.queryNewest<EventBody>({ kind: "event", match: { worldId, roomId } }, limit);
  return rows.reverse();
}

/** Everything in this room after `afterId`, oldest first. The incremental half of the same view. */
export async function tailEvents(
  client: RadiaClient,
  worldId: string,
  roomId: string,
  afterId: string,
  limit = 50,
): Promise<RadiaRecord<EventBody>[]> {
  // ASCENDING from the caller's last-seen id: a feed is read forward, and `after` is exclusive in
  // the direction of the read, so this is "what happened since". `afterId` comes from the caller
  // rather than a cursor because it is a WATERMARK the caller persists, not a page position.
  return (await client.queryPage<EventBody>({ kind: "event", match: { worldId, roomId } }, limit, { dir: "asc", after: afterId })).records;
}
