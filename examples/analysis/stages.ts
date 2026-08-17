// The shipped analysis stages, each a self-contained ENTRYPOINT TREE under stages/<name>/,
// published as workspaces at bootstrap. Nothing in the repo executes them: the host materialises
// each agent's bound tree and runs it jailed.
//
// A stage is a pure transform over bytes (no clock, no randomness, no I/O beyond what the harness
// hands it), which is what makes the pipeline's caching honest: "same input, same code, same
// output" holds, so a memo keyed on (inputDigest, workspace digest) is sound. Per-stage
// granularity is the point: editing one stage's tree re-runs that stage and everything after it,
// and nothing else. Each tree carries `harness.ts` (the host adapter) beside `<stage>/main.ts`;
// the harness bytes are identical across trees, so content addressing stores them once.

import { readWorkspace, writeWorkspace } from "../../extensions/ts/workspace.ts";
import type { RadiaClient } from "../../sdk/ts/client.ts";
import { STAGES, type StageName } from "./kinds.ts";

/** One stage's tree as path -> bytes, read from disk. The entry module sits under the stage's own
 *  directory and imports `../harness.ts`, a layout that resolves identically on disk and inside a
 *  materialised tree. */
async function treeFiles(stage: StageName): Promise<Record<string, Uint8Array>> {
  return {
    "harness.ts": await Deno.readFile(new URL("./stages/harness.ts", import.meta.url)),
    [`${stage}/main.ts`]: await Deno.readFile(new URL(`./stages/${stage}/main.ts`, import.meta.url)),
  };
}

const entrypointOf = (stage: StageName) => `${stage}/main.ts`;

/**
 * Operator setup: store each stage's tree as a workspace named `stage-<name>`.
 *
 * Idempotent through `writeWorkspace`'s own dedupe (an identical tree is a no-op), and a changed
 * tree becomes the next version based on its predecessor. This is what step 4 binds and promotes:
 * the request's digest stops being an advertisement and becomes a tree the host can materialise.
 */
export async function publishStageWorkspaces(client: RadiaClient): Promise<Record<StageName, string>> {
  const out = {} as Record<StageName, string>;
  for (const stage of STAGES) {
    const before = await readWorkspace(client, `stage-${stage}`);
    const ws = await writeWorkspace(client, {
      name: `stage-${stage}`,
      owner: "analysis",
      files: await treeFiles(stage),
      entrypoint: entrypointOf(stage),
      ...(before ? { basedOn: before.id } : {}),
    });
    out[stage] = ws.treeDigest;
  }
  return out;
}
