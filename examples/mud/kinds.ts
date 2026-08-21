// The record kinds for a shared world (agent_docs/plan-mud.md).
//
// The design is in what is DECLARED. Prose (`text`, `description`) stays undeclared: nothing routes
// on it, and an undeclared path is invisible to matching, which is what would let the encrypted-body
// convention apply later without re-deciding anything.
//
// Phase 1 declares only what phase 1 uses. `contest` (phase 3) and `scene_image` (phase 5) are in
// the plan's table and are not here, because a kind nothing writes is a promise nothing keeps.

import type { RadiaClient } from "../../sdk/ts/client.ts";

/** The world this example seeds. Every kind indexes `worldId`, so one space can hold several. */
export const WORLD_ID = "keep";

/** A week. `event` and `command` carry a person's own words, and a record BODY has no erasure path
 *  (CLAUDE.md), so the choice is between ephemera-by-default and a permanent transcript. Declared
 *  on the KIND, so the runtime materializes `retention_until` at commit and every record stays
 *  self-describing; a later redeclaration changes only future records. Swept by `radia gc`. */
const TRANSCRIPT_RETENTION_SECONDS = 7 * 24 * 3600;

export async function registerMudKinds(client: RadiaClient): Promise<void> {
  // The world's static frame: title, the room a new player wakes in, the tone a narrator writes in.
  await client.registerKind({
    kind: "world",
    indexedPaths: [{ path: "worldId", type: "keyword" }],
    contentKey: ["worldId"],
    claimable: false,
  });

  // A place. `exits` is a body field nothing matches on, so it is not declared: movement is decided
  // by reading the room record, never by a query over exits.
  await client.registerKind({
    kind: "room",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "roomId", type: "keyword" },
    ],
    contentKey: ["worldId", "roomId"],
    claimable: false,
  });

  // Where an actor is. A latest-wins registry keyed by (worldId, actor): each move appends a
  // successor and `radia gc` compacts the trail to the newest per actor.
  //
  // `contentKey` is for COMPACTION, never for the write key. Keying the write on (worldId, actor)
  // would make walking back into a room you left dedupe against the earlier record and silently
  // not move you, for the whole idempotency window.
  await client.registerKind({
    kind: "presence",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "actor", type: "keyword" },
      { path: "roomId", type: "keyword" },
    ],
    contentKey: ["worldId", "actor"],
    claimable: false,
  });

  // `fact` (the plan's table, melkrox's `facts` dict) is NOT here. Phase 1's only mutable state is
  // where everybody is standing, which is `presence`; a kind nothing writes is a promise nothing
  // keeps. It arrives in phase 4 with the narrator that needs it.

  // What a player typed. CLAIMABLE: the narrator takes it under a fenced lease, so a crashed
  // narrator's command is redelivered rather than lost.
  //
  // There is deliberately no `roomId` here. Where the actor is standing is `presence`, which the
  // narrator writes; a room named by the client would be a CLAIM, and trusting it would let a stale
  // tab act in a room it has already left.
  await client.registerKind({
    kind: "command",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "actor", type: "keyword" },
    ],
    claimable: true,
    defaultRetentionSeconds: TRANSCRIPT_RETENTION_SECONDS,
  });

  // What happened, and the room's feed. Read by every client in the room and by nobody else.
  //
  // NO `index` FIELD, and the reason is a property of idempotency rather than a preference: an
  // idempotency key is scoped to the AGENT behind the caller, so the slot-claiming trick that
  // orders the chat's transcript (`msg:<conv>:<i>`, examples/chat/client/thread.ts) does not work
  // across principals, and a narrator and an NPC would both write index N without either seeing a
  // conflict. Feeds are ordered and tailed by RECORD ID instead: one runtime process mints
  // monotonic ULIDs (`src/core/ids.ts`), so `{dir: "asc", after: lastId}` is a total, gap-free
  // cursor. The honest limit is several instances over one database, where ids tie inside a
  // millisecond; this example runs one.
  await client.registerKind({
    kind: "event",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "roomId", type: "keyword" },
      { path: "actor", type: "keyword" },
      { path: "verb", type: "keyword" },
      // "the room" or one actor's principal. A DISPLAY convention, not enforcement: players read
      // the whole world's feed (see roles.ts on fog of war), so a client renders what is addressed
      // to it and the space refuses nothing.
      { path: "audience", type: "keyword" },
      // The claimed record this line came out of. Indexed so a worker can ask "did I already
      // narrate this command" on the COORDINATION plane. `parent_ids` carries the same fact and is
      // reachable only through lineage, which is the ops plane and no worker here holds it.
      { path: "causedBy", type: "keyword" },
    ],
    claimable: false,
    defaultRetentionSeconds: TRANSCRIPT_RETENTION_SECONDS,
  });

  // An NPC's definition: name, where it stands, what it is. A registry, so retiring one removes it
  // and editing one is a successor.
  await client.registerKind({
    kind: "npc",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "npc", type: "keyword" },
      { path: "roomId", type: "keyword" },
    ],
    contentKey: ["worldId", "npc"],
    claimable: false,
  });

  // An NPC's cue to act. CLAIMABLE for the same reason `command` is: a lease, and redelivery if the
  // NPC dies mid-turn. Each cue CARRIES what the NPC needs (who spoke, what they said), so an NPC
  // needs no grant to read the event that provoked it.
  await client.registerKind({
    kind: "npc_turn",
    indexedPaths: [
      { path: "worldId", type: "keyword" },
      { path: "npc", type: "keyword" },
      { path: "roomId", type: "keyword" },
    ],
    claimable: true,
    defaultRetentionSeconds: TRANSCRIPT_RETENTION_SECONDS,
  });
}
