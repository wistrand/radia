// The kinds the demo agents coordinate over. Registering declares which body paths are
// matchable. That is what lets a worker claim `{kind:pipeline_task, match:{op}}` and the
// aggregator group results by job. The names are prefixed `pipeline_*` (the stress example's
// convention) so the demo shares a space without claiming anybody else's `task` or `job`.

import type { RadiaClient } from "../../sdk/ts/client.ts";

export async function registerDemoKinds(client: RadiaClient): Promise<void> {
  await client.registerKind({ kind: "pipeline_job", indexedPaths: [] });
  await client.registerKind({
    kind: "pipeline_task",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "jobId", type: "keyword" }],
  });
  // result/summary are facts read by `query`, never `take`n → reference kinds (claimable:false).
  await client.registerKind({
    kind: "pipeline_result",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "jobId", type: "keyword" }],
    claimable: false,
  });
  await client.registerKind({ kind: "pipeline_summary", indexedPaths: [{ path: "jobId", type: "keyword" }], claimable: false });
}
