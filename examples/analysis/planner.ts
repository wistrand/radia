// The staleness planner: the one piece the substrate does not hand you.
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
import type { RadiaRecord } from "../../sdk/ts/wire.ts";
import { STAGES, type StageName } from "./kinds.ts";

export interface PlanStep {
  dataset: string;
  stage: StageName;
  inputDigest: string;
  codeDigest: string;
  /** Absent while the stage is still to be asked for; set once a request exists. */
  requested?: string;
  state: "done" | "requested" | "asked" | "blocked" | "failed";
  resultId?: string;
  outputDigest?: string;
  error?: string;
}

/** What code each stage is currently serving, from the workers' own advertisements. */
export async function liveCode(c: RadiaClient): Promise<Map<string, string>> {
  const view = await readRegistry<{ stage: string; codeDigest: string; retired?: boolean }>(
    (limit, after) => c.query({ kind: "stage_code" }, limit, { after }),
    (b) => b.stage,
  );
  // `entries` is already latest-wins with tombstones dropped, so a retired worker's advertisement
  // is gone and the newest per stage is what remains.
  if (!view.complete) throw new Error("could not read the stage_code registry completely");
  const out = new Map<string, string>();
  for (const rec of view.entries.values()) {
    const b = rec.body as { stage: string; codeDigest: string };
    out.set(b.stage, b.codeDigest);
  }
  return out;
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
  code: Map<string, string>;
  results: Map<string, RadiaRecord>;
  requests: Map<string, RadiaRecord>;
}

/** The logical identity of one unit of work: which dataset, which stage, on what input, under
 *  which code. The same four fields the records are indexed on, so a map lookup answers exactly
 *  what the per-stage query used to. */
const workKey = (b: { dataset?: string; stage?: string; inputDigest?: string; codeDigest?: string }) =>
  `${b.dataset}|${b.stage}|${b.inputDigest}|${b.codeDigest}`;

async function readPass(c: RadiaClient, names: string[]): Promise<PassReads> {
  const code = await liveCode(c);
  if (names.length === 0) return { code, results: new Map(), requests: new Map() };
  const bulk = async (kind: string) => {
    const view = await readRegistry<Record<string, unknown>>(
      (limit, after) => c.query({ kind, match: { dataset: { $in: names } } }, limit, { dir: "desc", after }),
      (b) => workKey(b as { dataset?: string }),
    );
    if (!view.complete) throw new Error(`could not read every ${kind} for this pass; refusing to plan on a prefix`);
    return view.newest; // newest per work key, retirements included: nothing here retires
  };
  return { code, results: await bulk("stage_result"), requests: await bulk("stage_request") };
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

  for (const stage of STAGES) {
    const codeDigest = reads.code.get(stage);
    if (!codeDigest) {
      // No worker has advertised this stage. Reported rather than requested: a request naming no
      // live code would sit unclaimed and look like a slow stage rather than a missing one.
      steps.push({ dataset: dataset.name, stage, inputDigest, codeDigest: "", state: "blocked" });
      break;
    }
    const match = { dataset: dataset.name, stage, inputDigest, codeDigest };
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
      inputArtifact = b.outputArtifact ?? "";
      continue;
    }
    // Not done. Is it already asked for? Content-keyed, so asking twice is one record.
    const key = `stage:${dataset.name}:${stage}:${inputDigest}:${codeDigest}`;
    const asked = reads.requests.get(workKey(match));
    if (asked) {
      steps.push({ ...match, state: "requested", requested: asked.id });
    } else if (opts.apply) {
      const req = await c.put({
        kind: "stage_request",
        body: { ...match, inputArtifact, owner: dataset.owner },
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
  // WATCH, not a timer. A result landing is what makes the next stage plannable, so the planner
  // wakes on the record that changed rather than polling a clock. The first pass runs before the
  // watch: anything that landed while this was down would otherwise wait for the next write.
  const pass = async () => {
    try {
      for (const s of await planAll(client, { apply: true })) {
        if (s.state === "requested" && s.requested) console.error(`[plan] ${s.dataset}/${s.stage} -> ${s.requested}`);
        if (s.state === "blocked") console.error(`[plan] ${s.dataset}/${s.stage}: no worker advertises this stage`);
      }
    } catch (e) {
      console.error(`[plan] ${e instanceof Error ? e.message : e}`);
    }
  };
  await pass();
  console.error(`[plan] watching for datasets and results`);
  // BOTH kinds, because both make new work plannable: a dataset starts a pipeline, and a result is
  // the next stage's input. Watching only results meant an upload sat still until something else
  // happened to write one.
  await Promise.all([
    (async () => {
      for await (const _ of client.watch({ kind: "dataset" }, stop.signal)) await pass();
    })(),
    (async () => {
      for await (const _ of client.watch({ kind: "stage_result" }, stop.signal)) await pass();
    })(),
  ]);
}
