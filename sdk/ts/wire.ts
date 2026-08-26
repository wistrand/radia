// The frozen contract's vocabulary: the shapes that cross `/v0`, and the few pure functions a
// client must compute IDENTICALLY to the server.
//
// WHY THIS FILE EXISTS, and it is not tidiness. `sdk/ts/client.ts` used to import these from
// `src/`, including runtime VALUES, and its own header said so: "For M0 it imports the wire types
// from the repo; Phase 7 will extract a standalone type surface so the SDK can ship independently."
// Phase 7 shipped and this did not, which broke the thing the note was written to prevent:
// `scripts/build-release.sh` stages `sdk/` and `extensions/` into the npm package and no `src/`, so
// the package's own entry point (`"." : "./sdk/client.ts"`) imported paths that are not in it. A
// value import fails at run time; a type import fails whenever anyone type-checks. The layering
// rule and the shipping bug were the same defect seen from two sides.
//
// DIRECTION. `src/` imports THIS, never the reverse, and every former definition site re-exports
// from here so nothing else in the runtime changed. That is not the runtime depending on its own
// client library: the wire contract is the most fundamental thing in the project ("the wire contract
// is what's frozen, not the implementation"), so it is a leaf both sides depend on. It lives under
// `sdk/` because that is what the package already stages, and a contract nobody ships is not one.
//
// WHAT BELONGS HERE. A shape that appears on the wire, or a function whose result both sides must
// agree on byte for byte (`kindDefKey`, the registry projection). NOT storage ports, NOT anything
// with a dependency, NOT server policy. If it needs an import from `src/`, it is not wire vocabulary.
// `test/layering.test.ts` enforces the direction.

// ---------------------------------------------------------------------------
// Identifiers and records
// ---------------------------------------------------------------------------

/** A ULID, lowercase-free and lexicographically sortable. Monotonic within a process: latest-wins
 *  registries decide "newer" by comparing these. */
export type Ulid = string;

export type RecordState =
  | "available"
  | "leased"
  | "consumed"
  | "dead_letter";

/**
 * The single authorization chain for delegated work, server-derived from the CLAIMED LEASE and
 * never from `parent_ids` (data parents contribute no authority). Present only on records emitted
 * via `ack` under a managed run's lease; a direct put or operator-owned work carries none.
 */
export interface DelegationContext {
  chain: Ulid[]; // ordered grant subjects (agents) whose authority this work flows under
  origin: Ulid; // the leased record it was delegated from (the authorization parent)
}

/**
 * What `POST /v0/agent-runs/delegated` returns: an ordinary run token whose authority is
 * `grants(worker) INTERSECT grants(caller)`.
 *
 * `agent` is still the WORKER's: delegation narrows what a run may do, it does not change who it
 * is, so `created_by`, taint and the idempotency scope all keep naming the worker. `actingFor` is
 * the other half of the answer and is server-resolved from the named record's author.
 */
export interface DelegatedRun {
  run: Ulid;
  agent: string;
  runToken: string;
  expiresAt: string;
  actingFor: string;
}

/** Server-assigned, authoritative metadata. Never client-editable. */
export interface RuntimeMeta {
  createdBy: string; // principal id
  delegationContext?: DelegationContext; // authorization chain, server-derived from the lease
  parentIds: Ulid[]; // data/causality lineage only
  /** Classification labels this record carries, sorted and deduplicated; empty means unclassified.
   *  A BARRIER vocabulary, not provenance: see `TAINT_LABELS` in `src/core/kinds.ts`. Lives outside
   *  the body, so the routing language cannot match on it. */
  taint: string[];
  schemaVersion: number;
  createdAt: string; // DB clock, ISO 8601
}

/** Immutable content half of a record. Never rewritten after commit. */
export interface RadiaRecord<T = unknown> {
  id: Ulid;
  kind: string;
  /** Opaque by default. A reader that KNOWS the shape names it (`RadiaRecord<Task>`), which is what
   *  the typed reads below hand back; it is not a promise the runtime makes, so a body still has to
   *  be one the writer's kind allows. */
  body: T;
  bodySha256: string; // over plaintext
  clientMeta?: Record<string, unknown>; // client-submitted claims only
  runtimeMeta: RuntimeMeta;
  deadlineAt?: string; // business deadline
  retentionUntil?: string; // GC eligibility
}

/** What a client submits. Authoritative fields are absent BY CONSTRUCTION: there is no slot for
 *  `created_by`, `taint` beyond a raise, or any lease field, so a client cannot claim one. */
export interface PutRequest {
  kind: string;
  body: unknown;
  /** Client claims: confidence, requested_priority, app fields. Preserved, never trusted. */
  clientMeta?: Record<string, unknown>;
  /** Data/causality lineage the client asserts. All must exist at commit (checked in put). */
  parentIds?: string[];
  /**
   * When this record becomes CLAIMABLE. Absent means immediately, which is what every record was
   * before this field existed.
   *
   * Delayed visibility, not a timer: nothing fires at this instant. The record simply stops being a
   * take candidate until the DB clock passes it (`rankClaimable`), which is the machinery retry
   * backoff has always used (`nack({backoffSeconds})`). A worker notices on its next poll, so the
   * lag is its `pollMs` floor (1s for `agentLoop`), and an idle space still runs nothing. See
   * agent_docs/plan-milestones.md, "durable timers": the sweeper that entry imagines is not needed
   * and is deliberately not built.
   *
   * A CLAIM, like `deadlineAt` and `retentionUntil`: the caller computes it from ITS clock and the
   * space compares against ITS own, so a value already past is clamped forward to now rather than
   * refused. A delay beyond the space's ceiling IS refused (`invalid_available_at`), because an
   * unclaimed claimable record is never swept and a far-future one is permanent litter.
   *
   * Meaningless on a non-claimable kind, where nothing takes: harmless, and not refused, since a
   * kind can be redeclared claimable later.
   */
  availableAt?: string;
  /** When the work stops being worth doing. STORED AND NEVER READ by the runtime: nothing claims,
   *  orders or sweeps on it, so it is a fact for app code (a turn worker resumes only while it is
   *  in the future). Never reach for it to defer a claim: that is `availableAt` above. */
  deadlineAt?: string;
  /** GC eligibility, and the ONLY thing that makes a record sweepable. Absent, with no
   *  `defaultRetentionSeconds` on the kind, means PERMANENT. Materialized at commit, so a later
   *  redeclaration never changes history (plan-gc.md). */
  retentionUntil?: string;
  /** Source attestation: classification labels the client RAISES on its own output, from the closed
   *  vocabulary (`TAINT_LABELS`). Raising is monotone, so it needs no trust: a client can only ever
   *  restrict what the record may reach, never widen it. Removal is declassify, and privileged. */
  taint?: string[];
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface Lease {
  leaseId: Ulid;
  epoch: number;
  ownerRun: string;
  recordId: Ulid;
  expiresAt: string;
}

export interface TakeResult<T = unknown> {
  record: RadiaRecord<T>;
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
// Patterns and paging
// ---------------------------------------------------------------------------

export interface OrderKey {
  path: string;
  dir?: "asc" | "desc";
}

/** Wire pattern. `match` values are implicit-$eq scalars or operator objects. */
export interface Pattern {
  kind: string;
  match?: Record<string, unknown>;
  orderBy?: OrderKey[];
}

/**
 * Keyset pagination over record id. `after` is EXCLUSIVE and is read in the direction of `dir`,
 * so it is "the last id of the previous page" either way: ids strictly greater for `asc`,
 * strictly smaller for `desc`.
 *
 * Note what a ULID cursor does and does not promise. Ids sort by creation time only to the
 * MILLISECOND; records written inside the same millisecond differ in their random half, so `desc`
 * is "newest first" at millisecond resolution, not a strict write order. What it does guarantee is
 * a total, stable order, which is all pagination needs, and is exactly what an offset cannot give
 * while the space is being written to.
 */
export type Page =
  /** A FIRST page, or a resume from a watermark the caller stores itself. */
  | { after?: Ulid; dir?: "asc" | "desc"; cursor?: never }
  /**
   * A CONTINUATION. The cursor carries the direction, so it is an alternative to `after` + `dir`
   * and never an addition: the union makes the pair unrepresentable in TypeScript, and the server
   * refuses it with a 400 for every other client. Either resolution of that pair is a walk that
   * changes direction half way through, re-reading records it already returned and skipping ones
   * it never did.
   */
  | { cursor: Cursor; after?: never; dir?: never };

/**
 * An opaque page cursor. Treat it as a token to echo back; the encoding below is an implementation
 * detail that exists so a MISUSE is loud rather than silent.
 */
export type Cursor = string;

/**
 * `<a|d>:<ulid>`, and deliberately not base64.
 *
 * A cursor that carried only the id let a caller walk the first page `desc` and the second `asc`
 * with nothing to notice: `after` is exclusive in the direction of the read, so the second page
 * returned records from BEFORE the first. Encoding the direction makes that unrepresentable.
 *
 * The `:` is what makes an old bare-ULID `after` value DISTINGUISHABLE rather than misread: a ULID
 * is 26 characters of Crockford base32 and can never contain one, so `decodeCursor` can refuse.
 * Base64 would have hidden that, and hidden the direction from anyone reading a log.
 */
export function encodeCursor(dir: "asc" | "desc", after: Ulid): Cursor {
  return `${dir === "desc" ? "d" : "a"}:${after}`;
}

/** Inverse of `encodeCursor`. Throws on anything it did not produce, including a bare record id. */
export function decodeCursor(cursor: Cursor): { dir: "asc" | "desc"; after: Ulid } {
  const at = cursor.indexOf(":");
  const tag = at === 1 ? cursor[0] : "";
  if (tag !== "a" && tag !== "d") {
    throw new Error(`not a page cursor: ${JSON.stringify(cursor)} (expected a value from nextCursor)`);
  }
  const after = cursor.slice(2);
  if (after.length === 0) throw new Error("page cursor carries no record id");
  return { dir: tag === "d" ? "desc" : "asc", after };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventInput {
  runId: string; // run identity on every event (approximated by principal/lease owner in M0)
  operation: string; // put | take | ack | nack | release | expire
  recordId?: Ulid;
  kind?: string;
  state?: RecordState; // resulting state
  detail?: Record<string, unknown>;
  /** The record's content hash, captured on the event that commits it. Server-assigned, and
   *  deliberately NOT folded into `detail`: that field is caller-influenced, and this is what the
   *  integrity chain hashes to cover record content. */
  bodySha256?: string;
}

export interface SpaceEvent extends EventInput {
  seq: number; // unique per-event identity (display / dedup)
  // Gap-safe resume cursor, OPAQUE to callers (transport echoes it via SSE id / Last-Event-ID;
  // only the adapter interprets it). On single-connection backends it is the seq; on pooled
  // Postgres it is the inserting transaction id (xid), and `getEvents` only returns events below
  // the snapshot watermark, so a watcher advancing by `cursor` never skips an event that
  // committed out of seq order (see agent_docs/design-storage.md "Watch delivery under concurrency").
  cursor: string;
  id: Ulid;
  ts: string; // DB clock
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * What a declared path holds. DESCRIPTIVE: nothing casts on it — matching, ordering and pushdown all
 * read the runtime JSON type at the path — so this says what a reader should expect to find, and a
 * declaration that lies is a lie nothing currently catches.
 *
 * `number` is for values that are genuinely fractional AND tolerant of rounding: a score, a ratio, a
 * provider's reported `cost` of 0.00161865, which is a figure to rank and show rather than to
 * reconcile. Money you are ACCOUNTING for is a scaled integer (minor units), as every ledger stores
 * it — reach for `integer` there, not this. Prefer `integer` wherever values are whole: a float
 * declared as `integer` sorts correctly today and misleads the first reader who trusts it.
 */
export type IndexedType = "keyword" | "integer" | "number" | "timestamp" | "array";

export interface IndexedPath {
  path: string; // dotted path into the record body
  type: IndexedType;
}

export interface KindDef {
  kind: string;
  indexedPaths: IndexedPath[];
  /** Paths order_by may use. Must each be a declared indexed path. */
  sortablePaths?: string[];
  /** Whether records of this kind are *claimed as work* (`take`n by a worker) vs. *reference*
   *  data (facts, config, history; written once, read by `query`, never taken). Default true.
   *  `false` opts the kind out of the starvation check: a reference record sitting `available`
   *  forever is normal, not stale work. See `Space.diagnostics`. */
  claimable?: boolean;
  /** Body paths that form this kind's LATEST-WINS identity, for a kind that is a registry (a
   *  capability keyed by provider+tool, a model ad keyed by tier). Declaring it is what lets
   *  `radia gc` compact the kind — delete every record strictly older than the newest per key,
   *  tombstones included — without the runtime knowing what the kind means. A record missing any
   *  key path is never compacted. Purely descriptive for matching; see agent_docs/plan-gc.md. */
  contentKey?: string[];
  /**
   * Retention for records of this kind whose writer stamped none: MATERIALIZED into
   * `retention_until` at commit, from the DB clock, never evaluated at sweep time — so every
   * record stays self-describing and a later redeclaration changes only FUTURE records' fate,
   * never retroactively. An explicit `retentionUntil` on the put always wins.
   *
   * Declaring this makes the kind ephemera-by-default: a writer wanting one record kept must
   * stamp a far-future date, because absence no longer means permanence for this kind. That is
   * the declarer's call to make, the same way `indexedPaths` and `claimable` already are — the
   * alternative was retention remembered per call site, which is how the chat's chunks were
   * permanent for a month. See agent_docs/plan-gc.md.
   */
  defaultRetentionSeconds?: number;
}

/** The meta-kind. Defined here rather than in the runtime because a client writes one. */
export const KIND_DEF = "kind_def";

/** Kind names the runtime gives meaning to. On the wire because a client has to know which names
 *  are not its to use, and because `RESERVED_KINDS` is checked client-side before a declaration is
 *  sent. Their SEMANTICS stay in `src/core/kinds.ts`; only the names are contract. */
export const GRANT = "grant";
export const SIGNAL = "signal";
export const AGENT_DEFINITION = "agent_definition";
export const AGENT_RUN = "agent_run";
export const ARTIFACT = "artifact";
export const SHRED = "shred";
export const INTEREST = "interest";
/** Ops-plane powers as records (architecture-ops-tiers.md): `{principal, operations}` over a closed
 *  power vocabulary, assigned by a config operator, additive, retired to revoke. */
export const OPS_GRANT = "ops_grant";
/** OIDC identity mapping (design-auth.md "OIDC"): `{iss, sub, principal}`, latest-wins per
 *  (iss, sub), operator-assigned. Maps an IdP identity to the `human:` principal grants bind to. */
export const OIDC_IDENTITY = "oidc_identity";
export const RESERVED_KINDS = [KIND_DEF, GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN, ARTIFACT, INTEREST, SHRED, OPS_GRANT, OIDC_IDENTITY];

/**
 * A deterministic idempotency key for a declaration, stable across process restarts and
 * independent of field order: the same def dedups (no record growth), a changed def is a new
 * successor record.
 *
 * NORMATIVE, and the reason it sits in the wire vocabulary rather than in the runtime: the server
 * and every client must produce the same string, or a client redeclaring an unchanged kind appends
 * a duplicate record on every startup and the registry grows without bound.
 */
export function kindDefKey(def: KindDef): string {
  const ip = [...(def.indexedPaths ?? [])].map((p) => `${p.path}:${p.type}`).sort().join(",");
  const sp = [...(def.sortablePaths ?? [])].sort().join(",");
  // `contentKey` and `defaultRetentionSeconds` participate so a redeclaration ADDING one is a
  // changed def (a fresh record), not an idempotent replay of the old declaration. Each is omitted
  // entirely when absent, so every key minted before the field existed stays byte-identical and
  // old declarations do not re-write.
  const ck = def.contentKey?.length ? `:ck=${[...def.contentKey].sort().join(",")}` : "";
  const rt = def.defaultRetentionSeconds ? `:rt=${def.defaultRetentionSeconds}` : "";
  return `kind_def:${def.kind}:${ip}:${sp}:${def.claimable === false ? "ref" : "work"}${ck}${rt}`;
}

/**
 * What a SCOPED caller was narrowed to on the ops plane, sent by every `/v0/ops` read that can
 * return a slice. Absent for an operator.
 *
 * Its whole job is stopping a partial answer from reading as a total, so a client that cannot see
 * this field reports somebody's own records as the space. Defined here because twelve handlers
 * send it and the SDK's private copy was already missing `alsoReadableInFull`.
 */
export interface OpsScope {
  self: true;
  /** The kinds this caller is scoped on. */
  kinds: string[];
  /** Kinds it may READ in full even though the numbers above cover only its own records: a
   *  specific, checkable statement that a query there returns more. */
  alsoReadableInFull?: string[];
  note: string;
}

/**
 * A record's RUNTIME half: the only part that changes after commit.
 *
 * Read through `GET /v0/ops/records?state=…`, which is what makes claim state a query rather than a
 * bespoke endpoint. The five timing fields are distinct concepts and are never overloaded
 * (agent_docs/design-data-model.md).
 */
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

/**
 * A freshly minted run: the SHORT half of a credential, and the only half that acts.
 *
 * `runToken` is returned once and never again. `expiresAt` is when it stops working, not when the
 * run ends: renewal moves it up to the ceiling `RunRenewal.maxLifetimeAt` reports.
 */
export interface MintedRun {
  run: string;
  agent: string;
  runToken: string;
  expiresAt: string;
}

/** A renewed run. No token: renewal moves the expiry of the one the caller already holds, and
 *  `maxLifetimeAt` is the ceiling past which no renewal helps and a fresh mint is required. */
export interface RunRenewal {
  run: string;
  agent: string;
  expiresAt: string;
  maxLifetimeAt: string;
}

// ---------------------------------------------------------------------------
// Authorization, as the space reports it (`GET /v0/ops/permissions`)
// ---------------------------------------------------------------------------

/** The coordination operations a grant can authorize. */
export type GrantOp = "put" | "take" | "query" | "read_one";

/** The ops-plane powers an `ops_grant` can carry (architecture-ops-tiers.md). */
export type OpsPower = "observe" | "remediate" | "sweep" | "declassify" | "purge";

export interface EffectivePermissions {
  principal: string;
  /** The agent a run resolves to. Grants are held by agents, not by individual runs. */
  subject: string;
  privileged: boolean;
  /** Set for a DELEGATED run: the caller whose reach bounds it. `kinds` below is then the
   *  intersection it was minted with, not `subject`'s own grants, so the two lines have to be read
   *  together. See agent_docs/plan-delegation.md. */
  actingFor?: string;
  /** Authority this agent can reach ONLY by minting a delegated run (`delegable:<agent>` grants).
   *  Absent from `kinds` on purpose: its own token cannot use these. */
  delegable?: { kind: string; operations: GrantOp[] }[];
  kinds: {
    kind: string;
    operations: GrantOp[];
    readsScopedToSelf: boolean;
    patterns: Record<string, unknown>[];
    /** Set when NO such kind is declared on this space, so the grant authorizes nothing. A grant
     *  may legitimately precede its kind (an operator bootstraps an agent before the fleet declares
     *  its kinds), so this is a flag rather than an error. But an agent that guessed a kind name
     *  and got it approved otherwise reads this row as working access. */
    kindNotDeclared?: true;
  }[];
  ops: { reachable: boolean; kinds: string[] };
  /** Ops-plane powers held via `ops_grant` records (all of them for a privileged principal).
   *  Reported through the same resolution the gate enforces (`Space.opsPowers`), so this line IS
   *  the enforcement, not a restatement of it. Distinct from `ops` above, which is the
   *  self-scoped read tier (own records of granted kinds). */
  opsPowers: OpsPower[];
  /** False if the grant scan could not be exhausted. The picture may be missing entries. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Diagnostics (`GET /v0/ops/diagnostics`)
// ---------------------------------------------------------------------------

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
  /** Records past their `retention_until`, waiting for a sweep (`POST /v0/ops/gc`). The sweep is
   *  on demand, so without this row nobody learns there is anything to run. `atLeast` marks a
   *  capped count; ABSENT for a scoped caller, like the rows above. */
  sweepable?: { eligible: number; byKind: Record<string, number>; atLeast: boolean };
  /** Superseded registry entries a compaction pass would delete (`radia gc`). Its own row, never
   *  folded into `sweepable`: this is bookkeeping rather than a finding, and summing the two would
   *  hide which number a retention policy actually governs. Reported because `doctor` said "19
   *  sweepable" where `gc` said 19 plus 181, so the number a person acted on was the small one. */
  compactable?: { superseded: number; byKind: Record<string, number>; atLeast: boolean };
  /** Event-log retention backlog, present when `eventRetentionSeconds` is configured. `unsealed`
   *  is the seal-first debt: those events cannot sweep (or be truncation candidates) until a gc
   *  seals them, and on a never-doctored space it is the whole log, so without this row the first
   *  gc looks hung. */
  eventsSweepable?: { eligible: number; unsealed: number };
  /** The event chain's verdict. ABSENT for a scoped caller, like `undoneErasures` and for the same
   *  reason: the chain covers everyone's activity, so a scoped `ok:true` would be reassurance
   *  about records the caller cannot see. */
  integrity?: IntegrityReport;
}

// ---------------------------------------------------------------------------
// Erasure (`POST /v0/ops/records/{id}/shred`, `GET /v0/ops/erasures`)
// ---------------------------------------------------------------------------

/** What a shred destroyed. Erasure is by CONTENT, so `references` is the number of artifact records
 *  that named those bytes: above 1 the call refuses unless the caller acknowledges the sharing. */
export interface ShredResult {
  digest: string;
  references: number;
  encrypted: boolean;
  /** The payload was already gone. Success, not a fault: erasing twice must converge. */
  alreadyGone: boolean;
}

/** One recorded erasure, and whether it still holds. */
export interface ErasureStatus {
  shredId: string;
  artifactId: string;
  digest: string;
  reason: string;
  at: string;
  method: string;
  /** False when the payload is present again, which is a REVERSED erasure and the only interesting
   *  value here. */
  holds: boolean;
}

/** Every recorded erasure, with `complete: false` rather than a plausible prefix: a partial list
 *  read as a population would say "all erasures hold" about a space nobody finished scanning. */
export interface ErasureReport {
  erasures: ErasureStatus[];
  checked: number;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Space digest (`GET /v0/ops/digest`)
// ---------------------------------------------------------------------------

/** One read that orients an investigator: what kinds exist, what is in them, who is listening, and
 *  what the caller may do. Generated from records, so it cannot drift from the space. */
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
  /** What the CALLING principal may do: the same shape `GET /v0/ops/permissions` returns. */
  permissions: EffectivePermissions;
  complete: boolean;
}

/** What `GET /v0/ops/digest` sends: the digest, plus what only the handler knows. */
export interface DigestResponse extends SpaceDigest {
  /** Present when a grant narrowed the read. */
  scope?: OpsScope;
  /** Present when interests were withheld: why an empty list is not "nobody is listening". */
  interestsNote?: string;
}

// ---------------------------------------------------------------------------
// Garbage collection (`POST /v0/ops/gc`)
// ---------------------------------------------------------------------------

/** What one compaction pass deleted: superseded latest-wins successors, and dead runs' interests. */
export interface CompactionResult {
  /** Records deleted (0 on dryRun). */
  compacted: number;
  /** Records found superseded or dead (== compacted unless dryRun or a lease intervened). */
  superseded: number;
  byKind: Record<string, number>;
  /** A kind's walk hit the page cap: more may remain. Never read a capped count as the total. */
  more: boolean;
}

/** What one event-log retention pass did (plan-gc.md phase 3). */
export interface EventGcResult {
  /** False when `eventRetentionSeconds` is unset: the log is never truncated. */
  enabled: boolean;
  /** Links sealed by the seal-first pass this call ran. */
  sealed: number;
  /** Seal-first debt after the budget: 0 = fully sealed, 1 = at least one unsealed (a probe,
   *  like `IntegrityReport.unsealed`; report it as "N+"). Unsealed events can never sweep. */
  unsealed: number;
  /** Events deleted (0 on a dry run). */
  swept: number;
  /** Events at or below the anchor (dry run: what would go). */
  eligible: number;
  /** The chosen anchor: the newest sealed event outside the retention window, cursor-group safe. */
  anchorIdx?: number;
  /** Whether the horizon statement sealed; false aborts the sweep with `more: true`. */
  attested?: boolean;
  /** Work remains: a seal backlog, an unsealed statement, or pairs past this call's limit. */
  more: boolean;
}

/** What one blob sweep did. */
export interface BlobGcResult {
  scanned: number;
  deleted: number;
  bytes: number;
  /** Payloads KEPT because they were sealed under a key this space does not hold. Absent or 0 in
   *  the ordinary case. A rotation that dropped a retired key shows up here rather than as bytes
   *  quietly disappearing, which is the one outcome a sweep must never produce silently. */
  foreign?: number;
}

/**
 * What one `gc` call did, across all four sweeps.
 *
 * The handler adds nothing, so this is both what core returns and what the wire sends. `more` is
 * the field that matters: a capped pass is normal, and reading its counts as the total is how a
 * backlog goes unnoticed.
 */
export interface GcReport {
  swept: number;
  eligible: number;
  idempotency: number;
  byKind: Record<string, number>;
  more: boolean;
  passes: number;
  /** Registry compaction, unless `compact: false`. Kinds opt in by declaring a `contentKey`. */
  compaction?: CompactionResult;
  /** Present when the space configures `eventRetentionSeconds`. */
  events?: EventGcResult;
  /** Reference-aware blob GC, on LIVE runs only: a dry pass would walk the whole store to predict
   *  what a live one reports anyway. */
  blobs?: BlobGcResult;
}

// ---------------------------------------------------------------------------
// Mined flows (`GET /v0/ops/flows`)
// ---------------------------------------------------------------------------

/** A recurring shape of work, mined from what happened. Never declared: the runtime has no
 *  topology to assert, which is the whole reason this has to be recovered rather than read. */
export interface FlowShape {
  /** `job → task×4-7 → result×4-7 → summary`: one segment per causal depth, tokens sorted. */
  signature: string;
  occurrences: number;
  /** Mechanical, never a model's verdict: `failed` = a `dead_letter` in the subgraph, `open` = work
   *  still claimable or claimed, `complete` = everything settled or terminal by design. */
  outcomes: { complete: number; open: number; failed: number };
  successRate: number;
  medianDurationMs: number;
  /** The whole shape's wall-clock, summed across occurrences: `count x median` misestimates a
   *  skewed shape, and "which shape burns the most time" is the question a total exists for. */
  totalDurationMs: number;
  medianRecords: number;
  /** Totals for the caller's `sum` paths: `{ "usage.cost": { total, records } }`. Present only
   *  when sums were requested. `records` keeps an empty metric honest: a zero with records: 0 is
   *  "nothing here carries this field", not "this shape is free". */
  sums?: Record<string, { total: number; records: number }>;
  /** Roots of the newest occurrences, so a reader can go look at the thing itself. */
  exemplars: string[];
}

/** What mining produced. The RESPONSE adds what the handler knows and the miner does not
 *  (`FlowsResponse`). */
export interface FlowReport {
  granularity: "kind" | "kind+agent";
  counts: "bucketed" | "exact";
  flows: FlowShape[];
  scanned: { records: number; kinds: string[]; subgraphs: number };
  /** Subgraphs with a parent outside the scan, whose signature is therefore a FRAGMENT: the flow
   *  started somewhere this caller could not see, or before the record cap. */
  fragments: number;
  /** Records linked to nothing, excluded from `flows` unless asked for. Counted rather than
   *  dropped: a large number is a real finding (registry churn), just not a flow. */
  singletons: number;
  /** Hub records cut out so the work hanging off them could be mined separately. A non-zero count
   *  means the signatures below are the pieces, and the `X ⇒` prefix names what they hung from. */
  hubs: number;
  complete: boolean;
  notes?: string[];
}

/**
 * What `GET /v0/ops/flows` sends: the mined report, plus what only the handler knows.
 *
 * DEFINED HERE rather than restated in the client. The client's private copy had drifted three
 * ways: no `scope`, so a SCOPED caller could not see that the diagram covered only its own
 * records; and `granularity`/`counts` widened to `string`, so the unions the server actually sends
 * could not be narrowed on.
 */
export interface FlowsResponse extends FlowReport {
  /** Present when a grant narrowed the mining: a diagram of a slice, said so. */
  scope?: OpsScope;
  /** Present when nothing was mined: why an empty diagram is not the same as no work. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Event chain (tamper evidence)
// ---------------------------------------------------------------------------

/** One record in a relationship graph (`/v0/ops/records/{id}/graph`). A projection, not a record:
 *  enough to draw and label a node, with the body fetched by id when a reader opens one. */
export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  taint: string[]; // classification labels (see design-taint.md)
  delegated: number; // delegation-chain length (0 = root/operator work)
}

/** What a verification found. `ok` is the only field a caller should branch on. */
export interface IntegrityReport {
  /** Set when only a SUFFIX was walked (`verifyIntegrity({tail})`): the first idx checked. `ok`
   *  then means "nothing below this was altered", and says nothing about the links beneath it. */
  spotCheckedFrom?: number;
  ok: boolean;
  /** Links checked in this pass. */
  checked: number;
  /** Chain length, so "0 checked" cannot read as "verified". */
  sealed: number;
  /** Events committed but not yet sealed. Not a fault: sealing follows the watermark. */
  unsealed: number;
  head?: { idx: number; hash: string };
  /** Present only when the chain is signed. `false` means a link's signature did not verify, which
   *  is the case a bare chain cannot distinguish from an honest rebuild. */
  signed: boolean;
  /**
   * Present when the chain begins past genesis: event GC's anchor state. `swept` counts events
   * whose content is gone (`anchorIdx` links below the anchor, plus the anchor's own event once
   * the sweep completes); the anchor's dense idx is what makes it exact. `attested` means the
   * retained suffix carries a sealed horizon statement covering the anchor, so the truncation is
   * the one the sweep declared; without it `ok` is false (`unattested_truncation`). On an
   * unsigned chain an attestation is naive-edit evidence only, like the chain itself.
   */
  truncated?: { anchorIdx: number; swept: number; attested: boolean };
  failure?: {
    idx: number;
    eventId: string;
    reason: "hash_mismatch" | "broken_link" | "missing_event" | "bad_signature" | "unknown_key" | "gap" | "unattested_truncation";
    detail: string;
  };
}

/**
 * What `GET /v0/ops/integrity` sends: the report, plus the prose the handler adds for the states a
 * boolean cannot carry.
 *
 * DEFINED HERE rather than restated in the client, which is the rule for every shape crossing
 * `/v0` and the one this response broke: the client's private copy was missing `spotCheckedFrom`
 * and `unsealedNote`, so an SDK caller could not tell a tail spot-check from a full audit. The CLI
 * had the same defect against the same field once, and its fix is recorded at the top of
 * `src/surfaces/cli.ts`.
 */
export interface IntegrityResponse extends IntegrityReport {
  /** Present when the chain is UNSIGNED: what that does and does not detect. */
  note?: string;
  /** Present when events are committed but not yet sealed: why that is normal. */
  unsealedNote?: string;
  /** Present when the chain begins past genesis: what was swept, and whether it is attested. */
  truncatedNote?: string;
}

/** The predecessor of the first sealed event. */
export const CHAIN_GENESIS = "0".repeat(64);

/** One event's link in the chain. `bodySha256` is what ties the chain to record CONTENT: without
 *  it the chain proves the events happened in this order and says nothing about whether a record
 *  body is still what it was, which is the wrong half of the guarantee. */
export interface ChainedEvent {
  index: number;
  id: Ulid;
  ts: string;
  runId: string;
  operation: string;
  recordId?: string;
  kind?: string;
  state?: string;
  bodySha256?: string;
  detail?: Record<string, unknown>;
}

/**
 * Canonical JSON: sorted keys, recursive, no whitespace.
 *
 * `detail` is free-form JSON from callers, so it is the field that finds every hole in a naive
 * encoder. Key ORDER in particular is insertion order in JS, which means the same logical event
 * hashes two ways depending on how the object was built.
 */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Length-delimited so no value can impersonate a field boundary, and `-` for ABSENT so a missing
 *  field and an empty string are different bytes. */
function frame(v: string | undefined): string {
  if (v === undefined || v === null) return "-";
  return `${new TextEncoder().encode(v).length}:${v}`;
}

/**
 * NORMATIVE. The exact bytes an event contributes to the chain.
 *
 * In the wire vocabulary rather than the runtime for the same reason as `kindDefKey`: a chain only
 * one implementation can compute is a chain nobody can verify, and the whole point of the artifact
 * is that someone other than the writer can check it. Any implementation must produce these bytes.
 */
export function canonicalEvent(e: ChainedEvent): string {
  return [
    frame(String(e.index)),
    frame(e.id),
    frame(e.ts),
    frame(e.runId),
    frame(e.operation),
    frame(e.recordId),
    frame(e.kind),
    frame(e.state),
    frame(e.bodySha256),
    frame(e.detail === undefined ? undefined : canonicalJson(e.detail)),
  ].join("|");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** NORMATIVE. `H(prev || canonical(event))`. The index is inside the canonical form, so reordering
 *  two seals breaks both links rather than silently producing a valid-looking chain. */
export function eventHash(prevHash: string, e: ChainedEvent): Promise<string> {
  return sha256Hex(`${prevHash}|${canonicalEvent(e)}`);
}
