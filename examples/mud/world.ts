// The world, as data. Four rooms and two NPCs, written into the space as records.
//
// Phase 1 has no model anywhere: this is a hand-written world, so the whole example runs with no
// API key and the smoke test can assert on exact prose. Phase 4 replaces the descriptions with
// generated ones and changes nothing else, because a room is a record either way.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";

export interface RoomDef {
  roomId: string;
  name: string;
  description: string;
  /** direction -> roomId. Not an indexed path: movement reads this room's record, and no query
   *  ever asks "which rooms lead north". */
  exits: Record<string, string>;
}

export interface NpcDef {
  npc: string;
  name: string;
  roomId: string;
  description: string;
}

/** Where a player who has never been here wakes up. */
export const START_ROOM = "gate";

export const ROOMS: RoomDef[] = [
  {
    roomId: "gate",
    name: "The outer gate",
    description:
      "Two leaning towers and a portcullis someone has propped open with a cart axle. " +
      "Wind comes off the moor and finds every gap in your coat.",
    exits: { north: "courtyard" },
  },
  {
    roomId: "courtyard",
    name: "The courtyard",
    description:
      "Cobbles worn into a shallow bowl by three centuries of boots. A well stands in the middle " +
      "with its bucket missing.",
    exits: { south: "gate", east: "tavern", down: "cellar" },
  },
  {
    roomId: "tavern",
    name: "The Bell and Hammer",
    description:
      "Low beams, a fire that draws badly, and four tables that have all been mended at least once.",
    exits: { west: "courtyard" },
  },
  {
    roomId: "cellar",
    name: "The cellar",
    description:
      "Cold, and darker than the stair suggested. Barrels along one wall, and behind them something " +
      "that is not a barrel.",
    exits: { up: "courtyard" },
  },
];

export const NPCS: NpcDef[] = [
  {
    npc: "gatekeeper",
    name: "the gatekeeper",
    roomId: "gate",
    description: "A tall woman in a mail coat two sizes too large, reading a ledger she never turns a page of.",
  },
  {
    npc: "barkeep",
    name: "the barkeep",
    roomId: "tavern",
    description: "A broad man polishing a glass that was clean when you came in.",
  },
];

export const roomsById = new Map(ROOMS.map((r) => [r.roomId, r]));

/**
 * Write the world. Idempotent, and safe to re-run after an EDIT: the key carries a digest of the
 * body, so an unchanged room dedupes against its own earlier write and a changed one appends a
 * successor that latest-wins picks up.
 *
 * Keying on (worldId, roomId) alone would be worse than useless: an edited description would
 * collide with the original key and be refused with `idempotency_conflict` for the whole
 * idempotency window, which reads as "the space is broken" rather than "you changed the world".
 */
export async function seedWorld(admin: RadiaClient): Promise<void> {
  await write(admin, "world", `world:${WORLD_ID}`, {
    worldId: WORLD_ID,
    title: "The Keep at Ashfell",
    startRoom: START_ROOM,
  });
  for (const room of ROOMS) {
    await write(admin, "room", `room:${WORLD_ID}:${room.roomId}`, { worldId: WORLD_ID, ...room });
  }
  for (const npc of NPCS) {
    await write(admin, "npc", `npc:${WORLD_ID}:${npc.npc}`, { worldId: WORLD_ID, ...npc });
  }
}

/**
 * Start each NPC's ambient clock, if it is not already running.
 *
 * One deferred `npc_turn` per NPC. From there the NPC keeps its own chain going by acking each beat
 * with the next one (`npc.ts`), so this runs once in the life of a world and nothing holds an
 * interval anywhere.
 *
 * THE EXISTENCE CHECK IS THE WHOLE OF IT, and it is not an optimisation: seeding a second cue would
 * give one NPC two clocks, both self-perpetuating, with nothing to notice or stop them. A content
 * key would not do the job on its own, because idempotency expires (7 days) and a launcher re-run
 * after that writes a fresh record. So the question asked is "does a cue exist at all", on the
 * coordination plane, with `trigger` indexed for it.
 *
 * What this deliberately does NOT do is revive a chain that DIED (a cue dead-lettered after its
 * attempts). That needs `radia remediate requeue`, because "no cue is pending" and "a cue is
 * pending and overdue" are the same answer to a content-plane query, and guessing between them is
 * how the double-clock gets in.
 */
export async function seedAmbient(admin: RadiaClient, delaySeconds = 5): Promise<string[]> {
  const started: string[] = [];
  for (const npc of NPCS) {
    const existing = await admin.query({ kind: "npc_turn", match: { worldId: WORLD_ID, npc: npc.npc, trigger: "ambient" } }, 1);
    if (existing.length > 0) continue;
    await admin.put({
      kind: "npc_turn",
      body: { worldId: WORLD_ID, npc: npc.npc, roomId: npc.roomId, trigger: "ambient", tick: 0 },
      availableAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    }, `ambient:${WORLD_ID}:${npc.npc}:0`);
    started.push(npc.npc);
  }
  return started;
}

async function write(admin: RadiaClient, kind: string, keyPrefix: string, body: Record<string, unknown>): Promise<void> {
  await admin.put({ kind, body }, `${keyPrefix}:${await digest(body)}`);
}

/** Short content digest of a body, for the write key. Web Crypto, no dependency and no import from
 *  `src/` (an example is an app, but it has no business reaching into the runtime for a hash). */
async function digest(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
