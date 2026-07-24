# Matching and query language (design)

Spec and rationale for template matching. Origin: outline §3. Not yet implemented.

## Contents
- Invariants
- Semantics (divergences from Mongo)
- Operator whitelist
- Per-kind indexing contract
- Two matching directions
- Semantic matching (late)
- Template properties

## Invariants

- Templates are data, not code. No `$regex`, `$where`, `$expr`, ever (also in
  [CLAUDE.md](../CLAUDE.md)).
- "Mongo-compatible" is never claimed. The syntax is Mongo-inspired; the semantics are
  Radia's own and are conformance-suite-backed.
- Registration rejects predicates on undeclared paths and `order_by` on non-sortable
  paths. A typo'd path is a registration error, not a silently-empty match.

## Semantics (divergences from Mongo)

Explicit, deterministic, conformance-tested:

- Missing ≠ null. An absent field never matches except `$exists: false`.
- No type coercion. Cross-type comparison is false.
- Explicit array quantifiers `$any` / `$each`. Scalar predicates never silently
  distribute over arrays.
- `$not` is field-level only, depth 1.
- Dotted paths only. Literal dots in keys are rejected at schema registration.

## Operator whitelist

- **Whitelist (early):** `$eq` (implicit), `$gt` / `$gte` / `$lt` / `$lte`, `$in`,
  `$exists`, `$any` / `$each`, `$and` / `$or` (depth ≤ 3).
- **Deferred:** `$ne` / `$nin` / `$not` (poor selectivity; slow lane if ever);
  `$prefix` and full-text (indexable, later — semantic matching is not a substitute for
  deterministic prefix/token/filename matching).
- **Never:** `$regex`, `$where`, `$expr`.

## Per-kind indexing contract

Each kind declares `indexed_paths` (typed: keyword / integer / timestamp / array) and
`sortable_paths`. Registration rejects predicates on undeclared paths (or routes them to
the rate-limited slow lane) and `order_by` on non-sortable paths. Hot declared paths
become generated columns / expression indexes on `record_runtime` (see
[design-storage.md](design-storage.md)).

## Two matching directions

They need different machinery, and only the first ships early:

- **template → records** is an indexed query (the hot claim path).
- **new-record → templates** (wakeups, scheduler candidates) is subscription matching,
  needing an inverted index of template atoms. Early milestones ship bounded
  **wakeup-by-kind only**.

## Semantic matching (late)

Embeddings over declared semantic fields, computed on the structurally-filtered set
only; per-agent LLM rerank with a cost budget; shadow mode before enforcement. See
[plan-milestones.md](plan-milestones.md) (M3).

## Template properties

Templates are storable, analyzable, and schema-validated at registration. Orphan records
and starving templates are first-class diagnostics (see
[design-observability.md](design-observability.md)). Deterministic tie-breaking:
`order_by`, then record ID.
