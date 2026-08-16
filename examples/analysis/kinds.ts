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

/** The stages, in order. The planner walks this list; a worker serves one entry. */
export const STAGES = ["clean", "features", "report"] as const;
export type StageName = typeof STAGES[number];

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

  // What CODE a stage worker is running, advertised by the worker itself. A registry: latest wins
  // per stage, so restarting a worker writes nothing and deploying a new one is a successor.
  //
  // The planner reads this rather than holding a version table. That is the same rule the chat's
  // model tiers follow: a worker advertises what it serves, and nothing hardcodes it.
  await client.registerKind({
    kind: "stage_code",
    indexedPaths: [{ path: "stage", type: "keyword" }, { path: "codeDigest", type: "keyword" }],
    claimable: false,
  });

  // The unit of work. CLAIMABLE, so a worker takes it under a lease and at-least-once delivery
  // applies. Every field the planner matches on is indexed, which is what makes the existence
  // check a query rather than a scan.
  await client.registerKind({
    kind: "stage_request",
    indexedPaths: [
      { path: "stage", type: "keyword" },
      { path: "dataset", type: "keyword" },
      { path: "inputDigest", type: "keyword" },
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
  await client.registerKind({
    kind: "stage_result",
    indexedPaths: [
      { path: "stage", type: "keyword" },
      { path: "dataset", type: "keyword" },
      { path: "inputDigest", type: "keyword" },
      { path: "codeDigest", type: "keyword" },
      { path: "outputDigest", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "ok", type: "keyword" },
    ],
    claimable: false,
  });
}
