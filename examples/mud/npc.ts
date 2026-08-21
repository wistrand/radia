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

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient, RadiaClientError, type RadiaRecord } from "../../sdk/ts/client.ts";
import { WORLD_ID } from "./kinds.ts";
import { writeEvent } from "./feed.ts";
import { npcAgent } from "./roles.ts";

export interface NpcCue {
  worldId: string;
  npc: string;
  roomId: string;
  cause: { actor: string; actorName: string; verb: string; text: string };
}

/** What an NPC says, or null for "it does not react to that". Pure, so the smoke test can assert on
 *  exact prose and a redelivery is free. */
export type Behaviour = (cue: NpcCue, name: string) => string | null;

const mentions = (text: string, words: string[]) => {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
};

export const BEHAVIOURS: Record<string, Behaviour> = {
  gatekeeper: (cue, name) => {
    const { verb, text, actorName } = cue.cause;
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
    const { verb, text } = cue.cause;
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

export function npcLoop(
  client: RadiaClient,
  npc: string,
  name: string,
  opts: { worldId?: string; signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<void> {
  const worldId = opts.worldId ?? WORLD_ID;
  const behaviour = BEHAVIOURS[npc];
  if (!behaviour) throw new Error(`no behaviour for npc '${npc}'`);
  return agentLoop(client, {
    name: `npc:${npc}`,
    // Its own name as well as the world. Every NPC would otherwise race for every cue, and
    // at-least-once means the loser does not merely lose: it would answer in the wrong voice, the
    // pin on `event: put` would refuse the write, and the cue would nack and redeliver forever.
    patterns: [{ kind: "npc_turn", match: { worldId, npc } }],
    signal: opts.signal,
    log: opts.log,
    handle: async (record: RadiaRecord, c: RadiaClient) => {
      const cue = record.body as NpcCue;
      const line = behaviour(cue, name);
      if (!line) return;
      try {
        await writeEvent(c, {
          worldId: cue.worldId,
          roomId: cue.roomId,
          // Its own PRINCIPAL, which its `event: put` grant is pinned to alongside the room. An NPC
          // therefore cannot attribute a line to a player, and the refusal is the runtime's rather
          // than a check of ours.
          actor: npcAgent(npc),
          actorName: name,
          verb: "say",
          text: line,
          audience: "room",
          causedBy: record.id,
        }, `evt:${record.id}`, [record.id]);
      } catch (e) {
        if (!(e instanceof RadiaClientError && e.code === "idempotency_conflict")) throw e;
        opts.log?.(`[npc:${npc}] ${record.id.slice(-6)} was already answered; keeping that line`);
      }
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
  await npcLoop(new RadiaClient(url, { definitionToken: token }), npc, name, { log: (m) => console.error(m) });
}
