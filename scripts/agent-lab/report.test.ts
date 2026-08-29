// The lab's REPORTER, against frozen evidence (agent_docs/plan-agent-lab.md phase 2).
//
//   deno task test:lab
//
// `scripts/agent-lab/report.ts` holds eight checks that decide what a run is worth, and until this
// file nothing exercised any of them: they ran only when somebody spent tokens on a live harness,
// which is the one thing CI cannot do. The fixtures under `scripts/agent-lab/testdata/` are the
// EVIDENCE HALF of two real runs (traces, `space.json`, `tally.json`, and `scenario.json` where the
// run is new enough to have one), copied without the credential file, the logs or the 28 MB PGlite
// directory beside them. 124 KB buys every check a case.
//
// A fixture is a RUN THAT HAPPENED, so the assertions below are what those two runs actually did,
// not a scenario invented to suit a check. The queue one is the run behind the `space_nack` finding
// in agent_docs/research-agent-sessions.md; pinning it here is what stops that finding's evidence
// from being re-derivable only by paying for another session.

import { assert, assertEquals } from "@std/assert";
import { describe, load } from "./report.ts";

const TESTDATA = new URL("./testdata/", import.meta.url).pathname;
const QUEUE = `${TESTDATA}team-queue-2026-08-28T13-28-17-483Z`;
const WORKSPACE = `${TESTDATA}team-workspace-2026-08-29T18-28-27-115Z`;

/** Every check the reporter ships. A run puts each one in `per` (it decided) or `skipped` (it could
 *  not), and the union is how a check that quietly stopped running is caught: a disappearing check
 *  reads as a clean run, which is the failure mode this whole file exists against. */
const CHECK_IDS = [
  "empty-claim-while-work-stood-available",
  "settled-more-than-once",
  "left-claimed-or-dead-lettered",
  "retry-loop-on-one-record",
  "participant-authored-nothing",
  "delivered-code-was-altered",
  "refusals",
  "wrote-without-reading-the-vocabulary",
].sort();

async function reportOf(dir: string) {
  const run = await load(dir);
  assert(run, `${dir} did not load`);
  return describe(run);
}

Deno.test("[lab] every check decides or says it cannot, and none of them vanishes", async () => {
  for (const dir of [QUEUE, WORKSPACE]) {
    const rep = await reportOf(dir);
    const covered = [...rep.per.keys(), ...rep.skipped.keys()].sort();
    assertEquals(covered, CHECK_IDS, `${dir}: a check neither decided nor skipped`);
    // A skip must SAY why. "Not applicable" with no reason is indistinguishable from a pass, which
    // is the over-reporting the reporter's own header refuses.
    for (const [id, note] of rep.skipped) assert(note.length > 0, `${id} skipped with no reason`);
  }
});

Deno.test("[lab] the nack loop is found in the run that produced it, and only there", async () => {
  // agent_docs/research-agent-sessions.md, "space_nack was used for the first time, and used
  // toward a dead-letter": four attempts on the impossible task, three nacks at zero backoff, an
  // ack on the fourth. `maxAttempts` is 5, so one more turn would have dead-lettered it.
  const queue = await reportOf(QUEUE);
  const found = queue.per.get("retry-loop-on-one-record") ?? [];
  assertEquals(found.length, 1, JSON.stringify(found));
  assertEquals(found[0].severity, "medium");
  assert(/nacked 3 times/.test(found[0].title), found[0].title);
  assert(/4 attempts by codex-lab/.test(found[0].detail), found[0].detail);
  assert(/backoffSeconds 0/.test(found[0].detail), found[0].detail);

  // The same check, on a run with no retry at all, reports nothing rather than something.
  const workspace = await reportOf(WORKSPACE);
  assertEquals((workspace.per.get("retry-loop-on-one-record") ?? []).length, 0);
});

Deno.test("[lab] contention settled cleanly, and the checks that would have said otherwise ran", async () => {
  // The other half of that finding, and the half that is easy to lose: five seeded tasks, two
  // claimants, every task settled EXACTLY once with nothing still claimed at exit. Both checks are
  // in `per` rather than `skipped`, so zero findings here means they looked and found nothing.
  const rep = await reportOf(QUEUE);
  for (const id of ["settled-more-than-once", "left-claimed-or-dead-lettered"]) {
    const findings = rep.per.get(id);
    assert(findings, `${id} did not run on a run with claims in it`);
    assertEquals(findings.length, 0, `${id}: ${JSON.stringify(findings)}`);
  }
});

Deno.test("[lab] a check that cannot decide is SKIPPED, never counted as a pass", async () => {
  // Nothing was claimed in the workspace run, so the claim-shaped check has no population. The
  // distinction is the reporter's whole discipline: an empty answer to a question nobody could ask
  // must not read as an answer.
  const rep = await reportOf(WORKSPACE);
  assert(!rep.per.has("empty-claim-while-work-stood-available"), "a check with no population reported a verdict");
  assert(/claimed/.test(rep.skipped.get("empty-claim-while-work-stood-available") ?? ""), "the skip does not say why");
});

Deno.test("[lab] a run older than `scenario.json` still loads, and says what it has", async () => {
  // `scenario.json` was added after this run (agent_docs/plan-agent-lab.md phase 2). The reporter
  // must read what exists rather than refusing the corpus that motivated it.
  assert(!(await Deno.stat(`${QUEUE}/scenario.json`).catch(() => null)), "fixture is no longer the older shape");
  const rep = await reportOf(QUEUE);
  assertEquals(rep.run.scenario, "team-queue");
  assertEquals(rep.run.results.map((r) => r.name).sort(), ["claude-lab", "codex-lab"]);
  // Both harnesses were traced, which is what makes the trace-joining checks answerable at all.
  assertEquals([...rep.run.traces.keys()].sort(), ["claude-lab", "codex-lab"]);
});
