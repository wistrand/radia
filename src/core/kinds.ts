// Per-kind indexing contract (control-plane). A kind declares which body paths are
// indexed (typed) and which are sortable. Registration VALIDATES the declaration, and
// pattern compilation (core/matching.ts) validates predicates against it: a predicate on
// an undeclared path, or order_by on a non-sortable path, is a registration error.
//
// The in-memory registry is a per-Space cache. Declarations are NOT a side table: each is a
// record of the reserved `kind_def` kind (body = a KindDef), committed through the normal
// `put` path, discoverable by query, and watchable like any record. `Space.loadKinds` rebuilds
// the cache at startup by querying those records (latest per kind wins; a redeclaration is a
// successor record, not a mutation). The one bootstrap is the `kind_def` meta-kind itself,
// registered in code (META_KIND_DEF) so a query for `kind_def` records can compile. Still
// deferred: the physical expression indexes for declared paths (predicate pushdown). The
// semantic oracle, not an index, defines correctness. See
// agent_docs/plan-m0-implementation.md Phase 2 and agent_docs/design-matching.md.

import { RadiaError } from "./errors.ts";

// The wire vocabulary is DEFINED in `sdk/ts/wire.ts` and re-exported here, so every import
// path inside `src/` is unchanged while the SDK ships without reaching back into the runtime.
// See that file's header for why the direction runs this way.
import type {
  IndexedPath,
  IndexedType,
  KindDef,
} from "../../sdk/ts/wire.ts";
export type {
  IndexedPath,
  IndexedType,
  KindDef,
};

/** The reserved kind whose records ARE kind declarations (body = a KindDef). */
// KIND_DEF and kindDefKey live in the wire vocabulary: a CLIENT writes kind declarations, and
// the idempotency key has to be computed identically on both sides or a redeclaring fleet appends a
// duplicate record per startup.
export { KIND_DEF, kindDefKey } from "../../sdk/ts/wire.ts";
import {
  AGENT_DEFINITION as WIRE_AGENT_DEFINITION,
  AGENT_RUN as WIRE_AGENT_RUN,
  ARTIFACT as WIRE_ARTIFACT,
  GRANT as WIRE_GRANT,
  INTEREST as WIRE_INTEREST,
  KIND_DEF,
  OPS_GRANT as WIRE_OPS_GRANT,
  SHRED as WIRE_SHRED,
  SIGNAL as WIRE_SIGNAL,
} from "../../sdk/ts/wire.ts";

/** Reserved kind whose records ARE authorization grants (body = a GrantDef). */
export const GRANT = WIRE_GRANT;

/** Reserved control kind: operator/supervisor broadcasts (grant-management adjacent). */
export const SIGNAL = WIRE_SIGNAL;

/** Reserved kind: an agent definition (body {agent, tokenHash}) that mints runs. */
export const AGENT_DEFINITION = WIRE_AGENT_DEFINITION;

/** Reserved kind: an agent run instance (body {run, agent, tokenHash, status, expiresAt}). */
export const AGENT_RUN = WIRE_AGENT_RUN;

/** Reserved kind: a reference to bytes held in the blob store (body = an ArtifactDef). The RECORD
 *  is the artifact as far as coordination is concerned: it routes, carries taint and lineage, and
 *  is grant-gated like anything else; only the payload lives outside. */
export const ARTIFACT = WIRE_ARTIFACT;
/** A destroyed payload: `{digest, reason, at}`. Written when a blob is crypto-shredded, so a reader
 *  can tell "erased" from "never existed". Write-protected: a forged shred marker would make live
 *  bytes look destroyed, which is the one lie this record exists to prevent. */
export const SHRED = WIRE_SHRED;

/**
 * Reserved kind: what a run is currently listening for (body `{kind, match?}`).
 *
 * Standing interest is otherwise invisible to the substrate. A worker declares it by polling `take`
 * with a pattern the space never retains, so the space can show every past hop and cannot say who
 * would receive the next record. That is the whole reason "where is the workflow?" has no answer.
 *
 * DESCRIPTIVE, never authorization. Publishing an interest in a kind grants nothing; the grant
 * records still decide. So this is deliberately NOT write-protected: a run publishes its own, and
 * the author is the server-assigned `created_by` rather than anything the body claims.
 *
 * LIVENESS COMES FROM THE RUN, not from this record. A clean shutdown retires the interest, but a
 * crashed worker never gets to, so a reader must treat an interest whose run has stopped or expired
 * as dead. Never use the presence of an interest record as proof that anyone is listening.
 */
export const INTEREST = WIRE_INTEREST;

/** Reserved kind: an ops-plane power assignment (body = an OpsGrantDef). The tier between
 *  self-scoped reads and the full operator bit; see architecture-ops-tiers.md and design-auth.md
 *  "The operator bit". Assigned by a config operator, additive, retired to revoke. */
export const OPS_GRANT = WIRE_OPS_GRANT;

/**
 * The closed ops-power vocabulary (design-auth.md "The operator bit", powers 1–5). Powers 6
 * (identity root: grant/signal/agent_* writes, minting, revoke) and 7 (coordination bypass) are
 * deliberately NOT here and never will be: a tier holding 6 is the full tier with extra steps,
 * and an observer that can also write ungranted records is not one. Extend only when a real
 * failure names the next power.
 */
export const OPS_POWERS = ["observe", "remediate", "sweep", "declassify", "purge"] as const;
export type OpsPower = (typeof OPS_POWERS)[number];

/** Body of an `ops_grant` record. `operations` mirrors the grant field name on purpose, so the
 *  console and `effectivePermissions` render both registries the same way. */
export interface OpsGrantDef {
  principal: string;
  operations: OpsPower[];
}

/** Validate an ops_grant body. Throws RadiaError. The privileged-principal refusal lives in
 *  `Space.validateReservedBody` (it needs the context's operator set). */
export function validateOpsGrantDef(def: OpsGrantDef): void {
  if (typeof def.principal !== "string" || def.principal.length === 0) {
    throw new RadiaError("invalid_ops_grant", "ops_grant.principal must be a non-empty string");
  }
  if (!Array.isArray(def.operations) || def.operations.length === 0) {
    throw new RadiaError("invalid_ops_grant", "ops_grant.operations must be a non-empty array");
  }
  for (const op of def.operations) {
    if (!(OPS_POWERS as readonly string[]).includes(op)) {
      throw new RadiaError(
        "invalid_ops_grant",
        `unknown ops power '${op}' (expected ${OPS_POWERS.join(", ")}); identity and grant writes are never a power`,
      );
    }
  }
}

/** Reserved kinds only an OPERATOR may write directly (assigned, never self-declared), with one
 *  carve-out in `Space.authorize`: the supervisor may put `grant`/`signal`, its entire remaining
 *  privilege. Runs/definitions are also written internally by the bootstrap endpoints. */
export const WRITE_PROTECTED_KINDS = new Set<string>([GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN, SHRED, OPS_GRANT]);

/**
 * Kinds whose appearance in the event log means somebody's authorization may have just changed.
 * A long-lived reader (the watch SSE stream) re-derives its scope when one goes by, so the event
 * log is the revocation signal and no separate invalidation channel exists.
 *
 * DERIVED from `WRITE_PROTECTED_KINDS` rather than listed, and the direction matters. Over-inclusion
 * costs one wasted registry read (`shred` changes no authorization); under-inclusion is a revoked
 * grant that keeps streaming. Any kind that can change authorization must be write-protected, so
 * this set cannot be too small without the other one being wrong first.
 */
export const AUTHORIZATION_KINDS: ReadonlySet<string> = WRITE_PROTECTED_KINDS;

/**
 * The closed taint vocabulary: a classification some policy BARS, never a note about origin.
 *
 * Provenance is already in the log (`parent_ids` + `created_by`), so a label that merely records
 * where content came from is a denormalised copy of a graph fact. The test for adding one is not
 * "is it true of the record" but "is it tested where walking the log is too expensive": the barrier
 * runs inside `take`, per candidate, where a lineage walk costs ~125x the claim itself. Everything
 * else is asked once, after the fact, and belongs in the log. See design-taint.md.
 *
 * Adding a label requires naming the policy that tests it AT CLAIM TIME. Three is not a placeholder.
 */
export const TAINT_LABELS = ["file", "net", "foreign"] as const;
export type TaintLabel = (typeof TAINT_LABELS)[number];

/** Carried by records written before labels existed: the space cannot know what they touched, so
 *  they get a label no allowlist may contain and are claimable by nothing that states a barrier. */
export const TAINT_UNKNOWN = "unknown";

const VALID_TAINT = new Set<string>([...TAINT_LABELS, TAINT_UNKNOWN]);

/**
 * Normalize a label set: sorted, deduplicated, validated. An unrecognized label is REFUSED rather
 * than dropped; silently ignoring one would let a caller believe it had restricted a record that is
 * in fact unrestricted.
 *
 * `unknown` is RESERVED and refused by default, because the sentence above it only holds if no
 * allowlist can name it: it was accepted anywhere a label was, so a grant could say
 * `scope: {taint: "unknown"}` and claim exactly the pre-labels records the marker exists to hold
 * back. `reserved: true` is for the two server paths that legitimately handle it — a legacy
 * record's stored labels travelling back out, and an operator declassifying the marker itself.
 */
export function normalizeTaint(
  labels: readonly string[] | undefined,
  opts: { reserved?: boolean } = {},
): string[] {
  if (!labels || labels.length === 0) return [];
  const out = new Set<string>();
  for (const l of labels) {
    if (!VALID_TAINT.has(l)) {
      throw new RadiaError("invalid_taint", `unknown taint label '${l}'; the vocabulary is ${[...TAINT_LABELS].join(", ")}`);
    }
    if (l === TAINT_UNKNOWN && !opts.reserved) {
      throw new RadiaError(
        "invalid_taint",
        `'${TAINT_UNKNOWN}' is reserved: it marks records written before labels existed, so nothing ` +
          `a client states may name it. A barrier that admits it admits every such record.`,
      );
    }
    out.add(l);
  }
  return [...out].sort();
}

/**
 * The labels a grant's `scope.taint` ALLOWS. `"none"` is the empty allowlist.
 *
 * An allowlist rather than a blocklist, and that is the load-bearing choice: a label introduced
 * later is barred by every existing grant automatically, where a blocklist would silently permit
 * it. It also composes correctly with the union rule, since two grants widen to the union of what
 * they allow, which is what "these grants together permit" should mean.
 */
export function parseTaintAllowlist(value: string): string[] {
  if (value === "none") return [];
  return normalizeTaint(value.split(",").map((v) => v.trim()).filter(Boolean));
}

/**
 * Labels from a client, as a JSON array or a comma-separated header. Anything unrecognized is
 * refused by `normalizeTaint`; `undefined` means the client stated nothing.
 *
 * `reserved` marks the RAISE direction, where `unknown` is allowed. The asymmetry is the taint
 * model's own: raising is monotone, so a client marking its record unclassifiable only narrows who
 * will claim it, which is its own foot. An ALLOWLIST widens, so it may never name the reserved
 * label — that is the direction that turns the pre-labels marker into no marker at all.
 */
export function clientTaint(raw: unknown, opts: { reserved?: boolean } = {}): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  // An EMPTY ARRAY is not absence. As a raise it means "no labels", and as an allowlist it means
  // "accept nothing classified" — which is the strictest barrier there is. Collapsing it to
  // `undefined` turned the strictest possible request into no barrier at all.
  if (Array.isArray(raw)) return normalizeTaint(raw.map(String), opts);
  // A comma list, for headers, which can only carry strings. An empty one is absence.
  if (typeof raw === "string") {
    const parts = raw.split(",").map((v) => v.trim()).filter(Boolean);
    return parts.length === 0 ? undefined : normalizeTaint(parts, opts);
  }
  throw new RadiaError("invalid_taint", "taint must be an array of labels");
}

/** The coordination operations a grant can authorize. */
export type GrantOp = "put" | "take" | "query" | "read_one";
const VALID_OPS = new Set<GrantOp>(["put", "take", "query", "read_one"]);

/** The envelope-side selectors a grant may carry. Closed by design; extended only when a real
 *  failure names the field it needs (see design-auth.md, "Self-scoped ops grants"). */
// The envelope-side selector vocabulary. Each key has its OWN value vocabulary: `createdBy`
// narrows to the principal ("self"), while `taint` is a classification barrier whose only value is
// "none". Keep this closed; an unknown key or value must fail rather than be ignored.
//
// `leaseOwner: "self"` is DESIGNED (design-auth.md's selector table: "records my RUN currently
// holds") and NOT BUILT, so it is refused here rather than accepted. Accepting it was the worse of
// the two: `authorScope` restricts only when every applicable grant says `createdBy: "self"`, so a
// grant carrying `leaseOwner` alone read as UNRESTRICTED — an operator wrote a narrowing scope and
// got no narrowing, silently, in the direction that widens. Enforcing it needs an envelope-side
// filter on `lease_owner` in every read verb, which means the storage port (a query reads `records`
// and would have to join `record_runtime`), so it is a feature to build rather than a line to add.
const VALID_SCOPE_VALUES = new Map<string, Set<string>>([
  ["createdBy", new Set(["self"])],
  // `taint` is the odd one out: its value is an ALLOWLIST, not a fixed token, so it is validated by
  // `parseTaintAllowlist` in `validateGrantDef` rather than by membership here. "none" is listed so
  // the common case reads the same as the other keys.
  ["taint", new Set(["none"])],
]);

/** A kind-scoped authorization grant. Never wildcard; assigned by a privileged writer. */
export interface GrantDef {
  principal: string; // the principal the grant is FOR (e.g. agent:summarizer, run:...)
  kind: string; // the concrete record kind it applies to; never "*"
  operations: GrantOp[]; // which coordination verbs on that kind
  /** Envelope-side scope, e.g. `{createdBy: "self"}` or `{taint: "none"}` (see design-auth.md).
   *  Distinct from `pattern`, which is a BODY match: the envelope fields a scope selects on are
   *  precisely the ones the routing language is forbidden to see. `taint` is a claim barrier an
   *  OPERATOR imposes, so containment stops depending on the worker asking for it: its value is an
   *  ALLOWLIST of labels (`"none"`, or `"file"`, or `"file,net"`), and a record carrying anything
   *  outside it cannot be claimed. Allowlist rather than blocklist so a label added later is barred
   *  by every existing grant instead of silently permitted. */
  scope?: Record<string, string>;
  /** Optional pattern-scope: a match object AND-ed into the principal's read/take on this kind
   *  (the effective query is `grant ∧ request`). Omitted → the whole kind. Applies to
   *  query/read_one/take; put ignores it. Its paths must be declared indexed paths of the kind
   *  (validated when a query compiles, not at grant creation, since the kind may not exist yet). */
  pattern?: Record<string, unknown>;
}

/** Validate a grant body. Throws RadiaError. Rejects wildcard kinds (kind-scoped invariant). */
export function validateGrantDef(def: GrantDef): void {
  if (typeof def.principal !== "string" || def.principal.length === 0) {
    throw new RadiaError("invalid_grant", "grant.principal must be a non-empty string");
  }
  if (typeof def.kind !== "string" || def.kind.length === 0) {
    throw new RadiaError("invalid_grant", "grant.kind must be a non-empty string");
  }
  if (def.kind === "*" || def.kind.includes("*")) {
    throw new RadiaError("wildcard_grant", "grants are kind-scoped; wildcard kinds are never allowed");
  }
  if (!Array.isArray(def.operations) || def.operations.length === 0) {
    throw new RadiaError("invalid_grant", "grant.operations must be a non-empty array");
  }
  for (const op of def.operations) {
    if (!VALID_OPS.has(op)) {
      throw new RadiaError("invalid_grant", `unknown grant operation '${op}'`);
    }
  }
  if (def.pattern !== undefined && (def.pattern === null || typeof def.pattern !== "object" || Array.isArray(def.pattern))) {
    throw new RadiaError("invalid_grant", "grant.pattern must be a match object");
  }
  // `scope` is the ENVELOPE-side selector (self-scoped ops), a closed vocabulary deliberately kept
  // out of `pattern`, which stays a body match compiled by the same oracle. Validated strictly
  // rather than ignored: an unknown key or value here fails closed (the grant simply opens
  // nothing), and a silent no-op on an authorization record is exactly the thing that gets
  // mistaken for a working grant.
  if (def.scope !== undefined) {
    const scope = def.scope as Record<string, unknown>;
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      throw new RadiaError("invalid_grant", "grant.scope must be an object");
    }
    for (const [key, value] of Object.entries(scope)) {
      const allowed = VALID_SCOPE_VALUES.get(key);
      if (!allowed) {
        throw new RadiaError(
          "invalid_grant",
          `unknown grant scope '${key}' (expected ${[...VALID_SCOPE_VALUES.keys()].join(", ")})`,
        );
      }
      if (typeof value !== "string") {
        throw new RadiaError("invalid_grant", `grant.scope.${key} must be a string`);
      }
      // `taint` carries an ALLOWLIST rather than a fixed token, so it validates its own value.
      // A typo must be a registration error, never a grant that quietly allows nothing.
      if (key === "taint") {
        parseTaintAllowlist(value);
        continue;
      }
      if (!allowed.has(value)) {
        throw new RadiaError(
          "invalid_grant",
          `grant.scope.${key} must be one of ${[...allowed].map((v) => `"${v}"`).join(", ")}`,
        );
      }
    }
  }
}

const VALID_TYPES = new Set<IndexedType>([
  "keyword",
  "integer",
  "number", // fractional: a provider's cost, a score. See `IndexedType` in sdk/ts/wire.ts.
  "timestamp",
  "array",
]);

/** A kind is claimable (work) unless it explicitly declares `claimable: false` (reference data). */
export function isClaimable(def: KindDef | undefined): boolean {
  return def?.claimable !== false;
}

/** The self-describing declaration of the `kind_def` meta-kind. Registered in code (the one
 *  bootstrap) so `query {kind: kind_def}` compiles; its records are all other declarations. */
export const META_KIND_DEF: KindDef = {
  kind: KIND_DEF,
  indexedPaths: [{ path: "kind", type: "keyword" }],
  claimable: false, // kind declarations are reference records, never taken
};

/** Declarations of the reserved control kinds, registered in code (bootstrap) so their own
 *  records can be queried. `grant` is indexed on principal+kind so the authorizer can look up
 *  a principal's grants for a kind directly. */
/** The body of an `artifact` record: what the bytes are, never the bytes. */
export interface ArtifactDef {
  digest: string; // sha256 of the plaintext bytes: integrity, and the blob store's address
  mediaType: string; // validated against MEDIA_TYPE_RE on write
  size: number; // bytes
  filename?: string; // advisory, for downloads; never used as a path
}

/** A conservative `type/subtype` with optional suffix/parameters stripped by the caller. Keeps a
 *  client-supplied string out of response headers unchecked. */
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i;

/** Validate an artifact body. Throws RadiaError. The digest/size are server-assigned (the blob
 *  store computes them), so this guards the client-supplied parts. */
export function validateArtifactDef(def: ArtifactDef): void {
  if (typeof def.mediaType !== "string" || !MEDIA_TYPE_RE.test(def.mediaType)) {
    throw new RadiaError("invalid_artifact", `artifact.mediaType must be a simple type/subtype, got '${def.mediaType}'`);
  }
  if (def.filename !== undefined && (typeof def.filename !== "string" || def.filename.length > 255 || /[\r\n"\\/]/.test(def.filename))) {
    throw new RadiaError("invalid_artifact", "artifact.filename must be a short name without path separators or quotes");
  }
}

/** Field names the runtime owns on an artifact body. An application may add its own alongside them
 *  (see `Space.putArtifact`), but not redefine these: they are computed from the bytes. */
const ARTIFACT_RESERVED_FIELDS = ["digest", "mediaType", "size", "filename"];

/**
 * Validate the application half of an artifact body.
 *
 * Kept narrow on purpose. The point is to let an app scope artifacts it owns (a grant pattern
 * matches the body, so without an app field there is nothing to bind), not to turn the artifact
 * record into a second payload. The bytes live in the blob store precisely so bodies stay small
 * and matchable.
 */
export function validateArtifactFields(fields: unknown): void {
  if (fields === undefined) return;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new RadiaError("invalid_artifact", "artifact metadata must be an object of field → value");
  }
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (ARTIFACT_RESERVED_FIELDS.includes(key)) {
      throw new RadiaError("invalid_artifact", `artifact field '${key}' is computed by the runtime and cannot be supplied`);
    }
    const t = typeof value;
    if (value !== null && t !== "string" && t !== "number" && t !== "boolean") {
      throw new RadiaError("invalid_artifact", `artifact metadata field '${key}' must be a string, number, boolean or null`);
    }
    if (typeof value === "string" && value.length > 256) {
      throw new RadiaError("invalid_artifact", `artifact metadata field '${key}' is too long (max 256 characters)`);
    }
  }
}

/** Kinds defined in CODE, not as `kind_def` records. That is why they never appear in
 *  `listKinds()`, which reads those records. Anything asking "does this kind exist" must consider these too. */
export { RESERVED_KINDS } from "../../sdk/ts/wire.ts";

export const META_RESERVED: KindDef[] = [
  META_KIND_DEF,
  {
    kind: GRANT,
    indexedPaths: [{ path: "principal", type: "keyword" }, { path: "kind", type: "keyword" }],
    claimable: false,
  },
  { kind: SIGNAL, indexedPaths: [{ path: "topic", type: "keyword" }], claimable: false },
  // `tokenHash` is indexed so a credential cache-miss can hydrate one record by hash from storage
  // (see Space.resolveToken fallback) instead of failing.
  { kind: AGENT_DEFINITION, indexedPaths: [{ path: "agent", type: "keyword" }, { path: "tokenHash", type: "keyword" }], claimable: false },
  {
    kind: AGENT_RUN,
    indexedPaths: [{ path: "run", type: "keyword" }, { path: "agent", type: "keyword" }, { path: "tokenHash", type: "keyword" }],
    claimable: false,
  },
  // Indexed on `kind`: the dry-run matcher asks "which interests target the kind of this record",
  // so that is the only lookup on the path. The pattern itself stays an opaque body field, since
  // nothing queries by it; it is compiled and evaluated, never matched against.
  { kind: INTEREST, indexedPaths: [{ path: "kind", type: "keyword" }], claimable: false },
  { kind: SHRED, indexedPaths: [{ path: "digest", type: "keyword" }], claimable: false },
  // Indexed on principal: the ops gate reads one principal's powers per request.
  { kind: OPS_GRANT, indexedPaths: [{ path: "principal", type: "keyword" }], claimable: false },
  // Indexed on digest (find every record referencing the same bytes) and mediaType (route by what
  // it is: an image worker claims `{mediaType: "image/png"}` without a routing table).
  {
    kind: ARTIFACT,
    indexedPaths: [{ path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }],
    claimable: false,
  },
];

/** The code-defined contract for a reserved kind, by name. */
const META_RESERVED_BY_KIND = new Map(META_RESERVED.map((d) => [d.kind, d]));

/**
 * A reserved kind may be EXTENDED by a redeclaration, never SHRUNK.
 *
 * `META_RESERVED` is not decoration: `authorize` compiles patterns against `grant.principal`/
 * `grant.kind`, and credential resolution against `agent_definition.tokenHash`. Drop one of those
 * paths and every authorization fails `undeclared_path` (fail-closed, but space-wide) until someone
 * finds the successor record. That needed no operator, only an ordinary `put: kind_def` grant, which
 * is the point: a grant scoped to one app kind is not a licence to rewrite the auth schema.
 *
 * Refusing the SHRINK rather than the kind is what keeps this narrow. Adding an index to `artifact`
 * stays a legal thing for an app to do, and the auth-critical paths stay undroppable. `claimable` is
 * pinned too, since flipping `grant` to claimable turns authorization state into work.
 *
 * Checked on every path a declaration can enter by (`put`, `ack`, `loadKinds`, `refreshKind`), NOT
 * only the write: a declaration written before this rule existed is still sitting in the log, and
 * startup adopting it is exactly how the damage persisted across restarts.
 */
export function assertReservedCompatible(def: KindDef): void {
  const required = META_RESERVED_BY_KIND.get(def.kind);
  if (!required) return; // an app-owned kind is freely redeclarable
  const declared = new Map((def.indexedPaths ?? []).map((p) => [p.path, p.type]));
  for (const need of required.indexedPaths) {
    if (declared.get(need.path) !== need.type) {
      throw new RadiaError(
        "reserved_kind",
        `'${def.kind}' is a reserved kind: a redeclaration must keep the indexed path ` +
          `'${need.path}' (${need.type}) the runtime compiles against`,
      );
    }
  }
  if (required.claimable !== undefined && def.claimable !== required.claimable) {
    throw new RadiaError(
      "reserved_kind",
      `'${def.kind}' is a reserved kind: 'claimable' is fixed at ${required.claimable}`,
    );
  }
}

function validPath(path: string): boolean {
  // Dotted segments only; no empty segment (rejects "", "a.", ".a", "a..b"). Literal dots
  // in a key are impossible by construction: dots are the path separator.
  return path.length > 0 && path.split(".").every((s) => s.length > 0);
}

/** Validate a declaration. Throws RadiaError on any problem (a registration error). */
export function validateKindDef(def: KindDef): void {
  if (typeof def.kind !== "string" || def.kind.length === 0) {
    throw new RadiaError("invalid_kind", "kind must be a non-empty string");
  }
  const seen = new Set<string>();
  for (const ip of def.indexedPaths ?? []) {
    if (!validPath(ip.path)) {
      throw new RadiaError("invalid_path", `invalid indexed path '${ip.path}'`);
    }
    if (!VALID_TYPES.has(ip.type)) {
      throw new RadiaError(
        "invalid_type",
        `unknown type '${ip.type}' for path '${ip.path}'`,
      );
    }
    if (seen.has(ip.path)) {
      throw new RadiaError(
        "duplicate_path",
        `indexed path '${ip.path}' declared more than once`,
      );
    }
    seen.add(ip.path);
  }
  for (const sp of def.sortablePaths ?? []) {
    if (!seen.has(sp)) {
      throw new RadiaError(
        "unsortable_path",
        `sortable path '${sp}' is not a declared indexed path`,
      );
    }
  }
  if (def.claimable !== undefined && typeof def.claimable !== "boolean") {
    throw new RadiaError("invalid_type", "kind.claimable must be a boolean");
  }
  // A compaction key over a path nobody can address is a key that silently never matches, so it is
  // held to the same path grammar as everything else. It need NOT be an indexed path: the key is
  // read per record during compaction, never matched by the planner.
  for (const ck of def.contentKey ?? []) {
    if (!validPath(ck)) {
      throw new RadiaError("invalid_path", `invalid contentKey path '${ck}'`);
    }
  }
  if (def.contentKey !== undefined && def.contentKey.length === 0) {
    throw new RadiaError("invalid_kind", "contentKey must be omitted or non-empty: an empty key would make every record one identity");
  }
  if (def.defaultRetentionSeconds !== undefined) {
    const n = def.defaultRetentionSeconds;
    // A zero or negative default would stamp every record already-expired at commit: not a
    // retention policy, a kind whose records exist only until somebody sweeps. Refused rather than
    // supported, because nothing honest wants it and everything confused produces it.
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new RadiaError("invalid_kind", `defaultRetentionSeconds must be a positive finite number, got '${n}'`);
    }
  }
}

export class KindRegistry {
  #defs = new Map<string, KindDef>();

  register(def: KindDef): void {
    validateKindDef(def);
    this.#defs.set(def.kind, {
      kind: def.kind,
      indexedPaths: [...def.indexedPaths],
      sortablePaths: [...(def.sortablePaths ?? [])],
      ...(def.claimable !== undefined ? { claimable: def.claimable } : {}),
      // Copied explicitly, like every field here: this copy is a WHITELIST, and a field left out
      // of it is silently dropped from every registered kind — which is how `contentKey` would
      // have vanished between declaration and compaction.
      ...(def.contentKey !== undefined ? { contentKey: [...def.contentKey] } : {}),
      ...(def.defaultRetentionSeconds !== undefined ? { defaultRetentionSeconds: def.defaultRetentionSeconds } : {}),
    });
  }

  get(kind: string): KindDef | undefined {
    return this.#defs.get(kind);
  }

  has(kind: string): boolean {
    return this.#defs.has(kind);
  }

  list(): KindDef[] {
    return [...this.#defs.values()];
  }
}
