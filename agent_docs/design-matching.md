# Matching and query language (design)

Spec and rationale for template matching. Origin: outline §3.

**M0 status (implemented):** compilation, validation, and the equality/range/`$in`/
`$exists`/`$any`/`$each`/`$or` operators with the divergence semantics live in
`src/core/matching.ts`; the pure evaluator (`matchesRecord`) is the **semantic oracle**
that defines what a template matches. The per-kind indexing contract is
`src/core/kinds.ts` (an in-memory registry). Declarations are **not a side table**: each is a
`kind_def` record, written via `put` and reloaded at startup by querying those records
(`Space.loadKinds`); the registry is a cache/projection. The one bootstrap is the `kind_def`
meta-kind itself (`META_KIND_DEF`), defined in code so a query for `kind_def` records can
compile. `read_one`/`query` fetch by kind and filter + order with the
oracle; **pushing predicates onto physical per-kind expression indexes is deferred** (paired
with the M1 keyset query — see [plan-m0-implementation.md](plan-m0-implementation.md) Phase 2).
Any future indexed SQL must agree with the oracle.

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

A kind also declares `claimable` (default `true`): whether its records are *work* (claimed by a
worker with `take`) or *reference* data (facts, config, history — written once, read by `query`,
never taken). It's a diagnostic hint, not a matching rule: `claimable:false` opts the kind out of
the starvation check (`Space.diagnostics` — a reference record sitting `available` forever is
normal, not stale). The reserved control kinds (`kind_def`/`grant`/`signal`/`agent_*`) default to
`claimable:false`.

A declaration is itself a **record** of the reserved `kind_def` kind (body = the contract
above), expressed through the substrate rather than a bespoke table/endpoint (see
[CLAUDE.md](../CLAUDE.md) "Design principle"). Declare a kind by `put`-ing a `kind_def`
record; discover kinds by `query {kind: kind_def}`. Records are immutable, so re-declaring a
kind emits a **successor** `kind_def` record (latest per kind name wins on reload) rather than
mutating the prior one. The server validates a `kind_def` body on `put` (M0 status: `Space.put`
special-cases the reserved kind), and rejects redeclaring `kind_def` itself — the meta-kind is
the one declaration defined in code (`META_KIND_DEF`), which breaks the bootstrap cycle so its
own records can compile. Because they are ordinary records, kind declarations appear in the
event log and are watchable.

## Template-scoped grants (grant ∧ request)

An authorization grant may carry a `template` (a match object). The effective query for a
scoped principal is then `grant ∧ request`, **computed server-side**: `combineMatch`
(`src/core/matching.ts`) ANDs the request match with the union (`$or`) of the principal's grant
templates, and the combined match compiles + evaluates through the same oracle. Applies to
`query`/`read_one`/`take` (an unrestricted grant, or a privileged principal, imposes no
constraint). Because the constraint nests as `$and[request, $or[templates]]`, a grant template
must stay simple (a flat equality map) — a `$or`/`$and` *inside* one can exceed the depth-3
limit and be rejected at compile. See [design-auth.md](design-auth.md).

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
