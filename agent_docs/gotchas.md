# Gotchas, rejected approaches, and risk register

Non-obvious decisions and the reasoning behind them: the "why is it like this" that the
spec alone doesn't carry. Skim before proposing a change to signing, encryption,
idempotency ordering, storage backends, or the delivery guarantee. Origin: outline §9.1,
§9.2, §13, and rationale scattered through §2–§8.

**Read a SECTION, not the file.** The traps below are grouped by what a rule constrains, so a
change to one subsystem has one heading to skim rather than nine hundred lines. Many rules are
genuinely bi-topical (a storage lesson learned in the credential path), so they sit under the thing
they CONSTRAIN, not where they were found; grep by symbol (`readRegistry`, `lease_lost`) when in
doubt.

**Writing an entry: a bold rule, then at most a short paragraph.** Name the mechanism, the
consequence, the measurement if there is one, and the symbol or guard to look at. Cut the
narrative of how it was found, what was believed first, and anything a reader can infer. An entry
past ~8 lines is one that needs cutting, not a second paragraph: this file is read by someone
skimming for a rule, and a page of prose per entry means the rule is not found.

## Contents

- [Findings](#findings) (diagnosed during implementation)
- [Traps and critical decisions](#traps-and-critical-decisions), by subsystem:
  - [Records, kinds, matching and taint](#records-kinds-matching-and-taint)
  - [Registries, and reads that must not truncate](#registries-and-reads-that-must-not-truncate)
  - [Leases, claims, events and watches](#leases-claims-events-and-watches)
  - [Storage, SQL and the planner](#storage-sql-and-the-planner)
  - [Credentials, tokens and sessions](#credentials-tokens-and-sessions)
  - [Grants, scopes and narrowed answers](#grants-scopes-and-narrowed-answers)
  - [Artifacts, blobs and erasure](#artifacts-blobs-and-erasure)
  - [Executing model-written code](#executing-model-written-code)
  - [Surfaces: HTTP, console, CLI and the SDKs](#surfaces-http-console-cli-and-the-sdks)
  - [Agent- and model-facing design](#agent--and-model-facing-design)
  - [Method: how these were found](#method-how-these-were-found)
- [Rejected approaches](#rejected-approaches) (do not re-propose without revisiting these)
- [Risk register](#risk-register)

## Findings

### `jsr:@db/sqlite` FFI segfaults; use built-in `node:sqlite`

- **Symptom:** the conformance suite and even a standalone `new Database(":memory:")`
  exited 139 (SIGSEGV) with no output, under Deno 2.9.2 on Linux. First run also required
  `--allow-env` / `--allow-net` just to download a native `libsqlite3.so`.
- **Diagnosis:** `jsr:@db/sqlite@0.12.0` loads a prebuilt native library over FFI; that
  library crashes on load under this Deno build.
- **Fix:** the M0 SQLite adapter uses Deno's built-in **`node:sqlite`** (`DatabaseSync`)
  instead: no FFI, no native download, no `--allow-ffi`, and one fewer dependency.
- **Takeaway:** prefer the runtime's built-in SQLite to an FFI package. It also fits the
  minimal-deps / platform-independence invariant better. `node:sqlite` is still marked
  unstable upstream; watch for API changes on Deno upgrades.

## Traps and critical decisions

> Most of the entries below are instances of ONE mistake: a registry's writes are unbounded, its
> reads were bounded, and nothing connected the two. They are kept individually because each cost
> real debugging, but the fix is structural and lives in `src/core/registry.ts` (`readRegistry`,
> which pages to exhaustion and admits when it cannot) plus content-keyed registry writes. New code
> should not be able to re-enter this class: if you are writing `query(kind, N)` and treating the
> result as "all of them", use `readRegistry` instead.

Grouped for skimming, and every entry is one rule with its reasoning. Jump to:

- [Records, kinds, matching and taint](#records-kinds-matching-and-taint)
- [Registries, and reads that must not truncate](#registries-and-reads-that-must-not-truncate)
- [Leases, claims, events and watches](#leases-claims-events-and-watches)
- [Storage, SQL and the planner](#storage-sql-and-the-planner)
- [Credentials, tokens and sessions](#credentials-tokens-and-sessions)
- [Grants, scopes and narrowed answers](#grants-scopes-and-narrowed-answers)
- [Artifacts, blobs and erasure](#artifacts-blobs-and-erasure)
- [Executing model-written code](#executing-model-written-code)
- [Surfaces: HTTP, console, CLI and the SDKs](#surfaces-http-console-cli-and-the-sdks)
- [Agent- and model-facing design](#agent--and-model-facing-design)
- [Method: how these were found](#method-how-these-were-found)

### Records, kinds, matching and taint

- **Predicate pushdown is a SOUND pre-filter, never a second opinion.** `src/storage/pushdown.ts`
  renders part of a compiled pattern into SQL, but the oracle in `core/matching.ts` still decides
  every match. The asymmetry is the whole safety argument: over-returning is free (the oracle
  rejects the extras), under-returning is a silent lost record, and for `take`, an empty space
  reported while work sits in it. So anything not expressible EXACTLY renders as `TRUE`: object
  and array equality (the oracle compares serialized text, so key order matters; jsonb normalizes
  it), `$each`, a range against a non-ASCII bound, any path segment outside `[A-Za-z0-9_]`
  (segments are inlined into a JSON path literal so the planner can match an index, and restricting
  the alphabet is what makes that injection-proof), and any ALL-DIGIT segment (next entry). Three
  traps: rendering a node BINDS PARAMETERS as a side effect, so a caller discarding the SQL must
  roll them back too (`mark`/`rollback`); `json_extract` returns SQL NULL for both an absent key and
  a JSON `null`, so presence is asked via `json_type`; and an unguarded jsonb `>` compares a string
  to a number happily, since jsonb totally orders across types. Every comparison is type-guarded.
- **A path segment means three different things to the oracle, Postgres and SQLite, and the
  disagreement is in the unsound direction.** Two shapes, both closed at their root (package E).
  **All-digit segments** (`items.0`, `a.00`): the oracle indexes an array element by property
  access, Postgres' `#>` takes a subscript (`00` too, parsed as 0), SQLite's `$.items.0` is a KEY
  lookup that is NULL over an array, and `@>` asks whether the array contains `{"0": v}`. So both
  dialects EXCLUDED records the oracle accepts, and the leading-zero case over-included while marked
  `exact`, dragging the caller's LIMIT with it. `pushablePath` declines them. **Prototype-shaped
  names** (`arr.length`, `obj.constructor`) run the other way: `getPath` used bare property access,
  so they resolved for every record while SQL correctly saw nothing. It resolves own properties
  only, and an array only by canonical index; a body really holding a key named `length` still
  routes. **When the oracle and SQL disagree, ask which is describing STORED DATA** — usually SQL,
  and the oracle is what to narrow. Pinned by the differential case in `suites/pushdown.ts`, which
  runs each pattern through the adapter AND the bare oracle, since under-return is invisible to any
  test that checks the adapter against itself.
- **A LIMIT may only be pushed under an EXACT filter, not merely a sound one.** `Pushed.exact`
  distinguishes them, and it is the difference between an optimization and a correctness bug: with
  an inexact filter SQL returns its first N rows, the oracle rejects some, and the matching rows
  further down were never fetched, so the caller silently gets fewer records than exist. `readOne`
  and `query` push the limit only when the filter is exact AND there is no `orderBy` (with no
  `orderBy` the oracle's order is its `x.id < y.id` tie-break, which `order by id` reproduces).
  Pinned by "a limit is never pushed under a filter the database cannot decide" in
  `conformance/suites/pushdown.ts`.
- **Postgres orders text by the database's collation; the oracle orders by JS string comparison.**
  They disagree under a linguistic collation, so the pushed limit sorts `id collate "C"` against a
  dedicated `idx_records_id_c`. Keep it, but keep the severity straight: for the ids the runtime
  actually mints there is no divergence. Checked with `sort` under both locales, `C` and
  `en_US.UTF-8` order Crockford base32 (digits and uppercase letters, all a ULID contains)
  IDENTICALLY; they differ on punctuation and case, which a ULID has none of. So this guards
  against ids ceasing to be ULIDs, and no test can be written that fails without it.
- **`indexedPaths` are a validation contract, not per-path physical indexes.** One GIN index
  (`jsonb_path_ops` over the generated `body_jsonb`) answers pushed equality on every path, so
  declaring a path costs no DDL and no migration — that is what keeps kinds-as-records from
  dragging a schema change behind it. At 40k records a selective `read_one` is **7.98ms without the
  index, 1.42ms with**, for ~5% on `put`. Not to be confused with the headline pushdown win:
  against an unselective predicate GIN is not used at all, and the speedup is the pushed LIMIT
  letting the scan stop at the first match.
- **Lineage goes UP; to follow links DOWN you need children.** `parent_ids` points at what a record
  was derived from, so `getLineage` returns ANCESTORS and a root record (a `conversation`, a `job`)
  has none. Use `getChildren` / `space_children` (backed by `childrenOf`) for records that
  REFERENCE one. This bit the chatbot: asked to summarize a conversation it called `space_lineage`,
  got the conversation back, and concluded it was empty — the messages are its children. The two
  directions are why the console has both a lineage and a graph view.
- **The graph/lineage viewer excludes nothing by default except what the caller asks**
  (`?exclude=llm_chunk`): streaming `llm_chunk` records would otherwise dominate a
  conversation graph. Keep chunk flushing coarse for the same reason (event-log volume).
- **An empty allowlist is not the absence of one, and collapsing them inverts a security control.**
  `allowTaint: []` means "accept nothing classified", the STRICTEST barrier there is; `undefined`
  means no barrier at all. A helper that returned `undefined` for an empty array turned the
  strictest possible request into no barrier, and conformance caught it. The same shape recurs
  wherever an empty collection is a real answer: an empty grant list, an empty label set, an empty
  scope. Check for `=== undefined`, never for falsiness.
- **Compare identities that are the same KIND of name.** `foreign` (derived from another
  principal's record) first compared the LEASE OWNER (`run:…`) against a record's `created_by`
  (the resolved caller), which are the same actor under two names, so a worker's own ack read as
  foreign against the task it had just claimed. A label that fires on everything is the saturation
  the label set exists to end. Compare against whatever will become `created_by`.
- **Do not denormalise what the log already answers; denormalise what the HOT PATH cannot afford to
  ask.** Provenance is in the graph: `parent_ids` plus a server-assigned `created_by` answers "did
  this descend from executed code" with a lineage walk. Measured, that walk is 1.3 ms over a 60-turn
  thread, which is free for an auditor asking once and ruinous inside `take`, which runs it per
  candidate (~0.3 s against a 2.4 ms claim, 125x). So the test for a new envelope field is not "is
  this true of the record" but "is this tested where walking the log is too expensive". A first draft
  of the taint labels carried `model` and `exec` on that mistake; both are graph facts, neither is
  ever tested at claim time, and both were cut. See [design-taint.md](design-taint.md).
- **A RAISE and an INHERITANCE look alike and need opposite rules.** A caller asserting what the
  graph does not know ("this tree came off a filesystem") may label whatever it likes, since raising
  is monotone and needs no trust; a derived tree carrying what its predecessor carried must travel
  on the record graph and nowhere else, or the copy drifts from the fact. `writeWorkspace` does the
  first; a write-back and an edit do the second. "Should file artifacts carry labels at all" was the
  wrong question, and taking its answer literally would have deleted a tested feature.
- **Taint follows DATA parents; delegation follows the LEASE. Never cross them.** `Space.computeTaint`
  ORs `taint:true` (client raise) with any `parent_ids` parent's taint, on both put and ack (the
  leased record is a data parent, so taint rides through `ack`). `delegation_context` derives from
  the lease, never `parent_ids`. Two separate lineages by design; don't compute one from the other.
- **`taint` is the one authoritative field a client may RAISE (never lower).** `put`'s `taint:true`
  is honored (source attestation: "my output is untrusted"); `taint:false` from a client is
  ignored (propagation/declassify decide). This is a deliberate, narrow exception to "clients submit
  only claims": the handler maps `taint === true` only. Clearing taint is a **privileged
  declassify** (`Space.declassify`), which, because records are immutable, emits a **clean successor**
  (same body, `taint:false`, tainted original as its data parent) rather than mutating anything.
  Don't add a way for an ordinary agent to write `taint:false`.
- **The one operation whose purpose is accountability must name its actor and be its own event
  operation.** `Space.declassify` called `putRaw` with NO principal, so the clean successor's
  `created_by` (and the event's `runId`) was the space's own identity rather than the approving
  operator, and the event said `operation: "put"` because no `declassify` operation existed in the
  log. The whole audit trail for a clearance was `parentIds` plus an anonymous put — which outranks
  the hash-chained log: a tamper-evident chain over a record that omits the approver protects the
  wrong fact. It threads the approver now and commits a distinct `declassify` operation carrying
  `{declassifiedFrom}` (`conformance/suites/taint.ts`). **If an operation exists to be audited, it
  needs its own verb in the log** — an entry that looks like every other write is not findable.
- **The taint barrier filters candidates in core, not SQL.** It lives in `rankClaimable` (skips a
  candidate carrying any label outside the allowlist), threaded via `LeaseSpec.allowTaint`, so
  both adapters get it for free and it stays backend-neutral. It's a claim-time skip, not a query
  predicate (taint is runtime metadata, not body; the content-routing DSL can't see it, same as the
  envelope).
- **The ops query language is body-only by design; the envelope query is the ops exception.**
  The content-routing pattern DSL matches record *bodies* (for routing) and deliberately can't
  see the runtime envelope (state/attempt/lease). So observability that needs the envelope
  (diagnostics, "what's stuck") is NOT a pattern query; it's `GET /v0/ops/records?state=…`
  (`Space.queryEnvelopes`), and diagnostics composes that. Don't try to fold envelope-state,
  aggregation (stats), DAG-traversal (lineage/graph), or get-by-id into the pattern DSL:
  those are legitimately first-class ops capabilities, not endpoints pretending to be queries.
- **Timing fields are never overloaded.** Reusing `deadline_at` as `available_at` (or any
  such shortcut) breaks retention-vs-lease separation. Keep the five distinct.

### Registries, and reads that must not truncate

- **A `desc` sort puts records with NO value FIRST** (`compareRecords`, `src/core/matching.ts`).
  `compareValues` sorts a missing path last, then `desc` negates the whole comparison including that
  rule, so "the largest" leads with the records that have none. Ordering by `usage.total_tokens`
  ranked a user message above every answer. Always pair a descending `orderBy` with a match that
  excludes the absent (`role: "assistant"`, or `$exists: true`). Matches Postgres's NULLS FIRST
  default, so it is defensible, but the comment beside it claims "missing sorts last" unqualified.
  Guard: `examples/chat/smoke-inspect.ts`, "a descending sort puts records with NO value first".
- **A body field nobody DECLARED is invisible to discovery, not just to matching.** `space_digest`
  reports declared paths, so an agent cannot learn a field exists. The provider's `usage` sat on
  every assistant `message` from the start, unreachable: asked which call cost most, the assistant
  went hunting in `tool_call`, spent a grant request on it, and answered in adjectives. Declaring
  is publishing (`examples/chat/space/kinds.ts`); writing is not.
- **`getGraph` walks parents AND children, so under a HUB record it returns every sibling thread**
  (`src/core/space.ts`). Seeded inside one conversation turn it climbs one hop to the conversation
  and fans back down into all of them, then stops at `maxNodes`: a live 346-record thread drew as
  150 nodes with nothing saying so. Use `direction: "down"`, and read `truncated` — a capped graph
  is a bounded read presented as a population, in a picture. It only separates a thread that IS a
  subtree: see [[plan-chat-turn]] on parenting each link to its cause.
  Guards: `conformance/suites/graph.ts`, `examples/chat/smoke-turnlink.ts`.
- **`new Map(entries)` keeps the LAST value per key, not the first.** Grouping "the first record per
  turn" that way silently selects each turn's final round, and the assertion built on it passed
  against the very shape it was written to reject. Build the map with an explicit
  `if (!m.has(k)) m.set(k, v)` whenever first-wins is the point.
- **`listKinds()` does not list every kind.** It reads `kind_def` RECORDS, and NINE kinds are
  defined in code instead (`kind_def`, `grant`, `signal`, `agent_definition`, `agent_run`,
  `artifact`, `interest`, `shred`, `ops_grant`; see `RESERVED_KINDS`, which is the list — this
  entry said six, then eight, each time updated only after drifting). Anything answering "does
  this kind exist" must add them, or it will report that
  `artifact` is not a kind while the caller is successfully counting artifacts.
- **Content-key idempotency dedupes for a WINDOW, and a re-put outranks a tombstone.** "Registry
  writes are content-keyed so restarts don't append" is implemented as content-key-as-idempotency-key
  (`kindDefKey`, `opsGrantKey`), and idempotency rows sweep after `idempotencyRetentionSeconds`
  (7 days). Past the window a boot-time re-put appends a FRESH record: for keep-newest registries
  compaction sweeps the surplus; for NEVER_COMPACT kinds it accumulates per boot (`kind_def` does
  this today, slowly); and for an AUTHORIZATION registry the fresh record is newer than any
  `retired: true` tombstone, so a scheduled republish silently un-retires what an operator
  withdrew — invisible in any test shorter than the window. Never republish an authorization
  entry on a schedule; assign it once, when the identity is created (`provisionObserver`), and
  let a retirement stand until an explicit revoke re-creates the identity. Found 2026-08-06 in
  review, before it shipped; planted in `defaults.test.ts`.
- **Filtering a cursor-paged endpoint breaks paging unless the cursor is reported separately.** An
  empty page is how every caller detects the end of a log, so a page whose events were all withheld
  reads as "nothing further", and a scoped caller could never page PAST foreign events to reach its
  own (0 visible on a space whose first 500 were someone else's). Two parts, the second easy to
  skip: scan forward across raw pages rather than filtering one, and report `nextAfter` from the
  last RAW event examined (`getEventsPage`), so a caller can advance past what it cannot see.
- **A bounded page over a registry must be read NEWEST-first, or a busy space hides the newest
  entry.** A limited query returns the OLDEST matches, so a space holding more `capability` records
  than the cap shows every tool EXCEPT the ones published most recently: a live session reported "I
  don't have a request_grant tool" for a tool that was published, granted and working. Registry
  projections over a capped page pass `{dir: "desc"}` (`ToolSet.refresh`, `Space.loadKinds`). Two
  contributing causes: **capability publication was not idempotent across restarts** (an idempotency
  key is scoped `(principal, operation, key)` and a worker's principal is a fresh `run:<ulid>` each
  launch, so an unchanged definition wrote a new record per start — 24 per chat restart, ~21
  restarts to cross 500; `publishCapability` reads the current advertisement and writes only on a
  real change), and the startup wait was "until ANY tool appears", which returns as soon as the
  first worker publishes.
- **A registry is a projection, and `retired: true` is how you withdraw from one.** Kinds, grants,
  capabilities, models and procedures are mutable-looking tables over an append-only stream, so
  "remove" is a successor carrying `retired: true`, honoured in ONE place (`src/core/registry.ts`).
  Two shapes, and the wrong one is a correctness bug: **latest-wins** (`activeByKey`: kind_def by
  kind, capability by tool, model by tier, procedure by name) and **additive** (`activeSet`:
  grants), where entries coexist and each is independently withdrawable — a grant keyed on
  `(principal, kind)` would take every other grant on that kind with it, which is why `grantKey` is
  the whole content. Two easy mistakes: retirement is applied AFTER the newest-per-key pass, never
  as a filter over the input (filter first and an older non-retired record becomes "newest" and
  resurrects the entry), and the projection compares timestamps/ids rather than arrival order.
  Nothing is deleted, so the audit trail survives a revocation and re-declaring revives.
- **Record ids are MONOTONIC ULIDs, and latest-wins depends on it.** A plain `ulid()` randomizes
  everything below the millisecond, so declare-then-retire (a same-millisecond pair) could leave the
  retirement outranked by the record it retired. Latent in `loadKinds` and the capability projection
  long before retirement existed; it surfaced as a conformance test that passed alone and failed in
  a full run, the signature of same-millisecond collisions. `newUlid()` uses `monotonicUlid()`, and
  monotonicity is PER PROCESS.
- **Across instances the id is the TIE-BREAK, not the clock: registries order by `created_at`
  first.** A ULID's timestamp half is the WRITING PROCESS's clock, so ordering by id alone imports
  clock skew into an authorization decision: two instances a second apart order a second of writes
  backwards, and a revocation can lose to the grant it revokes. `created_at` comes from the DB clock,
  so `newer` (`sdk/ts/registry.ts`) uses it, with the id deciding inside one millisecond, where it
  carries real per-process order ("prefer the retirement on a tie" was tried and reverted: it broke
  revival). Still NOT commit order — `created_at` is read before commit, so a same-DB-millisecond
  cross-instance race stays undefined; closing it needs the event cursor's `xid8` machinery carried
  on the record, i.e. through the frozen wire contract.
- **Kinds are records (`kind_def`), and the `kind_def` meta-kind is the one bootstrap in
  code.** A kind declaration is a `kind_def` record; the registry is a cache rebuilt by
  querying them (`Space.loadKinds`). This has a chicken-and-egg: to `query {kind:kind_def}`
  the kind `kind_def` must be registered. Broken by registering `META_KIND_DEF` in the Space
  constructor (in code, never a record). Consequences to preserve: `Space.put` special-cases
  `kind_def` (validate the body as a `KindDef`, register it after commit, on idempotent
  replay too); re-declaring `kind_def` itself is rejected; a re-declaration of any other kind
  is a **successor** record (immutability), so `loadKinds`/`listKinds` take the latest per kind
  name (by ULID id). Re-registering an identical def is idempotent (deterministic key from
  `kindDefKey`), so restarts don't grow records. Don't reintroduce a `kinds` table or a
  `/v0/kinds` endpoint; that's the side-table-beside-the-substrate this replaced.
- **A reserved kind may be EXTENDED by a redeclaration, never SHRUNK, on every path a declaration
  enters by.** `authorize` compiles against `grant.principal`/`grant.kind` and credential resolution
  against `agent_definition.tokenHash`, so a successor `kind_def` dropping one of those paths failed
  every authorization in the space with `undeclared_path` — fail-closed, space-wide, and reinstated
  on each restart by `loadKinds`. No operator needed: `kind_def` is deliberately not write-protected,
  so an ordinary `put: kind_def` grant was the whole vector. `assertReservedCompatible`
  (`src/core/kinds.ts`) refuses dropping a code-defined path of a `META_RESERVED` kind or changing
  its `claimable`, principal-independently. Extending stays legal (the chat adds `conversationId` to
  `artifact`), and a redeclaration REPLACES rather than merges, so it must repeat the runtime's own
  paths. Two reusable halves: **the check belongs on every write path, not the one you thought of**
  (`ack` results skipped it entirely, so a lease was a way around a rule the direct write obeyed),
  and **a startup that CASTS what a live write validates cannot recover from what is already in the
  log** (`loadKinds` adopted stored bodies unchecked, so a pre-rule declaration outlived the fix).
- **A bounded read of a registry stays a bug after you fix its DIRECTION.** The chat's tool list read
  an ascending page of 500 and lost the newest tool on a space with 505 records. The fix was
  `dir: "desc"` — which corrected which tools vanish (least-recently-republished instead of newest)
  and left the boundedness. Measured mid-session on a real space: **737 capability records for 33
  tools**, so the page was within 1.5x of silently dropping tools again. CLAUDE.md already said
  registry state is read through `readRegistry`, never a hand-rolled `query(kind, N)`; this was the
  hand-rolled one, in the most consequential place, and the failure mode is invisible — "the
  assistant does not have that tool" is indistinguishable from "it did not think to use it".
- **A registry rebuilt only at startup is single-instance by accident.** `loadKinds` ran once and a
  `kind_def` put registers in the WRITING process only, so with N instances a kind declared on A was
  unknown to B until restart, and one REDECLARED on A left B compiling the old contract. Reads
  failed; writes were fine, because one GIN index serves every path, so a declaration governs
  COMPILATION rather than storage. The refresh is driven by the SYMPTOM (`unknown_kind` /
  `undeclared_path` → re-read that kind → retry once), not a timer: a periodic refresh has a
  staleness window by construction, and refresh-on-MISS alone fixes only half, since a stale
  declaration is not a missing one. The old conformance test asserted `unknown_kind` before
  `loadKinds()` — **the bug written down as expected behaviour**, which is how these live longest.
- **`query <kind>` is not a listing when versions are records.** Three saves of one workspace are
  three `workspace` records, so a raw query answers a question nobody asked and counting its rows is
  wrong twice over. Anything registry-shaped needs the latest-wins-minus-retired projection, and it
  belongs in ONE place: `summarizeWorkspaces` is shared by `radia workspaces` and the chat's
  `list_workspaces` precisely so the two cannot disagree about what exists.
- **`KindRegistry.register` copies fields explicitly, so add new `KindDef` fields there or they're
  silently dropped.** It rebuilds the stored def (`{kind, indexedPaths, sortablePaths, …}`) rather
  than spreading, so a new field (like `claimable`) is lost on registration unless you add it to the
  copy. This bit the `claimable` work: the flag validated and persisted fine but read back as
  `undefined` everywhere until `register` was taught to carry it (caught by conformance). Same
  applies to `kindDefKey`: include a new field there too, or a changed value won't mint a successor.

### Leases, claims, events and watches

- **The wakeup burst's reads are COALESCED, and only reads that cannot change in flight may be**
  (`src/core/coalesce.ts`; `Space.getEvents` and the record fetch in `matchesEvent`). One
  `notify()` resumes every parked stream in the same tick, so U streams issued U identical log
  reads and U identical record fetches for one write; single-flight collapses them to one each
  (measured 250+250 → 1+1, 127ms → 2.3ms at 250 streams). It is NOT a cache: an entry lives only
  while its read is in flight, so a sequential caller always hits storage and there is no TTL or
  invalidation. Two rules before coalescing anything else: the answer must be immutable for the
  read's duration (the log below the finality watermark is append-only; records are immutable),
  and a shared result must still be AUTHORIZED per caller — the shared record is evaluated against
  each watch's own scope, so sharing changes how often it is read, never who may see it.
  Guard: `conformance/coalesce.test.ts`.
- **Coalescing collapses reads that OVERLAP, so its benefit decays as load staggers the wakeups**
  (`bench/suites/chatload.ts`). Measured: 40 sessions / 200 streams on live Postgres cost 344
  queries per turn against 122 at 100 streams, and the whole excess is `getRecord` (24/turn → 242)
  while puts, `getEvents` and grant reads stay flat. Nothing regressed; the burst simply stopped
  landing in one tick once turns queued for seconds. Do not read "1 query per write however many
  streams" as unconditional — it holds while the streams wake together, and the fix if it ever
  binds is the broadcast tailer that file's header describes.
- **`notify(kind)` is kind-aware, and a new wake site must pass the right kind or wake everyone**
  (`src/core/notifier.ts`, `Space.putRaw`/`ack`). A watch matches only its own kind, so a write
  wakes only that kind's parked streams plus the any-set; waking foreign kinds was the O(U)
  fan-out (bench/suites/fanout.ts: one write woke all N streams, N-1 wasted). Two rules for any
  new wake: an AUTHORIZATION_KIND write must wake EVERYONE (`notify(undefined)`), because the SSE
  loop re-scopes on those and a revoked stream must see it; and a caller that cannot cheaply name
  the kind whose watchers newly match (a settle across kinds, the foreign-instance poll) wakes
  everyone too — under-waking stalls a stream until its 15s keepalive, the one failure worse than
  waste. Kind-aware does NOT help watchers that share a kind and differ by predicate (250
  `message` streams still all wake on a `message` write). Guard: `conformance/notifier.test.ts`.
- **A chat worker reads FLAGS, not the environment, unless the fleet gave it `--allow-env`**
  (`examples/chat/client/fleet.ts`). Each worker is spawned with the narrowest permissions that
  let it work, and `tools`, `turn` and `exec` get no env access at all, so `Deno.env.get` there is
  a NotCapable crash at STARTUP, before any test that does not launch the real fleet can see it.
  The launcher has the environment and resolves values into arguments (`PROVIDER_CONCURRENCY` /
  `LOCAL_CONCURRENCY` are the worked example). A `??` chain hides this: `arg("--url") ?? Deno.env.get(...)` never crashed only
  because the flag was always passed. Guard: `smoke-fleet.ts` correlates each spawn's flags with
  its worker's source, which is how the `turn.ts` case was found.
- **A worker loop must never swallow a handler exception, whatever its logging is configured to
  do.** `agentLoop`'s `log` defaulted to a no-op and the nack path used it, so a throwing handler
  retried invisibly: claimed, nacked, reclaimed, nacked again, with nothing anywhere naming the
  cause. Every caller saw the same symptom, "the work never completed", which is indistinguishable
  from a worker that was never started. Three separate defects in one afternoon presented that way.
  Failures now reach `console.error` when no `log` was given, in both SDKs, and there is no way to
  turn them off; routine trace stays opt-in. Guarded by `conformance/loop.test.ts`, including that a
  caller WHO DID pass a log does not also get stderr.

- **A watch is dropped when it is IDLE, never when it disconnects.** The map was never pruned at
  all: every `POST /v0/watches` allocated an entry that outlived any interest in it, from a cheap
  authenticated call, and the workload that makes it bite is an inspection console opening many
  short-lived watches — which is why `plan-inspection.md` named this its one prerequisite. The
  tempting fix is wrong: deleting on stream close breaks RESUMPTION, and the cursor exists precisely
  so a dropped client can reconnect to the same id with `Last-Event-ID`. So the rule is "nothing
  attached for `watchIdleSeconds`", a live stream keeps its watch alive by touching it every lap (at
  most a 15s keepalive apart), and the sweep runs on CREATE so an idle space holds no timer. The
  ceiling (`maxWatchesPerPrincipal`) REFUSES with a 429 rather than evicting the oldest, because
  evicting kills somebody's live stream to serve a new one and tells them nothing.
- **A watch wakeup crosses instances by POLLING THE EVENT LOG, and the poll runs only while somebody
  waits.** `notify()` knows this Space's own mutations and nothing else, so a watch on A slept
  through B's write until the caller's keepalive (15s in the SSE loop). `LISTEN`/`NOTIFY` is not
  available: deno-postgres 0.19 exposes no asynchronous notification API (checked — `QueryClient`
  has queries and transactions, no notification hook). So a parked waiter drives
  `Space.pollForForeignChanges` every `CHANGE_POLL_MS`: one query per interval per SPACE however
  many streams are open, and none at all when nobody waits. The first poll of a space's life always
  reports a change, since a record written before it took its baseline would otherwise be the one
  wakeup this exists to deliver. Errors are swallowed — the poll is a hint, the log is the truth.
- **Never 410 the `"0"` cursor sentinel; clamp it.** Both SDKs recover from `410 cursor_expired`
  by resetting to the literal `"0"` and reconnecting with no sleep, so a uniform
  `cursor < horizon → 410` hot-loops every shipped client forever. `"0"`/absent means "from the
  beginning", which on a truncated log is the oldest retained event; only an explicit non-sentinel
  cursor below the horizon is refused (`watches.ts`). The comparison lives on the storage port
  (`eventHorizon`), never in the transport, because cursors are dialect-shaped (seq vs. xid8).
  Ops reads never 410 at all: they clamp and annotate (`logBeginsAfter`/`sweptBefore`), or the
  first sweep would permanently break every from-zero read.
- **Event GC's deletion order is what separates honest truncation from tampering.** Three rules,
  each of which turns a crash into a false tamper verdict if broken (`Space.gcEvents` owns them):
  the horizon statement is written AND sealed before the first delete (`attestEventTruncation`
  must return `attested: true`, else the sweep walks away); events and their seals delete
  TOGETHER, oldest-first, per transaction, so every observable state is a clean prefix
  truncation; and a cursor group is never split — an xid groups one transaction's events, so the
  anchor steps DOWN and sweeps less rather than stranding a retained sibling below the horizon.
  Verify accepts "begins at J" only when the newest sealed statement attests an anchor ≥ J, which
  is what lets a killed-and-resumed sweep still pass. `take` selected every
  available-or-leased record of the kind `for update … skip locked`, then filtered in the runtime.
  Two bugs in one line. **Starvation:** one claimer's open transaction held row locks on the whole
  queue, so a peer's `skip locked` found nothing and was told EMPTY while work remained (67 wasted
  takes at 4 claimers, 166 at 16). Invisible to `deno task conformance`, since the embedded adapters
  are single-connection. **Cost:** ordering the JOIN materialized every body of the kind before
  `limit`, making a claim O(kind size) in bytes. The fix (`fetchCandidates`/`take`): a bounded
  `CANDIDATE_WINDOW` (64) chosen from the narrow `record_runtime` table, bodies fetched only for
  that window, no row locks, single-winner resting on a CHECKED compare-and-set. Two consequences:
  bounding the window is only safe because the SQL `order by` is the key `rankClaimable` sorts by
  (change one, change the other, or a claim silently prefers the wrong record), and a selective
  pattern pages to the next window rather than truncating. `take` at 40k: 183ms → 18.4ms; empty
  takes 67/166 → 2/4. Pinned by `claimFairnessSuites`, which fails on Postgres without the fix — run
  `scripts/pg-conformance.sh` before trusting a change to the claim path.
  A loose end here was later RESOLVED THE OTHER WAY, and the sequence matters because the first
  measurement misled. `idx_runtime_claim` has the wrong column order for the claim sort and is
  partial on a predicate the candidate query widens, so it cannot serve the window's `order by`. A
  correctly-ordered index measured as no change at the time (58.8 vs 60.2ms at 40k) and this entry
  said "don't add it" — wrong, because that claim's cost was dominated elsewhere. Added later as
  `idx_runtime_claim_order`: **19.5ms → 0.8ms**. Keep BOTH: the new one serves the claim window, the
  old one is still chosen for `envelopesInState`/diagnostics (verified with `explain query plan`).
  Note `effective_priority` is uniformly 0 until the scheduler lands (M3), which is why the two
  orderings look identical today.
- **SSE watch streams detect client disconnect via the response stream's `cancel()`, not
  `req.signal`.** Under `Deno.serve`'s legacy semantics, `request.signal` aborts on a *fully
  delivered response*, not only on client disconnect. Using it to gate a long-lived SSE loop
  risks a false teardown, and merely reading it emits a deprecation warning
  (`--unstable-no-legacy-abort`). `handleWatchEvents` instead sets a `closed` flag in the
  `ReadableStream`'s `cancel()` callback (Deno invokes it when the client goes away) and races
  the keepalive wait against a wake promise so disconnect cleanup is prompt. Don't reintroduce
  `req.signal` here.
- **`take` also ranks EXPIRED-lease records as candidates, so repeated pattern takes re-claim the
  same record.** Bit two test setups in a row: seven puts followed by seven `take({pattern})` with
  a lapsed lease leaves ONE stranded record (each take reclaims the previous one, bumping its
  attempt) and six still available, not seven stuck leases. To strand N records, take them BY ID.
  This is correct behaviour (reclaiming lapsed work is what take is for), but it makes "claim
  several, let them expire" a trap when building fixtures.
- **A selector on `state: available` must exclude reference kinds.** `claimable:false` records (the
  kind registry, grants, `agent_run`s, plain facts) sit available forever by design, so the first
  selector-driven remediation swept the space's own control records into `dead_letter` with
  `dead-letter --all --stale 0`. Caught by running the CLI verb against a real space, not by reading
  it. `dead_letter` stays unfiltered, so a reference record that lands there is still requeueable.
- **There is no `expired` record STATE.** A lapsed lease leaves the record `leased`; a later take
  reclaims it. `RecordState` carried an `expired` member nothing ever wrote, and
  `?state=expired` answered zero rows — a confident nothing beside hundreds of lapsed leases, which
  is how a reader concludes the report is broken. It is gone from the union and both OpenAPI enums,
  and the endpoint 400s naming the query that works: expiry is a PREDICATE
  (`state=leased&expired=1`). Diagnostics reports `stuckLeases` with `atLeast` when its scan hit the
  cap, because a bounded scan must not present itself as a census. (`take.ts` has its own
  `how: "available" | "expired"`, describing how a candidate was reached, not a state.)
- **Lease settlement is owner-bound, not fenced alone.** `ack` (and the other settle verbs, via the
  threaded principal) reject a non-operator principal that doesn't own the lease (`lease_owner`)
  with `lease_lost`, on top of the `leaseId`+`epoch` fencing. This closes lease-leak impersonation, which
  matters because an ack-emitted result is authorized as, and carries the delegation chain of, the
  lease owner. In-process/operator callers (no principal / privileged) skip the check.
- **The guarded UPDATE is the fence, so check its affected-row count, and fence BEFORE writing.**
  The settle verbs selected the envelope without `FOR UPDATE`, validated the lease in application
  code, then ran `update … and lease_id = $ and lease_epoch = $` without inspecting how many rows it
  touched. Under pooled Postgres at READ COMMITTED another connection can reclaim the lease in that
  gap, so the guard matched nothing and the transaction still committed `{status: "ok"}`: a
  quarantined run landing one final result despite the epoch bump meant to fence it out. All four
  verbs in both adapters check the count and return `lease_lost` on zero, and `ack` was REORDERED so
  the guarded update precedes the result insert — the fence is an early return, not a rollback. The
  new branch is unreachable on the embedded adapters (single connection, and the update's `WHERE` is
  a subset of what `leaseValid` checked), so a conformance case there would assert nothing;
  exercising the race is fault-matrix work against a live Postgres. See
  [plan-validation.md](plan-validation.md).
- **A stream opened with a raw `fetch` inherits none of the client's headers, and the failure is
  quiet.** The TS `watch()` built its SSE connect by hand, so it sent no `Authorization`: every
  connect 401'd under `--auth required` and `agentLoop` fell back to polling — slow rather than
  broken, which is why it survived. Anything that bypasses the client's own request helper has to
  re-add what that helper was doing. Same file, same shape: a watch id is server MEMORY, so a
  restart 404s it permanently and retrying is the one failure that never heals; both SDKs re-create
  the watch on a 404 (`conformance/loop.test.ts`).
- **A heartbeat that discards its result is a worker that never learns it was fenced.** `renew`
  reports fencing as a `{status: "lease_lost"}` BODY, so `renew(...).catch(() => {})` ignored exactly
  the case it existed to detect: a reclaimed worker renewed a dead lease for the life of the process
  while its handler kept making side effects. All three heartbeats (`sdk/ts/loop.ts`,
  `sdk/py/radia.py`, `src/surfaces/mcp/server.ts`) act on it and cancel the handler. Three rules:
  **the fence has two faces**, `lease_lost` AND 401/403, since quarantining a run kills its token
  first so its heartbeat never sees `lease_lost`; **everything else stays ignored**, because a
  network blip is not a fence; and **a claim known to be lost is not settled**, since the ack would
  only be answered `lease_lost` and a nack risks bumping the next owner's attempt count. The same
  investigation found only `403` was permanent for a watcher, so a stopped run's watchers retried a
  `401` connect forever and `agentLoop`, which awaits them, could never finish. Watchers run on the
  credential's signal now.
- **A column that exists is not a behaviour that happens.** `claim_until` and `effective_priority`
  are written as `undefined`/`0` everywhere and consulted nowhere, so "no new claims after this
  time" and "aged by sweeper" described nothing (same for `retention_until`; `schema_version` is a
  constant). The schema, indexes and ranking code are all real, which is what makes it convincing:
  `take` genuinely orders by `effective_priority` and therefore always falls through to the next
  tiebreak. Before planning against a documented field, grep for a WRITE of a non-default value —
  scaffolding for a later milestone looks identical to a live feature from the schema alone.
- **A worker handler must ANSWER a permanent failure, never throw it.** `agentLoop` nacks a throwing
  handler and the record becomes claimable again (`sdk/ts/loop.ts`), which is right for a transient
  fault and exactly wrong for one that cannot succeed on retry. A shredded file in a workspace made
  `materialize` throw, so `run_python {workspace}` re-failed in a loop until the CLIENT's tool
  deadline and the user saw `timed out waiting for 'run_python'` with no reason given. Returning a
  `tool_result` turned a two-minute hang into a one-line explanation in about a second. Ask of every
  throw in a handler: can a retry possibly help? If not, it is a result.
- **Graceful stop ≠ quarantine.** A lease is owned by the claiming principal (`take` threads it
  into `lease_owner`; a run token → `run:*`). `stopRun` (default) only stops the token resolving:
  the run's in-flight leases expire on their own clocks, NOT immediately. `stopRun({quarantine:true})`
  is the emergency path: `quarantineLeasesOf` force-releases them now with an **epoch bump**, so a
  late `ack`/`renew` fences out as `lease_lost` (that bump is essential; without it the stale
  holder could still settle). Don't assume a plain stop kills live leases.
- **Stale-available diagnostics count only `claimable` kinds; reference records are not "stuck".**
  A record sitting `available` isn't necessarily starved work. Reference kinds (`claimable:false`:
  facts, config, `grant`/`kind_def`/`agent_*`, conversation history) are written once and read by
  `query`, never `take`n, so they sit available forever by design. `Space.diagnostics` excludes
  them (`excludeKinds`, filtered in the adapter query *before* the 500 sample cap, so a real starved
  `task` is never crowded out by hundreds of `message`/`capability` records). Reserved control kinds
  default `claimable:false`; user reference kinds must declare it. Don't "fix" a large
  stale-available count by raising the threshold; check the kinds are marked reference.
- **A guard placed "before storage" is placed before IDEMPOTENCY, and that is the invariant it
  breaks.** The owner-match check for settle verbs sat in `Space`, ahead of the adapter call, on the
  argument that `lease_owner` is never cleared on settle so an owner's retry still matches. True,
  and it misses REASSIGNMENT: A nacks, the response is lost, B claims the record, A retries its
  idempotency key and is told `lease_lost` for an operation that already succeeded. The check rides
  on `LeaseRef.expectOwner` now, so the adapter applies it inside the settle's transaction after
  `withIdem` has replayed. Two things fell out worth keeping: `renew`/`nack`/`release` stopped
  pre-reading the envelope entirely, and `ack` (which genuinely needs the owner, to authorize the
  result it emits) skips that authorization on a mismatch, because authorizing a stranger's ack as
  the OWNER would tell them what that principal may write.
- **Idempotency is checked before lease validation, and the order matters.**
  `ack` commits, the HTTP response is lost, the agent retries; the task is now consumed
  and the lease invalid. Validating the lease first would falsely return `lease_lost` for
  a succeeded operation. See [design-api.md](design-api.md).
- **Concurrent same-key writes race on the idempotency insert; pooled Postgres exposed what
  single-connection embedded hid.** `withIdem` (`src/storage/pgbase.ts`) does SELECT-then-effect-
  then-INSERT. On single-connection PGlite/SQLite these serialize, so a duplicate key always hits
  the SELECT and replays. On the **pooled** Postgres adapter, N requests with the same
  `(principal, operation, key)` run on different connections, all SELECT empty, and only one can
  INSERT. The rest hit a unique-violation that aborts the whole transaction (a real 500 the SDK
  saw as unparseable text). Fix: the INSERT is `ON CONFLICT DO NOTHING`; a loser (0 rows) throws
  an internal `IdempotencyReplay`, which rolls its attempt back (discarding its effect, since the
  record insert used a fresh id) and `withRetry` re-runs so the SELECT now replays the winner's
  stored response. The effect is non-idempotent on its own (fresh ULID per call); the idempotency
  row is the single-winner gate. This bit the chat example: three inference workers share one run
  principal and each publishes the same content-keyed `capability:escalate` at startup.
- **The watch/event cursor is the inserting `xid` (opaque), not the `seq`. Do not "simplify" it
  back to seq.** `events.seq` (identity) is assigned at insert but transactions on the pooled
  Postgres adapter commit out of seq order, so a watcher consuming `seq > cursor` skips a low-seq
  event that commits after a higher one it already passed, giving silent dropped deliveries (felt as
  chat slowness via the poll fallback). `getEvents` orders by `xid` under the watermark
  `xid < pg_snapshot_xmin(pg_current_snapshot())`; `SpaceEvent.cursor` is an opaque string (seq on
  embedded, xid on pg) that the transport only echoes. See
  [design-storage.md](design-storage.md) "Watch delivery under concurrency".
- **At-least-once means external side effects can duplicate.** The space protects its own
  state atomically, not your emails. Side-effecting agents need idempotency at the effect
  boundary, an outbox, or the (candidate) transactional tool gateway. This is the
  contract, not a bug.
- **Physical execution overlaps lease expiry.** A fenced worker keeps running until it
  observes `lease_lost`. "At most one valid lease" is not "at most one running process".
- **`take(record_id=...)` is a selector, not a bypass.** The server re-verifies pattern,
  grants, admission, availability, and `claim_until` every time.

### Storage, SQL and the planner

- **The events table needs `idx_events_xid_seq`, or the seal walk seq-scans the whole log**
  (`src/storage/pgbase.ts`). `sealableEvents` (verify's per-page fetch and the seal-first pass)
  asks for the next N events in (xid, seq) order; the PK is on `seq` alone, so without this index
  Postgres parallel-seq-scans every row and top-N sorts to return 500. Measured at 20M events
  (bench/README log-axis run): window query 2005ms, `radia integrity` 14.4s, both O(log size);
  with the index 0.19ms and 0.32s. On-demand sealing hides this from any write workload — it only
  bites the operator path (doctor/integrity/console Overview), which is why a pure-fill benchmark
  never saw it. SQLite orders the walk by its `seq` PK already; Postgres half only.
- **`appendSeals` batches, and the batch must land a CONTIGUOUS PREFIX, not just the rows that
  won** (`src/storage/pgbase.ts`). One INSERT per link cost ~650ms to seal a 500-link batch on
  Postgres, and sealing runs INSIDE reads (`verifyIntegrity` seals first; diagnostics spot-checks),
  so every `radia doctor` poll on a backlogged space paid it — diagnostics ~650ms → ~80ms once
  batched. The trap in batching: two concurrent sealers compute identical rows, so `on conflict do
  nothing` may let this call win positions on BOTH sides of a rival's row. The caller re-reads the
  head at the returned prefix length and continues, so a win past the gap becomes a hole nobody
  revisits. The multi-row insert returns the won idxs, and anything beyond the first conflict is
  DELETED before returning the prefix. SQLite is single-connection and kept its row-at-a-time loop.
  Guard: `conformance/suites/integrity.ts` "appendSeals lands a contiguous prefix".
- **A sound pre-filter is not a complete one, and the gap is measurable.** What `pushdown.ts`
  cannot express renders as `TRUE`, and the whole kind is then pulled into JS for
  `core/matching.ts` to decide. Measured over HTTP against Postgres (`bench/deployment.ts`): 278ms
  at 25k records, **13.6 seconds at 1M**, tracking the record count exactly. The process is
  single-threaded, so that was 14 seconds in which the space served nobody else. Both halves are
  fixed and both are measured at 5.5M: the budget refuses at a FLAT ~2.5s (4269/3994/4119ms at
  2.1M/3.7M/5.3M under load, so the cost no longer tracks the kind), and the chunked walk's yield
  keeps a neighbour's indexed read at a 48ms worst wait during a 2538ms refused scan.
  Every pushable predicate stays flat over the same range, so the ONLY way to see this is a
  benchmark whose predicate is not pushable, which none of the in-process suites had.
  `$any` was that predicate until it was pushed (a type-guarded `EXISTS` over the elements, exact,
  so the LIMIT rides with it); `$each` is what still measures the wall, and a new unpushable node
  joins it silently unless a bench row keeps the path measured.
- **The scan is chunked because the budget alone would not have fixed the outage.** A read whose
  pre-filter is inexact walks the kind in chunks of 1000 (`scanChunkSize`) and yields between them,
  raising `429 scan_budget_exceeded` past `maxScanRows` (200k). Two traps in that sentence, both
  measured. The yield must be `setImmediate`, not `setTimeout(0)` (2.2ms per yield against 0.013ms,
  which was 353ms of scan against 184ms) and certainly not a microtask, which drains in the same
  turn and yields to nobody: without a real yield a neighbour's indexed read waited 138ms, the whole
  scan. And the budget is checked AFTER the early exit, not before, or a read that finished inside
  its first chunk gets refused for the size of the chunk it was handed.

- **An ORDER BY can defeat the index that would have served the filter, and a partial index is
  unusable when its predicate column is a bound parameter.** Both bit the credential lookup, and
  neither is visible without `explain query plan`. `where kind=? and <expr>=? order by id desc
  limit 1` walks the whole kind in id order; a partial index over the credential kinds is never
  chosen either, because SQLite cannot prove a bound `kind` satisfies the predicate. What works puts
  kind in the index KEY: `(kind, json_extract(body_json,'$.tokenHash'))`, matching `SqliteJson.at`
  character for character. 3000 credential records: 1.23ms → 0.05ms, flat to 12k. Postgres needs
  none of it (GIN over `body_jsonb` serves every path), so this is the schema's only per-path index.
- **A pushed LIMIT is worth nothing if the plan sorts first, and on SQLite the primary key does not
  prevent that.** `where kind = ? … order by id limit N` plans as USE TEMP B-TREE FOR ORDER BY: the
  whole kind is read and sorted, so an exact filter's pushed limit saves nothing and `read_one`
  grows linearly with the space (12.0ms at 40k records, a predicate matching 1 in 7).
  `idx_records_kind_id (kind, id)` makes it an ordered seek that stops at the Nth match: 0.05ms,
  flat. Postgres carries `idx_records_id_c` for a different reason (byte-order ids), which is what
  hid the gap. `explain query plan` is the only way to see it; a benchmark shows it as a shape.
- **GC's guards each have exactly one row where they bite, and a test that misses it tests
  nothing.** Found by planting, three times in one sitting (`conformance/suites/gc.ts`). The lease
  floor tests `lease_id`, not `leased_until`: settling clears the id and leaves the timestamp, so
  testing time alone embargoes every freshly-acked record for a lease-length. Its observable case is
  a LEASED REFERENCE record (`claimable` is a hint, so take-by-id works on reference kinds); on work
  records the state guard masks it. The reserved-kind exclusion only bites on a CONSUMED artifact
  (an available one is saved by the state guard first). And `NEVER_COMPACT` only bites when a
  contentKey IS declared on a protected kind, which in-process registration allows — so the test
  declares one on `agent_definition` and proves the exclusion holds anyway. A swept record also
  cannot parent NEW work (`parent_not_found`): retention is the writer's promise nothing will
  reference the record later, pinned in the suite.
- **`record_edges` is a DERIVED index; `parent_ids` stays the source of truth.** `childrenOf` was a
  `LIKE` scan over the JSON text: 87µs at 1k records → 662µs at 20k for the same five children. It
  is a `(parent_id, child_id)` lookup now, flat at ~32µs. Three things keep the derivation honest:
  the edge is written in the record's OWN transaction; EVERY insert path writes it, ack-with-result
  included (pinned by a conformance case, since a reverse index only `put` maintained looks correct
  in every hand test); and a one-time backfill rebuilds it for databases written by older builds.
  Covered by `conformance/backfill.test.ts`, which needs a PERSISTENT database: `init()` on
  `:memory:` opens a new empty one, so the first draft "survived a restart" by finding nothing.
- **A graph walk should batch by LEVEL, but the reason it got faster may not be the batching.**
  `getLineage` fetches a depth level per `getRecords` call: 0.224ms vs 0.651ms at depth 64 in a 20k
  space. The benchmark's lineage is a chain, one node per level, so batching saved no round trips
  there at all — the first batched version was SLOWER (1.247ms vs 0.780ms) because SQLite rebuilt
  its SQL text per id count and re-parsed every level. Caching the prepared statement by placeholder
  count is what won. Check what a speedup actually came from before attributing it.
- **Fan-out needs a bound even when the caller has one.** `childrenOf` returned every child: fine as
  an unused `LIKE` scan, a materialize-the-subtree once it became an indexed lookup people walk. Two
  limits, because they bound different things: the endpoint keyset-pages over child id, and the
  graph walk bounds children PER NODE (`maxNodes` bounds what the picture SHOWS, not what the walk
  reads). A client-side `.slice()` is not a bound — the rows are already fetched.
- **A NUL is invisible in source and lethal in Postgres.** `grantKey` joined parts with `\0`, fine
  as an in-memory Map key, `invalid byte sequence for encoding "UTF8": 0x00` once that key became an
  idempotency key. Encode composite keys (`JSON.stringify([...])`) rather than joining on a
  separator no value can contain. Note `grep -P "\x00"` will not find these: grep suppresses binary
  matches.
- **A queue is paged by KEYSET, never by OFFSET, and a CAS guards everything the read relied on.**
  Both are the same mistake seen twice: assuming the rows you already looked at are still there. An
  offset window assumes the rows BEFORE the cursor stay put, and in a queue those are exactly the
  rows other claimers are removing, so each departure shifts the rest forward and the next window
  skips them — `take` answering "nothing claimable" over a kind with work in it. And the
  available-branch claim guarded only `state='available'`, so a record nacked into a backoff between
  the read and the update was claimed anyway, under a stale epoch. Both adapters now page on the
  claim order's own key (`ClaimCursor`, shared in `src/core/take.ts` so they cannot drift) and guard
  on state, `available_at` and the epoch that was read. Neither is reachable on a single connection,
  which is why both survived the embedded suites; staging them wants the fault matrix.
- **The claim index must be ordered like the claim, and `state` must not lead it.** The candidate
  window sorts by `effective_priority desc, available_at asc, record_id asc`; an index only serves
  that if its columns are in that order. `idx_runtime_claim` is not (it leads with `available_at`)
  and is also partial on `state = 'available'` while the window needs `'leased'` too, for expired-
  lease reclaim, so it never applied. The subtle part is the fix that does NOT work: an index
  leading `(kind, state, …)` satisfies `state in ('available','leased')` but sorts only WITHIN each
  state value, so the database still sorts the whole set. Measured, that version changed a claim by
  1.4ms, indistinguishable from noise, which is why the first attempt looked like "the sort was
  never the problem". `idx_runtime_claim_order`, with the sort columns immediately after `kind` and
  no `state`, took a claim at 40k records from **19.5ms to 0.8ms** on SQLite by turning a full scan
  of the envelope table into an ordered seek that stops when the window is full.
- **A claim on Postgres is planned on a guess, and the guess is wrong by 200×.** Where SQLite does
  an ordered seek, Postgres collected EVERY matching record through the body index (5,715 of
  40,000), joined each to its envelope and sorted, because it estimates the jsonb predicate at 26
  rows and concludes the sort is free. No query rewrite fixes it (`join` vs `exists`, with or
  without `@>`, all plan the same; `enable_seqscan`/`enable_bitmapscan` off makes it *worse* at
  28.6ms). The fix is a real ESTIMATE: `PgSqlAdapter.prepareKind` creates
  `create statistics … on ((body_jsonb #> '{path}')) from records` per declared path, via the
  optional `StorageAdapter.prepareKind` hook. Cost is ANALYZE time, not write time. Measured on a
  real `take` over 20k records: **9.75ms → 3.37ms p50**, the plan changing from sorting 9,168
  buffers to an ordered walk over 1,364. Four things are easy to get wrong:
  * **ANALYZE `record_runtime` as well as `records`.** A claim JOINS the two, and with no statistics
    on the envelope table the join estimate collapses however good the body estimate is. The
    isolated window query measured 48ms with neither analyzed, 11ms with the envelope table
    analyzed, 1.0ms with the expression statistics on top.
  * **The two pushed terms are redundant AND correlated, and the planner multiplies them.**
    Pushdown emits `@>` (what GIN answers) AND `#> = ` (what makes the filter exact). For a value
    matching 2,858 of 20,000 rows: `@>` alone estimates 2,858, `#>` alone 100 without statistics and
    2,858 with, the two ANDed **14 without and 408 with**, because the planner assumes independence.
    The residual 7× underestimate is structural, and neither term can be dropped: one is the index,
    the other is the exactness that lets a LIMIT be pushed.
  * **The statistics expression must match `PgJson.at` character for character**, and the path is
    inlined into DDL, so `prepareKind` skips any path pushdown declines rather than escaping it. It
    calls `pushablePath` outright now: it carried its own copy of the alphabet rule, and the two
    drifted the moment digit segments stopped being pushable.
  * **`pg_statistic_ext` is server-wide; a statistics object is not.** The "already created?" check
    asked by NAME only, so the first space to declare a path claimed that name for the entire
    server and every other space in its own schema ran on the planner's guess forever, silently and
    permanently. It is scoped by `stxnamespace = current_schema()::regnamespace` now. Pinned in
    `planner.test.ts`; the conformance harness hits this on every run, since it shares one PGlite
    across per-test schemas.
  A fresh space declares its kinds before it has rows, so that ANALYZE measures an empty table and
  the estimate becomes real at the next autoanalyze: a brand new space planning a claim badly for a
  while is not a bug. Also: an unfiltered first window (try the head of the queue, fall back to the
  filtered query) was built and **reverted** — it only wins when the head holds a match, and every
  measured cell got worse (sqlite 1.0 → 1.3ms, Postgres 22.7 → 28.6ms).
  A COROLLARY that bit a benchmark (2026-08-11): the statistics are created by `prepareKind`, which
  only the DURABLE declaration path calls, never the synchronous `registerKind`. Declared with
  `registerKind`, a Postgres `take` measured 23.6ms and "grew with the space"; the same kind
  declared as a `kind_def` record was 10.5ms and flat. A test or bench that uses `registerKind`
  measures a plan no real client gets. `bench/suites/scale.ts` declares durably for this reason.
- **The Postgres driver needs TCP_NODELAY or every parameterized query costs ~40ms.** deno-postgres
  (0.19.x) does not set `TCP_NODELAY`, so its extended-protocol (parameterized) queries send several
  small packets and hit Nagle + delayed-ACK, measured at **42ms per query vs 0.18ms** with NODELAY, a
  230× hit that made pg-backed chat feel broken (a put+take+ack cycle went 602ms → 10ms). Simple
  (unparameterized) queries don't show it, so it hides in microbenchmarks. The driver connects via
  `Deno.connect` and exposes no socket option, so `src/storage/postgres.ts` enables NODELAY by
  wrapping `Deno.connect` once (only raw TCP connects are affected; `fetch`/`Deno.serve` use a
  different path). Remove the wrapper if deno-postgres starts setting it. Not docker-specific;
  reproduced identically via the published port and the container IP.

### Credentials, tokens and sessions

- **Renewal is a LIVENESS protocol, so it only serves holders that are alive.** `renewRun` extends a
  token by presenting it before expiry, which needs a process awake and scheduled inside the window.
  That excludes a laptop that slept through it (an expired token cannot renew itself), a fresh CLI
  process, a closed browser tab, and anything that only replays a stored secret. The fix was already
  built and unused: an `agent_definition` has no expiry, `POST /v0/agent-runs` mints a run from it,
  and the space REFUSES that token for coordination, so the durable half cannot act. Hold both,
  exchange on expiry. Renew where lease ownership must survive (exchange changes the `run:`
  principal, so in-flight claims fence out); exchange everywhere else.
- **A retry wrapper must not wrap the retry.** Routing the credential exchange through the same
  `req` that triggers it made a FAILING exchange re-enter the wrapper, await the in-flight exchange
  it was already inside, and deadlock: a revoked definition hung the caller instead of reporting
  itself. The exchange uses a raw request with no retry. Found by the test, not by reading.
- **`radia dev` writes the credential file only after the bind, and its shutdown clear names its
  own token** (`src/main.ts`; `clearCredential(base, onlyIfToken)` in `src/credentials.ts`). A
  second dev losing the port race otherwise overwrites the running space's operator entry at
  startup and deletes it in its `finally`, so every CLI verb against the healthy space gets
  `auth_required`. Guard: `conformance/defaults.test.ts` "losing a port race".
- **One credential file, two identities.** `radia dev` provisions an OPERATOR credential per space
  and `radia login` authenticates a PERSON against the same space. Keyed by base URL alone the
  second silently replaces the first, and the CLI's remediation verbs, the chat's bootstrap and the
  MCP adapter all start acting as whoever logged in last. Logins live under their own suffix; the
  operator entry is never touched. Caught one edit before it shipped, and guarded by
  `conformance/exchange.test.ts`.
- **"Public route" means no credential is REQUIRED, not that a bad one is ignored.** `GET /` and
  `GET /v0/health` skip authentication so the console can bootstrap under `--auth required`. The
  skip covered every credential error, so an expired or garbage token got
  `200 {principal: "anonymous"}` from the one endpoint a client uses to ask whether its token still
  works. Only `auth_required` (nothing presented) is exempt now; every other resolution failure is a
  401 on public routes too.
- **Cache what cannot change; never cache what can be revoked.** Credentials looked like a registry
  and were built as one, but a registry cache trades away freshness, which is the whole content of a
  credential. Two silent fail-opens followed: a bounded startup rebuild left a STOPPED run's token
  resolving after a restart, and `stopRun` consulted the cache first, so stopping a run it had not
  seen returned `applied: false` and did nothing. `Space.resolveToken` reads records per request;
  `CredentialStore` (`src/core/auth.ts`) keeps only operator tokens and the immutable run→agent memo.
  If it can be withdrawn, it must be discovered.
- **The credential index was rebuilt from a bounded page too, and the fix was to delete the index,
  not widen the page.** `loadCredentials` read the OLDEST 5000 `agent_definition`/`agent_run`
  records, both of which accumulate, so a busy space held only ancient history: at 5202 run records,
  a STOPPED run's token still resolved after a restart. The cache is gone (see "cache what cannot
  change"). Kept as history because its justification, "credentials are a registry like kinds", is
  the reasoning to distrust next time. One consequence outlived it: `runsForAgent` answered "which
  principals count as me" from the cache, but that question wants HISTORY, not live credentials. It
  is `Space.runPrincipalsOf` now, querying `agent_run` by `agent`.
- **`created_by` and idempotency scope are the RESOLVED caller, threaded from the handler, not
  `ctx.principal`.** `put`/`ack`/settle take an optional trailing `principal`; the handlers pass the
  resolved caller, so `created_by` is the token's principal (or `human:local` for no-auth), the
  event `run_id` follows it, and idempotency keys are scoped **per principal** (two agents reusing
  the same `Idempotency-Key` don't collide; that was a real bug). It defaults to the space's own
  identity, so **in-process callers** (conformance, `demo.ts`) omit it → `created_by = local:dev`,
  which is why those tests still pin `local:dev` while the handler tests pin the caller. Grant
  *enforcement* still lives at the HTTP boundary (`Space` verbs don't call `authorize` themselves),
  so in-process callers bypass enforcement and exercise `authorize`/`bodyMatchesGrant` directly.
- **Default principal is the operator, so dev stays open; enforcement only bites a real token.**
  An unauthenticated request resolves to `human:local` (privileged), so the UI, demo, and examples
  work with no auth. To act as a scoped principal you must mint a real run token via the bootstrap
  chain; there is **no impersonation shortcut** (the old dev-only `X-Radia-Principal` assume-header
  was removed, because a client must never choose its own identity, so a single Bearer channel is
  the whole story).
- **`--auth` defaults to REQUIRED, and the loopback bind is the second layer, not the first.**
  No bearer → `401 auth_required` (`ServerOptions.authRequired`). `--auth open` opts back into the
  no-header operator shortcut, which is only ever safe locally. `radia dev` also binds `127.0.0.1`
  by default; `--host 0.0.0.0` is an explicit opt-in to expose it. `GET /` and `GET /v0/health`
  stay public in both modes so the console can bootstrap and a client can tell "no space here" from
  "not allowed"; neither carries a credential, and neither may (see the operator-token bullet).
- **The operator token is a server-lifetime in-memory credential, not a record, and it never
  travels in the served page.** `Space.mintOperatorToken` registers a hash resolving to the
  privileged `human:local`; it never expires and is not persisted. It is the one credential that
  legitimately lives in memory: it cannot be revoked because it cannot outlive the process. **Never
  bake it into `index.html`** — `GET /` is public so the console can bootstrap, so an embedded token
  is readable by anyone who can reach the port. The console prompts and keeps it in `sessionStorage`;
  `conformance/console.test.ts` fails if a credential-shaped literal or a substitution placeholder
  reappears. The substitution machinery is gone rather than disabled, so there is no option to pass
  that reinstates it.
- **The operator token resolves as `kind: "operator"`, never `"def"`.** Resolving it to something
  that 401s breaks the CLI, MCP and `curl`; resolving it as a DEFINITION token breaks the other way,
  since definition tokens mint runs, so a leaked unrevocable credential would convert into a
  long-lived run token. It authorizes everything and mints nothing: a distinct `ResolvedToken`
  variant (`src/core/auth.ts`), accepted by `resolveAuth` beside `run` and refused by `mintRun`, so
  the escalation is closed at the source rather than at each caller (`conformance/http.test.ts`).
- **The open-mode no-header shortcut is for `curl`, and nothing radia ships may rely on it.** No
  credential resolves to `human:local`, the operator: the largest authority a space has, acquired by
  nobody having typed anything. The console and the chat both silently ran privileged; both refuse
  to start without a token now, the shortcut sits behind an explicit `--auth open`, and the examples
  read the provisioned operator credential (`examples/operator.ts`) so they exercise the
  authenticated path they exist to demonstrate.
- **Never let a launch flag pick between "scoped" and "operator": the privileged posture becomes the
  default.** The chat once took a role setting that defaulted to operator, so it ran privileged
  unless you knew to say otherwise, and the flag described how the process was started rather than
  who was using it. Authority is a property of the CREDENTIAL: the session is whoever the supplied
  token belongs to, and whether that reaches the ops plane follows from the grants that principal
  holds.
- **Short run tokens need a RENEWAL path, or every long-running process dies mid-task.** 15 minutes
  is right for a leaked credential and wrong for a session someone is sitting in front of: the chat
  crashed with an uncaught `token_expired` from whichever write happened to be next, and the whole
  worker fleet had the same fuse with a quieter symptom (a worker whose token lapsed stopped
  claiming and said nothing, so the chat waited on a result nobody was coming to produce). Renewal
  is a successor `agent_run` with the SAME tokenHash, the shape `stopRun` already used, so
  resolution finds it in the one indexed lookup it already does. The three bounds are the design:
  a stopped run cannot be revived (revocation wins), renewal never passes
  `mintedAt + runMaxLifetimeSeconds`, and an expired token cannot renew itself. That last one is why
  clients renew at HALF-LIFE (`RadiaClient.keepAlive`): waiting for a 401 means the session is
  already gone.
- **Credential keep-alive belongs in `agentLoop`, not in each agent.** Every process running that
  loop is long-lived by definition, and the five chat workers each needed it. One place, and an
  external agent author gets it without knowing it exists.
- **A public endpoint still rejects a BAD credential, so `401` never means "the space is down".**
  `/v0/health` and `GET /` skip the auth requirement, but `resolveAuth` rejects a presented token
  that does not resolve, on every path. So an expired run token `401`s on the one endpoint a client
  uses to prove the space is up, and the console read that as `offline`: it named the wrong thing
  and, because the sign-in screen only appeared when NO token was set, left the tab dead until
  someone cleared `sessionStorage` by hand. Any client polling health has to separate `401`
  (credential) from unreachable (space), and run tokens expire in ~15 minutes, so this is the
  ordinary end of a session rather than an edge case.
- **The provisioned credential is keyed by HOST, so `localhost` and `127.0.0.1` are two spaces.**
  `baseKey` (`src/credentials.ts`) keys on `protocol//host`, and `radia dev` binds `127.0.0.1`, so
  anything defaulting to `http://localhost:7788` finds no credential for a space it can otherwise
  reach. Two examples and the TS SDK defaulted to `localhost` and started failing the moment auth
  became required. Every default now agrees on `127.0.0.1`. The aliasing was NOT fixed in
  `baseKey`: two names for one host is exactly the kind of helpful normalization that surprises
  someone later, and the error message names the trap instead.
- **Two branches of one function, one checking its credential's status and one not.**
  `resolveCredential` checked `agent_run` for `status`/`expiresAt`, then returned `{ok: true}` for
  `agent_definition` on the mere EXISTENCE of a record. So "credentials resolve from records per
  request, so revocation is immediate" held for every credential except the one that never expires,
  and a leaked definition token minted runs forever. Fixed with the run's own shape: a successor
  carrying the SAME `tokenHash`, so revocation lands in the indexed lookup authentication already
  does. **When two things in one function are the same KIND of thing, read them side by side** — the
  asymmetry sat two lines apart for a milestone.
- **A credential that mints authority must not be able to name a privileged subject.** A definition
  mints runs for its subject, so `createAgentDefinition("human:root")` on a space whose operators
  include it was a permanent way to mint privileged runs — and until revocation existed, a permanent
  one. Refused at mint. The general rule: wherever a factory takes a principal, check it against the
  identities whose authority is NOT expressed as grants, because nothing downstream narrows those.
- **Revoke and stop are different decisions and must stay separate verbs.** Revoking a definition
  leaves already-minted runs alive on purpose: conflating them would make "stop handing out new
  authority" also mean "kill the work in flight", which have different blast radii and belong to
  different moments in an incident. Revoke first, then stop the runs that matter.
- **Privilege is a NAMED SET, not a name prefix, and `human:` is a namespace.** `isPrivileged`
  (`src/core/space.ts`) checks `ctx.operators` (default `["human:local"]`) and the
  space's own identity — the supervisor is NOT in it (demoted, architecture-ops-tiers.md phase 5: it keeps
  exactly `grant`/`signal` puts as a carve-out in `authorize` and is otherwise ordinary, which is
  also what made it mintable). It used to treat every `human:*` as an operator, which meant a space could
  not have ordinary people on it: a definition principal had to be `agent:`, so the only human
  credential obtainable was god-mode, and a console holding one held everything. `radia login
  human:alice` and the console's Auth tab depend on this being a set. Two consequences that read as
  bugs if the old rule is assumed: a logged-in `human:alice` is refused a `grant`/`signal`/`agent_*`
  write like any other principal, and a run token whose subject is a human is still just a scoped
  session.
- **Ask the space who a credential belongs to; never infer it from the fact that one exists.**
  `GET /v0/health` reports the CREDENTIAL (`run:…`); `GET /v0/ops/permissions` reports its subject
  and whether it is privileged, and any principal may ask about itself. The console labelled itself
  "operator token" whenever a token was set, so a scoped session displayed authority it did not
  have; the chat resolves the login token's owner this way rather than trusting a body field. This
  is the same promise-vs-enforcement gap behind every grant defect here, which is why the canonical
  form (`Space.effectivePermissions`) exists at all.
- **A presented `Authorization: Bearer` token must resolve; a bad one is 401, never a silent
  fall-through to the operator.** Only the *absence* of any credential defaults to `human:local`;
  `resolveAuth` in `src/server/http.ts` encodes it (Bearer → run principal, else operator).
  `POST /v0/agent-runs` is special: it reads its DEFINITION token directly (a def
  token is not a coordination principal, so `resolveAuth` returns `invalid_token` for it), which
  is why that route is dispatched **before** the bad-bearer 401 check.
- **Only token HASHES are stored, and the records are the authority on every request.**
  Run/definition tokens are secrets returned once at mint; the `agent_definition`/`agent_run` record
  bodies hold the sha256 hash (not a secret). `Space.resolveToken` reads the newest record for that
  hash per authenticated request; there is no credential cache to miss, go stale, or replay at
  startup. A run's status change (stop) is a **successor** `agent_run` record (records are
  immutable) carrying the SAME `tokenHash`, so the one indexed lookup that finds the mint finds the
  stop instead. The lookup path is guarded by a token-shape regex so garbage tokens don't reach the
  query at all. Token expiry
  uses the **DB clock** (fetched only when a token is actually presented, so the no-auth path stays free).

### Grants, scopes and narrowed answers

- **A delegated run can never exceed its CALLER, so a worker capability cannot be delegated**
  (`intersectGrants`, src/core/space.ts). The authority is `worker INTERSECT caller`, so anything
  the caller deliberately lacks intersects to nothing: exec's `check: put` and `workspace: put`
  stay on its own token because the session holds neither, and moving them to `delegable:` broke
  `save_procedure` outright. Split a worker's grants by READ versus WRITE, not by "session data".
  Guard: conformance/delegation.test.ts "a SUBSET on every axis".
- **Anything that mints an `agent_run` per call grows a table GC never sweeps**
  (`Space.mintDelegatedRun`). Reserved kinds are exempt from the retention sweep and compaction
  only keeps newest-per-`run`, so each distinct run is a permanent row — and `runPrincipalsOf`
  pages an agent's runs to exhaustion on every self-scoped read, refusing rather than narrowing.
  Derive the token from the caller's credential plus what makes the run distinct (the OIDC mint's
  move), so an unchanged one is found by its `tokenHash` and writes nothing. Put anything that can
  CHANGE into the derivation, or reuse would mutate a run whose authority is memoized as immutable.
  Guard: conformance/delegation.test.ts "REUSES its run".
- **A per-caller credential cache keyed only by the CALLER belongs to one worker, not the module**
  (`delegatedClients`, extensions/ts/tool-worker.ts). A module-level map shared by two `serveTools`
  calls in one process hands worker A the delegated client worker B minted — a different worker's
  authority under the same caller, silently. It is per-call now. Evict on lookup too: author runs
  rotate (12h ceiling, a fresh run per login), so a long-lived shared worker otherwise accumulates
  one dead entry per run for as long as it runs.
- **A read-then-write helper needs two credentials, and its name will not tell you**
  (`writeWorkspace`, extensions/ts/workspace.ts). It reads the predecessor AND asks whether the
  tree forked, two separate reads inside one write call; passing only the writing credential
  produced a `forbidden` three frames down in an extension. Both take an optional `reader`
  defaulting to `client`. Grep a function for reads before handing it a narrowed credential.
- **A test harness acting as the OPERATOR is not testing the real path** (smoke-procedures.ts).
  It wrote `tool_call` records as `admin`, so every call had a privileged author; delegation
  refuses those (an operator has no grant set to narrow to) and the whole suite failed at once.
  Write records as the principal production uses.
- **A refusal for an UNDECLARED kind must say so, or a guessing agent reads it as a permissions
  problem** (`Space.noGrant`). Authorization runs before pattern compilation, so a caller naming a
  kind nobody declared is told only "no 'query' grant for kind 'file'" — and goes looking for a
  grant that would never help. Observed live: a session invented `file`, read the refusal as
  missing permission, and burned its next two calls guessing around it. The status and code stay
  403 `forbidden` (wire contract, and it IS still a refusal); only the sentence grows. Say the
  remedy in the SUBSTRATE's vocabulary: the first draft said "list them with `radia kinds`", which
  the reader that hits this cannot run — it is a model holding tools, not a shell — and which is
  `src/core` naming a surface's verb. "Query `kind_def`" is true through every surface. The
  tradeoff taken: kind names become enumerable by probing, which is fine because they are SCHEMA.
  Guard: conformance/delegation.test.ts "a refusal SAYS when the kind does not exist", proved red
  both ways (clause missing, and clause on every kind).
- **A principal acts through TWO run classes, and a query for one silently leaves the other alive**
  (`radia runs --for`). Their own sessions are `agent_run{agent: X}`; runs a worker holds on their
  behalf are `agent_run{actingFor: X}`. The offboarding verb shipped matching only `actingFor`, so
  following the documented runbook left the person chatting for up to the 12h ceiling — proved by
  test, not by reading. And `revoke` closes neither: it stops a definition MINTING (deliberately,
  so a rotation does not kill every worker mid-call) and is a no-op for an SSO identity, which by
  design holds no definition. Offboarding is stop-both-classes, then remove what re-mints.
  Guard: conformance/delegation.test.ts "offboarding needs BOTH run classes".
- **A one-off manual grant to a long-lived principal hides gaps in the standard set**
  (`userGrants`, examples/chat/space/roles.ts). `kind_def:query` was hand-granted to one person
  in August and never added to the set, so `space_kinds` worked for them and 403'd for every
  FRESH identity — first seen when OIDC minted one. Test defaults with a new principal, never an
  accumulated one. Guard: smoke-login.ts "a fresh session can discover kinds".
- **A worker's `progress` record must carry `owner`, or an identity-scoped session cannot see it**
  (`examples/chat/workers/router.ts`). The chat's default scope is `{owner}`, and a grant pattern
  NARROWS rather than errors, so the router's `routing`/`routed` records were filtered out in
  silence: no routing label, no liveness signal to extend the client's deadline, and a timeout that
  reported "no worker claimed this call" for a call the router had claimed in 60ms. Any field a
  scope can bind on is required on every record a scoped reader must see. Guard:
  `smoke-turnlink.ts`, "an identity-scoped session sees 'routed' progress" — and note that suite
  scopes by `conversationId`, the posture under which this bug is invisible, which is why it shipped.
- **A bounded read that decides a SCOPE is not a performance question, it is an authorization one.**
  `runPrincipalsOf` answered "which principals count as me" from 1000 rows, so a long-lived agent's
  OLDEST records fell out of its own self-scoped reads. That list is the allowlist for `take`,
  lineage, graph, artifact bytes and watch wakeups, so truncation makes an agent's own records
  unclaimable and `rankClaimable` skips them indistinguishably from an empty queue. It pages to
  exhaustion via `readRegistry` and throws `registry_incomplete` rather than narrowing. Five client
  reads had the same shape and now route through `RadiaClient.queryAll` / `query_all`, which pages
  newest-first and THROWS instead of returning a prefix. Guarded in `conformance/suites/auth.ts`
  (1201 runs for one agent; its oldest must stay in scope). Where a bound is right, bound by
  RELEVANCE, not page size, and say so at the call site.
- **Every grant read is a bounded page over records that ACCUMULATE, and truncation misauthorizes
  silently.** Re-defining an agent appended a record per grant per boot, and `authorize`/
  `authorizeWatch`/`authorScope`/`opsScope` all read a capped page: at 101 records a granted
  principal was DENIED, at 122 a REVOCATION was invisible and the revoked grant kept working. Grant
  writes are CONTENT-KEYED now (re-defining with unchanged grants writes nothing), reads take the
  NEWEST page, and the bound is generous. Reading newest-first ALONE does not work either: an
  old-but-live grant falls off the other end. No single page direction is correct over a set larger
  than the page.
- **Scoping by AUTHOR does not mean what "my records" means to a user.** The chat's session writes
  `message`/`llm_call`/`tool_call`, but the RESULTS, chunks and artifacts are written by WORKERS
  under their own principals, so `createdBy: self` would hide a session's own tool output and hang
  it waiting for results it cannot read. What works is an application field: the session stamps
  `owner`, workers copy it, the grant binds `{owner}` and enforces it on writes so a session cannot
  stamp another identity. `RADIA_CHAT_SCOPE` picks that or `{conversationId}`. Identity scoping
  separates two PEOPLE only if they are two principals, and `agent:chat-user` is one constant, so
  without `RADIA_CHAT_TOKEN` (a `radia login` session) only `{conversationId}` keeps them apart.
- **Tightening a grant by adding a PATTERN is inert on any space that already had the loose one.**
  Scope and pattern are part of a grant's identity, so declaring `{message, [put,query],
  pattern:{conversationId}}` beside an existing `{message, [put,query]}` creates a SECOND grant, and
  grants union, so the narrower one changes nothing. Tests passed because they start on a fresh
  space; a live session on a two-day-old space kept reading every conversation. `createAgentDefinition`
  now retires the unpatterned twin of each grant it declares, and every live grant on the same
  (principal, kind, operations) whose pattern DIFFERS — swapping one pattern for another had the
  same widening effect. Two boundaries: `scope` is excluded (`grantKey` excludes it, and including
  it made the rule retire the grant it had just written), and it is bounded to the declared triple,
  so a grant assigned out of band survives restarts. General shape: **when identity includes the
  thing you are changing, a change is an ADD**, and the old value stays in force until withdrawn.
- **A content-keyed registry write cannot revive what it retired, and a supersede that runs per
  entry retires its own siblings.** Grants are written under a content-derived idempotency key and
  idempotency rows never expire, so re-declaring a previously-used grant wrote NOTHING while
  `supersedeGrantsFor` retired the live one: zero active grants, and `createAgentDefinition`
  reporting success. Reachable from an ordinary chat resume (identity scope → conversation scope →
  identity scope ends in `forbidden`). Three changes in `src/core/space.ts`: the write suffixes its
  key with `:after:<recordId>` when the newest record for that identity is a retirement (which is
  why `RegistryView.newest` exists — `entries` drops retirements, so a writer could not see what it
  had to supersede); `supersedeGrantsFor` takes the WHOLE declared set and skips keys in it, so two
  patterns on one triple survive together; and retirements are keyed on the RECORD retired, so an
  identity can be retired more than once. Anchor revival on the newest RETIREMENT, never on "is the
  newest record retired": that was tried, and after one revival it falls back to a key the original
  record already consumed, so the next repeat replays the RETIRED record. Both SDK `grant()` helpers
  anchor the same way. Guards: `conformance/suites/retire.ts`, `examples/chat/smoke-selfgrant.ts`.
- **A withheld count with no reason sends every agent hunting for a grant that cannot exist.**
  `/v0/ops/events` filters by which principal PERFORMED the operation, so no record-kind grant
  widens it, but the response said only `withheld: 65923`, which reads as "you are missing a grant".
  Four sessions running spent their turns requesting grants that could not have helped, two of them
  inventing a kind to ask for. The response carries `withheldNote` now. Cheaper to say once than to
  have every caller learn it by exhaustion.
- **An approval prompt whose label does not match what it grants, and whose keys read as "yes".**
  The narrow option said "only its OWN records, reads only" and then granted the request VERBATIM,
  `take` on `llm_call` included, which would let a chat session claim work the inference fleet waits
  for: self-scoping is a read filter, not a claim filter. The narrow answer grants the reads ONLY
  and names what it withheld. Separately the keys were `y`/`a`/`n`, where `y` meant the NARROW
  grant, so answering "yes" to "shall I look wider?" got the opposite. Options are words now
  (`own`/`all`/`no`), nothing means "yes", and an unrecognised answer is re-asked rather than read
  as a refusal.
- **An escalation that costs two turns and two human inputs per grant does not converge.** Hit
  `forbidden` → `request_grant` → "asked them, retry later" → turn ends → human approves → human
  types "retry" → try again, and every miss costs another two. Sessions ran out of tool rounds and
  gave up with nothing broken. `request_grant` BLOCKS on the decision and the REPL reviews pending
  requests while the call is in flight (`onToolWait` in `turn.ts`), so the answer lands in the same
  turn. Details that make it work: the decision travels as a successor `grant_request` record
  carrying what was ACTUALLY granted (the asker may have got something narrower, and learning that
  by retrying is the loop being removed); the tool's deadline is a human one (240s) and the REPL's
  is longer; and the between-turns review stays as the backstop for a request whose turn died.
  General shape: **a protocol whose round trip crosses a turn boundary pays for that boundary every
  iteration.**
- **Kind-scoped is not conversation-scoped: every chat session ran as one agent, so each could read
  every other session's messages.** `USER_GRANTS` said `message: {put, query}` with a comment
  promising "may drive a conversation and read its own results, nothing more", and nothing enforced
  the "its own": a ten-minute session correctly reconstructed two days of unrelated conversations.
  The fix is the runtime's own content scoping — the session's grants are PATTERN-scoped to its
  conversation, binding reads and writes alike. Consequences: the conversation record is created by
  the OPERATOR before the session token is minted (a grant is minted with the token, so it must
  exist first), so a user session holds no `conversation: put`; and growth is per CONVERSATION, not
  per session, since the pattern is part of the grant's identity. `llm_chunk`, `llm_result` and
  `tool_result` are keyed by `callId` and needed a `conversationId` of their own, or a session
  holding a callId from elsewhere could read another conversation's output. Getting THAT wrong
  fails as a hang, not a leak (a writer that forgets the field produces a result its own session
  cannot read), so the test pins both directions. Artifacts needed a runtime change, since their
  body is computed from the bytes: `Space.putArtifact` merges application fields (`x-radia-meta`,
  an ASCII JSON header) with the runtime's own applied LAST, so nothing an app sends can forge a
  digest, size or media type. **And the narrowing had to learn about it**: patterns UNION, so
  approving an unpatterned self-scoped grant beside a patterned one replaces "this conversation"
  with "everything this agent ever wrote" — a widening performed by the act of narrowing. The
  approval flow inherits the pattern of the grants it replaces (`smoke-inspect.ts`, both directions).
- **A self scope must narrow the plane the agent actually READS through, and grants UNION.**
  `scope: {createdBy: "self"}` narrowed only the ops plane while ordinary `query`/`read_one`
  returned every record of the kind, so an approval promising "only its own records" handed over all
  of them (a session reported 98 records from `ops/stats` and 308 from `space_count` in one breath).
  `Space.authorScope` applies to the coordination plane too, reads only: `take` is excluded, because
  claiming a record and then rejecting it is not a filter. Grants UNION, so a narrow grant added
  beside a broad one changes nothing — the approval has to RETIRE the wider grant, and `authorScope`
  restricts only when EVERY grant permitting that operation is self-scoped. Per-OPERATION on both
  sides: counting a `put`-only grant as applicable lifted the restriction, and retiring the whole
  overlapping grant took the bootstrap `{put, query}` with it, so the chat died on "no 'put' grant".
- **Every read verb must resolve its scope through ONE path, or the verbs that forget serve
  everything.** Each handler called `space.authorScope` by hand and five did not: `take` drained the
  kind with full foreign bodies, `lineage` returned a whole ancestor DAG (and `put` never checks
  parent readability, so a scoped run could name any foreign id in `parentIds`), `graph` leaked
  foreign ids and labels, artifact reads served foreign bytes and minted a bearer capability over
  them, and `authorizeWatch` woke for every author. `Space.readAccess(principal, op, kind)` returns
  `{constraint, createdBy}` TOGETHER, so the author scope cannot be fetched separately and
  forgotten. Details worth keeping: `take` carries the scope into the CLAIM (`LeaseSpec.createdBy`),
  since `created_by` is envelope metadata a pattern never sees; lineage/graph treat a foreign record
  as a WALL rather than skipping it, because continuing still exposes the shape; artifact reads
  apply the scope before the bytes AND before minting a capability, since a bearer URL outlives the
  check; a `Watch` carries its owner and scope, because watch ids are enumerable ULIDs and were
  never secret; and `effectivePermissions` computes reachability per GRANT, the rule `opsScope`
  enforces, because a believed view that drifts from enforcement is worse than no view. Guard: a
  table in `conformance/http.test.ts`, one row per read verb. **A read verb with no row is a verb
  nobody checked** — add a row when you add a verb. It is a convention, not a type: a new handler
  can still call `authorize` alone.
- **The ops aggregate is self-scoped even where READS are not, so it must say which kinds it
  under-counts.** An unscoped `{put, query}` grant can live beside a self-scoped `{query}` on one
  kind (different operations, different grant identities), so a principal can LIST every record
  while `ops/stats` counts only its own: 187 messages reported as the space's total by a session
  whose `space_count` said 578. The scoping stays; the answer carries `alsoReadableInFull`. Widening
  the aggregate to match was tried and reverted — it turns every unscoped bootstrap grant into full
  ops visibility. Guard: `suites/selfscope.ts`.
- **A narrowed answer is dangerous because it is SHAPED exactly like a complete one.** Two
  instances. `POST /v0/records/query` returned `{records, nextAfter}`, so a caller scoped to one
  conversation could not tell its slice from the whole space; four sessions running reported their
  own slice as the space's history and then hunted for a grant to close a gap they could not see. It
  carries `scope: {narrowedBy, ownRecordsOnly, note}` now, only when a grant narrowed the read, so
  an unrestricted read is byte-identical (additive to the frozen contract). Ops responses had the
  same hole in aggregate form: a session with ops access on one kind read `stats: []`, `events: []`
  and an all-zero diagnostics and told its user "the space is empty and healthy" — every number
  correct, the claim wrong. They carry `scope: {self, kinds, note}` (`describeScope` in
  `handlers/ops.ts`), and the chat's tools pass it through rather than projecting it away, which
  they were doing, so a fixed server alone would not have reached the model. `read_one` is left
  alone: a null answer to "give me this one thing" does not invite the mistake.
- **A grant on a kind that does not exist authorizes nothing, and everything downstream reads it as
  access.** An agent that cannot list kinds guesses, and a plausible guess is a TOOL name: a session
  asked for `space_event` (the tool is `space_events`; the kind does not exist), a human approved it
  past the prompt's warning, and the phantom kind then appeared in every `scope.kinds` line the ops
  plane returned — documentary evidence of access it did not have. The grant is still honoured as
  written, because a grant may legitimately precede its kind, but `effectivePermissions` marks the
  row `kindNotDeclared: true`. That is the one answer an agent is told to trust about its own
  authority, so it is where the discrepancy has to surface.
- **A scoped agent must be able to ask what it may do, and the ops plane refused exactly the
  principal that needed to.** `GET /v0/ops/permissions` was operator-only, and `opsScope` throws for
  a principal with no self-scoped grants, so the caller with the least authority — the one that has
  just asked for some — got a 403 from the one endpoint that says whether the ask succeeded.
  Observed: a session granted precisely what it requested retried an unrelated failing call, saw no
  change, and told its user the request must still be pending. The self-read is checked BEFORE the
  plane's gate (`asksAboutSelf` in `http.ts`, matching the principal or its grant subject, since a
  run token asking about its agent asks about itself); anyone else's needs the `observe` ops power
  or an operator.
- **An escalation protocol that cannot express WHOSE records are needed keeps producing grants that
  authorize nothing.** `request_grant` carried kind and operations only, so an assistant needing to
  read a registry written by others said it in prose while the human answered a narrower prompt:
  request, approve, "the grant landed", every read still empty, three times in one session. The
  request carries `scope: "own" | "all"` now (a request, not a decision). Two supporting details:
  `scope` is part of the request's identity key, or re-asking un-scoped dedups into the handled
  request and vanishes; and choosing narrow against a measured-empty exposure PRINTS that the grant
  authorizes nothing, because an answer being allowed is not the same as it working. Pinned in
  `smoke-inspect.ts`.
- **Self-scoping a REGISTRY kind grants a view of nothing, not a narrowed one.** `createdBy: "self"`
  is right for a kind the principal WRITES and useless for one it only reads: `kind_def`,
  `capability`, `model` and `procedure` are written by whoever declares them, so a self-scoped
  session sees zero and `space_kinds` answers `[]` on a space with twelve. Nothing breaks, which is
  what makes it expensive. The approval prompt (`client/grants.ts`) MEASURES the exposure first (how
  much of a sampled page the principal actually authored) and recommends against self-scope when the
  answer is none — measured, not a hardcoded list of registry-ish names, which would be wrong the
  moment an app adds one.
- **A read grant without `query` is a session that cannot find its own work.** The chat gave itself
  `artifact: read_one` and no `query`, so "which artifacts do I have?" was unanswerable: it could
  fetch an id it already knew and could not discover one. The assistant diagnosed it correctly and
  then asked a human to widen a grant so it could see its OWN files. When a kind is scoped by
  pattern, `query` adds no exposure the pattern does not already bound, so withholding it buys
  nothing and costs discovery. Check both verbs whenever a grant is meant to cover "my records".
- **`{owner}` and `{conversationId}` scope are different code paths, and only one was tested.**
  `smoke-selfgrant.ts` covers the escalation loop under `{conversationId}`, which is not the default;
  both bugs above reproduce only under `{owner}`. A suite that exercises one posture of a documented
  either/or is not covering the feature. `smoke-login.ts` now carries the identity-scope half.
- **Narrowing a grant can leave a session with LESS than it had, and the prompt said so too late.**
  Approving `[own]` retires any wider grant carrying the same operations — correct, because grants
  union and leaving the wide one standing would make the narrowing theatre. But it means the
  conservative-sounding answer is destructive: a scoped user reading workspace files through
  `artifact: read_one` lost that access entirely when a human chose `[own]` on an unrelated artifact
  request. The consequence line already existed and printed AFTER the decision, as a receipt. **A
  cost disclosed after the choice is not a disclosure**, and an option that removes access must
  never be the recommended one. Pinned in `smoke-selfgrant.ts` by capturing the prompt at the file
  descriptor and asserting the warning's POSITION relative to the options, not just its presence —
  the receipt was always printed, so a presence check would have passed before the fix.
- **`delegation_context` is derived from the LEASE, never `parent_ids`; and only for managed-run
  work.** On `ack`, the authority chain comes from the leased record's authoritative `lease_owner`
  (from the envelope, not the client-presented lease) → its agent → extending the leased record's
  chain. Data parents contribute no authority (the core invariant). It is set only when the lease
  owner is **non-privileged** (a managed run), so operator/root work carries none. This is why
  `isPrivileged` also covers the space's own `ctx.runId`/`ctx.principal`: in-process callers
  (conformance, demo, examples) claim under `run:local`, which must count as operator so their
  ack-emitted results stay root (no delegation, no put-enforcement) and existing tests don't break.
- **Strict chain-intersection was rejected as the ack gate, because it breaks pipelines.** "Effective
  permission = intersection of the whole chain's grants" (design-auth) sounds right but, enforced
  on every `ack`, it blocks the fan-out/aggregator pattern: in `a → b`, agent `b` legitimately
  produces a kind `a` cannot, and intersection would forbid it. M1 instead authorizes the **acting
  agent's own** `put` grant for the emitted kind (`Space.ack` → `authorize(owner, "put", kind)`),
  which is pipeline-friendly and closes the real hole (ack-emitted records previously bypassed put
  auth). A forbidden ack throws before consuming, so the record stays leased. Full intersection is
  deferred to compose with taint (M3); don't reinstate it as a hard default.
- **Pattern-scoped grants apply to reads/claims AND writes.** A grant's `pattern` is AND-ed into
  `query`/`read_one`/`take` (`grant ∧ request` via `combineMatch`), and on `put`/ack the record body
  must satisfy it (`Space.bodyMatchesGrant`), so a scoped principal writes only records inside its
  pattern. Note the asymmetry: read-side ANDs the pattern into the *query*; write-side matches the
  *body* against it. Also: the read constraint nests as `$and[request, $or[patterns]]`, so a grant
  pattern must be a flat equality map: a `$or`/`$and` inside one can exceed the depth-3 compile
  limit. And a pattern's paths are validated (indexed-path check) only when it compiles at use, not
  at grant creation (the kind may not be registered yet), so a bad path surfaces as a 400/denied later.
- **Provenance is not authority.** A result with a privileged data parent inherits no
  permission from it. See [design-data-model.md](design-data-model.md).
- **A long-lived connection is a request that never ends, so it re-resolves rather than never
  resolves.** The rule "never remember what can be revoked" was written for token caches and read
  as if a request were the unit. A watch SSE stream authorized once and then streamed under that
  decision for hours. Every long-lived thing added from here (a stream, a subscription, a
  materialized view over authorized data) inherits this: bound the staleness at open time or it is
  unbounded by default. Closed in package L; see
  [plan-audit-remediation.md](plan-audit-remediation.md).
- **Ownership is not authorization, and confusing them makes revocation reversible by reconnect.**
  `getWatch` checks that the caller CREATED the watch, which stays true forever, so gating a
  reconnect on it alone let a client whose grant had been revoked get its stream back by dropping
  and re-attaching. An identity check answers "who is this", never "may they still". The two look
  interchangeable at the call site precisely when one of them has gone stale.
- **Re-derive a narrowed scope from the ORIGINAL request, never from the narrowed result.**
  Scope is `grant ∧ request`. Recombining the already-combined match with a fresh grant ratchets:
  each check ANDs another constraint on, so the scope only ever shrinks and a re-widened grant never
  takes effect. `Watch.request` keeps the client's pattern for this reason. The bug is invisible
  while grants only get revoked, and appears the first time one is restored.

### Artifacts, blobs and erasure

- **Writing a payload and its key is two operations, so order them for the crash.** The encrypted
  blob store wrote ciphertext first and the wrapped DEK second. A crash between them left
  ciphertext with no sidecar, which the reader treated as a *plaintext* blob, so raw ciphertext
  was served as the artifact, and a re-upload never healed it because the content-address guard saw
  the file and skipped. Now: key first, payload second (an interrupted write is an honest miss);
  the "already stored" guard requires BOTH parts; and a blob at the ENCRYPTED name with no sidecar
  is damage, never legacy plaintext. Only the plaintext-digest name may be read as plaintext.
- **Artifact bytes are served `inline` only for formats a browser cannot execute.** Blob bytes are
  attacker-supplied and served from the space's OWN origin, the origin whose console page carries
  an operator token, so `text/html` rendered inline is a same-origin XSS reachable by anyone
  holding an `artifact: put` grant. The allowlist names raster image, audio and video types
  explicitly rather than `image/*`, because `image/svg+xml` is scriptable; PDF is excluded for the
  same reason. Everything else downloads. `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox` back it up. Don't widen the list to
  "anything that looks like media" (`src/server/handlers/artifacts.ts`).
- **A download capability belongs in an `<img>`, not in a transcript.** Capabilities are minutes
  long and in-memory, so a URL carrying one is broken by the next restart and by the clock. The
  console mints one per render and uses it immediately, which is correct. Printing one into terminal
  scrollback (the chat example did) produces a link that looks permanent, fails later, and leaves
  a token in the user's history. Print the stable `/v0/artifacts/{id}` URL instead and let the
  viewer authenticate.
- **A guard on one field of a pair is a guard on neither, and the budget is their SUM.**
  `buildRecord` checked the body's size and its NUL and left `clientMeta` — equally
  client-supplied, equally persisted, equally unerasable — untouched, so both limits were walked
  past by moving the payload one field sideways. Both are covered now, and the size check shares
  ONE budget rather than giving each field its own: two independent limits are defeated by
  splitting. Note which half of the fix rests on what: the body's NUL rule is a storage fact
  (`body_jsonb` cannot hold U+0000), while `client_meta` is plain text and refuses it for the
  boundary's sake instead. Saying so beats implying a failure that does not exist today.
- **An unenforced record-size limit is an ERASURE hole, not a performance note.** Nothing rejects a
  large body (verified: 4 MiB accepted, while the same bytes as an artifact hit a 32 MiB cap), and
  the erasure boundary is precisely "payloads are out of line, so they can be destroyed; bodies are
  not, so they cannot". So the missing limit is the mechanism by which unerasable data enters a
  space: base64 a secret into a body and no operator verb reaches it. That moves the record-size
  limit above the rest of the unbuilt resource limits, which only bound cost.
- **The capability URL is the one URL a PERSON handles, so its length is a real property.** 122
  characters became 46: the capability already names one record, so `GET /v0/a/{capability}` drops
  the redundant id and query string, and the token is 16 bytes base64url rather than 32 hex — not a
  weakening, since it opens one object for minutes, is not an identity, and carries no id to
  substitute. It stays under `/v0` (a root path buys an unversioned public surface), and the long
  form still works, since that is the one OpenAPI marks `stable`.
- **A capability URL must come back ABSOLUTE to anything that is not the console.**
  `POST /v0/artifacts/{id}/capability` returns a RELATIVE url when no isolated artifact origin is
  running (`--artifact-port 0`). The console resolves that against its own origin; an agent hands it
  to a user verbatim and it opens nothing, with no way for the model to know what to prepend. The
  chat's tool resolves it against the client's base before returning.
- **"Refuse or fabricate" is usually a false pair.** The git export refused an erased payload,
  because a placeholder blob would make the tree hash to something the manifest never described.
  OMITTING the entry is a third, honest option: a tree that does not contain the file makes no claim
  about it. What made it honest was closing the remaining gap, silence — the subject line, the commit
  trailers and the repository `description` each say what is missing, the last because it is the only
  channel that survives the directory being passed on.
- **Discriminate a skippable failure by its STATUS, never by how its message reads.** `--partial`
  skips a 410 (bytes deliberately destroyed) and nothing else. A 404 is a manifest pointing at
  something that never existed; a digest mismatch is content disagreeing with its claim. Both look
  like "cannot read that file" and neither is erasure, and skipping them would return a repository
  that looks complete. Any "best effort" option needs this line drawn explicitly, with a test on the
  wrong side of it.
- **An undone erasure was not just a no-op, it was INVISIBLE.** `shredOf` had exactly one caller,
  inside the branch that runs after a read has already failed, so once the bytes returned nothing in
  the system ever consulted the shred record again. The fix is detection, not enforcement: a marker
  plus a present blob is a reversed erasure, derivable in one `stat`, reported by `Space.erasures`,
  `GET /v0/ops/erasures` and `radia doctor`. Scoped callers get the field OMITTED rather than zero,
  because "no erasure was undone" is the one reassurance nobody should receive on no evidence.
- **Erasure leaves a confirmation oracle, and the argument against it was already in the repo,
  pointed at the neighbouring case.** The plaintext sha256 lives in the artifact record's body,
  which has no erasure path, so a shredded payload stays confirmable to anyone holding a candidate —
  while `BlobCipher.storageName` HMACs the same value precisely because a storage name must reveal
  nothing. Two layers, opposite postures. `design-data-model.md` had already reasoned that a
  retained `body_sha256` leaves a low-entropy body brute-forceable, one case short of its own
  counter-example. **When a doc states a hazard, check the sentence next to it for the case it was
  not applied to.**
- **Erasure by content cannot mean "these bytes may never exist here again".** A pre-write check
  refusing any payload whose digest was ever shredded was written and reverted the same hour: it
  poisons a content address space-wide (shred an empty file and nothing can store one) and breaks
  any program that legitimately recomputes the same output. Erasure destroys the runtime's copy;
  someone re-uploading bytes they already hold learns nothing. What IS worth fixing is legibility
  where it bites: the runner and reader say "ERASED, permanently, save a successor without this
  path" rather than hanging.
- **A git tree can hold two entries with one name, and it builds, hashes and writes fine.** `a` as a
  file plus `a/b` produced exactly that. Only `git fsck` rejects it, which is why the export suite
  round-trips through the real binary where one is installed rather than trusting its own vectors:
  vectors written by the same author who wrote the encoding are wrong in the same direction.
- **A git export's author is `created_by`, never the manifest's `owner`.** Provenance is not
  authority. `owner` is a body field a client submits, so taking the author line from it would let a
  record name whoever it liked as its writer. It travels as a trailer instead, where it reads as the
  claim it is.
- **Encrypted content is coordination-invisible by construction.** Client-side-encrypted
  bodies are unmatchable, untaint-trackable, and invisible to diagnostics. E2E-from-the-
  runtime while plaintext is exposed to the LLM provider is rarely a coherent threat
  model. See [design-observability.md](design-observability.md) confidentiality layers.
- **In a content-addressed store, a partial write is permanent, not transient.** Ordinary storage
  self-corrects because something writes that address again. Content addressing removes that: the
  only party who would ever write those bytes is a caller holding exactly them, and dedup-on-
  existence is precisely the rule that tells that caller to skip. So a truncated blob survived every
  attempt to repair it. Two rules follow, and both are needed: write atomically (temp plus rename,
  `FileBlobStore.writeAtomic`) so damage cannot be created, and VALIDATE before deduping (compare
  length, not existence) so damage that exists can still be repaired. "The file is there" is not
  "the bytes are there". Closed in package G.

### Executing model-written code

- **A process that executes model-written code must hold nothing; the process that holds a token
  must not execute.** Executing inside a worker with a run token hands hostile code the space itself
  (`put`/`take` as that agent), a better target than the internet. Hence three processes in the chat
  example: `workers/exec.ts` (token, space access, `--allow-run`) spawns `deno run -` with NO
  permissions and talks over pipes. The sandbox never gets a credential "so code can query" (the
  worker fetches and pipes data in), and that emptiness is what makes lease RETRY sound: a
  permissionless child has no side effect to double.
- **Do not share stdout with a protocol. Use a FIFO pair; it is the portable extra fd.** Verified
  against `extensions/ts/broker.ts`: an entrypoint writing without a trailing newline
  (`print(..., end="")`, a progress bar) prepends itself to the next frame, which no longer starts
  its line, is read as chatter, and leaves the jail blocked on an answer that never comes until a
  timeout naming the wrong cause. Framing rules (leading newline, a long printable marker, mid-line
  detection) manage that; a private channel removes it. `Command` exposes no extra fd, but a named
  pipe is one reached by path, and the run already has a writable directory. Costs on the untrusted
  side are what to compare: a unix socket needs `--allow-net` in the JAIL (measured: scopable to one
  path, but no-network is proved by that flag's absence), a FIFO needs `--allow-run=mkfifo` on the
  HOST. Prefer the host paying.
- **Open both ends of a FIFO yourself (O_RDWR) before spawning the child.** A FIFO open blocks until
  the other end opens, so the naive open hangs the host before it spawns anything and ahead of any
  run timeout. The cost is no EOF, so end the read loop on a terminal frame plus an exit-and-quiet
  window. Planting the naive open hangs every case in the broker suite.
- **Which end of a diagnostic carries the message depends on the language, so keep both.** A
  Python traceback ends with the exception; a JavaScript uncaught error STARTS with it and the
  frames below are noise. A tail-only clip is right for one and drops the cause of the other, which
  is how a fully diagnosed failure reached a test as an exit code and nothing else. Size the ends
  for what each must catch rather than splitting evenly: the head needs one line, the tail needs a
  message sitting ABOVE a stack (`clip` in `extensions/ts/broker.ts`).
- **Address a record by identity, never by a predicted index.** A reader that computes where a
  record will land gets the WRONG record when a writer disagrees, not an error. Match on what the
  record carries and the reader already knows (`tool_call_id`; `{turnAt, round, role}`), and keep
  the sequence for ordering only. A scoped client cannot fetch by id at all (`getRecord`,
  `lineage` and `children` are ops-plane), so an address has to be an indexed body field.
- **A match on `{round: 0}` does not match a record whose `round` is absent.** A field used as an
  address must be stamped even when its value is the default; `client/turn.ts` seeds `round: 0`
  explicitly for this.
- **`round` must be copied onto the assistant message** (`finished()`, `workers/inference.ts`). It
  rides on the `llm_call`; dropped, the turn worker reads undefined, re-emits round 1 forever, and
  `MAX_ROUNDS` never trips. Assert the BOUND (how many calls happened), not that a value changed:
  under the bug the rounds still read `[0,1,1,1…]`. Guard: `smoke-turnlink.ts` "round cap".
- **`i`/`of`/`round`/`turnAt` must be copied from a `tool_call` onto its reply** (`asTurnReply`,
  `extensions/ts/turn.ts`). Dropped, `of` defaults to 1, every reply looks like the only one of its
  round, and a round of eight calls becomes eight rounds. Test the SECOND element of anything
  positional; a suite of one-call rounds proves nothing. Guard: `smoke-turnlink.ts` "TWO tools".
- **Scope a per-turn marker to the turn (`turnAt`), never the conversation.** `turn_complete`
  matched on `{conversationId}` finds the PREVIOUS turn's and ends every later turn immediately.
  Index the path. A suite running one turn per conversation cannot see it.
- **A deadline on ELAPSED time cannot tell a slow answer from a dead worker.** The chat abandoned a
  top-tier turn at two minutes while the worker was still generating, so the answer landed for
  nobody. Time out on SILENCE instead: `awaitResult({alive})` restarts the clock on any evidence
  (a streamed chunk, a progress record). The other half is that the evidence has to exist — a model
  can think for minutes before its first token, so `runInferenceWorker` beats a `progress` record
  every 15s while a completion is outstanding.
- **Routing per round plus a tool-count signal is a RATCHET.** The chat re-classified every round of
  a turn and told the classifier how many tools had run; the user's text is identical each round, so
  the tool count was the only input that changed and it only ever grows. Measured: 14% of first
  rounds went to the top tier and 72% of every round after, with most calls being later rounds. Two
  fixes, and the second is the one that holds: say what happened rather than that it was hard, and
  BOUND a later round to one step above where the turn opened (`capToTurn`, workers/router.ts).
- **A WATCH does not outlive its run, so supervise the loop that owns one.** A run lasts fifteen
  minutes; the SDK mints another for ordinary calls, but the SSE stream opened under the old one is
  revoked with `credential_invalid`. An unsupervised `for await (… client.watch(…))` throws out and
  takes its worker with it, which stopped every conversation on the space with one stack trace as
  the sign. Re-watch, and sweep on the way round so nothing that landed in the gap is stranded.
- **A revoked watch has TWO causes and they need opposite responses.** `credential_invalid` means
  the run ended (mint another and re-watch); anything else means the authorization changed (poll
  and tell the operator). Conflated, a worker whose credential merely turned over was told to fix a
  grant it already had, and polled for the rest of the session. The reason is the error's `code`
  (`RadiaClient.watch`), so a caller can tell them apart without parsing a message.
- **A long-lived worker holds the DEFINITION token, not a run token.** A run expires (15 minutes,
  renewing to a 12-hour ceiling); past that, or across a space restart, a worker holding only that
  half cannot re-authenticate and spins on `token_expired`. A definition token has no expiry and is
  mint-only, so handing it over is safe, and `RadiaClient({definitionToken})` exchanges it. EXCEPT a
  credential that acts for somebody else: the tools worker's session client keeps a run token,
  because a worker able to mint a person's session can be that person.
- **Measure a storage-bound loop on a COLD cache.** The event-chain walk read one event per link:
  0.085ms warm, ~6.7ms cold. A 20k-link space verified in 1.7s warm and 135s after a restart, and
  batching the reads measured slightly SLOWER warm. Batched cold: 1.9s.
- **`diagnostics` spot-checks the event chain; it does not walk it.** A full walk is O(every event
  ever written) on a command an operator runs casually. `verifyIntegrity({tail})` does the newest
  500 and the output says so; `radia integrity` stays the unbounded audit.
- **A boot reconcile needs TWO bounds: the conversation's head, and the work's own deadline.**
  Sweeping history re-dispatches dead turns' work and starves the live one. Head alone is
  insufficient: an abandoned multi-call turn's head legitimately asks for the next call. An age
  cutoff guesses in both directions, since a grant request waits minutes on a person by design, so
  the bound is `deadline_at`: client-submitted, and a record without one is never resumed. Being
  keyed makes an emission idempotent, never appropriate.
- **A record FIELD does not survive a `{...body}` re-emit.** `deadlineAt` sits beside the body, so
  the router's re-dispatch of an `llm_call` dropped it. Either every re-emitter copies it, or read
  it from the records the OWNER writes (`currentCall` reads untiered calls only). Prefer the second:
  a worker cannot forget a field it does not know exists.
- **A client test that runs as the OPERATOR tests the wrong principal.** An operator bypasses grant
  checks, so the suite proves the logic runs, never that the session may perform it. Mint a scoped
  session (`mintSession`) for anything asserting client behaviour.
- **Asserting on RECORDS cannot test a client that only reads them.** Workers write the transcript
  whatever the client does, so a role-by-role assertion passes with the render loop broken. Assert
  on state only the client under test advances (there, the thread's cursor).
- **A diagnostic tool's failure is its ANSWER, never a nack.** A rehearsal that throws makes the
  loop nack, at-least-once re-runs the same doomed code, and the caller times out while the
  diagnosis reaches a terminal and nobody else. Return infrastructure faults the same way: a jail
  the worker cannot start is something the caller needs told.
- **A frame channel from a jail is UNTRUSTED, and should be built so that costs nothing.** Jailed
  code can forge any frame; it gains nothing when the labels, the compartment stamp, the forced
  parent, the idempotency key and the agent's grants are all applied HOST-side. Check this
  property holds before adding a field the jail gets to state.
- **Two truncations at opposite ends destroy the diagnosis between them.** The broker keeps the
  TAIL of stderr (a stack trace's last line is the useful one); `WorkspaceHost` then kept the first
  300 characters of the failure, so a program that logged before it died reported only its
  chatter. Both caps were individually defensible and together they threw away every cause. Pick
  ONE end and one place: bound it where the text is produced, and let the reporting cap be a
  backstop wide enough to pass a bounded message through. The same rule applies to
  `runCode`'s stderr, which had the same head-first slice.
- **Cap stderr as well as stdout, and keep DRAINING past the cap.** A flood guard on one stream is
  no guard: the other one buffers just as unboundedly. And a reader that stops at the cap blocks
  the child on a full pipe instead of killing it, which converts a flood into a hang.
- **An exit code survives a kill only if the process already exited** (verified: `kill` after a
  clean exit still reports the real code, so only a live process loses it to the signal). A host
  that SIGKILLs its child at teardown therefore has to wait briefly for a natural exit before it
  can report the code at all. Worth doing: a result frame followed by a non-zero exit is code
  contradicting itself, and it used to ack clean.
- **Read access for executed code is granted separately from the file tools' roots.** Both bound
  "which files", but a tool returns one file per call, visibly, while a program can fold a whole
  tree into one line of output — so widening the tools (`RADIA_CHAT_DIRS`) must not widen the
  sandbox (`RADIA_CHAT_EXEC_DIRS`). Two properties to keep: roots are realpath'd before being
  granted, so a symlink cannot smuggle the grant elsewhere; and the blob KEK and operator credential
  are passed as `--deny-read`, which beats `--allow-read` in Deno, so a root containing them still
  does not expose them. Write, net, env and run stay denied whatever is configured.
- **Deno's `--max-old-space-size` does not bound TypedArrays.** Measured: an object-allocation loop
  dies in ~0.3s ("Reached heap limit", exit 133), while `while(true) a.push(new Uint8Array(1e7))`
  runs until the kill timer, because the backing store is external to V8's old space. So the
  execution *timeout* is the real memory bound, not the flag. Keep it short, and reach for
  `ulimit -v` or a container if that is not good enough.
- **A jail's own description is the first thing to distrust, including your own.** `bwrapSandbox`
  claimed `writablePaths: []` and the probe caught it on the first run: bubblewrap's root is a
  tmpfs, so a program CAN write there. Nothing escapes and nothing persists, but the claim was
  false, and a record is only worth something if it says what the jail GOT rather than what was
  intended. Write the probe before believing the spec, even when you wrote both.
- **A jail must not resolve its own interpreter through a search path, and a test must not assume
  an OPTIONAL jailer is installed.** Both were environment assumptions every developer machine here
  happened to satisfy, and the first CI run failed on both. `runCode` spawned `deno` BY NAME against
  the `PATH=/usr/bin:/bin` it invents for the child, so on a machine where Deno lives anywhere else
  (a GitHub runner's tool cache) the jail was unreachable — "entity not found", which reads like a
  broken test rather than a missing binary. It spawns `Deno.execPath()` now: the running runtime, by
  absolute path, so the flags it passes are enforced by the binary that passed them. Separately, the
  bubblewrap cases FAILED rather than skipped where `bwrap` was absent, though the design treats it
  as optional (a space advertises it only where its probe comes back clean). They skip now, and CI
  installs it, because skipping is right on a laptop and wrong in the run that is meant to be
  thorough. Two details that took a second pass. **The skip check must be FUNCTIONAL**: the first
  version ran `bwrap --version`, which proves the binary exists and nothing about whether the kernel
  permits an unprivileged user namespace — Ubuntu 23.10+ ships
  `kernel.apparmor_restrict_unprivileged_userns=1`, under which `--version` succeeds and the first
  real jail dies, so the cases would have failed anyway. It runs a trivial program through the jail
  now. And **gate only what actually spawns**: the case that merely DECLARES two backend records was
  skipped too at first, and it had passed on the runner.
- **A hosted runner cannot run this bubblewrap jail at all, and asserting the capability only turned
  a skip into a red build.** Measured on `ubuntu-latest`: the package installs, `--version` answers,
  the user namespace is created, and `--unshare-all` then dies with `bwrap: loopback: Failed
  RTM_NEWADDR: Operation not permitted` — Ubuntu's AppArmor profile grants the namespace and
  withholds the capability to configure `lo` inside it, so "installed", "allowed to unshare" and
  "able to build the jail" are three different questions and `kernel.apparmor_restrict_
  unprivileged_userns=0` answers only the second. CI attempts the relaxation, never fails on it, and
  PRINTS whether bubblewrap coverage is ON or OFF. That is the rule worth keeping: the fix for a
  silent skip is to make the skip loud, not to fail the build over an environment nobody chose.
  Real coverage for this backend needs a machine with unprivileged user namespaces.
- **A confiner that bounds READS only, plus a runtime that writes caches, corrupts those caches.**
  Measured on macOS while verifying the Seatbelt jail: Deno writes its global SQLite caches whatever
  `--no-remote` says, a read-bounding profile leaves them WRITABLE BUT UNREADABLE, and that is the
  one combination SQLite cannot survive. It fails machine-wide (`SQLITE_IOERR` 522 on every later
  `deno`) and does not heal, because Deno's recovery deletes the main db and leaves the `-wal`/
  `-shm` siblings; recovery is deleting the full triples by hand. The rule generalises past Deno:
  when you confine one axis of a runtime, ask what that runtime writes WITHOUT being asked, and give
  it somewhere it can both read and write, private to the jail. Bubblewrap avoids this by accident
  rather than by design, since its `/tmp` is a fresh tmpfs. See `RunOptions.cacheDir`.
- **A read permission does not necessarily cover MODULE LOADING, and in Deno it does not.** Measured
  2026-08-06: inside the permission jail, `import("file:///x.json", {with:{type:"json"}})` returns
  the file past both `--allow-read` and `--deny-read`, while `Deno.readTextFileSync` on the same
  path is refused. Any `.ts`/`.js` is importable too, which reads its exports and runs it. Non-module
  text does not leak, so this reaches JSON and code rather than arbitrary bytes. No flag closes it
  (`--allow-import` is remote-only), and a textual ban on `import` is not a control because dynamic
  import works from `eval`. A mount namespace does close it, for 7ms. The lesson generalises past
  Deno: when a sandbox grants "read these paths", ask which CHANNELS that covers, and probe the ones
  it does not name. See package T in [plan-audit-remediation.md](plan-audit-remediation.md) and
  `SandboxSpec.importsConfined`.
- **Prefer a guarantee that holds by ABSENCE over one that holds by presence.** Deno's sandbox is
  safe because nothing was granted: forget every flag, get the safe answer. A bwrap or container
  jail is safe because `--unshare-net` was passed: forget one, get the unsafe answer silently. That
  is fail-closed versus fail-open, and it is the first thing to check when a second isolation
  backend is proposed. Mitigation is a boot-time PROBE (try to connect, to write, to read what
  should not be there) and refusing to advertise a jail that fails it.
- **Measure the isolation you are comparing, not the latency.** Making `python3` reachable under
  bubblewrap means binding the host's `/usr`, and the resulting jail sees 4223 binaries and 289
  site-packages entries where the Deno jail beside it sees NOTHING; a purpose-built container image
  sees ~142. bwrap benchmarked faster than the runner already in use (13 ms vs 35 ms) and is three
  orders of magnitude weaker on the dimension that matters, which is not visible in a timing table.
  It is also inherent rather than a misconfiguration: an interpreter has to come from somewhere.
- **When a capability varies, make the VARIATION a record, not a worker's identity.** A first draft
  of multi-language execution gave each language its own runner worker publishing
  `capability{language}`. That conflates two axes: `language: "python"` says nothing about what the
  jail guarantees, so two Python runners with different isolation collide on one name and an
  operator granting `tool_call{language:"python"}` has granted the weak one too. The grant reads
  like a policy and is a proxy for one. The fix is that an execution environment is a THING, so it
  is a record (`sandbox`), its guarantees are body fields, and a grant binds the field that matters.
  Symptom to catch: a design that answers "how will anyone know what this guarantees?" with "we will
  write it in the description". Descriptions are for a model's benefit; the runtime cannot match on
  prose. See [design-execution.md](design-execution.md).
- **The cost of an LLM iteration loop is the model, not the substrate.** Measured locally: a full
  put+take+ack round trip is ~30ms, a sandbox spawn ~27ms, and a model round is 1-10 SECONDS. So
  routing an edit-run-test loop through records costs about 1% of an iteration, and optimizing the
  medium is optimizing the wrong end. It also means the argument against coordinating a tight loop
  through a substrate (true for a compiler) does not transfer to one gated by inference. What DOES
  pay is reducing model rounds and making each one more informative.
- **An inconclusive probe was read as a passing one, which is fail-OPEN in the component whose job
  is to disbelieve.** `escaped = stdout.includes("ESCAPED")` had two outcomes for three cases: a
  denied operation says "held", an escape says "ESCAPED", and a probe that never ran — cold
  interpreter past its timeout, missing binary — says neither and was counted as held. So an
  unverifiable jail passed its own verification. It surfaced as an intermittent conformance failure
  rather than as an alarm, which is how a fail-open default usually announces itself. Now a probe
  with no conclusive output is a FAILED claim and the worker refuses to serve.
- **A conformance test that reaches the public internet is not a conformance test.** The network
  probe connected to `1.1.1.1:53`, so it reported "held" on a machine that was merely offline or
  behind an egress filter — meaning a jail with no network isolation would have passed. A loopback
  listener opened by the prober discriminates exactly as well, cannot be wrong about it, and stops
  every worker boot making an outbound connection.
- **A language is a CAPABILITY NAME, not an argument or a router decision.** `run_python` is
  published only where its jail probes clean, so a space without `bwrap` never advertises it. A
  `requires: {language}` argument would be expressible everywhere and fail at execution, after the
  model committed a turn to it; a router would have to fall back, and a fallback means running
  somewhere weaker than asked. The `llm_call` tier router is NOT the precedent: a tier is a
  judgement about a turn, worth delegating; a language is a fact the caller already holds, because
  it wrote the program. A router earns its place only when a caller states REQUIREMENTS rather than
  a name. See [design-execution.md](design-execution.md).

### Surfaces: HTTP, console, CLI and the SDKs

- **Three rules the OTLP exporter learned from live Jaeger, for any second exporter or binding**
  (2026-08-06, each found by an operator reading a real trace, none by the design pass).
  A `run:<ulid>` principal carries NO agent name: the first exporter parsed a fictional format
  out of it and showed one "service" per 15-minute run remint; the mapping lives in `agent_run`
  RECORDS and arrives as a resolver, never string surgery (the same rule design-auth states for
  `created_by`). A `parentSpanId` naming a span the collector never received is rendered as
  tampering-adjacent ("not in the trace", an Incomplete badge), so a parent outside the export
  LINKS instead, and the follower backfills ancestry. And a deterministic span id may be sent
  ONCE, which makes premature emission permanent: a child settling during its ancestor's open
  attempt froze the ancestor at zero-duration `radia.open` forever, so the follower defers the
  family until the attempt settles (30s cap). Collaterally: collectors refuse `end == start`, so
  point spans carry a deliberate 1ns floor rather than a per-span sanitizer warning.
- **A 401 is the first move of HTTP Basic, not a failure.** A server that logs every one reports a
  successful authenticated clone as a wall of errors, and (because only failures were logged) says
  nothing at all when it works: loudest precisely when nothing is wrong. Distinguish the CHALLENGE
  (a 401 to a request that carried no credentials) from a refusal, and log something on success.
- **A protocol that FALLS BACK hides its own bugs.** Git takes the smart transport only when the
  advertisement's content type is exactly `application/x-git-upload-pack-advertisement`; anything
  else and it walks the dumb routes, which works and is ten times slower. So the assertion cannot be
  "the clone succeeded": it has to be on the SHAPE of the exchange (two requests, no loose objects).
  Same class as a watch that 401s into a silent poll fallback, and it recurs wherever a client is
  polite about a server's mistakes.
- **`onShutdown` REPLACES the default signal behaviour, so a no-op handler makes a process
  unkillable.** It registers listeners for SIGINT and SIGTERM; one that does nothing means neither
  Ctrl-C nor `kill` stops the process, only SIGKILL. A long-running verb wants the shape `radia dev`
  already uses — abort a controller, pass its signal to `serve`, await `finished`, return a status —
  since `exit` outside `src/main.ts` is not allowed either. Also pick a port that is not `space + 1`:
  a space binds two, and `git-serve` first defaulted onto the artifact origin.
- **A cache in front of an authorization decision becomes an authorization decision.** The git
  server caches a client per credential, because a dumb clone is one request per object and building
  one per request exchanges the credential per object (a hundred `agent_run` records for one clone).
  The obvious cache then made `radia revoke` take up to fifteen minutes, since a cached run token
  outlives the definition it came from: the property that PAYS for a durable credential quietly
  became an approximation. Re-authenticate at a boundary the protocol already has (`info/refs`
  starts every fetch), and state the guarantee exactly: a revoked credential cannot start a fetch,
  one in flight finishes. Found by an acceptance test that revoked and cloned again.
- **A terminal has ONE cursor, so it needs one writer.** Three writers shared the chat's: the turn
  streaming an answer, a `capability` watch wakeup, and every worker's inherited stderr. The two
  background ones printed straight through, so a worker restarting mid-turn spliced a bracketed line
  into the model's sentence and a crashing one wrote an unlabelled stack at whatever column the
  answer had reached. The fix is a `write` funnel that tracks the cursor's column plus a `notice`
  that holds a line until the turn releases it, and piping worker stderr instead of inheriting it.
  Guarded by `examples/chat/smoke-render.ts`; the seam it needs is an output capture, because
  ordering is invisible from outside a process that writes to the real terminal.
- **Owning raw mode means owning everything the line discipline was doing for you.** A prompt in
  cooked mode gets backspace, `^W` and `^U` and nothing else, so an arrow key inserts `^[[D` as text
  and there is no history. Taking raw mode fixes that and transfers four obligations at once: Ctrl-C
  stops being a signal and has to be a key, Ctrl-D has to mean two different things, the terminal
  has to be restored on EVERY exit path (a crash otherwise leaves the user's shell with no echo),
  and a paste has to be bracketed or a multi-line one submits once per line. The decoder must also
  never guess at a half-arrived escape sequence: deciding early turns an arrow key into a cancel.
  `examples/chat/client/edit.ts` is the pure half, which is what makes any of it testable.
- **A streaming renderer is only correct if the chunk boundaries cannot be felt.** Markdown rendered
  as it arrives has to produce the same bytes whether the text comes whole or one character at a
  time, and both bugs in the chat's first version were invisible to a complete string: a `_` at the
  start of an otherwise empty buffer lost its look-back (fixed by remembering the last character
  DEALT WITH, not the last one still buffered), and a closing fence consumed a newline that had not
  arrived. The test shape that catches this class is rendering the same source at several chunk
  sizes and comparing the results TO EACH OTHER, plus a deterministic fuzz over random splits;
  `examples/chat/smoke-markdown.ts`. Do not test a stream by feeding it one buffer.
- **A width constant is a bug on somebody else's terminal.** The status line was cut at 100 columns
  and redrawn with `\r\x1b[2K`, which erases the row the cursor is on. On an 80-column window the
  line wrapped, the erase cleared the second row, and the first row's fragment stayed on screen for
  the session. Measure with `Deno.consoleSize` and cut to fit; and note the off-by-one under it,
  found by the test rather than by reading: a `trunc` that appends its ellipsis AFTER slicing
  returns n+1 characters, which is exactly enough to wrap.
- **A cast is still a promise, not a check; `match` was the one that got away.** `pattern.match` was
  cast straight into the compiler, and `Object.keys(3)` is empty, so `match: 3` compiled to NO
  PREDICATE and returned every record of the kind: a malformed filter that WIDENS. Validated in
  `compilePattern`, not in the handlers, because SDK/MCP/in-process callers never pass through one.
  Found by writing `conformance/http.test.ts`, which is a table now: add a row per field.
- **A wrong-typed field that changes WHICH records are involved is a 400; one that only sizes the
  answer falls back to its default.** `limit: "ten"`, `leaseSeconds: "60"`, `backoffSeconds: []` fall
  back; `match`, `pattern`, `orderBy`, `after`, `dir` are rejected. A bad bound cannot answer a
  different question; a bad selector can. Pinned in both directions so neither drifts.
- **An idempotency key travels as an HTTP header (a ByteString), so hash content into it, never
  embed it.** A key built from free-form content can carry Unicode (a tool description with `…`, a
  body with an em-dash) and `fetch` throws `not a valid ByteString`. Content-keying a record is
  right; the key must be a HASH of the content. `kindDefKey`/grant keys are ASCII by construction;
  the capability publish content-hashes the tool def (`examples/chat/space/capability.ts`).
- **A cast is a promise to the type checker, not a check.** Handlers built a `PutRequest` by casting
  wire JSON, so `parentIds: 42`, `deadlineAt: {}`, an `orderBy` string or a null body failed deep
  inside matching and answered 500 instead of 400. Found by fuzzing every field of every endpoint;
  fixed at the boundary (`pickPut`/`pickResult`, plus the numeric query-param checks) and, for
  `order_by`, in `compileOrderBy` so in-process callers are covered. **If it came off the wire,
  check it.**
- **`esc()` must escape quotes, because record data reaches HTML attributes.** The console escaped
  `& < >` only, but a grant's `pattern` renders as JSON inside `title="…"` and JSON always contains
  `"`, so every pattern-scoped grant broke out of the attribute and a crafted pattern could inject
  an event handler into a page carrying an operator token. What generalizes is the follow-up: `esc`
  being correct was never the problem, ONE call site interpolating raw was.
  `conformance/console.test.ts` checks the property structurally — every `${…}` inside an attribute
  must route through `esc` or be a ternary of literals — and immediately found two more. It lifts
  `esc` out of the page source by brace balance and fails loudly if the function is renamed, which
  is what keeps it from quietly testing nothing.
- **Client-supplied headers must win over the SDK's own credential.** Python's `_req` set
  `Authorization` after merging caller headers, clobbering them. It surfaced only with `create_run`,
  the one call authenticating with a DIFFERENT credential (the definition token). TS spreads caller
  headers last and was always right; any future "authenticate this call differently" API depends on
  that precedence.
- **`fetch` REJECTS when nothing is listening, so a stopped space is an exception, not a status.**
  The console's `api()` returns `{ok, status}` and every caller reads it, so an uncaught rejection
  froze the page on its last good render. It now maps a network failure to `status: 0`, distinct
  from any HTTP status.
- **Runtime paths belong in `src/paths.ts`, never at a call site.** Naming each where it was needed
  grew four top-level entries nobody chose as a set (`.radia-blobs/`, `.radia-kek.json`,
  `.radia-chat-space.db`, `.radia-chat-space.db-blobs/`). They default under one `./.radia`
  (`RADIA_DIR` moves it), so `rm -rf .radia` is a complete reset and the chat's sandbox denies ONE
  directory. Two properties to preserve: the KEK stays a SIBLING of the blob directory (copying
  blobs must not carry the key), and blobs stay `<db>-blobs` when `--db` points outside the runtime
  dir. SQLite will not create a missing parent, so a new path needs `ensureParent` — the error
  otherwise names the file and reads like corruption.
- **A CLI verb must read its positional through `positional()`, never `argv[0]`.** A flag written
  before the argument is otherwise taken AS the argument, and for a verb whose argument is a bare
  string the failure is silent: `radia permissions --json alice` reported on a principal named
  "--json" and printed a well-formed answer about nobody. Three verbs had it (`login`, `shred`,
  `permissions`), all added recently, all reading `argv[0]` while the other ten used the scanner.
  A new valueless switch must also join `VALUELESS` in `src/flags.ts`, or the scanner eats the token
  after it. Guarded structurally in `conformance/defaults.test.ts`, which strips comments first,
  because the rule is explained in a comment that names the thing it forbids.
- **A layering rule and a broken shipping artifact were the same defect, seen from two sides.**
  `sdk/ts/client.ts` imported the wire types AND runtime values from `../../src/`, with its own
  header saying a standalone type surface would be extracted in Phase 7. Phase 7 shipped and it was
  not, so `build-release.sh` — which stages `sdk/` and `extensions/` into the npm package and no
  `src/` — published a package whose entry point (`"." : "./sdk/client.ts"`) imported four paths
  that are not in it. The fix is directional: `sdk/ts/wire.ts` OWNS the contract vocabulary and the
  old definition sites re-export from it, so nothing inside `src/` had to move. A contract the
  client cannot ship is not a contract.
- **Any uncaught handler error must return problem+json, never a plain-text 500.** The SDK does
  `JSON.parse(body)`, so a bare `Deno.serve` 500 ("Internal Server Error") surfaces as a cryptic
  `Unexpected token 'I'` that hides the real fault. `makeHandler` wraps the dispatch in a
  catch-all (`src/server/http.ts`): a `RadiaError` maps by `statusFor`, anything else is a logged
  500 problem, so clients always get parseable JSON.

### Agent- and model-facing design

- **A turn whose TEXT is trivial is not a trivial turn** (`examples/chat/workers/router.ts`). The
  router classifies the newest user message, so "retry deep" was answered `fast` on all four rounds
  of a live turn, and a bare "continue" reads as small talk however hard the work is. Two rules
  ahead of the classifier: a tier NAMED in the message wins, and a bare continuation INHERITS the
  previous turn's tier. Both live in the router, from the discovered tier list — a `/tier` command
  in the client is the anti-pattern the design principle names. Guard: `smoke-fleet.ts`.
- **Unparseable tool arguments must be refused as a PARSE error** (`parseArgs`, `extensions/ts/turn.ts`;
  the refusal in `serveTools`, `tool-worker.ts`). Handed `{_unparsed}`, a tool reports whichever
  required field it misses first, so a malformed 16 KB `edit_workspace` call was refused with
  "needs a `workspace`" for a workspace the model did send; it could not correct and burned the
  turn's round budget. `parseArgs` also escapes raw control characters inside string literals, the
  one lexical error long arguments actually make (a model escapes newlines for 7 KB, then stops).
  Guard: `extensions/conformance/tool-worker.test.ts`, both cases proved red on a plant.
- **Testing the client is not testing the TOOL the model calls.** `smoke-selfgrant.ts` proved the
  scoped-events contract by paging the log itself and passed, but the chat calls `tools/space.ts`,
  where `space_events` fetched one page from cursor `0`. On a busy space that page is all foreign
  events, so the tool returned `{events: [], withheld: 500}` with the same cursor on every retry
  while the session's own activity sat at the far end of an 11,588-event log. Every layer underneath
  was correct. **A wrapper that adds a bound is a place a bug can hide from every test of the thing
  it wraps**; `smoke-inspect.ts` drives the tools for that reason.
- **A bounded newest-first read of a thread must expand until the turn's start is in view.** A
  tool-heavy round is a dozen messages, so "the newest N" can land entirely inside tool replies and
  miss the `user` message that began the turn. The inference worker then built a context window with
  no question in it; the router got an EMPTY question, scored it as small talk by length, and routed
  the synthesis round — the one that most needs capability — to the cheapest tier. Both expand the
  descending read until a `user` message is included, and the router never scores an empty string.
  **When a bounded read feeds a DECISION, "not found" is not a neutral default** — decide what it
  means explicitly.
- **Mutable module state is per-PROCESS, and the chat's workers are separate processes.**
  `sessionOwner()` is set by the REPL; the tools-worker imports the same module in its own process
  where nothing sets it, so `request_grant` stamped the wrong owner and the write was refused —
  killing the ONE escalation path the prompt tells the model to use, and reported by the model as
  its request being restricted, so the symptom pointed at authorization rather than a stale global.
  Worker-side code takes identity from `ToolContext.owner`, which the session stamped on the
  tool_call and the runtime already checked. Guarded structurally in `smoke-login.ts` (no
  worker-side module may IMPORT `sessionOwner`), because the call site reads correctly and is wrong
  only because of which process runs it.
- **A verdict the subject can write is not a verdict.** The exec-worker is the only principal with
  `check: put`; the chat session holds `query`. If the session could write one, "the code works"
  would be the model grading its own output. **The party being judged must not hold the pen**, for
  any evidence kind. Two boundaries that look like details: an ABSENT expectation records no verdict
  rather than a passing one, and a TIMEOUT fails `exit_zero` (a killed process has a null exit code,
  and reading that as zero turns the worst outcome into a pass).
- **An agent that discovers its abilities from records cannot discover one nothing publishes.**
  Both SDKs had `artifactCapability` since artifacts shipped and the chat had no tool for it, so the
  assistant could store a file and not hand it over: asked for a link it quoted the id-based URL (a
  401 in a browser) or invented one, because inventing was the only move left. **Before concluding a
  model "does not understand" something, check that a tool for it exists** and that a description
  says when to reach for it (`share_artifact` in `examples/chat/tools/save.ts`).
- **A status hint is a DIAGNOSIS and must be evidence-based, not timer-based.** The chat showed "no
  worker serves 'x'" after 2.5 seconds without a `progress` record, but most tools emit none, so it
  accused a worker that was about to answer. A client can prove what is ADVERTISED; LIVENESS it
  cannot, since a `capability` record outlives the worker and a scoped session cannot read the
  envelope. The hint claims only the provable half and the timeout names both possibilities.
- **Anything that abandons a turn mid-flight must answer the tool call it interrupted.**
  Escape-to-cancel lands in exactly the window that bricks a conversation, so it appends a `tool`
  reply as a timeout does. **Every early exit from a turn is a candidate for the
  unanswered-`tool_calls` bug**, and the fix belongs in the exit path they share. Cancelling stops
  only the WAITING: a claimed `llm_call` still completes and writes its result, so a message
  implying the work was undone is wrong about an at-least-once substrate.
- **An assistant `tool_calls` with no reply BRICKS a conversation, permanently.** OpenAI rejects the
  whole payload, and the thread is durable, so every later turn reassembles the same rejected
  history: 59 messages, none sendable. Produced by any throw between writing the assistant message
  and the reply. BOTH fixes are needed: `runToolCall` appends a reply on every exit path
  (prevention), and `assembleContext` pairs calls to replies in both directions (repair, the only
  thing that helps a conversation already holding one). A partially answered message keeps the calls
  that WERE answered — dropping it whole orphans the survivors and trades one violation for another.
- **A tool scoped more narrowly than the GRANT contradicts the tools that are not.**
  `list_workspaces` filtered to the current conversation while `space_count` was owner-scoped: one
  answered 8, the other none, both correctly, and the model spent eight rounds failing to reconcile
  them. The narrowing did no security work either, since the query is bounded by the grant anyway.
  Where relevance genuinely differs from permission, MARK the rows (`thisConversation: true`) rather
  than hiding them: a name the model cannot use, with no way to know why, is worse than a long list.
- **When a model cannot READ something, it reconstructs it and presents that as real.** Workspaces
  had save, list and run, no read. Asked to show a file, the model rebuilt the contents from earlier
  in the conversation, stored the reconstruction, and answered with it — noting it was a
  reconstruction, which no user reads as "this is not the file". **Fabrication is what fills a
  missing read path**, so a missing reader is a correctness gap, not a convenience one.
  `read_workspace` exists now, and `list_workspaces` reports PATHS rather than a count, because
  "what files are in X" was being answered from memory too.
- **A precondition can be real and still guard the wrong thing.** A line-range edit required
  `expectDigest`, which proves the file has not changed — and says nothing about whether the range
  points where the caller meant. A model aimed at the wrong lines, the digest matched, and the edit
  removed four structural tags while reporting that it had replaced a style block. Positional
  addressing needs a CONTENT check (quote the boundary lines), and the last line is the one that
  catches it: a caller knows what it is starting at and miscounts where the region ends. When adding
  a precondition, name the failure it does not cover.
- **A tool that returns no evidence gets its result described from intent.** The edit returned
  `changed` and a digest and no content, deliberately, to stay cheap. The caller then reported what
  it MEANT to do, discovering the real damage a turn later. A bounded window over what changed costs
  a few dozen tokens and removes the gap between doing and describing. Frugality about output has a
  floor, and it is "enough for the caller to tell the truth about what happened".
- **A tool description is only read once the model is already considering that tool.** With
  `share_workspace` in its list, a model holding a freshly split three-file page reasoned that opaque
  artifact URLs made relative links impossible and told the user no link could be given. The
  description was correct and never consulted, because the model was not asking "which sharing tool"
  — it was asking "is this possible at all". Fix: the RESULT carries the affordance at the moment it
  applies (a saved tree containing `index.html` says it is a browsable site and names the tool), the
  same move as `forked` and `incomplete`. Where a capability only becomes relevant because of what
  just happened, announce it in the thing that just happened.
- **An error that does not say what to do next gets diagnosed creatively.** `oldString not found`
  was accurate and useless: the model had guessed the text instead of reading it, concluded the
  failure was a permissions problem, and asked for a grant — which the human then narrowed, breaking
  the read access it did have. One bad message produced a three-step cascade ending in less access
  than it started with. The message now names the likely cause, says to read the file, and states
  what it is NOT. Whenever a tool can fail for a reason the caller could fix, say which reason.
- **A write-only tool is half a tool, and the missing half is the one that saves tokens.**
  `save_workspace` shipped with no LIST, so an assistant told to "fix the bug" re-created the
  project from memory and lost every file it was not currently thinking about. Whenever a tool
  creates named state, ask what reads the names back. The listing must also distinguish "no
  workspace called X" from "I could not see all of them" — only the first is safe to act on.
- **Two runners are two overlapping tools, so the same description rule applies — and only half of
  it was written.** `run_python` named `run_javascript`; `run_javascript` did not name `run_python`
  and opened with "Run JavaScript" one word ahead of four hundred about `save_as`. Asked for "python
  code finding the first 10 primes", the model called `run_javascript` with a Python program twice,
  read back a `SyntaxError`, then tried `os.system('python3 …')`. Each tool must name the other AND
  state the condition that selects it, in the OPENING clause where a model comparing tools reads.
- **A description may only name a tool that EXISTS, so a cross-reference between optional tools has
  to be built per boot.** `run_python` is published only where its jail probes clean, so a static
  `run_javascript` description naming it is unreachable advice on every host without bubblewrap:
  the model calls it and gets "unknown tool", which is the same defect as naming no alternative.
  `runJavascriptDef(pythonServed)` builds both variants, and the sibling is published BEFORE the
  description that names it — a description pointing at a tool that is not there yet is a failure,
  while one that does not mention it yet is merely incomplete.
- **Adding a THIRD overlapping tool reopens a boundary two tools had already settled.** Fixing
  `run_javascript` vs `save_content` did not survive `save_workspace` arriving: `save_content` still
  listed "code" and still claimed to be "the DEFAULT way to give the user a file", competing with a
  tool strictly better at it. All three now state the rule: a document goes to `save_content`, code
  of ANY size to `save_workspace`, a throwaway calculation to `run_javascript {code}`. **When a tool
  lands in a space another occupies, re-read the incumbent's description**, and scope its claim
  rather than dropping it — removing "DEFAULT" from `save_content` un-fixed the reason it was added,
  which the suite caught.
- **Two tools that reach the same outcome are chosen by their DESCRIPTIONS, so an unconditional
  claim beats a conditional one.** `save_content` and `run_javascript` + `save_as` both produce an
  artifact, so nothing FAILS when the wrong one is picked. The model always picked `run_javascript`,
  whose description said "that is how you save a file" with no condition and never named
  `save_content`, while `save_content` deferred to it and gated its trigger on the user saying
  "save". Asked to "create a web page", the assistant wrapped the HTML in `console.log` and stored
  stdout, sending the content twice. Each overlapping tool must name the other AND state the
  selecting condition. Guarded by `smoke-save.ts`, which reads descriptions back from the
  `capability` records the running fleet publishes — a fix never republished changes nothing.

### Method: how these were found

- **Never size one query class by the MEAN cost of all classes.** A turn costs ~122 Postgres
  queries, 23 of them `storage.now()`, so the clock looked like 19% of the latency and the cheapest
  win going. Measured with a throwaway host-clock patch (the round trip gone entirely) it is ~2%:
  `select now()` is nothing beside a put, which is a transaction writing a record, a runtime row and
  an event. The 19% came from dividing total latency by total query COUNT. Cost the change before
  building it — that hack took two minutes and saved a `StorageAdapter.put` contract change across
  three adapters, over the timestamps ordering, retention, leases and the event chain all rest on.

- **A test for a race proves nothing until the pre-fix code fails it, and the first draft usually
  does not.** Both guards in `conformance/concurrency.test.ts` passed against the exact defect they
  were written for. The paging one had TWO independent reasons: a pushable pattern is filtered in
  SQL, so a selective take sees a window of pure matches and never pages (the boundary the test was
  aiming at was never reached), and matches parked at the tail of a queue shift *toward* a paging
  claimer as rows leave, never past it. What made it decisive was changing the detector from "an
  empty answer" to ORDER: one claimer must be served in claim order, so a later match arriving first
  is a skip, and that is a trial per take rather than one per run.
- **A check written against ONE member of a set breaks the moment the set grows, and a rename is
  exactly when it grows.** The exec worker decided "this is a saved procedure, not a built-in" with
  `b.tool !== "run_code"`. Renaming that to `run_javascript` kept it correct; adding `run_python`
  beside it did not, so every Python call went down the procedure path and came back as "no
  procedure named run_python" — with the capability published and the jail working, which is why it
  read as an execution bug. It is now a `BUILTIN_RUNNERS` set. Grep for the OLD name's remaining
  comparisons before adding a sibling, not after.
- **"Deduped" at one layer is not deduped at the next.** A phase claimed the storage saving from an
  edit was ZERO, reasoning from the blob store: identical bytes share a blob. True, and the wrong
  layer — `putArtifact` creates an artifact RECORD per file per save, so a six-file tree re-saved
  for a one-line change appends six records where an edit appends one. The claim came from a real
  property of a neighbouring component instead of a measurement.
- **A header assertion cannot tell a classic script from a module.** The tree-serving conformance
  case checked the CSP and the media types and passed, while the first real page in a browser loaded
  nothing: the document was sandboxed without `allow-same-origin`, so its origin was opaque, so every
  subresource fetch was cross-origin, so `<script type="module">` failed on missing CORS. A classic
  `<script src>` survives that, which is why the hand-written fixture worked and the model's output
  did not. Where the contract is "a browser can render this", a test over response headers is a
  proxy, and the gap between the proxy and the thing is exactly one browser behaviour nobody
  remembered.
- **A tool tested with an operator client does not test the WORKER's authority.** `read_workspace`
  and `edit_workspace` were driven through an admin client, so the suite stayed green while the
  tools worker, holding `artifact: put` and no `read_one`, answered `forbidden` to every read in a
  real chat. The comment beside the grant said "WRITE only, it never reads one back": true when
  written, false the moment a reader was added. Third instance of this shape. **When a worker gains
  a capability, its grants are part of the change**, and at least one assertion must run through a
  live worker over a real `tool_call` — the only thing that exercises the identity, not the code.
  **Fourth instance, 2026-08-04, with this rule already written down.** Workspace `attach` resolved
  an artifact with `client.getRecord`, which is `/v0/ops/records/{id}`: the OPERATOR plane. Four
  conformance cases passed under an operator client while the feature could not work for any worker,
  and a live session got "no artifact" for an artifact it had just created. The shape is more
  specific than "use the worker's grants": **an SDK method that looks like an ordinary read may sit
  on the ops plane**, so check which URL a helper calls before using it in something a worker runs.
  The fix added `HEAD /v0/artifacts/{id}`, because reading a record by id had no coordination-plane
  form at all.
- **Check a cited rule's PRECONDITION before leaning on it.** "A label exists only where a lineage
  walk is too slow" was cited to leave workspace artifacts unlabelled — but there is no lineage walk
  from an artifact to its manifest (the reference is a body field, not a parent edge), so the rule
  never reached the case. The decision survived on two other arguments, which is luck. **A rule
  invoked outside its precondition is worse than no rule**: it ends the discussion while leaving the
  reasoning wrong, and the next reader inherits the citation rather than the check.
- **A dead ternary reads as a decision, which is why it survives review.**
  `{ taint: b.owner ? undefined : undefined }` looked deliberate enough that a reviewer and an audit
  both read it as a laundering hole. It was neither — the parent edge already carried the labels. An
  expression whose branches are identical is worse than a missing argument, which at least reads as
  missing.
- **Check whether a recorded defect is still there before fixing it.** Two thirds of one audit
  package had been fixed the same day it was filed, and the plan doc never caught up, so acting on
  the entry would have meant re-deriving a decision somebody had already made. Reading the code
  first cost minutes; the entry now says what was already true and what genuinely remained. A
  backlog is a record of what someone believed, not of what is.
- **A defect that SHRINKS under checking deserves the same write-up as one that grows.** One finding
  went from "write-back carries no labels" to "artifacts only" to "correct by design" across two
  corrections. Recording only confirmed defects teaches that reviews find bugs; recording the
  walk-backs teaches checking first, which is the habit that produced the right answer.
- **A structural guard certifies only what it looks at, and this one did not look at `sdk/`.**
  `layering.test.ts` checked `src/` and `extensions/` and passed while the one file breaking the
  extensions-tier claim sat in the directory it never scanned. Type imports count too: erased at run
  time, so the package runs and then fails to type-check, which is a later and more confusing
  failure than a missing value. When adding a tier rule, enumerate every directory the rule is
  ABOUT, not the ones the violation was expected in.
- **A measurement that settles one question gets read as settling the next one.** Phase 1 measured
  manifest SCALING and found the ~6 300-entry cap, which genuinely settles where a dependency set
  lives (out of line, no choice). `plan-workspaces.md` then wrote "SETTLED", and the adjacent
  question — whether the materialisation cache that decision requires is cheap or even buildable —
  was never measured and is still unbuilt. When a measurement decides something, write down what it
  did NOT decide, or the confidence leaks sideways.
- **Validating a knob you do not enforce is worse than refusing it.** `scope: {leaseOwner: "self"}`
  passed grant validation and narrowed nothing, and the failure direction is what matters:
  `authorScope` restricts only when EVERY applicable grant is `createdBy`-scoped, so a grant
  carrying only the unenforced key read as unrestricted. The operator wrote a narrowing scope and
  got none, silently, in the widening direction. Refused at grant-write time until it is built. The
  general shape: a vocabulary entry is a PROMISE, so ship it with the enforcement or refuse it —
  accepting it is the only option that lies.
- **An invariant that names a guard which is not running is the loudest kind of drift.** CLAUDE.md
  said the conformance suite runs against every implementation of every port "in CI from day one";
  the live-Postgres run was manual and the repo had no CI at all. The embedded adapters are
  single-connection, so the claim-fairness bug that motivated the invariant was invisible to them —
  a green embedded run is not evidence about the adapter people deploy. `.github/workflows/ci.yml`
  runs both. Same shape as the frozen wire contract, which nothing checked until
  `conformance/openapi.test.ts`: it found two live endpoints (`POST /v0/capabilities`,
  `GET /v0/w/{capability}/{path}`) that the spec did not mention. **Before trusting a claim about a
  guard, check the guard runs.**
- **A structural test nobody has seen FAIL is a structural test nobody has tested.** The layering
  guard destructured `matchAll` as `[full, spec]`, which binds group 1 (the import clause) rather
  than group 2 (the path), so every comparison ran against `{ Space } ` instead of
  `../core/space.ts`. It passed, green, matching nothing — the exact failure it exists to catch, in
  itself. Found only by planting a violation in each direction and asserting the guard goes red.
  Do that for every grep-shaped test; and strip comments first, since two greps in this repo have
  matched their own explanatory prose (once the comment describing the rule was the only thing
  breaking it).
- **A cache keyed on the thing being verified turns one check into no checks.** The git exporter
  fetched each artifact once and cached its blob id across versions, so a later manifest naming the
  SAME artifact with a different claimed digest hit the cache and skipped verification entirely. The
  cache now holds the digest that was verified and every manifest ENTRY is checked against it. The
  general shape: a per-fetch check is not a per-entry check, and it is the entries that are claims
  (an artifact's own digest is server-computed; a manifest's copy of it is ordinary record content).

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
- **`$regex` / `$where` / `$expr` in patterns.** Never. Patterns are data, not code.
- **Snapshot pagination cursors.** Deferred: keyset over immutable sort keys instead.
  `effective_priority` is mutable under aging, so it can't be a cursor key.
- **Eager (records × agents) candidate materialization in the scheduler.** Rejected for
  cost; candidates are incremental and capped. See [design-scheduler.md](design-scheduler.md).
- **Artifact keys derived from the caller's token.** Rejected, on four counts, any one fatal. The
  runtime stores only `sha256(token)` so a leaked DB yields no usable credential, so it cannot
  re-derive such a key without keeping the token at rest. Run tokens expire while records are
  permanent, so the blob would die with the run. An artifact is consumed by a DIFFERENT principal,
  so a producer-keyed blob needs per-recipient rewrapping (the federation-gated scheme). And since
  the runtime must decrypt for any grant-holder, the key must live where the runtime reaches it
  anyway — which is what a space KEK gives. A token authorizes the ASK (that is what download
  capabilities are); it is not key material. The built scheme is per-artifact DEK + AES-GCM wrapped
  by a space KEK, behind the `BlobStore` port.
- **Embedded mode as a weaker cousin.** Rejected: the conformance + fault suite runs on
  every adapter in CI from day one, or the backends drift.
- **Escalation-only tier routing, with no classifier (chat example).** Tried and reverted on
  evidence, and interesting because the argument was sound and its assumption false. Removing the
  pre-classifier in favour of "dispatch to the cheapest tier, let a worker `escalate`" puts the cost
  where the uncertainty is. What happened: across a tool-heavy session every turn routed cheap and
  NOTHING escalated — the model answered an aggregation question from invented numbers. **Escalation
  depends on the cheap model recognising its own inadequacy, the weakest available judge**; one
  confident enough to confabulate will not reach for `escalate`. Restored, judged by a different
  model than the one being judged, with escalation kept as the catch for under-routing.
  **Keep from the removal:** no tier name appears in `router.ts`. Tiers come from `model` records by
  `rank`, and the fallback heuristic picks by POSITION in that list, not by name.
  **Related limit, partly closed.** A `model` record advertises a TIER, not a live worker. The
  publish reads before writing (no record per worker per launch) and a worker retires its
  advertisement on SIGINT/SIGTERM. NOT fixed: a `kill -9`ed worker leaves its advertisement behind
  and the router dispatches into silence. Closing that needs liveness the substrate lacks — a
  heartbeat record reintroduces the growth, expiring advertisements need the M2 retention GC. Do not
  "fix" it with a periodic re-publish.
  **The retire/republish trap, general to content-keyed registries.** Withdrawing an entry and
  re-publishing it is not symmetric: the republish reuses the publish key, an idempotency key is
  scoped `(principal, operation, key)`, so within one principal the write REPLAYS the record being
  revived — nothing is written, the retirement stays newest, the entry is withdrawn permanently. It
  does NOT reset across restarts either: idempotency keys scope to the AGENT behind a run (Package
  U), so a relaunched worker replays its dead predecessor's writes. A revival keys on the retirement
  it supersedes (`…:after:<id>`). Caught by `smoke-fleet.ts`; no test using a fresh principal per
  step would have found it. Harmless replay for content-keyed registries (capability, model), whose
  entries survive their author; fatal for one keyed BY author — see the interest entry below.

- **A registry keyed by AUTHOR needs run-scoped idempotency keys** (`publishInterest`,
  `sdk/ts/client.ts`). Interest entries are keyed `createdBy|kind|match` and live only while their
  run is, but the publish key was content-only, so a restarted worker's publish REPLAYED its dead
  predecessor's write: no record under the new run, and every routing view of a lived-in space went
  empty at the first restart inside the 7-day idempotency window. Invisible to every suite, because
  suites run on fresh spaces with nothing to replay against. The key now carries the run, which also
  deletes the revive anchor: a new run's key is new. The ceiling check reads author-scoped
  (`checkInterestBudget`: `created_by` is a storage column), not the whole-registry liveness walk
  that cost ~1.6s per publish × 31 patterns — a worker deaf for 49s before its first claim.
  Guard: `conformance/exchange.test.ts`, "a restarted worker's interest survives".

- **The matching construct is a `pattern`, and never a `selector`.** It was `template` until the
  whole surface was renamed (wire contract, code, both SDKs, CLI, MCP, docs; the inner field stayed
  `match`), because a template reads as a GENERATOR and Radia's is a recognizer — a misreading with
  somewhere to land, since `kind_def` genuinely is blueprint-shaped. The word had also drifted:
  once `$in`, `$gt` and `$or` existed it was a small query expression, not a partial instance.
  - **Never rename it to `selector`.** That word is already taken by the ENVELOPE selector on the
    ops plane (`{state:"leased", expired:true}`), and the body/envelope split is the distinction
    these docs work hardest to keep sharp. One word across both planes would blur it.
  - **Never reintroduce "repeated-pattern" for the livelock feature.** It owned the word first and
    was renamed to repeated-SHAPE detection to free it ([design-observability.md](design-observability.md)).
  - `notes/` keeps the old vocabulary deliberately: it is the origin outline, provenance rather
    than a maintained doc, so renaming it would falsify the record. Older prior-art reading uses
    the old word too, because Linda and JavaSpaces call this argument a template.
  - Do the rename totally or not at all. A codebase that says both is worse than either.

## Risk register

From outline §13. Each risk with its mitigation:

| Risk                       | Mitigation                                                                              |
|----------------------------|-----------------------------------------------------------------------------------------|
| Semantic-matching drift    | shadow mode first, before enforcement                                                   |
| Livelock                   | repeated-signature + no-progress detection (see design-observability.md)                 |
| Hot-record contention      | admission top-K                                                                          |
| Schema anarchy             | per-kind schemas                                                                         |
| Agenda gaming              | server-computed `effective_priority`, historical calibration                            |
| Storage-adapter drift      | conformance suite on every adapter in CI, the only guard                                |
| Naming                     | PyPI as `radia-space`, trademark screen, courtesy note to Perlman, watch Radia Inc.      |
| Side-effect duplication    | at-least-once is the contract; transactional tool gateway is the mitigation (and possibly the second product) |
| Temporal encroaches on gap | don't compete on durability (Temporal's decade-hardened home ground); the differentiator is record-scoped classification/containment + content routing, which Temporal has no place for. Watch for a Temporal data-classification / per-step-permission story, the single external event that most narrows the thesis (moderately unlikely: hard to retrofit taint into an opaque-payload, no-record model; but the 2026 a16z Series D funds the attempt). See [research-positioning.md](research-positioning.md). |
