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

- **`childrenOf` (the relationship-graph reverse lookup) is a `LIKE` scan** over the
  `parent_ids` JSON text, not an indexed reverse edge. Fine for the dev console at small
  scale; a real reverse index (or an edges table) is the fix before it's a hot path. It
  works because ids are ULIDs (no `%`/`_`), so `like '%"<id>"%'` is safe.
- **SSE watch streams detect client disconnect via the response stream's `cancel()`, not
  `req.signal`.** Under `Deno.serve`'s legacy semantics, `request.signal` aborts on a *fully
  delivered response*, not only on client disconnect — using it to gate a long-lived SSE loop
  risks a false teardown, and merely reading it emits a deprecation warning
  (`--unstable-no-legacy-abort`). `handleWatchEvents` instead sets a `closed` flag in the
  `ReadableStream`'s `cancel()` callback (Deno invokes it when the client goes away) and races
  the keepalive wait against a wake promise so disconnect cleanup is prompt. Don't reintroduce
  `req.signal` here.

- **The graph/lineage viewer excludes nothing by default except what the caller asks**
  (`?exclude=llm_chunk`): streaming `llm_chunk` records would otherwise dominate a
  conversation graph. Keep chunk flushing coarse for the same reason (event-log volume).

- **Kinds are records (`kind_def`), and the `kind_def` meta-kind is the one bootstrap in
  code.** A kind declaration is a `kind_def` record; the registry is a cache rebuilt by
  querying them (`Space.loadKinds`). This has a chicken-and-egg: to `query {kind:kind_def}`
  the kind `kind_def` must be registered. Broken by registering `META_KIND_DEF` in the Space
  constructor (in code, never a record). Consequences to preserve: `Space.put` special-cases
  `kind_def` (validate the body as a `KindDef`, register it after commit — on idempotent
  replay too); re-declaring `kind_def` itself is rejected; a re-declaration of any other kind
  is a **successor** record (immutability), so `loadKinds`/`listKinds` take the latest per kind
  name (by ULID id). Re-registering an identical def is idempotent (deterministic key from
  `kindDefKey`), so restarts don't grow records. Don't reintroduce a `kinds` table or a
  `/v0/kinds` endpoint — that's the side-table-beside-the-substrate this replaced.

- **Authorization is enforced at the HTTP boundary, not inside `Space` methods.** `Space.put`/
  `take`/`query` stay principal-agnostic (they use the space's own context); the handlers resolve
  the caller and call `Space.authorize` before dispatching. Consequence: **in-process callers
  (conformance, examples, `demo.ts`) bypass enforcement** — they exercise the mechanism by
  calling `authorize` directly (see `conformance/suites/auth.ts`), and `created_by` still comes
  from `SpaceContext`, not the resolved caller (per-request `created_by` threading is a deferred
  follow-up; tests pin `created_by === "local:dev"`). Don't "fix" this by moving grant checks
  into `Space` methods without also threading the principal through every call site.
- **Default principal is the operator, so dev stays open; enforcement only bites a real token.**
  An unauthenticated request resolves to `human:local` (privileged) — the UI, demo, and examples
  work with no auth. To act as a scoped principal you must mint a real run token via the bootstrap
  chain; there is **no impersonation shortcut** (the old dev-only `X-Radia-Principal` assume-header
  was removed — a client must never choose its own identity, so a single Bearer channel is the
  whole story).
- **The dev console holds an operator token; it's a server-lifetime in-memory bootstrap credential,
  not a record.** `Space.mintOperatorToken` (startup) registers a hash in `CredentialStore` that
  resolves to the privileged `human:local`, never expires, and is NOT persisted or cleared on
  `loadCredentials` rebuild (like the in-code meta-kinds). The server bakes the plaintext into the
  served `index.html` (replacing `__RADIA_OPERATOR_TOKEN__`); the console's guard falls back to the
  no-header default if the placeholder is left intact (page opened as a static file). This is
  additive — the no-header operator default still exists for curl/examples/tests; the console just
  demonstrates the real Bearer path. Baking a token into served HTML is safe only because the dev
  API is already open on the local network; a production console would authenticate an operator
  session and the no-header default would be closed.
- **A presented `Authorization: Bearer` token must resolve; a bad one is 401, never a silent
  fall-through to the operator.** Only the *absence* of any credential defaults to `human:local`;
  `resolveAuth` in `src/server/http.ts` encodes it (Bearer → run principal, else operator).
  `POST /v0/agent-runs` is special — it reads its DEFINITION token directly (a def
  token is not a coordination principal, so `resolveAuth` returns `invalid_token` for it), which
  is why that route is dispatched **before** the bad-bearer 401 check.
- **Only token HASHES are stored; the credential index is a cache over records.** Run/definition
  tokens are secrets returned once at mint; the `agent_definition`/`agent_run` record bodies hold
  the sha256 hash (not a secret), and `CredentialStore` is an in-memory index rebuilt by
  `Space.loadCredentials` at startup — the same cache-over-records pattern as kinds. A run's
  status change (stop) is a **successor** `agent_run` record (records are immutable), so rebuild
  takes records in id order and a later stop overrides the earlier mint. Token expiry uses the
  **DB clock** (fetched only when a token is actually presented, so the no-auth path stays free).
- **Graceful stop ≠ quarantine.** A lease is owned by the claiming principal (`take` threads it
  into `lease_owner`; a run token → `run:*`). `stopRun` (default) only stops the token resolving —
  the run's in-flight leases expire on their own clocks, NOT immediately. `stopRun({quarantine:true})`
  is the emergency path: `quarantineLeasesOf` force-releases them now with an **epoch bump**, so a
  late `ack`/`renew` fences out as `lease_lost` (that bump is load-bearing — without it the stale
  holder could still settle). Don't assume a plain stop kills live leases.
- **`delegation_context` is derived from the LEASE, never `parent_ids`; and only for managed-run
  work.** On `ack`, the authority chain comes from the leased record's authoritative `lease_owner`
  (from the envelope, not the client-presented lease) → its agent → extending the leased record's
  chain. Data parents contribute no authority (the core invariant). It is set only when the lease
  owner is **non-privileged** (a managed run) — so operator/root work carries none. This is why
  `isPrivileged` also covers the space's own `ctx.runId`/`ctx.principal`: in-process callers
  (conformance, demo, examples) claim under `run:local`, which must count as operator so their
  ack-emitted results stay root (no delegation, no put-enforcement) and existing tests don't break.
- **Strict chain-intersection was rejected as the ack gate — it breaks pipelines.** "Effective
  permission = intersection of the whole chain's grants" (design-auth) sounds right but, enforced
  on every `ack`, it blocks the fan-out/aggregator pattern: in `a → b`, agent `b` legitimately
  produces a kind `a` cannot, and intersection would forbid it. M1 instead authorizes the **acting
  agent's own** `put` grant for the emitted kind (`Space.ack` → `authorize(owner, "put", kind)`) —
  pipeline-friendly, and it closes the real hole (ack-emitted records previously bypassed put
  auth). A forbidden ack throws before consuming, so the record stays leased. Full intersection is
  deferred to compose with taint (M3); don't reinstate it as a hard default.
- **Taint follows DATA parents; delegation follows the LEASE — never cross them.** `Space.computeTaint`
  ORs `taint:true` (client raise) with any `parent_ids` parent's taint, on both put and ack (the
  leased record is a data parent, so taint rides through `ack`). `delegation_context` derives from
  the lease, never `parent_ids`. Two separate lineages by design — don't compute one from the other.
- **`taint` is the one authoritative field a client may RAISE (never lower).** `put`'s `taint:true`
  is honored (source attestation — "my output is untrusted"); `taint:false` from a client is
  ignored (propagation/declassify decide). This is a deliberate, narrow exception to "clients submit
  only claims" — the handler maps `taint === true` only. Clearing taint is a **privileged
  declassify** (`Space.declassify`), which, because records are immutable, emits a **clean successor**
  (same body, `taint:false`, tainted original as its data parent) rather than mutating anything.
  Don't add a way for an ordinary agent to write `taint:false`.
- **`take {requireUntainted}` filters candidates in core, not SQL.** The barrier lives in
  `rankClaimable` (skips `record.runtimeMeta.taint`), threaded via `LeaseSpec.requireUntainted` — so
  both adapters get it for free and it stays backend-neutral. It's a claim-time skip, not a query
  predicate (taint is runtime metadata, not body — the content-routing DSL can't see it, same as the
  envelope).
- **Template-scoped grants restrict reads/claims, not writes.** A grant's `template` is AND-ed
  into `query`/`read_one`/`take` (`grant ∧ request` via `combineMatch`); `put` **ignores** it, so
  a template-scoped grant still authorizes putting any record of that kind (write-side scoping is
  deferred). Also: the constraint nests as `$and[request, $or[templates]]`, so a grant template
  must be a flat equality map — a `$or`/`$and` inside one can exceed the depth-3 compile limit.
  And a template's paths are validated (indexed-path check) only when a query using it compiles,
  not at grant creation (the kind may not be registered yet) — a bad path surfaces as a 400 later.

- **Stale-available diagnostics count only `claimable` kinds; reference records are not "stuck".**
  A record sitting `available` isn't necessarily starved work — reference kinds (`claimable:false`:
  facts, config, `grant`/`kind_def`/`agent_*`, conversation history) are written once and read by
  `query`, never `take`n, so they sit available forever by design. `Space.diagnostics` excludes
  them (`excludeKinds`, filtered in the adapter query *before* the 500 sample cap, so a real starved
  `task` is never crowded out by hundreds of `message`/`capability` records). Reserved control kinds
  default `claimable:false`; user reference kinds must declare it. Don't "fix" a large
  stale-available count by raising the threshold — check the kinds are marked reference.
- **`KindRegistry.register` copies fields explicitly — add new `KindDef` fields there or they're
  silently dropped.** It rebuilds the stored def (`{kind, indexedPaths, sortablePaths, …}`) rather
  than spreading, so a new field (like `claimable`) is lost on registration unless you add it to the
  copy. This bit the `claimable` work: the flag validated and persisted fine but read back as
  `undefined` everywhere until `register` was taught to carry it (caught by conformance). Same
  applies to `kindDefKey` — include a new field there too, or a changed value won't mint a successor.
- **The ops query language is body-only by design; the envelope query is the ops exception.**
  The content-routing template DSL matches record *bodies* (for routing) and deliberately can't
  see the runtime envelope (state/attempt/lease). So observability that needs the envelope
  (diagnostics, "what's stuck") is NOT a template query — it's `GET /v0/ops/records?state=…`
  (`Space.queryEnvelopes`), and diagnostics composes that. Don't try to fold envelope-state,
  aggregation (stats), DAG-traversal (lineage/graph), or get-by-id into the template DSL:
  those are legitimately first-class ops capabilities, not endpoints pretending to be queries.

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
