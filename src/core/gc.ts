// Registry compaction: deleting SUPERSEDED entries of latest-wins registries
// (agent_docs/plan-gc.md, phase 2).
//
// The measured motive: on a live chat space, registry successors were 52% of all records —
// `agent_run` at 6.8 records per run (renewals and stops), `capability` at 38 records per tool
// (every session retires ~40 on the way out and republishes them on the way in). "Withdrawal is a
// successor record" is the design principle that manufactures this growth; compaction is its
// missing other half. The PROJECTION is what a registry means, and every record strictly older
// than the newest per content key contributes nothing to it.
//
// THE FAILURE MODE IS RESURRECTION, and it is why keep-newest is the entire correctness condition:
// the newest entry per key must survive even when it is a `retired: true` tombstone. Delete a
// retire-marker while an older live entry survives and the withdrawal silently un-happens — for a
// capability that is a ghost tool, for anything authorization-adjacent it is worse. So the
// compactor never chooses what to keep: it walks NEWEST-FIRST and deletes only what it has already
// seen a newer same-key record for. That order makes a partial walk safe too: whatever page the
// walk stops on, everything deleted had a newer survivor by construction.
//
// Never compacted: `grant`, `kind_def`, `signal`, `agent_definition`. "The audit trail survives
// revocation" is a documented property of grants, and the others are small, security-load-bearing,
// or both. The exclusion is enforced HERE, not left to who declares a `contentKey`: a kind_def
// redeclaration must not be able to opt the grant registry into deletion.
//
// Extracted from `space.ts`-style code into its own module per the flows/artifacts/inspection
// pattern, except this port deliberately holds the one destructive member (`sweepIds`), and the
// adapters re-check the lease floor under it whatever this logic decides.

import type { KindDef } from "./kinds.ts";
import { AGENT_DEFINITION, AGENT_RUN, ARTIFACT, GRANT, INTEREST, isClaimable, KIND_DEF, OIDC_IDENTITY, OPS_GRANT, RESERVED_KINDS, SHRED, SIGNAL } from "./kinds.ts";
import { getPath } from "./matching.ts";
import type { Page, RadiaRecord, StorageAdapter, SweptIds } from "../storage/adapter.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { Pattern } from "./matching.ts";
import { newer } from "./registry.ts";

/** Reserved kinds compaction knows how to key IN CODE. Everything else reserved is excluded.
 *  A runtime key also NEUTRALIZES a hostile redeclaration: `RUNTIME_KEYS[kind] ?? contentKey`
 *  means a `put: kind_def` grant cannot re-key one of these registries into compaction under an
 *  arbitrary key (the move that keeps `shred`/`interest`… out of this table entirely). */
export const RUNTIME_KEYS: Record<string, string[]> = {
  // A run's records (mint, renewals at half-life, the stop) all carry the same `run`; the newest
  // holds the live tokenHash/expiry/status, which is exactly what credential resolution reads.
  [AGENT_RUN]: ["run"],
  // An identity's records (enrollment, display refreshes, renames, retires) all carry the same
  // (iss, sub); the newest is what the mint reads (`view.newest`), tombstone included. Compacting
  // the rest is a PRIVACY property as much as a space one: superseded mappings from before
  // display claims moved into profile artifacts carry names in immutable bodies, and
  // supersede-then-compact is their only deletion path (plan-oidc.md).
  [OIDC_IDENTITY]: ["iss", "sub"],
};

/** Reserved kinds that must never compact, whatever anyone declares. See the header. `ops_grant`
 *  for the same reason as `grant`: the assignment history of an ops power is audit, and deleting
 *  a retire-marker would silently restore a power. `oidc_identity` is NOT here: it compacts
 *  under its RUNTIME key above (newest per (iss, sub) survives, tombstone included, so a ban
 *  stands), and the runtime key is itself what defeats the hostile-contentKey redeclaration
 *  that once argued for listing it. */
const NEVER_COMPACT = new Set([GRANT, KIND_DEF, SIGNAL, AGENT_DEFINITION, OPS_GRANT]);

/** Everything compaction needs from the space. `sweepIds` is the destructive member; the rest are
 *  reads. The adapters keep their own lease floor under `sweepIds`. */
export interface CompactionHost {
  listKinds(): KindDef[];
  /** Newest-first keyset page of a kind (dir desc, after = the previous page's last id). */
  pageDesc(kind: string, limit: number, after?: string): Promise<RadiaRecord[]>;
  sweepIds(ids: string[], runId: string): Promise<SweptIds>;
  /** Is this principal's run still able to act? Non-run principals are always "live". */
  runIsLive(run: string): Promise<boolean>;
}

import type { CompactionResult, EventGcResult, GcReport } from "../../sdk/ts/wire.ts";
import type { BlobGcResult } from "../storage/blobs.ts";
import { addSeconds } from "./time.ts";
import { SEAL_BATCH } from "./seal.ts";
export type { CompactionResult };

const PAGE = 500;
/** Most records one call walks per kind: bounds a pathological registry without a config knob.
 *  Compaction is idempotent, so a capped call plus `more: true` is a smaller next call. */
const MAX_WALK = 20_000;

/**
 * A record's latest-wins identity, from the paths its kind DECLARES.
 *
 * Exported so compaction and the registry read use ONE derivation. The key was otherwise stated
 * twice per registry: once as `contentKey` (what `gc` compacts by) and again as a `keyOf` closure at
 * each reader, and nothing checked they agreed. Disagreement is silent and one-directional in the
 * worst way: `gc` deletes by its key while readers project by theirs, so a record every reader
 * considers current can be swept.
 *
 * AN ABSENT PATH IS A VALUE, not a refusal to classify. Returning null instead was a
 * one-directional bug of exactly the kind this function exists to end: compaction kept such a
 * record while the projection SKIPPED it, so a `capability` advertised without a provider was
 * invisible to every reader that used the declared key, and the tool vanished from the model's list
 * with no error. Absence groups: two records missing the same path are one entry, newest wins, which
 * is what each reader's own `?`-style fallback already did by hand.
 *
 * ABSENT IS NOT NULL. A NUL cannot appear in `JSON.stringify` output (control characters are
 * escaped), so the marker collides with no encodable value, and a body carrying an explicit `null`
 * keys as `"null"` and stays a separate entry. SQL conflates the two and the oracle must not
 * (`test/conformance/suites/pushdown.ts`); neither may this.
 */
const ABSENT = "\u0000";
export function keyOf(rec: RadiaRecord, paths: string[]): string {
  return paths.map((p) => {
    const v = getPath(rec.body, p);
    return v === undefined ? ABSENT : JSON.stringify(v);
  }).join("\u0001");
}

export async function compactRegistries(
  host: CompactionHost,
  /** `only` restricts the walk to one kind. That is what lets the amortized trigger pay for the
   *  kind it just dirtied instead of walking every registry in the space (plan-registry-cost.md
   *  item 3); the `gc` verb passes nothing and walks them all, as before. */
  opts: { dryRun?: boolean; runId: string; only?: string },
): Promise<CompactionResult> {
  const out: CompactionResult = { compacted: 0, superseded: 0, byKind: {}, more: false };
  const record = async (ids: string[], kind: string) => {
    out.superseded += ids.length;
    if (ids.length === 0) return;
    // `byKind` is attributed on the dry run too, from the walk's own knowledge: a dry answer of
    // "2 superseded: (nothing)" names a number and refuses to say of what, which is the kind of
    // report nobody can act on. The live path still counts what was ACTUALLY deleted, since the
    // adapter's lease floor may keep some.
    if (opts.dryRun) {
      out.byKind[kind] = (out.byKind[kind] ?? 0) + ids.length;
      return;
    }
    const r = await host.sweepIds(ids, opts.runId);
    out.compacted += r.swept;
    for (const [k, n] of Object.entries(r.byKind)) out.byKind[k] = (out.byKind[k] ?? 0) + n;
  };

  // --- keyed registries: app kinds that declared a contentKey, plus the runtime's own keys.
  const keyed: { kind: string; paths: string[] }[] = [];
  for (const def of host.listKinds()) {
    if (NEVER_COMPACT.has(def.kind)) continue;
    if (opts.only !== undefined && def.kind !== opts.only) continue;
    const paths = RUNTIME_KEYS[def.kind] ?? def.contentKey;
    if (paths && paths.length > 0) keyed.push({ kind: def.kind, paths });
  }
  for (const { kind, paths } of keyed) {
    // The winner per key, decided by the SAME comparator the projection uses (`newer`), never by
    // the order this loop happens to page in. Paging is id-descending because that is what a keyset
    // cursor can do; ids carry the writing PROCESS's clock, so on two instances they can disagree
    // with `created_at`, and this loop is the one that DELETES. Trusting page order here could drop
    // the record every reader considers current, tombstones included (audit package W3).
    const winner = new Map<string, RadiaRecord>();
    const doomed: string[] = [];
    let after: string | undefined;
    let walked = 0;
    for (;;) {
      const page = await host.pageDesc(kind, PAGE, after);
      for (const rec of page) {
        const key = keyOf(rec, paths);
        const held = winner.get(key);
        if (!held) winner.set(key, rec);
        else if (newer(held, rec)) {
          // A later page carried the real winner. Doom the one we were holding, not this.
          doomed.push(held.id);
          winner.set(key, rec);
        } else doomed.push(rec.id);
      }
      walked += page.length;
      if (page.length < PAGE) break;
      if (walked >= MAX_WALK) {
        out.more = true;
        break;
      }
      after = page[page.length - 1].id;
    }
    await record(doomed, kind);
  }

  // --- interests: live while their RUN is, so the key is liveness, not succession. An interest
  // is published per run at agentLoop start, which makes every restart append; the dead runs'
  // entries are what `liveInterests` filters on every read, forever, until they are gone.
  if (opts.only === undefined || opts.only === INTEREST) {
    const liveness = new Map<string, boolean>();
    const doomed: string[] = [];
    let after: string | undefined;
    let walked = 0;
    for (;;) {
      const page = await host.pageDesc(INTEREST, PAGE, after);
      for (const rec of page) {
        const by = rec.runtimeMeta.createdBy;
        let live = liveness.get(by);
        if (live === undefined) {
          live = await host.runIsLive(by);
          liveness.set(by, live);
        }
        if (!live) doomed.push(rec.id);
      }
      walked += page.length;
      if (page.length < PAGE) break;
      if (walked >= MAX_WALK) {
        out.more = true;
        break;
      }
      after = page[page.length - 1].id;
    }
    await record(doomed, INTEREST);
  }

  return out;
}

/**
 * The amortization counters, which are INSTANCE state rather than the database's.
 *
 * Two instances over one database each keep their own count, which only means the housekeeping
 * runs a little oftener. That is deliberate: coordinating it would need a shared row and a lock to
 * save work nobody is waiting on. The counters live on the space and reach this module as one
 * holder, because their lifetime is the process's and this module holds nothing of its own.
 */
export interface SweepState {
  /** Commits since the last amortized retention sweep. */
  writesSinceSweep: number;
  amortizedSweepRunning: boolean;
  /** Writes per KEYED kind since that kind was last compacted. Only keyed kinds are counted, so a
   *  space streaming an unkeyed kind never triggers a walk. */
  readonly writesSinceCompact: Map<string, number>;
  compactingKind: Set<string>;
}

/**
 * What the sweeps need from a space.
 *
 * Wider than `ChainHost` because a sweep decides ELIGIBILITY, and eligibility is a question about
 * kinds, grants-free reads and the blob store at once. Two members are the chain's, asked rather
 * than reimplemented: an event-log truncation has to be attested, or the sweep is indistinguishable
 * from tampering when integrity next runs (plan-gc.md phase 3).
 */
export interface GcHost {
  readonly storage: StorageAdapter;
  readonly blobs: BlobStore;
  readonly ctx: SpaceGcContext;
  readonly kinds: { list(): KindDef[]; get(kind: string): KindDef | undefined };
  readonly sweep: SweepState;
  query(pattern: Pattern, limit?: number, page?: Page): Promise<RadiaRecord[]>;
  /** Is this run still live? A record under a live run's lease is never swept. */
  runIsLive(run: string): Promise<boolean>;
  sealEvents(limit?: number): Promise<{ sealed: number; head?: { idx: number; hash: string } }>;
  attestEventTruncation(
    anchor: { idx: number; cursor: string; seq: number },
    runId?: string,
  ): Promise<{ attested: boolean }>;
}

/** The knobs the sweeps read. Named as its own type so the port does not depend on the whole
 *  `SpaceContext`, most of which is nothing to do with deletion. */
export interface SpaceGcContext {
  runId: string;
  gcEveryWrites: number;
  compactEveryWritesPerKind: number;
  eventRetentionSeconds?: number | null;
  blobGcGraceSeconds: number;
  idempotencyRetentionSeconds: number;
}

/**
 * The retention sweep: delete records whose writer-declared `retention_until` has passed.
 *
 * The second deliberate carve-out from immutability, after artifact erasure, and shaped by the
 * same rule: destroy the content, keep the evidence (the event log keeps id, kind, digest and
 * every transition; the sweep adds one recordless `gc` event per kind per batch). See
 * agent_docs/plan-gc.md for eligibility and for what is deliberately NOT swept.
 *
 * The kind classes come from the REGISTRY, which is why this lives here and not in the adapter:
 * only the registry knows which kinds are reference data (`claimable: false`, sweepable from any
 * state because they sit `available` forever by design) and which are reserved. A kind this
 * process has never loaded defaults to the strict class (consumed/dead_letter only), which is
 * the conservative side.
 *
 * ON DEMAND, never on a timer, like sealing and for the same reason: an idle space should hold
 * no background work. `radia doctor` reports the backlog; `POST /v0/ops/gc` runs the sweep.
 */
export async function gc(
  host: GcHost,
  opts: { limit?: number; dryRun?: boolean; compact?: boolean; principal?: string } = {},
): Promise<GcReport> {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
  const totals = { swept: 0, eligible: 0, idempotency: 0, byKind: {} as Record<string, number>, more: false, passes: 0 };
  // Bounded batches rather than one unbounded delete: each pass is one transaction, so a crash
  // loses at most a batch's progress and a concurrent reader never sees a half-swept batch. The
  // pass cap bounds one CALL; `more` says a backlog remains and the caller decides.
  const MAX_PASSES = 50;
  // The idempotency cutoff rides the FIRST pass only: after it those rows are gone, and a dry
  // run would count the same rows once per pass.
  const idempotencyBefore = addSeconds(await host.storage.now(), -host.ctx.idempotencyRetentionSeconds);
  for (;;) {
    const r = await host.storage.sweepExpired({
      ...sweepSelector(host, limit, opts.dryRun),
      runId: opts.principal ?? host.ctx.runId,
      ...(totals.passes === 0 ? { idempotencyBefore } : {}),
    });
    totals.eligible += r.eligible;
    totals.swept += r.swept;
    totals.idempotency += r.idempotency;
    for (const [k, n] of Object.entries(r.byKind)) totals.byKind[k] = (totals.byKind[k] ?? 0) + n;
    totals.passes++;
    totals.more = r.more;
    // A dry run never loops: its count is a capped sample, and looping would re-count the same
    // rows forever, since nothing was deleted.
    if (opts.dryRun || !r.more || totals.passes >= MAX_PASSES) break;
  }
  // An explicit LIVE gc restarts the amortized clock. Not a dry run: doctor calls this dry on
  // every diagnostics, and a backlog report must not keep postponing the sweep it reports on.
  if (!opts.dryRun) host.sweep.writesSinceSweep = 0;
  // Event-log retention rides the verb too (phase 3, plan-gc.md) and ONLY the verb: sealing on
  // the write path is exactly the background work the on-demand rule refuses.
  const events = host.ctx.eventRetentionSeconds != null
    ? await gcEvents(host, { dryRun: opts.dryRun, runId: opts.principal })
    : undefined;
  // Registry compaction rides the same verb (phase 2, plan-gc.md): superseded successors of
  // latest-wins registries, plus interests whose run is over. `core/gc.ts` owns the keep-newest
  // logic and its resurrection guard; this only wires the reads and the one destructive member.
  let compaction: CompactionResult | undefined;
  if (opts.compact !== false) {
    compaction = await compactRegistries(
      compactionHost(host),
      { dryRun: opts.dryRun, runId: opts.principal ?? host.ctx.runId },
    );
  }
  // Reference-aware blob GC rides the verb LAST (phase 4, plan-gc.md): the record sweep above
  // is what turns an expired artifact into an unreferenced digest, so its bytes reclaim in the
  // same call. The live set is every digest any surviving artifact record carries, paged to
  // exhaustion; the store deletes what is absent from it AND untouched past the grace window
  // (the whole race answer — see `blobGcGraceSeconds` and `BlobStore.retainOnly`). LIVE sweeps
  // only: `doctor` runs this dry on every diagnostics, and a dry blob pass would walk every
  // artifact record and the whole blob directory to report a number the live sweep reports
  // anyway.
  let blobs: BlobGcResult | undefined;
  if (!opts.dryRun) {
    blobs = await host.blobs.retainOnly(await referencedDigests(host), { graceMs: host.ctx.blobGcGraceSeconds * 1000 });
  }
  // Assembled into a typed value rather than spread into the return, so a sweep that grows a
  // field `GcReport` does not declare is a compile error. Conditional spreads widen to `{}` and
  // check nothing (see `handleIntegrity`).
  const out: GcReport = { ...totals };
  if (compaction) out.compaction = compaction;
  if (events) out.events = events;
  if (blobs) out.blobs = blobs;
  return out;
}

/**
 * Event-log retention: truncate the log to `eventRetentionSeconds` ∩ the sealed head
 * (plan-gc.md phase 3). The order is the contract, each step for a reason the plants pin:
 * seal FIRST (a never-sealed space must not sweep nothing forever, and only sealed events are
 * ever candidates); pick the anchor through the seals, never splitting events that share a
 * cursor (an xid groups siblings, and a split would strand retained events below the horizon);
 * attest and SEE `attested: true` before the first delete (an honest crash must not read as
 * tampering); then delete pairs oldest-first so every observable state is a clean prefix
 * truncation. Refusing to proceed (statement not sealed yet) reports `more: true` rather than
 * weakening any step.
 */
export async function gcEvents(
  host: GcHost,
  opts: { dryRun?: boolean; limit?: number; sealBudget?: number; runId?: string } = {},
): Promise<EventGcResult> {
  const retention = host.ctx.eventRetentionSeconds;
  const out: EventGcResult = { enabled: retention != null, sealed: 0, unsealed: 0, swept: 0, eligible: 0, more: false };
  if (retention == null) return out;
  // A dry run reports the seal-first debt instead of paying it: doctor runs this on every
  // diagnostics, and "what would sweep" must not quietly become "seal 5000 links".
  out.sealed = (await host.sealEvents(opts.sealBudget ?? (opts.dryRun ? 0 : 10 * SEAL_BATCH))).sealed;
  const head = await host.storage.sealHead();
  out.unsealed = (await host.storage.sealableEvents(head ? { cursor: head.cursor, seq: head.seq } : null, 1)).length;
  out.more = out.unsealed > 0; // a seal backlog is work this call did not finish
  if (!head) return out;

  const cutoff = addSeconds(await host.storage.now(), -retention);
  let anchor = await host.storage.latestSealBefore(cutoff);
  const [oldest] = await host.storage.getSeals(-1, 1);
  // Never split a cursor group: if the next seal shares the candidate's cursor, the window
  // boundary falls inside one transaction's events; step down and sweep less instead.
  while (anchor) {
    const [next] = await host.storage.getSeals(anchor.idx, 1);
    if (!next || next.cursor !== anchor.cursor) break;
    if (anchor.idx - 1 < oldest.idx) {
      anchor = null;
      break;
    }
    [anchor] = await host.storage.getSeals(anchor.idx - 2, 1);
  }
  if (!anchor) return out;
  out.anchorIdx = anchor.idx;

  if (opts.dryRun) {
    out.eligible = (await host.storage.sweepSealedEvents({ idx: anchor.idx, seq: anchor.seq }, 0, true)).events;
    return out;
  }
  const { attested } = await host.attestEventTruncation(anchor, opts.runId ?? host.ctx.runId);
  out.attested = attested;
  if (!attested) {
    // The statement is committed but the chain has not sealed through it (finality watermark
    // behind, or the seal backlog outran the budget). Deleting now would manufacture the
    // unattested state verify rightly calls tampering, so nothing is deleted.
    out.more = true;
    return out;
  }
  const r = await host.storage.sweepSealedEvents(
    { idx: anchor.idx, seq: anchor.seq },
    Math.min(Math.max(opts.limit ?? 10_000, 1), 100_000),
  );
  out.swept = r.events;
  out.eligible = r.events;
  if (!r.done) out.more = true;
  return out;
}

/** The eligibility classes the sweep needs, computed from the registry (only it knows which
 *  kinds are reference data and which are reserved). Shared by the verb and the amortized pass. */
function sweepSelector(host: GcHost, limit: number, dryRun?: boolean) {
  return {
    // `artifact` is reference data like any other claimable-false kind (it sits `available`
    // forever), so once its writer declared retention it sweeps from any state. It left
    // `neverKinds` when reference-aware blob GC arrived (plan-gc.md phase 4): before that,
    // sweeping the record stranded its bytes with no path to them but `erasures`.
    anyStateKinds: host.kinds.list()
      .filter((d) => !isClaimable(d) && (!RESERVED_KINDS.includes(d.kind) || d.kind === ARTIFACT))
      .map((d) => d.kind),
    neverKinds: RESERVED_KINDS.filter((k) => k !== ARTIFACT),
    limit,
    dryRun,
  };
}

/** What compaction reads and the one destructive member it calls. Shared by the `gc` verb and
 *  the amortized per-kind trigger, so the two cannot come to disagree about what a registry is. */
function compactionHost(host: GcHost) {
  return {
    listKinds: () => host.kinds.list(),
    pageDesc: (kind: string, limit: number, after?: string) => host.query({ kind }, limit, { dir: "desc" as const, after }),
    sweepIds: (ids: string[], runId: string) => host.storage.sweepIds(ids, runId),
    runIsLive: (run: string) => host.runIsLive(run),
  };
}

/**
 * Compact ONE registry inline, every `compactEveryWritesPerKind` writes of that kind.
 *
 * The measurement is the whole argument (agent_docs/plan-registry-cost.md): a registry read is
 * linear in history, and compaction makes it EXACTLY FLAT, so leaving it to a verb nobody runs
 * means every reader pays for litter forever. Amortizing it puts the cost on the writer producing
 * the litter, which is where the interest budget and the retention sweep already put theirs.
 *
 * PER KIND rather than on `gcEveryWrites`, and that distinction is the reason this is separate
 * machinery: registry litter grows per write of a KEYED kind, so a global counter would walk
 * every registry in the space because somebody streamed a million chunks. What runs here is a
 * walk of the registry that just grew.
 *
 * Same shape as the retention sweep otherwise: no timer, awaited so it is deterministic and
 * bounded, guarded against stacking, and a failure is swallowed because housekeeping must never
 * fail the write that happened to trigger it.
 */
export async function maybeCompactKind(host: GcHost, kind: string): Promise<void> {
  if (host.ctx.compactEveryWritesPerKind <= 0) return;
  // Only kinds a compaction pass would actually walk. `NEVER_COMPACT` and unkeyed kinds are
  // asked about once per write and answered from the in-process registry, never the database.
  const def = host.kinds.get(kind);
  const keyed = kind === INTEREST || (def !== undefined && (def.contentKey?.length ?? 0) > 0);
  if (!keyed) return;
  const n = (host.sweep.writesSinceCompact.get(kind) ?? 0) + 1;
  if (n < host.ctx.compactEveryWritesPerKind) {
    host.sweep.writesSinceCompact.set(kind, n);
    return;
  }
  host.sweep.writesSinceCompact.set(kind, 0);
  if (host.sweep.compactingKind.has(kind)) return;
  host.sweep.compactingKind.add(kind);
  try {
    await compactRegistries(compactionHost(host), { runId: host.ctx.runId, only: kind });
  } catch { /* the litter waits for the next trigger or the verb */ } finally {
    host.sweep.compactingKind.delete(kind);
  }
}

/**
 * The amortized half of GC: every `gcEveryWrites` record commits, the WRITING call runs one small
 * retention batch inline.
 *
 * The lazy-lease-expiry shape, deliberately: no timer (an idle space runs nothing and does not
 * grow), and the cost lands on the principal generating the litter, which is the fair place for
 * it. Awaited rather than fire-and-forget, so the Nth writer pays a bounded few milliseconds
 * and tests are deterministic; the guard keeps a slow sweep from stacking. Measured (plan-gc.md
 * carries the table): an empty trigger costs 0.36ms (sqlite) / 1.7ms (pglite), a full 256-row
 * batch 5–9ms, which amortizes to under 1% of a put and lands at p99.9, not p99.
 * Retention only — compaction walks whole registries and stays with the explicit verb, because
 * registry litter grows per session, not per write.
 *
 * A failed pass is swallowed: housekeeping must never fail the write that happened to trigger it.
 */
export async function maybeAmortizedSweep(host: GcHost): Promise<void> {
  if (host.ctx.gcEveryWrites <= 0) return;
  if (++host.sweep.writesSinceSweep < host.ctx.gcEveryWrites) return;
  host.sweep.writesSinceSweep = 0;
  if (host.sweep.amortizedSweepRunning) return;
  host.sweep.amortizedSweepRunning = true;
  try {
    await host.storage.sweepExpired({
      ...sweepSelector(host, AMORTIZED_BATCH),
      runId: host.ctx.runId,
      idempotencyBefore: addSeconds(await host.storage.now(), -host.ctx.idempotencyRetentionSeconds),
    });
  } catch { /* the backlog waits for the next trigger or the verb */ } finally {
    host.sweep.amortizedSweepRunning = false;
  }
}

/** Every digest a surviving `artifact` record carries, paged to EXHAUSTION: a bounded read would
 *  present a prefix as the population, and both callers act on this set (one deletes what is
 *  absent from it, the other re-seals what is in it). */
export async function referencedDigests(host: GcHost): Promise<Set<string>> {
  const live = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const rows = await host.query({ kind: ARTIFACT }, 500, { dir: "desc", after });
    for (const rec of rows) {
      const d = (rec.body as { digest?: unknown }).digest;
      if (typeof d === "string") live.add(d);
    }
    if (rows.length < 500) break;
    after = rows[rows.length - 1].id;
  }
  return live;
}
/** Rows one amortized pass may delete: small enough that the write paying for it feels a few
 *  milliseconds, not a collection. A backlog bigger than this drains across later triggers. */
const AMORTIZED_BATCH = 256;

/** A fresh set of counters, so the space does not have to spell the shape out. */
export function newSweepState(): SweepState {
  return { writesSinceSweep: 0, amortizedSweepRunning: false, writesSinceCompact: new Map(), compactingKind: new Set() };
}
