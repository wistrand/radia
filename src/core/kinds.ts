// Per-kind indexing contract (control-plane). A kind declares which body paths are
// indexed (typed) and which are sortable. Registration VALIDATES the declaration, and
// template compilation (core/matching.ts) validates predicates against it: a predicate on
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

/** Reserved kinds only a human/supervisor principal may write directly (assigned, never
 *  self-declared). Runs/definitions are also written internally by the bootstrap endpoints. */
export const WRITE_PROTECTED_KINDS = new Set<string>([GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN]);

/** The coordination operations a grant can authorize. */
export type GrantOp = "put" | "take" | "query" | "read_one";
const VALID_OPS = new Set<GrantOp>(["put", "take", "query", "read_one"]);

/** A kind-scoped authorization grant. Never wildcard; assigned by a privileged writer. */
export interface GrantDef {
  principal: string; // the principal the grant is FOR (e.g. agent:summarizer, run:...)
  kind: string; // the concrete record kind it applies to — never "*"
  operations: GrantOp[]; // which coordination verbs on that kind
  /** Optional template-scope: a match object AND-ed into the principal's read/take on this kind
   *  (the effective query is `grant ∧ request`). Omitted → the whole kind. Applies to
   *  query/read_one/take; put ignores it. Its paths must be declared indexed paths of the kind
   *  (validated when a query compiles, not at grant creation — the kind may not exist yet). */
  template?: Record<string, unknown>;
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
  if (def.template !== undefined && (def.template === null || typeof def.template !== "object" || Array.isArray(def.template))) {
    throw new RadiaError("invalid_grant", "grant.template must be a match object");
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
export const META_RESERVED: KindDef[] = [
  META_KIND_DEF,
  {
    kind: GRANT,
    indexedPaths: [{ path: "principal", type: "keyword" }, { path: "kind", type: "keyword" }],
    claimable: false,
  },
  { kind: SIGNAL, indexedPaths: [{ path: "topic", type: "keyword" }], claimable: false },
  { kind: AGENT_DEFINITION, indexedPaths: [{ path: "agent", type: "keyword" }], claimable: false },
  {
    kind: AGENT_RUN,
    indexedPaths: [{ path: "run", type: "keyword" }, { path: "agent", type: "keyword" }],
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
