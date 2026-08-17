// The adapter between a stage's pure transform and the workspace-agent host
// (extensions/ts/host.ts). The host materialises the request's declared input at `input/data`
// before the run; the transform's output is written to the run's own output directory (the cwd,
// never this tree), and its digest is computed HERE, in the jail, so the result names bytes this
// run actually wrote (architecture-analysis-workspace-agents.md gap 2).
//
// SELF-CONTAINED, like everything in a stage tree: the jail materialises the tree and nothing
// else, so an import into the repository would run on a developer's machine and fail as "module
// not found" inside the jail. This file is included in every stage's tree; identical bytes are one
// artifact, so the copies cost nothing.

export interface StageRequest {
  body: {
    stage?: string;
    dataset?: string;
    inputDigest?: string;
    codeDigest?: string;
    workspace?: string;
    tier?: string;
    owner?: string;
  };
}

export async function runStage(
  record: StageRequest,
  transform: (input: Uint8Array) => Uint8Array,
): Promise<{ kind: "stage_result"; body: Record<string, unknown> }> {
  const b = record.body;
  const base = {
    stage: b.stage,
    dataset: b.dataset,
    inputDigest: b.inputDigest,
    // Which code produced this: the tree digest the request named, and what the result-side pin
    // matches, together with the tier. Echoed from the claimed record because a tree cannot know
    // its own digest.
    workspace: b.workspace ?? b.codeDigest ?? "",
    ...(b.tier ? { tier: b.tier } : {}),
    owner: b.owner,
  };
  let output: Uint8Array;
  try {
    output = transform(new Uint8Array(await Deno.readFile("input/data")));
  } catch (e) {
    // A failed stage is an ANSWER, not a crash: the input will not become parseable on redelivery,
    // and a retry loop would hide the failure behind a lease that keeps expiring.
    return {
      kind: "stage_result",
      body: { ...base, outputDigest: "", ok: "no", error: e instanceof Error ? e.message : String(e) },
    };
  }
  await Deno.writeFile("output.json", output);
  // Plain sha256 hex, the same content address the artifact store computes, so this digest and the
  // one on the captured artifact are comparable without translation.
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", output as BufferSource));
  const outputDigest = [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { kind: "stage_result", body: { ...base, outputDigest, ok: "yes", bytes: output.length } };
}
