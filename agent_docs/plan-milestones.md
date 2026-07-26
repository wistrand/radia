# Plan: milestones

> Status: M0 (Phases 0–7) built and verified; M1 partly built (watches, authorization stack,
> Postgres adapter); M2/M3 unbuilt. Origin: outline §11.

## Goal

Deliver Radia in four milestones, embedded-first, freezing the wire contract early so the
implementation and storage backend can change behind it. Each milestone runs the same
conformance + fault-injection suite against every storage adapter (see
[design-storage.md](design-storage.md) invariants).

## Current state

M0 (Phases 0–7) plus M1 watches, the M1 **authorization stack** (grants, run-token bootstrap
chain, per-run leases with stop/quarantine, delegation, taint), and the M1 **Postgres adapter**
(conformance-verified against a live server) are built; see
[plan-m0-implementation.md](plan-m0-implementation.md) for the per-phase record and the
`design-*` docs for spec + rationale + source pointers. M0 is complete through Phase 7 (CLI,
MCP adapter, Python SDK, release wrapping); only the registry publish itself is unexercised.
The rest of M2/M3 is unbuilt.

## Phases

### M0 — semantic kernel prototype, embedded-first — DONE

**Status:** Phases 0–7 built and verified (190 conformance tests across the embedded
adapters, 213 including a live Postgres); the web console (Feed, records browser, kinds, query, worker, relationship-**graph**, and an **Auth**
view), runnable agent examples, and a CLI LLM chatbot (runnable with real auth roles) ship too.
Enhancements layered on since the phases: M1 watches (below), the M1 **authorization stack**
(grants, run tokens, per-run leases, delegation, taint), optional on-disk persistence (`--db`,
records + envelopes + events + idempotency + kind declarations), the chatbot's
conversation-as-record-thread model, and dev diagnostics (`GET /v0/ops/records/{id}` and
`/graph`), the **Space** map in the console, and Phase 7's surfaces: the `radia` CLI, the
bundled **MCP adapter** (stdio JSON-RPC; credential and fenced lease held outside the model
context, lease renewed internally), the **Python SDK** at parity (stdlib only), auto-provisioned
local credentials, and `deno task release` (per-OS binaries + npm/pip launcher packages).
`npx radia dev` / `pipx run` are staged but unpublished, so that install path is unexercised.
Full per-phase record in
[plan-m0-implementation.md](plan-m0-implementation.md).

Scope note: 2–3 careful weeks for a focused prototype (embedded storage, limited
predicates, auto-provisioned local auth, minimal hardening, basic fault testing) —
explicitly **not** production-readiness.

> The buildable, phase-by-phase version of this checklist (Deno + TS runtime, PGlite
> embedded storage, ordered phases with verify steps) is in
> [plan-m0-implementation.md](plan-m0-implementation.md).

- [x] `deno task dev` — embedded storage (PGlite/SQLite), single process, **web console** (dev UI), bundled **MCP adapter** (`radia mcp`). Distribution staged by `deno task release` (binaries + npm/pip shims); `npx radia dev` awaits a publish.
- [x] put / take / ack / nack / release / renew
- [x] record + envelope split with denormalized routing columns
- [x] `body_sha256` on every record
- [x] fencing epochs
- [x] at-least-once semantics documented
- [x] idempotency with stored responses, correct ordering
- [x] equality/range matching on declared indexed paths (plus `$in`/`$exists`/`$any`/`$each`/`$or`)
- [x] transactional event log
- [x] dead-letter state
- [x] conformance suite as a storage-adapter contract from the first commit
- [x] TS SDK (`sdk/ts/`) and **Python SDK** (`sdk/py/radia.py`, stdlib only) at parity — client, watches, and an `agent_loop` with heartbeat in both
- [x] minimal CLI — `radia dev`/`mcp` plus the public-API verbs in `src/cli.ts`

**Verify:** conformance suite green against the embedded adapter; the under-a-minute
two-terminal demo works.

### M1 — usable runtime

- [x] Postgres storage adapter (same conformance suite as embedded) — `src/storage/postgres.ts` (deno-postgres pool) over the shared `src/storage/pgbase.ts` body PGlite also uses, so both speak identical SQL; `take` claims atomically across connections with a checked compare-and-set over a bounded candidate window (it originally used `FOR UPDATE ... SKIP LOCKED` over the whole kind, which starved peers — see [gotchas.md](gotchas.md)). `--storage postgres` in `radia dev`. **VERIFIED:** `scripts/pg-conformance.sh` green against a live Postgres 16 — **213 passed, 0 failed** (142 sqlite + pglite, 71 postgres), each test in an ephemeral schema. This is the first run of the pool-only paths: `SKIP LOCKED` claims across connections, and the `xid8` watermark in `getEvents` that keeps watch cursors gap-free when transactions commit out of seq order. Still to do: the same run in CI (it is manual today), and the partition/failover fault suite (M2).
- [~] single-node deployment mode with admin-provisioned auth — **auth bootstrap chain + per-run leases built** (agent definitions → run tokens → stop/quarantine; `Authorization: Bearer` is the sole channel; a run inherits its agent's grants and owns its leases; graceful stop vs. emergency quarantine; credential index is a cache over `agent_definition`/`agent_run` records; the dev console holds a server-minted operator token). OIDC for `human:*`, the deployment mode itself, and federated identity still to do. See [design-auth.md](design-auth.md).
- [x] read_one + **keyset query** — `after`/`dir` on `POST /v0/records/query` (`Page` in `src/storage/adapter.ts`). A cursor over record id, not an offset, so a page stays correct while the space is written to; `dir: "desc"` is what makes "the newest N" expressible at all, since the deterministic tie-break is ascending id and a plain limit therefore returns the OLDEST matches. Defined for the natural id order only — combining a cursor with `order_by` is rejected rather than silently resolved, because a keyset over a body field needs the whole sort key plus the oracle's type rules. Pinned by `conformance/suites/keyset.ts`, including paging while records are inserted.
- [ ] long-polls
- [~] schema version registry — kind *declarations* now persist (as `kind_def` records, reloaded at startup by `Space.loadKinds`); schema *versioning* + migration still to do
- [x] kind- and template-scoped grants — grants are `grant` records; `Space.authorize` + `isPrivileged`; enforced at the HTTP boundary; `/v0/ops/*` and `grant`/`signal` writes operator-only. **Template-scoped** grants built for read (query/read_one/take, `grant ∧ request` via `combineMatch`) AND write (put/ack, the record body must satisfy the template via `bodyMatchesGrant`). Delegation and taint are also built (rows below); budgets and per-principal trust classification still to do. See [design-auth.md](design-auth.md).
- [ ] resource limits enforced
- [ ] hash-chained event log
- [ ] polished Python + TS SDKs
- [x] watches (SSE, cursors, 410 semantics) — `POST /v0/watches` + `GET /v0/watches/{id}/events` (SSE, `Last-Event-ID`/`?cursor=` resumption, 410 `cursor_expired` path); backed by the event log + an in-process `Notifier` (LISTEN/NOTIFY-equivalent wakeup); wakeup-by-kind (+ predicate) matching in `Space.matchesEvent`; **grant-gated** (`Space.authorizeWatch` — any grant on the kind, template AND-ed into the watch scope). SDK `client.watch()` async generator; `agentLoop` is now event-driven (watch wakeups + poll fallback). 410/GC dormant until event-log retention (M2).
- [x] artifact service — the `BlobStore` port (content-addressed, memory + filesystem impls) + reserved `artifact` records + short-lived download capabilities + **optional encryption at rest** (per-blob AES-GCM DEK, AES-KW-wrapped under a space KEK). See [design-data-model.md](design-data-model.md) §2.4. Open: reference-aware GC and KEK rotation.
- [~] orphan/starvation diagnostics — a derived-diagnostics report + remediation ships (`GET /v0/ops/diagnostics`; reclaim/dead-letter/requeue per record OR by envelope selector via `POST /v0/ops/remediate`, so draining a backlog is one call per page rather than one per record); uses age/state heuristics, not full template-match orphan/starving-template analysis

**Verify:** the same suite green against Postgres *and* embedded — **PASSED**, 213/213 via
`scripts/pg-conformance.sh` (sqlite, pglite, and a live Postgres 16). Watch resumption and 410
`cursor_expired` per [design-api.md](design-api.md) are still only partly covered: `createWatch`,
`matchesEvent`, and start-cursor semantics are in the suite, but SSE reconnection and the 410
path are exercised by an HTTP smoke rather than conformance, and 410 stays dormant until
event-log retention lands (M2).

### M2 — coordination protocols

- [ ] request/bid/award (see [design-marketplace.md](design-marketplace.md)) — speculative ahead of a first user; gate behind a measured baseline like the scheduler, not build-on-spec (see [plan-validation.md](plan-validation.md))
- [ ] durable timers — in scope: the delayed-visibility sweeper over the envelope's `available_at` that retry backoff needs anyway. Out of scope: a general workflow-timer / cron / signal library — that is Temporal's ground; Radia does not reimplement durable execution (see [research-positioning.md](research-positioning.md))
- [ ] transactional budget reservation/settlement
- [~] runtime envelope encryption + crypto-shredding — **built for artifact blobs** (`src/storage/crypto.ts`: per-blob DEK, wrapped under a space KEK from env/keyring, destroyable sidecar so deleting the key destroys the payload while the record and its digest stay verifiable). Record *bodies* are still plaintext, and KMS wrapping + rotation are open.
- [ ] signed, externally-anchored log checkpoints
- [ ] lineage viewer
- [ ] run-scoped short-lived credentials
- [ ] revocation paths
- [ ] fault-injection suite

**Verify:** fault-injection matrix (see [plan-validation.md](plan-validation.md)) passes;
crypto-shredding deletes a body while the event chain still verifies.

### M3 — intelligent control

- [ ] scheduler-enforced atomic admission (see [design-scheduler.md](design-scheduler.md))
- [ ] semantic matching
- [~] delegation contexts end-to-end — **built (M1):** `delegation_context` is server-derived from the lease on ack-emitted work (authority chain accumulates per hop; never data parents); ack authorizes the acting agent's `put`. Remaining for M3: the stricter chain-intersection policy composed with taint.
- [~] taint + declassification — **built (M1):** taint propagates along data parents (put + ack), clients may raise but never clear it, `take {requireUntainted}` is a claim-time barrier, and a privileged `declassify` emits a clean successor. Remaining for M3: per-principal trust classification and taint-composed access checks.
- [ ] repeated-pattern livelock detection
- [ ] re-execution tooling
- [ ] learned scoring after static scoring is measurable

**Verify:** scheduler baselines in [plan-validation.md](plan-validation.md) isolate the
agenda's contribution; semantic matching runs in shadow mode before enforcement.

## Open questions

- Whether the M0 TypeScript-on-PGlite server is rewritten before or after M1 (the wire
  contract is frozen either way).
