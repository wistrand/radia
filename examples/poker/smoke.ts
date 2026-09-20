// The poker example end to end: a space, a dealer, four scripted players, and the isolation the
// design claims checked against what the space will actually answer.
//
//   deno run -A examples/poker/smoke.ts
//
// No models and no API key. What it asserts is that hidden information is enforced by the runtime
// rather than by the players' good manners: the negative cases below are the point of the example,
// and each one is a request a misbehaving player can and does make.

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
import { resolveToken } from "../../src/credentials.ts";
import {
  ACTION,
  ACTION_REQUEST,
  BOARD,
  declarePokerKinds,
  HOLE,
  KINDS,
  playerGrants,
  playHand,
  RESULT,
  rng,
  rotateButton,
  runPlayer,
  type Seat,
  shuffled,
  STRATEGIES,
} from "./poker.ts";

// `--url <base>` runs against a space that is already up, instead of spawning a throwaway one.
// Everything this writes is stamped with a fresh `session`, so a rerun neither dedupes against the
// last one (the idempotency window is 7 days) nor counts its records in the assertions.
const given = Deno.args.indexOf("--url");
const external = given >= 0 ? Deno.args[given + 1] : undefined;
if (given >= 0 && !external) throw new Error("--url needs a base URL, e.g. --url http://127.0.0.1:7788");
const PORT = 7894;
const url = external ?? `http://127.0.0.1:${PORT}`;
const session = `s${Date.now().toString(36)}`;
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const dir = external ? "" : await Deno.makeTempDir({ prefix: "radia-poker-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = external ? null : new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();

const stop = { done: false };
const players: Promise<void>[] = [];

try {
  const probe = new RadiaClient(url);
  for (let i = 0; i < 400; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!external) Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
  const token = Deno.env.get("RADIA_TOKEN") || resolveToken(url);
  if (!token) {
    throw new Error(
      `no operator credential for ${url}. Start it with \`radia dev\`, which provisions one, or ` +
        `set RADIA_TOKEN. The credential is keyed by HOST: a space on 127.0.0.1 has none under localhost.`,
    );
  }
  const operator = new RadiaClient(url, { token });
  console.log(`poker: ${external ? `against ${url}` : "on a throwaway space"}, session ${session}\n`);

  await declarePokerKinds(operator);

  // The dealer holds every kind unscoped: it deals the cards, so narrowing its reads would buy
  // nothing. What the example constrains is the PLAYERS.
  const dealerDef = await operator.createAgentDefinition(
    "agent:dealer",
    KINDS.map((k) => ({ principal: "agent:dealer", kind: k.kind, operations: ["put", "query", "read_one"] })),
  );
  const dealer = new RadiaClient(url, { token: (await operator.createRun(dealerDef.definitionToken)).runToken });

  const roster = [
    { name: "ada", strategy: "solid" },
    { name: "ben", strategy: "calling" },
    { name: "cy", strategy: "aggressive" },
    { name: "dee", strategy: "timid" },
  ];
  const seats: Seat[] = [];
  const clients = new Map<string, RadiaClient>();
  for (const r of roster) {
    const principal = `agent:${r.name}`;
    const def = await operator.createAgentDefinition(principal, playerGrants(principal));
    const run = await operator.createRun(def.definitionToken);
    clients.set(principal, new RadiaClient(url, { token: run.runToken }));
    seats.push({ principal, name: r.name, stack: 500 });
  }

  // ---------------------------------------------------------------------
  // The isolation, before a card is dealt
  // ---------------------------------------------------------------------
  console.log("poker: what one player can reach of another");
  const ada = clients.get("agent:ada")!;
  await dealer.put({ kind: HOLE, body: { session, handId: `${session}-probe`, owner: "agent:ben", cards: ["As", "Ks"] } });
  await dealer.put({ kind: HOLE, body: { session, handId: `${session}-probe`, owner: "agent:ada", cards: ["2c", "7d"] } });

  const asked = await ada.queryNewest<{ owner: string }>({ kind: HOLE, match: { owner: "agent:ben" } });
  check("a player asking for another's hole cards BY NAME gets nothing", asked.length === 0, asked.length);

  const unfiltered = await ada.queryNewest<{ owner: string }>({ kind: HOLE, match: { session } });
  check(
    "and an unfiltered query returns only its own",
    unfiltered.length > 0 && unfiltered.every((r) => r.body.owner === "agent:ada"),
    unfiltered.map((r) => r.body.owner),
  );

  let forged: string;
  try {
    await ada.put({ kind: ACTION, body: { session, handId: `${session}-probe`, street: "preflop", player: "agent:ben", type: "fold", amount: 0 } });
    forged = "accepted";
  } catch (e) {
    forged = e instanceof RadiaClientError ? `${e.status} ${e.code}` : String(e);
  }
  check("a player cannot write another player's action", forged.startsWith("403"), forged);

  const mine = await ada.put({ kind: ACTION, body: { session, handId: `${session}-probe`, street: "preflop", player: "agent:ada", type: "check", amount: 0 } });
  check("but can write its own", typeof mine.id === "string");

  const req = await dealer.put({ kind: ACTION_REQUEST, body: { session, handId: `${session}-probe`, street: "preflop", player: "agent:ben", toCall: 0, betSize: 2, canRaise: true, pot: 0, board: [], stack: 500 } });
  const stolen = await ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ben" } } });
  check("a player cannot claim another player's turn", stolen === null);
  const byId = await ada.take({ recordId: req.id }).catch((e) => (e instanceof RadiaClientError ? `${e.status}` : "threw"));
  check("nor reach it by id, which is a selector and not a bypass", byId === null || typeof byId === "string", byId === null ? "null" : byId);

  // ---------------------------------------------------------------------
  // Hands
  // ---------------------------------------------------------------------
  console.log("\npoker: four hands, fixed limit 1/2");
  for (const [principal, client] of clients) {
    players.push(runPlayer(client, principal, STRATEGIES[roster.find((r) => `agent:${r.name}` === principal)!.strategy], stop));
  }

  const next = rng(20260920);
  const chipsBefore = seats.reduce((n, s) => n + s.stack, 0);
  const outcomes = [];
  for (let h = 1; h <= 4; h++) {
    outcomes.push(await playHand(dealer, seats, `${session}-h${h}`, shuffled(next), { session, log: (l) => console.log(`  ${l}`) }));
    rotateButton(seats);
  }
  const chipsAfter = seats.reduce((n, s) => n + s.stack, 0);
  console.log(`  stacks: ${seats.map((s) => `${s.name} ${s.stack}`).join(", ")}\n`);

  check("every hand paid its pot to somebody", outcomes.every((o) => o.winners.length > 0));
  check("chips are conserved across the session", chipsBefore === chipsAfter, `${chipsBefore} -> ${chipsAfter}`);
  check("nobody timed out while the players were running", outcomes.every((o) => o.foldedOnTimeout.length === 0));

  // Turn order is claimability, so there is exactly one action per request and it names its
  // request as a parent. A second action on one request would mean two players acted on one turn.
  const requests = await operator.queryAll<{ player: string }>({ kind: ACTION_REQUEST, match: { session } });
  const actions = await operator.queryAll<{ player: string }>({ kind: ACTION, match: { session } });
  const perRequest = new Map<string, number>();
  for (const a of actions) {
    for (const p of a.runtimeMeta.parentIds) perRequest.set(p, (perRequest.get(p) ?? 0) + 1);
  }
  check("no request drew two actions", [...perRequest.values()].every((n) => n === 1), [...perRequest.values()].filter((n) => n !== 1));
  check(
    "and every action was written by the player it names",
    actions.every((a) => a.runtimeMeta.createdBy.startsWith("run:") && a.body.player !== undefined),
    actions.length,
  );

  // A folded hand is never revealed. This is the property a grant cannot give you, because the
  // dealer holds every hole card: it holds because the dealer does not WRITE what it need not.
  const results = await operator.queryAll<{ shown: { player: string }[]; winners: string[] }>({ kind: RESULT, match: { session } });
  const showdowns = results.filter((r) => r.body.shown.length > 0);
  check(
    "a hand that ended before showdown reveals nobody, and still has one winner",
    results.filter((r) => r.body.shown.length === 0).every((r) => r.body.winners.length === 1),
    `${showdowns.length}/${results.length} went to showdown`,
  );
  check(
    "at a showdown, only players still in the hand are shown",
    showdowns.every((r) => r.body.shown.length >= r.body.winners.length),
  );

  // ---------------------------------------------------------------------
  // The timeout, and the litter it leaves
  // ---------------------------------------------------------------------
  console.log("\npoker: a player that never acts");
  stop.done = true;
  await Promise.all(players);
  players.length = 0;

  const silent = await playHand(dealer, seats, `${session}-silent`, shuffled(next), { session, actionTimeoutMs: 400, log: (l) => console.log(`  ${l}`) });
  check("the dealer folds a seat that never acts", silent.foldedOnTimeout.length > 0, silent.foldedOnTimeout);

  // The fold is a RECORD, so the betting history has no silent gaps: a seat that was asked and
  // never answered reads differently from one that was never asked.
  const timeouts = await operator.queryAll<{ by?: string; type: string; player: string }>({
    kind: ACTION,
    match: { session, handId: `${session}-silent` },
  });
  check(
    "and writes that fold, marked as the clock's rather than the player's",
    timeouts.length === silent.foldedOnTimeout.length && timeouts.every((a) => a.body.by === "timeout" && a.body.type === "fold"),
    timeouts.map((a) => `${a.body.player}:${a.body.by}`),
  );
  check("and the hand still pays out", silent.winners.length > 0, silent.winners);

  // The honest half: nothing in the space expired that request. There is no timer, and the dealer
  // cannot unpublish a record it wrote, so an abandoned turn stays claimable until an operator
  // remediates it. See the README.
  const stranded = await operator.queryEnvelopes({ state: "available", kind: ACTION_REQUEST, limit: 500 });
  const strandedIds = new Set(stranded.map((s) => s.envelope.recordId));
  check(
    "the abandoned request is STILL claimable, which no sweep will fix",
    silent.abandonedRequests.every((id) => strandedIds.has(id)),
    `${silent.abandonedRequests.length} abandoned`,
  );

  console.log(`\n${requests.length} requests, ${actions.length} actions, ${results.length} hands`);
  console.log(failures === 0 ? "\npoker: ok" : `\npoker: ${failures} FAILED`);
} finally {
  stop.done = true;
  await Promise.all(players).catch(() => {});
  if (space) {
    space.kill();
    await space.status;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.exit(failures === 0 ? 0 : 1);
