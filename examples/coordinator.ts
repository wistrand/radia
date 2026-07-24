// The coordinator seeds work and reads outcomes. It knows nothing about which agent will
// do what — it just posts a `job` and a standalone `task`, then waits for the results to
// appear. Run it against a space that has a planner, workers, and an aggregator running.
//
//   deno run --allow-net --allow-env examples/coordinator.ts

import { RadiaClient, type RadiaRecord } from "../sdk/ts/client.ts";
import { registerDemoKinds } from "./kinds.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollFor(fn: () => Promise<RadiaRecord | null>, timeoutMs = 10000): Promise<RadiaRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await sleep(150);
  }
  return null;
}

export async function seedAndAwait(client: RadiaClient, text: string): Promise<void> {
  await registerDemoKinds(client);

  // A job to be planned + fanned out, and a standalone task that only worker:reverse matches.
  const job = await client.put({ kind: "job", body: { text } });
  await client.put({ kind: "task", body: { op: "reverse", input: "radia" } });
  console.log(`[coordinator] posted job ${job.id.slice(-6)} ("${text}") + a standalone reverse task`);

  const summary = await pollFor(() => client.readOne({ kind: "summary", match: { jobId: job.id } }));
  if (summary) console.log(`[coordinator] job summary: "${(summary.body as { text: string }).text}"`);
  else console.log(`[coordinator] no summary yet (are the planner/workers/aggregator running?)`);

  const reversed = await pollFor(() => client.readOne({ kind: "result", match: { op: "reverse" } }));
  if (reversed) console.log(`[coordinator] standalone reverse -> "${(reversed.body as { output: string }).output}"`);
}

if (import.meta.main) {
  const client = new RadiaClient();
  await seedAndAwait(client, Deno.args.join(" ") || "the quick brown fox");
}
