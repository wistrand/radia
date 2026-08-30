# Plan: milestones

> Status: M0 (Phases 0–7) built and verified; M1 largely built (watches, the authorization stack,
> the Postgres adapter, the tamper-evident event chain, resource limits, credential exchange,
> OIDC sign-in for humans — server, console and CLI, [plan-oidc.md](plan-oidc.md) — and DELEGATED
> RUNS, so one worker fleet can serve many people without holding anyone's credential,
> [plan-delegation.md](plan-delegation.md)); a real M2
> slice is built too (GC + compaction, event-log retention, ops-plane tiers, revocation,
> pushdown + the scan budget); the rest of M2/M3 is unbuilt. Workspaces and the git projection
> are complete beside the list, bar push. Origin: outline §11.
>
> **Read `[~]` before assuming an item is work waiting to be done.** A box here is one of three
> things, and an audit on 2026-08-29 found the third outnumbering the first: OPEN (nobody decided),
> GATED (decided, waiting on a first user or a measurement, and it says what would ungate it), or
> ALREADY ANSWERED ELSEWHERE under another name. Genuinely open and ungated, in order of size:
> schema versioning + migration, SSE backpressure, externally-anchored checkpoints, and KMS
> wrapping. The Python SDK's credential exchange was on that list and shipped 2026-08-29, which
> closes the last SDK parity gap. [plan-validation.md](plan-validation.md) was the
> largest entry on that list and is now as complete as it can be: the fault matrix finished
> 2026-08-29, and the baselines ran the same day for two of their three arms, the third blocked
> until there is a scheduler to compare against.

## Goal

Deliver Radia in four milestones, embedded-first, freezing the wire contract early so the
implementation and storage backend can change behind it. Each milestone runs the same
conformance + fault-injection suite against every storage adapter (see
[design-storage.md](design-storage.md) invariants).

## Beside the milestones: a workspace for code generation (BUILT)

This was a "later, not scheduled" note and it got built anyway, driven by use rather than by this
list, which is worth recording as much as the outcome. The sandbox was a single-file JS evaluator
and real code generation iterates on a PROJECT, so a tree became a manifest record plus one artifact
per file: records stay the medium, the filesystem is ephemeral scratch, and every version of every
file is content-addressed, attributable and individually erasable.

Phases 0-12 of [plan-workspaces.md](plan-workspaces.md) are done: manifests, materialisation into a
jail, write-back, fork detection, `check` attestations, editing in place, a second sandbox backend,
serving a tree over one path capability, git export, and `git clone` over HTTP. Push stays refused.
Three of those phases came from watching it fail rather than from the plan (git export, the read
side, attachment), which is the same pattern as this note existing at all.

None of it is in the runtime, which has no idea what a file or a path is. See
[design-workspaces.md](design-workspaces.md) and [extensions/README.md](../extensions/README.md).

## Current state

M0 (Phases 0–7) plus M1 watches, the M1 **authorization stack** (grants, run-token bootstrap
chain, per-run leases with stop/quarantine, delegation, taint), the M1 **Postgres adapter**
(conformance-verified against a live server), the **tamper-evident event chain** and the M1
**resource limits** are built; see
[plan-m0-implementation.md](plan-m0-implementation.md) for the per-phase record and the
`design-*` docs for spec + rationale + source pointers. Only the registry publish itself is
unexercised. The rest of M2/M3 is unbuilt.

One more thing landed off the list: **a client re-authenticates itself**. The durable half of the
bootstrap chain is exchanged for the short half whenever that lapses. Renewing requires a process
that is awake inside the window, which rules out most of the things holding a credential. See
[design-auth.md](design-auth.md), "The durable half".

## Phases

### M0: semantic kernel prototype, embedded-first (DONE)

**Status:** Phases 0–7 built and verified (190 conformance tests at the time; the suite has grown
with M1, so take the current number from a run); the web console (Feed, records browser, kinds,
query, worker, relationship-**graph**, **Flows**, and an **Auth** view), runnable agent examples, and a CLI LLM
chatbot (runnable with real auth roles) ship too. Beyond the phases: M1 watches (below), the M1
**authorization stack** (grants, run tokens, per-run leases, delegation, taint), optional on-disk
persistence (`--db`, records + envelopes + events + idempotency + kind declarations), the
chatbot's conversation-as-record-thread model, dev diagnostics (`GET /v0/ops/records/{id}` and
`/graph`), the **Space** map in the console, and Phase 7's surfaces: the `radia` CLI, the
bundled **MCP adapter** (stdio JSON-RPC; credential and fenced lease held outside the model
context, lease renewed internally), the **Python SDK** at parity (stdlib only), auto-provisioned
local credentials, and `deno task release` (per-OS binaries + SDK-only npm/pip packages).
The binary installs only via `curl | sh` (`docs/install.sh`; decided 2026-08-30, replacing the
launcher-package plan), native Windows is unsupported (WSL2 runs the Linux binary), and nothing
is published yet, so the install path is unexercised.
Full per-phase record in
[plan-m0-implementation.md](plan-m0-implementation.md).

Scope note: 2–3 careful weeks for a focused prototype (embedded storage, limited
predicates, auto-provisioned local auth, minimal hardening, basic fault testing), and
explicitly **not** production-readiness.

> The buildable, phase-by-phase version of this checklist (Deno + TS runtime, PGlite
> embedded storage, ordered phases with verify steps) is in
> [plan-m0-implementation.md](plan-m0-implementation.md).

- [x] `deno task dev`: embedded storage (PGlite/SQLite), single process, **web console** (dev UI), bundled **MCP adapter** (`radia mcp`). Distribution staged by `deno task release` (binaries for the `curl | sh` installer + SDK-only npm/pip packages: TS SDK and `extensions/` as source in npm, the Python SDK in pip); the install path awaits a release tag.
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
- [x] TS SDK (`sdk/ts/`) and **Python SDK** (`sdk/py/radia.py`, stdlib only) at parity: client, watches, and an `agent_loop` with heartbeat in both
- [x] minimal CLI: `radia dev`/`mcp` plus the public-API verbs in `src/surfaces/cli.ts`

**Verify:** conformance suite green against the embedded adapter; the under-a-minute
two-terminal demo works.

### M1: usable runtime

- [x] Postgres storage adapter (same conformance suite as embedded). `src/storage/postgres.ts` (deno-postgres pool) over the shared `src/storage/pgbase.ts` body PGlite also uses, so both speak identical SQL; `take` claims atomically across connections with a checked compare-and-set over a bounded candidate window (it originally used `FOR UPDATE ... SKIP LOCKED` over the whole kind, which starved peers; see [gotchas.md](gotchas.md)). `--storage postgres` in `radia dev`. **VERIFIED:** `scripts/pg-conformance.sh` green against a live Postgres 16 (**698 passed, 0 failed** as of 2026-08-04; 508 embedded plus the postgres rows), each test in an ephemeral schema. That run is the only cover for the pool-only paths: `SKIP LOCKED` claims across connections, and the `xid8` watermark in `getEvents` that keeps watch cursors gap-free when transactions commit out of seq order. **That run is now in CI** (`.github/workflows/ci.yml`, the `postgres` job against a service container), together with the two CONTENDED claim-path cases the embedded adapters cannot express (`test/concurrency.test.ts`). The partition and failover rows landed 2026-08-29 and run on every adapter (`test/conformance/suites/failover.ts`, `suites/faults.ts`).
- [~] single-node deployment mode with admin-provisioned auth. **THE MODE IS BUILT** (2026-08-29, `radia serve`, `test/serve.test.ts`): the same space `dev` runs, in a deployment's posture. No credential on stdout or in this machine's credential file, `--auth open` refused, persistent storage required, the console off unless asked, and a `--config` file that is these same flag names without the dashes. Still on the deployment rather than on us: TLS, backup/restore, and an upgrade procedure. **Auth bootstrap chain + per-run leases built** (agent definitions → run tokens → stop/quarantine; `Authorization: Bearer` is the sole channel; a run inherits its agent's grants and owns its leases; graceful stop vs. emergency quarantine; credentials resolve from `agent_definition`/`agent_run` records per request, uncached; the dev console holds any session token, operator or a person's, and mints the latter). A person gets a session through the same chain (`radia login`, or the console's Auth tab), so identity-scoped grants can separate two people on one space. **OIDC for `human:*` is BUILT** (2026-08-11, [plan-oidc.md](plan-oidc.md)): `POST /v0/sessions/oidc` mints runs from a verified id_token, the `oidc_identity` registry names the principal (first login enrolls, retire is a ban), the console has "Sign in with SSO" and the CLI `radia login --sso`, with `docker/keycloak/` as the worked issuer. Still to do: more than one issuer per space. See [design-auth.md](design-auth.md).
- [x] read_one + **keyset query**: `after`/`dir` on `POST /v0/records/query` (`Page` in `src/storage/adapter.ts`). A cursor over record id, not an offset, so a page stays correct while the space is written to; `dir: "desc"` is what makes "the newest N" expressible at all, since the deterministic tie-break is ascending id and a plain limit therefore returns the OLDEST matches. Defined for the natural id order only. Combining a cursor with `order_by` is rejected rather than silently resolved, because a keyset over a body field needs the whole sort key plus the oracle's type rules. Pinned by `test/conformance/suites/keyset.ts`, including paging while records are inserted.
- [x] long-polls: **DECIDED AGAINST 2026-08-29, not deferred.** The outline asked for a blocking
  `take`; both halves of what it promised are built elsewhere, and the gap it looked like it closed
  it does not. Wakeup is watches plus the lazy claim path (`agentLoop`: a watch per kind, poll floor
  1s), so blocking would shave one second. Waiting for an ANSWER is already a long poll at the
  CLIENT tier, deliberately polled rather than streamed because a watch per outstanding call is a
  stream per call (`sdk/ts/await.ts`, and `space_watch` in the MCP adapter). A held request occupies
  a browser connection exactly as an SSE stream does, so it is no escape from the six-per-origin
  budget either. Reopen on a client that cannot do SSE, or a measurement that the 1s floor costs
  something. See [design-api.md](design-api.md), "Wire protocol".
- [~] schema version registry ([plan-schema-versioning.md](plan-schema-versioning.md): PHASES 1 TO 3 BUILT 2026-08-29, phase 4 designed. A record now names the DECLARATION it was written under, materialized at commit the way `retention_until` is, so a redeclaration moves only future records; and a redeclaration that breaks something already stored is refused unless it acknowledges it. The finding that reorders the work: a kind declares no body schema, so this is about the routing contract and the patterns pinned to it): kind *declarations* persist (as `kind_def` records, reloaded at startup by `Space.loadKinds`, and re-read per kind on a stale-projection compile error so N instances over one database stay correct). Still to do: phase 4, the dispositions (quarantine, emit successors, or scope readers by version), and the compare-and-set half of the acknowledgement
- [x] kind- and pattern-scoped grants: grants are `grant` records; `Space.authorize` + `isPrivileged`; enforced at the HTTP boundary; `/v0/ops/*` is power-gated (`ops_grant` records, [architecture-ops-tiers.md](architecture-ops-tiers.md)) and `grant`/`signal` writes are operator-or-supervisor, everything else reserved operator-only. **Pattern-scoped** grants built for read (query/read_one/take, `grant ∧ request` via `combineMatch`) AND write (put/ack, the record body must satisfy the pattern via `bodyMatchesGrant`). Delegation and taint are also built (rows below); budgets and per-principal trust classification still to do. See [design-auth.md](design-auth.md).
- [~] resource limits enforced: record body bytes, artifact bytes, `$and`/`$or` nesting depth and watches per principal, plus (2026-08-04) **body depth** (`413 body_too_deep`), **body array length** (`413 array_too_long`), **pattern size** (`413 pattern_too_large`), **compiled predicate count** (`too_many_predicates`), **`$or` branch count** (`too_many_branches`), **`$in` cardinality** (`too_many_values`) and **registered interests per principal per kind** (`429 too_many_interests`). Each bounds a cost bytes do not: a pattern is stored and re-evaluated per candidate record, a body's shape is walked by the matcher and the event chain, and the interest registry is read by the dry-run matcher and the starvation split. Enforced in the RUNTIME, not the handler, since the SDK/MCP/in-process callers never pass through one; guarded by `test/conformance/suites/limits.ts`. Plus (2026-08-05) the **row-scan budget** (`429 scan_budget_exceeded`, default 200k), the first of these that needed a MECHANISM rather than a validator: the walk is chunked and yields between chunks, so the cost of a pattern SQL cannot decide is paid by its caller instead of by the whole space. Still to do: SSE backpressure. The slow-lane TIME budget listed here is a SCHEDULER concept (design-data-model.md §2 says so), so it is gated with M3 rather than open in M1.
- [x] hash-chained event log: each event is sealed into a chain (`event_seal`) once the log's finality watermark passes it, so the hot path pays nothing and the chain is eventually consistent (`unsealed` says how far behind). Sealing runs ON DEMAND, never on a timer (the lesson `Notifier` and `sweepWatches` learned). The hash covers the event AND the record's `body_sha256`, so editing a body directly is caught rather than leaving a perfect chain. `src/core/seal.ts`, `GET /v0/ops/integrity`, `radia integrity`, in `radia doctor`. **A chain stored in the database it protects detects corruption and careless edits, not a rewrite**: each link is HMAC'd under a key that lives beside the database (`RADIA_SEAL_KEY`, else `.radia/seal.json`), which is what makes a rebuild detectable. Externally anchored checkpoints stay M2.
- [~] polished Python + TS SDKs. **TS gained the credential exchange** (`ClientAuth.definitionToken`:
  a client whose short token lapses mints another instead of ending the session, once per failure,
  never on a 403, shared across concurrent calls, and on the SSE stream). That is what makes a
  session outlive the 12-hour run ceiling, and renewal alone could not, since it serves only a
  holder that is awake inside the window. **Python gained the same thing on
  2026-08-29** (`definition_token=`, `test/py-exchange.test.ts`, six cases against a real socket),
  which closes the last parity gap: `keep_alive` now mints a fresh run at the ceiling instead of
  reporting the session lost, and the artifact calls and the SSE stream recover too, since neither
  shares the ordinary request path.
- [x] watches (SSE, cursors, 410 semantics): `POST /v0/watches` + `GET /v0/watches/{id}/events` (SSE, `Last-Event-ID`/`?cursor=` resumption, 410 `cursor_expired` path); backed by the event log + an in-process `Notifier` (LISTEN/NOTIFY-equivalent wakeup); wakeup-by-kind (+ predicate) matching in `Space.matchesEvent`; **grant-gated** (`Space.authorizeWatch`: any grant on the kind, pattern AND-ed into the watch scope). SDK `client.watch()` async generator; `agentLoop` is event-driven (watch wakeups + poll fallback). The 410 check is live and sentinel-exempt (`Space.eventHorizon`, 2026-08-06); it fires once the M2 event sweep creates a horizon.
- [x] artifact service: the `BlobStore` port (content-addressed; memory, filesystem and S3-compatible impls, plus a migrating layer so a space can change backend) + reserved `artifact` records + short-lived download capabilities + **optional encryption at rest** (per-blob AES-GCM DEK, AES-KW-wrapped under a space KEK). See [design-data-model.md](design-data-model.md) §2.4. Reference-aware blob GC BUILT (2026-08-11, [plan-gc.md](plan-gc.md) phase 4: artifacts join retention, a live `gc` reclaims unreferenced bytes). KEK rotation BUILT: every `SealedKey` names the key that wrapped it (`kid`), a store reads and sweeps under retired keys as well as the current one, and `radia rewrap` (`POST /v0/ops/rewrap`) re-seals referenced payloads under the current key, which is what lets the retired one be destroyed. Open: KMS wrapping, and rotation of the chat's per-conversation keys.
- [x] orphan/starvation diagnostics: a derived report + remediation (`GET /v0/ops/diagnostics`; reclaim/dead-letter/requeue per record OR by envelope selector via `POST /v0/ops/remediate`, so draining a backlog is one call per page rather than one per record). `staleAvailable.split` now separates the two failures age alone conflates, by running the PATTERN match against the live interest registry: **orphaned** (no live interest matches, so waiting never helps) versus **starving** (a listener matches and is not claiming). The registry is read once per KIND, not per record. It refuses to answer when nothing was ever declared, since every record would then look orphaned, but it does answer when the declarations exist and their runs are gone: that is a dead fleet, not an absence of evidence. Guarded by `test/conformance/suites/starvation.ts`.

**Verify:** the same suite green against Postgres *and* embedded: **PASSED**, 213/213 via
`scripts/pg-conformance.sh` (sqlite, pglite, and a live Postgres 16). Watch resumption and 410
`cursor_expired` per [design-api.md](design-api.md) are only partly covered: `createWatch`,
`matchesEvent`, and start-cursor semantics are in the suite; the 410 + sentinel-clamp boundary is
pinned in `test/http.test.ts` and the horizon derivation per adapter in
`test/conformance/suites/gc.ts` (planted truncation; the sweep that creates one honestly is M2).

### M2: coordination protocols

- [~] request/bid/award (see [design-marketplace.md](design-marketplace.md)): **GATED, not queued.**
  Speculative ahead of a first user; gate behind a measured baseline like the scheduler, not
  build-on-spec (see [plan-validation.md](plan-validation.md)). Its TIMING half already shipped under
  another name: "durable timers" became delayed visibility (`PutRequest.availableAt`), and the
  sweeper that section describes was deliberately not built. Read design-marketplace.md before
  proposing a timer, a sweeper, or anything that fires at a deadline.
- [x] **retention GC + registry compaction** (2026-08-05, [plan-gc.md](plan-gc.md)): `Space.gc` /
  `POST /v0/ops/gc` / `radia gc`, on demand only. `retention_until` is finally consulted: writers
  declare expiry, the sweep deletes settled/reference records past it (never a held lease, never
  unclaimed claimable work, never reserved kinds or artifacts), events keep the audit at ~200
  bytes/record. Compaction deletes superseded latest-wins successors (keep-newest per `contentKey`,
  tombstones included — the resurrection guard is planted-regression-proved) and dead runs'
  interests. Motive was measured: registry successors were 52% of a live space, `llm_call` bodies
  8 MB of 10 MB.
- [x] **event-log retention** (2026-08-06, [plan-gc.md](plan-gc.md) phase 3, all three steps):
  opt-in `eventRetentionSeconds` (`radia dev --event-retention`); `Space.gcEvents` rides the gc
  verb — seal-first, anchor through the seals, attest a sealed horizon statement BEFORE deleting,
  then seal+event pairs oldest-first. `verifyIntegrity` reports honest truncation as
  `truncated`+attested and everything else as tampering (`unattested_truncation`); watch cursors
  below the horizon 410 (the `"0"` sentinel clamps, or the SDKs' recovery would loop); ops reads
  annotate. What a space wins and loses by enabling it: plan-gc.md, "The ledger".
- [x] **delayed visibility** (2026-08-21), which is what the in-scope half of "durable timers" turned out to be. `PutRequest.availableAt` seeds the envelope column retry backoff already drove, so a record simply is not a take candidate until the database clock passes it; a worker sees it on its next poll (`agentLoop`'s 1s floor) and an idle space runs nothing. THE SWEEPER THIS ENTRY ASKED FOR WAS NOT BUILT, and should not be: the claim path went lazy (`rankClaimable` + the CAS in each dialect), so nothing needs sweeping, and an amortized sweeper rides a write counter, which an idle space does not turn. Bounded by `maxPutDelaySeconds` (7 days) because retention GC never sweeps unclaimed claimable work. Out of scope and still out: a general workflow-timer / cron / signal library, which is Temporal's ground; Radia does not reimplement durable execution (see [research-positioning.md](research-positioning.md))
- [~] transactional budget reservation/settlement: **NOT A SEPARATE ITEM.** `design-auth.md`
  ("Budgets") puts observability in records and enforcement in the scheduler's reservation +
  settlement, so this inherits the M3 scheduler's gate and cannot be worked before it. The rule that
  survives either way: two readers of one budget record must not both spend it.
- [~] runtime envelope encryption + crypto-shredding: **built for artifact blobs** (`src/storage/crypto.ts`: per-blob DEK, wrapped under a space KEK from env/keyring, destroyable sidecar so deleting the key destroys the payload while the record and its digest stay verifiable). Record *bodies* stay plaintext IN THE RUNTIME, and always will: matching reads them. What closed the gap is an APP-layer convention ([plan-encryption.md](plan-encryption.md), BUILT 2026-08-16, `extensions/ts/encrypted.ts`): the chat seals the fields nothing routes on, keeps the wraps in artifacts so a conversation can be crypto-shredded, and every reader refuses a marker it cannot open. KMS wrapping + rotation are open.
- [ ] signed, externally-anchored log checkpoints. The INTERNAL half converged with event GC
  (plan-gc.md phase 3): each seal is self-contained and the retained suffix verifies from an
  anchor, so what remains open is only publishing a checkpoint outside the operator's trust domain
- [x] lineage viewer: the console's Graph tab (parents/children walk, `?direction=down`, honest
  `truncated`), the WATERFALL view (time as the axis; now the tab's default), and the Flows tab's
  mined shapes with per-exemplar timing. Listed open long after the console shipped it; the same
  drift `run-scoped credentials` had below.
- [x] run-scoped short-lived credentials: built in M1 with the bootstrap chain above. A run token
  carries `expiresAt`, renews at half-life (`keepAlive` in both SDKs) and is capped by
  `runMaxLifetimeSeconds`; `src/core/auth.ts` mints and hashes, `Space.createRun` issues. Listed as
  open here long after it shipped, which put this file in contradiction with `docs/`.
- [x] **ops-plane tiers** (2026-08-06, [architecture-ops-tiers.md](architecture-ops-tiers.md), all phases): the one
  operator bit split into grantable powers (`ops_grant` records, `observe`/`remediate`/`sweep`/
  `declassify`/`purge`, fail-closed, reported by `effectivePermissions`); the supervisor demoted to
  a `grant`/`signal` carve-out (and thereby mintable); `radia mcp` and the CLI's read-only verbs
  default to a revocable OBSERVER credential instead of the operator token.
- [x] revocation paths, and WHICH ONE STOPS WHAT, because reading them as interchangeable is the
  mistake this line used to invite (it claimed revoke "kills every run of an agent"; it does not).
  `Space.revokeDefinition` / `radia revoke <principal>` stops a definition MINTING, permanently,
  and deliberately leaves live runs alone — "stop handing out new authority" and "kill the work in
  flight" are different decisions with different blast radii, so a rotation does not take every
  worker down mid-call. It is also a no-op for an identity holding no definition, which is every
  SSO principal by design (plan-oidc.md). `Space.stopRun` retires ONE run (`quarantine: true` also
  force-releases its leases), and a grant is withdrawn by a `retired: true` successor.
  Credentials resolve from records per request, uncached, so a stop or a withdrawal takes effect on
  the next call rather than at expiry — but only for the credential it actually names.
  **Offboarding a person is therefore not one verb**: stop their own runs AND the delegated runs
  minted on their behalf, and for an SSO identity retire the `oidc_identity` mapping so nothing
  re-mints. See [plan-delegation.md](plan-delegation.md) and `radia runs`.
- [x] **fault-injection suite** (2026-08-29, [plan-validation.md](plan-validation.md)): the matrix is
  complete. The last three rows landed together, each with the injection method stated and most
  proved red on a planted regression: partition during renewal in both directions (unheard request,
  lost response), DB failover as a Proxy around one adapter method that throws before or after
  delegating (`test/conformance/suites/failover.ts`, six cases on every adapter), and cursor expiry
  under a 24-stream reconnect storm over a horizon made by the REAL sweep. What the suite does not
  cover is stated there rather than implied: it cannot fail inside a storage transaction without a
  test-only hook in production code, and a real primary kill stays a deployment test. The BASELINES
  half ran the same day (`bench/baselines.ts`, `deno task bench:baselines`): coordination costs
  ~0.65ms and two records per item against a static orchestrator's zero, and what that buys is a
  worker death costing the static arm its ANSWER while both space arms lose nothing. It does not
  beat a plain queue on any timing column, and the one column that separates them is one record: an
  unforeseen shape is consumed by a queue's dispatch and left claimable by content routing.
- [x] **push `$any` into SQL** (`pushdown.ts`, both dialects): a type-guarded `EXISTS` over the
  array's elements for a scalar element predicate, exact, so the caller's LIMIT rides with it.
  Measured over HTTP against Postgres, it is flat at 1.6–1.9ms from 25k to 1M records
  (`bench/deployment.ts`), where the unpushable path is 278ms → 13.6s over the same range.
- [x] **bound the oracle path that remains.** `$each` is deliberately NOT pushed (negating an
  element predicate soundly-but-incompletely would EXCLUDE rows, and the empty array is where it
  breaks first), so an unpushable pattern still walks a whole kind through `matchesRecord`. Two
  mechanisms now bound it, in `CompiledMatch.scanBudget` + both adapters: the walk is CHUNKED, so
  memory is bounded and the event loop gets a turn between chunks (measured on 60k records: a
  neighbour's indexed read waited 138ms, the whole scan, and now waits 5.9ms); and a per-read budget
  (`maxScanRows`, default 200k) raises `429 scan_budget_exceeded` rather than truncating. Guarded by
  `test/conformance/suites/limits.ts` + `http.test.ts`, each proved to fail on a planted regression.

**Verify:** fault-injection matrix (see [plan-validation.md](plan-validation.md)) passes;
crypto-shredding deletes a body while the event chain still verifies.

### M3: intelligent control

- [~] scheduler-enforced atomic admission (see [design-scheduler.md](design-scheduler.md)):
  **GATED on a measured baseline** ([plan-validation.md](plan-validation.md) isolates the agenda's
  contribution), and the scheduler is OPTIONAL by design. Two other rows here wait on it rather than
  on their own work: transactional budgets, and the slow-lane TIME budget listed under M1 limits.
- [~] semantic matching: **SHAPE DECIDED, timing gated** ([design-matching.md](design-matching.md),
  "Semantic matching (late)"): embeddings over declared semantic fields computed on the
  STRUCTURALLY-FILTERED set only, per-agent rerank under a cost budget, shadow mode before
  enforcement. It is not a substitute for deterministic prefix/token/filename matching, which is a
  separate deferred item on the same page.
- [~] delegation contexts end-to-end. **Built (M1):** `delegation_context` is server-derived from the lease on ack-emitted work (authority chain accumulates per hop; never data parents); ack authorizes the acting agent's `put`. Since 2026-08-12 a worker can also ACT for its caller: `POST /v0/agent-runs/delegated` mints a run whose authority is `grants(worker) INTERSECT grants(caller)`, resolved through the run behind `created_by` rather than any body field, with the authority a worker may use only on somebody's behalf held under a `delegable:<agent>` principal nothing can authenticate as ([plan-delegation.md](plan-delegation.md)). Remaining for M3: the stricter chain-intersection policy composed with taint, which this deliberately does NOT anticipate — it intersects two principals at mint, and says nothing about a chain of five.
- [~] taint + declassification. **Built (M1):** taint is a closed set of BARRIER labels (`file`/`net`/`foreign`, `TAINT_LABELS`) that UNION along data parents (put + ack); clients may raise but never clear one; `take {allowTaint}` and a grant's `scope.taint` are claim-time ALLOWLISTS; a privileged `declassify` clears named labels and emits a successor carrying the remainder. It began as one boolean, which saturated after the first tool call and therefore barred nothing; see [design-taint.md](design-taint.md). Remaining for M3: per-principal trust classification and taint-composed access checks.
- [~] repeated-shape livelock detection: **the same implementation as flow mining, and the READ half
  is built** (2026-08-04: `Space.flows`, `GET /v0/ops/flows`, `radia flows`, the console's Flows
  tab). One primitive, a signature over ancestry, read two ways: repetition WITHOUT progress is
  rumination and gets interrupted, repetition WITH progress is skill and gets kept
  ([research-self-modeling.md](research-self-modeling.md), which says these must stop being two
  items). What remains is the no-progress predicate and the `flow` RECORD, without which there is no
  provenance for the measurement and no drift over time.
- [ ] re-execution tooling
- [ ] learned scoring after static scoring is measurable

**Verify:** scheduler baselines in [plan-validation.md](plan-validation.md) isolate the
agenda's contribution; semantic matching runs in shadow mode before enforcement.

## Decided

- **The M0 Deno + TypeScript kernel stays through M1. Revisit only on evidence** (2026-08-04,
  closing an open question that had been hedging every other decision). Nothing measured argues for
  a rewrite: a `put`+`take`+`ack` round trip is ~30ms against a model round of 1–10s, and every
  speedup this project has had was algorithmic or SQL (claim-order index 19.5→0.8ms, Postgres
  expression statistics 9.75→3.37ms p50, TCP_NODELAY 42→0.18ms per query), none of which a new
  language would inherit. Pausing to rewrite also delays the first user, which is what the M2/M3
  gates wait for.

  **The option does not expire, and stays cheap.** A rewrite touches `src/core`, `src/server` and
  `src/storage` only: the CLI and MCP adapter reach the space through the SDK exactly as an external
  client does (`test/layering.test.ts` holds that line), so the surfaces, SDKs, extensions and
  examples are clients of a frozen protocol either way. The conformance suite is the replacement's
  executable specification, and it gets more valuable the longer this runs, not less.

  **What would reopen it**, in descending order of likelihood: a requirement for PUSH-based
  cross-instance wakeup, since deno-postgres exposes no asynchronous notification API and the
  250ms poll in `src/core/notifier.ts` is the one place the runtime choice shows up in the DESIGN
  rather than in a workaround; a measurement showing the runtime rather than the model is a real
  bottleneck; or an upstream break in `node:sqlite`, which ships unstable. Preference is not
  evidence — reopen this with a number or a requirement, not with an opinion about TypeScript.
