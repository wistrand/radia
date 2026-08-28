// The MCP adapter's `--trace`, which is the only place an agent's ATTEMPTS are recorded.
//
// The space cannot help here: a `take` appends its event only after it wins a record, so a claim
// that matched nothing leaves no trace anywhere (agent_docs/plan-agent-lab.md). Every assertion the
// agent lab makes about a fruitless call rests on this file's classification being right, so the
// two directions are both planted: `empty` must be reported when the answer was empty, and must NOT
// be reported for an answer this cannot classify.

import { assert, assertEquals } from "@std/assert";
import { classify, fileTracer } from "../src/surfaces/mcp/trace.ts";

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
