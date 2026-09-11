// An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than
// claiming them. Results are knowledge, not work. When every result for a job has
// arrived it emits one `summary`, linked to all of them.
//
// THE THREE READS ARE DELIBERATELY DIFFERENT (agent_docs/plan-bounded-reads.md). Candidates come
// from a forward WALK that resumes where the last pass stopped, so every result is seen once and
// no job is stranded by the window: this loop read the oldest 500 and then the newest 200, which
// strand opposite halves of the space. The decision is an EXHAUST scoped to one `jobId` (an
// indexed path, `kinds.ts`), and "already summarized" is a NARROW read of one record.
//
// COMPLETENESS COUNTS DISTINCT INDEXES against an arity every part agrees on, not results against
// whichever `total` arrived first. Counting read a replayed fan-out as complete (indexes [0,0,1] of
// a three-word job summarized as "A A B"), and comparing against a missing `total` completed a job
// of unknown length from one result.
//
// The idempotency key `summary:<jobId>` makes the emit safe when two aggregators race, PROVIDED
// they share an identity: a key is scoped to the agent behind the caller (audit Package U), so
// two runs of one agent dedupe and two different principals deliberately do not.
//
//   deno run --allow-net --allow-env examples/aggregator.ts

import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";
import { reactorLoop } from "../../sdk/ts/loop.ts";

interface ResultBody {
  jobId?: string;
  index: number;
  total: number;
  output: unknown;
}

/** One page of the forward walk below. Not a ceiling on anything: the walk continues until a page
 *  comes back short, so this is how much arrives per round trip and nothing else. */
const PAGE = 200;

export async function aggregatorLoop(client: RadiaClient, signal?: AbortSignal, log?: (m: string) => void): Promise<void> {
  // A memo, not the correctness argument: the key above and the read below are. Seeded from the
  // summaries that already exist, in ONE read rather than a round trip per job, so restarting on a
  // space full of finished jobs costs a page walk instead of a request each.
  const done = new Set<string>();
  for (const s of await client.queryAll<{ jobId: string }>({ kind: "pipeline_summary" })) done.add(s.body.jobId);

  const summarize = async (jobId: string) => {
    if (done.has(jobId)) return;
    // NARROW: one current thing. Survives a restart past the idempotency window, where the key
    // no longer dedupes and this is the only thing standing between a replay and a second summary.
    if (await client.readOne({ kind: "pipeline_summary", match: { jobId } })) {
      done.add(jobId);
      return;
    }
    const results = await client.queryAll<ResultBody>({ kind: "pipeline_result", match: { jobId } });
    if (results.length === 0) return;
    // HOW MANY THERE ARE IS THE JOB'S OWN CLAIM, and every result has to make the same one. A
    // result naming no `total` claims nothing, and `size < undefined` is false, so ONE of them
    // completed a job of unknown length; two results disagreeing is the same defect from the other
    // side. Refuse to decide, out loud, rather than deciding on nothing.
    const totals = new Set(results.map((r) => r.body.total));
    const total = results[0].body.total;
    if (totals.size !== 1 || !Number.isInteger(total)) {
      log?.(`[aggregator] job ${jobId.slice(-6)}: ${results.length} result(s) claim totals ${JSON.stringify([...totals])}; not deciding`);
      return;
    }
    const byIndex = new Map<number, RadiaRecord<ResultBody>>();
    for (const r of results) if (!byIndex.has(r.body.index)) byIndex.set(r.body.index, r);
    if (byIndex.size < total) return;
    const ordered = [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!);
    const text = ordered.map((r) => r.body.output).join(" ");
    await client.put(
      { kind: "pipeline_summary", body: { jobId, text }, parentIds: ordered.map((r) => r.id) },
      `summary:${jobId}`,
    );
    done.add(jobId);
    log?.(`[aggregator] job ${jobId.slice(-6)} -> summary "${text}"`);
  };

  // HOW FAR THIS PROCESS HAS WALKED. Every result is seen exactly once, in order, and a job is
  // decided when the result that completes it arrives.
  //
  // NEITHER DIRECTION OF A FIXED PAGE WORKS HERE, and both were shipped: reading the oldest N
  // stranded every job after the first N, and reading the newest N stranded any job whose last
  // result had fallen out of the window (restart after a busy period, or a burst between two
  // passes). A page is only honest as a WALK, and `{after, dir: "asc"}` is the resume the wire
  // type names for a watermark the caller keeps (`sdk/ts/wire.ts`, `Page`). The first pass starts
  // at the beginning, which is the catch-up; every later pass reads only what arrived.
  let after: string | undefined;
  // Jobs the pass below could not finish. Carried, because the watermark has already moved past
  // the result that named them: dropping them on a transient failure is the same stranding by a
  // different route.
  let pending = new Set<string>();

  // The fact-side harness: reconcile at boot, on every wakeup, on every tick. The watch is a
  // wakeup hint; the tick is what heals a result written while the stream was re-creating itself.
  await reactorLoop(client, {
    name: "aggregator",
    patterns: [{ kind: "pipeline_result" }],
    signal,
    log,
    pollMs: 1000,
    reconcile: async () => {
      const jobs = pending;
      pending = new Set();
      for (;;) {
        const { records } = await client.queryPage<ResultBody>({ kind: "pipeline_result" }, PAGE, { after, dir: "asc" });
        for (const r of records) {
          if (r.body.jobId) jobs.add(r.body.jobId); // standalone results have none
          after = r.id;
        }
        if (records.length < PAGE) break;
      }
      let failure: unknown;
      for (const jobId of jobs) {
        try {
          await summarize(jobId);
        } catch (e) {
          pending.add(jobId);
          failure ??= e;
        }
      }
      if (failure) throw failure; // reported by the harness; the next pass retries `pending`
    },
  });
}

if (import.meta.main) {
  const client = new RadiaClient();
  console.log(`aggregator connecting to ${client.base}`);
  await aggregatorLoop(client, undefined, (m) => console.log(m));
}
