// StorageAdapter: the port every storage backend implements.
//
// This interface IS the storage-adapter contract. The conformance suite targets it,
// not any concrete backend, so PGlite, SQLite (both M0), and Postgres (M1) satisfy the
// same tests. Keep backend dialect OUT of this file and out of `src/core/`: SQL and
// dialect-specific concurrency (checked compare-and-set over a bounded candidate window,
// serialized in-process on the embedded adapters) live inside each adapter.
//
// Design split (see agent_docs/plan-m0-implementation.md):
//   - core/  computes policy: matching predicates, attempt deltas, idempotency ordering.
//   - adapters execute the resulting transitions ATOMICALLY in one transaction.
// Atomicity is the adapter's job because a transaction is per-backend; the semantics it
// guarantees are the contract.

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

// The wire vocabulary is DEFINED in `sdk/ts/wire.ts` and re-exported here, so every import
// path inside `src/` is unchanged while the SDK ships without reaching back into the runtime.
// See that file's header for why the direction runs this way.
import type {
  AckResult,
  DelegationContext,
  EventInput,
  Lease,
  Page,
  RadiaRecord,
  RecordState,
  RenewResult,
  RuntimeMeta,
  SettleResult,
  SpaceEvent,
  TakeResult,
  Ulid,
} from "../../sdk/ts/wire.ts";
export type {
  AckResult,
  DelegationContext,
  EventInput,
  Lease,
  Page,
  RadiaRecord,
  RecordState,
  RenewResult,
  RuntimeMeta,
  SettleResult,
  SpaceEvent,
  TakeResult,
  Ulid,
};

/**
 * One link of the tamper-evident event chain, written AFTER the event it covers is final.
 *
 * Sealing cannot happen at append time: `seq` is assigned on insert but transactions commit out of
 * order, so two concurrent appends would read the same head and fork the chain. Serializing appends
 * would put every put/take/ack behind one lock. So the chain is built by a sealer walking events
 * that are already final, which costs the hot path nothing and makes the chain eventually
 * consistent: an audit answers about SEALED history, and the report says how far that reaches.
 */
export interface EventSeal {
  idx: number; // chain position, dense from 0
  eventId: Ulid;
  /** Where the sealed event sat in the log, so the next batch resumes exactly after it. */
  cursor: string;
  seq: number;
  hash: string;
  prevHash: string;
  /** HMAC over `hash` under a key that does not live in this database. Absent when no key is
   *  configured, and that absence is reported rather than hidden: an unsigned chain detects
   *  corruption and naive edits, not an adversary who can rewrite rows. */
  sig?: string;
}

/** The event log's truncation floor. Everything at or below `cursor` may have been swept;
 *  `getEvents(cursor)` is gap-free. `swept` is exact because seal idx is dense from 0. */
export interface EventHorizon {
  cursor: string;
  swept: number;
}

export interface EventHorizonCheck {
  /** True when `getEvents(after)` would silently skip swept events. The sentinel "0"/"" reads as
   *  expired on a truncated log by design; the caller decides whether that clamps or refuses. */
  expired: boolean;
  horizon: EventHorizon | null;
}

/**
 * Shared horizon derivation both adapters bind to their dialect: the oldest retained seal plus
 * whether its event still exists decides the floor. Oldest idx 0 with its event present = complete
 * from genesis. Event missing = the anchor state (its event was the newest swept one). Idx > 0
 * with the event present = a sweep in flight, floored just below it: over-refusing a cursor that
 * sits exactly on the unknowable newest-swept position is safe, silently under-refusing is not.
 * Cursors are decimal strings in every adapter (seq or xid8), so the comparison is numeric here
 * rather than re-implemented per dialect; an unparseable cursor keeps today's behavior.
 */
export function resolveEventHorizon(
  oldest: EventSeal | null,
  oldestEventExists: boolean,
  after: string,
): EventHorizonCheck {
  let horizon: EventHorizon | null = null;
  if (oldest && !oldestEventExists) horizon = { cursor: oldest.cursor, swept: oldest.idx + 1 };
  else if (oldest && oldest.idx > 0) horizon = { cursor: (BigInt(oldest.cursor) - 1n).toString(), swept: oldest.idx };
  if (!horizon) return { expired: false, horizon: null };
  let expired = false;
  try {
    expired = BigInt(after.length > 0 ? after : "0") < BigInt(horizon.cursor);
  } catch {
    expired = false;
  }
  return { expired, horizon };
}

/** Mutable claim-state envelope. One row per record. */
export interface Envelope {
  recordId: Ulid;
  kind: string; // denormalized from record at commit
  state: RecordState;
  attempt: number;
  availableAt: string; // eligibility / backoff
  claimUntil?: string; // no NEW claims after this time
  deadlineAt?: string; // denormalized
  effectivePriority: number; // server-computed
  leaseId?: Ulid;
  leaseEpoch?: number;
  leaseOwner?: string; // run id
  leasedUntil?: string;
}

// ---------------------------------------------------------------------------
// Compiled match: backend-neutral pattern AST
// ---------------------------------------------------------------------------
//
// core/matching.ts compiles a wire pattern into this neutral AST over declared indexed
// paths, and core/matching.ts's evaluator is the SEMANTIC ORACLE for it. `storage/pushdown.ts`
// renders nodes into each dialect (Postgres jsonb / SQLite json_extract) as a SOUND PRE-FILTER:
// SQL implied by the oracle's verdict, never a substitute for it, so a node it cannot express
// exactly falls through to the oracle rather than guessing. The neutral form is what stops a
// Postgres assumption leaking into core.

export type CmpOp = "eq" | "gt" | "gte" | "lt" | "lte";

/** A predicate applied to a single array element under $any/$each (no path). */
export type ElemPred =
  | { t: "cmp"; op: CmpOp; value: unknown }
  | { t: "in"; values: unknown[] };

export type MatchNode =
  | { t: "cmp"; path: string; op: CmpOp; value: unknown }
  | { t: "in"; path: string; values: unknown[] }
  | { t: "exists"; path: string; exists: boolean }
  | { t: "quant"; quant: "any" | "each"; path: string; pred: ElemPred }
  | { t: "and"; nodes: MatchNode[] }
  | { t: "or"; nodes: MatchNode[] };

export interface OrderBy {
  path: string;
  dir: "asc" | "desc";
}

/**
 * What an ops-plane read is narrowed to: the principal's own records (`createdBy`) on `kinds`.
 * Both filters are ANDed and both are applied in SQL, never after the fact. `createdBy` holds
 * PRINCIPALS as stored on the record (`run:…` for a token-bearing session), not agent names. What
 * "my records" means is resolved by the runtime before it gets here.
 *
 * `alsoReadable` filters NOTHING. It is carried so the answer can describe itself honestly. A
 * principal's authority is not uniform across kinds: it can hold a self-scoped read grant on one
 * and an unscoped one on another, and then the ops aggregate (always self-scoped, by design) counts
 * fewer records than its own `query` returns for the same kind. With no hint in the aggregate, the
 * caller reports its own slice as the space. The counts stay narrow; the response says which kinds
 * it could read more of.
 */
export interface StatsScope {
  /** Author restriction: the principal and its runs. */
  createdBy?: string[];
  /** Kinds the aggregate covers, narrowed to `createdBy`. */
  kinds?: string[];
  /** Descriptive only: kinds whose READS are not narrowed, so a query on them returns more than
   *  these counts. Never used as a filter; see the note above. */
  alsoReadable?: string[];
}

export interface KindStateCount {
  kind: string;
  state: RecordState;
  count: number;
}

// ---- event log ----

export interface CompiledMatch {
  kind: string; // record kind discriminator
  where?: MatchNode; // undefined = match all of kind
  orderBy?: OrderBy[];
  /**
   * Most candidate rows this read may EXAMINE, counted before the oracle sees them.
   *
   * Not a limit on rows returned: an exact pre-filter (`pushdown.ts`) returns only matches and can
   * never reach this. It bounds the other path, where SQL cannot decide the pattern and every row
   * of the kind crosses into `matchesRecord`. That path costs 13.6s at a million records
   * (`bench/deployment.ts`) in a single-threaded process, which makes it one principal's denial of
   * service against every other. Exceeding it raises `scan_budget_exceeded`; it never truncates,
   * because a bounded read whose result is treated as a population is this codebase's most
   * repeated bug. Undefined means unbounded, which is what an in-process caller constructing a
   * `CompiledMatch` by hand gets; `Space.compile` always sets it.
   */
  scanBudget?: number;
}

/** What a retention sweep may touch. Computed by `Space.gc` from the kind registry, because the
 *  adapter knows states and columns while only the registry knows which kinds are reference data
 *  and which are reserved. */
export interface SweepSelector {
  /** Kinds eligible in ANY state (claimable:false reference kinds). All others sweep only from
   *  `consumed`/`dead_letter`. */
  anyStateKinds: string[];
  /** Kinds never swept: the reserved kinds, incl. `artifact` until blob GC exists. */
  neverKinds: string[];
  /** Batch cap; a full batch sets `more`, and the caller decides whether to go again. */
  limit: number;
  /** Count eligibility, delete nothing. */
  dryRun?: boolean;
  /** Who asked, stamped on the `gc` events. */
  runId: string;
  /** Also sweep IDEMPOTENCY rows stamped before this cutoff (the third append-only store).
   *  Rows whose `created_at` is `''` (written before the column was stamped) never sweep: an
   *  unknown age must not read as an old one. Replaying a swept key re-executes, which is the
   *  ordinary at-least-once posture past any honest retry window. */
  idempotencyBefore?: string;
}

export interface SweepResult {
  /** Rows deleted (0 on dryRun). */
  swept: number;
  /** Rows that matched eligibility (== swept unless dryRun). */
  eligible: number;
  /** Idempotency rows swept (or eligible, on dryRun). */
  idempotency: number;
  byKind: Record<string, number>;
  /** The batch filled `limit`: run again for the rest. NEVER read a capped result as the total —
   *  that is this codebase's most repeated bug, stated here because a GC backlog is exactly the
   *  number an operator will quote. */
  more: boolean;
}

/** Rows an adapter fetches per chunk while walking a kind the pre-filter could not decide. Large
 *  enough that the per-chunk statement overhead disappears, small enough that the yield between
 *  chunks is frequent. Both adapters use it, because two adapters walking a kind by different rules
 *  would make the conformance suite two different tests. */
const SCAN_CHUNK = 1000;

/** Never larger than the budget: a first chunk bigger than the whole budget would overshoot it by
 *  construction, and the mechanism would be untestable below a thousand records. */
export function scanChunkSize(budget?: number): number {
  return budget === undefined ? SCAN_CHUNK : Math.max(1, Math.min(SCAN_CHUNK, budget));
}

/**
 * Give the event loop a real turn between chunks, so a scan of a large kind is a delay for its
 * caller rather than an outage for everyone else. Measured on 60k records, sqlite, one neighbour
 * polling an indexed read while an unpushable scan ran: without this the neighbour ran ONCE and
 * waited 138ms, the whole scan. With it, 24 times, worst wait 5.9ms, and the scan went 140ms to
 * 184ms. That is the trade, stated plainly: the scan pays about a third for not being an outage.
 *
 * `setImmediate`, not `setTimeout(0)`: the timer clamp costs 2.2ms per yield against 0.013ms, which
 * on the same rows was 353ms of scan rather than 184ms. A microtask (`await Promise.resolve()`)
 * would be cheaper still and would do NOTHING, since it drains inside the same turn. The embedded
 * adapters need this even where a chunk is awaited: PGlite is WASM in this process, so its `await`
 * is not the socket round trip a real Postgres gives for free.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) =>
    typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)
  );
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface IdempotencyKey {
  principal: string;
  operation: string;
  key: string;
  requestHash: string;
}

// ---------------------------------------------------------------------------
// Operation inputs / results
// ---------------------------------------------------------------------------

export interface PutInput {
  /** Fully formed record incl. server-assigned runtimeMeta and bodySha256. */
  record: RadiaRecord;
  /** Exact serialized body that bodySha256 is over; stored verbatim so bytes and hash agree. */
  bodyJson: string;
  /** Denormalized routing fields for the envelope, computed by core at commit. */
  envelope: Pick<
    Envelope,
    "kind" | "availableAt" | "claimUntil" | "deadlineAt" | "effectivePriority"
  >;
  idempotency?: IdempotencyKey;
  /** Overrides for the `put` event this commit appends. A privileged DECLASSIFY is still a put of
   *  a successor record, but recording it as an ordinary put leaves the one operation whose whole
   *  purpose is accountability indistinguishable from every other write. */
  event?: { operation?: string; detail?: Record<string, unknown> };
}

export interface PutResult {
  id: Ulid;
  /** True when an idempotency key replayed a stored response. */
  deduped: boolean;
}

// ---- take / lease settlement ----

/** Core-computed inputs for a take. The adapter assigns epoch + deadlines atomically. */
export interface LeaseSpec {
  leaseId: Ulid;
  ownerRun: string;
  leaseSeconds: number;
  maxCumulativeSeconds: number; // hard cap: a wedged process cannot renew past this
  maxAttempts: number; // beyond this, an expired reclaim dead-letters
  /** A sensitive consumer's claim filter: the labels a candidate may carry. Undefined = no barrier.
   *  An ALLOWLIST, so a label introduced later is barred rather than silently admitted. */
  allowTaint?: string[];
  /** Author restriction from a self-scoped grant: skip candidates authored by anyone else. A claim
   *  hands back the record body, so this has to be enforced in the claim like `requireUntainted`,
   *  not left to the caller. */
  createdBy?: string[];
}

/** What a lease holder presents to renew/ack/nack/release. Fencing checks all three. */
export interface LeaseRef {
  recordId: Ulid;
  leaseId: Ulid;
  epoch: number;
  /**
   * The RESOLVED caller, when a settle must be owner-bound. Set, the adapter treats a lease owned
   * by anyone else as invalid (an opaque `lease_lost`, never a distinguishable error).
   *
   * It rides on the ref rather than being checked by the caller BECAUSE of the ordering invariant:
   * the check has to happen inside the settle's transaction, after the stored idempotent response
   * is consulted. Checked first, in `Space`, a legitimate owner's retry of an op that already
   * succeeded was answered `lease_lost` once the record had been reclaimed by somebody else —
   * exactly what "idempotency is checked before lease validation" exists to forbid.
   */
  expectOwner?: string;
}

export type TakeSelector =
  | { pattern: CompiledMatch }
  | { recordId: Ulid; pattern?: CompiledMatch };

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  readonly name: string;

  /** Open the backend and ensure schema exists. */
  init(): Promise<void>;
  /** Release all resources. */
  close(): Promise<void>;

  /**
   * The database clock, ISO 8601. INVARIANT: all lease/timing math uses this, never a
   * client or app-server clock. Adapters read it from the DB engine, not from the host.
   */
  now(): Promise<string>;

  /** Commit an immutable record + its envelope in one transaction. (Phase 1) */
  put(input: PutInput): Promise<PutResult>;

  /** First matching record, or null. (Phase 1) */
  /** `scope.createdBy` restricts reads to records written by those principals. This is how a
   *  self-scoped grant narrows the coordination plane, not only the ops plane. */
  readOne(match: CompiledMatch, scope?: StatsScope): Promise<RadiaRecord | null>;

  /**
   * Matching records, ordered by the pattern, capped at `limit`.
   *
   * `page` is KEYSET pagination over record id: a cursor, not an offset, so a page stays stable
   * while records are being written. It is defined only for the natural (id) order, i.e. when the
   * pattern carries no `orderBy`: a keyset cursor has to be the whole sort key, and for a body
   * field that means (value, id) pairs plus the type semantics of the oracle. Refusing the
   * combination is the honest bound; sorting by a body field still works, just without a cursor.
   *
   * `dir: "desc"` is what makes "the newest N" expressible at all. Without it a limit always
   * returns the OLDEST matches, because the deterministic tie-break is ascending id.
   */
  query(match: CompiledMatch, limit: number, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]>;

  /** Record counts grouped by kind and state (dev UI overview / diagnostics). */
  /**
   * Counts by kind and state.
   *
   * `scope` makes this a GENUINE aggregate over a subset, not a whole-space total filtered
   * afterwards. The difference matters because a wrongly-filtered count is invisible in the
   * output, it just looks plausible. `createdBy` is a set of principals (an agent's run
   * principals, resolved by the runtime; the run → agent mapping is not a column), `kinds` limits
   * which kinds are counted at all.
   */
  stats(scope?: StatsScope): Promise<KindStateCount[]>;

  /**
   * Atomically claim a record for a fenced lease. Selects an eligible record (available,
   * or a leased record whose lease has expired), transitions it to `leased`, bumps the
   * epoch, and returns the record + lease. Returns null if nothing is claimable. An
   * expired reclaim increments `attempt` (expiry backoff) and dead-letters past
   * `maxAttempts`. INVARIANT: at most one valid lease per record at a time. (Phase 3)
   */
  take(selector: TakeSelector, spec: LeaseSpec): Promise<TakeResult | null>;

  // Idempotency (Phase 4): every state-changing op accepts an optional key. The stored
  // response is checked BEFORE lease validation and written in the SAME transaction as the
  // effect, so a retry after a lost response replays the original outcome instead of
  // re-validating a now-invalid lease. A key reused with a different request throws
  // RadiaError("idempotency_conflict").

  /** Extend a held lease, clamped to the cumulative hard cap. Fenced. (Phase 3) */
  renew(ref: LeaseRef, leaseSeconds: number, idem?: IdempotencyKey): Promise<RenewResult>;

  /** Consume the record and optionally emit a result record, in one transaction. Fenced. (Phase 3) */
  ack(ref: LeaseRef, result?: PutInput, idem?: IdempotencyKey): Promise<AckResult>;

  /** Retryable failure: attempt +1, backoff via available_at, dead-letter past max. Fenced. (Phase 3) */
  nack(ref: LeaseRef, backoffSeconds: number, maxAttempts: number, idem?: IdempotencyKey): Promise<SettleResult>;

  /** Cooperative cancel: attempt +0, immediately available. Fenced. (Phase 3) */
  release(ref: LeaseRef, idem?: IdempotencyKey): Promise<SettleResult>;

  /** The mutable envelope for a record (diagnostics, inspector, tests). */
  getEnvelope(recordId: Ulid): Promise<Envelope | null>;

  /** A single record by id (inspector, get-by-id). */
  getRecord(recordId: Ulid): Promise<RadiaRecord | null>;

  /**
   * Records for a set of ids, in one round trip. Missing ids are simply absent from the result,
   * and order is not guaranteed, so callers that need one must impose it. This exists so a graph
   * walk costs a round trip per LEVEL rather than per node; `getLineage` is the caller that
   * makes the difference visible on a deep DAG.
   */
  getRecords(ids: Ulid[]): Promise<RadiaRecord[]>;

  /**
   * Records whose parent_ids include this id: the reverse of lineage (relationship graph).
   *
   * BOUNDED, and paged by the same keyset contract as `query`: `page.after` is the last child id of
   * the previous page. Fan-out is unbounded in principle (a conversation accumulates a child per
   * message, a task per result), so an unlimited read here materializes a whole subtree to answer
   * "who references this", and a caller that walks the graph would do it per node.
   */
  childrenOf(recordId: Ulid, limit: number, page?: Page): Promise<RadiaRecord[]>;

  /** Append-only event log, in cursor order, after the opaque `afterCursor` ("0"/"" = from the
   *  start). The cursor is adapter-defined and opaque to callers (see SpaceEvent.cursor). (Phase 5) */
  getEvents(afterCursor: string, limit: number): Promise<SpaceEvent[]>;

  /** The current high-water cursor: a fresh watch's starting point, so only future events are
   *  delivered. Opaque; pass it back to getEvents. (M1) */
  latestCursor(): Promise<string>;

  /**
   * Events that are FINAL and not yet sealed, in chain order, after `(cursor, seq)`.
   *
   * Separate from `getEvents` for two reasons the chain cannot tolerate. It resumes on the pair
   * rather than the cursor alone, because one transaction appends several events under one cursor
   * and `xid > cursor` would step over the siblings; a watcher losing one drops a wakeup, a sealer
   * losing one breaks the chain. And it never returns an event that might still be joined by an
   * older in-flight transaction, since a chain cannot accept a late arrival: `getEvents`' watermark
   * is what makes the order final rather than merely current. (M1)
   */
  sealableEvents(after: { cursor: string; seq: number } | null, limit: number): Promise<SpaceEvent[]>;

  /** The last sealed link, or null on a space that has never been sealed. (M1) */
  sealHead(): Promise<EventSeal | null>;

  /**
   * Append seal rows, contiguously from `sealHead().idx + 1`. Returns how many were written.
   *
   * A conflicting index is skipped rather than overwritten: two runtimes over one database may seal
   * the same events concurrently, and they compute identical rows from identical input, so first
   * writer wins and the loser learns it wrote nothing. Overwriting would let a second sealer replace
   * a link, which is the one thing this table exists to make impossible. (M1)
   */
  appendSeals(seals: EventSeal[]): Promise<number>;

  /** Seal rows after `afterIdx`, ascending, for verification. (M1) */
  getSeals(afterIdx: number, limit: number): Promise<EventSeal[]>;

  /**
   * The event log's truncation floor, and whether resuming from `after` would silently skip
   * swept events. Event-log GC (M2) deletes a PREFIX of events with their seals and keeps the
   * newest pre-horizon seal as the anchor; this reads that state back (`resolveEventHorizon`).
   * `horizon` is null while the log is complete from genesis. Sentinel policy is the CALLER's:
   * "0"/"" reads as expired on a truncated log, and the watch handler exempts it (410 only a
   * non-sentinel cursor) while the ops read annotates it. The check is live before the sweep
   * exists; it just never finds a horizon.
   */
  eventHorizon(after: string): Promise<EventHorizonCheck>;

  // Kind declarations are NOT a storage concern: they are kind_def records, written via put()
  // and read via query() like any record (see core/space.ts loadKinds). No kinds table.

  /**
   * OPTIONAL physical hint: this kind declares these body paths, and predicates on them are about
   * to be pushed down. Purely an optimization: an adapter that ignores it must return identical
   * results, and the default is to have no implementation at all.
   *
   * It exists because one adapter cannot plan a claim without it. Postgres estimates a jsonb
   * predicate at ~26 rows where 5,715 match, concludes a sort is free, and collects every match
   * through the body index instead of walking the claim index. That is 200× off, and not fixable by
   * rewriting the query (see gotchas.md, "a claim on Postgres is planned on a guess"). The fix is
   * to give the planner a real estimate for the expression, which is per-path DDL, which means the
   * adapter has to be told the paths. It is deliberately NOT "create an index": what a path costs
   * physically is the adapter's business, and SQLite implements none of this.
   *
   * Must be idempotent and safe to call on every startup.
   */
  prepareKind?(kind: string, paths: string[]): Promise<void>;

  /**
   * Retention sweep: delete records whose `retention_until` has passed, with their envelope and
   * edge rows, in one transaction per batch. The ONE deliberate record-deletion path besides
   * artifact shredding; see agent_docs/plan-gc.md for what it may and may never touch.
   *
   * Eligibility is entirely COLUMN predicates (no body pattern, no oracle, no scan budget):
   *   - `retention_until` non-null and before the DB clock's now;
   *   - no lease is HELD: `lease_id` set with an unexpired `leased_until` ("Retention GC never
   *     discards a valid in-flight lease's completed work", CLAUDE.md). Settling clears `lease_id`
   *     and leaves `leased_until` behind, so testing the timestamp alone embargoes every freshly
   *     acked record for a lease-length — found by the conformance suite, kept as a comment;
   *   - the kind is not in `neverKinds` (reserved kinds; artifact until blob GC exists);
   *   - the state is `consumed`/`dead_letter`, UNLESS the kind is in `anyStateKinds`
   *     (claimable:false reference kinds, whose records sit `available` forever by design —
   *     unclaimed WORK is never litter, however old its retention).
   *
   * Appends one recordless `gc` event per swept kind (operation "gc", detail {swept, cutoff}) in
   * the same transaction: the audit residue, at event size rather than record size. `dryRun`
   * counts eligibility and deletes nothing. Idempotent; concurrent sweeps race harmlessly (the
   * loser deletes zero rows).
   */
  sweepExpired(sel: SweepSelector): Promise<SweepResult>;

  /**
   * Delete these specific records (with envelope and edges), for registry COMPACTION: the caller
   * has already computed which entries are superseded (`core/gc.ts`), so eligibility here is only
   * the safety floor — a record holding a live lease is skipped whatever the caller decided, and
   * the count of what was actually deleted is returned. Appends the same recordless `gc` events
   * the retention sweep does, marked `compacted: true`.
   */
  sweepIds(ids: Ulid[], runId: string): Promise<{ swept: number; byKind: Record<string, number> }>;

  /** Envelopes currently in a given state, capped (diagnostics). `excludeKinds` filters them out
   *  at the query level (before the cap), used to skip reference kinds in the starvation check. */
  envelopesInState(
    state: RecordState,
    limit: number,
    excludeKinds?: string[],
    scope?: StatsScope,
  ): Promise<Envelope[]>;

  /**
   * Emergency quarantine: force every `leased` record owned by `ownerRun` back to `available`,
   * bumping the epoch (so a late `ack`/`renew` from that run fences out as `lease_lost`) and the
   * attempt, and appending a `quarantine` event per record. Returns how many were invalidated.
   * Not a lease settlement; used when a run is stopped-with-quarantine.
   */
  quarantineLeasesOf(ownerRun: string, now: string): Promise<number>;

  /**
   * Admin/control-plane forced state transition (bypasses lease fencing, used to remediate
   * another worker's stuck records). Moves a record from one of `fromStates` to `toState`
   * (optionally only if its lease is expired, and/or bumping attempt), appends an event, and
   * returns whether a row actually changed. Not a lease settlement.
   */
  adminTransition(
    recordId: Ulid,
    fromStates: RecordState[],
    toState: RecordState,
    opts: { now: string; bumpAttempt?: boolean; onlyExpired?: boolean },
  ): Promise<boolean>;
}

/** Marker for port methods a phase has not implemented yet. */
export function notImplemented(method: string): never {
  throw new Error(`StorageAdapter.${method} not implemented yet`);
}
