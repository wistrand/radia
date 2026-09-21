// The dealer, as a `service: true` member of the team.
//
// `radia team up` spawns this once and supervises it until the run ends, rather than looping it
// over claims: it is the one participant that is not answering a turn. It deals, writes the board,
// asks each player in turn, and settles the pot, all through the same public API a player uses.
//
// It holds every poker kind team-scoped, because it deals the cards and narrowing its reads would
// buy nothing. What the example constrains is the PLAYERS, in `team.json`'s per-member grants.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { PENALTY, playHand, rng, rotateButton, type Seat, shuffled } from "../../poker/poker.ts";

export interface DealerRunOptions {
  team: string;
  players: string[];
  hands: number;
  startingStack?: number;
  /** Per seat, by name, overriding `startingStack`. A DEFICIT IS AN EXPERIMENTAL CONTROL: a
   *  prompt telling a partnership that finishing behind is total failure only tests anything
   *  while it IS behind, and leaving that to the deal made half the deterrence runs uninformative
   *  (README, "A weaker stated penalty"). Dealing the premise in makes it true from hand 1. */
  stacks?: Record<string, number>;
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
    stack: opts.stacks?.[name] ?? opts.startingStack ?? 500,
  }));
  const session = `t${Date.now().toString(36)}`;
  const next = rng(opts.seed ?? Date.now() & 0xffff);

  // Fines the floor levied, read from the space rather than handed over: the floor and the
  // dealer share no code and no channel but the records, which is the same arrangement the floor
  // already uses to identify a note's author.
  const applied = new Set<string>();
  for (let h = 1; h <= opts.hands; h++) {
    const fines: { player: string; chips: number; why: string }[] = [];
    for (
      const f of await dealer.queryAll<{ player: string; chips: number; why: string; session?: string }>({
        kind: PENALTY,
        match: { team: opts.team },
      }).catch(() => [])
    ) {
      if (f.body.session !== session || applied.has(f.id)) continue;
      applied.add(f.id);
      fines.push({ player: f.body.player, chips: f.body.chips, why: f.body.why });
    }
    await playHand(dealer, seats, `${session}-h${h}`, shuffled(next), {
      session,
      team: opts.team,
      actionTimeoutMs: opts.actionTimeoutMs ?? 120_000,
      fines,
      log,
    });
    log(`  stacks: ${seats.map((s) => `${s.name} ${s.stack}`).join(", ")}`);
    rotateButton(seats);
    // Two seats left able to act is the least a hand can be played with.
    if (seats.filter((s) => !s.sittingOut).length < 2) {
      log(`  stopping after ${h} hand(s): fewer than two seats are still playing`);
      break;
    }
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
    // `--stacks ada=400,ben=400,cy=600,dee=600`; any seat left out takes the default.
    ...(arg("stacks")
      ? {
        stacks: Object.fromEntries(
          arg("stacks")!.split(",").map((p) => {
            const [n, v] = p.split("=");
            return [n, Number(v)];
          }),
        ),
      }
      : {}),
    hands: Number(arg("hands", "3")),
    // Two minutes suits a harness launch, whose seat spends a whole agent session per decision.
    // An LLM seat is far quicker and the dealer's own clock becomes the slowest thing at the
    // table: measured over 46 turns of grok-4.6, the median turn was 13s and the p90 32s, so one
    // stalled seat cost 150s where the table was waiting 13. The LLM team files use 75, which is
    // more than double the p90. Do not cut it to the median: at 45s four concurrent seats were
    // folded by the clock and then acked anyway, which puts two actions on one turn
    // (README, "How long a run takes").
    ...(arg("action-timeout") ? { actionTimeoutMs: Number(arg("action-timeout")) * 1000 } : {}),
    seed: arg("seed") ? Number(arg("seed")) : undefined,
  });
  console.error(`poker: ${out.hands} hands dealt; ${out.seats.map((s) => `${s.name} ${s.stack}`).join(", ")}`);
}
