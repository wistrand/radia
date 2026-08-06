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
// `conformance/layering.test.ts` enforces the direction.

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

/** What a client submits. Authoritative fields are absent BY CONSTRUCTION: there is no slot for
 *  `created_by`, `taint` beyond a raise, or any lease field, so a client cannot claim one. */
export interface PutRequest {
  kind: string;
  body: unknown;
  /** Client claims: confidence, requested_priority, app fields. Preserved, never trusted. */
  clientMeta?: Record<string, unknown>;
  /** Data/causality lineage the client asserts. All must exist at commit (checked in put). */
  parentIds?: string[];
  deadlineAt?: string;
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
export interface Page {
  after?: Ulid;
  dir?: "asc" | "desc"; // default "asc"
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

export type IndexedType = "keyword" | "integer" | "timestamp" | "array";

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
export const RESERVED_KINDS = [KIND_DEF, GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN, ARTIFACT, INTEREST, SHRED];

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

// ---------------------------------------------------------------------------
// Event chain (tamper evidence)
// ---------------------------------------------------------------------------

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
