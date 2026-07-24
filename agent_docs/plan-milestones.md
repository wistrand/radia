# Plan: milestones

> Status: not started. This whole repo is design-only. Origin: outline §11.

## Goal

Deliver Radia in four milestones, embedded-first, freezing the wire contract early so the
implementation and storage backend can change behind it. Each milestone runs the same
conformance + fault-injection suite against every storage adapter (see
[design-storage.md](design-storage.md) invariants).

## Current state

Nothing built. All subsystem behavior is specified in the `design-*` docs linked from
[CLAUDE.md](../CLAUDE.md). When a milestone lands, promote the relevant `design-*` docs to
`architecture-*` and update this file's status.

## Phases

### M0 — semantic kernel prototype, embedded-first

Scope note: 2–3 careful weeks for a focused prototype (embedded storage, limited
predicates, auto-provisioned local auth, minimal hardening, basic fault testing) —
explicitly **not** production-readiness.

- [ ] `npx radia dev` — embedded storage (SQLite/PGlite), single process, bundled MCP
      adapter + minimal web inspector
- [ ] put / take / ack / nack / release / renew
- [ ] record + envelope split with denormalized routing columns
- [ ] `body_sha256` on every record
- [ ] fencing epochs
- [ ] at-least-once semantics documented
- [ ] idempotency with stored responses, correct ordering
- [ ] equality/range matching on declared indexed paths
- [ ] transactional event log
- [ ] dead-letter state
- [ ] conformance suite as a storage-adapter contract from the first commit
- [ ] Python + TS SDK stubs
- [ ] minimal CLI

**Verify:** conformance suite green against the embedded adapter; the under-a-minute
two-terminal demo works.

### M1 — usable runtime

- [ ] Postgres storage adapter (same conformance + fault suite as embedded)
- [ ] single-node deployment mode with admin-provisioned auth
- [ ] read_one + keyset query
- [ ] long-polls
- [ ] schema version registry
- [ ] kind- and template-scoped grants
- [ ] resource limits enforced
- [ ] hash-chained event log
- [ ] polished Python + TS SDKs
- [ ] watches (SSE, cursors, 410 semantics)
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
