// A planner agent. It claims a `job`, splits its text into words, and emits one `upper`
// task per word (fan-out), each linked to the job via parent_ids. Consuming the job with
// no result record; the emitted tasks carry the work forward.
//
//   deno run --allow-net --allow-env examples/planner.ts

import { agentLoop } from "../sdk/ts/loop.ts";
import { RadiaClient, type RadiaRecord } from "../sdk/ts/client.ts";
import { tools } from "./tools.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `paceMs` (demo only) staggers the fan-out so the feed animates; 0 = instant. */
export function plannerLoop(client: RadiaClient, signal?: AbortSignal, log?: (m: string) => void, paceMs = 0): Promise<void> {
  return agentLoop(client, {
    name: "planner",
    templates: [{ kind: "job" }],
    signal,
    log,
    handle: async (job: RadiaRecord, c: RadiaClient) => {
      const words = tools.split((job.body as { text: string }).text) as string[];
      for (let i = 0; i < words.length; i++) {
        await c.put({
          kind: "task",
          body: { op: "upper", input: words[i], jobId: job.id, index: i, total: words.length },
          parentIds: [job.id],
        });
        if (paceMs) await sleep(paceMs);
      }
      log?.(`[planner] job ${job.id.slice(-6)} -> ${words.length} tasks`);
      // ack the job with no result; the tasks are the output.
    },
  });
}

if (import.meta.main) {
  const client = new RadiaClient();
  console.log(`planner connecting to ${client.base}`);
  await plannerLoop(client, undefined, (m) => console.log(m));
}
