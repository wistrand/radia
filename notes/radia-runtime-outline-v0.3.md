# Radia: A Content-Routed Coordination Runtime for LLM Agents
### Functional design outline — v0.3
*(v0.2 → v0.3 incorporates second external review: execution-overlap wording, timing-field separation, idempotency ordering, corrected storage layout, authority/lineage separation, atomic admission, immutable awards, repeated-pattern livelock detection, revocation, resource limits.)*

**Name:** *Radia*, honoring Radia Perlman, whose Spanning Tree Protocol showed independent nodes building a shared structure with no central controller — and who announced it as a poem ("Algorhyme"). In the tradition of Linda, the name is a lineage homage. Naming actions: npm `radia` claimed (verified free at decision time); PyPI bare name is occupied by an unrelated physics package, so the PyPI distribution is `radia-space` (import name `radia`); trademark screen before public launch; courtesy note to Perlman before any public use of the homage.

## 1. Positioning

**Thesis:** a durable, policy-aware, content-routed work and knowledge exchange for independently implemented agents, with optional cost-aware admission control. A coordination substrate, not an agent framework: model calls and agent logic stay outside the runtime.

**Evidence, stated carefully:** recent experiments suggest blackboard-style coordination can improve success or token efficiency on selected multi-agent reasoning and data-discovery workloads (Salemi et al. 2025: 13–57% relative improvement on three data-discovery benchmarks; Han & Zhang 2025: competitive performance at lower token cost on selected evals). Encouraging, workload-specific — not proof of general superiority.

**Prior art:** JavaSpaces (template matching, read/take, leases, notifications, transactions), GigaSpaces, LangGraph (durable execution, shared state). The defensible gap: **no prominent LLM-native runtime combines JSON content matching, competitive leased claims, agent-scoped authorization, lineage, cost-aware activation, and MCP integration behind a language-neutral protocol.** Our distinction from graph orchestrators is topology-free, content-based coordination — not durability.

## 2. Data model

### 2.1 Record (immutable content) vs. runtime envelope (mutable claim state)

```
record                       # immutable after commit
  id             ULID
  kind           discriminator; never rewritten
  body           JSON (large payloads via artifacts, §2.4)
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
  effective_priority   server-computed (§6); aged by sweeper
  lease_id, lease_epoch, lease_owner (run id), leased_until
```

**Timing fields are distinct concepts, never overloaded:** `available_at` (eligibility), `claim_until` (claim window), `deadline_at` (business deadline), `retention_until` (GC), `leased_until` (current lease). Retention expiry does **not** invalidate an in-flight valid lease — administrative GC never discards valid completed work.

**Client-submitted vs. runtime-authoritative metadata is a hard API split.** Server-controlled, always: `created_by`, `delegation_context`, `created_at`, `schema_version` (post-validation), `taint`, `effective_priority`, all lease fields. Clients submit *claims* (`confidence`, `requested_priority`); the runtime decides what they're worth.

**Provenance ≠ authority (two structures):**
- `parent_ids` — data/causality lineage only. All parents must exist at commit; self-parenting rejected; the DAG is enforced, and — because parents must pre-exist and records are immutable — is acyclic *by construction*.
- `delegation_context` — the authorization chain for this operation, **server-derived from the claimed task/lease**, never freely client-supplied. A result may have many data parents but exactly one authorization context. Deriving data from a privileged record grants nothing; intersecting authority across arbitrary parents is neither meaningful nor attempted.

Other rules: content "updates" = consume + emit successor; dead-lettering sets `state = dead_letter`, preserves `kind`; all time comparisons use the **database clock**.

### 2.2 Kind conventions
`task` · `fact`/`hypothesis` · `request`/`bid`/`award` (§7) · `result` · `signal` (privileged writers only).

### 2.3 Resource limits (hard, enforced at commit/registration)
Maximum record and template size · field depth · predicate count · `$or` branches · array cardinality · registered templates per agent · watches per run · slow-lane time and row-scan budgets · SSE buffer/backpressure limits. An indexed query can still be expensive; limits are not optional.

### 2.4 Artifact references
Large payloads live in blob storage. Records carry **stable internal artifact IDs** — never temporary signed URLs (they expire inside immutable records). Retrieval is authorized through the runtime, which issues short-lived download capabilities. Artifact policy: sha256 verification, MIME/size validation, encryption, reference-aware GC, taint propagation, access checks independent of possession of the record JSON.

## 3. Matching and query language

### 3.1 Syntax Mongo-inspired; semantics our own
Divergences (explicit, conformance-suite-backed): missing ≠ null (absent field never matches except `$exists: false`) · no type coercion (cross-type comparison is false) · explicit array quantifiers `$any`/`$each` (scalar predicates never silently distribute) · `$not` field-level only, depth 1 · dotted paths only; literal dots in keys rejected at schema registration. "Mongo-compatible" is never claimed.

**Whitelist (early):** `$eq` (implicit), `$gt/$gte/$lt/$lte`, `$in`, `$exists`, `$any`/`$each`, `$and`/`$or` (depth ≤ 3). **Deferred:** `$ne`/`$nin`/`$not` (poor selectivity; slow lane if ever), `$prefix` and full-text (indexable, later — semantic matching is not a substitute for deterministic prefix/token/filename matching). **Never:** `$regex`, `$where`, `$expr` — templates are data, not code.

### 3.2 Per-kind indexing contract
Each kind declares `indexed_paths` (typed: keyword/integer/timestamp/array) and `sortable_paths`. Registration rejects predicates on undeclared paths (or routes to the rate-limited slow lane) and `order_by` on non-sortable paths. Hot declared paths become generated columns / expression indexes on `record_runtime`.

**Two matching directions:** template→records is an indexed query; new-record→templates (wakeups, scheduler candidates) is subscription matching needing an inverted index of template atoms — early milestones ship bounded wakeup-by-kind only.

### 3.3 Semantic matching (late)
Embeddings over declared semantic fields, on the structurally-filtered set only; per-agent LLM rerank with cost budget; shadow mode before enforcement.

### 3.4 Template properties
Templates are data: storable, analyzable, schema-validated at registration (typo'd path = registration error). Orphan records and starving templates are first-class diagnostics. Deterministic tie-breaking: `order_by`, then record ID.

## 4. Delivery semantics and core API

### 4.1 The guarantee, precisely

> **At-least-once execution with at most one valid lease at a time. Physical execution may overlap after lease expiry, because a fenced worker may continue running until it observes `lease_lost`.**

Atomic consume-and-emit protects space state, not external side effects: an agent can send the email and crash before `ack`. Side-effecting agents require idempotency at the effect boundary, an outbox, or a transactional tool gateway (candidate second product surface).

### 4.2 Leases with fencing

`take` returns `{record, lease: {lease_id, epoch, owner_run, expires_at}}`.

- `renew`/`ack`/`nack`/`release` present `lease_id + epoch`; mismatch → distinct **`lease_lost`** status.
- Expiry → `available`, `attempt += 1`, backoff via `available_at`. Attempt semantics per path: `nack` +1 (agent backoff), expiry +1 (policy backoff), `release` +0 (cooperative cancel — an explicit operation, not a client-chosen nack flavor; server policy may override the +0).
- Max cumulative lease duration per (record, run): a wedged-but-alive process cannot renew forever.
- **Late results:** `ack` either succeeds transactionally or fails without emitting its result. A fenced worker wishing to preserve late output uses an explicit diagnostic operation/record type — never a side-channel commit inside a failed ack.
- After `max_attempts` → `dead_letter`.

### 4.3 Idempotency (ordering is load-bearing)

For every state-changing operation:

```
lookup (principal, operation, idempotency_key)
  found + same request hash   -> return stored response      # BEFORE lease validation
  found + different hash      -> idempotency_conflict
  absent                      -> validate lease/eligibility, execute, store response
```

Rationale: ack commits, HTTP response is lost, agent retries — the task is now consumed and the lease invalid; validating the lease first would falsely return `lease_lost` for a succeeded operation. Stored responses include generated result IDs; concurrent same-key requests serialize. All state-changing operations accept idempotency keys; stale `nack` retries may be terminal.

### 4.4 API surface (ten operations)

```
put(record, idempotency_key) -> id
read_one(template) -> record | null
query(template, cursor, limit) -> page          # keyset cursor, see below
take(template | record_id, lease_s, block, timeout) -> {record, lease} | null
ack(lease, result_record?, idempotency_key) -> ok | lease_lost | idempotency_conflict
nack(lease, reason, backoff_s) -> ok | lease_lost
release(lease, reason) -> ok | lease_lost       # cooperative cancel, attempt +0
renew(lease) -> lease' | lease_lost
watch(template) -> watch_id / event stream
control-plane ops (kinds, templates, definitions, runs — §8)
```

- **`take(record_id=...)` is only an efficient selector, never a bypass.** The server re-verifies: a registered template of this run matches the record; grants permit the take; scheduler admission exists (in scheduler mode); the record is `available` and within `claim_until`.
- **Pagination is keyset, not snapshot:** stable with respect to the selected *immutable* sort keys (`created_at`, record ID); runtime eligibility is evaluated per page fetch. (`effective_priority` is mutable under aging and therefore not a cursor key — aging influences scheduler admission, not cursor order. "Snapshot cursor" is reserved for a real snapshot implementation, deferred.)
- Long-poll cancellation: client disconnect releases nothing; only leases hold state. Reactive mode retains priority aging so low-priority work cannot starve.

### 4.5 Wire protocol
HTTP + JSON, OpenAPI-first; long-poll for blocking ops; watch = `POST /watches` → `GET /watches/{id}/events` (SSE, event cursor, resumption). **Cursor older than retained events → 410 `cursor_expired`: client performs catch-up query and opens a new watch.** Watches are **ephemeral run resources** (die with the run); durable subscriptions deferred. Templates never in query strings. Errors: RFC 9457; `lease_lost` and lost-race are distinct non-error statuses. LISTEN/NOTIFY = wakeup only; event log = truth. Layering: Postgres → runtime (sole DB client) → protocol → {SDKs, MCP adapter, CLI}; CLI uses only the public API. SDKs hand-write the heartbeat (renew at lease/3; stop when work dies) and the loop harness; Python + TS polished, others generated. MCP adapter holds credentials outside the model context and heartbeats internally.

## 5. Agent loop (client contract)

```python
async def agent_loop(space, run):
    async for hint in space.watch(run.templates):
        claimed = await space.take(record_id=hint.record_id, lease_s=run.lease_s)
        if claimed is None:
            continue                                   # lost race / not admitted: normal
        hb = start_lease_renewal(space, claimed.lease)
        try:
            result = await run_llm_step(claimed.record)
            status = await space.ack(claimed.lease, result_record=result,
                                     idempotency_key=key_for(claimed))
            if status == "lease_lost":
                log_fenced(claimed)                    # duplicate work possible: at-least-once
        except CancelRequested:
            await space.release(claimed.lease, reason="preempted")
        except RetryableError as e:
            await space.nack(claimed.lease, reason=str(e), backoff_s=backoff(claimed.record))
        finally:
            hb.cancel()
```

## 6. Scheduler (enforced, atomic)

Enforcement: in scheduler mode `take` consults the agenda — a record is returned only for an admitted (record, agent) activation; watches filter to admitted agents; scheduler-off degenerates to reactive semantics.

**Admission → claim is one atomic transition.** A successful scheduled `take` transactionally: (1) validates the activation exists, is admitted, unexpired; (2) confirms the record is `available`; (3) **reserves estimated budget**; (4) increments run/agent concurrency; (5) creates the fenced lease; (6) consumes/invalidates competing activations. `ack` settles estimated vs. actual cost; `nack`/`release`/expiry adjust or release reservations; activation expiry re-opens admission to other candidates. Without atomicity, stale admissions act and two agents spend the same budget.

**Agent-supplied values are claims, not inputs.** `confidence`, `est_value`, `est_token_cost`, `requested_priority` are gameable; the scheduler computes **`effective_priority`** server-side from: per-principal priority caps, historical calibration of each agent's claims, runtime-derived cost estimates, and fairness/quota terms. Otherwise one agent monopolizes the agenda by declaring maximum value.

No eager (records × agents) materialization: candidates computed incrementally on record/budget/manifest change; capped candidates per record; activations invalidated on change. Scoring pluggable; learned scoring only after static scoring is measurable.

## 7. Capability marketplace (request/bid/award)

Honest claims: there is an agent registry, and the assigned task is directed to the winner. The advantage is no *preconfigured routing table*.

1. `put` request → interested agents `put` bids (linked via `parent_ids`) within the window.
2. Selection transaction: non-destructively read eligible bids → consume/close the request → **emit an immutable `award` record** (`parent_ids: [request, winning_bid]`, body: winner + assigned task id) → emit the assigned task → **all bids preserved unchanged** (a bid's *envelope* may become consumed; its content is never mutated).
3. Zero bids at deadline → escalate.

**Durable timers:** windows/deadlines are `available_at`/`deadline_at`-indexed rows driven by a sweeper; time-based predicates alone trigger nothing.

## 8. Identity, authorization, safety

### 8.1 Principals
`human:*` (OIDC) · `agent:*` (definition: grants, budgets, templates) · `run:*` (instance). Leases belong to runs.

### 8.2 Bootstrap — grants assigned, never self-declared
`POST /agent-definitions` (privileged control plane assigns grants) · `POST /agent-runs` (definition credential → short-lived run token) · `POST /agent-runs/{id}/stop`. Manifest capability claims are descriptive, not authorization. On k8s prefer workload identity (SPIFFE / projected SA tokens). MCP adapter keeps credentials out of the model context.

### 8.3 Grants
Kind-scoped verbs, never wildcard. Template-scoped grants: effective query = grant ∧ requested template, **computed server-side**. `signal` + grant management writable only by `human:*` and one supervisor agent.

### 8.4 Delegation
`delegation_context` (§2.1) is server-derived from the claimed lease; effective permission on delegated work = intersection of the *authorization chain's* grants — data parents contribute nothing. Composes with taint: taint = untrusted data lineage; delegation = authority lineage; sensitive consumers may constrain both.

### 8.5 Taint — server-computed
Derived from principal trust classification, mandatory parent linkage at ack, server-side propagation. Direct `put` from applicable principals defaults tainted absent source attestation. Clearing requires privileged **declassify**; ordinary agents cannot write `taint: false`.

### 8.6 Revocation semantics (defined, not implied)
- **Run stopped:** no new operations or renewals; held leases expire on their own clocks (quickly, given renewal stops).
- **Grant revoked:** no new claims; in-flight `ack` allowed under the **policy version captured at lease issuance** (default), unless…
- **Emergency quarantine:** deny all writes from the principal and invalidate its leases immediately; late `ack`s fence out as `lease_lost`.
- **Token expiry mid-task:** run refreshes via its definition credential; refresh failure degrades to "run stopped."

### 8.7 Budgets
Observability via records; enforcement via transactional reservation + settlement (§6). Two readers of the same budget record must not both spend it.

### 8.8 Deferred
Boundary signing and agent-held keys (federation-time; rationale in §9.1) · recipient-keyed encryption as a runtime feature (§9.2) · field-level ACLs · multi-tenancy (one space per team).

## 9. Observability, audit, re-execution

- **Event log:** append-only, same transaction as each mutation, run identity on every event. Incident scope = one lineage query. Retention vs. deletion duties: crypto-shredding or payload tombstoning (envelope + hashes retained, body destroyed) planned from day one.
- **Diagnostics:** orphan records, starving templates, wakeup amplification, duplicate-execution rate.
- **Livelock detection — repeated patterns, not cycles.** The lineage DAG is acyclic by construction (§2.1); ping-pong livelock is a *repeating signature along a chain*. Detect: repeated (agent, template/kind) signatures along ancestry · max hop count · max repeated-activation count · no-progress detection via content hashes or an application-defined progress score (e.g., signature pair repeated ≥3× with no progress delta → quarantine + surface).
- **Re-execution, not replay.** Capture: agent/prompt versions, model+provider+params, tool I/O, retrieval results, schema and policy versions, artifact hashes, scheduler decisions, logical time. External effects suppressed/mocked/routed through replay-aware adapters.
- **Schema/template lifecycle:** templates pin validated schema versions; migration re-validates or quarantines (fault-injection case: migration with live templates).

### 9.1 Integrity architecture (why records are NOT individually signed)

Per-agent record signatures are rejected for the single-space case: the runtime authenticates every `put` via run tokens and is the sole DB writer, so origin is already established authoritatively; an agent's signing key would live exactly where its bearer token lives, so run compromise compromises the signing oracle; signatures authenticate origin, not trustworthiness (a prompt-injected agent signs its poisoned output); server-assigned `runtime_meta` cannot be agent-signed, so only fragments would be covered; and the costs (per-agent PKI, rotation/revocation, JSON canonicalization — a classic vuln class) buy nothing against the actual threats.

Three-tier posture instead:

1. **Content hashes everywhere (M0):** `body_sha256` on every record — over *plaintext* — already needed for artifacts, dedup, and no-progress detection; nearly free.
2. **Tamper-evident event log (M1–M2):** each event embeds its predecessor's hash; the runtime signs periodic checkpoints; checkpoints are anchored externally (secondary store, transparency log, or a git repo). "History cannot be silently rewritten" for the entire space — records, envelopes, grants, scheduler decisions — at O(1) per event. The chain covers *content hashes*, not content, so crypto-shredding (§9) deletes a body while the chain stays verifiable.
3. **Signatures at trust boundaries only (federation-time):** export bundles and cross-space transfers are runtime-signed together with the checkpoint proving chain position. Agent-held keys (via workload identity, no static key at rest) only when agents run outside the operator's trust domain or non-repudiation is a regulatory requirement.

### 9.2 Confidentiality architecture (three layers, three owners)

1. **Infrastructure encryption** (disk/TDE, TLS, object-store SSE): deployment prerequisite, stated as such; not a runtime feature.
2. **Runtime-managed envelope encryption — required, not optional.** The crypto-shredding commitment (§9) *is* application-layer encryption: deletion-by-key-destruction requires that bodies and artifact blobs were encrypted under destroyable data keys (per kind / tenant / data-subject grouping, KMS-wrapped). This also covers the realistic leak vectors — backups, snapshots, misconfigured replicas — that disk encryption does not. Runtime decrypts on read, so matching is unaffected. `body_sha256` and the event chain hash the plaintext: verifiability survives shredding because a retained hash is irreversible.
3. **Client-held-key E2E encryption — client responsibility, supported but never managed.** Content-routing is the product: matching, taint, schema validation, no-progress hashing, and the inspector all require the runtime to read content, and any consuming agent must decrypt into a prompt anyway (plaintext transits every consumer and its model provider — E2E-from-the-runtime while exposed-to-the-LLM-provider is rarely a coherent threat model). Convention for clients who need it regardless: **hybrid records** — plaintext routing envelope (`kind`, verb, priority, deadline, declared indexed paths) + opaque payload (`body.ciphertext` + `body.enc_meta`); artifacts may carry client-side-encrypted blobs (already opaque bytes to the runtime). Stated plainly in the spec: **encrypted content is coordination-invisible by construction** — unmatchable, untaint-trackable, invisible to diagnostics. Recipient-keyed encryption as a runtime feature has the same trigger as boundary signing: federation.

## 10. Postgres mapping (corrected layout)

| Concept | Implementation |
|---|---|
| Storage | `records` (immutable) + `record_runtime` (mutable envelope) with **`kind`, `deadline_at`, and hot routing fields denormalized into `record_runtime`**, assigned transactionally at commit, never client-editable |
| Claim index | `CREATE INDEX ON record_runtime (kind, available_at, effective_priority DESC, record_id) WHERE state = 'available'` — single-table partial index; no cross-table index exists, so takes never require an index-assisted join on the hot path |
| take | conditional `UPDATE record_runtime ... FOR UPDATE SKIP LOCKED RETURNING`, epoch bump |
| Fencing | `lease_id`/`lease_epoch` conditional updates |
| Idempotency | (principal, op, key) → request hash + stored response (incl. generated IDs); checked **before** lease validation |
| watch | LISTEN/NOTIFY wakeups + cursor catch-up; event retention window + 410 on expired cursors |
| Timers | `available_at`/`deadline_at` indexes + sweeper (backoff, bid windows, lease resurrection, priority aging) |
| Event log | append-only table, same transaction |
| Clock | DB `now()` for all lease/timing math |
| Blobs | object store + artifact table (sha256, size, internal URI); runtime-issued download capabilities |

### 10.1 Deployment modes and distribution

**Adoption constraint (strategy, not packaging):** a coordination substrate delivers value only after multiple agents join, so friction before the first local two-agent demo kills the funnel. The bar: **`npx radia dev` → running space + web inspector in under a minute; an agent joins from a second terminal.** (Precedents: SQLite/DuckDB/Vite won partly on zero-setup; Temporal loses prototype users at the docker-compose wall.)

**Why this is architecturally cheap here:** the runtime is the sole DB client (§4.5), so all concurrency guarantees — atomic take, fencing, idempotency serialization — live in the runtime process. `SKIP LOCKED` is the *Postgres implementation* of the take contract, not the contract. An embedded mode backs the same semantics with SQLite (WAL) or PGlite, serializing takes in-process. Leases, fencing, the event log, durable timers, and dead-lettering all remain meaningful locally: local agent processes still crash.

**Three modes, one contract:**

| Mode | Invocation | Storage | Auth | Integrity |
|---|---|---|---|---|
| `dev` | `npx radia dev` (also `pipx run`) | embedded (SQLite/PGlite), single process | auto-provisioned local credentials — **same API shape, never "no tokens"** | event log, hash chain optional |
| `single-node` | binary + config | Postgres | admin-provisioned definitions | hash-chained log |
| `production` | HA deployment | HA Postgres | full control plane, workload identity, KMS | anchored signed checkpoints, envelope encryption |

**Invariant: embedded mode is never a semantically weaker cousin.** The entire conformance + fault-injection suite runs against every storage adapter in CI from day one — that is the standing price of two backends.

**Distribution ≠ implementation language:** ship one native (or single-runtime) server binary wrapped for both `npm` and `pip` (the esbuild/uv pattern) — agent developers split across both ecosystems. Acceptable M0 shortcut: a TypeScript server on PGlite reaches the demo fastest and can be rewritten behind the stable OpenAPI protocol later; the wire contract is what's frozen, not the implementation.

**The `dev` command bundles the MCP adapter and inspector:** sharpest onboarding path is `npx radia dev`, one line in an MCP-capable harness config (e.g. Claude Code), and a real agent is participating before any SDK code is written.

## 11. Milestones

**M0 — semantic kernel *prototype*, embedded-first** *(2–3 careful weeks for a focused prototype: embedded storage, limited predicates, auto-provisioned local auth, minimal hardening, basic fault testing — explicitly not production-readiness)*: **`npx radia dev`** — embedded storage (SQLite/PGlite), single process, bundled MCP adapter + minimal web inspector · put/take/ack/nack/release/renew · record + envelope split with denormalized routing columns · `body_sha256` on every record · fencing epochs · at-least-once semantics documented · idempotency with stored responses, correct ordering · equality/range matching on declared indexed paths · transactional event log · dead-letter state · conformance suite as a storage-adapter contract from the first commit · Python + TS SDK stubs · minimal CLI.

**M1 — usable runtime:** **Postgres storage adapter (same conformance + fault suite as embedded)** · single-node deployment mode with admin-provisioned auth · read_one + keyset query · long-polls · schema version registry · kind- and template-scoped grants · resource limits enforced · hash-chained event log · polished Python + TS SDKs · watches (SSE, cursors, 410 semantics) · artifact service · orphan/starvation diagnostics.

**M2 — coordination protocols:** request/bid/award · durable timers · transactional budget reservation/settlement · runtime envelope encryption + crypto-shredding · signed, externally-anchored log checkpoints · lineage viewer · run-scoped short-lived credentials · revocation paths · fault-injection suite.

**M3 — intelligent control:** scheduler-enforced atomic admission · semantic matching · delegation contexts end-to-end · taint + declassification · repeated-pattern livelock detection · re-execution tooling · learned scoring after static scoring is measurable.

## 12. Validation plan

Three baselines: static graph orchestration · plain worker queue · blackboard without the agenda scheduler (isolates the scheduler's contribution).

Metrics: task success · tokens/cost · latency · invocation count · duplicate-execution rate · lease-recovery latency · wakeup amplification · orphan rate · admission accuracy · p50/p95/p99 take latency · throughput scaling in records × templates × agents.

Fault injection: crash before external effect · after effect, before ack · after commit, before HTTP response · duplicate ack · stale ack after reassignment · partition during renewal · DB failover · conflicting idempotency payloads · schema migration with live templates · revocation mid-lease · cursor expiry under reconnect storm.

## 13. Risk register

Semantic-matching drift (shadow first) · livelock (repeated-signature + no-progress detection) · hot-record contention (admission top-K) · schema anarchy (per-kind schemas) · agenda gaming (server-computed effective_priority, calibration) · **storage-adapter drift** (embedded vs. Postgres semantics diverging — conformance suite on every adapter in CI is the only guard) · **naming** (Radia adopted; remaining actions: PyPI as radia-space, trademark screen, courtesy note to Perlman, watch Radia Inc. aerospace for category drift) · **side-effect duplication** (at-least-once is the contract; the transactional tool gateway is the mitigation and possibly the second product).
