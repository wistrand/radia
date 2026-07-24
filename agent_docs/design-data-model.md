# Data model (design)

Spec and rationale for Radia's core data model. Origin: outline §2.

**M0 status (implemented):** the record + `record_runtime` split, ULID ids, `body_sha256`,
the client-vs-runtime metadata split, and `parent_ids` lineage live in
`src/core/record.ts` (`buildRecord`), `src/storage/adapter.ts` (types), `src/storage/row.ts`
(mapping), and the two adapters. Kinds/indexing: `src/core/kinds.ts`. **Not implemented:**
artifacts / blob storage (§2.4, M1), taint (§2.1, M3), delegation_context (M3).

## Contents
- Invariants
- Record vs. runtime envelope
- Timing fields
- Client vs. runtime-authoritative metadata
- Provenance vs. authority
- Kind conventions
- Resource limits
- Artifact references

## Invariants

Subsystem-local rules. Cross-cutting rules (immutability, the client/runtime split,
provenance ≠ authority) are stated once in [CLAUDE.md](../CLAUDE.md) — read those too.

- One `record_runtime` row per record. The envelope is the only mutable state.
- Denormalized routing fields (`kind`, `deadline_at`, hot paths) are copied into
  `record_runtime` transactionally at commit and are never client-editable.
- Content "updates" are consume + emit successor. Dead-lettering sets
  `state = dead_letter` and preserves `kind`.
- Every record carries `body_sha256` over plaintext (needed for artifacts, dedup, and
  no-progress detection; see [design-observability.md](design-observability.md)).

## Record vs. runtime envelope

Two structures per unit of work: immutable content, and a mutable claim-state envelope.

```
record                       # immutable after commit
  id             ULID
  kind           discriminator; never rewritten
  body           JSON (large payloads via artifacts, below)
  client_meta    confidence?, requested_priority?, app fields (client-submitted claims)
  runtime_meta   created_by, delegation_context, parent_ids[], taint,
                 schema_version, created_at        (server-assigned, authoritative)
  deadline_at?   application-level deadline (business semantics / scheduler signal)
  retention_until?  content GC eligibility

record_runtime               # mutable envelope, one row per record
  record_id
  kind, deadline_at, hot routing fields   # DENORMALIZED from record, server-assigned
                                          # transactionally at commit, never client-editable
  state          available | leased | consumed | dead_letter | expired
  attempt        int
  available_at   delayed visibility / retry backoff
  claim_until    no NEW claims after this time
  effective_priority   server-computed (see design-scheduler.md); aged by sweeper
  lease_id, lease_epoch, lease_owner (run id), leased_until
```

The split is what makes immutable content coexist with churning claim state, and it is
what lets the hot claim path be a single-table index (see
[design-storage.md](design-storage.md)).

## Timing fields

Five distinct concepts, never overloaded onto one field:

| Field             | Meaning                                    |
|-------------------|--------------------------------------------|
| `available_at`    | eligibility (delayed visibility, backoff)  |
| `claim_until`     | no new claims after this time              |
| `deadline_at`     | business deadline / scheduler signal       |
| `retention_until` | content GC eligibility                     |
| `leased_until`    | current lease expiry                       |

Retention expiry does **not** invalidate an in-flight valid lease. Administrative GC
never discards valid completed work.

## Client vs. runtime-authoritative metadata

A hard API split. Server-controlled always: `created_by`, `delegation_context`,
`created_at`, `schema_version` (post-validation), `taint`, `effective_priority`, all
lease fields. Clients submit only *claims* (`confidence`, `requested_priority`); the
runtime decides what they are worth. This is what stops an agent from, e.g., declaring
its own priority or authorship.

## Provenance vs. authority

Two separate structures, deliberately not merged:

- **`parent_ids`** — data/causality lineage only. All parents must exist at commit;
  self-parenting is rejected. Because parents pre-exist and records are immutable, the
  lineage DAG is **acyclic by construction**.
- **`delegation_context`** — the authorization chain for this operation,
  server-derived from the claimed task/lease, never freely client-supplied. A result
  may have many data parents but exactly one authorization context.

A result may have many data parents but exactly one authorization context:

```mermaid
flowchart TB
    p1[data parent] --> R[result record]
    p2[data parent] --> R
    p3[data parent] --> R
    L[claimed lease] -. server-derived .-> DC[delegation_context<br/>exactly one per operation]
    DC ==> R
```

Deriving data from a privileged record grants nothing. Intersecting authority across
arbitrary data parents is neither meaningful nor attempted. See
[design-auth.md](design-auth.md) for how `delegation_context` drives permission.

## Kind conventions

`task` · `fact` / `hypothesis` · `request` / `bid` / `award` (see
[design-marketplace.md](design-marketplace.md)) · `result` · `signal` (privileged
writers only).

## Resource limits

Hard, enforced at commit/registration — an indexed query can still be expensive, so
limits are not optional. Bounded: max record and template size · field depth · predicate
count · `$or` branches · array cardinality · registered templates per agent · watches
per run · slow-lane time and row-scan budgets · SSE buffer/backpressure limits.

## Artifact references

Large payloads live in blob storage. Records carry **stable internal artifact IDs**,
never temporary signed URLs (they would expire inside immutable records). Retrieval is
authorized through the runtime, which issues short-lived download capabilities.

Artifact policy: sha256 verification, MIME/size validation, encryption, reference-aware
GC, taint propagation, and access checks independent of possession of the record JSON.
