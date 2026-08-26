// Where everyone is standing, as records. The `presence` kind's helpers, the way `feed.ts` owns
// `event`'s: the kind name and the body shape are stated HERE and nowhere else, so a reader names
// neither.
//
// READ AS A REGISTRY, never as a plain query. `presence` is append-only, so
// `query {worldId, roomId}` returns everyone who has EVER been in that room, including people who
// left an hour ago, because their old record survives until `radia gc` compacts it. The projection
// is by the kind's own `contentKey` (worldId + actor), which is the same statement `gc` compacts by.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

export interface PresenceBody {
  worldId: string;
  actor: string;
  roomId: string;
}

/** Everyone currently placed in a world, one entry per actor. Scoped to the WORLD rather than a
 *  room: the projection has to span it to see where somebody went. */
export function livePresence(
  client: RadiaClient,
  worldId: string,
): Promise<{ entries: ReadonlySet<RadiaRecord<PresenceBody>>; complete: boolean; scanned: number }> {
  return client.registry<PresenceBody>("presence", { worldId });
}
