// The MCP adapter's `--trace`, which is the only place an agent's ATTEMPTS are recorded.
//
// The space cannot help here: a `take` appends its event only after it wins a record, so a claim
// that matched nothing leaves no trace anywhere (agent_docs/plan-agent-lab.md). Every assertion the
// agent lab makes about a fruitless call rests on this file's classification being right, so the
// two directions are both planted: `empty` must be reported when the answer was empty, and must NOT
// be reported for an answer this cannot classify.

import { assert, assertEquals } from "@std/assert";
import { classify, fileTracer } from "../src/surfaces/mcp/trace.ts";
import { answer } from "../src/surfaces/mcp/render.ts";
import { PROBE_NOTE } from "../src/surfaces/mcp/server.ts";

Deno.test("[trace] an answer that found nothing is classified as empty, not as success", () => {
  // The exact sentence the adapter writes, and the exact shape a real session produced: this is
  // what a pattern bug looks like from outside, and it reads as "no work" to everyone.
  assertEquals(classify("nothing available for that pattern").outcome, "empty");
  assertEquals(classify("[]").outcome, "empty");
  assertEquals(classify("[]").records, 0);
  assertEquals(classify('{"found":false}').outcome, "empty");
  assertEquals(classify("null").outcome, "empty");
});

Deno.test("[trace] anything it cannot classify counts as ok, never as a finding", () => {
  // Over-reporting `empty` would put false findings in front of a reader, which is the one failure
  // that makes a lab worse than no lab. A rendered table, a sentence, a single object: all ok.
  assertEquals(classify("kind    records\ntask    3").outcome, "ok");
  assertEquals(classify('{"id":"01J","kind":"task"}').outcome, "ok");
  assertEquals(classify("claimed 01J0000").outcome, "ok");

  const list = classify('[{"id":"a"},{"id":"b"}]');
  assertEquals(list.outcome, "ok");
  assertEquals(list.records, 2, "a countable answer must carry its count, or rates cannot be computed");
});

Deno.test("[trace] a call is one JSON line, and a megabyte argument does not become the log", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-trace-" });
  const path = `${dir}/trace.jsonl`;
  try {
    const t = fileTracer(path, () => {});
    t.call({ tool: "space_take", args: { kind: "task", match: { tags: { $in: ["image"] } } }, outcome: "empty", ms: 4 });
    // What `space_put_artifact` actually carries. A trace nobody can open is a trace nobody reads.
    t.call({ tool: "space_put_artifact", args: { base64: "A".repeat(2_000_000) }, outcome: "ok", ms: 900 });

    const lines = (await Deno.readTextFile(path)).trim().split("\n");
    assertEquals(lines.length, 2, "each call must be exactly one line, or the file is not JSONL");
    const first = JSON.parse(lines[0]);
    assertEquals(first.tool, "space_take");
    assertEquals(first.outcome, "empty");
    assertEquals(first.args.match.tags.$in, ["image"], "the PATTERN is the evidence; it must survive verbatim");
    assert(typeof first.ts === "string" && first.ts.endsWith("Z"));

    const second = JSON.parse(lines[1]);
    assert(second.args.base64.length < 1000, "a long argument must be truncated");
    assert(/2000000 chars/.test(second.args.base64), "…and must say what was cut, or a reader guesses");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[trace] a failing trace disables itself and never breaks the call it observes", () => {
  // An observation that can fail the thing it observes is worse than none: this adapter is a
  // model's only way into the space, and a full disk must not end its session.
  const said: string[] = [];
  const t = fileTracer("/nonexistent-directory-for-radia/trace.jsonl", (s) => said.push(s));
  t.call({ tool: "space_health", args: {}, outcome: "ok", ms: 1 });
  t.call({ tool: "space_health", args: {}, outcome: "ok", ms: 1 });

  assertEquals(said.length, 1, "it must say so ONCE, not once per call");
  assert(said[0].includes("continuing untraced"), said[0]);
});

Deno.test("[trace] a NARROWED answer is still counted, wrapper and all", () => {
  // `render.ts` wraps a list beside its scope when a grant narrowed the read, so the count moved
  // one level in. Reading only the bare array would call every scoped read `ok`, including the
  // empty ones, and the empty ones are the measurement.
  const narrowed = answer("records", [], { scope: { self: true, kinds: ["task"], note: "…" } });
  assertEquals(classify(narrowed).outcome, "empty");
  assertEquals(classify(narrowed).records, 0);

  const some = answer("stats", [{ id: "a" }, { id: "b" }]);
  assertEquals(classify(some).outcome, "ok");
  assertEquals(classify(some).records, 2);

  // EVERY read answers with an object now, scoped or not, so there is one shape to read.
  assertEquals(classify(answer("kinds", [])).outcome, "empty");
});

Deno.test("[render] a bounded answer says it is bounded, and an exact one does not", () => {
  // "A page that reports only its own size reads as a population: the model counts 10 records and
  // states a total" (extensions/ts/agent-tools.ts, where this was already solved). The MCP surface
  // lacked it, and "3 available tasks" was reported off `space_query` on a space where two of the
  // three were settled.
  const page = JSON.parse(answer("records", [1, 2], { more: true, limit: 2 }));
  assertEquals(page.count, 2);
  assertEquals(page.more, true);
  assert(/PAGE, not the total/.test(page.warning), page.warning);
  assert(/Do not count or aggregate/.test(page.warning));

  // An answer that fit says nothing about pages: a warning on every read is a warning nobody reads.
  const whole = JSON.parse(answer("records", [1, 2], { limit: 50 }));
  assertEquals(whole.count, 2);
  assertEquals(whole.more, undefined);
  assertEquals(whole.warning, undefined);

  // The rows come LAST, after what qualifies them.
  assertEquals(Object.keys(JSON.parse(answer("records", [1], { more: true, limit: 1, scope: { self: true }, notes: ["x"] }))), [
    "count",
    "more",
    "warning",
    "scope",
    "notes",
    "records",
  ]);
});

Deno.test("[render] the page note the adapter filters is still the note the runtime writes", async () => {
  // `space_query` probes one past the limit, so `explainQuery`'s page note reports the PROBE's
  // limit: a caller asking for 2 was told "results filled the limit (3)" beside a correct "more
  // than 2 records match". The adapter drops that one note and states the fact itself. Matched on
  // the runtime's wording, so this holds the string: a rename in `inspection.ts` must fail HERE,
  // where the filter stops matching, rather than silently letting the wrong number back through.
  const inspection = await Deno.readTextFile(new URL("../src/core/inspection.ts", import.meta.url));
  assert(PROBE_NOTE.test(inspection), "explainQuery's page note was reworded; update the filter in server.ts");
});
