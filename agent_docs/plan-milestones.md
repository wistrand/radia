# Plan: milestones

> Status: not started. This whole repo is design-only. Origin: outline §11.

## Goal

Deliver Radia in four milestones, embedded-first, freezing the wire contract early so the
implementation and storage backend can change behind it. Each milestone runs the same
conformance + fault-injection suite against every storage adapter (see
[design-storage.md](design-storage.md) invariants).

## Current state

M0 (Phases 0–6) plus M1 watches are built and verified; see
[plan-m0-implementation.md](plan-m0-implementation.md) for the per-phase record and the
`design-*` docs for spec + rationale + source pointers. Remaining M0: MCP adapter + Python
SDK. M2/M3 are unbuilt.

## Phases

### M0 — semantic kernel prototype, embedded-first — DONE (except MCP adapter + Python SDK)

**Status:** Phases 0–6 built and verified (88 conformance tests on both adapters); the web
console (Feed, records browser, kinds, query, worker, and a relationship-**graph** view),
runnable agent examples, and a CLI LLM chatbot ship too. Enhancements layered on since the
phases: M1 watches (below), optional on-disk persistence (`--db`, records + envelopes +
events + idempotency + kind declarations), the chatbot's conversation-as-record-thread
model, and dev diagnostics (`GET /v0/records/{id}` and `/graph`). Remaining M0 items: the
bundled **MCP adapter** and the **Python SDK** (Phase 7). Full per-phase record in
[plan-m0-implementation.md](plan-m0-implementation.md).

Scope note: 2–3 careful weeks for a focused prototype (embedded storage, limited
predicates, auto-provisioned local auth, minimal hardening, basic fault testing) —
explicitly **not** production-readiness.

> The buildable, phase-by-phase version of this checklist (Deno + TS runtime, PGlite
> embedded storage, ordered phases with verify steps) is in
> [plan-m0-implementation.md](plan-m0-implementation.md).

- [~] `deno task dev` — embedded storage (PGlite/SQLite), single process, **web console** (dev UI). Bundled **MCP adapter** not built (Phase 7); distribution is `deno task dev`, not `npx` yet.
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
- [~] TS SDK stub built (`sdk/ts/`); **Python SDK** not built (Phase 7)
- [x] minimal CLI (`radia dev`)

**Verify:** conformance suite green against the embedded adapter; the under-a-minute
two-terminal demo works.

### M1 — usable runtime

- [ ] Postgres storage adapter (same conformance + fault suite as embedded)
- [ ] single-node deployment mode with admin-provisioned auth
- [ ] read_one + keyset query
- [ ] long-polls
- [~] schema version registry — kind *declarations* now persist (`kinds` table, reloaded at startup); schema *versioning* + migration still to do
- [ ] kind- and template-scoped grants
- [ ] resource limits enforced
- [ ] hash-chained event log
- [ ] polished Python + TS SDKs
- [x] watches (SSE, cursors, 410 semantics) — `POST /v0/watches` + `GET /v0/watches/{id}/events` (SSE, `Last-Event-ID`/`?cursor=` resumption, 410 `cursor_expired` path); backed by the event log + an in-process `Notifier` (LISTEN/NOTIFY-equivalent wakeup); wakeup-by-kind (+ predicate) matching in `Space.matchesEvent`. SDK `client.watch()` async generator; `agentLoop` is now event-driven (watch wakeups + poll fallback). 410/GC dormant until event-log retention (M2).
- [ ] artifact service
- [ ] orphan/starvation diagnostics

**Verify:** the same suite green against Postgres *and* embedded; watch resumption and
410 `cursor_expired` behave per [design-api.md](design-api.md).

### M2 — coordination protocols

- [ ] request/bid/award (see [design-marketplace.md](design-marketplace.md))
- [ ] durable timers
- [ ] transactional budget reservation/settlement
- [ ] runtime envelope encryption + crypto-shredding
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
- [ ] delegation contexts end-to-end
- [ ] taint + declassification
- [ ] repeated-pattern livelock detection
- [ ] re-execution tooling
- [ ] learned scoring after static scoring is measurable

**Verify:** scheduler baselines in [plan-validation.md](plan-validation.md) isolate the
agenda's contribution; semantic matching runs in shadow mode before enforcement.

## Open questions

- Whether the M0 TypeScript-on-PGlite server is rewritten before or after M1 (the wire
  contract is frozen either way).
