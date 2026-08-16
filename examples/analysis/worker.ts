// One stage of the pipeline, as a worker.
//
//   deno run -A examples/analysis/worker.ts --stage features --url … --token …
//
// It advertises the CODE it runs, then claims the requests that name that code. Advertising rather
// than being configured is the same rule the chat's model tiers follow: the planner discovers what
// version is live instead of holding a table that drifts.
//
// The lease is what makes this safe to run several of. Two workers on one stage claim different
// requests; a crashed one has its lease expire and the work is redelivered. Nothing here has to
// know either thing.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { STAGE_IMPLS, stagesDigest } from "./stages.ts";
import type { StageName } from "./kinds.ts";

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const url = arg("--url") ?? "http://127.0.0.1:7788";
const stage = (arg("--stage") ?? "clean") as StageName;
const token = arg("--token");
const impl = STAGE_IMPLS[stage];
if (!impl) {
  console.error(`no such stage: ${stage}. Known: ${Object.keys(STAGE_IMPLS).join(", ")}`);
  Deno.exit(1);
}

const client = new RadiaClient(url, token ? { definitionToken: token } : {});
const codeDigest = await stagesDigest();

// Content-keyed on (stage, digest): a restart writes nothing, a code change is a successor, and the
// planner's registry read sees the newest.
await client.put(
  { kind: "stage_code", body: { stage, codeDigest, about: impl.about } },
  `stage-code:${stage}:${codeDigest}`,
);
console.error(`[${stage}] serving ${codeDigest}`);

await agentLoop(client, {
  name: `analysis:${stage}`,
  // ONE pattern per stage name, never `stage_request` wholesale: claiming the kind would steal the
  // other stages' work and they would wait forever.
  patterns: [{ kind: "stage_request", match: { stage } }],
  leaseSeconds: 60,
  handle: async (rec, c) => {
    const b = rec.body as {
      dataset: string;
      inputArtifact: string;
      inputDigest: string;
      codeDigest: string;
      owner: string;
    };
    // The request names the code it wants. A worker running something else must not answer it: the
    // result would be filed under a digest that did not produce it, and every later "has this run"
    // check would be wrong. Left unclaimed rather than nacked — a worker serving that digest may
    // still be starting.
    if (b.codeDigest !== codeDigest) {
      console.error(`[${stage}] leaving ${rec.id}: it asks for ${b.codeDigest}, I serve ${codeDigest}`);
      return;
    }
    const input = await c.getArtifact(b.inputArtifact);
    let output: Uint8Array;
    try {
      output = impl.run(input);
    } catch (e) {
      // A failed stage is an ANSWER, not a nack: the input will not become parseable on redelivery,
      // and a retry loop would hide the failure behind a lease that keeps expiring.
      return {
        kind: "stage_result",
        body: {
          stage,
          dataset: b.dataset,
          inputDigest: b.inputDigest,
          codeDigest,
          outputDigest: "",
          owner: b.owner,
          ok: "no",
          error: e instanceof Error ? e.message : String(e),
        },
        parentIds: [rec.id],
      };
    }
    // The OUTPUT is an artifact, so its content digest becomes the next stage's input digest. The
    // chain is content-addressed end to end without anyone computing a hash by hand.
    const art = await c.putArtifact(output, {
      mediaType: "application/json",
      filename: `${b.dataset}-${stage}.json`,
      meta: { dataset: b.dataset, owner: b.owner },
      parentIds: [rec.id],
    });
    return {
      kind: "stage_result",
      body: {
        stage,
        dataset: b.dataset,
        inputDigest: b.inputDigest,
        codeDigest,
        outputDigest: art.digest,
        outputArtifact: art.id,
        owner: b.owner,
        ok: "yes",
        bytes: art.size,
      },
      parentIds: [rec.id],
    };
  },
});
