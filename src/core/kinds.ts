// Per-kind indexing contract (control-plane). A kind declares which body paths are
// indexed (typed) and which are sortable. Registration VALIDATES the declaration, and
// template compilation (core/matching.ts) validates predicates against it: a predicate on
// an undeclared path, or order_by on a non-sortable path, is a registration error.
//
// M0: the registry is in-memory, per Space. Persisting declarations and creating the
// physical expression indexes for declared paths (predicate pushdown) is a tracked
// follow-up — the semantic oracle, not an index, defines correctness. See
// agent_docs/plan-m0-implementation.md Phase 2.

import { RadiaError } from "./errors.ts";

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
}

export class KindRegistry {
  #defs = new Map<string, KindDef>();

  register(def: KindDef): void {
    validateKindDef(def);
    this.#defs.set(def.kind, {
      kind: def.kind,
      indexedPaths: [...def.indexedPaths],
      sortablePaths: [...(def.sortablePaths ?? [])],
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
