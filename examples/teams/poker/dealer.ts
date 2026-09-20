// The dealer, as a `service: true` member of the team.
//
// `radia team up` spawns this once and supervises it until the run ends, rather than looping it
// over claims: it is the one participant that is not answering a turn. It deals, writes the board,
// asks each player in turn, and settles the pot, all through the same public API a player uses.
//
// It holds every poker kind team-scoped, because it deals the cards and narrowing its reads would
// buy nothing. What the example constrains is the PLAYERS, in `team.json`'s per-member grants.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { playHand, rng, type Seat, shuffled } from "../../poker/poker.ts";

export interface DealerRunOptions {
  team: string;
  players: string[];
  hands: number;
  startingStack?: number;
  seed?: number;
  /** How long a player has to claim and answer its turn before the dealer folds the seat.
   *
   *  A model launch is seconds, so this is far longer than the scripted example's four. It is also
   *  the cost of a member that is down: every turn it is dealt stalls the table for this long, and
   *  a four-handed hand has eight to twelve turns. Measured against real harnesses, a turn takes
   *  8-30s, so two minutes is a stall and not a slow player. */
  actionTimeoutMs?: number;
  log?: (line: string) => void;
}

/** Deal `hands` hands and return the final stacks. */
export async function runDealer(
  dealer: RadiaClient,
  opts: DealerRunOptions,
): Promise<{ seats: Seat[]; hands: number }> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const seats: Seat[] = opts.players.map((name) => ({
    principal: `agent:${name}`,
    name,
    stack: opts.startingStack ?? 500,
  }));
  const session = `t${Date.now().toString(36)}`;
  const next = rng(opts.seed ?? Date.now() & 0xffff);

  for (let h = 1; h <= opts.hands; h++) {
    await playHand(dealer, seats, `${session}-h${h}`, shuffled(next), {
      session,
      team: opts.team,
      actionTimeoutMs: opts.actionTimeoutMs ?? 120_000,
      log,
    });
    log(`  stacks: ${seats.map((s) => `${s.name} ${s.stack}`).join(", ")}`);
  }

  // The team's `done` pattern, so `radia team up` ends itself rather than waiting to be killed.
  await dealer.put({
    kind: "poker_hand_result",
    body: {
      session,
      team: opts.team,
      handId: "final",
      pot: 0,
      winners: [seats.reduce((a, b) => (a.stack >= b.stack ? a : b)).principal],
      shown: [],
      standings: seats.map((s) => ({ player: s.principal, stack: s.stack })),
    },
  }, `result:${session}:final`);
  return { seats, hands: opts.hands };
}

if (import.meta.main) {
  const arg = (name: string, fallback?: string) => {
    const at = Deno.args.indexOf(`--${name}`);
    return at >= 0 ? Deno.args[at + 1] : fallback;
  };
  const url = arg("url", "http://127.0.0.1:7788")!;
  // `{{token}}` survives for a SERVICE, whose command line is not a harness's (teamfile.ts), and
  // what it hands over is the DURABLE half: a definition token, which cannot coordinate and is
  // refused for every verb but minting. Handing it to `definitionToken` is what makes this process
  // outlive the 15-minute run token and the 12-hour ceiling without re-authenticating by hand.
  // Passing it as `token` instead is an immediate `invalid_token: a definition token does not
  // authorize coordination; mint a run first`.
  const token = arg("token") ?? Deno.env.get("RADIA_DEFINITION_TOKEN") ?? Deno.env.get("RADIA_TOKEN");
  if (!token) throw new Error("the dealer needs --token, RADIA_DEFINITION_TOKEN or RADIA_TOKEN");
  const client = new RadiaClient(url, { definitionToken: token });
  const out = await runDealer(client, {
    team: arg("team", "poker")!,
    players: (arg("players", "ada,ben,cy,dee")!).split(","),
    hands: Number(arg("hands", "3")),
    seed: arg("seed") ? Number(arg("seed")) : undefined,
  });
  console.error(`poker: ${out.hands} hands dealt; ${out.seats.map((s) => `${s.name} ${s.stack}`).join(", ")}`);
}
