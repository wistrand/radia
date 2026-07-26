// StorageAdapter — the port every storage backend implements.
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

export type Ulid = string;

export type RecordState =
  | "available"
  | "leased"
  | "consumed"
  | "dead_letter"
  | "expired";

/**
 * The single authorization chain for delegated work — server-derived from the CLAIMED LEASE,
 * never from `parent_ids` (data parents contribute no authority). Present only on records emitted
 * via `ack` under a managed run's lease; a direct put or operator-owned work carries none.
 */
export interface DelegationContext {
  chain: Ulid[]; // ordered grant subjects (agents) whose authority this work flows under
  origin: Ulid; // the leased record it was delegated from (the authorization parent)
}

/** Server-assigned, authoritative metadata. Never client-editable. */
export interface RuntimeMeta {
  createdBy: string; // principal id
  delegationContext?: DelegationContext; // authorization chain, server-derived from the lease
  parentIds: Ulid[]; // data/causality lineage only
  taint: boolean;
  schemaVersion: number;
  createdAt: string; // DB clock, ISO 8601
}

/** Immutable content half of a record. Never rewritten after commit. */
export interface RadiaRecord {
  id: Ulid;
  kind: string;
  body: unknown;
  bodySha256: string; // over plaintext
  clientMeta?: Record<string, unknown>; // client-submitted claims only
  runtimeMeta: RuntimeMeta;
  deadlineAt?: string; // business deadline
  retentionUntil?: string; // GC eligibility
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

/** A fenced lease handed to a claimant. */
export interface Lease {
  leaseId: Ulid;
  epoch: number;
  ownerRun: string;
  recordId: Ulid;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Compiled match — backend-neutral template AST
// ---------------------------------------------------------------------------
//
// core/matching.ts compiles a wire template into this neutral AST over declared indexed
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
 * Restricts an aggregate to a subset of the space. Both fields are ANDed, and both are applied in
 * SQL rather than after the fact.
 *
 * `createdBy` holds PRINCIPALS as stored on the record (`run:…` for a token-bearing session), not
 * agent names: what "my records" means is resolved by the runtime before it gets here, because the
 * run → agent mapping lives in the credential index and not in any column.
 */
export interface StatsScope {
  createdBy?: string[];
  kinds?: string[];
}

export interface KindStateCount {
  kind: string;
  state: RecordState;
  count: number;
}

// ---- event log ----

/** What an op appends to the event log, in the same transaction as its mutation. */
export interface EventInput {
  runId: string; // run identity on every event (approximated by principal/lease owner in M0)
  operation: string; // put | take | ack | nack | release | expire
  recordId?: Ulid;
  kind?: string;
  state?: RecordState; // resulting state
  detail?: Record<string, unknown>;
}

export interface SpaceEvent extends EventInput {
  seq: number; // unique per-event identity (display / dedup)
  // Gap-safe resume cursor — OPAQUE to callers (transport echoes it via SSE id / Last-Event-ID;
  // only the adapter interprets it). On single-connection backends it is the seq; on pooled
  // Postgres it is the inserting transaction id (xid), and `getEvents` only returns events below
  // the snapshot watermark — so a watcher advancing by `cursor` never skips an event that
  // committed out of seq order (see agent_docs/design-storage.md "Watch delivery under concurrency").
  cursor: string;
  id: Ulid;
  ts: string; // DB clock
}

export interface CompiledMatch {
  kind: string; // record kind discriminator
  where?: MatchNode; // undefined = match all of kind
  orderBy?: OrderBy[];
}

/**
 * Keyset pagination over record id. `after` is EXCLUSIVE and is read in the direction of `dir`,
 * so it is "the last id of the previous page" either way — ids strictly greater for `asc`,
 * strictly smaller for `desc`.
 *
 * Note what a ULID cursor does and does not promise. Ids sort by creation time only to the
 * MILLISECOND; records written inside the same millisecond differ in their random half, so `desc`
 * is "newest first" at millisecond resolution, not a strict write order. What it does guarantee is
 * a total, stable order — which is all pagination needs, and is exactly what an offset cannot give
 * while the space is being written to.
 */
export interface Page {
  after?: Ulid;
  dir?: "asc" | "desc"; // default "asc"
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
  /** A sensitive consumer claim-filter: skip candidates whose record is tainted. */
  requireUntainted?: boolean;
}

/** What a lease holder presents to renew/ack/nack/release. Fencing checks all three. */
export interface LeaseRef {
  recordId: Ulid;
  leaseId: Ulid;
  epoch: number;
}

export type TakeSelector =
  | { template: CompiledMatch }
  | { recordId: Ulid; template?: CompiledMatch };

export interface TakeResult {
  record: RadiaRecord;
  lease: Lease;
}

/** `lease_lost` is a distinct non-error outcome, not an exception. */
export type SettleResult = { status: "ok" } | { status: "lease_lost" };
export type AckResult =
  | { status: "ok"; resultId?: Ulid }
  | { status: "lease_lost" };
export type RenewResult =
  | { status: "ok"; lease: Lease }
  | { status: "lease_lost" };

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
  /** `scope.createdBy` restricts reads to records written by those principals — how a self-scoped
   *  grant narrows the coordination plane, not only the ops plane. */
  readOne(match: CompiledMatch, scope?: StatsScope): Promise<RadiaRecord | null>;

  /**
   * Matching records, ordered by the template, capped at `limit`.
   *
   * `page` is KEYSET pagination over record id — a cursor, not an offset, so a page stays stable
   * while records are being written. It is defined only for the natural (id) order, i.e. when the
   * template carries no `orderBy`: a keyset cursor has to be the whole sort key, and for a body
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
   * afterwards — the difference matters because a wrongly-filtered count is invisible in the
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
   * and order is not guaranteed — callers that need one must impose it. This exists so a graph
   * walk costs a round trip per LEVEL rather than per node; `getLineage` is the caller that
   * makes the difference visible on a deep DAG.
   */
  getRecords(ids: Ulid[]): Promise<RadiaRecord[]>;

  /**
   * Records whose parent_ids include this id — the reverse of lineage (relationship graph).
   *
   * BOUNDED, and paged by the same keyset contract as `query`: `page.after` is the last child id of
   * the previous page. Fan-out is unbounded in principle — a conversation accumulates a child per
   * message, a task per result — so an unlimited read here materializes a whole subtree to answer
   * "who references this", and a caller that walks the graph would do it per node.
   */
  childrenOf(recordId: Ulid, limit: number, page?: Page): Promise<RadiaRecord[]>;

  /** Append-only event log, in cursor order, after the opaque `afterCursor` ("0"/"" = from the
   *  start). The cursor is adapter-defined and opaque to callers (see SpaceEvent.cursor). (Phase 5) */
  getEvents(afterCursor: string, limit: number): Promise<SpaceEvent[]>;

  /** The current high-water cursor — a fresh watch's starting point, so only future events are
   *  delivered. Opaque; pass it back to getEvents. (M1) */
  latestCursor(): Promise<string>;

  // Kind declarations are NOT a storage concern: they are kind_def records, written via put()
  // and read via query() like any record (see core/space.ts loadKinds). No kinds table.

  /** Envelopes currently in a given state, capped (diagnostics). `excludeKinds` filters them out
   *  at the query level (before the cap) — used to skip reference kinds in the starvation check. */
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
   * Not a lease settlement — used when a run is stopped-with-quarantine.
   */
  quarantineLeasesOf(ownerRun: string, now: string): Promise<number>;

  /**
   * Admin/control-plane forced state transition (bypasses lease fencing — used to remediate
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
