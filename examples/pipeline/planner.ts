// A planner agent. It claims a `job`, splits its text into words, and emits one `upper`
// task per word (fan-out), each linked to the job via parent_ids. Consuming the job with
// no result record; the emitted tasks carry the work forward.
//
// EVERY FAN-OUT WRITE IS KEYED, and that is the whole correctness argument here. A handler that
// returns its answer gets a keyed, fenced, parented ack for free (`LoopOptions.handle`), but a
// fan-out has N answers and one ack, so these are ordinary `put`s that a redelivery writes twice:
// kill this process between the puts and the ack and the job comes back, replays the whole
// fan-out, and the space holds two tasks per word. Content-keying makes the replay a no-op.
//
//   deno run --allow-net --allow-env examples/planner.ts

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";
import { tools } from "./tools.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `paceMs` (demo only) staggers the fan-out so the feed animates; 0 = instant. */
export function plannerLoop(client: RadiaClient, signal?: AbortSignal, log?: (m: string) => void, paceMs = 0): Promise<void> {
  return agentLoop<{ text: string }>(client, {
    name: "planner",
    patterns: [{ kind: "pipeline_job" }],
    signal,
    log,
    handle: async (job, c) => {
      const words = tools.split(job.body.text) as string[];
      for (let i = 0; i < words.length; i++) {
        await c.put({
          kind: "pipeline_task",
          body: { op: "upper", input: words[i], jobId: job.id, index: i, total: words.length },
          parentIds: [job.id],
        }, `pipeline_task:${job.id}:${i}`);
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
