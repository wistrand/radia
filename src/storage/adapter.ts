// StorageAdapter — the port every storage backend implements.
//
// This interface IS the storage-adapter contract. The conformance suite targets it,
// not any concrete backend, so PGlite, SQLite (both M0), and Postgres (M1) satisfy the
// same tests. Keep backend dialect OUT of this file and out of `src/core/`: SQL and
// dialect-specific concurrency (`FOR UPDATE SKIP LOCKED` on Postgres, single-connection
// serialization on the embedded adapters) live inside each adapter.
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

/** Server-assigned, authoritative metadata. Never client-editable. */
export interface RuntimeMeta {
  createdBy: string; // principal id
  delegationContext?: string; // authorization chain, server-derived from the lease
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
// paths, and core/matching.ts's evaluator is the SEMANTIC ORACLE for it. Each adapter may
// later render nodes into its own dialect (Postgres jsonb / SQLite json_extract) for
// indexed pushdown, but that SQL must agree with the oracle. The neutral form is what
// stops a Postgres assumption leaking into core.

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
  seq: number; // monotonic
  id: Ulid;
  ts: string; // DB clock
}

export interface CompiledMatch {
  kind: string; // record kind discriminator
  where?: MatchNode; // undefined = match all of kind
  orderBy?: OrderBy[];
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
  readOne(match: CompiledMatch): Promise<RadiaRecord | null>;

  /**
   * Matching records, ordered by the template, capped at `limit`. A basic list for the
   * dev UI; the keyset-cursor `query` (stable pagination) lands in M1.
   */
  query(match: CompiledMatch, limit: number): Promise<RadiaRecord[]>;

  /** Record counts grouped by kind and state (dev UI overview / diagnostics). */
  stats(): Promise<KindStateCount[]>;

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

  /** A single record by id (lineage walk, inspector). */
  getRecord(recordId: Ulid): Promise<RadiaRecord | null>;

  /** Append-only event log, in seq order, after `afterSeq` (0 = from the start). (Phase 5) */
  getEvents(afterSeq: number, limit: number): Promise<SpaceEvent[]>;
}

/** Marker for port methods a phase has not implemented yet. */
export function notImplemented(method: string): never {
  throw new Error(`StorageAdapter.${method} not implemented yet`);
}
