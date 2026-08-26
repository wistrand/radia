// A scripted NPC: claims its own cues and answers in its own room.
//
//   deno run -A examples/mud/npc.ts --url http://127.0.0.1:7788 --npc gatekeeper --token <def token>
//
// The whole worker is `agentLoop` plus a pure function, which is the point of phase 1: an NPC is a
// principal with grants, not a branch in the game loop. Phase 2 changes nothing here. Phase 4
// replaces `BEHAVIOURS` with an `llm_call` and still changes nothing about the claim, the lease or
// the grant. Phase 6 moves the behaviour into a workspace tree run under a pinned digest.
//
// NO REDELIVERY GUARD HERE, unlike the narrator, and the difference is worth understanding: this
// handler is a pure function of the record it claimed, so a second attempt computes the same line
// and the `evt:<cue id>` key dedupes it. The narrator needs a guard because it reads `presence`,
// which its own first attempt may already have changed.
//
// AMBIENT BEHAVIOUR IS A CHAIN OF DEFERRED CUES, and it is the reason `PutRequest.availableAt`
// exists (agent_docs/plan-milestones.md, "delayed visibility"). An NPC acks its ambient cue with
// the NEXT one, deferred by `ambientSeconds`, so a wandering guard needs no process holding an
// interval. That matters beyond tidiness: a phase-6 workspace NPC is a pure function of the record
// it claimed and then exits, so an interval was never available to it, and this is.
//
// The chain cannot break at the hop. Ack is consume-and-emit ATOMICALLY, so either the cue is still
// claimable (and gets redelivered) or it is consumed and its successor exists. What CAN break it is
// a cue dead-lettering after `maxAttempts`, and the repair is `radia remediate requeue`, not
// restarting anything: a restart that re-seeded would leave the NPC with two clocks.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient, RadiaClientError, type RadiaRecord } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";
import { writeEvent } from "./feed.ts";
import { npcAgent } from "./roles.ts";

export interface NpcCue {
  worldId: string;
  npc: string;
  roomId: string;
  /** `player`: the narrator saw something this NPC should react to. `ambient`: the NPC's own clock.
   *  Absent on cues written before ambient existed, which read as `player`. */
  trigger?: "player" | "ambient";
  /** Which beat of the ambient chain this is. Absent on a player cue. */
  tick?: number;
  /** What provoked it. Absent on an ambient cue: nobody did anything. */
  cause?: { actor: string; actorName: string; verb: string; text: string };
}

/** What an NPC says, or null for "it does not react to that". Pure, so the smoke test can assert on
 *  exact prose and a redelivery is free. */
export type Behaviour = (cue: NpcCue, name: string) => string | null;

/** What an NPC does when nobody is doing anything. Null is a beat where it does nothing visible,
 *  which is most of them: an NPC that speaks every tick is noise, and the chain continues either
 *  way. `tick` is the only state it gets, and it comes from the record. */
export type Ambient = (tick: number, name: string) => string | null;

const mentions = (text: string, words: string[]) => {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
};

export const BEHAVIOURS: Record<string, Behaviour> = {
  gatekeeper: (cue, name) => {
    const { verb, text, actorName } = cue.cause!;
    if (verb === "arrive") return `${cap(name)} looks up from her ledger. "Name and business."`;
    if (verb !== "say") return null;
    if (mentions(text, ["gate", "open", "portcullis"])) {
      return `${cap(name)} does not look up. "The gate stays as it is. I only write down who goes through."`;
    }
    if (mentions(text, ["hello", "hail", "greetings", "hi "])) {
      return `${cap(name)} writes something in the ledger. "Afternoon, ${actorName}."`;
    }
    return `${cap(name)} turns a page she has already read.`;
  },
  barkeep: (cue, name) => {
    const { verb, text } = cue.cause!;
    if (verb === "arrive") return `${cap(name)} sets the glass down. "Sit anywhere. The fire draws badly but it draws."`;
    if (verb !== "say") return null;
    if (mentions(text, ["ale", "drink", "beer", "wine"])) {
      return `${cap(name)} is already reaching for a cup. "Copper a cup, and I'll trust you for it."`;
    }
    if (mentions(text, ["cellar", "barrel", "down"])) {
      return `${cap(name)} stops polishing. "Nothing down there but barrels. Leave it."`;
    }
    return `${cap(name)} grunts and keeps polishing.`;
  },
};

/**
 * What each NPC does on its own clock. Cycled by tick, and mostly nothing: three quiet beats to one
 * visible line, so a room with an NPC in it feels inhabited rather than chatty.
 */
export const AMBIENT: Record<string, Ambient> = {
  gatekeeper: (tick, name) => {
    const beats = [
      null,
      `${cap(name)} turns a page of the ledger and writes nothing in it.`,
      null,
      `${cap(name)} shifts her weight and looks down the road.`,
      null,
      null,
    ];
    return beats[tick % beats.length];
  },
  barkeep: (tick, name) => {
    const beats = [
      null,
      `${cap(name)} holds a glass up to the fire, frowns, and polishes it again.`,
      null,
      null,
      `${cap(name)} pokes the fire. It draws no better.`,
      null,
    ];
    return beats[tick % beats.length];
  },
};

/** How long the ambient chain waits between beats. Thirty seconds reads as a place going about its
 *  business; the smoke test drops it to one so the chain is observable. */
export const AMBIENT_SECONDS = 30;

export function npcLoop(
  client: RadiaClient,
  npc: string,
  name: string,
  opts: { worldId?: string; signal?: AbortSignal; log?: (m: string) => void; ambientSeconds?: number } = {},
): Promise<void> {
  const worldId = opts.worldId ?? WORLD_ID;
  const behaviour = BEHAVIOURS[npc];
  if (!behaviour) throw new Error(`no behaviour for npc '${npc}'`);
  const ambient = AMBIENT[npc] ?? (() => null);
  const ambientSeconds = opts.ambientSeconds ?? AMBIENT_SECONDS;
  return agentLoop<NpcCue>(client, {
    name: `npc:${npc}`,
    // Its own name as well as the world. Every NPC would otherwise race for every cue, and
    // at-least-once means the loser does not merely lose: it would answer in the wrong voice, the
    // pin on `event: put` would refuse the write, and the cue would nack and redeliver forever.
    patterns: [{ kind: "npc_turn", match: { worldId, npc } }],
    signal: opts.signal,
    log: opts.log,
    handle: async (record, c) => {
      const cue = record.body;
      const isAmbient = cue.trigger === "ambient";
      const tick = cue.tick ?? 0;
      const line = isAmbient ? ambient(tick, name) : behaviour(cue, name);
      if (line) {
        try {
          await writeEvent(c, {
            worldId: cue.worldId,
            roomId: cue.roomId,
            // Its own PRINCIPAL, which its `event: put` grant is pinned to alongside the room. An
            // NPC therefore cannot attribute a line to a player, and the refusal is the runtime's
            // rather than a check of ours.
            actor: npcAgent(npc),
            actorName: name,
            // `emote` rather than `say`: an ambient beat is something a room sees, not something
            // said to anyone. The verb is indexed, so a client can render or mute the two apart.
            verb: isAmbient ? "emote" : "say",
            text: line,
            audience: "room",
            causedBy: record.id,
          }, `evt:${record.id}`, [record.id]);
        } catch (e) {
          if (!(e instanceof RadiaClientError && e.code === "idempotency_conflict")) throw e;
          opts.log?.(`[npc:${npc}] ${record.id.slice(-6)} was already answered; keeping that line`);
        }
      }
      if (!isAmbient) return;
      // The next beat, ACKED rather than put: consume-and-emit is atomic, so the chain cannot end
      // up with this cue consumed and no successor. Returned even when the beat was silent, or the
      // clock stops on the first quiet tick.
      //
      // `availableAt` is computed from THIS process's clock and compared against the database's, so
      // the interval is approximate. The space clamps a value already past and refuses one beyond
      // its ceiling, which is why an NPC cannot schedule itself into the next century.
      return {
        kind: "npc_turn",
        body: {
          worldId: cue.worldId,
          npc,
          roomId: cue.roomId,
          trigger: "ambient",
          tick: tick + 1,
        },
        availableAt: new Date(Date.now() + ambientSeconds * 1000).toISOString(),
      };
    },
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

if (import.meta.main) {
  const arg = (n: string) => {
    const i = Deno.args.indexOf(n);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
  const npc = arg("--npc");
  const token = arg("--token");
  if (!npc || !token) throw new Error("usage: npc.ts --npc <name> --token <definition token> [--url …]");
  const name = arg("--name") ?? `the ${npc}`;
  const every = arg("--ambient-seconds");
  await npcLoop(new RadiaClient(url, { definitionToken: token }), npc, name, {
    log: (m) => console.error(m),
    ...(every ? { ambientSeconds: Number(every) } : {}),
  });
}
