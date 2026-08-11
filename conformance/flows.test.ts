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

Deno.test("flows: a record linked to nothing is counted, not ranked as a flow", async () => {
  // Found on a real space, not this one: parentless registry writes (`capability`×861, `model`×215)
  // outranked every actual shape, so "what does this space do" was answered with its own
  // bookkeeping. A one-node subgraph has no shape. Counting it keeps that visible, since a large
  // number IS a finding, just not a flow.
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, ["a", "b"]);
    for (let i = 0; i < 5; i++) await space.put({ kind: "task", body: { op: "upper", input: "x" } });

    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.scanned.subgraphs, 6, "five unrelated records are five subgraphs, not one flow of five");
    assertEquals(r.singletons, 5);
    assertEquals(r.flows.map((f) => f.signature), ["job → task×2-3 → result×2-3 → summary"]);

    const withThem = await space.flows({ granularity: "kind", includeSingletons: true });
    const lone = withThem.flows.find((f) => f.signature === "task");
    assertEquals(lone?.occurrences, 5, "they stay reachable; the default is a ranking choice, not a filter");
  } finally {
    await close();
  }
});

Deno.test("flows: a hub record is cut so the work hanging off it can be mined", async () => {
  // Found on a real space: a long-lived `conversation` links every turn to every other, so a whole
  // multi-day chat was ONE component that occurred exactly once and said nothing. Eleven
  // conversation-rooted shapes, eleven occurrences of one each.
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "conversation", indexedPaths: [], claimable: false });
  space.registerKind({ kind: "message", indexedPaths: [], claimable: false });
  space.registerKind({ kind: "reply", indexedPaths: [], claimable: false });
  try {
    const conv = await space.put({ kind: "conversation", body: { title: "t" } });
    for (let i = 0; i < 10; i++) {
      const m = await space.put({ kind: "message", body: { i }, parentIds: [conv.id] });
      await space.put({ kind: "reply", body: { i }, parentIds: [m.id] });
    }

    const cut = await space.flows({ granularity: "kind" });
    assertEquals(cut.hubs, 1);
    assertEquals(cut.flows.length, 1);
    // The turn, ten times over. The hub's kind stays in the signature: without it, the turns of a
    // conversation and the steps of a job would merge on the strength of looking alike.
    assertEquals(cut.flows[0].signature, "conversation ⇒ message → reply");
    assertEquals(cut.flows[0].occurrences, 10);

    // The knob is a knob, and 0 is the pre-fix behaviour: one shape, seen once, saying nothing.
    const whole = await space.flows({ granularity: "kind", hubDegree: 0 });
    assertEquals(whole.hubs, 0);
    assertEquals(whole.flows.length, 1);
    assertEquals(whole.flows[0].occurrences, 1);
    assertEquals(whole.flows[0].signature, "conversation → message×8-15 → reply×8-15");
  } finally {
    await adapter.close();
  }
});

/** A space whose kinds are a long-lived thing (`doc`, versioned by successor) and work on it. */
async function docSpace(): Promise<{ space: Space; close: () => Promise<void> }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  for (const kind of ["conversation", "message", "reply", "doc", "edit", "check", "note"]) {
    space.registerKind({ kind, indexedPaths: [], claimable: false });
  }
  return { space, close: () => adapter.close() };
}

Deno.test("flows: a version SPINE is a hub stretched into a line, and gets the same test", async () => {
  // The second shape found on the real corpus. A workspace writes each version with the previous as
  // its parent, so ten saves are a ten-record spine with each turn's output hanging off its own
  // version; the spine then links every turn to every other exactly as a conversation does.
  const { space, close } = await docSpace();
  try {
    let prev: string | undefined;
    for (let v = 0; v < 5; v++) {
      const doc = await space.put({ kind: "doc", body: { v }, ...(prev ? { parentIds: [prev] } : {}) });
      prev = doc.id;
      const edit = await space.put({ kind: "edit", body: { v }, parentIds: [doc.id] });
      await space.put({ kind: "check", body: { v }, parentIds: [edit.id] });
      await space.put({ kind: "note", body: { v }, parentIds: [doc.id] }); // a sibling, linked to nothing else
    }

    const cut = await space.flows({ granularity: "kind" });
    assertEquals(cut.hubs, 5, "the whole spine is the hub, not its widest record");
    assertEquals(cut.flows.map((f) => f.signature), ["doc ⇒ edit → check"]);
    assertEquals(cut.flows[0].occurrences, 5);
    // Siblings do NOT survive the cut as a group: two records sharing only a parent that is gone
    // have no edge between them, so each is its own piece. That is the same rule as everywhere else
    // here (a record linked to nothing is not a flow), and it is why the work hanging off a version
    // has to be causally chained to read as a unit.
    assertEquals(cut.singletons, 5, "the notes hung off the spine and off nothing else");

    const whole = await space.flows({ granularity: "kind", hubDegree: 0 });
    assertEquals(whole.flows[0].occurrences, 1, "left whole it is one shape seen once, which says nothing");
  } finally {
    await close();
  }
});

Deno.test("flows: ONE same-kind edge is a step, not a version", async () => {
  // What protects real work from the spine rule. A router's `llm_call` producing an inference
  // `llm_call` is same-kind and parent-child and is emphatically a step of work; three of a kind in
  // a line is a thing being saved again. Two must survive, or the chat turn this feature just
  // learned to mine would be shredded by the fix for the next thing.
  const { space, close } = await docSpace();
  try {
    const conv = await space.put({ kind: "conversation", body: {} });
    for (let i = 0; i < 10; i++) {
      const first = await space.put({ kind: "doc", body: { i }, parentIds: [conv.id] });
      await space.put({ kind: "doc", body: { i, second: true }, parentIds: [first.id] });
    }
    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.flows.map((f) => f.signature), ["conversation ⇒ doc → doc"]);
    assertEquals(r.flows[0].occurrences, 10);
  } finally {
    await close();
  }
});

Deno.test("flows: two hubs that each link everything are cut together, or neither ever is", async () => {
  // The case that decided the search direction. A conversation links every turn AND a doc spine
  // links every turn, so removing either one alone splits NOTHING: the other still holds the
  // component together. A forward search that accepts a candidate only when it splits on its own
  // therefore cuts neither and reports one shape seen once. Cutting everything and restoring what
  // is not needed answers the question one candidate at a time and gets both.
  const { space, close } = await docSpace();
  try {
    const conv = await space.put({ kind: "conversation", body: {} });
    let prevDoc: string | undefined;
    for (let i = 0; i < 10; i++) {
      const doc = await space.put({ kind: "doc", body: { i }, ...(prevDoc ? { parentIds: [prevDoc] } : {}) });
      prevDoc = doc.id;
      const m = await space.put({ kind: "message", body: { i }, parentIds: [conv.id] });
      // The turn's reply hangs off BOTH: this is what makes each hub sufficient on its own.
      await space.put({ kind: "reply", body: { i }, parentIds: [m.id, doc.id] });
    }

    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.flows.map((f) => f.signature), ["conversation + doc ⇒ message → reply"]);
    assertEquals(r.flows[0].occurrences, 10);
    assertEquals(r.hubs, 11, "the conversation and all ten doc versions");
  } finally {
    await close();
  }
});

Deno.test("flows: a wide fan-out that RECONVERGES is not a hub, however wide it is", async () => {
  // The discriminating case, and the reason the test is structural rather than a degree threshold:
  // a job with twelve tasks is exactly as high-degree as a hub. What separates them is that the
  // tasks reconverge on a summary, so deleting the job still leaves ONE piece. Cut it and the
  // pipeline's shape — the thing this feature was accepted against — would disintegrate.
  const { space, close } = await pipelineSpace();
  try {
    await runJob(space, "a b c d e f g h i j k l".split(" "));
    const r = await space.flows({ granularity: "kind" });
    assertEquals(r.hubs, 0);
    assertEquals(r.flows.map((f) => f.signature), ["job → task×8-15 → result×8-15 → summary"]);
  } finally {
    await close();
  }
});

Deno.test("flows: the state scan is scoped to the kinds being mined", async () => {
  // A live space had 1135 `agent_run` and 1080 `interest` envelopes ahead of the work, so an
  // unscoped state read spent its budget on kinds this scan excludes and 278 mined records came
  // back with no state at all. An unknown state then reads as "nothing wrong", which is the
  // reassuring direction to be wrong in.
  const { space, close } = await pipelineSpace();
  try {
    for (let i = 0; i < 40; i++) await space.persistKind({ kind: `filler${i}`, indexedPaths: [] });
    await runJob(space, ["a", "b"]);
    // Small enough that an unscoped state read would be consumed by the kind_def records above.
    const r = await space.flows({ granularity: "kind", maxRecords: 12 });
    assertEquals(r.flows[0].outcomes, { complete: 1, open: 0, failed: 0 });
    assert(
      !(r.notes ?? []).some((n) => n.includes("no envelope")),
      `the outcome must be READ, not guessed: ${JSON.stringify(r.notes)}`,
    );
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

Deno.test("[flows] caller-named sums answer 'where does the metric go, by shape'", async () => {
  // The runtime learns no app's vocabulary: `usage.cost` is an address the CALLER names, and the
  // miner adds numbers it finds there while the records are already in hand. The chat is the worked
  // example (provider cost on every reply), but the mechanism is any numeric body path.
  const { space, close } = await pipelineSpace();
  try {
    const conv = await space.put({ kind: "job", body: { text: "conversation-shaped" } });
    let spent = 0, carried = 0;
    for (let turn = 0; turn < 3; turn++) {
      const cost = (turn + 1) / 100; // 0.01 + 0.02 + 0.03
      const call = await space.put({
        kind: "task",
        body: { op: "llm", input: `t${turn}`, usage: { cost, total_tokens: 1000 * (turn + 1) } },
        parentIds: [conv.id],
      });
      spent += cost;
      carried++;
      // A reply with NO usage, so `records` counts what actually carried the field.
      await space.put({ kind: "result", body: { out: "text" }, parentIds: [call.id] });
    }

    const r = await space.flows({ granularity: "kind", counts: "exact", sum: ["usage.cost", "usage.total_tokens", "no.such.path"] });
    const shape = r.flows.find((f) => f.signature.includes("task") && f.signature.includes("result"));
    assert(shape, JSON.stringify(r.flows.map((f) => f.signature)));

    // Exact totals, because cost is ADDITIVE: no concurrency double-count, unlike wall-clock.
    assertEquals(shape!.sums?.["usage.cost"], { total: 0.06, records: 3 });
    assertEquals(shape!.sums?.["usage.total_tokens"], { total: 6000, records: 3 });
    // A path nothing carries is an honest zero, not an absent key: records: 0 is what tells a
    // reader "nothing here has this field" apart from "this shape is free".
    assertEquals(shape!.sums?.["no.such.path"], { total: 0, records: 0 });

    // The total-duration column: for shapes this fast the number is small, but it must be a SUM
    // over occurrences, never count x median.
    assert(shape!.totalDurationMs >= shape!.medianDurationMs, `${shape!.totalDurationMs} >= ${shape!.medianDurationMs}`);

    // Unrequested, the fields stay absent: the response does not grow for callers that did not ask.
    const plain = await space.flows({ granularity: "kind" });
    assert(plain.flows.every((f) => f.sums === undefined));
    assert(carried === 3 && spent === 0.06, "test arithmetic");
  } finally {
    await close();
  }
});
