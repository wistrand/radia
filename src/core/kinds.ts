// Per-kind indexing contract (control-plane). A kind declares which body paths are
// indexed (typed) and which are sortable. Registration VALIDATES the declaration, and
// pattern compilation (core/matching.ts) validates predicates against it: a predicate on
// an undeclared path, or order_by on a non-sortable path, is a registration error.
//
// The in-memory registry is a per-Space cache. Declarations are NOT a side table: each is a
// record of the reserved `kind_def` kind (body = a KindDef), committed through the normal
// `put` path, discoverable by query, and watchable like any record. `Space.loadKinds` rebuilds
// the cache at startup by querying those records (latest per kind wins — a redeclaration is a
// successor record, not a mutation). The one bootstrap is the `kind_def` meta-kind itself,
// registered in code (META_KIND_DEF) so a query for `kind_def` records can compile. Still
// deferred: the physical expression indexes for declared paths (predicate pushdown) — the
// semantic oracle, not an index, defines correctness. See
// agent_docs/plan-m0-implementation.md Phase 2 and agent_docs/design-matching.md.

import { RadiaError } from "./errors.ts";

/** The reserved kind whose records ARE kind declarations (body = a KindDef). */
export const KIND_DEF = "kind_def";

/** Reserved kind whose records ARE authorization grants (body = a GrantDef). */
export const GRANT = "grant";

/** Reserved control kind: operator/supervisor broadcasts (grant-management adjacent). */
export const SIGNAL = "signal";

/** Reserved kind: an agent definition (body {agent, tokenHash}) — mints runs. */
export const AGENT_DEFINITION = "agent_definition";

/** Reserved kind: an agent run instance (body {run, agent, tokenHash, status, expiresAt}). */
export const AGENT_RUN = "agent_run";

/** Reserved kind: a reference to bytes held in the blob store (body = an ArtifactDef). The RECORD
 *  is the artifact as far as coordination is concerned — it routes, carries taint and lineage, and
 *  is grant-gated like anything else; only the payload lives outside. */
export const ARTIFACT = "artifact";

/** Reserved kinds only a human/supervisor principal may write directly (assigned, never
 *  self-declared). Runs/definitions are also written internally by the bootstrap endpoints. */
export const WRITE_PROTECTED_KINDS = new Set<string>([GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN]);

/** The coordination operations a grant can authorize. */
export type GrantOp = "put" | "take" | "query" | "read_one";
const VALID_OPS = new Set<GrantOp>(["put", "take", "query", "read_one"]);

/** The envelope-side selectors a grant may carry. Closed by design — extended only when a real
 *  failure names the field it needs (see design-auth.md, "Self-scoped ops grants"). */
const VALID_SCOPE_KEYS = new Set(["createdBy", "leaseOwner"]);

/** A kind-scoped authorization grant. Never wildcard; assigned by a privileged writer. */
export interface GrantDef {
  principal: string; // the principal the grant is FOR (e.g. agent:summarizer, run:...)
  kind: string; // the concrete record kind it applies to — never "*"
  operations: GrantOp[]; // which coordination verbs on that kind
  /** Envelope-side self scope, e.g. `{createdBy: "self"}` — see design-auth.md. Distinct from
   *  `pattern`, which is a BODY match: the fields a self-scope needs are precisely the ones the
   *  routing language is forbidden to see. */
  scope?: Record<string, "self">;
  /** Optional pattern-scope: a match object AND-ed into the principal's read/take on this kind
   *  (the effective query is `grant ∧ request`). Omitted → the whole kind. Applies to
   *  query/read_one/take; put ignores it. Its paths must be declared indexed paths of the kind
   *  (validated when a query compiles, not at grant creation — the kind may not exist yet). */
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
  // out of `pattern` — which stays a body match compiled by the same oracle. Validated strictly
  // rather than ignored: an unknown key or value here fails closed (the grant simply opens
  // nothing), and a silent no-op on an authorization record is exactly the thing that gets
  // mistaken for a working grant.
  if (def.scope !== undefined) {
    const scope = def.scope as Record<string, unknown>;
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      throw new RadiaError("invalid_grant", "grant.scope must be an object");
    }
    for (const [key, value] of Object.entries(scope)) {
      if (!VALID_SCOPE_KEYS.has(key)) {
        throw new RadiaError("invalid_grant", `unknown grant scope '${key}' (expected ${[...VALID_SCOPE_KEYS].join(", ")})`);
      }
      if (value !== "self") {
        throw new RadiaError("invalid_grant", `grant.scope.${key} must be "self"`);
      }
    }
  }
}

export type IndexedType = "keyword" | "integer" | "timestamp" | "array";

const VALID_TYPES = new Set<IndexedType>([
  "keyword",
  "integer",
  "timestamp",
  "array",
]);

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
   *  data (facts, config, history — written once, read by `query`, never taken). Default true.
   *  `false` opts the kind out of the starvation check: a reference record sitting `available`
   *  forever is normal, not stale work. See `Space.diagnostics`. */
  claimable?: boolean;
}

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
  digest: string; // sha256 of the plaintext bytes — integrity, and the blob store's address
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
 * record into a second payload — the bytes live in the blob store precisely so bodies stay small
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

/** Kinds defined in CODE, not as `kind_def` records — so they never appear in `listKinds()`, which
 *  reads those records. Anything asking "does this kind exist" must consider these too. */
export const RESERVED_KINDS = [KIND_DEF, GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN, ARTIFACT];

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
  // Indexed on digest (find every record referencing the same bytes) and mediaType (route by what
  // it is — an image worker claims `{mediaType: "image/png"}` without a routing table).
  {
    kind: ARTIFACT,
    indexedPaths: [{ path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }],
    claimable: false,
  },
];

/** A deterministic idempotency key for a declaration, stable across process restarts and
 *  independent of field order: the same def dedups (no record growth), a changed def is a new
 *  successor record. Shared by the server and the SDK so both produce the same key. */
export function kindDefKey(def: KindDef): string {
  const ip = [...(def.indexedPaths ?? [])].map((p) => `${p.path}:${p.type}`).sort().join(",");
  const sp = [...(def.sortablePaths ?? [])].sort().join(",");
  return `kind_def:${def.kind}:${ip}:${sp}:${def.claimable === false ? "ref" : "work"}`;
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
