// The staleness planner: the one piece the runtime does not hand you.
//
//   deno run -A examples/analysis/planner.ts --url … --token …
//
// Everything else here is ordinary Radia — lineage gives the DAG, patterns give the routing, the
// event chain gives the audit. What no runtime can decide for you is WHICH work is stale, because
// that depends on what you consider an input. This file is that decision, and it is small:
//
//   for each dataset, walk the stages in order
//     input digest = the dataset's digest, or the previous stage's OUTPUT digest
//     if a stage_result exists for (dataset, stage, inputDigest, codeDigest) -> done, go on
//     else ask for it, and stop: the next stage's input does not exist yet
//
// Two properties fall out of keying on digests rather than on "has it run":
//
//   CHANGING A STAGE re-runs that stage and everything after it, because its new output digest is
//   the next stage's new input digest. Nothing walks the graph invalidating; the keys simply miss.
//   CHANGING NOTHING re-runs nothing, however many times this executes. The planner is a pure
//   function of what it reads, so it is safe to run on a timer, on a watch, or by hand.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { readRegistry } from "../../sdk/ts/client.ts";
import { reactorLoop } from "../../sdk/ts/loop.ts";
import type { RadiaRecord } from "../../sdk/ts/wire.ts";
import { readBindings } from "../../extensions/ts/host.ts";
import { PIPELINE_TIER } from "./kinds.ts";

export interface PlanStep {
  dataset: string;
  stage: string;
  inputDigest: string;
  /** The tree digest of the code this step runs under: the pin vocabulary
   *  (architecture-analysis-workspace-agents.md), carried on requests and results as `workspace`. */
  workspace: string;
  /** Absent while the stage is still to be asked for; set once a request exists. */
  requested?: string;
  state: "done" | "requested" | "asked" | "blocked" | "failed";
  resultId?: string;
  outputDigest?: string;
  error?: string;
}

/** What code each stage is currently serving, from its agent's BINDING: the same record the host
 *  materialises and the promotion pin is checked against, so discovery and enforcement read one
 *  state and cannot disagree. This replaced the workers' self-advertisement (`stage_code`), which
 *  nothing verified. Paged to exhaustion inside `readBindings`, latest per agent, retirements
 *  dropped. Any `agent:analysis-<stage>` binding counts, so a stage deployed after this process
 *  started needs no code change here. */
export async function liveCode(c: RadiaClient): Promise<Map<string, string>> {
  const bindings = await readBindings(c);
  const out = new Map<string, string>();
  for (const b of bindings) {
    const m = /^agent:analysis-(.+)$/.exec(b.agent);
    if (m) out.set(m[1], b.workspaceDigest);
  }
  return out;
}

/** One entry of the pipeline's SHAPE: which stage, where in the order. A latest-wins registry
 *  (retire to remove), so adding a stage is a `stage_def` put and never a code change. */
export interface StageDef {
  stage: string;
  index: number;
  about?: string;
}

/** The pipeline's stages, in order, from the `stage_def` registry. Paged to exhaustion: a def
 *  that fell off a page would silently truncate every dataset's pipeline. */
export async function readStageDefs(c: RadiaClient): Promise<StageDef[]> {
  const view = await readRegistry<StageDef & { retired?: boolean }>(
    (limit, after) => c.query({ kind: "stage_def" }, limit, { after }),
    (b) => b.stage,
  );
  if (!view.complete) throw new Error("could not read the stage_def registry completely");
  return [...view.entries.values()]
    .map((r) => r.body as StageDef)
    .sort((a, b) => a.index - b.index);
}

/**
 * Bring one dataset up to date, and report what each stage is doing.
 *
 * `apply: false` plans without writing, which is what the web app renders: an operator sees what
 * WOULD run before anything does.
 */
/**
 * What one pass reads, once, for every dataset it is about to plan.
 *
 * The planner used to ask per dataset per stage, so a pass cost O(datasets x stages) queries and it
 * ran on EVERY result landing. Three reads now serve the whole pass however many datasets there
 * are, and the planning itself is map lookups.
 *
 * Scoped with `$in` over the datasets in hand and PAGED TO EXHAUSTION, which is the part that has
 * to be right: a bounded read that missed a result would report a finished stage as still pending,
 * the walk would stop there, and every stage after it would never be planned. That is a stall, not
 * a slow answer, so the read reports `complete: false` and this refuses rather than plans on a
 * prefix.
 */
interface PassReads {
  /** The pipeline's shape, in order: what to walk. */
  defs: StageDef[];
  code: Map<string, string>;
  results: Map<string, RadiaRecord>;
  requests: Map<string, RadiaRecord>;
  /** outputDigest -> artifact record id, for results whose body names no artifact. A stage run in
   *  the jail computes its output's DIGEST and cannot know the id the capture assigned; the digest
   *  is content-addressed, so one indexed query recovers the id (architecture-analysis-workspace-agents.md
   *  gap 2). Bulk, over every ok result's digest, so a pass stays FLAT however many datasets. */
  artifacts: Map<string, string>;
}

/** The logical identity of one unit of work: which dataset, which stage, on what input, under
 *  which code. The same four fields the records are indexed on, so a map lookup answers exactly
 *  what the per-stage query used to. `codeDigest` is the field's name on records written before
 *  the rename to `workspace`; reading both keeps them one population. */
const workKey = (b: { dataset?: string; stage?: string; inputDigest?: string; workspace?: string; codeDigest?: string }) =>
  `${b.dataset}|${b.stage}|${b.inputDigest}|${b.workspace ?? b.codeDigest}`;

async function readPass(c: RadiaClient, names: string[]): Promise<PassReads> {
  const defs = await readStageDefs(c);
  const code = await liveCode(c);
  if (names.length === 0) return { defs, code, results: new Map(), requests: new Map(), artifacts: new Map() };
  const bulk = async (kind: string) => {
    const view = await readRegistry<Record<string, unknown>>(
      (limit, after) => c.query({ kind, match: { dataset: { $in: names } } }, limit, { dir: "desc", after }),
      (b) => workKey(b as { dataset?: string }),
    );
    if (!view.complete) throw new Error(`could not read every ${kind} for this pass; refusing to plan on a prefix`);
    return view.newest; // newest per work key, retirements included: nothing here retires
  };
  const results = await bulk("stage_result");
  // Resolve every ok result's output digest to its artifact id in ONE read, skipping results that
  // carry the id already (records from before the host, whose worker stored the artifact itself).
  const unresolved = [...results.values()]
    .map((r) => r.body as { ok?: string; outputDigest?: string; outputArtifact?: string })
    .filter((b) => b.ok === "yes" && b.outputDigest && !b.outputArtifact)
    .map((b) => b.outputDigest!);
  const artifacts = new Map<string, string>();
  if (unresolved.length > 0) {
    const view = await readRegistry<{ digest?: string }>(
      (limit, after) => c.query({ kind: "artifact", match: { digest: { $in: [...new Set(unresolved)] } } }, limit, { dir: "desc", after }),
      (b) => b.digest,
    );
    if (!view.complete) throw new Error("could not resolve every output digest to an artifact; refusing to plan on a prefix");
    for (const [digest, rec] of view.entries) artifacts.set(digest, rec.id);
  }
  return { defs, code, results, requests: await bulk("stage_request"), artifacts };
}

/**
 * Bring one dataset up to date, and report what each stage is doing.
 *
 * Pure lookups against `reads` plus, when `apply` is set, at most one write: the next stage's
 * request. `apply: false` plans without writing, which is what the web app renders — an operator
 * sees what WOULD run before anything does.
 */
export async function planDataset(
  c: RadiaClient,
  dataset: { name: string; digest: string; artifactId: string; owner: string },
  reads: PassReads,
  opts: { apply?: boolean } = {},
): Promise<PlanStep[]> {
  const steps: PlanStep[] = [];
  let inputDigest = dataset.digest;
  let inputArtifact = dataset.artifactId;

  for (const { stage } of reads.defs) {
    const workspace = reads.code.get(stage);
    if (!workspace) {
      // No binding names this stage's code. Reported rather than requested: a request naming no
      // live code would sit unclaimed and look like a slow stage rather than a missing one.
      steps.push({ dataset: dataset.name, stage, inputDigest, workspace: "", state: "blocked" });
      break;
    }
    const match = { dataset: dataset.name, stage, inputDigest, workspace };
    // THE MEMO. Still keyed on all four fields, and still not an idempotency key (kinds.ts): this
    // must answer correctly a month later, and content-key idempotency expires.
    const done = reads.results.get(workKey(match));
    if (done) {
      const b = done.body as { ok?: string; outputDigest?: string; outputArtifact?: string; error?: string };
      if (b.ok !== "yes") {
        steps.push({ ...match, state: "failed", resultId: done.id, error: b.error });
        break; // a failed stage has no output, so nothing after it can be planned
      }
      steps.push({ ...match, state: "done", resultId: done.id, outputDigest: b.outputDigest });
      inputDigest = b.outputDigest ?? "";
      // The id the next request names: from the result when a worker stored the artifact itself,
      // else resolved from the digest (the capture stored it before the ack, so it must exist).
      inputArtifact = b.outputArtifact ?? reads.artifacts.get(inputDigest) ?? "";
      if (!inputArtifact) throw new Error(`no artifact carries digest ${inputDigest} (${dataset.name}/${stage}); cannot chain`);
      continue;
    }
    // Not done. Is it already asked for? Content-keyed, so asking twice is one record.
    const key = `stage:${dataset.name}:${stage}:${inputDigest}:${workspace}`;
    const asked = reads.requests.get(workKey(match));
    if (asked) {
      steps.push({ ...match, state: "requested", requested: asked.id });
    } else if (opts.apply) {
      const req = await c.put({
        kind: "stage_request",
        // `tier` is what the promotion pin matches alongside `workspace`: a request outside the
        // pinned tier is one no pinned agent may claim.
        body: { ...match, tier: PIPELINE_TIER, inputArtifact, owner: dataset.owner },
        // The INPUT is the parent, so lineage reads as the pipeline it is: dataset → clean →
        // features → report, and `radia children <dataset>` walks the whole run.
        parentIds: [inputArtifact],
      }, key);
      // Into the pass's own view, so a second dataset sharing this exact work does not ask again.
      reads.requests.set(workKey(match), req as unknown as RadiaRecord);
      steps.push({ ...match, state: "requested", requested: req.id });
    } else {
      steps.push({ ...match, state: "asked" });
    }
    // STOP. The next stage's input is this stage's output, which does not exist yet. The planner
    // runs again when the result lands.
    break;
  }
  return steps;
}

/**
 * Every dataset this caller can see, newest first.
 *
 * BOUNDED, and this is the honest limit of the planner: a space holding more than `limit` datasets
 * plans only the newest ones, so an older one that becomes stale (its stage's code changed) never
 * advances. The bound keeps a pass flat; removing it would make every pass cost the whole space.
 * The real fix is not a bigger number, it is planning INCREMENTALLY from the `Wakeup` that says
 * which record changed, which this example does not do.
 */
export async function datasets(c: RadiaClient, limit = 50): Promise<
  { id: string; name: string; digest: string; artifactId: string; owner: string; createdAt: string }[]
> {
  const rows = await c.query({ kind: "dataset" }, limit, { dir: "desc" });
  return rows.map((r) => {
    const b = r.body as { name: string; digest: string; artifactId: string; owner: string };
    return { id: r.id, ...b, createdAt: r.runtimeMeta.createdAt };
  });
}

/** Plan every dataset once. Returns what it did, so a caller can log or render it.
 *
 *  Cost is FLAT in the number of datasets: four reads for the pass (the datasets, the code
 *  registry, the results, the requests) plus one write per stage actually dispatched. */
export async function planAll(c: RadiaClient, opts: { apply?: boolean } = {}): Promise<PlanStep[]> {
  const sets = await datasets(c);
  const reads = await readPass(c, sets.map((d) => d.name));
  const out: PlanStep[] = [];
  for (const d of sets) out.push(...await planDataset(c, d, reads, opts));
  return out;
}

if (import.meta.main) {
  const arg = (n: string) => {
    const i = Deno.args.indexOf(n);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const client = new RadiaClient(arg("--url") ?? "http://127.0.0.1:7788", {
    ...(arg("--token") ? { definitionToken: arg("--token")! } : {}),
  });
  const stop = new AbortController();
  Deno.addSignalListener("SIGTERM", () => stop.abort());
  console.error(`[plan] watching for datasets and results`);
  // A REACTOR, not a bare watch loop (plan-reactor-loop.md): the naive `for await` here died on
  // the run ceiling (`credential_invalid` throws out of the generator) and silently missed
  // records written while the SDK's watch re-created itself after a space restart. reactorLoop
  // owns that supervision; the tick is what heals the invisible gaps. BOTH kinds, because both
  // make new work plannable: a dataset starts a pipeline, and a result is the next stage's input.
  await reactorLoop(client, {
    name: "plan",
    patterns: [{ kind: "dataset" }, { kind: "stage_result" }],
    pollMs: 15_000,
    signal: stop.signal,
    log: (m) => console.error(m),
    reconcile: async () => {
      for (const s of await planAll(client, { apply: true })) {
        if (s.state === "requested" && s.requested) console.error(`[plan] ${s.dataset}/${s.stage} -> ${s.requested}`);
        if (s.state === "blocked") console.error(`[plan] ${s.dataset}/${s.stage}: no binding names this stage's code`);
      }
    },
  });
}
