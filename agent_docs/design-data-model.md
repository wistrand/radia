# Data model (design)

Spec and rationale for Radia's core data model. Origin: outline §2.

**M0 status (implemented):** the record + `record_runtime` split, ULID ids, `body_sha256`,
the client-vs-runtime metadata split, and `parent_ids` lineage live in
`src/core/record.ts` (`buildRecord`), `src/storage/adapter.ts` (types), `src/storage/row.ts`
(mapping), and the two adapters. Kinds/indexing: `src/core/kinds.ts`. `delegation_context`
(authority lineage) and `taint` (data lineage) are both built (M1) — see "Provenance vs.
authority" below. **Artifacts / blob storage (§2.4) are built (M1), unencrypted in v1** — see the
section below for what landed and what did not.

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
its own priority or authorship. **`created_by` is the server-RESOLVED caller** (the handler's
resolved principal — a run token → `run:*`, no header → `human:local`), threaded into
`put`/`ack`; it also scopes idempotency (per principal) and the event `run_id`. In-process
callers default to the space's own identity.

## Provenance vs. authority

Two separate structures, deliberately not merged:

- **`parent_ids`** — data/causality lineage only. All parents must exist at commit;
  self-parenting is rejected. Because parents pre-exist and records are immutable, the
  lineage DAG is **acyclic by construction**.
- **`delegation_context`** — the authorization chain for this operation,
  server-derived from the claimed task/lease, never freely client-supplied. A result
  may have many data parents but exactly one authorization context. **M1 status (built):**
  set on records emitted via `ack` under a **managed run's** lease (`src/core/space.ts`
  `deriveDelegation`): `{chain, origin}`, where `chain` accumulates the acting agents along
  the delegation path (from the record's authoritative `lease_owner` → its agent) and `origin`
  is the leased record it was delegated from. Derived from the lease, **never** from
  `parent_ids`. Operator/root-owned work carries none (full authority). Emitting a result is
  authorized as a `put` for the acting agent (closing the gap where ack-emitted records
  bypassed put-authorization); the stricter *chain-intersection* policy composes with taint
  (M3). See [design-auth.md](design-auth.md).

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

**`taint` is the mirror image — it follows the DATA lineage that authority ignores.** M1
status (built): a record is tainted if a client raised it (`taint:true`, source attestation)
or **any `parent_ids` parent is tainted** (`Space.computeTaint`, on put and ack — so a tainted
task yields a tainted result). A client can only ever *raise* taint; clearing requires a
privileged **declassify** (`Space.declassify` → a clean successor with the tainted original as
its data parent). A sensitive consumer skips tainted work with `take {requireUntainted}`. So
the two lineages are complementary: authority flows down the **lease** (delegation), untrust
flows down **data parents** (taint), and neither leaks into the other.

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

**M1 status: built.** `src/storage/blobs.ts` (the `BlobStore` port + memory/filesystem impls),
`src/core/kinds.ts` (`ARTIFACT`, `validateArtifactDef`), `Space.putArtifact`/`readArtifact`/
`mintDownloadCapability`, `src/server/handlers/artifacts.ts`, `conformance/suites/blobs.ts`.

Large payloads live in blob storage. Records carry **stable internal artifact IDs**,
never temporary signed URLs (they would expire inside immutable records). Retrieval is
authorized through the runtime, which issues short-lived download capabilities.

**An artifact is a record.** The reserved `artifact` kind's body is `{digest, mediaType, size,
filename?}` — the metadata, never the bytes — so grants, taint, lineage, the event log, retention
and template-scoped scoping all apply with no new machinery, and only the payload sits outside.
Indexed on `digest` (every record referencing the same bytes) and `mediaType` (a worker claims
`{mediaType: "image/png"}` — content routing, not a routing table). `digest` and `size` are
server-computed; a client cannot assert them.

Blobs are **content-addressed** by sha256 of the plaintext: an object verifies itself, identical
bytes are stored once, and re-upload is free. Client-facing identity stays the record id, so
dedup never merges two artifacts into one reference.

**Download capabilities** (`POST /v0/artifacts/{id}/capability`) exist for one concrete reason: a
browser cannot attach an `Authorization` header to `<img src>`. A capability is scoped to a single
artifact, expires in minutes, lives in memory, and is minted only for a caller already authorized
to read that artifact — a delegation of a read, not a credential. It is checked before token
resolution (there is deliberately no token) and opens nothing else: `/v0/records` and `/v0/ops/*`
still 401 with a capability attached under `--auth required`.

**Only raster images, audio and video are served `inline`; everything else downloads.** Artifact
bytes are attacker-supplied and served from the space's OWN origin — the origin whose console page
carries an operator token — so `text/html` (or `image/svg+xml`, which is why the allowlist names
raster formats rather than `image/`) rendered inline would be a same-origin XSS reachable by anyone
holding an `artifact: put` grant. Responses also carry `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`.

Artifact policy, as built: sha256 verification, media-type and filename validation *before* the
body is read, a size ceiling (`maxArtifactBytes`, 32 MB) enforced against the stream rather than
the declared `Content-Length`, taint propagation (a client may raise it via `X-Radia-Taint`), and
access checks independent of possession of the record JSON.

**Not in v1, deliberately:** encryption at rest, and reference-aware GC (blobs are permanent;
`retention_until` on the artifact record is the hook). When encryption lands it is a per-artifact
random DEK under AES-GCM, the DEK wrapped by a space KEK from env or keyring, entirely behind the
`BlobStore` port. Two constraints for whoever builds it: the digest stays over **plaintext** (the
event chain and integrity survive crypto-shredding), and the wrapped DEK must live in **destroyable**
state — a blob sidecar or key table — never in the immutable artifact record, because shredding
means deleting it. Recipient-keyed / token-derived keys stay out; see
[gotchas.md](gotchas.md).
