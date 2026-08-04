// Flow mining: does the space recover its own workflow diagram?
//
// The acceptance test was specified before the feature (research-self-modeling.md): the miner must
// independently recover the pipeline example's shape, `job → task×N → result×N → summary`, WITHOUT
// being told to look for it. That is the bar here, and it is why this file builds the pipeline's
// causal structure rather than a convenient one.
//
// Not adapter-parameterized: mining is storage-agnostic logic over records, and the ports it uses
// (`query` with a keyset page, `envelopesInState`) are already under contract in `suites/`.

import { assert, assertEquals } from "@std/assert";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { Space } from "../src/core/space.ts";

/** The pipeline example, in-process: a job fans out into per-word tasks, workers ack results, an
 *  aggregator emits one summary. `words.length` is the fan-out, so it is also N. */
async function runJob(space: Space, words: string[]): Promise<void> {
  const job = await space.put({ kind: "job", body: { text: words.join(" ") } });
  const claimed = await space.take({ pattern: { kind: "job" } });
  for (const w of words) {
    await space.put({ kind: "task", body: { op: "upper", input: w }, parentIds: [job.id] });
  }
  await space.ack(claimed!.lease);
  const resultIds: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const c = await space.take({ pattern: { kind: "task" } });
    const r = await space.ack(c!.lease, { kind: "result", body: { out: w(c!.record) }, parentIds: [c!.record.id] });
    assertEquals(r.status, "ok");
    resultIds.push((r as { resultId: string }).resultId);
  }
  await space.put({ kind: "summary", body: { text: "done" }, parentIds: resultIds });
}

function w(rec: { body: unknown }): string {
  return String((rec.body as { input: string }).input).toUpperCase();
}

async function pipelineSpace(): Promise<{ space: Space; close: () => Promise<void> }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "job", indexedPaths: [] });
  space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
  // result/summary are facts, read but never taken, so they sit `available` forever BY DESIGN.
  space.registerKind({ kind: "result", indexedPaths: [], claimable: false });
  space.registerKind({ kind: "summary", indexedPaths: [], claimable: false });
  return { space, close: () => adapter.close() };
}

Deno.test("flows: the pipeline's shape is recovered without being told to look for it", async () => {
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["the", "quick", "brown", "fox"]);
    await runJob(space, ["hello", "there", "world", "again", "more"]);

    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.complete, true, "a mined shape from a truncated scan is a different claim");
    const top = r.flows[0];
    assertEquals(top.signature, "job → task×4-7 → result×4-7 → summary");
    // BOTH jobs, under one signature. Four words and five words are the same flow, which is the
    // entire job of bucketing: exact counts would file these apart and report every run as unique.
    assertEquals(top.occurrences, 2);
    assertEquals(top.outcomes, { complete: 2, open: 0, failed: 0 });
    assertEquals(top.successRate, 1);
    assertEquals(top.exemplars.length, 2, "the shape is a claim; the exemplars are the evidence");
  } finally {
    await close();
  }
});

Deno.test("flows: granularity is a parameter because neither setting is knowable in advance", async () => {
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["the", "quick", "brown", "fox"]);
    await runJob(space, ["hello", "there", "world", "again", "more"]);

    // Too specific and every flow is unique. Exact counts split the two runs, which is the failure
    // mode the default avoids and the reason it stays reachable: the bucket is a guess about which
    // differences matter, and this is how a reader checks it.
    const exact = await space.flows({ granularity: "kind", counts: "exact" });
    assertEquals(exact.flows.length, 2);
    assertEquals(exact.flows.map((f) => f.occurrences), [1, 1]);
    assert(exact.flows.some((f) => f.signature === "job → task×4 → result×4 → summary"));
    assert(exact.flows.some((f) => f.signature === "job → task×5 → result×5 → summary"));

    // The agent is part of a token by default. Everything here is written by one principal, so the
    // shape is unchanged and only the tokens grow: agent granularity costs nothing until there IS
    // more than one agent, which is why it can be the default.
    const withAgent = await space.flows({ granularity: "kind+agent" });
    assertEquals(withAgent.flows.length, 1);
    assertEquals(withAgent.flows[0].occurrences, 2);
    assert(
      withAgent.flows[0].signature.includes("@"),
      `expected agent-qualified tokens, got ${withAgent.flows[0].signature}`,
    );
  } finally {
    await close();
  }
});

Deno.test("flows: a shape that starts and never finishes is mined beside the one that completes", async () => {
  // Survivorship is the hazard the design names: only completed DAGs have shapes, so much of the
  // signal is in the comparison with the partial ones. A miner that filtered them would report this
  // space as 100% healthy.
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["the", "quick", "brown", "fox"]);
    // Fanned out, then abandoned: the tasks sit available, nobody works them, no summary.
    const stalled = await space.put({ kind: "job", body: { text: "a b" } });
    const claimed = await space.take({ pattern: { kind: "job" } });
    for (const word of ["a", "b"]) {
      await space.put({ kind: "task", body: { op: "upper", input: word }, parentIds: [stalled.id] });
    }
    await space.ack(claimed!.lease);

    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.flows.length, 2);
    const partial = r.flows.find((f) => f.signature === "job → task×2-3");
    assert(partial, `expected the stalled shape, got ${r.flows.map((f) => f.signature).join(" | ")}`);
    assertEquals(partial.outcomes, { complete: 0, open: 1, failed: 0 });
    assertEquals(partial.successRate, 0);

    // The completed one is NOT reported as open, and that distinction is the whole outcome rule: a
    // `claimable:false` kind sits `available` forever by design, so reading "available" as
    // unfinished would mark every terminated pipeline in the space as still running.
    const done = r.flows.find((f) => f.signature.endsWith("summary"));
    assertEquals(done?.outcomes, { complete: 1, open: 0, failed: 0 });
  } finally {
    await close();
  }
});

Deno.test("flows: a dead-lettered record makes its whole subgraph a failure, mechanically", async () => {
  // Success is never a model's verdict: it is a `dead_letter` in the subgraph, work still
  // claimable, or everything settled. Nothing else.
  const { space, close } = await pipelineSpace();
  try {
    const job = await space.put({ kind: "job", body: { text: "one" } });
    const claimed = await space.take({ pattern: { kind: "job" } });
    const task = await space.put({ kind: "task", body: { op: "upper", input: "one" }, parentIds: [job.id] });
    await space.ack(claimed!.lease);
    assert(await space.forceDeadLetter(task.id));

    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.flows.length, 1);
    assertEquals(r.flows[0].outcomes, { complete: 0, open: 0, failed: 1 });
  } finally {
    await close();
  }
});

Deno.test("flows: work with no lineage has no shape, and says so instead of inventing one", async () => {
  const { space, close } = await pipelineSpace();
  try {
    for (let i = 0; i < 5; i++) await space.put({ kind: "task", body: { op: "upper", input: "x" } });
    const r = await space.flows({ granularity: "kind" });
    // Five unrelated records are five subgraphs of one node, not one flow of five.
    assertEquals(r.scanned.subgraphs, 5);
    assertEquals(r.flows.length, 1);
    assertEquals(r.flows[0].signature, "task");
    assertEquals(r.flows[0].occurrences, 5);
  } finally {
    await close();
  }
});

Deno.test("flows: the substrate's own kinds stay out of the mining unless asked for", async () => {
  // A quiet space's highest-volume kinds are its declarations and grants. Including them by default
  // would make every space's top flow a registry write and bury the work under bookkeeping.
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["a", "b"]);
    await space.persistKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
    const plain = await space.flows({ granularity: "kind" });
    assert(!plain.scanned.kinds.includes("kind_def"), `reserved kinds leaked: ${plain.scanned.kinds.join(",")}`);

    const withReserved = await space.flows({ granularity: "kind", includeReserved: true });
    assert(withReserved.scanned.kinds.includes("kind_def"));
    assert(
      withReserved.scanned.records > plain.scanned.records,
      "asking for reserved kinds must actually scan more",
    );
  } finally {
    await close();
  }
});

Deno.test("flows: a scan that hits its cap reports a prefix rather than a plausible diagram", async () => {
  // The bounded-read-as-population bug, in the place it is hardest to notice: a mined diagram looks
  // exactly as complete whether or not the scan finished.
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["the", "quick", "brown", "fox"]);
    const r = await space.flows({ granularity: "kind", maxRecords: 3 });
    assertEquals(r.complete, false);
    assert(r.notes?.some((n) => n.includes("PREFIX")), `expected a prefix note, got ${JSON.stringify(r.notes)}`);
  } finally {
    await close();
  }
});
