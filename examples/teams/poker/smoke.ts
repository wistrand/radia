// The team wiring without models: the dealer service, the grants `team.json` assigns, and scripted
// stand-ins for the four harness players.
//
//   deno task test:poker-team
//
// What it checks that examples/poker/smoke.ts cannot: the grants here carry BOTH a team label and
// a per-player field, and a member of the team is still refused another member's hand. A team
// compartment separates one table from another; it does nothing about the player in the next seat,
// and that is the thing this example exists to show.

import { RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { resolveToken } from "../../../src/credentials.ts";
import { ACTION, ACTION_REQUEST, HOLE, RESULT, runPlayer, STRATEGIES } from "../../poker/poker.ts";
import { runDealer } from "./dealer.ts";
import { PLAYERS, provisionTeam } from "./provision.ts";

const TEAM = "poker";
const OTHER = "poker-b";
const PORT = 7893;
const url = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const dir = await Deno.makeTempDir({ prefix: "radia-poker-team-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();

const stop = { done: false };
const loops: Promise<void>[] = [];

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
  Deno.env.set("RADIA_CREDENTIALS", env.RADIA_CREDENTIALS);
  const operator = new RadiaClient(url, { token: resolveToken(url)! });

  // Exactly what `radia team up --init` does to this team, through the same two functions the
  // verb calls, so the grants under test are the ones a real run gets.
  const dir = new URL(".", import.meta.url).pathname;

  const provisioned = await provisionTeam(operator, dir);
  if (provisioned.team !== TEAM) throw new Error(`team.json names team '${provisioned.team}', not '${TEAM}'`);
  const runFor = async (agent: string) =>
    new RadiaClient(url, { token: (await operator.createRun(provisioned.tokens.get(agent)!)).runToken });
  const dealer = await runFor("agent:dealer");
  const clients = new Map<string, RadiaClient>();
  for (const name of PLAYERS) clients.set(`agent:${name}`, await runFor(`agent:${name}`));
  console.log(`poker team: ${provisioned.declared} kinds, ${provisioned.tokens.size} members minted from team.json\n`);

  // ---------------------------------------------------------------------
  // The seat beside you, and the table next door
  // ---------------------------------------------------------------------
  console.log("poker team: what a teammate can reach");
  const ada = clients.get("agent:ada")!;
  await dealer.put({ kind: HOLE, body: { team: TEAM, session: "probe", handId: "probe", owner: "agent:ben", cards: ["As", "Ks"] } });
  await dealer.put({ kind: HOLE, body: { team: TEAM, session: "probe", handId: "probe", owner: "agent:ada", cards: ["2c", "7d"] } });

  const ofBen = await ada.queryNewest<{ owner: string }>({ kind: HOLE, match: { owner: "agent:ben" } });
  check("a member of the SAME team still cannot read a teammate's hand", ofBen.length === 0, ofBen.length);

  const ownTeam = await ada.queryNewest<{ owner: string }>({ kind: HOLE });
  check("and sees only its own inside the team", ownTeam.every((r) => r.body.owner === "agent:ada"), ownTeam.map((r) => r.body.owner));

  // The team half of the pattern is load-bearing too: ada's grant names `{team: "poker"}`, so a
  // hand dealt to ada at another table is not hers to read.
  await operator.put({ kind: HOLE, body: { team: OTHER, session: "probe", handId: "probe", owner: "agent:ada", cards: ["Ah", "Ad"] } });
  const elsewhere = await ada.queryNewest<{ owner: string; team: string }>({ kind: HOLE, match: { team: OTHER } });
  check("nor its own cards at a table it is not seated at", elsewhere.length === 0, elsewhere.length);

  let forged: string;
  try {
    await ada.put({ kind: ACTION, body: { team: TEAM, session: "probe", handId: "probe", street: "preflop", player: "agent:ben", type: "fold", amount: 0 } });
    forged = "accepted";
  } catch (e) {
    forged = e instanceof RadiaClientError ? `${e.status} ${e.code}` : String(e);
  }
  check("a member cannot fold a teammate", forged.startsWith("403"), forged);

  let unlabelled: string;
  try {
    await ada.put({ kind: ACTION, body: { session: "probe", handId: "probe", street: "preflop", player: "agent:ada", type: "check", amount: 0 } });
    unlabelled = "accepted";
  } catch (e) {
    unlabelled = e instanceof RadiaClientError ? `${e.status} ${e.code}` : String(e);
  }
  check("and cannot write a record with no team label at all", unlabelled.startsWith("403"), unlabelled);

  // ---------------------------------------------------------------------
  // A session, dealt by the service
  // ---------------------------------------------------------------------
  console.log("\npoker team: three hands, dealer service, scripted seats");
  const strategies = ["solid", "calling", "aggressive", "timid"];
  for (const [i, name] of PLAYERS.entries()) {
    const principal = `agent:${name}`;
    loops.push(runPlayer(clients.get(principal)!, principal, STRATEGIES[strategies[i]], stop));
  }
  const out = await runDealer(dealer, {
    team: TEAM,
    players: [...PLAYERS],
    hands: 3,
    seed: 4242,
    actionTimeoutMs: 4000,
    log: (l) => console.log(`  ${l}`),
  });
  stop.done = true;
  await Promise.all(loops);
  loops.length = 0;

  check("every seat still has a stack", out.seats.every((s) => s.stack >= 0), out.seats.map((s) => `${s.name}:${s.stack}`));
  check("chips are conserved", out.seats.reduce((n, s) => n + s.stack, 0) === 500 * PLAYERS.length, out.seats.reduce((n, s) => n + s.stack, 0));

  const actions = await operator.queryAll<{ player: string; team: string }>({ kind: ACTION, match: { team: TEAM } });
  check("every action carries the team label", actions.length > 0 && actions.every((a) => a.body.team === TEAM), actions.length);

  // The dealer ends the run with the team's `done` record, so `radia team up` exits by itself.
  const final = await operator.readNewest<{ standings: unknown[] }>({ kind: RESULT, match: { handId: "final" } });
  check("the dealer writes the team's `done` record", final !== null && Array.isArray(final.body.standings), final?.body.standings);

  console.log(failures === 0 ? "\npoker team: ok" : `\npoker team: ${failures} FAILED`);
} finally {
  stop.done = true;
  await Promise.all(loops).catch(() => {});
  space.kill();
  await space.status;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

Deno.exit(failures === 0 ? 0 : 1);
