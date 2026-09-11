// The market example end to end: a space, five scripted bidders, a run of auctions, and the
// properties the design claims checked against what the space actually holds.
//
//   deno task test:market
//
// No models and no API key. What it asserts is the marketplace convention's contract as an APP
// sees it: every award is one transaction, the winner alone can claim its prize, the bids that
// lost are still there to recover from, and a seeded run repeats exactly.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { resolveToken } from "../../src/credentials.ts";
import { BID, REQUEST, TASK } from "../../extensions/ts/marketplace.ts";
import { runMarket, STRATEGIES } from "./market.ts";

const PORT = 7896;
const url = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const dir = await Deno.makeTempDir({ prefix: "radia-market-" });
const env = { RADIA_CREDENTIALS: `${dir}/credentials.json`, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  env,
  stdout: "null",
  stderr: "null",
}).spawn();

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

  console.log("market: a run of eight auctions");
  const t0 = Date.now();
  const run = await runMarket(operator, { rounds: 8, seed: 1234, log: (l) => console.log(`  ${l}`) });
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, ${run.awarded} awarded, spend ${run.spend}\n`);

  check("every round ended, awarded or reopened", run.awarded + run.reopened === 8, run.wonBy);
  check("the market did not settle on one winner", Object.keys(run.wonBy).length > 1, run.wonBy);
  check(
    "a bidder that declines never wins",
    !Object.keys(run.wonBy).some((n) => !STRATEGIES.some((s) => s.name === n)),
    Object.keys(run.wonBy),
  );

  // Every award is a task whose parents are its request and the bid that won it, so the decision
  // reads back from records with nothing stored twice.
  const tasks = await operator.queryAll<{ assignee: string; request: string }>({ kind: TASK });
  check("one task per award", tasks.length === run.awarded, tasks.length);
  // The award is only half the protocol: `bidderGrants` issues `task: take {assignee: self}` so the
  // winner can collect, and a run where nobody claims ends in the state design-marketplace.md
  // question 2 calls "it never claims at all", indistinguishable from a bidder that was never
  // granted the take.
  const claimed = await operator.queryEnvelopes({ state: "consumed", kind: TASK, limit: 200 });
  check("and the winner claimed it, under its own credential", claimed.length === run.awarded, claimed.length);
  // A prize nobody collects makes every later bid of that strategy wrong, so the run REPORTS it
  // rather than leaving it to be inferred from a market that behaved oddly.
  check("no award went uncollected, and the run says so itself", run.uncollected === 0, run.uncollected);
  let parented = 0, priced = 0;
  for (const t of tasks) {
    const bids = await operator.queryAll<{ bidder: string; price: number }>({ kind: BID, match: { request: t.body.request } });
    const winning = bids.find((b) => b.body.bidder === t.body.assignee);
    if (t.runtimeMeta.parentIds.includes(t.body.request) && winning && t.runtimeMeta.parentIds.includes(winning.id)) parented++;
    // The winning bid was the cheapest of its auction, which is the requester's policy and not the
    // runtime's: nothing in the space ranked anything.
    if (winning && Math.min(...bids.map((b) => Number(b.body.price))) === Number(winning.body.price)) priced++;
  }
  check("each award names its request AND the bid that won it", parented === tasks.length, `${parented}/${tasks.length}`);
  check("and the winner was the cheapest bid in its own auction", priced === tasks.length, `${priced}/${tasks.length}`);

  // The losing bids are untouched, which is what makes a failed winner recoverable without a new
  // auction. Nothing consumed them and nothing rewrote them.
  const allBids = await operator.queryAll({ kind: BID });
  const consumed = await operator.queryEnvelopes({ state: "consumed", kind: BID, limit: 200 });
  check("every bid survives the auction it lost", allBids.length > tasks.length, allBids.length);
  check("and none was consumed: a bid is reference data", consumed.length === 0, consumed.length);

  // Each awarded request was closed by the same transaction that emitted the task.
  const openRequests = await operator.queryEnvelopes({ state: "available", kind: REQUEST, limit: 200 });
  check("an awarded request is consumed, not left open", openRequests.length === run.reopened, openRequests.length);

  // A seeded run is deterministic, which is what makes this example a test as well as a demo.
  const second = await runMarket(operator, { rounds: 8, seed: 1234 });
  check("a seeded run repeats exactly", JSON.stringify(second.wonBy) === JSON.stringify(run.wonBy), second.wonBy);
  const third = await runMarket(operator, { rounds: 8, seed: 99 });
  check("and a different seed is a different market", JSON.stringify(third.wonBy) !== JSON.stringify(run.wonBy), third.wonBy);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
} finally {
  try {
    space.kill();
    await space.status;
  } catch { /* already gone */ }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
if (failures > 0) Deno.exit(1);
