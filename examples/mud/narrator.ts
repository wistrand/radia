// The narrator: claims what a player typed, decides what happened, writes it down.
//
//   deno run -A examples/mud/narrator.ts --url http://127.0.0.1:7788 --token <definition token>
//
// One worker, no model (phase 1). It is the only writer of `event` and `presence`, which is what
// makes a player's grant set as small as it is: a player writes `command` and nothing else.
//
// Three rules here are worth keeping when phase 4 replaces the parser with a model.
//
// WHERE SOMEBODY IS STANDING COMES FROM `presence`, NEVER FROM THE COMMAND. A room named by a
// client is a claim; a stale tab would otherwise act in a room it has already left.
//
// EVERY EVENT CARRIES `causedBy`, AND A COMMAND ALREADY NARRATED IS NOT NARRATED AGAIN. Delivery is
// at-least-once, so this handler runs again whenever a lease expires mid-turn. The `evt:<id>:<n>`
// keys below dedupe an exact repeat, and they are not enough on their own: a redelivery re-reads
// `presence`, which the first attempt may already have moved, so the second attempt walks a
// DIFFERENT branch and its writes collide with the first attempt's under the same keys. The query
// guard is what covers that, and the keys cover the two attempts racing before either write is
// visible. Neither can be dropped.
//
// `ack` cannot do this job: its idempotency key carries the lease epoch, so a redelivered claim
// acks a fresh record by design (`sdk/ts/loop.ts`).

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient, RadiaClientError, type RadiaRecord } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";
import { type EventBody, writeEvent } from "./feed.ts";

interface CommandBody {
  worldId: string;
  actor: string;
  text: string;
}

interface RoomBody {
  worldId: string;
  roomId: string;
  name: string;
  description: string;
  exits: Record<string, string>;
}

interface PresenceBody {
  worldId: string;
  actor: string;
  roomId: string;
}

interface NpcBody {
  worldId: string;
  npc: string;
  name: string;
  roomId: string;
  description: string;
}

/** Compass shorthand, and the direction you came FROM once you arrive. */
const DIRECTIONS: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west", u: "up", d: "down",
  north: "north", south: "south", east: "east", west: "west", up: "up", down: "down",
};
const OPPOSITE: Record<string, string> = {
  north: "the south", south: "the north", east: "the west", west: "the east", up: "below", down: "above",
};

const HELP = [
  "look                 what is here",
  "go <direction>       north, south, east, west, up, down (or just: north)",
  "say <words>          speak, and everyone here hears it",
  "emote <words>        do something everyone here sees",
  "who                  who else is in this room",
].join("\n");

export function narratorLoop(
  client: RadiaClient,
  opts: { worldId?: string; signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<void> {
  const worldId = opts.worldId ?? WORLD_ID;
  return agentLoop(client, {
    name: "narrator",
    patterns: [{ kind: "command", match: { worldId } }],
    signal: opts.signal,
    log: opts.log,
    handle: (record, c) => narrate(c, worldId, record, opts.log),
  });
}

async function narrate(
  client: RadiaClient,
  worldId: string,
  command: RadiaRecord,
  log?: (m: string) => void,
): Promise<void> {
  const { actor, text } = command.body as CommandBody;
  const actorName = displayName(actor);

  // Already narrated. A redelivery, and the world has moved on since: leave it alone and ack.
  const already = await client.queryOldest({ kind: "event", match: { worldId, causedBy: command.id } }, 1);
  if (already.length > 0) {
    log?.(`[narrator] ${command.id.slice(-6)} was already narrated; acking without writing`);
    return;
  }

  let n = 0;
  const emit = async (body: Omit<EventBody, "worldId" | "actor" | "actorName" | "causedBy">) => {
    const key = `evt:${command.id}:${n++}`;
    try {
      await writeEvent(client, { worldId, actor, actorName, causedBy: command.id, ...body }, key, [command.id]);
    } catch (e) {
      // This key belongs to this command's handling and to nothing else, so a conflict can only
      // mean another attempt of THIS claim got here first. Its version stands.
      if (!(e instanceof RadiaClientError && e.code === "idempotency_conflict")) throw e;
      log?.(`[narrator] ${key} was written by another attempt; keeping it`);
    }
  };

  // A player-caused, room-audible event is what an NPC reacts to. Collected as it is written and
  // cued at the end, so one command produces at most one cue per NPC.
  //
  // Declared BEFORE the placement below, because a newcomer's arrival is one of these: writing it
  // with `emit` instead left the gatekeeper silent for the one event she exists to react to.
  const audible: { roomId: string; verb: string; text: string }[] = [];
  const broadcast = async (inRoom: string, v: string, t: string) => {
    await emit({ roomId: inRoom, verb: v, text: t, audience: "room" });
    audible.push({ roomId: inRoom, verb: v, text: t });
  };

  const roomId = await locate(client, worldId, actor) ?? await placeNewcomer(client, worldId, actor, command, broadcast);
  const room = await readRoom(client, worldId, roomId);
  if (!room) {
    // A presence pointing at a room nobody declared. Said in the feed rather than thrown: a nack
    // would redeliver forever against a world that is not going to change by itself.
    await emit({ roomId, verb: "error", audience: actor, text: `You are somewhere the world does not describe (${roomId}).` });
    return;
  }

  const words = (text ?? "").trim();
  const verb = words.split(/\s+/)[0]?.toLowerCase() ?? "";
  const rest = words.slice(verb.length).trim();

  const toActor = (v: string, t: string) => emit({ roomId: room.roomId, verb: v, text: t, audience: actor });

  switch (verb) {
    case "":
      break;
    case "look":
    case "l":
      await toActor("look", await describe(client, worldId, room, actor));
      break;
    case "who": {
      const { here, complete } = await occupantsOf(client, worldId, room.roomId, actor);
      await toActor("who", here.length ? here.join("\n") + incomplete(complete) : "Nobody else." + incomplete(complete));
      break;
    }
    case "help":
      await toActor("help", HELP);
      break;
    case "say":
      if (!rest) await toActor("say", "Say what?");
      else await broadcast(room.roomId, "say", `${actorName} says, "${rest}"`);
      break;
    case "emote":
    case "me":
      if (!rest) await toActor("emote", "Do what?");
      else await broadcast(room.roomId, "emote", `${actorName} ${rest}`);
      break;
    default: {
      const dir = DIRECTIONS[verb === "go" ? rest.toLowerCase() : verb];
      if (!dir) {
        await toActor("unknown", "Nothing happens. Try: help");
        break;
      }
      const to = room.exits[dir];
      if (!to) {
        await toActor("blocked", `There is no way ${dir} from here.`);
        break;
      }
      // The order matters to anyone tailing both rooms: leave, then move, then arrive.
      await broadcast(room.roomId, "leave", `${actorName} goes ${dir}.`);
      await client.put({
        kind: "presence",
        body: { worldId, actor, roomId: to } satisfies PresenceBody,
        parentIds: [command.id],
      }, `pres:${command.id}`);
      await broadcast(to, "arrive", `${actorName} arrives from ${OPPOSITE[dir] ?? "somewhere"}.`);
      const there = await readRoom(client, worldId, to);
      if (there) {
        await emit({ roomId: to, verb: "look", audience: actor, text: await describe(client, worldId, there, actor) });
      }
      break;
    }
  }

  await cueNpcs(client, worldId, command, audible, actor);
}

/**
 * Cue every NPC standing where something audible just happened.
 *
 * ONLY FOR PLAYER-CAUSED EVENTS, which is why this takes what this command produced rather than
 * reading the feed. An NPC's own line is an event in the same room, so cueing on any event at all
 * would make two NPCs sharing a room answer each other until somebody stopped one of them.
 */
async function cueNpcs(
  client: RadiaClient,
  worldId: string,
  command: RadiaRecord,
  audible: { roomId: string; verb: string; text: string }[],
  actor: string,
): Promise<void> {
  if (audible.length === 0) return;
  const rooms = new Set(audible.map((a) => a.roomId));
  const npcs = (await client.queryOldest({ kind: "npc", match: { worldId } }, 200))
    .map((r) => r.body as NpcBody)
    .filter((npc) => rooms.has(npc.roomId));
  if (npcs.length === 0) return;
  for (const [i, cue] of audible.entries()) {
    for (const npc of npcs) {
      if (npc.roomId !== cue.roomId) continue;
      await client.put({
        kind: "npc_turn",
        // The cue CARRIES what the NPC needs. An NPC holds no grant to read `event`, and should
        // not: a worker that reads a record named by a body field reads it with its OWN authority
        // (plan-encryption.md phase 0), and the less of that an NPC can do the better.
        body: {
          worldId,
          npc: npc.npc,
          roomId: cue.roomId,
          cause: { actor, actorName: displayName(actor), verb: cue.verb, text: cue.text },
        },
        parentIds: [command.id],
      }, `cue:${command.id}:${i}:${npc.npc}`).catch((e) => {
        if (!(e instanceof RadiaClientError && e.code === "idempotency_conflict")) throw e;
      });
    }
  }
}

/** Where this actor is, or null for somebody the world has never seen. */
async function locate(client: RadiaClient, worldId: string, actor: string): Promise<string | null> {
  const rows = await client.queryNewest({ kind: "presence", match: { worldId, actor } }, 1);
  return rows.length ? (rows[0].body as PresenceBody).roomId : null;
}

/** First contact: stand them at the world's start room. There is no join verb anywhere, so a player
 *  exists from the moment they type. */
async function placeNewcomer(
  client: RadiaClient,
  worldId: string,
  actor: string,
  command: RadiaRecord,
  broadcast: (inRoom: string, verb: string, text: string) => Promise<void>,
): Promise<string> {
  const world = (await client.queryNewest({ kind: "world", match: { worldId } }, 1))[0];
  const roomId = (world?.body as { startRoom?: string })?.startRoom ?? "gate";
  await client.put({
    kind: "presence",
    body: { worldId, actor, roomId } satisfies PresenceBody,
    parentIds: [command.id],
  }, `pres-first:${command.id}`);
  await broadcast(roomId, "arrive", `${displayName(actor)} is here, blinking.`);
  return roomId;
}

async function readRoom(client: RadiaClient, worldId: string, roomId: string): Promise<RoomBody | null> {
  // A `query` rather than `readOne`, deliberately: `readOne` is a separate coordination verb with
  // its own grant, and the narrator holds `room: query` and nothing more.
  const rows = await client.queryNewest({ kind: "room", match: { worldId, roomId } }, 1);
  return rows.length ? rows[0].body as RoomBody : null;
}

/** The room as a player sees it. */
async function describe(client: RadiaClient, worldId: string, room: RoomBody, actor: string): Promise<string> {
  const { here, complete } = await occupantsOf(client, worldId, room.roomId, actor);
  const npcs = (await client.queryOldest({ kind: "npc", match: { worldId, roomId: room.roomId } }, 50))
    .map((r) => r.body as NpcBody);
  const exits = Object.keys(room.exits);
  return [
    room.name,
    room.description,
    ...npcs.map((n) => `${cap(n.name)} is here. ${n.description}`),
    ...here,
    exits.length ? `Exits: ${exits.join(", ")}.` : "There is no way out.",
  ].join("\n") + incomplete(complete);
}

/**
 * Who else is standing here.
 *
 * READ AS A REGISTRY, never as a plain query. `presence` is append-only, so
 * `query {worldId, roomId}` returns everyone who has EVER been in this room, including people who
 * left an hour ago, because their old record survives until `radia gc` compacts it. Project
 * latest-wins per actor first, then filter. A projection over an append-only log read as state is
 * the most repeated bug in this codebase (CLAUDE.md), and a room full of ghosts is what it looks
 * like from in here.
 *
 * The key is NOT restated here: `client.registry` projects by the `contentKey` the kind declares
 * (`worldId` + `actor`), which is the same statement `radia gc` compacts by. Filtering by room
 * stays client-side, since the projection must span the whole world to see where someone went.
 */
async function occupantsOf(
  client: RadiaClient,
  worldId: string,
  roomId: string,
  actor: string,
): Promise<{ here: string[]; complete: boolean }> {
  const view = await client.registry("presence", { worldId });
  const here = view.entries
    .map((r) => r.body as PresenceBody)
    .filter((p) => p.roomId === roomId && p.actor !== actor)
    .map((p) => `${displayName(p.actor)} is here.`);
  return { here, complete: view.complete };
}

/** The registry read reports when it could not exhaust the kind. Saying so beats a plausible list:
 *  the answer to "who is here" is a population, and a prefix of one is a different answer. */
const incomplete = (complete: boolean) => complete ? "" : "\n(Too many people to count; this list is partial.)";

/** What to call a principal in prose. Phase 2 replaces this with the display name the IdP hands
 *  over at sign-in, which is why it is one function rather than sprinkled through the text. */
export function displayName(principal: string): string {
  return principal.split(":").pop() ?? principal;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

if (import.meta.main) {
  const arg = (n: string) => {
    const i = Deno.args.indexOf(n);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
  const token = arg("--token");
  if (!token) throw new Error("the narrator needs --token <definition token> (roles.ts mints one)");
  await narratorLoop(new RadiaClient(url, { definitionToken: token }), { log: (m) => console.error(m) });
}
