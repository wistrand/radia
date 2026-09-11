// An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than
// claiming them. Results are knowledge, not work. When every result for a job has
// arrived it emits one `summary`, linked to all of them.
//
// THE THREE READS ARE DELIBERATELY DIFFERENT (agent_docs/plan-bounded-reads.md). Candidates come
// from a PAGE of the NEWEST results, which is a walk and never a completeness test: this loop
// read the OLDEST 500 for both, so past 500 results the window pinned to the first jobs and no
// later one ever finished. The decision is an EXHAUST scoped to one `jobId` (an indexed path,
// `kinds.ts`), and "already summarized" is a NARROW read of one record.
//
// COMPLETENESS COUNTS DISTINCT INDEXES, not results. Counting read a replayed fan-out as
// complete: indexes [0,0,1] of a three-word job summarized as "A A B", word 2 missing.
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

/** How many of the newest results a pass looks at to find jobs worth checking. Bounded ON
 *  PURPOSE: a job completes while its results are still among the newest, and each candidate is
 *  then re-read exhaustively before anything is decided. */
const CANDIDATES = 200;

export async function aggregatorLoop(client: RadiaClient, signal?: AbortSignal, log?: (m: string) => void): Promise<void> {
  // A memo, not the correctness argument: the key above and the read below are.
  const done = new Set<string>();

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
    const byIndex = new Map<number, RadiaRecord<ResultBody>>();
    for (const r of results) if (!byIndex.has(r.body.index)) byIndex.set(r.body.index, r);
    if (byIndex.size < results[0].body.total) return;
    const ordered = [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!);
    const text = ordered.map((r) => r.body.output).join(" ");
    await client.put(
      { kind: "pipeline_summary", body: { jobId, text }, parentIds: ordered.map((r) => r.id) },
      `summary:${jobId}`,
    );
    done.add(jobId);
    log?.(`[aggregator] job ${jobId.slice(-6)} -> summary "${text}"`);
  };

  // The fact-side harness: reconcile at boot, on every wakeup, on every tick. The watch is a
  // wakeup hint; the tick is what heals a result written while the stream was re-creating itself.
  await reactorLoop(client, {
    name: "aggregator",
    patterns: [{ kind: "pipeline_result" }],
    signal,
    log,
    pollMs: 1000,
    reconcile: async () => {
      const recent = await client.queryNewest<ResultBody>({ kind: "pipeline_result" }, CANDIDATES);
      const jobs = new Set<string>();
      for (const r of recent) if (r.body.jobId) jobs.add(r.body.jobId); // standalone results have none
      for (const jobId of jobs) await summarize(jobId);
    },
  });
}

if (import.meta.main) {
  const client = new RadiaClient();
  console.log(`aggregator connecting to ${client.base}`);
  await aggregatorLoop(client, undefined, (m) => console.log(m));
}
