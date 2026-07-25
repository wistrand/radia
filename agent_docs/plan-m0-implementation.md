# Plan: M0 implementation

> Status: Phases 0–7 DONE (190 conformance tests across the embedded adapters and the blob port, 213 including a
> live Postgres), plus M1 watches, the M1 **authorization stack** (grants, run tokens,
> delegation, taint — see below), and a range of enhancements (see "Current state" and
> "Enhancements" below). This is the buildable, phase-by-phase plan for M0
> (the semantic kernel prototype). Milestone scope and the M1–M3 outline live in
> [plan-milestones.md](plan-milestones.md); this doc is the technical *how* for M0 only.

## Goal

Ship `npx radia dev`: an embedded, single-process Radia space with a bundled MCP adapter
and a friendly dev UI (see "Dev UI"), reachable in under a minute, with the core kernel
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
  - **SQLite** (Deno's built-in `node:sqlite` / `DatabaseSync`) is the lighter, WASM-free
    adapter and the real test that the port abstracts: SQLite's WAL single-writer
    concurrency, its JSON path functions, and its lack of Postgres
    generated-column/expression-index parity differ from PGlite, so any leak of Postgres
    assumptions into `core/` surfaces here. Uses the runtime built-in rather than an FFI
    package — zero external dependency, no native download (`jsr:@db/sqlite` segfaulted;
    see [gotchas.md](gotchas.md)).
- **`SKIP LOCKED` is the Postgres *implementation* of the take contract, not the
  contract** (see [design-storage.md](design-storage.md)). The adapter interface exposes
  an atomic take; both embedded adapters serialize takes in-process (PGlite single
  connection, SQLite single writer), and the M1 Postgres adapter will use `FOR UPDATE SKIP
  LOCKED`. All three satisfy the same conformance test.
- **Path indexing is abstracted, not assumed.** The per-kind `indexed_paths` contract maps
  to Postgres generated columns / expression indexes on one adapter and to SQLite
  expression indexes over `json_extract` on the other. `core/matching.ts` speaks the port,
  never a backend dialect. Getting this seam right is the main reason SQLite is in M0.
- **Dependencies kept tiny and audited:** Deno std (`jsr:@std/ulid`, `jsr:@std/assert`)
  + PGlite (`npm:@electric-sql/pglite`). SQLite uses the runtime built-in `node:sqlite`,
  so it is not a dependency. No web framework, no ORM. Each further dependency is a cost
  to justify.

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

**All M0 phases (0–7) are DONE**, verified (190 conformance tests across the embedded adapters and the blob port;
213 including a live Postgres via `scripts/pg-conformance.sh`), plus M1
watches and the M1 **authorization stack** (grants, run-token bootstrap chain, per-run leases,
delegation, taint — see the Enhancements note below), the dev console, examples, and several
enhancements. Per-phase records with verify results are in the Phases section below.

The one thing M0 claims that has not been executed end to end is `npx radia dev` / `pipx run`:
the binaries compile and the shim packages are staged by `deno task release`, but nothing has
been published to a registry, so the install path itself is unexercised.

Two post-Phase fixes worth knowing about, both in storage (`src/storage/`):
- `ack` with a result appends the successor's own `put` event. Without it the record existed
  with no `available` event of its kind, so a watch on that kind never woke. See Phase 5.
- `DDL` gained a migrations block. `create table if not exists` only ever creates, so a
  database from a build predating `events.xid` kept the old shape and failed every
  `getEvents`. `PostgresBackend.exec` also strips `--` comments before its naive split on `;`.

**Enhancements built on top of the phases** (not in the original M0 checklist):
- On-disk persistence: `deno task dev --db <path>` (SQLite file / PGlite dir); records,
  envelopes, events, idempotency, and kind declarations (kinds are `kind_def` records rebuilt
  by `Space.loadKinds`) all reload on restart.
- Kinds-as-records: kind declarations are `kind_def` records (no `kinds` table, no `/v0/kinds`
  endpoint); declare via `put`, discover via `query {kind:kind_def}`. Ops envelope query
  (`GET /v0/ops/records?state=…`) makes the runtime envelope queryable; diagnostics composes it.
  Chatbot tool discovery is watch-driven (capabilities are watchable records).
- Relationship **graph** diagnostic: `childrenOf` (reverse of lineage) + `Space.getGraph`,
  `GET /v0/ops/records/{id}/graph` and `GET /v0/ops/records/{id}`, and a Graph view in the console
  (layered SVG, wide rows wrap, optional live refresh).
- The chatbot's conversation is an append-only `message` record thread (blackboard), not a
  client-held array; the inference-worker reconstructs context from the space.
- Derived **diagnostics** + **remediation**: `GET /v0/ops/diagnostics` (`Space.diagnostics` —
  counts, dead-letters, expired-but-stuck leases, stale-available) and control-plane
  `POST /v0/ops/records/{id}/{reclaim|dead-letter|requeue}` (`adminTransition`, bypasses
  lease fencing; `reclaim` only touches an *expired* lease). Surfaced as chatbot tools
  (`space_doctor` + `space_reclaim`/`space_dead_letter`/`space_requeue`) so the chat example
  is both inspector and operator.
- **Authorization stack (M1, ahead of the M1 milestone):** grants are `grant` records enforced by
  `Space.authorize` at the HTTP boundary; the bootstrap chain (`agent-definitions` → `agent-runs` →
  stop/quarantine) mints run tokens (`src/core/auth.ts`, only the hash stored); `Authorization:
  Bearer` is the sole channel (no header → operator default; the dev console holds a server-minted
  operator token). Per-run lease ownership, template-scoped grants, `delegation_context`, and
  `taint` + declassify all built; the chat example runs with real `admin`/`user` roles and the
  console surfaces the auth records (Auth tab) + taint/delegation badges. Detail in
  [design-auth.md](design-auth.md); this is M1 work, tracked in [plan-milestones.md](plan-milestones.md).

## Proposed layout

The original target layout (the actual tree is in [CLAUDE.md](../CLAUDE.md); the sketch
below is kept for the phase-planning record):

```
deno.json            # tasks + import map; no build for dev
openapi/radia.yaml   # the frozen wire contract (source of truth)
src/
  main.ts            # `radia dev` entry: arg parse, boot space + dev UI + MCP
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
    sqlite.ts        # embedded adapter — SQLite via built-in node:sqlite (M0)
  mcp/               # bundled MCP adapter (credentials outside model context)
  ui/                # dev UI: one self-contained index.html served at GET / (see "Dev UI")
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

## Dev UI (radia dev web console)

A friendly, single-page web console `radia dev` serves at `GET /`, so the space is
explorable in a browser the moment it boots — this is what makes the under-a-minute
adoption bar (see [design-storage.md](design-storage.md) "Deployment modes") land, not
just curl.

**BUILT** (ahead of Phase 7): `src/ui/index.html` served at `GET /`, with all panels
working — Overview, Records browser (with lineage in detail), Kinds, Put, Query
playground, Worker, and a live **Feed** tab. Backing endpoints added to support it: `GET
/v0/ops/stats`, `POST /v0/records/query` (basic list — keyset-cursor `query`
is still M1; the Kinds panel uses it with `{kind:kind_def}`), `GET /v0/ops/records/{id}/envelope`,
`GET /v0/ops/events`, and `GET /v0/ops/records/{id}/lineage`. Remaining polish: SSE push for the feed (currently polls;
proper watches land in M1).

Principles:

- **One `index.html`** — inline CSS + vanilla JS, no framework, no build step, no external
  requests. This is the [CLAUDE.md](../CLAUDE.md) minimal-deps / zero-build /
  platform-independence invariant applied to the UI, and it keeps the demo a single binary.
  Served from `src/ui/`. One exception since the Space tab: the prebuilt BlitZoom bundle in
  `src/ui/vendor/`, served from the same origin at `GET /ui/blitzoom.bundle.js` and injected
  lazily on first use. Checked in as an artifact, so there is still no build step and still no
  external request; `deno task compile` `--include`s it.
- **Public API only.** The console calls the same `/v0` endpoints an agent would; it gets
  no privileged backdoor. If the UI can do it, a client SDK can too.
- **Friendly by default.** Readable empty states, surfaced RFC 9457 error `detail`
  (a rejected template says *why*), theme-aware (light/dark), keyboard-navigable.
- **Built incrementally as backing features land** — each panel ships when its API does,
  so the UI is useful from Phase 1 onward rather than all-at-once at the end.

Panels (each maps to existing endpoints):

| Panel | Backing API | Lands |
|-------|-------------|-------|
| Space overview — backend, DB clock, counts by kind/state | `GET /v0/health` (+ counts) | Phase 1 |
| Records browser — filter by kind, view body + runtimeMeta + envelope state, follow `parent_ids` | `read_one` / `query` | Phase 1 (richer at M1 query) |
| Graph — the `parent_ids` relationship DAG around a record (conversation/job fan-out) as a layered SVG; wide generations wrap to rows (bounded width), optional live auto-refresh, hide-chunks toggle | `GET /v0/ops/records/{id}/graph` (+ `childrenOf`) | built |
| Kinds — view + register indexed/sortable paths (kinds are `kind_def` records) | `POST /v0/records` + `query {kind:kind_def}` | Phase 2 |
| Put a record — kind + JSON body form | `POST /v0/records` | Phase 1 |
| Query playground — template (match + order_by) with friendly validation errors | `read_one` | Phase 2 |
| Worker panel — take a record, then renew/ack/nack/release by hand to drive the lifecycle | `takes` + `leases/*` | Phase 3 |
| Live feed — records/state-transitions/dead-letters streaming in | event log + watches (SSE) | Phase 5 / M1 |
| Lineage viewer — a record's parent/child DAG | lineage query | Phase 5 (M2 richer) |
| Space — every record placed by property similarity (kind, envelope state, owning run), streamed from the event log; hierarchical zoom aggregates into supernodes. Layout is a pure function of the properties, so insertion never displaces what is on screen. Vendored BlitZoom `<bz-graph>` | `GET /v0/ops/events` (+ `GET /v0/ops/records/{id}` for detail) | built |

Everything above except the live feed and lineage viewer is backed by endpoints that
already exist (Phases 1–3), so the console can be built now and grow with the runtime.

## Phases

Ordered by dependency; each is independently verifiable before the next starts.

Each phase's **Verify** line records the suite total *at the moment that phase went green*
(16 → 36 → 52 → 60 → 68 → 78), so the numbers climb and are deliberately never back-filled —
they are a history, not a current count. Only the two Status lines above track today's total.

### Phase 0 — skeleton and contracts — DONE

- [x] `deno.json` with tasks: `dev`, `check`, `conformance`, `compile`. No build step for `dev`. Import map for std/ulid, std/assert, @db/sqlite, pglite.
- [x] `StorageAdapter` interface in `src/storage/adapter.ts` (the port every backend implements) — domain types, `CompiledMatch` neutral form, `now()`/`put`/`readOne` signatures, `notImplemented` marker for later-phase methods.
- [x] OpenAPI skeleton `openapi/radia.yaml` covering the operations' shapes, with per-element `x-stability`, reserved operators, `/v0` server prefix (see freeze policy above).
- [x] Conformance harness (`conformance/harness.ts`) runs each suite against a list of adapters; **both PGlite and SQLite wired in** (`conformance/adapters.ts`); Phase 0 smoke suite exercises `now()`.
- [x] `radia dev` (`src/main.ts` + `src/server/http.ts`) boots `Deno.serve` and answers `GET /v0/health`; `--storage pglite|sqlite` selects the backend.

**Verify:** PASSED. `deno task check` clean; `deno task conformance` green on both
adapters (`[pglite]` and `[sqlite]` smoke tests pass); `deno task dev --storage
pglite|sqlite` serves `/v0/health` with the DB clock, and unknown routes return an RFC
9457 404.

### Phase 1 — record model and storage — DONE

- [x] `records` (immutable) + `record_runtime` (envelope) schema in **both adapters** (`src/storage/pglite.ts`, `src/storage/sqlite.ts`), with `kind`, `deadline_at`, and hot routing fields denormalized into the envelope at commit; the `state='available'` partial claim index created on both.
- [x] ULID ids (`src/core/ids.ts` `newUlid`); `body_sha256` over plaintext via Web Crypto (`sha256Hex`), computed over the exact serialized body the adapter stores verbatim.
- [x] `put` and `read_one` — HTTP handlers (`src/server/handlers/records.ts`) over the `Space` service (`src/core/space.ts`); adapter methods `put`/`readOne`; matching oracle `src/core/matching.ts` (equality only; Phase 2 extends).
- [x] Server-assigned `runtime_meta` in `src/core/record.ts` `buildRecord`; `PutRequest` carries only client-submittable fields and the put handler picks only those, so authoritative fields can never come from the client.
- [x] Parent-must-exist checked in each adapter's put transaction; self-parenting rejected.

**Verify:** PASSED. `deno task conformance` green — 16 tests, both adapters: put→id,
read_one round-trip, `body_sha256` correct, immutability (distinct ids, first untouched),
metadata split (server `createdBy`/`schemaVersion`, client claims preserved but not
promoted), boundary enforcement (injected `createdBy:"attacker"` ignored),
`parent_not_found` on a dangling parent. Live `radia dev` confirmed via curl: put→id,
read-one match/miss(null), 400 `problem+json` on bad body. See
[design-data-model.md](design-data-model.md).

### Phase 2 — matching — DONE

- [x] Per-kind `indexed_paths` (typed: keyword/integer/timestamp/array) and `sortable_paths` declaration + registration validation (`src/core/kinds.ts` `KindRegistry`/`validateKindDef`). Declarations are **`kind_def` records** (not a table/endpoint): `put` validates + registers, `query {kind:kind_def}` discovers, `Space.loadKinds` rebuilds the registry at startup; the `kind_def` meta-kind (`META_KIND_DEF`) is the one code bootstrap. Invalid declarations rejected (`invalid_kind`/`invalid_path`/`invalid_type`/`duplicate_path`/`unsortable_path`); redeclaring `kind_def` rejected (`reserved_kind`).
- [x] Full operator set in the oracle (`src/core/matching.ts`): `$eq` (implicit), `$gt/$gte/$lt/$lte`, `$in`, `$exists`, `$any/$each`, `$and/$or` (depth ≤ 3). Forbidden (`$regex/$where/$expr`) and deferred (`$ne/$nin/$not/$prefix`) operators rejected at compile.
- [x] Divergence semantics: missing ≠ null, no type coercion (cross-type = false), explicit array quantifiers (scalar predicates never distribute).
- [x] Template validation against the kind: predicate paths ⊆ indexed paths, `order_by` ⊆ sortable paths; `unknown_kind`/`undeclared_path`/`unsortable_path`. `order_by` + deterministic record-id tie-break.
- [~] **Physical expression indexes / predicate pushdown DEFERRED.** M0 `read_one` fetches by kind and filters + orders with the semantic oracle (`matchesRecord`, `firstByOrder`), which *defines* correctness. Per-kind expression indexes and pushing predicates onto them are a matched pair, deferred to when query performance is exercised (M1 keyset query). Noted so it is not mistaken for done.

**Verify:** PASSED. `deno task conformance` green — 36 tests, both adapters: registration
validation, undeclared-path/unknown-kind/unsortable-path rejection, forbidden/deferred
operator rejection, ranges + `$in`, missing ≠ null via `$exists`, no coercion, `$any/$each`
non-distribution, `$or/$and`, and `order_by` with id tie-break. See
[design-matching.md](design-matching.md).

### Phase 3 — take, leases, fencing — DONE

- [x] Atomic `take(template | record_id, lease_s)`: one transaction, envelope → `leased`, epoch bump, returns `{record, lease}`. Claim ranking is a pure helper (`src/core/take.ts` `rankClaimable`); the adapter fetches candidates + performs the guarded claim. `POST /v0/takes`.
- [x] `take(record_id=...)` re-verifies availability (and optional template) — selector, not bypass.
- [x] `renew`, `ack(result_record?)`, `nack`, `release` present `recordId + lease_id + epoch`; mismatch → `lease_lost` (a non-error 200 status). `POST /v0/leases/{renew,ack,nack,release}`.
- [x] Attempt semantics: `nack` +1 (backoff via `available_at`), lazy expiry +1 (reclaim at take), `release` +0; `dead_letter` past `max_attempts`; cumulative hard cap via `lease_hard_deadline` (renew past it → `lease_lost`).
- [x] `ack` is atomic consume-and-emit: consumes the task and inserts the result record (linked via `parentIds`) in one transaction; a fenced `ack` emits nothing.
- [ ] Long-poll blocking (`block`/`timeout`) deferred to M1; M0 `take` returns immediately (null when nothing claimable).
- [x] At-least-once + overlap-after-expiry documented in `src/storage/adapter.ts` and the design docs.

**Verify:** PASSED. `deno task conformance` green — 52 tests, both adapters: one valid
lease at a time, fenced `renew`/`ack` → `lease_lost` (emitting nothing), `nack` +1 /
`release` +0, lazy expiry +1, `dead_letter` after `max_attempts`, renew hard-cap fencing,
`take(record_id)` selector. Live `radia dev` confirmed via curl: take → lease, second
take → null, `ack` with result → `ok`+`resultId`, stale `ack` → `lease_lost`, result
record carries `parentIds:[task]`. See [design-api.md](design-api.md).

> Expiry is exercised deterministically in tests with a negative `leaseSeconds` (puts
> `leased_until` in the past), avoiding sleeps. Lazy reclaim-at-take stands in for the
> background sweeper, which lands with durable timers in M2.

### Phase 4 — idempotency — DONE

- [x] `idempotency (principal, operation, idem_key)` table holding request hash + stored response (incl. generated ids), in both adapters.
- [x] `withIdem` wrapper runs **inside** each op's transaction and checks the stored response **before** the effect (which includes lease validation); the response is written in the same transaction as the effect. Single-connection embedded serializes same-key requests.
- [x] Same hash → replay stored response; different hash → `idempotency_conflict` (409 at the wire). Applied to `put`, `ack`, `nack`, `release`, `renew` (`take` is exempt — a claim). Wire: `Idempotency-Key` header; request hash computed server-side in `src/core/space.ts` (`idem()`).

**Verify:** PASSED. `deno task conformance` green — 60 tests, both adapters: put replay →
same id + inserted once, put conflict → `idempotency_conflict`, **ack replay after a lost
response → stored `ok` + same `resultId`, not `lease_lost`** (with a keyless retry fenced),
ack conflict → `idempotency_conflict`. Live `radia dev` confirmed via curl (header replay,
409, ack-replay-vs-fenced). This is the load-bearing ordering in [gotchas.md](gotchas.md).

### Phase 5 — event log and dead-letter — DONE

- [x] Append-only `events` table (monotonic `seq`, id, ts, run_id, operation, record_id, kind, state, detail) written in the **same transaction** as each mutation via `appendEvent`, inside each op's tx. Run identity on every event (creator principal for `put`, lease owner for settlements — real run tokens now built, M1).
- [x] One event per **mutation**: `put`, `take`, `ack` (with `resultId` in detail), `nack`, `release`, and `expire`→`dead_letter`. No-op outcomes (`lease_lost`, idempotency replay) append nothing. `renew` is intentionally not evented (heartbeat noise; it changes no lifecycle state). Usually one op is one mutation; `ack` **with a result** is the exception — it consumes the parent *and* inserts a record, so it appends two: the result's own `put` (its own kind, `state: available`, `detail.ackOf` = parent) then the parent's `ack`. Without that `put` the successor would be unwatchable: `matchesEvent` needs an `available` event carrying the record's own kind, and the `ack` event is `consumed` and carries the parent's. Fixed after Phase 5 was marked done; regression cases in `conformance/suites/{events,watches}.ts`.
- [x] Dead-letter transition preserves `kind` (Phase 3); event records resulting state.
- [x] Lineage BFS over `parent_ids` (`src/core/space.ts` `getLineage`, cycle-guarded, node-capped). Endpoints: `GET /v0/ops/events?after=&limit=`, `GET /v0/ops/records/{id}/lineage`.

**Verify:** PASSED. `deno task conformance` green — 68 tests, both adapters: successful
ops append one event each in seq order with run identity; `lease_lost` and idempotency
replay append nothing; nack backoff vs. dead-letter evented with resulting state; lineage
returns ancestry with correct depths. Live `radia dev` confirmed via curl (event stream
put/take/ack, lineage child→parent). See [design-observability.md](design-observability.md).

> Dev UI live feed + lineage viewer now BUILT (Feed tab polls `/v0/ops/events`; record detail
> shows ancestry) — the last two dev-UI panels from the "Dev UI" section.

### Phase 6 — basic fault suite — DONE

- [x] Crashes simulated by **composition**, not test hooks in production code: a crashed worker is one that took a lease and never acked, with its lease forced expired via a negative `leaseSeconds` (deterministic, no sleeps); a lost response is a discarded-and-retried ack. `conformance/suites/faults.ts`.
- [x] Cases (all on both adapters): crash before effect (reclaimed, runs once, no loss), crash after effect before ack (at-least-once — effect repeats, space stays consistent), crash after commit before response (idempotent ack replay, one result), duplicate ack (keyed replay safe, bare duplicate fenced), stale ack after reassignment (old lease fenced, new one settles).

**Verify:** PASSED. `deno task conformance` green — 78 tests, both adapters. Duplicate and
stale acks resolve via idempotency/fencing, not corruption; the at-least-once cost is made
explicit rather than hidden. Fuller matrix (partition, DB failover, cursor storm) needs
real infra and is deferred past M0 — see [plan-validation.md](plan-validation.md).

### Phase 7 — surfaces and the demo — DONE

- [x] Auto-provisioned local credentials — **same API shape as production, never "no tokens"**. `radia dev` mints an operator token and writes it to `$XDG_STATE_HOME/radia/credentials.json` (`%APPDATA%`/`~/.radia` elsewhere), mode 0600, keyed by base URL; removed on clean shutdown, since operator tokens die with the process. The CLI, MCP adapter, and Python SDK all resolve it the same way (`RADIA_TOKEN` overrides). Implemented in `src/credentials.ts` rather than `src/core/auth.ts`: `core/` is storage- and IO-agnostic, and this touches the filesystem. The no-header operator default still exists for `curl` and the browser console, but nothing radia ships depends on it.
- [x] Bundled MCP adapter (`src/mcp/`): newline-delimited JSON-RPC 2.0 over stdio, 15 tools. **Credentials outside the model context** — the token is attached by the adapter and appears in no schema, result, or error. **Heartbeats internally** — `space_take` returns an opaque `claimId`; the fenced lease stays in the adapter and is renewed at lease/3, so a model that thinks for minutes keeps its claim and cannot forge, replay, or leak a lease. Kinds are discovered through `space_kinds`, never hardcoded; tool descriptions carry the usage guidance rather than a system prompt teaching the substrate.
- [x] Friendly dev UI (`src/ui/index.html`) served at `GET /` — BUILT ahead of schedule: space overview, records browser, kinds, put form, query playground, worker panel, live feed, lineage, graph, auth, and the Space map. Public-API-only; single file plus one vendored, same-origin asset (`src/ui/vendor/`). See "Dev UI" above. Remaining polish: SSE push for the feed (still polls).
- [x] Minimal CLI (`src/cli.ts`) over the public API only: `health stats doctor kinds get lineage children events watch put query read-one take ack nack release`, `--json` on every verb. `take --json` emits the claim; pipe it back to `ack -`/`nack -`/`release -`. Discovery-first — `kinds` is a query for `kind_def` records; no verb carries a table of known kinds.
- [x] TS SDK (`sdk/ts/client.ts` + `loop.ts` — `RadiaClient` over `/v0`, `agentLoop` with heartbeat at lease/3, per-attempt idempotency key). Demo agents in `examples/` + `deno task demo` exercise it end-to-end over HTTP.
- [x] **Python SDK at parity** (`sdk/py/radia.py`): `RadiaClient` (records, claims, watches with SSE reconnect + opaque cursor, ops reads), `agent_loop` with background watchers, heartbeat, per-attempt idempotency key, and the same permanent-403-on-watch handling as the TS loop. **Standard library only** — `urllib` + `threading`, nothing to install, Python 3.9+.
- [x] Release wrapping: `scripts/build-release.sh` (`deno task release`) — `deno compile` for 5 targets, then stages the esbuild/uv shape: `dist/npm/radia` (launcher + `optionalDependencies` on per-platform packages) and `dist/pypi` (wheel source with a launcher that `execv`s the bundled binary; `exec` matters so `radia mcp`'s stdio stays a direct pipe). `/dist/` is gitignored. Publishing is manual and unexercised — see Verify.

**Verify:** PASSED for everything runnable locally. Against a live space: `radia dev` provisions
the credential (0600) and the CLI presents it — proven by a bogus `RADIA_TOKEN` 401ing on an
ops-plane call while the provisioned one succeeds; full `put → query → take → ack(result)`
round trip through the CLI; the MCP adapter driven over real stdio JSON-RPC through
`initialize → tools/list → space_kinds → space_put → space_take → space_ack`, with the token
absent from every stdout frame and stderr, a double-settle returning `isError` instead of
killing the session, and a 6-second lease held for 15 seconds still acking `ok` (the internal
heartbeat, proven — without it that ack fences out); the Python SDK against the same space for
kinds/put/query, a three-record `agent_loop` drain emitting results, a live watch wakeup, and
credential resolution at parity with `RADIA_TOKEN` precedence; and the compiled binary serving
the console, the vendored bundle, and its own CLI.

**Not verified:** `npx radia dev` / `pipx run radia dev` end to end — that needs a publish (or a
local registry), and installing packages is out of scope here. Cross-compilation for the four
non-host targets is likewise unrun; only the host target was built. The staged package metadata
is therefore best-effort until someone publishes once.

## Open questions

- **SQLite library — resolved to `node:sqlite`.** The FFI package `jsr:@db/sqlite`
  segfaulted under Deno 2.9.2 ([gotchas.md](gotchas.md)), so the adapter uses the built-in
  `node:sqlite`. It is marked unstable upstream; watch for API changes on Deno upgrades.
- **npm/pip binary distribution mechanics** (embed vs. download-on-install) — defer the
  polished version to M1; a rough shim is enough for the M0 demo.

Resolved: **two embedded adapters (PGlite + SQLite) ship in M0** — the port-abstraction
test happens now, not at M1. OpenAPI freeze scope is settled by the policy below.

<!-- When M0 lands: fold each phase's built behavior into the relevant architecture-*.md
     (promoted from design-*.md), point those docs into src/ paths + symbols, delete the
     landed phases here, and note the promotion in CLAUDE.md. -->
