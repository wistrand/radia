// Inspection: the derived reads that answer "what is this space doing", "why is this record
// stuck", and "what happened around this one".
//
// None of it is state. Every function here is a COMPOSITION of reads the space already has, which
// is what `agent_docs/design-inspection.md` argues an inspection feature must be: a content-routed
// substrate has no workflow to render, so the picture is recovered rather than read, and the moment
// it becomes its own bookkeeping it can disagree with the space it describes.
//
// The port below is wide, unlike `flows.ts` or `artifacts.ts`, and that is the honest shape: these
// are compositions, so their dependency IS most of the read surface. It earns its place anyway,
// because every member is a READ. A module that cannot reach `put` cannot grow a cache, a
// projection, or an opinion, which is the failure mode this doc warns about.
//
// Extracted from `space.ts` unchanged.

import type { Envelope, KindStateCount, RadiaRecord, StatsScope } from "../storage/adapter.ts";
import { isClaimable, type KindDef } from "./kinds.ts";
import type { Pattern } from "./matching.ts";
import type { IntegrityReport } from "./seal.ts";
import { RESERVED_KINDS } from "./kinds.ts";

/** How many children of ONE record a graph walk follows. The walk's node cap bounds the picture;
 *  this bounds the reading, so a record with a huge fan-out cannot dominate a single step. */
export const GRAPH_FANOUT = 200;

/** A registered interest whose run is still able to claim. */
export interface LiveInterest {
  run: string;
  agent?: string;
  match?: Record<string, unknown>;
}

/**
 * Why unclaimed work is unclaimed, which age alone cannot say.
 *
 * ORPHANED and STARVING call for opposite actions. Nothing is listening for an orphan, so waiting
 * never helps and the fix is to start a worker or fix a pattern; a starving record has a listener
 * that is not claiming, so the worker is down, wedged, or barred, and the fix is over there. The
 * old report called both "stale available" and left an operator to guess.
 */
export interface StaleSplit {
  /** No live interest matches. See `caveat`: this is evidence, not proof. */
  orphaned: { count: number; sample: unknown[] };
  /** A live interest matches and nothing has claimed it anyway. */
  starving: { count: number; sample: unknown[] };
  /** False when an interest registry read was truncated, so `orphaned` may be overstated. */
  complete: boolean;
  /** Always present, because both counts rest on the interest registry being a faithful picture of
   *  who is listening, and it is only ever best-effort. */
  caveat: string;
}

export interface Diagnostics {
  now: string;
  counts: Record<string, number>;
  deadLetter: { count: number; sample: unknown[] };
  stuckLeases: { count: number; atLeast: boolean; sampledFrom: number; sample: unknown[] };
  /** Unclaimed *claimable* (work) records older than the threshold: a starvation signal.
   *  Reference kinds (`claimable:false`: facts, config, grants, history) are excluded: they sit
   *  available forever by design and are not stale. */
  staleAvailable: {
    count: number;
    thresholdSeconds: number;
    sample: unknown[];
    /** The two failures age alone cannot tell apart. ABSENT when the space publishes no live
     *  interests at all: with an empty registry every record looks orphaned, and that is a fact
     *  about the fleet's instrumentation rather than about the work. */
    split?: StaleSplit;
  };
  /** Erasures that no longer hold: the bytes are back at the same content address. ABSENT for a
   *  scoped caller rather than zero, because a confident `0` about something the caller cannot see
   *  is the "empty scoped answer reads as empty space" failure this file already guards elsewhere. */
  undoneErasures?: { count: number; checked: number; complete: boolean; sample: unknown[] };
  /** The event chain's verdict. ABSENT for a scoped caller, like `undoneErasures` and for the same
   *  reason: the chain covers everyone's activity, so a scoped `ok:true` would be reassurance
   *  about records the caller cannot see. */
  integrity?: IntegrityReport;
}

/** What the digest reports about a space. Generated from records, never hand-written. */
export interface SpaceDigest {
  api: string;
  kinds: { kind: string; indexedPaths: string[]; sortablePaths?: string[]; claimable: boolean; reserved: boolean }[];
  counts: { kind: string; state: string; count: number }[];
  /** The routing topology as an EDGE LIST, one row per (kind, agent), not one per pattern. A
   *  worker that serves twenty tools publishes twenty interests; listing them all buries the
   *  shape this read exists to show. `patterns` counts them, and `POST /v0/ops/dry-run` answers
   *  which one a given record would reach. */
  interests: { kind: string; agent: string; runs: number; patterns: number }[];
  /** Interests hidden by the caller's scope. An empty list means "none you may see", never
   *  "nobody is listening", and the difference has to be stated or it gets reported as fact. */
  interestsWithheld?: number;
  permissions: unknown;
  complete: boolean;
}

/**
 * The reads inspection composes, and nothing else.
 *
 * Every member is a read on purpose: see the file header. `Space` satisfies this structurally, so
 * the wiring is one object literal there rather than a second implementation here.
 */
export interface InspectionHost {
  listKinds(): KindDef[];
  kindDef(kind: string): KindDef | undefined;
  /** The DATABASE clock, never the process one. */
  now(): Promise<string>;
  stats(scope?: StatsScope): Promise<KindStateCount[]>;
  /** `SpaceContext.diagnosticsStaleSeconds`: how long available work may sit before it is stale. */
  staleSeconds: number;
  queryEnvelopes(opts: {
    state?: string;
    kind?: string;
    expired?: boolean;
    staleSeconds?: number;
    excludeKinds?: string[];
    limit?: number;
    scope?: StatsScope;
  }): Promise<{ record: RadiaRecord | null; envelope: Envelope }[]>;
  /** Interests whose run can still claim, per kind, read to exhaustion. */
  liveInterests(kind: string): Promise<{ interests: LiveInterest[]; complete: boolean; published: number }>;
  interestMatches(i: LiveInterest, kind: string, body: unknown): boolean;
  matchingInterests(kind: string): Promise<{ interests: LiveInterest[]; complete: boolean }>;
  effectivePermissions(principal: string): Promise<unknown>;
  erasures(opts: { onlyUndone?: boolean }): Promise<{ erasures: unknown[]; checked: number; complete: boolean }>;
  verifyIntegrity(): Promise<IntegrityReport>;
  getLineage(recordId: string, max: number, createdBy?: string[]): Promise<{ record: RadiaRecord; depth: number }[]>;
  getChildren(recordId: string, limit: number): Promise<RadiaRecord[]>;
  authorAllows(createdBy: string[] | undefined, record: { runtimeMeta: { createdBy: string } }): boolean;
}

/**
 * Notes about a query the caller cannot see from its own result.
 *
 * Every note here answers a documented trap that a correct-looking query walks into silently:
 * a full page read as a population, a default order that returns the OLDEST rows, a reference
 * kind whose records sit available forever by design, a kind nobody has declared. These are all
 * cases where the request SUCCEEDED, so an error cannot carry the warning and prose in a doc
 * arrives too late. Attach it to the answer instead.
 *
 * Never make this change the result. It annotates, so a caller that ignores it is exactly as
 * correct as before.
 */
export function explainQuery(
  h: InspectionHost,
  pattern: Pattern,
  returned: number,
  limit: number,
  page?: { after?: string; dir?: "asc" | "desc" },
): string[] {
  const notes: string[] = [];
  const def = h.kindDef(pattern.kind);
  if (!def) {
    notes.push(
      `no kind '${pattern.kind}' is declared, so this can only ever return nothing. Declared: ` +
        `${h.listKinds().map((k) => k.kind).sort().join(", ") || "(none)"}.`,
    );
  }
  if (returned >= limit) {
    notes.push(
      `results filled the limit (${limit}), so this is a PAGE and not a population. Page on with ` +
        `'after' set to the last id; never treat a full page as the total.`,
    );
  }
  if (!pattern.orderBy && !page?.dir) {
    notes.push(
      "no orderBy and no dir, so records come back OLDEST first (ascending by id). A registry " +
        "read wants dir='desc', or the newest declaration falls off the end.",
    );
  }
  if (def && def.claimable === false) {
    notes.push(
      `kind '${pattern.kind}' is claimable:false (reference data), so records sitting 'available' ` +
        "forever is normal rather than stuck work.",
    );
  }
  if (def && pattern.match) {
    const declared = new Set(def.indexedPaths.map((p) => p.path));
    const unindexed = Object.keys(pattern.match).filter((k) => !k.startsWith("$") && !declared.has(k));
    if (unindexed.length > 0) {
      notes.push(
        `match names ${unindexed.join(", ")}, which ${unindexed.length === 1 ? "is" : "are"} not a ` +
          `declared indexed path of '${pattern.kind}' (declared: ${[...declared].sort().join(", ") || "(none)"}).`,
      );
    }
  }
  return notes;
}

/**
 * What a space contains, in one read: the orientation an investigator needs before asking
 * anything else.
 *
 * Generated from records, never hand-written, so it cannot drift from the space it describes.
 * This is the artifact an inspection agent trusts most, which makes it the worst possible place
 * to return a plausible prefix: every registry read here pages to exhaustion and the result says
 * `complete: false` rather than quietly truncating.
 */
export async function digest(
  h: InspectionHost,
  principal: string,
  scope?: { createdBy?: string[] } | null,
): Promise<SpaceDigest> {
  const reserved = new Set(RESERVED_KINDS);
  const kinds = h.listKinds()
    .map((d) => ({
      kind: d.kind,
      indexedPaths: d.indexedPaths.map((p) => p.path),
      ...(d.sortablePaths ? { sortablePaths: d.sortablePaths } : {}),
      claimable: d.claimable !== false,
      reserved: reserved.has(d.kind),
    }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));

  // The prospective half of the topology. Reported per kind so "who is listening for X" is
  // answerable without a second call; liveness is still the run's, as everywhere else.
  const edges = new Map<string, { kind: string; agent: string; runs: Set<string>; patterns: number }>();
  let complete = true;
  let withheld = 0;
  for (const k of kinds) {
    const found = await h.matchingInterests(k.kind); // listing mode: no candidate body
    if (!found.complete) complete = false;
    for (const i of found.interests) {
      // Interests are the one cross-principal part of the digest: the full set IS the routing
      // table, which `POST /v0/ops/dry-run` keeps operator-only. A scoped caller sees its own,
      // matching the rule that any principal may read its own authorization and no one else's.
      if (scope?.createdBy && !scope.createdBy.includes(i.run)) {
        withheld++;
        continue;
      }
      const agent = i.agent ?? i.run;
      const key = `${k.kind}|${agent}`;
      const edge = edges.get(key) ?? { kind: k.kind, agent, runs: new Set<string>(), patterns: 0 };
      edge.runs.add(i.run);
      edge.patterns++;
      edges.set(key, edge);
    }
  }
  return {
    api: "v0",
    kinds,
    counts: await h.stats(),
    interests: [...edges.values()]
      .map((e) => ({ kind: e.kind, agent: e.agent, runs: e.runs.size, patterns: e.patterns }))
      .sort((a, b) => (a.kind === b.kind ? (a.agent < b.agent ? -1 : 1) : a.kind < b.kind ? -1 : 1)),
    ...(withheld > 0 ? { interestsWithheld: withheld } : {}),
    permissions: await h.effectivePermissions(principal),
    complete,
  };
}

/**
 * The whole causal story around one record, in the order it happened.
 *
 * Reconstructing this by hand means walking `parent_ids` up to a root, then children down, then
 * sorting, and getting the paging right at every step. Models get it wrong in a specific way:
 * they walk one direction, treat a bounded page as the whole fan-out, and report a partial story
 * with the same confidence as a complete one. It is a composition of reads the ops plane already
 * has, which is exactly what that plane is for.
 *
 * Ordered by id, which is creation order (ULIDs are monotonic), so the sequence IS the causality
 * for anything written in one process.
 */
export async function thread(
  h: InspectionHost,
  recordId: string,
  opts: { maxNodes?: number; createdBy?: string[] } = {},
): Promise<{ root: string; records: RadiaRecord[]; truncated: boolean }> {
  const max = opts.maxNodes ?? 200;
  const lineage = await h.getLineage(recordId, max, opts.createdBy);
  if (lineage.length === 0) return { root: recordId, records: [], truncated: false };
  // The deepest ancestor reachable is the root of the story. Ties break on id so the answer is
  // deterministic when a record has several roots at the same depth.
  const deepest = Math.max(...lineage.map((l) => l.depth));
  const root = lineage.filter((l) => l.depth === deepest).map((l) => l.record.id).sort()[0];

  const seen = new Map<string, RadiaRecord>();
  for (const l of lineage) seen.set(l.record.id, l.record);
  let truncated = false;
  // Traversal is tracked SEPARATELY from the result set. The ancestors are already in `seen`
  // from the lineage walk, so skipping anything seen would stop the walk at the record asked
  // about and silently drop everything below it.
  const walked = new Set<string>();
  const queue = [root];
  while (queue.length > 0 && seen.size < max) {
    const id = queue.shift()!;
    if (walked.has(id)) continue;
    walked.add(id);
    const children = await h.getChildren(id, GRAPH_FANOUT);
    if (children.length >= GRAPH_FANOUT) truncated = true;
    for (const c of children) {
      if (!h.authorAllows(opts.createdBy, c)) continue;
      if (!seen.has(c.id)) seen.set(c.id, c);
      if (!walked.has(c.id)) queue.push(c.id);
    }
  }
  if (queue.length > 0) truncated = true;
  const records = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { root, records, truncated };
}

/** A derived health report, composed from queryEnvelopes + stats: counts by state,
 *  dead-letters, expired-but-stuck leases, and available records that have sat unclaimed. */
export async function diagnostics(h: InspectionHost, scope?: StatsScope): Promise<Diagnostics> {
  const now = await h.now();
  // Every component below carries the scope, so a scoped report is computed over that subset
  // rather than assembled from the whole space and trimmed. A count filtered after the fact is
  // the dangerous failure here: it is invisible in the output, it just looks plausible.
  const stats = await h.stats(scope);
  const total = (state: string) => stats.filter((s) => s.state === state).reduce((a, s) => a + s.count, 0);
  const SAMPLE = 500;
  const STALE_S = h.staleSeconds;
  // Starvation is only meaningful for CLAIMABLE (work) kinds: reference records (facts, config,
  // grants, kind_defs, history) sit `available` forever by design and are not stale, so exclude them
  // (filtered in the query, before the sample cap, so real stale work is never crowded out).
  const referenceKinds = h.listKinds().filter((d) => !isClaimable(d)).map((d) => d.kind);

  const deadLetter = await h.queryEnvelopes({ state: "dead_letter", limit: 50, scope });
  const stuck = await h.queryEnvelopes({ state: "leased", expired: true, limit: SAMPLE, scope });
  const stale = await h.queryEnvelopes({
    state: "available",
    staleSeconds: STALE_S,
    limit: SAMPLE,
    excludeKinds: referenceKinds,
    scope,
  });
  const env = (r: { envelope: Envelope }) => r.envelope;

  // OMITTED for a scoped caller, not zeroed. Shred records are operator-visible, so a session
  // would get a confident `0` about something it cannot see — the same trap `describeScope` exists
  // for, and worse here, because "no erasure was undone" is exactly the reassurance nobody should
  // receive on no evidence.
  const split = await splitStale(h, stale);
  const erasures = scope ? null : await h.erasures({ onlyUndone: true });
  const undone = erasures
    ? {
      count: erasures.erasures.length,
      checked: erasures.checked,
      complete: erasures.complete,
      sample: erasures.erasures.slice(0, 10),
    }
    : undefined;

  return {
    now,
    // No `expired` count: expiry is IMPLICIT. A lease that lapses leaves the record in state
    // `leased` (a later take reclaims it, bumping the attempt), so nothing ever writes the
    // `expired` state and reporting it would always be a confident zero next to hundreds of
    // demonstrably lapsed leases. The real number is `stuckLeases` below.
    counts: {
      available: total("available"),
      leased: total("leased"),
      consumed: total("consumed"),
      dead_letter: total("dead_letter"),
    },
    deadLetter: {
      count: total("dead_letter"),
      sample: deadLetter.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, attempt: env(r).attempt })),
    },
    stuckLeases: {
      count: stuck.length,
      // The scan is capped, so a full page means "at least this many". Otherwise a reader (or a
      // model) reports a cap as if it were a census.
      atLeast: stuck.length >= SAMPLE,
      sampledFrom: Math.min(total("leased"), SAMPLE),
      sample: stuck.slice(0, 10).map((r) => ({
        recordId: env(r).recordId,
        kind: env(r).kind,
        leaseId: env(r).leaseId,
        leasedUntil: env(r).leasedUntil,
        attempt: env(r).attempt,
      })),
    },
    staleAvailable: {
      count: stale.length,
      thresholdSeconds: STALE_S,
      sample: stale.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, availableAt: env(r).availableAt })),
      ...(split ? { split } : {}),
    },
    // In the health report because a reversed erasure is the most consequential thing this can
    // find, and nothing else was ever going to surface it.
    ...(undone ? { undoneErasures: undone } : {}),
    // Same reasoning: a broken chain is not something anyone thinks to ask about until it
    // matters, and a health report that omits it says the space is fine when it cannot know.
    // Operator-only, because the chain covers every principal's activity.
    ...(scope ? {} : { integrity: await h.verifyIntegrity() }),
  };
}

/**
 * Split unclaimed work into "nobody is listening" and "somebody is listening and not claiming".
 *
 * The interest registry is read ONCE PER KIND, not once per record: the registry read pages to
 * exhaustion and the pattern test is a function call, so doing it the other way round turns a
 * hundred stale records into a hundred full registry scans.
 *
 * Returns undefined when the space holds no live interests at all. Every record would classify as
 * orphaned, and that answer describes the fleet's instrumentation rather than its work: publishing
 * an interest is best-effort in `agentLoop` (a worker without the grant is invisible), so an empty
 * registry means "nobody said" and not "nobody is listening".
 */
async function splitStale(
  h: InspectionHost,
  rows: { record: RadiaRecord | null; envelope: Envelope }[],
): Promise<StaleSplit | undefined> {
  if (rows.length === 0) return undefined;
  const byKind = new Map<string, { interests: LiveInterest[]; complete: boolean; published: number }>();
  for (const kind of new Set(rows.map((r) => r.envelope.kind))) {
    byKind.set(kind, await h.liveInterests(kind));
  }
  // Nothing DECLARED, so there is nothing to reason from. A fleet whose interests are all dead is
  // a different matter and does get split: everything comes back orphaned, which is the true
  // answer and an actionable one.
  if ([...byKind.values()].every((v) => v.published === 0)) return undefined;

  const orphaned: unknown[] = [];
  const starving: unknown[] = [];
  let complete = true;
  for (const row of rows) {
    const kind = row.envelope.kind;
    const live = byKind.get(kind)!;
    if (!live.complete) complete = false;
    // A record whose body could not be read is counted as STARVING, the conservative side: it
    // claims no fleet is missing, so it cannot send anyone chasing a worker that exists.
    const listeners = row.record
      ? live.interests.filter((i) => h.interestMatches(i, kind, row.record!.body))
      : live.interests;
    const entry = { recordId: row.envelope.recordId, kind, availableAt: row.envelope.availableAt };
    if (listeners.length === 0) orphaned.push(entry);
    else starving.push({ ...entry, listeners: listeners.length, agents: [...new Set(listeners.map((l) => l.agent ?? l.run))] });
  }
  return {
    orphaned: { count: orphaned.length, sample: orphaned.slice(0, 10) },
    starving: { count: starving.length, sample: starving.slice(0, 10) },
    complete,
    caveat: "an interest is a worker's own declaration and publishing one is best-effort, so " +
      "'orphaned' means no live interest MATCHES, not that nothing is listening. A worker without " +
      "the grant to publish, or one that never did, is invisible here.",
  };
}
