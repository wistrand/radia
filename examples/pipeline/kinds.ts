// The kinds the demo agents coordinate over. Registering declares which body paths are
// matchable. That is what lets a worker claim `{kind:task, match:{op}}` and the
// aggregator group results by job.

import type { RadiaClient } from "../../sdk/ts/client.ts";

export async function registerDemoKinds(client: RadiaClient): Promise<void> {
  await client.registerKind({ kind: "job", indexedPaths: [] });
  await client.registerKind({
    kind: "task",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "jobId", type: "keyword" }],
  });
  // result/summary are facts read by `query`, never `take`n → reference kinds (claimable:false).
  await client.registerKind({
    kind: "result",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "jobId", type: "keyword" }],
    claimable: false,
  });
  await client.registerKind({ kind: "summary", indexedPaths: [{ path: "jobId", type: "keyword" }], claimable: false });
}
