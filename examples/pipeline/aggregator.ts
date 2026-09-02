// An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than
// claiming them. Results are knowledge, not work. When every result for a job has
// arrived it emits one `summary`, linked to all of them. The idempotency key
// `summary:<jobId>` makes the emit safe when two aggregators race, PROVIDED they share an
// identity: a key is scoped to the agent behind the caller (audit Package U), so two runs of one
// agent dedupe and two different principals deliberately do not.
//
//   deno run --allow-net --allow-env examples/aggregator.ts

import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ResultBody {
  jobId?: string;
  index: number;
  total: number;
  output: unknown;
}

export async function aggregatorLoop(client: RadiaClient, signal?: AbortSignal, log?: (m: string) => void): Promise<void> {
  const done = new Set<string>();
  while (!signal?.aborted) {
    const results = await client.queryOldest<ResultBody>({ kind: "pipeline_result" }, 500);
    const byJob = new Map<string, RadiaRecord<ResultBody>[]>();
    for (const r of results) {
      const jobId = r.body.jobId;
      if (!jobId) continue; // standalone task results have no job
      (byJob.get(jobId) ?? byJob.set(jobId, []).get(jobId)!).push(r);
    }
    for (const [jobId, rs] of byJob) {
      if (done.has(jobId)) continue;
      const total = rs[0].body.total;
      if (rs.length < total) continue;
      const ordered = [...rs].sort((a, b) => a.body.index - b.body.index);
      const text = ordered.map((r) => r.body.output).join(" ");
      await client.put(
        { kind: "pipeline_summary", body: { jobId, text }, parentIds: ordered.map((r) => r.id) },
        `summary:${jobId}`,
      );
      done.add(jobId);
      log?.(`[aggregator] job ${jobId.slice(-6)} -> summary "${text}"`);
    }
    await sleep(200);
  }
}

if (import.meta.main) {
  const client = new RadiaClient();
  console.log(`aggregator connecting to ${client.base}`);
  await aggregatorLoop(client, undefined, (m) => console.log(m));
}
