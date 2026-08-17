// The record kinds for a staged analysis pipeline.
//
// The whole design is in what is INDEXED. A stage's work is identified by (dataset, stage, the
// digest of its input, the digest of the code that will run) — so "has this already been computed"
// is one pattern query, and "the analysis changed" is a DIFFERENT record rather than a re-run of
// the same one. Nothing here needs a replay mechanism, because nothing is ever replayed: a changed
// digest is new work, and unchanged work is found and skipped.
//
// An undeclared path is invisible to matching, so every field the planner keys on is declared. That
// is not a detail: without `codeDigest` indexed, "did this version already run" degrades into
// fetching pages and comparing by hand, which is the failure this example exists to avoid.

import type { RadiaClient } from "../../sdk/ts/client.ts";

/** The stages this repo SHIPS, in order. Only deployment iterates this (publish the trees, write
 *  the defs, mint the agents): the pipeline's live shape is the `stage_def` REGISTRY, which the
 *  planner and the UI read, so a new stage is a deployment (def + promote + bind) and never an
 *  edit here. */
export const STAGES = ["clean", "features", "report"] as const;
export type StageName = typeof STAGES[number];

/** The tier every request is stamped with, and the one promotion pins. One tier, because this
 *  example deploys one environment; the vocabulary allows more. */
export const PIPELINE_TIER = "prod";

export async function registerAnalysisKinds(client: RadiaClient): Promise<void> {
  // Bytes live in artifacts, never in bodies (the erasure boundary, CLAUDE.md). A dataset record
  // NAMES its payload; `digest` is the content address, and it is what the first stage keys on.
  await client.registerKind({
    kind: "dataset",
    indexedPaths: [
      { path: "name", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "digest", type: "keyword" },
    ],
    claimable: false,
  });

  // REDECLARING a reserved kind, on purpose, exactly as the chat does. `artifact` is defined in
  // code with {digest, mediaType} indexed and nothing an app can scope on, so any principal holding
  // an artifact id could read it. Adding `owner` is what lets a grant bind a person's uploads and
  // the outputs computed from them. A redeclaration REPLACES rather than merges, so the runtime's
  // own paths are repeated here; omitting one is refused with `reserved_kind`.
  await client.registerKind({
    kind: "artifact",
    indexedPaths: [
      { path: "digest", type: "keyword" },
      { path: "mediaType", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "dataset", type: "keyword" },
    ],
    claimable: false,
  });

  // The stage code itself: each stage is an entrypoint tree (stages/<name>/), published at
  // bootstrap as a workspace named `stage-<name>`. Declared here because `workspace` is an
  // EXTENSION convention, not a reserved kind: the runtime has no idea what a file is, so any
  // space that stores trees declares this itself (architecture-analysis-workspace-agents.md step 2).
  await client.registerKind({
    kind: "workspace",
    indexedPaths: [
      { path: "name", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "treeDigest", type: "keyword" },
      { path: "basedOn", type: "keyword" },
    ],
    claimable: false,
  });

  // There is deliberately no `stage_code` kind. Which code is live is read from the BINDINGS
  // (the same records the host runs, `liveCode` in planner.ts) and enforced by the promotion
  // pins; a separate self-advertisement was a second mechanism that nothing verified and that
  // could disagree with both.

  // The pipeline's SHAPE: one def per stage, a latest-wins registry ordered by `index` (gaps left
  // for insertion), retire to remove. The planner walks THIS, not a constant, which is what lets
  // a workspace authored anywhere (the chat's save_procedure yields the right shape) become a new
  // stage by deployment alone.
  await client.registerKind({
    kind: "stage_def",
    indexedPaths: [{ path: "stage", type: "keyword" }],
    claimable: false,
  });

  // The unit of work. CLAIMABLE, so a worker takes it under a lease and at-least-once delivery
  // applies. Every field the planner matches on is indexed, which is what makes the existence
  // check a query rather than a scan.
  //
  // `workspace` + `tier` are the PIN vocabulary: promotion's grant pattern is hardcoded to those
  // two paths (extensions/ts/promotion.ts), so indexing them is what lets a grant bind "this agent
  // may only claim requests naming the promoted tree". `codeDigest` stays declared so records
  // written before the rename remain matchable; new records carry `workspace`.
  await client.registerKind({
    kind: "stage_request",
    indexedPaths: [
      { path: "stage", type: "keyword" },
      { path: "dataset", type: "keyword" },
      { path: "inputDigest", type: "keyword" },
      { path: "workspace", type: "keyword" },
      { path: "tier", type: "keyword" },
      { path: "codeDigest", type: "keyword" },
      { path: "owner", type: "keyword" },
    ],
    claimable: true,
  });

  // The answer, and the memo. A result for (dataset, stage, inputDigest, codeDigest) means that
  // exact computation has been done; the planner looks for one before asking for work.
  //
  // Dedupe is by THIS QUERY, never by idempotency key: content-keyed idempotency expires with
  // `idempotencyRetentionSeconds` (7 days), after which a re-put is a fresh record and the stage
  // recomputes silently. A memo that quietly stops memoizing is worse than none.
  // `workspace` + `tier` indexed here are the RESULT-side pin: granting `stage_result: put` with
  // promotion's pattern `{workspace: <digest>, tier}` makes `bodyMatchesGrant` refuse a result
  // that lies about which code produced it, which self-reporting never could.
  await client.registerKind({
    kind: "stage_result",
    indexedPaths: [
      { path: "stage", type: "keyword" },
      { path: "dataset", type: "keyword" },
      { path: "inputDigest", type: "keyword" },
      { path: "workspace", type: "keyword" },
      { path: "tier", type: "keyword" },
      { path: "codeDigest", type: "keyword" },
      { path: "outputDigest", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "ok", type: "keyword" },
    ],
    claimable: false,
  });
}
