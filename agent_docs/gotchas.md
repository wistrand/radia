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
- **An idempotency key travels as an HTTP header (a ByteString) — hash content into it, never
  embed it.** `Idempotency-Key` (and any header) must be Latin1; a key built from free-form content
  can carry Unicode (a tool description with `…`/`→`, a body with an em-dash) and `fetch` throws
  `Failed to construct 'Request': 'headers' … not a valid ByteString`. Content-keying a record (so a
  changed def is a successor, not a 409) is right, but the key must be a **hash** of the content, not
  the content itself. `kindDefKey`/`grant` keys are ASCII by construction (paths, types, principals);
  the capability publish content-hashes the tool def (`toolworker.ts`). Bit both the 409 fix and then
  this.
- **Lineage goes UP; to follow links DOWN you need children, not lineage.** `parent_ids` points
  from a record to what it was derived from, so `getLineage`/`space_lineage` returns *ancestors* —
  a **root** record (a `conversation`, a `job`) has none. To find records that *reference* a record
  (a conversation's messages, an llm_call's chunks/result, a task's results) use `getChildren` /
  `GET /v0/ops/records/{id}/children` / `space_children` (backed by `childrenOf`). This bit the
  chatbot: asked to summarize a conversation it called `space_lineage`, got just the conversation
  back, and wrongly concluded it was empty — the messages are its *children*. The two directions
  are why the console has both a lineage view and a graph view. (Guidance for the assistant lives
  in the discovered tool *descriptions*, not the chat's system prompt.)
- **SSE watch streams detect client disconnect via the response stream's `cancel()`, not
  `req.signal`.** Under `Deno.serve`'s legacy semantics, `request.signal` aborts on a *fully
  delivered response*, not only on client disconnect — using it to gate a long-lived SSE loop
  risks a false teardown, and merely reading it emits a deprecation warning
  (`--unstable-no-legacy-abort`). `handleWatchEvents` instead sets a `closed` flag in the
  `ReadableStream`'s `cancel()` callback (Deno invokes it when the client goes away) and races
  the keepalive wait against a wake promise so disconnect cleanup is prompt. Don't reintroduce
  `req.signal` here.

- **A bounded newest-first read of a thread must expand until the turn's start is in view.** Bit
  twice, in two files, within one change. A tool-heavy round is a dozen messages (one assistant
  `tool_calls` message plus a reply per call), so "read the newest N messages" can land entirely
  inside the tool replies and miss the `user` message that began the turn. In the inference-worker
  that produced a context window with no question in it (the model summarizes tool output it can no
  longer attribute); in the router it produced an EMPTY question, which the length heuristic scored
  as small talk and routed to the CHEAPEST tier — so the synthesis round, the one that most needs
  capability, systematically got the weakest model. Both now expand the descending read until a
  `user` message is included (`inference.ts` windowing, `router.ts` `currentTurn`), and the router's
  heuristic never scores an empty string as small talk. General rule: when a bounded read feeds a
  DECISION, the absence of the thing you are looking for is not a neutral default — decide what
  "not found" means explicitly.

- **Artifact bytes are served `inline` only for formats a browser cannot execute.** Blob bytes are
  attacker-supplied and served from the space's OWN origin — the origin whose console page carries
  an operator token — so `text/html` rendered inline is a same-origin XSS reachable by anyone
  holding an `artifact: put` grant. The allowlist names raster image, audio and video types
  explicitly rather than `image/*`, because `image/svg+xml` is scriptable; PDF is excluded for the
  same reason. Everything else downloads. `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox` back it up. Don't widen the list to
  "anything that looks like media" (`src/server/handlers/artifacts.ts`).

- **A download capability belongs in an `<img>`, not in a transcript.** Capabilities are minutes
  long and in-memory, so a URL carrying one is broken by the next restart and by the clock. The
  console mints one per render and uses it immediately — correct. Printing one into terminal
  scrollback (the chat example did) produces a link that looks permanent, fails later, and leaves
  a token in the user's history. Print the stable `/v0/artifacts/{id}` URL instead and let the
  viewer authenticate.

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

- **`created_by` and idempotency scope are the RESOLVED caller — threaded from the handler, not
  `ctx.principal`.** `put`/`ack`/settle take an optional trailing `principal`; the handlers pass the
  resolved caller, so `created_by` is the token's principal (or `human:local` for no-auth), the
  event `run_id` follows it, and idempotency keys are scoped **per principal** (two agents reusing
  the same `Idempotency-Key` don't collide — that was a real bug). It defaults to the space's own
  identity, so **in-process callers** (conformance, `demo.ts`) omit it → `created_by = local:dev`,
  which is why those tests still pin `local:dev` while the handler tests pin the caller. Grant
  *enforcement* still lives at the HTTP boundary (`Space` verbs don't call `authorize` themselves),
  so in-process callers bypass enforcement and exercise `authorize`/`bodyMatchesGrant` directly.
- **Lease settlement is owner-bound, not just fenced.** `ack` (and the other settle verbs, via the
  threaded principal) reject a non-operator principal that doesn't own the lease (`lease_owner`) —
  `lease_lost`, on top of the `leaseId`+`epoch` fencing. This closes lease-leak impersonation, which
  matters because an ack-emitted result is authorized as, and carries the delegation chain of, the
  lease owner. In-process/operator callers (no principal / privileged) skip the check.
- **Default principal is the operator, so dev stays open; enforcement only bites a real token.**
  An unauthenticated request resolves to `human:local` (privileged) — the UI, demo, and examples
  work with no auth. To act as a scoped principal you must mint a real run token via the bootstrap
  chain; there is **no impersonation shortcut** (the old dev-only `X-Radia-Principal` assume-header
  was removed — a client must never choose its own identity, so a single Bearer channel is the
  whole story).
- **The no-header operator default is only safe locally, so the server binds loopback and offers a
  close switch.** `radia dev` binds `127.0.0.1` by default (not all interfaces) — `--host 0.0.0.0`
  is an explicit opt-in to expose it. `--auth required` (`ServerOptions.authRequired`) drops the
  no-header shortcut entirely: no bearer → `401 auth_required`. `GET /` and `GET /v0/health` stay
  public so the console still bootstraps (it uses its baked operator token thereafter). Residual
  footgun: `GET /` serves that operator token embedded in the HTML, so `--auth required` over an
  exposed `--host` still leaks it to anyone who fetches `/` — for a locked-down exposed deployment,
  proxy-gate `/` or drop the bundled console. The loopback default is what keeps the local case safe
  without needing either.
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
- **Only token HASHES are stored; the credential index is a cache over records — the records are
  the authority.** Run/definition tokens are secrets returned once at mint; the
  `agent_definition`/`agent_run` record bodies hold the sha256 hash (not a secret), and
  `CredentialStore` is an in-memory index rebuilt by `Space.loadCredentials` at startup — the same
  cache-over-records pattern as kinds. A run's status change (stop) is a **successor** `agent_run`
  record (records are immutable), so rebuild takes records in id order and a later stop overrides the
  earlier mint. **The cache is not the source of truth:** on a miss, `Space.resolveToken` hydrates the
  one credential from the records by `tokenHash` (indexed on `agent_*`, honoring a stop successor)
  and retries — so a token minted on another instance, or one the startup load's `LIMIT` capped,
  resolves instead of a spurious `401`. The miss path is guarded by a token-shape regex so garbage
  tokens don't trigger a scan, and costs a per-kind fetch until read pushdown lands. Token expiry
  uses the **DB clock** (fetched only when a token is actually presented, so the no-auth path stays free).
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
- **Template-scoped grants apply to reads/claims AND writes.** A grant's `template` is AND-ed into
  `query`/`read_one`/`take` (`grant ∧ request` via `combineMatch`), and on `put`/ack the record body
  must satisfy it (`Space.bodyMatchesGrant`) — a scoped principal writes only records inside its
  template. Note the asymmetry: read-side ANDs the template into the *query*; write-side matches the
  *body* against it. Also: the read constraint nests as `$and[request, $or[templates]]`, so a grant
  template must be a flat equality map — a `$or`/`$and` inside one can exceed the depth-3 compile
  limit. And a template's paths are validated (indexed-path check) only when it compiles at use, not
  at grant creation (the kind may not be registered yet) — a bad path surfaces as a 400/denied later.

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
- **Concurrent same-key writes race on the idempotency insert — pooled Postgres exposed what
  single-connection embedded hid.** `withIdem` (`src/storage/pgbase.ts`) does SELECT-then-effect-
  then-INSERT. On single-connection PGlite/SQLite these serialize, so a duplicate key always hits
  the SELECT and replays. On the **pooled** Postgres adapter, N requests with the same
  `(principal, operation, key)` run on different connections, all SELECT empty, and only one can
  INSERT — the rest hit a unique-violation that aborts the whole transaction (a real 500 the SDK
  saw as unparseable text). Fix: the INSERT is `ON CONFLICT DO NOTHING`; a loser (0 rows) throws
  an internal `IdempotencyReplay`, which rolls its attempt back (discarding its effect — the
  record insert used a fresh id) and `withRetry` re-runs so the SELECT now replays the winner's
  stored response. The effect is non-idempotent on its own (fresh ULID per call); the idempotency
  row is the single-winner gate. This bit the chat example: three inference workers share one run
  principal and each publishes the same content-keyed `capability:escalate` at startup.
- **The watch/event cursor is the inserting `xid` (opaque), not the `seq` — do not "simplify" it
  back to seq.** `events.seq` (identity) is assigned at insert but transactions on the pooled
  Postgres adapter commit out of seq order, so a watcher consuming `seq > cursor` skips a low-seq
  event that commits after a higher one it already passed — silent dropped deliveries (felt as
  chat slowness via the poll fallback). `getEvents` orders by `xid` under the watermark
  `xid < pg_snapshot_xmin(pg_current_snapshot())`; `SpaceEvent.cursor` is an opaque string (seq on
  embedded, xid on pg) that the transport only echoes. See
  [design-storage.md](design-storage.md) "Watch delivery under concurrency".
- **The Postgres driver needs TCP_NODELAY or every parameterized query costs ~40ms.** deno-postgres
  (0.19.x) does not set `TCP_NODELAY`, so its extended-protocol (parameterized) queries send several
  small packets and hit Nagle + delayed-ACK — measured **42ms per query vs 0.18ms** with NODELAY, a
  230× hit that made pg-backed chat feel broken (a put+take+ack cycle went 602ms → 10ms). Simple
  (unparameterized) queries don't show it, so it hides in microbenchmarks. The driver connects via
  `Deno.connect` and exposes no socket option, so `src/storage/postgres.ts` enables NODELAY by
  wrapping `Deno.connect` once (only raw TCP connects are affected; `fetch`/`Deno.serve` use a
  different path). Remove the wrapper if deno-postgres starts setting it. Not docker-specific —
  reproduced identically via the published port and the container IP.
- **Any uncaught handler error must return problem+json, never a plain-text 500.** The SDK does
  `JSON.parse(body)`, so a bare `Deno.serve` 500 ("Internal Server Error") surfaces as a cryptic
  `Unexpected token 'I'` that hides the real fault. `makeHandler` wraps the dispatch in a
  catch-all (`src/server/http.ts`): a `RadiaError` maps by `statusFor`, anything else is a logged
  500 problem — so clients always get parseable JSON.
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
- **Artifact keys derived from the caller's token.** Rejected. The runtime stores only
  `sha256(token)` (`core/auth.ts`) precisely so a leaked DB yields no usable credential, so it
  cannot re-derive such a key without keeping the token at rest — trading the strongest part of
  the auth model for the weakest kind of encryption. Three more, any one fatal: run tokens expire
  while records are permanent (the blob would die with the run); an artifact exists to be consumed
  by a *different* principal, so a producer-keyed blob needs per-recipient rewrapping, which is the
  federation-gated recipient-keyed scheme; and since the runtime must decrypt for any grant-holder,
  the key must live where the runtime reaches it anyway — which is exactly what a space KEK gives,
  without the other three problems. A token authorizes the *ask* (that is what download capabilities
  are); it is not key material. The planned scheme is per-artifact random DEK + AES-GCM, DEK wrapped
  by a space KEK from env/keyring, behind the `BlobStore` port. Token-keyed encryption only makes
  sense client-side (confidentiality layer 3), where it is incompatible with the point of the
  feature: an image the runtime cannot read is one it cannot validate, taint, or route.
- **Embedded mode as a weaker cousin.** Rejected: the conformance + fault suite runs on
  every adapter in CI from day one, or the backends drift.
- **Escalation-only tier routing, with no classifier (chat example).** Tried, then reverted on
  evidence — the interesting one, because the argument for it was sound and the assumption under
  it was false. The router's pre-classifier (a cheap `llm_call` served by the fleet, answering
  with a tier word) was removed in favour of: dispatch every turn to the cheapest advertised tier
  and let a worker `escalate` when it finds itself out of depth. Rationale: a classifier taxes
  every turn, in front of the first token, to answer a question that is only in doubt on a
  minority of them, while escalation pays only on the turns actually misrouted. Cost belongs where
  the uncertainty is.
  **What happened:** across a tool-heavy analytical session every turn routed to the cheap tier
  and *nothing* escalated — the model answered an aggregation question from invented numbers
  instead. Escalation depends on the cheap model recognizing its own inadequacy, which is the
  weakest available judge; a model confident enough to confabulate is exactly the one that will
  not reach for `escalate`. Restored, with the judgment made by a different model than the one
  being judged. Escalation is kept as the catch for under-routing: two mechanisms for one decision
  is deliberate here.
  **Keep from the removal:** no tier name appears in `router.ts` any more. Live tiers come from
  `model` records by `rank`, the classifier answers with one of those words, and the fallback
  heuristic picks by *position* in that list, not by name — the original fallback hardcoded
  `"fast"|"balanced"|"deep"` in the file whose thesis is that tiers are discovered.
  **Related limit, unresolved:** a `model` record is written once at worker startup and never
  expires, so it advertises a tier, not a live worker. Routing to a tier whose worker is dead
  leaves the call `available`; the chat's stall detection reports it rather than the fleet
  re-probing.

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
| Temporal encroaches on gap | don't compete on durability (Temporal's decade-hardened home ground); the differentiator is record-scoped classification/containment + content routing, which Temporal has no place for. Watch for a Temporal data-classification / per-step-permission story — the single external event that most narrows the thesis (moderately unlikely: hard to retrofit taint into an opaque-payload, no-record model; but the 2026 a16z Series D funds the attempt). See [research-positioning.md](research-positioning.md). |
