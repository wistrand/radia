// Who may do what. One narrator, one principal per NPC, and the people playing.
//
// The point of the example is visible here rather than in any of the workers: an NPC is a PRINCIPAL,
// not a branch in the game loop. The gatekeeper holds `event: put` pinned to `{roomId: "gate"}`, so
// a gatekeeper that tried to speak in the tavern is refused at the write by `bodyMatchesGrant`, and
// no code of ours checks for it. Stopping an NPC is `radia runs --for agent:mud-npc-gatekeeper
// --stop`; that is the same mechanism, from the other end.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";
import { NPCS } from "./world.ts";

interface Grant {
  kind: string;
  operations: string[];
  /** ANDed into every read and matched against every write body. */
  pattern?: Record<string, unknown>;
}

export const NARRATOR = "agent:mud-narrator";
export const npcAgent = (npc: string) => `agent:mud-npc-${npc}`;

/**
 * The narrator: claims what players type, decides what happened, writes it down.
 *
 * `event: put` is UNPINNED here, unlike an NPC's, because the narrator speaks for the whole world:
 * it writes the departure line in the room you left and the arrival line in the one you entered, in
 * one handling. That reach is the reason it holds nothing else interesting: no `command: put` (it
 * cannot act as a player) and no `npc: put` (it cannot invent an NPC).
 */
const NARRATOR_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what it listens for
  { kind: "command", operations: ["take"] },
  // `query` as well as `put`, and it is not a nicety: the redelivery guard asks whether this
  // command was already narrated (`causedBy`), and without the read a lease that expired mid-turn
  // narrates the whole command a second time from wherever the player now stands.
  { kind: "event", operations: ["put", "query"] },
  { kind: "presence", operations: ["put", "query"] },
  // Where a newcomer wakes up is read from the `world` record, not from a constant here: the
  // narrator discovers the world it narrates. Shipped missing once, and the failure is the shape
  // this whole grant list is prone to — every command nacked with `no 'query' grant for kind
  // 'world'` and dead-lettered after six attempts, while the player's terminal simply showed
  // nothing at all.
  { kind: "world", operations: ["query"] },
  { kind: "room", operations: ["query"] },
  { kind: "npc", operations: ["query"] },
  { kind: "npc_turn", operations: ["put"] },
];

/**
 * An NPC: claims its own cues, speaks in its own room, and holds nothing else.
 *
 * `npc_turn: take` is scoped to its own name as well as its room. Without the pattern every NPC
 * would race for every cue, and at-least-once delivery means the loser does not merely lose: the
 * gatekeeper would claim the barkeep's cue, answer in the wrong voice, and the pin on `event: put`
 * would then refuse the write, so the turn would nack and redeliver forever.
 *
 * `event: put` pins the ROOM and the ACTOR. The room is what stops an NPC speaking somewhere it is
 * not standing; the actor is what stops it writing a line attributed to a player. Both are refused
 * by `bodyMatchesGrant` at the write, and no code in this example checks for either.
 *
 * `npc_turn: put` is the AMBIENT CLOCK, and it is pinned to this NPC's own name for the same
 * reason: an NPC schedules ITSELF and can put no words in another NPC's mouth. That write happens
 * through `ack`, which is authorized as an ordinary put for the acting agent, so the pin holds on
 * that path too.
 *
 * The room pin is a DEPLOYMENT fact, so an NPC that moves needs its definition re-minted. Phase 1
 * has none that move. When one does, the pin becomes a promotion-style rotation rather than a
 * wider grant, for the reason architecture-workspace-agents.md gives.
 */
const npcGrants = (npc: string, roomId: string): Grant[] => [
  { kind: "interest", operations: ["put", "query"] },
  { kind: "npc_turn", operations: ["take", "put"], pattern: { worldId: WORLD_ID, npc } },
  { kind: "event", operations: ["put"], pattern: { worldId: WORLD_ID, roomId, actor: npcAgent(npc) } },
];

/**
 * A person playing.
 *
 * `command: put` is pinned to their own principal, so a player physically cannot type as somebody
 * else: the runtime refuses the write, and the narrator never has to ask who really sent this.
 *
 * NOTE WHAT IS ABSENT. No `event: put`, so a player cannot narrate; no `presence: put`, so a player
 * cannot teleport by writing where they are; no `npc_turn: put`, so a player cannot puppet an NPC.
 * Everything a player does to the world goes through one kind, and the narrator is what turns it
 * into anything else.
 *
 * FOG OF WAR IS NOT ENFORCED, and this is where you would look for it. Reads are scoped to the
 * world, not the room, because a grant pattern is static and a player's room changes every move: a
 * `{roomId}` pattern would have to be rewritten on every step. So a curious player can query a room
 * they are not standing in. The alternative is per-recipient event fan-out
 * (agent_docs/plan-mud.md), which is enforceable and costs N records per room event; this example
 * ships the honest cheap version and says so.
 */
export function playerGrants(actor: string, worldId = WORLD_ID): Grant[] {
  return [
    { kind: "command", operations: ["put"], pattern: { worldId, actor } },
    { kind: "event", operations: ["query"], pattern: { worldId } },
    { kind: "presence", operations: ["query"], pattern: { worldId } },
    { kind: "room", operations: ["query"], pattern: { worldId } },
    { kind: "npc", operations: ["query"], pattern: { worldId } },
    { kind: "world", operations: ["query"], pattern: { worldId } },
  ];
}

export interface Bootstrapped {
  narratorToken: string;
  /** Definition token per NPC, keyed by npc name. Held by whatever process runs that NPC. */
  npcTokens: Record<string, string>;
}

/** Operator setup: the identities the fleet runs as. Nothing launched holds the operator token. */
export async function bootstrap(admin: RadiaClient): Promise<Bootstrapped> {
  const narrator = await admin.createAgentDefinition(NARRATOR, defs(NARRATOR, NARRATOR_GRANTS));
  const npcTokens: Record<string, string> = {};
  for (const npc of NPCS) {
    const agent = npcAgent(npc.npc);
    const def = await admin.createAgentDefinition(agent, defs(agent, npcGrants(npc.npc, npc.roomId)));
    npcTokens[npc.npc] = def.definitionToken;
  }
  return { narratorToken: narrator.definitionToken, npcTokens };
}

/** Operator action: let this person play. Idempotent, since grants are content-keyed. */
export async function grantPlayer(admin: RadiaClient, actor: string, worldId = WORLD_ID): Promise<void> {
  for (const g of playerGrants(actor, worldId)) await admin.grant(actor, g.kind, g.operations, g.pattern);
}

const defs = (agent: string, grants: Grant[]) =>
  grants.map((g) => ({
    principal: agent,
    kind: g.kind,
    operations: g.operations,
    ...(g.pattern ? { pattern: g.pattern } : {}),
  }));
