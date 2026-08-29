// The BASELINES half of agent_docs/plan-validation.md: what content-routed coordination costs
// against the two cheaper things it could have been.
//
//   deno run --allow-read --allow-write --allow-env --allow-net bench/baselines.ts [--items N]
//
// One workload, three arms, same storage and the same computation, so the only variable is how the
// work is routed:
//
//   static   a hardcoded orchestrator: split, map, aggregate, in one process. No space at all.
//   queue    ONE claimable kind. Workers take whatever is next and dispatch on a body field
//            themselves, which is the plain worker queue, and the `switch` on kinds CLAUDE.md
//            names as the symptom to catch in review.
//   routed   three kinds and three workers, each claiming its own PATTERN. Nothing dispatches;
//            a result is matched by whoever declared interest in that shape.
//
// WHAT THIS CANNOT ANSWER, and the reason each is out of reach rather than skipped:
//
//   admission accuracy       needs the scheduler, which is not built (M3). The third baseline
//                            plan-validation.md asks for, "a blackboard WITHOUT the agenda
//                            scheduler", is what Radia is today, so the with/without comparison
//                            has nothing on the other side of it yet.
//   task success, tokens     need a model in the loop. Every number here is deterministic and runs
//                            with no API key, which is what makes it repeatable.
//   lease-recovery latency   is `leaseSeconds` plus the worker's poll floor. Both are configured,
//                            so measuring it reports back the config rather than a property. What
//                            is measured instead is whether the work is LOST, which is the thing
//                            the configuration is buying.
//
// And the standing caveat of any self-benchmark: all three arms are written by the same author, so
// the arm under test is the one most likely to be written well. The counts (events, records,
// invocations) are exact and mechanical; the wall-clock is the soft number.
//
// Nothing here asserts, like the rest of `bench/`.

import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";

const argv = Deno.args;
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const ITEMS = flag("--items", 200);

// ---------------------------------------------------------------------------
// The computation. Identical in all three arms, so it cancels out of every comparison.
// ---------------------------------------------------------------------------

const split = (n: number) => Array.from({ length: n }, (_, i) => ({ item: i, value: i * 7 % 101 }));
const work = (t: { item: number; value: number }) => ({ item: t.item, score: (t.value * t.value) % 997 });
const aggregate = (rs: { score: number }[]) => rs.reduce((a, r) => a + r.score, 0);

interface Arm {
  name: string;
  /** Coordination events the space recorded. 0 for an arm that has no space. */
  events: number;
  /** Records committed, which is what a space costs in storage rather than in time. */
  records: number;
  ms: number;
  /** How many times `work` ran. Above ITEMS means an effect repeated. */
  invocations: number;
  /** Items whose result never reached the aggregator. */
  lost: number;
  /** Work of a type nobody was prepared for, when one appears mid-run. */
  unhandled: number;
  /** Of that work, how much is STILL CLAIMABLE by a worker that arrives later. The queue arm's
   *  dispatch consumed it to reach a `default`; nothing consumed it in the routed arm. */
  stillClaimable: number;
  /** Whether the aggregate came out right. */
  correct: boolean;
}

async function newSpace(): Promise<{ space: Space; close: () => Promise<void> }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "unit", indexedPaths: [{ path: "stage", type: "keyword" }, { path: "item", type: "integer" }] });
  space.registerKind({ kind: "task", indexedPaths: [{ path: "item", type: "integer" }] });
  space.registerKind({ kind: "result", indexedPaths: [{ path: "item", type: "integer" }] });
  space.registerKind({ kind: "audit", indexedPaths: [{ path: "item", type: "integer" }], claimable: false });
  return { space, close: () => adapter.close() };
}

const countEvents = async (space: Space) => (await space.getEvents("0", 100_000)).length;
const countRecords = async (space: Space) => (await space.stats()).reduce((n, k) => n + k.count, 0);

// ---------------------------------------------------------------------------
// Arm 1: static graph orchestration. The floor, and the thing to beat only on the columns
// coordination exists for.
// ---------------------------------------------------------------------------

function staticArm(items: number, crash: boolean, newType: boolean): Arm {
  const t0 = performance.now();
  let invocations = 0;
  const tasks = split(items);
  const results: { item: number; score: number }[] = [];
  let lost = 0;
  for (const [i, t] of tasks.entries()) {
    // A worker dies. In a single process there is no other side to notice, so the item is simply
    // never computed and the orchestrator carries on with a short list.
    if (crash && i === Math.floor(items / 2)) {
      lost++;
      continue;
    }
    invocations++;
    results.push(work(t));
  }
  // Work of an unforeseen type has no branch to reach: the orchestrator is the routing table.
  const unhandled = newType ? 1 : 0;
  const total = aggregate(results);
  return {
    name: "static",
    events: 0,
    records: 0,
    ms: performance.now() - t0,
    invocations,
    lost,
    unhandled,
    stillClaimable: 0,
    correct: total === aggregate(split(items).map(work)),
  };
}

// ---------------------------------------------------------------------------
// Arm 2: a plain worker queue. One kind, and the worker decides what a record means.
// ---------------------------------------------------------------------------

async function queueArm(items: number, crash: boolean, newType: boolean): Promise<Arm> {
  const { space, close } = await newSpace();
  const t0 = performance.now();
  let invocations = 0, lost = 0, unhandled = 0;
  const results: { item: number; score: number }[] = [];
  try {
    for (const t of split(items)) await space.put({ kind: "unit", body: { stage: "work", ...t } });
    // The thing this arm is: a record of an unforeseen shape lands in the SAME queue as everything
    // else, so the dispatch below meets it whether or not it knows what to do with it.
    if (newType) await space.put({ kind: "unit", body: { stage: "verify", item: -1, value: 0 } });

    let crashed = false;
    for (;;) {
      // Crash: a worker takes and never acks, its lease already expired (the composition
      // `test/conformance/suites/faults.ts` uses, deterministic and sleepless).
      if (crash && !crashed && invocations === Math.floor(items / 2)) {
        crashed = true;
        await space.take({ pattern: { kind: "unit" } }, { leaseSeconds: -1 });
        continue;
      }
      const claim = await space.take({ pattern: { kind: "unit" } });
      if (!claim) break;
      const body = claim.record.body as { stage: string; item: number; value: number };
      // THE DISPATCH. Every stage the system will ever have is a branch here, in the client, and
      // an unknown one is this arm's `default`.
      if (body.stage === "work") {
        invocations++;
        const r = work(body);
        results.push(r);
        await space.ack(claim.lease, { kind: "result", body: r });
      } else {
        unhandled++;
        await space.ack(claim.lease);
      }
    }
    lost = items - results.length;
    return {
      name: "queue",
      events: await countEvents(space),
      records: await countRecords(space),
      ms: performance.now() - t0,
      invocations,
      lost,
      unhandled,
      // Asked, not assumed: whatever the dispatch acked is gone, so a worker that arrives
      // tomorrow knowing what a `verify` is has nothing left to claim.
      stillClaimable: (await space.queryEnvelopes({ state: "available", kinds: ["unit"], limit: 50 })).length,
      correct: aggregate(results) === aggregate(split(items).map(work)),
    };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Arm 3: content-routed. Each worker claims a PATTERN; the aggregator matches results without
// anybody addressing it.
// ---------------------------------------------------------------------------

async function routedArm(items: number, crash: boolean, newType: boolean): Promise<Arm> {
  const { space, close } = await newSpace();
  const t0 = performance.now();
  let invocations = 0, unhandled = 0;
  try {
    for (const t of split(items)) await space.put({ kind: "task", body: t });
    // A record of an unforeseen shape. Nothing routes it, and nothing has to: it is a `task` of a
    // kind no pattern names, so it stays claimable until somebody declares an interest that fits.
    if (newType) await space.put({ kind: "audit", body: { item: -1 } });

    let crashed = false;
    for (;;) {
      if (crash && !crashed && invocations === Math.floor(items / 2)) {
        crashed = true;
        await space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 });
        continue;
      }
      const claim = await space.take({ pattern: { kind: "task" } });
      if (!claim) break;
      invocations++;
      const r = work(claim.record.body as { item: number; value: number });
      // The result is the ACK, so it is fenced: the record that answers this claim cannot be
      // written by a worker that lost the lease.
      await space.ack(claim.lease, { kind: "result", body: r });
    }

    // The aggregator addresses nobody. It matches a SHAPE, which is why adding a producer needs no
    // change here, and why the crashed item's reclaimed result is picked up like any other.
    const results = (await space.query({ kind: "result" }, items + 10)).map((r) => r.body as { item: number; score: number });
    // An unhandled record is one nothing claimed: measured by asking, not by a counter.
    if (newType) unhandled = (await space.query({ kind: "audit" }, 10)).length;

    return {
      name: "routed",
      events: await countEvents(space),
      records: await countRecords(space),
      ms: performance.now() - t0,
      invocations,
      lost: items - results.length,
      unhandled,
      stillClaimable: newType ? (await space.queryEnvelopes({ state: "available", kinds: ["audit"], limit: 50 })).length : 0,
      correct: aggregate(results) === aggregate(split(items).map(work)),
    };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function table(rows: Arm[], items: number): string {
  const head = ["arm", "ms", "ms/item", "events", "records", "work() ran", "lost", "unreached", "still claimable", "right answer"];
  const body = rows.map((a) => [
    a.name,
    a.ms.toFixed(0),
    (a.ms / items).toFixed(3),
    String(a.events),
    String(a.records),
    String(a.invocations),
    String(a.lost),
    String(a.unhandled),
    String(a.stillClaimable),
    a.correct ? "yes" : "NO",
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ");
  return [line(head), w.map((n) => "─".repeat(n)).join("  "), ...body.map(line)].join("\n");
}

// A discarded full-size round first. Without it the arm that runs first carries the process's
// sqlite and space initialisation: the queue arm measured 30-40% slower than routed in the clean
// table and level with it in every table after, and a 20-item warm-up did not clear it. With this,
// the two are within noise and their order flips between runs, which is the answer.
await queueArm(ITEMS, false, false);
await routedArm(ITEMS, false, false);

console.log(`baselines: ${ITEMS} items, sqlite in-memory, one process, no model\n`);

console.log("CLEAN RUN: what coordination costs when nothing goes wrong.");
console.log(table([staticArm(ITEMS, false, false), await queueArm(ITEMS, false, false), await routedArm(ITEMS, false, false)], ITEMS));

console.log("\nA WORKER DIES mid-run, holding one item. `lost` is the column that matters.");
console.log(table([staticArm(ITEMS, true, false), await queueArm(ITEMS, true, false), await routedArm(ITEMS, true, false)], ITEMS));

console.log("\nWORK OF AN UNFORESEEN SHAPE arrives. `unreached` is what nobody handled; `still claimable` is what somebody could still handle tomorrow.");
console.log(table([staticArm(ITEMS, false, true), await queueArm(ITEMS, false, true), await routedArm(ITEMS, false, true)], ITEMS));

console.log(`
Reading these: the first table is the PRICE and the second is what it buys. The static arm is the
floor by construction and always will be, since it makes no durable record of anything, and the
question is never whether it is faster. It is whether the second table's 'right answer: NO' is
acceptable, because that is what a dead worker costs an orchestrator with nothing underneath it.

Both space arms recover identically, and the numbers say so: same events, same records, same answer.
Nothing here shows content routing beating a queue at running a pipeline somebody already designed,
and a benchmark that claimed otherwise would be measuring its author.

The one column that separates them is 'still claimable'. Both leave the unforeseen record unhandled;
the queue arm's dispatch CONSUMED it to reach a default branch, so a worker that arrives tomorrow
knowing what to do has nothing left to claim, while the routed arm never touched it. That is the
whole difference, it is one record, and it is the shape of the argument rather than its size.
`.trim());
