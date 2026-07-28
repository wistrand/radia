// A worker agent. It claims ONLY tasks whose `op` matches the tool it runs — content
// routing, no routing table. Run two with different ops and each self-selects its work.
//
//   deno run --allow-net --allow-env examples/worker.ts upper
//   deno run --allow-net --allow-env examples/worker.ts reverse

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";
import { tools } from "./tools.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `paceMs` (demo only) simulates the work taking time so the feed animates; 0 = instant. */
export function workerLoop(client: RadiaClient, op: string, signal?: AbortSignal, log?: (m: string) => void, paceMs = 0): Promise<void> {
  if (!tools[op]) throw new Error(`unknown tool op: ${op}`);
  return agentLoop(client, {
    name: `worker:${op}`,
    patterns: [{ kind: "task", match: { op } }],
    signal,
    log,
    handle: async (rec: RadiaRecord) => {
      const b = rec.body as { input: unknown; jobId?: string; index?: number; total?: number };
      if (paceMs) await sleep(paceMs);
      const output = tools[op](b.input);
      // Result is a fact linked to its task (ack sets parent_ids = [task]).
      return {
        kind: "result",
        body: { op, output, jobId: b.jobId, index: b.index, total: b.total },
      };
    },
  });
}

if (import.meta.main) {
  const op = Deno.args[0] ?? "upper";
  const client = new RadiaClient();
  console.log(`worker:${op} connecting to ${client.base}`);
  await workerLoop(client, op, undefined, (m) => console.log(m));
}
