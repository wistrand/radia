// Replaying a recorded lab run, with no model and no tokens (agent_docs/plan-agent-lab.md).
//
//   deno task test:lab
//
// The corpus is what real models ASKED FOR: sequences and arguments nobody would have written by
// hand. `scripts/agent-lab/replay.ts` re-issues them through a real `radia mcp` against a space
// built from the same scenario, which turns a paid session into a free regression case. This file
// is that check, run from SOURCE so it needs no compiled binary.
//
// It costs about two seconds and proves one property: every call the corpus answered is answered
// still. What it cannot prove is anything about a model, which chose those calls and is not here.

import { assert, assertEquals } from "@std/assert";
import { classify as replayClassify, replay, SOURCE } from "./replay.ts";
import { classify as traceClassify } from "../../src/surfaces/mcp/trace.ts";

const FIXTURE = new URL("./testdata/team-workspace-2026-08-29T18-28-27-115Z", import.meta.url).pathname;
const TREE = new URL("./testdata/team-tree-2026-08-29T19-24-31-847Z", import.meta.url).pathname;
const TWOSTEP = new URL("./testdata/team-exec-twostep-2026-08-29T19-29-03-140Z", import.meta.url).pathname;
const IMAGE = new URL("./testdata/team-image-2026-08-29T19-34-14-021Z", import.meta.url).pathname;
const QUEUE = new URL("./testdata/team-queue-2026-08-29T19-12-34-160Z", import.meta.url).pathname;

Deno.test("[lab] a recorded run replays, and every call it answered is answered still", async () => {
  const r = await replay(FIXTURE, { build: SOURCE, quiet: true, wait: 1 });
  assert(r, "the fixture did not replay");

  // THE VERDICT THAT FAILS A BUILD, and the only one: a call that was answered and now refuses or
  // errors. Proven to fire by planting an off-by-one in `ScopeFiller.choose` (`< 1` for `< 2`),
  // which refuses a single-team caller and turns `space_save_workspace` into a regression here.
  const regressed = r.outcomes.filter((o) => o.verdict === "regressed");
  assertEquals(regressed, [], JSON.stringify(regressed.map((o) => ({ tool: o.line.tool, why: o.why })), null, 1));

  // COVERAGE IS ASSERTED, not assumed. A replay that silently skipped every call would report no
  // regressions and mean nothing, so the count and the skips are pinned to what this run holds.
  assertEquals(r.outcomes.length, 4, "the fixture's four calls");
  assertEquals(r.outcomes.filter((o) => o.verdict === "skipped"), [], "a call could not be rebuilt");

  // The one `diverged` is honest and expected: `space_query {kind: "sandbox"}` found the record the
  // HOST writes at startup, and this replay does not re-run the host. A changed population is
  // reported rather than failed, which is what keeps the check usable on a run with a race in it.
  const diverged = r.outcomes.filter((o) => o.verdict === "diverged");
  assertEquals(diverged.map((o) => `${o.line.tool} ${o.was}->${o.now}`), ["space_query ok->empty"]);
  assertEquals(r.notRerun.sort(), ["deploy", "runner"], "the participants it did not re-run must be named");
});

Deno.test("[lab] a claimed record is settled under the claim THIS replay holds", async () => {
  // Two harnesses draining five seeded tasks, replayed whole. It is here because the ack was the
  // one call the replay could not make: `claimId` names a record the operator seeded and a claim
  // this process minted, neither of which the recorded ids describe, so every settle in all three
  // queue runs was skipped and the call a contention scenario exists to exercise went untested.
  const r = await replay(QUEUE, { build: SOURCE, quiet: true, wait: 1 });
  assert(r, "the queue fixture did not replay");
  assertEquals(r.outcomes.filter((o) => o.verdict === "regressed"), []);

  const settles = r.outcomes.filter((o) => o.line.tool === "space_ack");
  assertEquals(settles.length, 5, "five seeded tasks, five acks");
  assertEquals(settles.filter((o) => o.verdict === "ok").length, 5, JSON.stringify(settles));

  // NOTHING SKIPPED, which is the sharper claim: an id the recording never held (the scenario
  // plants `01ZZZ…` for an agent to look up, and a model writes ids into its own prose) is a
  // LITERAL and travels untouched, so probing for a missing record is replayed rather than refused.
  assertEquals(r.outcomes.filter((o) => o.verdict === "skipped"), []);
  assert(r.outcomes.some((o) => JSON.stringify(o.line.args).includes("01ZZZZZZZZZZZZZZZZZZZZZZZZ")), "the planted id is gone from the fixture");
});

Deno.test("[lab] three models taking turns on ONE tree replay, edit included", async () => {
  // The workspace chain end to end: an author saves a tree, a second agent EDITS it in place, a
  // third reads it back and files a verdict. It is the only case covering `space_edit_workspace`,
  // `space_read_workspace` and `space_list_workspaces`, and the edit is the path `WorkspaceScope`
  // touched (`editWorkspace` resolves its predecessor through a two-step lookup by name).
  const r = await replay(TREE, { build: SOURCE, quiet: true, wait: 1 });
  assert(r, "the tree fixture did not replay");
  assertEquals(r.outcomes.filter((o) => o.verdict === "regressed"), []);
  for (const tool of ["space_save_workspace", "space_edit_workspace", "space_read_workspace", "space_list_workspaces"]) {
    const calls = r.outcomes.filter((o) => o.line.tool === tool);
    assert(calls.length > 0, `${tool} is not in this fixture any more`);
    assertEquals(calls.filter((o) => o.verdict !== "ok"), [], `${tool} did not replay cleanly`);
  }
  // The verifier PARENTS its verdict on the host's result record, and the host is not re-run, so
  // that one call cannot be rebuilt. Named rather than quietly dropped, which is the whole contract.
  const skipped = r.outcomes.filter((o) => o.verdict === "skipped");
  assertEquals(skipped.map((o) => o.line.tool), ["space_put"]);
  assert(/never created/.test(skipped[0].why ?? ""), skipped[0].why);
});

Deno.test("[lab] an artifact is re-paired by its CONTENT ADDRESS, so the chain that names it survives", async () => {
  // The two-step scenario: a worker answers with source in an artifact, and the agent that wrote
  // the task fetches it and dispatches the tool call itself. `space_put_artifact` is the one write
  // whose ARGUMENTS carry no body (it sends `text`), so pairing it to the recorded record needs the
  // digest the answer returns, which identical bytes reproduce exactly. Without that one mapping,
  // four calls fell over the same missing id: the ack naming the artifact, the fetch reading it,
  // the tool_call dispatching it, and the children walk looking for its result.
  const r = await replay(TWOSTEP, { build: SOURCE, quiet: true, wait: 1 });
  assert(r, "the two-step fixture did not replay");
  assertEquals(r.outcomes.filter((o) => o.verdict === "regressed"), []);
  assertEquals(r.outcomes.filter((o) => o.verdict === "skipped"), [], "an id went unmapped");
  for (const tool of ["space_put_artifact", "space_get_artifact", "space_ack"]) {
    assertEquals(r.outcomes.filter((o) => o.line.tool === tool && o.verdict !== "ok").length, 0, `${tool} did not replay`);
  }
});

Deno.test("[lab] a call naming a file this machine does not have is SKIPPED, never a regression", async () => {
  // The image run put its artifact by PATH, naming a PNG the harness generated beside its own
  // config. A local file is not part of the evidence and does not travel with a run directory, so
  // replayed anywhere else that call fails, and since the recording answered `ok` it would be
  // reported as a REGRESSION: a false finding caused by a missing file, which is the one thing this
  // tool must never produce. The fixture's path is rewritten to resolve on NO machine, including
  // the one that recorded it, because a fixture that passes only on its author's laptop is not one.
  const r = await replay(IMAGE, { build: SOURCE, quiet: true, wait: 1 });
  assert(r, "the image fixture did not replay");
  assertEquals(r.outcomes.filter((o) => o.verdict === "regressed"), [], "a missing local file was called a regression");

  const [first, ...rest] = r.outcomes.filter((o) => o.verdict === "skipped");
  assertEquals(first.line.tool, "space_put_artifact");
  assert(/a file on the machine that recorded this run/.test(first.why ?? ""), first.why);
  // The rest are the cascade, and they are the reason the first message has to be right: an
  // artifact nobody could store is an artifact nobody can settle, fetch or read back.
  assertEquals(rest.map((o) => o.line.tool), ["space_ack", "space_get_artifact", "space_get_artifact"]);
  assertEquals(r.outcomes.filter((o) => o.verdict === "ok").length, 12);
});

Deno.test("[lab] the replay classifies an answer exactly as the trace did", async () => {
  // Two implementations of one rule: `trace.ts` writes the outcome into the corpus and the replay
  // reads today's answer back. If they drift, every comparison is between two different questions
  // and the whole check quietly stops meaning anything.
  const cases = [
    "[]",
    '[{"id":"x"}]',
    "null",
    '{"records":[]}',
    '{"records":[{"id":"x"}]}',
    '{"kinds":[{"kind":"note"}]}',
    '{"found":false}',
    "nothing available for that pattern",
    "no workspace named 'x' (or no grant to read it)",
    '{"workspace":"inventory","files":["main.js"]}',
    "not json at all",
  ];
  for (const text of cases) {
    assertEquals(replayClassify(text, false), traceClassify(text).outcome, `disagreed on ${JSON.stringify(text)}`);
  }
  // The one thing only the replay sees: a JSON-RPC error frame, which the trace records from the
  // throw instead of from a body.
  assertEquals(replayClassify("forbidden: no 'put' grant", true), "error");
});
