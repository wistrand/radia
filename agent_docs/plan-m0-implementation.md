# Plan: M0 implementation

> Status: not started. This is the buildable, phase-by-phase plan for M0 (the semantic
> kernel prototype). Milestone scope and the M1–M3 outline live in
> [plan-milestones.md](plan-milestones.md); this doc is the technical *how* for M0 only.

## Goal

Ship `npx radia dev`: an embedded, single-process Radia space with a bundled MCP adapter
and a minimal web inspector, reachable in under a minute, with the core kernel
(put/take/ack/nack/release/renew, record+envelope split, fencing, idempotency,
equality/range matching, transactional event log, dead-letter) behind the frozen wire
contract. The conformance suite is a storage-adapter contract from the first commit.

This is a focused prototype (2–3 careful weeks), explicitly **not** production-readiness.

## Runtime and storage decisions

- **Runtime: Deno + TypeScript.** TS runs directly (no build step for dev), `deno
  compile` produces per-OS binaries for release, Web Crypto covers `body_sha256`, and
  `Deno.serve` covers HTTP without a framework. This satisfies the CLAUDE.md invariant
  *minimal dependencies, maximal platform independence, near-zero build steps*.
- **Two embedded adapters from M0: PGlite and SQLite.** This activates the
  *every-adapter-in-CI-from-day-one* invariant (CLAUDE.md) at M0 rather than deferring it
  to M1 — the point is to make the `StorageAdapter` port honest before Postgres arrives,
  so storage-adapter drift (the top risk in [gotchas.md](gotchas.md)) is caught while the
  kernel is small.
  - **PGlite** (`npm:@electric-sql/pglite`, WASM Postgres) keeps one adapter's SQL dialect
    and take semantics aligned with the M1 Postgres adapter.
  - **SQLite** (`jsr:@db/sqlite`, FFI) is the lighter, WASM-free adapter and the real test
    that the port abstracts: SQLite's WAL single-writer concurrency, its JSON path
    functions, and its lack of Postgres generated-column/expression-index parity differ
    from PGlite, so any leak of Postgres assumptions into `core/` surfaces here.
- **`SKIP LOCKED` is the Postgres *implementation* of the take contract, not the
  contract** (see [design-storage.md](design-storage.md)). The adapter interface exposes
  an atomic take; both embedded adapters serialize takes in-process (PGlite single
  connection, SQLite single writer), and the M1 Postgres adapter will use `FOR UPDATE SKIP
  LOCKED`. All three satisfy the same conformance test.
- **Path indexing is abstracted, not assumed.** The per-kind `indexed_paths` contract maps
  to Postgres generated columns / expression indexes on one adapter and to SQLite
  expression indexes over `json_extract` on the other. `core/matching.ts` speaks the port,
  never a backend dialect. Getting this seam right is the main reason SQLite is in M0.
- **Dependencies kept tiny and audited:** Deno std (`jsr:@std/ulid`, `jsr:@std/assert`,
  `jsr:@std/http` helpers as needed) + PGlite + `jsr:@db/sqlite`. No web framework, no ORM.
  Each further dependency is a cost to justify.

## OpenAPI freeze policy (M0)

`openapi/radia.yaml` is the frozen wire contract, but only the validated parts are
frozen at M0. Scope: **freeze the data-plane core; mark control-plane and auth
experimental.**

Frozen at M0 as **v0-stable** (additive-only — new optional fields and new enum values
allowed, no removals or renames):

- the nine data-plane verbs: `put`, `read_one`, `query`, `take`, `ack`, `nack`,
  `release`, `renew`, `watch`;
- record / runtime-envelope / lease JSON shapes;
- status values `lease_lost`, `idempotency_conflict`, and the `dead_letter` state;
- the RFC 9457 error model;
- the matching operator whitelist and its divergence semantics (see
  [design-matching.md](design-matching.md)).

Marked **experimental** (may change without a major bump) at M0:

- control-plane: kinds, templates, agent-definitions, runs, grants;
- auth and credential exchange (auto-provisioned locally at M0; real at M1).

Mechanism:

- **Per-element `x-stability: stable | beta | experimental`** on every operation and
  schema in the spec, so stability is granular and self-documenting.
- **SemVer 0.x**, where `0.x` signals the whole surface may still move; the additive-only
  rule above is what makes the frozen subset dependable within 0.x.
- **Reserved names now** so later additions aren't breaking: the deferred operators
  (`$ne`, `$nin`, `$not`, `$prefix`, full-text) and room for future status values are
  reserved; frozen request bodies use `additionalProperties: false`.
- **Version signaling** via a `/v0/` path prefix (or `Radia-Api-Version` header) so
  clients pin.

This honors the CLAUDE.md invariant *the wire contract is what's frozen, not the
implementation* for the parts M0 actually exercises, without committing to the
grant/auth/scheduler shapes that aren't validated until M1–M3.

## Current state

Nothing built. All behavior is specified in the `design-*` docs linked from
[CLAUDE.md](../CLAUDE.md). This plan turns the M0 checklist in
[plan-milestones.md](plan-milestones.md) into ordered, independently-verifiable phases.

## Proposed layout

No source tree exists yet; this is the target. Update the CLAUDE.md Layout table as it
lands.

```
deno.json            # tasks + import map; no build for dev
openapi/radia.yaml   # the frozen wire contract (source of truth)
src/
  main.ts            # `radia dev` entry: arg parse, boot space + inspector + MCP
  cli.ts             # minimal CLI over the public API only
  server/
    http.ts          # Deno.serve routing; long-poll; SSE
    handlers/        # one module per operation (put, take, ack, ...)
  core/              # storage-agnostic runtime logic
    record.ts        # record + envelope model, ULID, body_sha256
    matching.ts      # template evaluation (equality/range, divergences)
    lease.ts         # fencing, epochs, attempt semantics, dead-letter
    idempotency.ts   # (principal, op, key) store; ordering
    eventlog.ts      # append-only, same-transaction writes
    auth.ts          # auto-provisioned local principals/run tokens
  storage/
    adapter.ts       # StorageAdapter interface — the port/contract
    pglite.ts        # embedded adapter — WASM Postgres (M0)
    sqlite.ts        # embedded adapter — SQLite via jsr:@db/sqlite (M0)
  mcp/               # bundled MCP adapter (credentials outside model context)
  inspector/         # minimal web inspector (static assets + SSE feed)
sdk/
  ts/                # TS SDK stub (heartbeat + loop harness)
  py/                # Python SDK stub
conformance/         # storage-adapter contract suite + basic fault cases
```

## Testing methodology

- **Conformance suite is the contract.** It targets the `StorageAdapter` interface, not a
  concrete backend, and is written *before or alongside* each behavior. `deno task
  conformance` runs it against **every registered adapter** — PGlite *and* SQLite at M0;
  Postgres joins at M1 without the tests changing. A behavior is not done until it is green
  on both M0 adapters. This is the standing guard against storage-adapter drift — the
  CLAUDE.md invariant — and running two adapters from the first commit is what keeps it
  real rather than aspirational.
- **Fault cases** live in the same suite, driving crashes/retries through adapter and
  handler seams (not real process kills at M0): crash-before-effect, after-effect-before-ack,
  after-commit-before-response, duplicate ack, stale ack after reassignment. Full matrix in
  [plan-validation.md](plan-validation.md); M0 takes the subset that the kernel can exercise.
- **"Done" for a phase** = its Verify block passes and no earlier phase's conformance
  tests regress.
- No automated LLM in the loop; no interactive test output. Per repo conventions, the
  agent writes tests and states how to run them rather than running them here.

## Phases

Ordered by dependency; each is independently verifiable before the next starts.

### Phase 0 — skeleton and contracts

- [ ] `deno.json` with tasks: `dev`, `test`, `conformance`, `check`, `compile`. No build step for `dev`.
- [ ] `StorageAdapter` interface in `src/storage/adapter.ts` (the port every backend implements).
- [ ] OpenAPI skeleton `openapi/radia.yaml` covering the ten operations' shapes, with per-element stability annotations (see freeze policy below).
- [ ] Conformance harness that runs a suite against a list of adapters; **both PGlite and SQLite stubs wired in**.
- [ ] `radia dev` boots `Deno.serve` and answers a health endpoint.

**Verify:** `deno task dev` serves health; `deno task conformance` runs the (empty) suite
green against **both** the PGlite and SQLite adapters.

### Phase 1 — record model and storage

- [ ] `records` (immutable) + `record_runtime` (envelope) schema in **both adapters** (PGlite and SQLite), with `kind`, `deadline_at`, and hot routing fields denormalized into the envelope at commit.
- [ ] ULID ids; `body_sha256` over plaintext on every record (Web Crypto).
- [ ] `put(record, idempotency_key)` and `read_one(template)` handlers.
- [ ] Server-assigned `runtime_meta` (`created_by`, `created_at`, `schema_version`); client cannot set authoritative fields.

**Verify:** conformance — put returns an id; the record is immutable and cannot be
rewritten; `body_sha256` present and correct; client-submitted authoritative fields are
rejected/overwritten; read_one returns the committed record. See
[design-data-model.md](design-data-model.md).

### Phase 2 — matching

- [ ] Per-kind `indexed_paths` (typed) and `sortable_paths` declaration + registration validation (typo'd path = registration error).
- [ ] Equality and range predicates (`$eq`, `$gt/$gte/$lt/$lte`, `$in`, `$exists`, `$and/$or` depth ≤ 3) on declared indexed paths.
- [ ] Divergence semantics: missing ≠ null, no type coercion, explicit array quantifiers.
- [ ] Hot declared paths mapped to generated columns / expression indexes on `record_runtime`.

**Verify:** conformance — the divergence cases (missing ≠ null, cross-type = false,
`$any/$each` do not silently distribute); predicate on an undeclared path is a
registration error. See [design-matching.md](design-matching.md).

### Phase 3 — take, leases, fencing

- [ ] Atomic `take(template | record_id, lease_s, block, timeout)`: single transaction, envelope → `leased`, epoch bump, returns `{record, lease}`.
- [ ] `take(record_id=...)` re-verifies template + availability + `claim_until` (selector, not bypass).
- [ ] `renew`, `ack(result_record?)`, `nack`, `release` presenting `lease_id + epoch`; mismatch → `lease_lost`.
- [ ] Attempt semantics: `nack` +1, expiry +1, `release` +0; backoff via `available_at`; `dead_letter` after `max_attempts`; max cumulative lease duration per (record, run).
- [ ] At-least-once + overlap-after-expiry documented in code and SDK.

**Verify:** conformance — at most one valid lease at a time; a fenced `ack` returns
`lease_lost`; attempt increments per path; `release` is +0; expiry re-opens the record;
`max_attempts` reaches `dead_letter`. See [design-api.md](design-api.md).

### Phase 4 — idempotency

- [ ] `(principal, operation, idempotency_key)` store holding request hash + stored response (including generated result IDs).
- [ ] Lookup runs **before** lease validation; same-key concurrent requests serialize.
- [ ] Same hash → stored response; different hash → `idempotency_conflict`.

**Verify:** conformance — replaying `ack` after a lost response returns the stored result,
**not** `lease_lost`; a conflicting payload under the same key returns
`idempotency_conflict`. This is the load-bearing ordering in [gotchas.md](gotchas.md).

### Phase 5 — event log and dead-letter

- [ ] Append-only event table written in the **same transaction** as each mutation, run identity on every event.
- [ ] Dead-letter state transition preserves `kind`.
- [ ] Lineage query over `parent_ids` for a record.

**Verify:** conformance — every state-changing operation emits exactly one event in its
own transaction (no mutation without an event, no event without the mutation); a
lineage query returns the ancestry. See [design-observability.md](design-observability.md).

### Phase 6 — basic fault suite

- [ ] Adapter/handler seams that let tests inject failure between: effect and ack, commit and HTTP response, and on retry.
- [ ] Cases: crash before effect, after effect before ack, after commit before response, duplicate ack, stale ack after reassignment.

**Verify:** the M0 fault subset in [plan-validation.md](plan-validation.md) passes; duplicate
and stale acks resolve via idempotency/fencing, not corruption.

### Phase 7 — surfaces and the demo

- [ ] Auto-provisioned local credentials — **same API shape as production, never "no tokens"** (`src/core/auth.ts`).
- [ ] Bundled MCP adapter (`src/mcp/`): holds credentials outside the model context, heartbeats internally.
- [ ] Minimal web inspector (`src/inspector/`): live record/lease view over SSE.
- [ ] Minimal CLI (`src/cli.ts`) over the public API only.
- [ ] TS + Python SDK stubs with the hand-written heartbeat (renew at lease/3) and loop harness.
- [ ] Release wrapping: `deno compile` → per-OS binary → thin `npm` and `pip` shims (the esbuild/uv pattern; can be rough at M0).

**Verify:** the under-a-minute demo — `npx radia dev` (or `pipx run`) brings up the space
+ inspector + MCP adapter in one process; a second terminal joins as an agent and
claims a record; one line in an MCP-capable harness config participates without SDK code.

## Open questions

- **SQLite library choice.** `jsr:@db/sqlite` (FFI, mature, needs `--allow-ffi`) is the
  M0 pick. Deno's built-in `node:sqlite` would be zero-external-dependency but is still
  unstable; revisit switching to it once it stabilizes.
- **npm/pip binary distribution mechanics** (embed vs. download-on-install) — defer the
  polished version to M1; a rough shim is enough for the M0 demo.

Resolved: **two embedded adapters (PGlite + SQLite) ship in M0** — the port-abstraction
test happens now, not at M1. OpenAPI freeze scope is settled by the policy below.

<!-- When M0 lands: fold each phase's built behavior into the relevant architecture-*.md
     (promoted from design-*.md), point those docs into src/ paths + symbols, delete the
     landed phases here, and note the promotion in CLAUDE.md. -->
