# Gotchas, rejected approaches, and risk register

Non-obvious decisions and the reasoning behind them — the "why is it like this" that the
spec alone doesn't carry. Skim before proposing a change to signing, encryption,
idempotency ordering, storage backends, or the delivery guarantee. Origin: outline §9.1,
§9.2, §13, and rationale scattered through §2–§8.

## Contents
- Findings (diagnosed during implementation)
- Traps and load-bearing decisions
- Rejected approaches (do not re-propose without revisiting these)
- Risk register

## Findings

### `jsr:@db/sqlite` FFI segfaults; use built-in `node:sqlite`

- **Symptom:** the conformance suite and even a standalone `new Database(":memory:")`
  exited 139 (SIGSEGV) with no output, under Deno 2.9.2 on Linux. First run also required
  `--allow-env` / `--allow-net` just to download a native `libsqlite3.so`.
- **Diagnosis:** `jsr:@db/sqlite@0.12.0` loads a prebuilt native library over FFI; that
  library crashes on load under this Deno build.
- **Fix:** the M0 SQLite adapter uses Deno's built-in **`node:sqlite`** (`DatabaseSync`)
  instead — no FFI, no native download, no `--allow-ffi`, and one fewer dependency.
- **Takeaway:** prefer the runtime's built-in SQLite to an FFI package. It also fits the
  minimal-deps / platform-independence invariant better. `node:sqlite` is still marked
  unstable upstream; watch for API changes on Deno upgrades.

## Traps and load-bearing decisions

- **Idempotency is checked before lease validation, and the order is load-bearing.**
  `ack` commits, the HTTP response is lost, the agent retries; the task is now consumed
  and the lease invalid. Validating the lease first would falsely return `lease_lost` for
  a succeeded operation. See [design-api.md](design-api.md).
- **At-least-once means external side effects can duplicate.** The space protects its own
  state atomically, not your emails. Side-effecting agents need idempotency at the effect
  boundary, an outbox, or the (candidate) transactional tool gateway. This is the
  contract, not a bug.
- **Physical execution overlaps lease expiry.** A fenced worker keeps running until it
  observes `lease_lost`. "At most one valid lease" is not "at most one running process".
- **`take(record_id=...)` is a selector, not a bypass.** The server re-verifies template,
  grants, admission, availability, and `claim_until` every time.
- **Encrypted content is coordination-invisible by construction.** Client-side-encrypted
  bodies are unmatchable, untaint-trackable, and invisible to diagnostics. E2E-from-the-
  runtime while plaintext is exposed to the LLM provider is rarely a coherent threat
  model. See [design-observability.md](design-observability.md) confidentiality layers.
- **Timing fields are never overloaded.** Reusing `deadline_at` as `available_at` (or any
  such shortcut) breaks retention-vs-lease separation. Keep the five distinct.
- **Provenance is not authority.** A result with a privileged data parent inherits no
  permission from it. See [design-data-model.md](design-data-model.md).

## Rejected approaches

Do not re-propose these without re-reading the rationale; they were considered and
rejected for stated reasons.

- **Per-agent record signatures (single-space case).** Rejected: the runtime already
  authenticates every `put` and is the sole writer; an agent's signing key would live
  where its bearer token lives; signatures authenticate origin, not trustworthiness (a
  prompt-injected agent signs poisoned output); server-assigned `runtime_meta` can't be
  agent-signed; PKI/rotation/canonicalization costs buy nothing against the real threats.
  The chosen posture is content hashes + tamper-evident event log + boundary signatures
  only at federation time. Full argument in
  [design-observability.md](design-observability.md).
- **Recipient-keyed / E2E encryption as a managed runtime feature.** Rejected until
  federation: content-routing requires the runtime to read content, and consumers decrypt
  into prompts anyway. Supported as client-owned hybrid records, never runtime-managed.
- **"Mongo-compatible" matching.** Rejected: the semantics diverge deliberately (missing
  ≠ null, no coercion, explicit array quantifiers). Claiming compatibility would be
  wrong. See [design-matching.md](design-matching.md).
- **`$regex` / `$where` / `$expr` in templates.** Never. Templates are data, not code.
- **Snapshot pagination cursors.** Deferred: keyset over immutable sort keys instead.
  `effective_priority` is mutable under aging, so it can't be a cursor key.
- **Eager (records × agents) candidate materialization in the scheduler.** Rejected for
  cost; candidates are incremental and capped. See [design-scheduler.md](design-scheduler.md).
- **Embedded mode as a weaker cousin.** Rejected: the conformance + fault suite runs on
  every adapter in CI from day one, or the backends drift.

## Risk register

From outline §13. Each risk with its mitigation:

| Risk                       | Mitigation                                                                              |
|----------------------------|-----------------------------------------------------------------------------------------|
| Semantic-matching drift    | shadow mode first, before enforcement                                                   |
| Livelock                   | repeated-signature + no-progress detection (see design-observability.md)                 |
| Hot-record contention      | admission top-K                                                                          |
| Schema anarchy             | per-kind schemas                                                                         |
| Agenda gaming              | server-computed `effective_priority`, historical calibration                            |
| Storage-adapter drift      | conformance suite on every adapter in CI — the only guard                                |
| Naming                     | PyPI as `radia-space`, trademark screen, courtesy note to Perlman, watch Radia Inc.      |
| Side-effect duplication    | at-least-once is the contract; transactional tool gateway is the mitigation (and possibly the second product) |
