# Gotchas, rejected approaches, and risk register

Non-obvious decisions and the reasoning behind them: the "why is it like this" that the
spec alone doesn't carry. Skim before proposing a change to signing, encryption,
idempotency ordering, storage backends, or the delivery guarantee. Origin: outline §9.1,
§9.2, §13, and rationale scattered through §2–§8.

**Read a SECTION, not the file.** The traps below are grouped by what a rule constrains, so a
change to one subsystem has one heading to skim rather than nine hundred lines. Many rules are
genuinely bi-topical (a storage lesson learned in the credential path), so they sit under the thing
they CONSTRAIN, not where they were found; grep by symbol (`readExhaustively`, `lease_lost`) when in
doubt.

**Writing an entry: a bold rule, then at most 5 lines.** The rule, the mechanism, the measurement
if there is one, and the symbol or guard to look at. Cut the narrative of how it was found, what
was believed first, and anything a reader can infer. An entry past 5 lines needs cutting, not a
second paragraph: this file is read by someone skimming for a rule. `test/agentdocs.test.ts`
holds the em-dash ledger for this file; the character is banned and its ceiling only falls.

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

- **Never use `jsr:@db/sqlite`; the SQLite adapter is on `node:sqlite` (`DatabaseSync`).** The FFI
  package loads a prebuilt `libsqlite3.so` that segfaults on load (exit 139, no output) under Deno
  2.9.2 on Linux, and its first run needs `--allow-env`/`--allow-net` to download it. The built-in
  needs no FFI, no download and no `--allow-ffi`. `node:sqlite` is marked unstable upstream, so
  check its API on a Deno upgrade.

## Traps and critical decisions

> Most of the entries below are instances of ONE mistake: a registry's writes are unbounded, its
> reads were bounded, and nothing connected the two. They are kept individually because each cost
> real debugging, but the fix is structural and lives in `src/core/registry.ts` (`readExhaustively`,
> which pages to exhaustion and admits when it cannot) plus content-keyed registry writes. New code
> should not be able to re-enter this class: if you are writing `query(kind, N)` and treating the
> result as "all of them", use `readExhaustively` instead.

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
  renders SQL; `core/matching.ts` decides every match, so over-return is free and under-return loses
  a record. Inexact renders `TRUE`: object/array equality, `$each`, non-ASCII bounds, segments
  outside `[A-Za-z0-9_]` or all digits. Rendering binds parameters (`mark`/`rollback` on discard);
  `json_extract` is NULL for absent or `null` (presence is `json_type`); compares are type-guarded.
- **A path segment means three different things to the oracle, Postgres and SQLite, and the
  disagreement is in the unsound direction.** ALL-DIGIT segments (`items.0`): the oracle indexes an
  array, Postgres `#>` subscripts, SQLite `$.items.0` is a key lookup, NULL over an array;
  `pushablePath` declines them. PROTOTYPE names (`arr.length`): `getPath` reads own properties
  only. Narrow the side not describing STORED DATA. Guard: differential case, `suites/pushdown.ts`.
- **A LIMIT may only be pushed under an EXACT filter, not merely a sound one.** `Pushed.exact`
  marks it: inexact, SQL returns its first N rows, the oracle rejects some, and matching rows
  further down go unfetched. `readOne` and `query` push it only when the filter is exact AND there
  is no `orderBy` (`order by id` reproduces the oracle's `x.id < y.id` tie-break). Guard: "a limit
  is never pushed under a filter the database cannot decide", `test/conformance/suites/pushdown.ts`.
- **Postgres orders text by the database's collation; the oracle orders by JS string comparison.**
  They disagree under a linguistic collation, so the pushed limit sorts `id collate "C"` against a
  dedicated `idx_records_id_c`. Minted ids never diverge: checked with `sort`, `C` and `en_US.UTF-8`
  order Crockford base32 (digits and uppercase, all a ULID holds) IDENTICALLY and differ only on
  punctuation and case. So it guards against ids ceasing to be ULIDs; no test fails without it.
- **`indexedPaths` are a validation contract, not per-path physical indexes.** One GIN index
  (`jsonb_path_ops` over the generated `body_jsonb`) answers pushed equality on every path, so
  declaring a path costs no DDL and no migration. At 40k records a selective `read_one` is
  **7.98ms without the index, 1.42ms with**, for ~5% on `put`. Against an unselective predicate GIN
  is not used; the headline pushdown win is the pushed LIMIT stopping the scan at the first match.
- **`$in` on an array path is not membership, and the near miss is worse than the miss.** A scalar
  predicate never distributes over elements: `{tags: {$in: ["image"]}}` answers empty, and
  `{tags: ["image"]}` MATCHES by whole-list equality, missing `["image","urgent"]`. `{$any: …}` is
  membership. Named in the MCP `MATCH` description and an `explain` note (`src/core/inspection.ts`),
  never refused: the empty answer is the frozen contract (`test/conformance/suites/matching.ts`).
- **Lineage goes UP; to follow links DOWN you need children.** `parent_ids` points at what a record
  was derived from, so `getLineage` returns ANCESTORS and a root record (a `conversation`, a `job`)
  has none. Use `getChildren` / `space_children` (backed by `childrenOf`) for records that
  REFERENCE one: a conversation's messages are its children, so `space_lineage` on it answers with
  the conversation alone. The two directions are why the console has a lineage and a graph view.
- **The graph/lineage viewer excludes nothing by default except what the caller asks**
  (`?exclude=llm_chunk`): streaming `llm_chunk` records would otherwise dominate a
  conversation graph. Keep chunk flushing coarse for the same reason (event-log volume).
- **An empty allowlist is not the absence of one, and collapsing them inverts a security control.**
  `allowTaint: []` means "accept nothing classified", the STRICTEST barrier there is; `undefined`
  means no barrier at all. A helper returning `undefined` for an empty array turns the strictest
  request into no barrier (conformance caught it). The same shape recurs wherever an empty
  collection is a real answer: grant list, label set, scope. Check `=== undefined`, never falsiness.
- **Compare identities that are the same KIND of name.** `foreign` (derived from another
  principal's record) first compared the LEASE OWNER (`run:…`) against a record's `created_by`
  (the resolved caller), which are the same actor under two names, so a worker's own ack read as
  foreign against the task it had just claimed. A label that fires on everything is the saturation
  the label set exists to end. Compare against whatever will become `created_by`.
- **Do not denormalise what the log already answers; denormalise what the HOT PATH cannot afford to
  ask.** `parent_ids` plus `created_by` answer "did this descend from executed code" with a lineage
  walk: 1.3 ms over a 60-turn thread, free for an auditor asking once, ruinous inside `take`, which
  runs it per candidate (~0.3 s against a 2.4 ms claim, 125x). A new envelope field must be tested
  where a walk is too slow; `model` and `exec` failed that. See [design-taint.md](design-taint.md).
- **A RAISE and an INHERITANCE look alike and need opposite rules.** A caller asserting what the
  graph does not know ("this tree came off a filesystem") may label whatever it likes, since raising
  is monotone and needs no trust; a derived tree carrying what its predecessor carried must travel
  on the record graph and nowhere else, or the copy drifts from the fact. `writeWorkspace` does the
  first; a write-back and an edit do the second.
- **Taint follows DATA parents; delegation follows the LEASE. Never cross them.**
  `Space.computeTaint` ORs `taint:true` (client raise) with any `parent_ids` parent's taint, on both
  put and ack (the leased record is a data parent, so taint rides through `ack`).
  `delegation_context` derives from the lease, never `parent_ids`. Two separate lineages by design;
  don't compute one from the other.
- **`taint` is the one authoritative field a client may RAISE (never lower).** `put`'s `taint:true`
  is honored (source attestation); `taint:false` from a client is ignored, since propagation and
  declassify decide: the handler maps `taint === true` only, a narrow exception to "clients submit
  only claims". Clearing taint is a privileged `Space.declassify`, which emits a clean successor
  (same body, `taint:false`, the tainted original as data parent) rather than mutating anything.
- **The one operation whose purpose is accountability must name its actor and be its own event
  operation.** `Space.declassify` threads the approving operator (never `putRaw` with no principal,
  which made the successor's `created_by` and the event's `runId` the space's own identity) and
  commits a distinct `declassify` operation carrying `{declassifiedFrom}`, not a `put` nobody can
  find in the log (`test/conformance/suites/taint.ts`). An audited operation needs its own log verb.
- **The taint barrier filters candidates in core, not SQL.** It lives in `rankClaimable` (skips a
  candidate carrying any label outside the allowlist), threaded via `LeaseSpec.allowTaint`, so
  both adapters get it for free and it stays backend-neutral. It's a claim-time skip, not a query
  predicate (taint is runtime metadata, not body; the content-routing DSL can't see it, same as the
  envelope).
- **The ops query language is body-only by design; the envelope query is the ops exception.** The
  pattern DSL matches record bodies and cannot see the envelope (state, attempt, lease), so
  observability that needs it is `GET /v0/ops/records?state=…` (`Space.queryEnvelopes`, taking
  `expired`, `stale` and `kind`); diagnostics composes it. Never fold envelope state, aggregation
  (stats), DAG traversal (lineage/graph) or get-by-id into the DSL: they are first-class ops verbs.
- **Timing fields are never overloaded.** Reusing `deadline_at` as `available_at` (or any
  such shortcut) breaks retention-vs-lease separation. Keep the five distinct. `available_at` is
  the one a writer may SEED (`PutRequest.availableAt`, delayed visibility), and it stays the
  runtime's afterwards: nack, requeue and quarantine all rewrite it.

**A `kind_def` field left OUT of `kindDefKey` can never be set on an existing kind.** `registerKind`
puts under that key, so a declaration changing only an unkeyed field re-puts the same key with a
different body: `idempotency_conflict`. `usage` participates as its LENGTH plus an FNV-1a digest (a
600-character idempotency key is one nothing wants to store), omitted when absent so older keys stay
byte-identical; `contentKey` and `defaultRetentionSeconds` are keyed for the same reason.

**Never pattern-scope a grant on a kind whose bodies lack the field.** `radia team` scopes members
with `pattern: {team: …}`, and adding `kind_def: query` to that set made `space_kinds` fail exactly
as its ABSENCE did: a `kind_def` body carries no `team`, so the pattern matches nothing and refuses
every declaration. Discovery grants are a separate, deliberately unscoped set (`DISCOVERY_GRANTS`).
The rule: a scope belongs on kinds that carry DATA, never on the ones that describe them.

- **Declaring a kind another app also declares needs THREE rules, and each one stopped a boot**
  (`declareKind`, `extensions/ts/team.ts`; a redeclaration REPLACES). (1) MERGE paths and keep a
  live `contentKey` that CONTAINS yours (absent path = VALUE: `keyOf`, `src/core/gc.ts`); narrowing
  is refused. (2) SKIP a merge live by `kindDefKey` (`supersedes` is unkeyed). (3) ACKNOWLEDGE
  only refusals. Symptom: `incompatible_redeclaration`. Guard: `examples/chat/smoke-capability.ts`.
- **A long-running space serves the source it STARTED with, so a client edited today is talking to
  last week's server.** `deno run src/main.ts dev` caches modules at boot, so a space from before
  2026-08-28 answers `/v0/records/read-one` with the bare record; a FOUND one has no `record` key,
  so `?? null` calls it absent. `readOneEnvelope` (Python: `_read_one_envelope`) refuses both as
  `server_too_old`. Guard: test/http.test.ts "readOne refuses the pre-envelope response shape".
### Registries, and reads that must not truncate

**The current set of a keyed kind is `client.registry(kind)`, projected SERVER-side from the key the
kind declares.** Prefer it to `queryAll` + `activeByKey`: the key otherwise exists twice
(`contentKey` for `gc`, a `keyOf` closure at each reader), nothing checks they agree, and `gc`
deletes by one key and readers project by another. It is the only correct path from PYTHON (no
projection helper). `complete: false` means a prefix, never a set.

**Never pick from a projection BY POSITION.** `client.registry` returns a `ReadonlySet` so `.at(-1)`
no longer compiles, but a spread restores it: `[...entries]` is ordered by when each key was first
seen in a DESCENDING walk, so the last element is the key whose newest record is oldest.
`currentFleetKey` read that as "newest" and sealed to the fleet key about to be retired. Use `newer`
(`sdk/ts/registry.ts`), as `runs --for` also had to learn.

**A record missing a keyed path is an ENTRY under the absent key, not an unclassifiable one.**
`keyOf` (`src/core/gc.ts`) marks absence with a NUL, which `JSON.stringify` never emits, so it
collides with no value and `null` stays separate. Null (until 2026-08-25) let compaction keep a
provider-less `capability` that `registryOf` dropped from every projection; `gc` sweeps superseded
key-less records. Guard: `suites/gc.ts`, "compaction keeps exactly what the projection reads".

**`activeByKey` / `newestByKey` / `activeSet` take a `Population`, not a `RadiaRecord[]`.** Only
`queryAll` and `readExhaustively` mint one, so a projection over a page does not compile (the brand
found two live defects in `examples/chat/client/` that a grep had missed).
`unsafeAsPopulation(records, why)` is the way out, and `test/registrycost.test.ts` asserts the set
of sites that use it. Never `as unknown as Population`: it loses the type and the ledger at once.

**An unknown field on a `grant` or `ops_grant` body is REFUSED, because `pattern` is optional and
omitting it means the whole kind.** A misspelled `patern` validated cleanly and committed an
UNSCOPED grant, with `effectivePermissions` reporting `patterns: []`. In `validateGrantDef` (core),
not at the HTTP boundary: a grant also arrives from `createAgentDefinition` and from a definition's
grant list. Guard: `suites/auth.ts`.

**`kind_def` rejects an unknown field on WRITE and accepts one on LOAD.** A typo'd `contentKey`
silently costs the kind its compaction ([plan-registry-cost.md](plan-registry-cost.md)); but both
readers of a stored declaration (`loadKinds`, `refreshKind`) SKIP what their validator rejects, so
strictness there makes a stored kind_def an unloadable kind. `assertKnownKindDefFields` hangs off
`validateReservedBody`, never off `kindDefFromBody`. Guard: `suites/kinds.ts`, both halves.

**A handler picks fields BY NAME, so a misspelled one is dropped, and wherever that field NARROWS,
dropping it WIDENS.** `order_by`: 200 unsorted; `mach` (`/v0/records/registry`): everything; `Kind`
(`/v0/ops/remediate`): every app; `allow_taint` on a take: no barrier (absent means "send me
anything"). `rejectUnknown` (`src/server/problem.ts`) refuses by name (`put` only near-misses).
Guard `test/http.test.ts`; list [plan-bounded-reads.md](plan-bounded-reads.md).

**A tool boundary accepts BOTH spellings, because the key is a model's.** `space_query` rebuilds the
pattern from the model's args, so `order_by` becomes `undefined` and the wire's refusal never sees
it. Its description taught `order_by` while the schema said `orderBy`, so a model asked for a
descending sort got the OLDEST rows and reported one as the maximum. `pickOrderBy` reads either.

**A call site that did not WRITE the pattern must not impose a direction on it.** `queryNewest` /
`queryOldest` refuse a pattern carrying `order_by`: right for a literal (the caller asked for two
orders), wrong at a RELAY, where `order_by` is data. `space_query` (MCP) and the broker's query
proposal turned every ordered query into an error. Dispatch to `queryOrdered` when
`pattern.orderBy?.length`. Guard: `test/registrycost.test.ts`.

**A page cursor carries its direction (`nextCursor`, `a:`/`d:` + the id).** `after` is exclusive IN
THE DIRECTION OF THE READ, so a walk that took page one `desc` and page two without `dir` got
records from BEFORE page one and never terminated. Send `nextCursor` back as `cursor` and nothing
else: `cursor` with `dir` or `after` is a 400, and the TypeScript `Page` is a union so the pair does
not compile. `/v0/ops/events` and `children` keep `nextAfter`, a forward-only position in a log.

**The direction default lives in `pageClause`; read it back with `pageIsDescending`.** Resolving it
again at a call site is the same defect whether written as a comparison (`page.dir === "desc"`) or
as a default (`page?.dir ?? "asc"`), and the second shape got into the query handler while the guard
matched only the first. It builds the cursor, so a wrong answer sends the NEXT page backwards.

**`readExhaustively` builds the `Page`; a caller passes it through and never names a direction.**
The contract used to be prose ("must return records NEWEST-FIRST") and five call sites paged
ascending against it, right only because the function exhausts: on the incomplete path they would
have kept the OLDEST records, the half missing every retirement, while `complete: false` said only
that something was missing. A rule a caller can get wrong is one that will be got wrong.

- **A CONSTANT idempotency key latches a registry entry after one transition.** Within the window a
  replayed key writes nothing and reports success: `capability:<p>:<t>:retired` made a second
  withdrawal a no-op, and an unchanged content key made a re-publish over a tombstone one. Anchor
  each successor on the record it supersedes (`:after:<id>`, `extensions/ts/capability.ts`). Guard:
  `extensions/conformance/capability.test.ts`, "a withdrawal after a revival is a fresh write".
- **Reviving a registry entry needs a READ, so the publisher needs `query` on that kind.**
  `publishCapability` reads to see a tombstone; three chat workers held `capability: ["put"]` only,
  the read threw, a `catch` swallowed it, and they served tools nothing could discover. A grant list
  is part of the change when a worker gains a behaviour, and a degraded path that cannot see state
  must SAY so rather than continue. See [[architecture-workspace-agents]] on grants as records.
- **A `desc` sort puts records with NO value FIRST** (`compareRecords`, `src/core/matching.ts`).
  `compareValues` sorts a missing path last, then `desc` negates the whole comparison including that
  rule (Postgres's NULLS FIRST default), so ordering by `usage.total_tokens` ranked a user message
  above every answer. Always pair a descending `orderBy` with a match that excludes the absent
  (`role: "assistant"`, or `$exists: true`). Guard: `examples/chat/smoke-inspect.ts`, same title.
- **A body field nobody DECLARED is invisible to discovery, not just to matching.** `space_digest`
  reports declared paths, so an agent cannot learn a field exists. The provider's `usage` sat on
  every assistant `message` from the start, unreachable: asked which call cost most, the assistant
  went hunting in `tool_call`, spent a grant request on it, and answered in adjectives. Declaring is
  publishing (`examples/chat/space/kinds.ts`); writing is not.
- **`getGraph` walks parents AND children, so under a HUB record it returns every sibling thread**
  (`src/core/space.ts`). Seeded in one turn it climbs to the conversation, fans back down into all
  of them and stops at `maxNodes`: a live 346-record thread drew as 150, silently. Use `direction:
  "down"` and read `truncated`; it separates only a subtree thread ([[plan-chat-turn]]). Guards:
  `test/conformance/suites/graph.ts`, `examples/chat/smoke-turnlink.ts`.
- **`new Map(entries)` keeps the LAST value per key, not the first.** Grouping "the first record per
  turn" that way silently selects each turn's final round, and the assertion built on it passed
  against the very shape it was written to reject. Build the map with an explicit `if (!m.has(k))
  m.set(k, v)` whenever first-wins is the point.
- **`listKinds()` does not list every kind.** It reads `kind_def` RECORDS, and TEN kinds are defined
  in code instead (`kind_def`, `grant`, `signal`, `agent_definition`, `agent_run`, `artifact`,
  `interest`, `shred`, `ops_grant`, `oidc_identity`; `RESERVED_KINDS` in `sdk/ts/wire.ts` is the
  list, and this entry has drifted from it three times). Anything answering "does this kind exist"
  must add them, or it reports that `artifact` is not a kind while the caller is counting artifacts.
- **All four traps below are ONE trap, and it has a name.** A projection over an append-only log,
  read as if it were state. Two applications hit it four times in one week, none of them caught by a
  type. If you are writing a read against something that has successors, you are in this family: see
  [research-app-lessons.md](research-app-lessons.md) for the proposed ergonomics fix (`readNewest`,
  a generic `contentKey`).
- **An "already decided" sweep admits people once; it does not APPLY LATER WIDENINGS to them.**
  `sweepEnrolments` skips a principal that already holds something, which stops it undoing an
  operator's narrowing and also means a power added on a later run reaches nobody already admitted:
  `--observe` added to a running app granted it to new sign-ins only. Anything meant for EVERYONE
  enumerates `enrolledPrincipals` instead; the sweep answers a different question.
- **An idempotency key must name the CONTENT it dedupes, not just the thing it belongs to.**
  `contentKey(tag, body)` (`sdk/ts/registry.ts`, `content_key` in Python) hashes the whole body so
  no field can be forgotten; the identity keys beside it (`grantKey`, `oidcIdentityKey`) key on a
  SUBSET on purpose, so a retirement supersedes. Choose by what a re-put should mean:
  `conversation-key:<id>` replayed the first write forever, so the key now carries the wrap set.
- **`readOne` answers with the OLDEST match; use `readNewest`.** Any kind whose entries are replaced
  by successors (a registry, or key material a later write extends) is read with `readNewest` (both
  SDKs), never `readOne`. It is a `query`, so a principal holding only `read_one` on the kind is
  refused: ordering is a query. Conversation keys hit it (a second machine's successor never read).
  Guard: `test/http.test.ts`, "read-one answers with the OLDEST match".
- **Content-key idempotency dedupes for a WINDOW, and a re-put outranks a tombstone.** The content
  key is the idempotency key (`kindDefKey`, `opsGrantKey`); past `idempotencyRetentionSeconds` (7
  days) a re-put appends a FRESH record: compacted in a keep-newest registry, kept in a
  NEVER_COMPACT one (`kind_def`), and NEWER than any `retired: true` authorization tombstone. Assign
  one at identity creation (`provisionObserver`), never on a schedule. Guard: `defaults.test.ts`.
- **Filtering a cursor-paged endpoint breaks paging unless the cursor is reported separately.** An
  empty page is how every caller detects the end of a log, so a page whose events were all withheld
  reads as "nothing further" and a scoped caller could never page PAST foreign events to its own (0
  visible on a space whose first 500 were someone else's). Scan forward across raw pages rather than
  filtering one, and report `nextAfter` from the last RAW event examined (`getEventsPage`).
- **A bounded page over a registry must be read NEWEST-first, or a busy space hides the newest
  entry.** A limited query returns the OLDEST matches, so more `capability` records than the cap hid
  the newest tools; capped projections pass `{dir: "desc"}` (`ToolSet.refresh`, `Space.loadKinds`).
  The surplus: keys scoped `(principal, operation, key)` under a fresh `run:<ulid>` per launch, 24
  records per chat restart (~21 to cross 500) until `publishCapability` wrote only on real change.
- **A registry is a projection, and `retired: true` is how you withdraw from one.** A remove is a
  successor carrying `retired: true`, honoured once (`src/core/registry.ts`). Two shapes:
  **latest-wins** (`activeByKey`: kinds, capabilities, models, procedures) and **additive**
  (`activeSet`: grants, each withdrawable alone, so `grantKey` is the whole content). Retirement
  applies AFTER the newest-per-key pass, never as an input filter, by timestamp/id, not arrival.
- **Record ids are MONOTONIC ULIDs, and latest-wins depends on it.** A plain `ulid()` randomizes
  everything below the millisecond, so declare-then-retire (a same-millisecond pair) could leave the
  retirement outranked by the record it retired. It surfaced as a conformance test that passed alone
  and failed in a full run, the signature of same-millisecond collisions. `newUlid()` uses
  `monotonicUlid()`, and monotonicity is PER PROCESS.
- **Across instances the id is the TIE-BREAK, not the clock: registries order by `created_at`
  first.** A ULID timestamp is the WRITING PROCESS's clock, so id order alone imports clock skew
  into authorization. `newer` (`sdk/ts/registry.ts`) orders by the DB-clock `created_at`, the id
  deciding inside a millisecond ("prefer the retirement on a tie" broke revival). Not commit order:
  it is read before commit, so a same-DB-millisecond cross-instance race stays undefined.
- **Kinds are records (`kind_def`), and the `kind_def` meta-kind is the one bootstrap in code.**
  `Space.loadKinds` rebuilds the registry from `kind_def` records, so the Space constructor
  registers `META_KIND_DEF` first. `Space.put` special-cases `kind_def` (validate, register after
  commit and on replay), rejects re-declaring `kind_def` itself, and makes any other one a successor
  (latest per name; `kindDefKey` dedupes an identical def). No `kinds` table, no `/v0/kinds`.
- **A reserved kind may be EXTENDED by a redeclaration, never SHRUNK, on every path a declaration
  enters by.** Auth compiles `grant.principal`/`grant.kind` and `agent_definition.tokenHash`, so a
  `kind_def` dropping one failed every check with `undeclared_path`. `assertReservedCompatible`
  (`src/core/kinds.ts`) refuses a `META_RESERVED` kind losing a code-defined path or flipping
  `claimable` (`put`, `ack` results, `loadKinds`). A redeclaration REPLACES; repeat runtime paths.
- **A bounded read of a registry stays a bug after you fix its DIRECTION.** The chat tool list paged
  500 ascending and lost the newest tool at 505; `dir: "desc"` changed which vanish (**737
  capability records for 33 tools**, measured). Registry state goes through `readExhaustively`,
  never a hand-rolled `query(kind, N)`. Twice more: a `desc` page of the newest 200 `procedure` or
  50 `grant_request` drops whole KEYS, the earliest-saved procedure and the longest-waiting request.
- **A registry rebuilt only at startup is single-instance by accident.** A `kind_def` put registers
  in the WRITING process only, so a kind declared on instance A was unknown to B and a REDECLARATION
  left B on the old contract (reads only: one GIN index serves every path, so a declaration governs
  COMPILATION). Refresh follows the SYMPTOM (`unknown_kind` / `undeclared_path`: re-read the kind,
  retry once), not a timer, which has a staleness window; refresh-on-MISS alone misses a stale one.
- **`query <kind>` is not a listing when versions are records.** Three saves of one workspace are
  three `workspace` records, so a raw query answers a question nobody asked and counting its rows is
  wrong twice over. Anything registry-shaped needs the latest-wins-minus-retired projection, and it
  belongs in ONE place: `summarizeWorkspaces` is shared by `radia workspaces` and the chat's
  `list_workspaces` precisely so the two cannot disagree about what exists.
- **`KindRegistry.register` copies fields explicitly, so add new `KindDef` fields there or they're
  silently dropped.** It rebuilds the stored def (`{kind, indexedPaths, sortablePaths, …}`) rather
  than spreading, so a new field is lost on registration (`claimable` validated and persisted, then
  read back as `undefined` everywhere until `register` carried it; caught by conformance). Same for
  `kindDefKey`: include a new field there too, or a changed value won't mint a successor.
### Leases, claims, events and watches

- **A watcher wakes on the COMMIT, which beats your own `put` returning.** A transcript cursor
  advanced after the write reads the client's own message as somebody else's in that round trip and
  queues a notice for it. Claim the slot in the cursor BEFORE the write and give it back only if the
  write fails with anything but a conflict (`Thread.append`, `examples/chat/client/thread.ts`).
- **The wakeup burst's reads are COALESCED, and only reads that cannot change in flight may be**
  (`src/core/coalesce.ts`, `Space.getEvents`, `matchesEvent`). One `notify()` wakes every parked
  stream in one tick; single-flighting their identical reads measured 250+250 → 1+1 and 127ms →
  2.3ms at 250 streams. No cache: an entry lives only in flight. Coalesce only what is immutable for
  that duration, and a shared record is still authorized per watch. Guard: `test/coalesce.test.ts`.
- **Coalescing collapses reads that OVERLAP, so its benefit decays as load staggers the wakeups**
  (`bench/suites/chatload.ts`). 40 sessions / 200 streams on live Postgres: 344 queries per turn
  against 122 at 100 streams, the whole excess `getRecord` (24/turn → 242), once queued turns stop
  the burst landing in one tick. "1 query per write however many streams" holds only while streams
  wake together; the fix, should it bind, is the broadcast tailer in that file's header.
- **`notify(kind)` is kind-aware, and a new wake site must pass the right kind or wake everyone**
  (`src/core/notifier.ts`, `Space.putRaw`/`ack`). A write wakes its kind's parked streams plus the
  any-set (waking all N was N-1 wasted, `bench/suites/fanout.ts`). `notify(undefined)` wakes ALL:
  required on an AUTHORIZATION_KIND write (a revoked stream must re-scope) and wherever the kind is
  not cheaply known (a settle across kinds, the foreign-instance poll), since under-waking stalls a
  stream until its 15s keepalive. Same-kind watchers still all wake. Guard: `test/notifier.test.ts`.
- **A chat worker reads FLAGS, not the environment, unless the fleet named the variable**
  (`examples/chat/client/fleet.ts`). Workers run with the narrowest permissions, so `Deno.env.get`
  outside `--allow-env` THROWS NotCapable at STARTUP. The launcher resolves values into arguments
  (`PROVIDER_CONCURRENCY` / `LOCAL_CONCURRENCY`); a variable that must travel is named individually
  (`RADIA_CHAT_FLEET_KEY` on tools and exec), and granting it is a separate act from passing it; a
  `??` chain hides that. Guard: `smoke-fleet.ts` (spawn flags against worker source and imports).
- **A worker loop must never swallow a handler exception, whatever its logging is configured to
  do.** A no-op `log` on `agentLoop`'s nack path made a throwing handler retry invisibly, and every
  caller saw "the work never completed", indistinguishable from a worker never started. Failures
  reach `console.error` when no `log` was given, in both SDKs, with no way to turn them off; routine
  trace stays opt-in. Guard: `test/loop.test.ts` (a caller who DID pass a log gets no stderr).

- **A watch is dropped when it is IDLE, never when it disconnects.** Deleting on stream close breaks
  RESUMPTION: the cursor exists so a dropped client can reconnect to the same `POST /v0/watches` id
  with `Last-Event-ID`. The rule is "nothing attached for `watchIdleSeconds`": a live stream touches
  its watch every lap (at most a 15s keepalive apart), the sweep runs on CREATE so an idle space
  holds no timer, and `maxWatchesPerPrincipal` REFUSES with a 429 rather than evicting the oldest,
  since evicting kills somebody's live stream unannounced.
- **A watch wakeup crosses instances by POLLING THE EVENT LOG, and the poll runs only while somebody
  waits.** `notify()` knows this Space's own mutations only, and `LISTEN`/`NOTIFY` is unavailable
  (deno-postgres 0.19's `QueryClient` has no notification hook), so a parked waiter drives
  `Space.pollForForeignChanges` every `CHANGE_POLL_MS`: one query per interval per SPACE, none when
  nobody waits. Its first poll always reports a change (a record written before the baseline is
  otherwise missed), and its errors are swallowed: the poll is a hint, the log is the truth.
- **Never 410 the `"0"` cursor sentinel; clamp it.** Both SDKs recover from `410 cursor_expired` by
  resetting to `"0"` and reconnecting with no sleep, so a uniform `cursor < horizon → 410` hot-loops
  every client forever. `"0"`/absent means "from the beginning" (the oldest retained event); only an
  explicit non-sentinel cursor below the horizon is refused (`watches.ts`), compared on the storage
  port (`eventHorizon`) since cursors are dialect-shaped (seq vs. xid8). Ops reads never 410: they
  clamp and annotate (`logBeginsAfter`/`sweptBefore`), or the first sweep breaks from-zero reads.
- **Event GC's deletion order is what separates honest truncation from tampering.** `Space.gcEvents`
  holds three rules, each turning a crash into a false tamper verdict if broken: the horizon statement
  is written AND sealed before the first delete (`attestEventTruncation` must return `attested: true`,
  else the sweep walks away); events and their seals delete TOGETHER, oldest-first, per transaction,
  so every state is a clean prefix; and a cursor group (one xid) is never split, so the anchor steps
  DOWN rather than stranding a sibling. Verify accepts "begins at J" only when the newest sealed
  statement attests an anchor >= J, which lets a killed-and-resumed sweep pass.
- **`take` picks a bounded `CANDIDATE_WINDOW` (64) from `record_runtime`, holds no row locks, and
  settles one winner on a CHECKED compare-and-set.** Selecting the whole kind `for update ... skip
  locked` let one claimer's transaction lock the queue, so peers were told EMPTY while work remained
  (67 wasted takes at 4 claimers, 166 at 16; invisible to `test:runtime`, whose embedded adapters are
  single-connection). The SQL `order by` MUST stay the key `rankClaimable` sorts by, and a selective
  pattern pages to the next window rather than truncating. At 40k: 183ms to 18.4ms, empty takes
  67/166 to 2/4. `claimFairnessSuites` fails on Postgres without it: run `scripts/pg-conformance.sh`
  before trusting a change to the claim path.
- **Keep BOTH claim indexes.** `idx_runtime_claim` has the wrong column order for the claim sort and
  is partial on a predicate the window query widens, so it serves `envelopesInState` and diagnostics
  (verified with `explain query plan`); `idx_runtime_claim_order` serves the window's `order by`
  (19.5ms to 0.8ms at 40k; an earlier attempt measured no change, 58.8 vs 60.2ms, because that
  claim's cost was elsewhere). `effective_priority` is uniformly 0 until the scheduler lands (M3), so
  the two orderings look identical today.
- **SSE watch streams detect client disconnect via the response stream's `cancel()`, not
  `req.signal`.** Under `Deno.serve`'s legacy semantics `request.signal` aborts on a fully delivered
  response, so gating a long-lived SSE loop on it risks a false teardown, and reading it emits a
  deprecation warning (`--unstable-no-legacy-abort`). `handleWatchEvents` sets a `closed` flag in
  the `ReadableStream`'s `cancel()` callback and races the keepalive wait against a wake promise.
- **`take` also ranks EXPIRED-lease records as candidates, so repeated pattern takes re-claim the
  same record.** Seven puts followed by seven `take({pattern})` with a lapsed lease leaves ONE
  stranded record (each take reclaims the previous one, bumping its attempt) and six available, not
  seven stuck leases. To strand N records, take them BY ID. Reclaiming lapsed work is what take is
  for; it makes "claim several, let them expire" a trap only when building fixtures.
- **A selector on `state: available` must exclude reference kinds.** `claimable:false` records (the
  kind registry, grants, `agent_run`s, plain facts) sit available forever by design, so a selector
  without the exclusion sweeps the space's own control records into `dead_letter` with
  `dead-letter --all --stale 0`. `dead_letter` stays unfiltered, so a reference record that lands
  there is still requeueable. Caught by running the verb against a real space, not by reading it.
- **There is no `expired` record STATE.** A lapsed lease leaves the record `leased`; a later take
  reclaims it. `?state=expired` once answered zero rows beside hundreds of lapsed leases; `expired`
  is gone from `RecordState` and both OpenAPI enums, and the endpoint 400s naming the query that
  works, since expiry is a PREDICATE (`state=leased&expired=1`). Diagnostics reports `stuckLeases`
  with `atLeast` when its scan hit the cap, because a bounded scan must not present itself as a
  census. (`take.ts`'s `how: "available" | "expired"` is how a candidate was reached, not a state.)
- **Lease settlement is owner-bound, not fenced alone.** `ack` (and the other settle verbs, via the
  threaded principal) reject a non-operator principal that does not own the lease (`lease_owner`)
  with `lease_lost`, on top of the `leaseId`+`epoch` fencing. This closes lease-leak impersonation:
  an ack-emitted result is authorized as, and carries the delegation chain of, the lease owner.
  In-process/operator callers (no principal / privileged) skip the check.
- **The guarded UPDATE is the fence, so check its affected-row count, and fence BEFORE writing.**
  On pooled Postgres at READ COMMITTED another connection can reclaim the lease between an
  application-side lease check and `update … and lease_id = $ and lease_epoch = $`, so a guard that
  matched nothing still committed `{status: "ok"}` for a quarantined run. All four verbs in both
  adapters return `lease_lost` on zero rows, and `ack` runs the guarded update before the result
  insert. Single-connection embedded adapters cannot reach the race: it is fault-matrix work against
  live Postgres ([plan-validation.md](plan-validation.md)).
- **A stream opened with a raw `fetch` inherits none of the client's headers, and the failure is
  quiet.** The TS `watch()` built its SSE connect by hand and sent no `Authorization`, so every
  connect 401'd under `--auth required` and `agentLoop` fell back to polling (slow, not broken).
  Anything bypassing the client's request helper must re-add what it did. A watch id is server
  MEMORY, so a restart 404s it for good; both SDKs re-create it on a 404 (`test/loop.test.ts`).
- **A heartbeat that discards its result is a worker that never learns it was fenced.** `renew`
  reports fencing as a `{status: "lease_lost"}` BODY, so `renew(...).catch(() => {})` ignores the
  one case it exists to detect; all three heartbeats (`sdk/ts/loop.ts`, `sdk/py/radia.py`,
  `src/surfaces/mcp/server.ts`) act on it and cancel the handler. The fence has two faces,
  `lease_lost` AND 401/403 (quarantine kills the token first); everything else (a network blip)
  stays ignored; a claim known lost is not settled (a nack risks bumping the next owner's attempt).
  Watchers run on the credential's signal: only `403` was permanent, so a stopped run's watchers
  retried `401` forever and `agentLoop` never finished.
- **A column that exists is not a behaviour that happens.** `claim_until` and `effective_priority`
  are written as `undefined`/`0` everywhere and consulted nowhere, so "no new claims after this
  time" and "aged by sweeper" describe nothing (same for `retention_until`; `schema_version` is a
  constant); `take` does order by `effective_priority` and always falls through to the next
  tiebreak. Before planning against a documented field, grep for a WRITE of a non-default value.
- **A worker handler must ANSWER a permanent failure, never throw it.** `agentLoop` nacks a throwing
  handler and the record becomes claimable again (`sdk/ts/loop.ts`): right for a transient fault,
  wrong for one that cannot succeed on retry. A shredded file made `materialize` throw, so
  `run_python {workspace}` re-failed until the CLIENT's tool deadline and the user saw `timed out
  waiting for 'run_python'` with no reason; a `tool_result` instead turned a two-minute hang into a
  one-line answer in about a second. If a retry cannot help, it is a result.
- **Graceful stop ≠ quarantine.** A lease is owned by the claiming principal (`take` threads it into
  `lease_owner`; a run token → `run:*`). `stopRun` (default) only stops the token resolving: the
  run's in-flight leases expire on their own clocks, NOT immediately. `stopRun({quarantine:true})`
  is the emergency path: `quarantineLeasesOf` force-releases them now with an **epoch bump**, so a
  late `ack`/`renew` fences out as `lease_lost` (without it the stale holder could still settle).
- **Stale-available diagnostics count only `claimable` kinds; reference records are not "stuck".**
  Reference kinds (`claimable:false`: facts, config, `grant`/`kind_def`/`agent_*`, conversation
  history) are read by `query`, never `take`n, so they sit available forever. `Space.diagnostics`
  excludes them (`excludeKinds`, applied in the adapter query BEFORE the 500 sample cap, so a
  starved `task` is not crowded out by hundreds of `message`/`capability` records). Reserved kinds
  default `claimable:false`; user reference kinds must declare it; never raise the threshold.
- **A guard placed "before storage" is placed before IDEMPOTENCY, and that is the invariant it
  breaks.** An owner-match check in `Space`, ahead of the adapter call, misses REASSIGNMENT: A
  nacks, the response is lost, B claims the record, A retries its idempotency key and gets
  `lease_lost` for an operation that succeeded. The check rides on `LeaseRef.expectOwner`, applied
  inside the settle's transaction after `withIdem` has replayed; `renew`/`nack`/`release` pre-read
  nothing, and `ack` skips result authorization on a mismatch, since authorizing a stranger's ack
  as the OWNER reveals what that principal may write.
- **Idempotency is checked before lease validation, and the order matters.**
  `ack` commits, the HTTP response is lost, the agent retries; the task is now consumed
  and the lease invalid. Validating the lease first would falsely return `lease_lost` for
  a succeeded operation. See [design-api.md](design-api.md).
- **Concurrent same-key writes race on the idempotency insert; pooled Postgres exposed what
  single-connection embedded hid.** `withIdem` (`src/storage/pgbase.ts`) is SELECT-then-effect-
  then-INSERT, which serializes on PGlite/SQLite; on pooled Postgres N same-`(principal, operation,
  key)` requests all SELECT empty, one INSERTs and the rest hit a unique-violation that aborts the
  transaction (a 500). So the INSERT is `ON CONFLICT DO NOTHING`; a loser (0 rows) throws
  `IdempotencyReplay`, rolling its attempt back (its record used a fresh id), and `withRetry`
  re-runs so the SELECT replays the winner. Seen when three chat inference workers on one run
  principal each published the content-keyed `capability:escalate` at startup.
- **The watch/event cursor is the inserting `xid` (opaque), not the `seq`. Do not "simplify" it
  back to seq.** `events.seq` is assigned at insert but pooled Postgres transactions commit out of
  seq order, so a watcher consuming `seq > cursor` skips a low-seq event that commits after a higher
  one it already passed (silent dropped deliveries). `getEvents` orders by `xid` under the watermark
  `xid < pg_snapshot_xmin(pg_current_snapshot())`; `SpaceEvent.cursor` is an opaque string (seq on
  embedded, xid on pg) the transport only echoes. See [design-storage.md](design-storage.md) "Watch
  delivery under concurrency".
- **At-least-once means external side effects can duplicate.** The space protects its own
  state atomically, not your emails. Side-effecting agents need idempotency at the effect
  boundary, an outbox, or the (candidate) transactional tool gateway. This is the
  contract, not a bug.
- **Physical execution overlaps lease expiry.** A fenced worker keeps running until it
  observes `lease_lost`. "At most one valid lease" is not "at most one running process".
- **`take(record_id=...)` is a selector, not a bypass.** The server re-verifies pattern,
  grants, admission, availability, and `claim_until` every time.

### Storage, SQL and the planner

**A Postgres event cursor is `<xid>.<seq>`, and resuming compares the pair.** Comparing `xid` alone
while paging drops the second of an ack's two events (one transaction) at a page boundary, so a
`Last-Event-ID` reconnect skips it silently (`getEvents`, `src/storage/pgbase.ts`). A bare `<xid>`
(`latestCursor`, the horizon, an older client) still means everything after that whole transaction;
`resolveEventHorizon` reads the xid part. Guard: `test/conformance/suites/events.ts` (package Z).

**Every epoch comparison in a claim is NULL-safe on both adapters** (`is not distinct from` on
Postgres, `is` on SQLite, `?? null` bound). The expired-reclaim paths were not: Postgres bound the
epoch raw and SQLite `?? 0`, and though a leased row always carries an epoch today, two adapters
that agree only on the inputs that happen to occur are two claim rules the conformance suite is
testing as one. Now the same binding as the available paths (package Z).

**The page direction and its cursor comparison come from `pageClause`, together.** The SQL paths
derive the comparison from the direction and the oracle path reverses a sorted array, so deciding
them at separate sites drifts without a test failing: a 25-record kind paged 139 records with
repeats and never terminated. A shared `{dir, cmp}` pair would not help, since the pair is what
drifted. Guard: `test/registrycost.test.ts` flags a comparison against a direction literal.

**Never parent a record onto a REGISTRY entry.** Compaction deletes superseded entries and their
edges, so the lineage dangles and a later put naming that id fails `parent_not_found`; the retention
sweep drops edges the same way. Compaction is amortized per keyed kind
(`compactEveryWritesPerKind`), so this is reachable by default and not only through the `gc` verb.
Reference a registry entry by its CONTENT KEY, the way `basedOn` and the promotion pins do.

**`envelopesInState` applies every predicate BEFORE the cap, and nothing may filter after it.**
Rows sort by `available_at`, unrelated to `leased_until`, so `expired` and `staleSeconds` checked
after the adapter's `LIMIT` let a page of LIVE leases hide every lapsed one: `radia reclaim --all`
and `--drain` found nothing, `radia doctor` counted zero stuck leases beside 500 live ones. In SQL
since 2026-08-21 beside `excludeKinds` and `scope`; planted in `test/conformance/suites/admin.ts`.

- **Two processes on one local database are refused by `src/lock.ts`, not by the adapter.** PGlite
  has no locking of its own: two `radia dev --db <same dir>` both served, each `health` 200 and
  `integrity` "chain OK", at heads 5 and 7 (2026-08-20), the last to exit winning the files. Both
  local backends take an OS advisory lock on `<db>.lock` before `storage.init()`, so a SIGKILLed
  holder leaves nothing stale; the file is never unlinked, or a waiter locks an invisible inode.
- **The events table needs `idx_events_xid_seq`, or the seal walk seq-scans the whole log**
  (`src/storage/pgbase.ts`). `sealableEvents` asks for the next N events in (xid, seq) order and the
  PK is on `seq` alone, so Postgres seq-scans every row and top-N sorts to return 500. At 20M events
  (bench/README log-axis run) the window query took 2005ms and `radia integrity` 14.4s; 0.19ms and
  0.32s indexed. Sealing is on demand, so only doctor/integrity/Overview pay it. Postgres only.
- **`appendSeals` batches, and the batch must land a CONTIGUOUS PREFIX, not just the rows that
  won** (`src/storage/pgbase.ts`). Sealing runs INSIDE reads, so one INSERT per link cost ~650ms per
  500-link batch, ~80ms batched. Two sealers compute identical rows, so `on conflict do nothing` can
  win on BOTH sides of a rival's row, a hole a caller resuming at the prefix length never revisits:
  rows past the first conflict are DELETED. Guard: `test/conformance/suites/integrity.ts`.
- **A sound pre-filter is not a complete one, and the gap is measurable.** What `pushdown.ts` cannot
  express renders as `TRUE`, so `core/matching.ts` decides the whole kind in JS: 278ms at 25k, 13.6s
  at 1M (`bench/deployment.ts`, HTTP, Postgres). The budget refuses at FLAT ~2.5s (4269/3994/4119ms
  at 2.1M/3.7M/5.3M) and the walk yields (48ms worst neighbour wait in a 2538ms refusal). `$each` is
  the unpushable path the bench measures (`$any` is pushed now); a new unpushable node needs a row.
- **The scan is chunked because the budget alone would not have fixed the outage.** An inexact read
  walks 1000-row chunks (`scanChunkSize`), yields between them, and past `maxScanRows` (200k) raises
  `429 scan_budget_exceeded`. The yield must be `setImmediate`: `setTimeout(0)` costs 2.2ms a yield
  vs 0.013ms, and a microtask yields to nobody (a neighbour's indexed read waited 138ms). The budget
  is checked AFTER the early exit, or a read done inside its first chunk is refused for its size.

- **An ORDER BY can defeat the index that would have served the filter, and a partial index is
  unusable when its predicate column is a bound parameter.** `where kind=? and <expr>=? order by id
  desc limit 1` (the credential lookup) walks the kind in id order, and SQLite cannot prove a bound
  `kind` meets a partial index's predicate. Kind in the KEY fixes both, matching `SqliteJson.at`
  exactly: `(kind, json_extract(body_json,'$.tokenHash'))`, 1.23ms to 0.05ms at 3000, flat to 12k.
- **A pushed LIMIT is worth nothing if the plan sorts first, and on SQLite the primary key does not
  prevent that.** `where kind = ? … order by id limit N` plans as USE TEMP B-TREE FOR ORDER BY (the
  whole kind sorted), so `read_one` grows with the space (12.0ms at 40k records, 1 match in 7).
  `idx_records_kind_id (kind, id)` makes it an ordered seek to the Nth match: 0.05ms, flat. Postgres
  has `idx_records_id_c` for byte-order ids, which hid the gap; `explain query plan` alone shows it.
- **GC's guards each have exactly one row where they bite, and a test that misses it tests
  nothing** (`test/conformance/suites/gc.ts`). The lease floor tests `lease_id`, not `leased_until`
  (settling clears the id, not the timestamp); only a LEASED REFERENCE record shows it, the state
  guard masking it on work records. The reserved-kind exclusion bites only on a CONSUMED artifact,
  `NEVER_COMPACT` only with a contentKey on a protected kind, `parent_not_found` on a swept parent.
- **`record_edges` is a DERIVED index; `parent_ids` stays the source of truth.** `childrenOf` is a
  `(parent_id, child_id)` lookup, ~32µs flat; the `LIKE` scan it replaced went 87µs at 1k to 662µs
  at 20k. The edge is written in the record's OWN transaction, EVERY insert path writes it
  (ack-with-result included, pinned), and a one-time backfill rebuilds it for older databases; its
  test `test/backfill.test.ts` needs a PERSISTENT database: `init()` on `:memory:` opens a new one.
- **A graph walk should batch by LEVEL, but the reason it got faster may not be the batching.**
  `getLineage` fetches a depth level per `getRecords` call: 0.224ms vs 0.651ms at depth 64 in a 20k
  space. The benchmark's lineage is a chain, one node per level, so batching saved no round trips
  there; the first batched version was SLOWER (1.247ms vs 0.780ms) because SQLite rebuilt its SQL
  text per id count and re-parsed every level; caching the statement by placeholder count won.
- **Fan-out needs a bound even when the caller has one.** `childrenOf` returned every child: fine as
  an unused `LIKE` scan, a materialize-the-subtree once it became an indexed lookup people walk. Two
  limits, because they bound different things: the endpoint keyset-pages over child id, and the
  graph walk bounds children PER NODE (`maxNodes` bounds what the picture SHOWS, not what the walk
  reads). A client-side `.slice()` is not a bound: the rows are already fetched.
- **A NUL is invisible in source and lethal in Postgres.** `grantKey` joined parts with `\0`, fine
  as an in-memory Map key, `invalid byte sequence for encoding "UTF8": 0x00` once that key became an
  idempotency key. Encode composite keys (`JSON.stringify([...])`) rather than joining on a
  separator no value can contain. Note `grep -P "\x00"` will not find these: grep suppresses binary
  matches.
- **A queue is paged by KEYSET, never by OFFSET, and a CAS guards everything the read relied on.**
  An offset window assumes the rows BEFORE the cursor stay put, and in a queue claimers remove them,
  so `take` skips work and says "nothing claimable". Guarding only `state='available'` claims, under
  a stale epoch, a record nacked into backoff meanwhile. Both adapters page on `ClaimCursor`
  (`src/core/take.ts`) and CAS on state, `available_at` and epoch. Neither shows on one connection.
- **The claim index must be ordered like the claim, and `state` must not lead it.** The candidate
  window sorts by `effective_priority desc, available_at asc, record_id asc`, and an index serves it
  only with those columns in that order after `kind`. `idx_runtime_claim` leads with `available_at`
  and never applies; one leading `(kind, state, …)` sorts only WITHIN each state (a 1.4ms change,
  noise). `idx_runtime_claim_order` took a claim at 40k records from **19.5ms to 0.8ms** on SQLite.
- **A claim on Postgres is planned on a guess, and the guess is wrong by 200×.** It estimates the
  jsonb predicate at 26 rows, so it fetches all 5,715 of 40,000 matches through the body index and
  sorts. The fix is a real ESTIMATE: `PgSqlAdapter.prepareKind` (the `StorageAdapter.prepareKind`
  hook) runs `create statistics … on ((body_jsonb #> '{path}')) from records` per declared path at
  ANALYZE cost: a `take` at 20k went **9.75ms → 3.37ms p50**, 9,168 buffers sorted to 1,364 walked.
  * **ANALYZE `record_runtime` as well as `records`.** A claim JOINS the two, and without envelope
    statistics the join estimate collapses: the window query measured 48ms with neither analyzed,
    11ms with the envelope table analyzed, 1.0ms with expression statistics on top. A fresh space
    declares kinds before it has rows, so ANALYZE sees an empty table until the next autoanalyze.
  * **The two pushed terms are redundant AND correlated, and the planner multiplies them.** Pushdown
    emits `@>` (what GIN answers) AND `#> =` (exact, so a LIMIT can be pushed). For a value matching
    2,858 of 20,000 rows, `@>` alone estimates 2,858, `#>` alone 100 without statistics and 2,858
    with, the two ANDed **14 without and 408 with** (independence assumed). The residual 7× is
    structural, and neither term can be dropped.
  * **The statistics expression must match `PgJson.at` character for character**, and the path is
    inlined into DDL, so `prepareKind` calls `pushablePath` and skips any path pushdown declines.
  * **`pg_statistic_ext` is server-wide; a statistics object is not.** Checking "already created?"
    by NAME alone let the first space to declare a path claim it for the whole server, every other
    schema planning on the guess forever. Scoped by `stxnamespace = current_schema()::regnamespace`;
    pinned in `planner.test.ts`, and the conformance harness hits it on every run (one PGlite,
    per-test schemas).
  No query rewrite fixes it (`join` vs `exists`, with or without `@>`, all plan the same;
  `enable_seqscan`/`enable_bitmapscan` off is worse, 28.6ms), and an unfiltered first window (the
  head of the queue, then the filtered query) was **reverted**: it wins only when the head holds a
  match, and every measured cell got worse (sqlite 1.0 → 1.3ms, Postgres 22.7 → 28.6ms). Corollary
  (2026-08-11): only the DURABLE declaration path calls `prepareKind`, not `registerKind`. Declared
  with `registerKind`, a Postgres `take` measured 23.6ms and grew with the space; as a `kind_def`
  record, 10.5ms and flat. A bench using `registerKind` measures a plan no client gets;
  `bench/suites/scale.ts` declares durably.
- **The Postgres driver needs TCP_NODELAY or every parameterized query costs ~40ms.** deno-postgres
  (0.19.x) does not set it, so extended-protocol queries hit Nagle + delayed-ACK: **42ms per query
  vs 0.18ms** with NODELAY (a put+take+ack cycle went 602ms to 10ms). Simple queries do not show it,
  so microbenchmarks hide it. `src/storage/postgres.ts` wraps `Deno.connect` once, since the driver
  exposes no socket option (raw TCP only, not `fetch`/`Deno.serve`); drop it once the driver does.
### Credentials, tokens and sessions

- **Renewal is a LIVENESS protocol, so it only serves holders that are alive.** `renewRun` needs a
  process awake inside the window: not a laptop that slept, a fresh CLI process, a closed tab, or a
  replayed stored secret. An `agent_definition` has no expiry, `POST /v0/agent-runs` mints a run
  from it, and the space REFUSES that token for coordination. Hold both, exchange on expiry; renew
  only where lease ownership must survive (exchange changes the `run:` principal and fences claims).
- **`health().principal` is `anonymous` until the credential resolves.** The endpoint is public, so
  a client holding only a definition token answers `anonymous` while its requests arrive as the run
  behind that token. Ask `permissions` about that name and the self carve-out in `http.ts`
  (`asksAboutSelf`) misses, so the refusal is about the ops plane, not what was asked. Always
  `await client.ensureCredential()` first (`examples/chat/chat.ts`); guard: `test/team.test.ts`.
- **A retry wrapper must not wrap the retry.** Routing the credential exchange through the same
  `req` that triggers it made a FAILING exchange re-enter the wrapper, await the in-flight exchange
  it was already inside, and deadlock: a revoked definition hung the caller instead of reporting
  itself. The exchange uses a raw request with no retry. Found by the test, not by reading.
- **`radia dev` writes the credential file only after the bind, and its shutdown clear names its
  own token** (`src/main.ts`; `clearCredential(base, onlyIfToken)` in `src/credentials.ts`). A
  second dev losing the port race otherwise overwrites the running space's operator entry at
  startup and deletes it in its `finally`, so every CLI verb against the healthy space gets
  `auth_required`. Guard: `test/defaults.test.ts` "losing a port race".
- **One credential file, two identities.** `radia dev` provisions an OPERATOR credential per space
  and `radia login` authenticates a PERSON against the same space. Keyed by base URL alone the
  second silently replaces the first, and the CLI's remediation verbs, the chat's bootstrap and the
  MCP adapter all act as whoever logged in last. Logins live under their own suffix; the operator
  entry is never touched. Guard: `test/exchange.test.ts`.
- **`newestByHash` picks the newest by the DB clock, never by id.** A record's id is a ULID minted
  by the INSTANCE that wrote it, so a stop written by an instance whose clock runs behind sorts
  BEFORE the run it stops, and "newest by id" resolved a stopped token as live. A handful of rows by
  id, then `newer` (created_at first) picks: still one narrow read of one hash (package Z). Guard:
  `test/credential-order.test.ts`.
- **`writeEntry` in `src/credentials.ts` is locked, atomic, and refuses a file it cannot parse.**
  A `read` answering `{}` for a torn file let a booting space write back a file holding only its
  own entry, losing another's operator credential (2026-09-04). Now `withFileLockSync` on a sibling
  `.lock`, a temp-file rename, an error for damaged JSON; and every spawner of a `dev` sets
  `RADIA_CREDENTIALS` to a temp path. Guard: `test/credentials.test.ts`, twenty processes at once.
- **"Public route" means no credential is REQUIRED, not that a bad one is ignored.** `GET /` and
  `GET /v0/health` skip authentication so the console can bootstrap under `--auth required`. Only
  `auth_required` (nothing presented) is exempt; every other resolution failure is a 401 on public
  routes too, or an expired or garbage token gets `200 {principal: "anonymous"}` from the one
  endpoint a client uses to ask whether its token still works.
- **Cache what cannot change; never cache what can be revoked.** A credential's whole content is
  freshness, which a registry cache trades away, and the fail-open is silent: a bounded startup
  rebuild left a STOPPED run's token resolving after a restart, and `stopRun` consulting the cache
  first answered `applied: false` for a run it had not seen. `Space.resolveToken` reads records per
  request; `CredentialStore` (`src/core/auth.ts`) keeps only operator tokens and the run→agent memo.
- **The credential index was rebuilt from a bounded page too, and the fix was to delete the index,
  not widen the page.** `loadCredentials` read the OLDEST 5000 `agent_definition`/`agent_run`
  records, both of which accumulate, so at 5202 run records a STOPPED run's token still resolved
  after a restart. The cache is gone (see "cache what cannot change"); `runsForAgent` (which
  principals count as me) wants HISTORY: `Space.runPrincipalsOf` now, over `agent_run` by `agent`.
- **`created_by` and idempotency scope are the RESOLVED caller, threaded from the handler, not
  `ctx.principal`.** `put`/`ack`/settle take an optional trailing `principal`, which the handlers
  fill with the resolved caller: `created_by`, the event `run_id` and the idempotency key scope all
  follow it; omitted, it is the space's own identity (`local:dev` for conformance and `demo.ts`).
  Enforcement is HTTP-side; in-process callers exercise `authorize`/`bodyMatchesGrant` directly.
- **Default principal is the operator, so dev stays open; enforcement only bites a real token.**
  An unauthenticated request resolves to `human:local` (privileged), so the UI, demo, and examples
  work with no auth. To act as a scoped principal, mint a real run token via the bootstrap chain;
  there is no impersonation shortcut (the dev-only `X-Radia-Principal` assume-header was removed: a
  client must never choose its own identity, so a single Bearer channel is the whole story).
- **`--auth` defaults to REQUIRED, and the loopback bind is the second layer, not the first.**
  No bearer: `401 auth_required` (`ServerOptions.authRequired`); `--auth open` opts back into the
  no-header operator shortcut, safe only locally. `radia dev` binds `127.0.0.1`;
  `--host 0.0.0.0` opts in. `GET /` and `GET /v0/health` stay public in both modes, so the console
  can bootstrap and a client can tell "no space here" from "not allowed"; neither carries one.
- **The operator token is a server-lifetime in-memory credential, not a record, and it never
  travels in the served page.** `Space.mintOperatorToken` registers a hash resolving to privileged
  `human:local`; it never expires, dies with the process, and nothing revokes it. Never bake it into
  `index.html`, where anyone on the port can read it (`GET /` is public). The console keeps it in
  `sessionStorage`; `test/console.test.ts` fails on a credential-shaped literal or placeholder.
- **The operator token resolves as `kind: "operator"`, never `"def"`.** Resolving it to something
  that 401s breaks the CLI, MCP and `curl`; resolving it as a DEFINITION token lets a leaked
  unrevocable credential mint long-lived run tokens. It authorizes everything and mints nothing: a
  distinct `ResolvedToken` variant (`src/core/auth.ts`), accepted by `resolveAuth` beside `run` and
  refused by `mintRun`, so the escalation is closed at the source (`test/http.test.ts`).
- **The open-mode no-header shortcut is for `curl`, and nothing radia ships may rely on it.** No
  credential resolves to `human:local`, the operator: the largest authority a space has, acquired by
  nobody having typed anything. The console and the chat refuse to start without a token, the
  shortcut sits behind an explicit `--auth open`, and the examples read the provisioned operator
  credential (`examples/operator.ts`) so they exercise the authenticated path they demonstrate.
- **Never let a launch flag pick between "scoped" and "operator": the privileged posture becomes the
  default.** A role setting that defaults to operator runs privileged unless you know to say
  otherwise, and describes how the process was started rather than who is using it. Authority is a
  property of the CREDENTIAL: the session is whoever the supplied token belongs to, and whether that
  reaches the ops plane follows from the grants that principal holds.
- **Short run tokens need a RENEWAL path, or every long-running process dies mid-task.** 15 minutes
  suits a leaked credential, not a live session (`token_expired` mid-write, or a worker that
  silently stops claiming). Renewal is a successor `agent_run` with the SAME tokenHash. A stopped
  run cannot be revived (revocation wins), renewal never passes `mintedAt + runMaxLifetimeSeconds`,
  and an expired token cannot renew itself, so clients renew at HALF-LIFE (`RadiaClient.keepAlive`).
- **Credential keep-alive belongs in `agentLoop`, not in each agent.** Every process running that
  loop is long-lived by definition, and the five chat workers each needed it. One place, and an
  external agent author gets it without knowing it exists.
- **A public endpoint still rejects a BAD credential, so `401` never means "the space is down".**
  `/v0/health` and `GET /` skip the auth requirement, but `resolveAuth` rejects a presented token
  that does not resolve, on every path, so an expired run token `401`s on the endpoint a client uses
  to prove the space is up. A client polling health must separate `401` (credential) from
  unreachable (space): run tokens expire in ~15 minutes, so this is the ordinary end of a session.
- **The provisioned credential is keyed by HOST, so `localhost` and `127.0.0.1` are two spaces.**
  `baseKey` (`src/credentials.ts`) keys on `protocol//host`, and `radia dev` binds `127.0.0.1`, so
  anything defaulting to `http://localhost:7788` finds no credential for a space it can otherwise
  reach. Every default agrees on `127.0.0.1`; `baseKey` does NOT alias the two, since a helpful
  normalization surprises someone later, and the error message names the trap instead.
- **Two branches of one function, one checking its credential's status and one not.**
  `resolveCredential` checked `agent_run` for `status`/`expiresAt` but returned `{ok: true}` for an
  `agent_definition` on the mere EXISTENCE of a record, so a leaked definition token minted runs
  forever. Fix: the run's shape, a successor with the SAME `tokenHash`, so revocation rides the same
  indexed lookup. Two things in one function of the same KIND: read them side by side.
- **A credential that mints authority must not be able to name a privileged subject.** A definition
  mints runs for its subject, so `createAgentDefinition("human:root")` on a space whose operators
  include it was a permanent way to mint privileged runs (and, before revocation existed, an
  unrevocable one). Refused at mint. Wherever a factory takes a principal, check it against the
  identities whose authority is NOT expressed as grants, because nothing downstream narrows those.
- **Revoke and stop are different decisions and must stay separate verbs.** Revoking a definition
  leaves already-minted runs alive on purpose: conflating them would make "stop handing out new
  authority" also mean "kill the work in flight", which have different blast radii and belong to
  different moments in an incident. Revoke first, then stop the runs that matter.
- **Privilege is a NAMED SET, not a name prefix, and `human:` is a namespace.** `isPrivileged`
  (`src/core/space.ts`) checks `ctx.operators` (default `["human:local"]`) and the space's own
  identity; the supervisor is NOT in it (architecture-ops-tiers.md phase 5: a `grant`/`signal` put
  carve-out in `authorize`, nothing more). `radia login human:alice` and the console's Auth tab
  depend on it: a logged-in `human:alice` cannot write `grant`/`signal`/`agent_*`.
- **Ask the space who a credential belongs to; never infer it from the fact that one exists.**
  `GET /v0/health` reports the CREDENTIAL (`run:…`); `GET /v0/ops/permissions` reports its subject
  and whether it is privileged, and any principal may ask about itself. A console labelling itself
  "operator token" whenever a token is set shows authority a scoped session does not have; the chat
  resolves the login token's owner this way, never from a body field (`Space.effectivePermissions`).
- **A presented `Authorization: Bearer` token must resolve; a bad one is 401, never a silent
  fall-through to the operator.** Only the absence of any credential defaults to `human:local`;
  `resolveAuth` in `src/server/http.ts` encodes it (Bearer: run principal, else operator).
  `POST /v0/agent-runs` is dispatched BEFORE the bad-bearer 401 check and reads its DEFINITION
  token directly, since `resolveAuth` answers `invalid_token` for one (no coordination principal).
- **Only token HASHES are stored, and the records are the authority on every request.** Tokens are
  secrets returned once at mint; `agent_definition`/`agent_run` bodies hold the sha256 hash, and
  `Space.resolveToken` reads the newest record for it per request, with no cache. A stop is a
  successor `agent_run` with the SAME `tokenHash`, so the mint's indexed lookup finds it. A
  token-shape regex keeps garbage off the query; expiry uses the DB clock, read only with a token.

- **Ops tools are served by the SESSION, in-process; a worker must never hold a person's token**
  (`examples/chat/client/session-tools.ts`; its header holds the proof: a delegated run has no ops
  powers, so no worker can serve them for someone else). A worker handed the login at launch keeps
  it, so a lapsed short half re-minted in the REPL's memory ships DEAD to the worker, which then
  answers `token_expired` to every `space_*` call. Repair cannot span processes: delete the handoff.

**An empty environment variable is an ABSENT one; `??` keeps it.** `resolveDefinitionToken`
(`src/credentials.ts`) and `src/surfaces/mcp/server.ts` use `||`, since harness configs and wrapper
scripts export every name they know about, empty ones included, so
`env("RADIA_TOKEN") ?? env("RADIA_DEFINITION_TOKEN")` gets `""` for an exported `RADIA_TOKEN=`: the
definition token is lost and `radia mcp` comes up as the observer. Guard: `test/exchange.test.ts`.

**A second `agent_definition` for one agent is not a rotation, and looks exactly like one.** Both
tokens keep minting, while `revokeDefinition` reaches only the NEWEST record
(`Space.definitionRecord` reads the newest 5 desc and takes the first with a `tokenHash`).
`radia team add` therefore refuses an existing agent and names `--rotate`, which revokes first
(`definitionState`, `extensions/ts/team.ts`). Guard: `test/team.test.ts`, the shadowed token mints.

### Grants, scopes and narrowed answers

**The grant union `combineMatch` builds is exempt from the caller's `$or` cap, and nothing else is.**
`MAX_OR_BRANCHES` (16) bounds what a caller asks (`400 too_many_branches`); the union is bounded by
the grant ceiling, so `grantUnion` in `src/core/matching.ts` marks it with a symbol-keyed property
no JSON caller can forge and folds single-field equalities into one `$in`; the 64-node cap
(`ctx.exemptNodes`) and 8 KB cap (`callerHalf`) excuse it. Guard: `test/conformance/suites/auth.ts`.

**An identical live re-put of an uncompactable registry is ABSORBED, not written.**
`Space.checkRegistryBudget` answers `grant`, `ops_grant` and `kind_def` with the record already
carrying the entry, since content-keying dedupes only inside the idempotency window. Compared by
BODY: `grantKey` excludes `scope`, so absorbing on identity dropped a narrowing; a different body
under a live identity writes even past a ceiling. `signal` and `agent_definition` are excluded.

**A registry is either compactable or capped, never neither.** An uncompactable one is read whole
forever. `grant` (256 per principal+kind) and `ops_grant` (64 per principal) are capped by
`Space.checkRegistryBudget`; `kind_def` is neither. The cap never refuses a withdrawal, refuses an
incomplete read, writes a differing body under a live identity (it must not block a write that
REDUCES authority) and ABSORBS an identical re-put (exempted, 40 re-puts passed a cap of 10).

- **`put` never checks that a parent is READABLE, so ancestry is forgeable.** A scoped principal may
  name any record id in `parentIds`, so every upward walk stops at a foreign ancestor rather than
  skipping it (`getLineage`, `getGraph`), or naming a victim's record as parent would hand back its
  whole upstream. An ancestor scope is unsafe by construction, a DESCENDANT scope safe (nobody can
  make another's record their child); [research-app-lessons.md](research-app-lessons.md) action 6.

- **A delegated run can never exceed its CALLER, so a worker capability cannot be delegated**
  (`intersectGrants`, src/core/space.ts). Authority is `worker INTERSECT caller`, so what the caller
  lacks intersects to nothing: exec's `check: put` and `workspace: put` stay on its own token (the
  session holds neither; under `delegable:` they broke `save_procedure`). Split a worker's
  grants READ/WRITE, never "session data". Guard: test/delegation.test.ts "a SUBSET on every axis".
- **Anything that mints an `agent_run` per call grows a table GC never sweeps**
  (`Space.mintDelegatedRun`): reserved kinds skip retention, compaction keeps newest-per-`run`, and
  `runPrincipalsOf` pages every row. Derive the token from the caller's credential plus everything
  that can CHANGE, so an unchanged run is found by `tokenHash` and writes nothing, and reuse never
  mutates a run whose authority is memoized. Guard: test/delegation.test.ts "REUSES its run".
- **A per-caller credential cache keyed only by the CALLER belongs to one worker, not the module**
  (`delegatedClients`, extensions/ts/tool-worker.ts). A module-level map shared by two `serveTools`
  calls hands worker A the delegated client worker B minted: another worker's authority under the
  same caller. Evict on lookup too: author runs rotate (12h ceiling, a fresh run per login), so a
  long-lived worker otherwise accumulates one dead entry per run.
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
  kind nobody declared hunted for a grant that could never help. The status and code stay 403
  `forbidden`; only the sentence grows, the remedy in the SPACE's vocabulary ("query `kind_def`"),
  not a surface verb. Guard: test/delegation.test.ts "a refusal SAYS when the kind does not exist".
- **A worker must never read a record named by a BODY FIELD using its own authority**
  (`contextFor`, extensions/ts/inference.ts; package V in plan-audit-remediation.md). A body is a
  claim: `bodyMatchesGrant` bounds what a caller may WRITE, not what a worker reads for it. The
  `window <= 0` branch took `conversationId` from the body without `owner: body.owner`, so a session
  could read another owner's conversation. Dereference as the CALLER or conjoin the caller's scope.
- **A principal acts through TWO run classes, and a query for one silently leaves the other alive**
  (`radia runs --for`). Own sessions are `agent_run{agent: X}`, a worker's runs on their behalf are
  `agent_run{actingFor: X}`, and stopping one class left the person chatting up to the 12h ceiling.
  `revoke` closes neither (stops MINTING only; nothing for SSO). `team remove` stops both, retires
  grants and ops powers. Guard: test/delegation.test.ts "offboarding needs BOTH run classes".
- **A one-off manual grant to a long-lived principal hides gaps in the standard set**
  (`userGrants`, examples/chat/space/roles.ts). `kind_def:query` was hand-granted to one person in
  August and never added to the set, so `space_kinds` worked for them and 403'd for every FRESH
  identity, first seen when OIDC minted one. Test defaults with a new principal, never an
  accumulated one. Guard: smoke-login.ts "a fresh session can discover kinds".
- **A worker's `progress` record must carry `owner`, or an identity-scoped session cannot see it**
  (`examples/chat/workers/router.ts`). The default scope is `{owner}` and a pattern NARROWS rather
  than errors, so the router's `routing`/`routed` records were filtered out and a call it claimed in
  60ms timed out. Any field a scope can bind on is required on every record a scoped reader must
  see. Guard: `smoke-turnlink.ts` "an identity-scoped session sees 'routed' progress".
- **A bounded read that decides a SCOPE is not a performance question, it is an authorization one.**
  `runPrincipalsOf` answered "which principals count as me" from 1000 rows, so an agent's OLDEST
  records fell out of its own self-scoped reads. It pages via `readExhaustively` and throws
  `registry_incomplete`; five client reads route through `RadiaClient.queryAll` / `query_all`, which
  THROW instead of returning a prefix. Guard: `test/conformance/suites/auth.ts`, 1201 runs.
- **Every grant read is a bounded page over records that ACCUMULATE, and truncation misauthorizes
  silently.** Re-defining an agent appended a grant record per boot; `authorize`, `authorizeWatch`,
  `authorScope` and `opsScope` read a capped page: at 101 records a granted principal was DENIED, at
  122 a REVOCATION kept working. Writes are CONTENT-KEYED now and reads take the NEWEST page, which
  alone is no fix: no single page direction is correct over a set larger than the page.
- **Scoping by AUTHOR does not mean what "my records" means to a user.** The chat's results, chunks
  and artifacts are written by WORKERS under their own principals, so `createdBy: self` hides a
  session's own tool output. The session stamps `owner`, workers copy it, and the grant binds
  `{owner}`; `RADIA_CHAT_SCOPE` picks that or `{conversationId}`, and only the latter separates two
  people without `RADIA_CHAT_TOKEN`, since `agent:chat-user` is one constant.
- **Tightening a grant by adding a PATTERN is inert on any space that already had the loose one.**
  Pattern is part of a grant's identity: `{message, [put,query], pattern:{conversationId}}` beside
  an existing `{message, [put,query]}` is a SECOND grant, and grants union. `createAgentDefinition`
  retires the unpatterned twin of each grant it declares and every live grant on the same
  (principal, kind, operations) whose pattern DIFFERS, bounded to that triple and excluding `scope`.
- **A content-keyed registry write cannot revive what it retired, and a supersede that runs per
  entry retires its own siblings.** Idempotency rows never expire: a re-declared grant wrote NOTHING
  as `supersedeGrantsFor` retired the live one. `src/core/space.ts` suffixes the key
  `:after:<recordId>` of the newest RETIREMENT, `supersedeGrantsFor` skips the WHOLE declared set's
  keys, and retirements key on the RECORD retired. Guards: `suites/retire.ts`, `smoke-selfgrant.ts`.
- **A withheld count with no reason sends every agent hunting for a grant that cannot exist.**
  `/v0/ops/events` filters by which principal PERFORMED the operation, so no record-kind grant
  widens it, but the response said only `withheld: 65923`, which reads as "you are missing a grant":
  four sessions spent their turns requesting grants that could not help, two inventing a kind to ask
  for. The response carries `withheldNote` now.
- **An approval prompt whose label does not match what it grants, and whose keys read as "yes".**
  The narrow option said "only its OWN records, reads only" then granted the request VERBATIM,
  `take` on `llm_call` included: self-scoping is a read filter, not a claim filter. It now grants
  the reads ONLY and names what it withheld. The keys were `y`/`a`/`n` (`y` meant NARROW); options
  are words now (`own`/`all`/`no`), nothing means "yes", and an unrecognised answer is re-asked.
- **An escalation that costs two turns and two human inputs per grant does not converge.** Sessions
  ran out of tool rounds retrying after each approval. `request_grant` BLOCKS on the decision and
  the REPL reviews pending requests while the call is in flight (`onToolWait` in `turn.ts`), so the
  answer lands in the same turn. The decision travels as a successor `grant_request` record carrying
  what was ACTUALLY granted; the tool's deadline is human (240s), the REPL's longer.
- **Kind-scoped is not conversation-scoped: every chat session ran as one agent, so each could read
  every other session's messages.** (`USER_GRANTS`) Grants are now PATTERN-scoped to the
  conversation (OPERATOR-created; a session has no `conversation: put`); `llm_chunk`, `llm_result`
  and `tool_result` carry `conversationId`; `Space.putArtifact` merges `x-radia-meta` with runtime
  fields LAST; patterns UNION, so approval inherits the replaced pattern (`smoke-inspect.ts`).
- **A self scope must narrow the plane the agent actually READS through, and grants UNION.**
  `scope: {createdBy: "self"}` narrowed only the ops plane while `query`/`read_one` returned every
  record of the kind. `Space.authorScope` now covers the coordination plane for reads only (`take`
  excluded: claim-then-reject is no filter). Since grants UNION the approval must RETIRE the wider
  grant, and `authorScope` restricts only when EVERY grant permitting that operation is self-scoped.
- **Every read verb must resolve its scope through ONE path, or the verbs that forget serve
  everything.** `Space.readAccess(principal, op, kind)` returns `{constraint, createdBy}` TOGETHER.
  `take` carries it into the CLAIM (`LeaseSpec.createdBy`), lineage/graph treat a foreign record as
  a WALL, artifact reads apply it before the bytes and the capability mint; `effectivePermissions`
  computes reachability per GRANT. Guard: `test/http.test.ts`, one row per read verb.
- **The ops aggregate is self-scoped even where READS are not, so it must say which kinds it
  under-counts.** An unscoped `{put, query}` grant can live beside a self-scoped `{query}` on one
  kind, so a principal can LIST every record while `ops/stats` counts only its own: 187 messages
  counted where `space_count` said 578. It carries `alsoReadableInFull` now; widening the aggregate
  instead gives every unscoped bootstrap grant full ops visibility. Guard: `suites/selfscope.ts`.
- **A narrowed answer is dangerous because it is SHAPED exactly like a complete one.**
  `POST /v0/records/query` returned `{records, nextAfter}`, so a scoped caller reported its slice
  as the whole. It carries `scope: {narrowedBy, ownRecordsOnly, note}` only when a grant narrowed
  the read (an unrestricted read is byte-identical). Ops responses carry `scope: {self, kinds,
  note}` (`describeScope`, `handlers/ops.ts`), which the chat's tools pass through.
- **A grant on a kind that does not exist authorizes nothing, and everything downstream reads it as
  access.** A session asked for `space_event` (the tool is `space_events`; no such kind), a human
  approved it, and the phantom kind appeared in every `scope.kinds` line the ops plane returned. The
  grant is honoured as written (a grant may precede its kind), but `effectivePermissions` marks the
  row `kindNotDeclared: true`, the one answer an agent is told to trust about its own authority.
- **A scoped agent must be able to ask what it may do, and the ops plane refused exactly the
  principal that needed to.** `GET /v0/ops/permissions` was operator-only and `opsScope` throws for
  a principal with no self-scoped grants, so the caller that had just asked for some got a 403. The
  self-read is checked BEFORE the plane's gate (`asksAboutSelf` in `http.ts`, matching the principal
  or its grant subject); anyone else's needs the `observe` ops power or an operator.
- **An escalation protocol that cannot express WHOSE records are needed keeps producing grants that
  authorize nothing.** `request_grant` carried kind and operations only, so an assistant needing
  others' records could only ask in prose. The request carries `scope: "own" | "all"` now; `scope`
  is part of its identity key, or an un-scoped re-ask dedups into the handled one; choosing narrow
  against a measured-empty exposure PRINTS that it authorizes nothing. Guard: `smoke-inspect.ts`.
- **Self-scoping a REGISTRY kind grants a view of nothing, not a narrowed one.** `createdBy: "self"`
  is right only for a kind the principal WRITES: `kind_def`, `capability`, `model` and `procedure`
  are written by whoever declares them, so a self-scoped session sees zero and `space_kinds` answers
  `[]` on a space with twelve. The approval prompt (`client/grants.ts`) MEASURES the exposure and
  recommends against self-scope when it is none, never from a list of registry-ish names.
- **A read grant without `query` is a session that cannot find its own work.** The chat gave itself
  `artifact: read_one` and no `query`, so "which artifacts do I have?" was unanswerable: it could
  fetch an id it knew and not discover one, and asked a human to widen a grant to see its OWN files.
  When a kind is scoped by pattern, `query` adds no exposure the pattern does not already bound, so
  withholding it costs discovery and buys nothing. Check both verbs for any "my records" grant.
- **`{owner}` and `{conversationId}` scope are different code paths, and only one was tested.**
  `smoke-selfgrant.ts` covers the escalation loop under `{conversationId}`, which is not the default;
  both bugs above reproduce only under `{owner}`. A suite that exercises one posture of a documented
  either/or is not covering the feature. `smoke-login.ts` now carries the identity-scope half.
- **Narrowing a grant can leave a session with LESS than it had, and the prompt said so too late.**
  Approving `[own]` retires any wider grant carrying the same operations (grants union), so a scoped
  user's `artifact: read_one` (workspace files) vanished when a human chose `[own]` on an unrelated
  artifact request, and the consequence line printed AFTER the decision; an option that removes
  access is never the recommended one. `smoke-selfgrant.ts` asserts the warning's POSITION.
- **`delegation_context` is derived from the LEASE, never `parent_ids`; and only for managed-run
  work.** On `ack` the chain comes from the leased record's authoritative `lease_owner` (the
  envelope's, never the client's). It is set only when the lease owner is non-privileged, so
  operator/root work carries none; `isPrivileged` also covers the space's own
  `ctx.runId`/`ctx.principal`, since in-process callers claim under `run:local` and must stay root.
- **Strict chain-intersection was rejected as the ack gate, because it breaks pipelines.**
  "Effective permission = intersection of the whole chain's grants" (design-auth), enforced on every
  `ack`, blocks fan-out/aggregator: in `a → b`, agent `b` produces a kind `a` cannot. M1 authorizes
  the acting agent's OWN `put` grant (`Space.ack` → `authorize(owner, "put", kind)`); a forbidden
  ack throws before consuming, so the record stays leased. Full intersection waits for taint (M3).
- **Pattern-scoped grants apply to reads/claims AND writes.** A grant's `pattern` is AND-ed into
  `query`/`read_one`/`take` (`grant ∧ request` via `combineMatch`), and on `put`/ack the record body
  must satisfy it (`Space.bodyMatchesGrant`). The read constraint nests as `$and[request,
  $or[patterns]]`, so a grant pattern must be a flat equality map (nesting can exceed the depth-3
  compile limit), and its paths are checked at use, not at grant creation: a bad path 400s later.
- **Provenance is not authority.** A result with a privileged data parent inherits no
  permission from it. See [design-data-model.md](design-data-model.md).
- **A long-lived connection is a request that never ends, so it re-resolves rather than never
  resolves.** A watch SSE stream authorized once and then streamed under that decision for hours.
  Every long-lived thing (a stream, a subscription, a materialized view over authorized data) must
  bound its staleness at open time or it is unbounded by default. Closed in package L; see
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

**Never pattern-scope a grant on a kind whose bodies lack the field.** `radia team` scopes a
member's grants with `pattern: {team: …}`, and adding `kind_def: query` to that set made
`space_kinds` fail exactly as its absence did: a `kind_def` body carries no `team`, so the pattern
matches nothing. The team pattern belongs on kinds that carry data, never on those that DESCRIBE
them; discovery grants are a separate, unscoped set (`DISCOVERY_GRANTS`).

**A body must carry the field its grant pattern names, and nothing server-side will add it.** A
pattern-scoped grant bounds writes as well as reads (`bodyMatchesGrant`) and a body is the client's
claim, so a write missing the field is refused: no unlabelled lane. `src/surfaces/mcp/scope.ts`
fills it in from a REFUSAL, never up front, because `EffectivePermissions.kinds[].patterns` unions
every grant on a kind for any operation, so pre-stamping narrows an UNSCOPED put grant's record.

**`radia compartment` does not audit team isolation, and reads as though it does.** It answers a
KIND-compartment question ("who holds both sides"), so with `--inside task,note` it reports every
team member as an unexpected crosser for reading `task` and writing `artifact`. The team audit is
`radia team`, which reports unscoped members, crossers and `observe` holders.

**An unscoped grant is INVISIBLE in `patterns`, so a mixed set cannot be detected from it.** A
principal holding a scoped `query` beside an unscoped `put` on one kind shows only the scoped
pattern, and `radia team` therefore reports it as scoped. The clear case (no pattern at all) is
caught and reported as `TEAMS: ANY`. Same limit applies to reading `radia permissions`.

### Artifacts, blobs and erasure

- **A blob's storage name is derived from the KEK, so swapping the key renames the estate.** The
  sweep's keep set is computed under the CURRENT key, so without key ids every pre-rotation payload
  is swept. `SealedKey.kid` names the key, `RADIA_BLOB_KEK_RETIRED` supplies retired keys for reads,
  an unknown-key payload is KEPT (`BlobGcResult.foreign`) and is `missing` to the digest-driven
  `radia rewrap`, which re-seals live payloads. Guard: `test/conformance/suites/blobs.ts`.
- **Writing a payload and its key is two operations, so order them for the crash.** Key first,
  payload second, so an interrupted write is a miss; the "already stored" guard requires BOTH parts;
  and a blob at the ENCRYPTED name with no sidecar is damage, never legacy plaintext (only the
  plaintext-digest name reads as plaintext). Ciphertext written first leaves, on a crash, a blob the
  reader serves raw as plaintext, and a re-upload never heals it because the dedup guard skips it.
- **Artifact bytes are served `inline` only for formats a browser cannot execute.** Blobs are
  attacker-supplied and share the console's origin and operator token, so `text/html` is XSS for any
  `artifact: put` holder. Allowed: raster images, audio and video, never `image/*` (`image/svg+xml`
  scripts) nor PDF; the rest downloads, with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox` (`src/server/handlers/artifacts.ts`).
- **A download capability belongs in an `<img>`, not in a transcript.** Capabilities are minutes
  long and in-memory, so a URL carrying one is broken by the next restart and by the clock. The
  console mints one per render and uses it at once. Printed into terminal scrollback it is a link
  that looks permanent, fails later, and leaves a token in the user's history. Print the stable
  `/v0/artifacts/{id}` URL instead and let the viewer authenticate.
- **A guard on one field of a pair is a guard on neither, and the budget is their SUM.**
  `buildRecord` checks size and NUL on the body AND on `clientMeta` (equally client-supplied and
  unerasable), since a payload moved one field sideways passes a one-field limit. The size check is
  ONE shared budget; two independent limits are defeated by splitting. NUL is a storage fact for the
  body (`body_jsonb` cannot hold U+0000) and a choice for plain-text `client_meta`.
- **The record-size limit is an ERASURE boundary, not a performance note.** A body has no erasure
  path (payloads are out of line so they can be destroyed; bodies cannot), so an unbounded body is
  how unerasable data enters a space: base64 a secret into one and no operator verb reaches it.
  Enforced since 2026-08-04: `SpaceContext.maxRecordBytes` (1 MiB) in `buildRecord`, over body AND
  `clientMeta` together, `413 record_too_large`; `src/server/body.ts` caps the transport at 8 MiB.
- **The capability URL is the one URL a PERSON handles, so its length is a real property.** 122
  characters became 46: the capability already names one record, so `GET /v0/a/{capability}` drops
  the id and query string, and the token is 16 bytes base64url rather than 32 hex (no weakening: it
  opens one object for minutes, is not an identity, and carries no id to substitute). It stays under
  `/v0`, since a root path is an unversioned public surface; the `stable` long form still works.
- **A capability URL must come back ABSOLUTE to anything that is not the console.**
  `POST /v0/artifacts/{id}/capability` returns a RELATIVE url when no isolated artifact origin is
  running (`--artifact-port 0`). The console resolves that against its own origin; an agent hands it
  to a user verbatim and it opens nothing, with no way for the model to know what to prepend. The
  chat's tool resolves it against the client's base before returning.
- **"Refuse or fabricate" is usually a false pair.** The git export refuses to place a placeholder
  for an erased payload, because the tree would hash to something the manifest never described.
  OMITTING the entry is the third option: a tree without the file makes no claim about it. Silence
  is the remaining gap, so the subject line, the commit trailers and the repository `description`
  each say what is missing, the last because it alone survives the directory being passed on.
- **Discriminate a skippable failure by its STATUS, never by how its message reads.** `--partial`
  skips a 410 (bytes deliberately destroyed) and nothing else. A 404 is a manifest naming something
  that never existed; a digest mismatch is content disagreeing with its claim. Both read as "cannot
  read that file", neither is erasure, and skipping them yields a repository that looks complete.
  Any "best effort" option needs this line drawn, with a test on the wrong side of it.
- **An undone erasure was not just a no-op, it was INVISIBLE.** `shredOf` is consulted only in the
  branch after a read has failed, so once the bytes are back nothing reads the shred record again.
  The fix is detection, not enforcement: a marker plus a present blob is a reversed erasure,
  derivable in one `stat`, reported by `Space.erasures`, `GET /v0/ops/erasures` and `radia doctor`.
  Scoped callers get the field OMITTED rather than zero, since a zero reassures on no evidence.
- **Erasure leaves a confirmation oracle, and the argument against it was already in the repo,
  pointed at the neighbouring case.** The plaintext sha256 lives in the artifact record's body,
  which has no erasure path, so a shredded payload stays confirmable, while the storage name
  (`BlobCipher.storageName`) HMACs the same value because it must reveal nothing. The neighbouring
  case: `design-data-model.md`, a retained `body_sha256` and a brute-forceable low-entropy body.
- **Erasure by content cannot mean "these bytes may never exist here again".** A pre-write check
  refusing any payload whose digest was ever shredded poisons a content address space-wide (shred an
  empty file and nothing can store one) and breaks any program that recomputes the same output.
  Erasure destroys the runtime's copy; a re-upload of bytes already held learns nothing. Fix
  legibility: runner and reader say "ERASED, permanently, save a successor without this path".
- **A git tree can hold two entries with one name, and it builds, hashes and writes fine.** `a` as a
  file plus `a/b` produced exactly that. Only `git fsck` rejects it, which is why the export suite
  round-trips through the real binary where one is installed rather than trusting its own vectors:
  vectors written by the same author who wrote the encoding are wrong in the same direction.
- **A git export's author is the principal behind `created_by`, never the manifest's `owner`.**
  `owner` is a body field a client submits, so an author line from it lets a record name anyone as
  its writer; it travels as a trailer. The author resolves through the RUN (`principalBehind` in
  `extensions/ts/git.ts`: the agent its `agent_run` names, or the person behind a delegated run), as
  a run id names nobody tomorrow; a reader without `agent_run: query` gets the run id.
- **Encrypted content is coordination-invisible by construction.** Client-side-encrypted
  bodies are unmatchable, untaint-trackable, and invisible to diagnostics. E2E-from-the-
  runtime while plaintext is exposed to the LLM provider is rarely a coherent threat
  model. See [design-observability.md](design-observability.md) confidentiality layers.
- **In a content-addressed store, a partial write is permanent, not transient.** Only a caller
  holding exactly those bytes would ever write that address again, and dedup-on-existence tells that
  caller to skip, so a truncated blob survives every repair. Two rules: write atomically (temp plus
  rename, `FileBlobStore.writeAtomic`) so damage cannot be created, and VALIDATE before deduping
  (compare length, not existence) so existing damage can be repaired. Closed in package G.

- **Erasing something means destroying EVERY copy of its key, and a reader-facing check cannot tell
  you that you did.** A conversation read on two machines has two key artifacts holding one DEK,
  since enrolling a machine writes a successor record. Shred only the newest and the reader, which
  consults the newest, reports the conversation erased while the key survives one artifact back. The
  guard enumerates instead (`eraseConversation`, `examples/chat/space/keys.ts`).

### Executing model-written code

**A cache that stores a PROMISE stores its REJECTION too.** `treeCache` (`extensions/ts/host.ts`)
caches a promise, so a transient artifact-read failure reaches every later claim, and LRU never
evicts it, since a hit bumps `used`. The host nacks it with a 5s backoff, so a blip is a nack loop
until restart. Evict on rejection, by IDENTITY (`entries.get(k)?.root === root`), or a stale failure
evicts a healthy rebuild. Guard: `extensions/conformance/broker.test.ts`.

**A build that creates a directory before it can fail must remove it on the way out.** `makeTempDir`
then `materialize`: a mid-fetch failure leaves a partial tree nothing can reach, since eviction and
`clear` both walk the promise and a rejected one resolves to no path. Paired with the retry above it
leaks a directory every 5 seconds, so an ENOSPC makes ENOSPC worse.

**Killing a child does not end `child.output()`; a GRANDCHILD holding the pipe does that.**
`output()` resolves when stdout CLOSES, not when the process dies, so SIGKILL on a wrapper script
reaps the wrapper and leaves the read blocked on what it spawned (measured: 60s against a 2s
timeout). A deadline must RACE the read and return, and must `unref()` the child, or the process
outlives the caller's answer. `examples/chat/client/clipboard.ts` carries the worked version.

**A probe on the critical path costs its own timeout, every time it fails.** The chat's clipboard
probe ran `wl-paste --list-types` before printing the prompt, and that command NEVER RETURNS on a
Wayland session where nothing owns the clipboard (a fresh login): 2.0s of a 3.2s startup. Probes
belong beside the work they overlap, or behind first use; and a probe that had to be KILLED must
report absent, not present, or the banner advertises a tool that can only hang again.


- **A process that executes model-written code must hold nothing; the process that holds a token
  must not execute.** A worker with a run token executing code hands it the space (`put`/`take` as
  that agent). In the chat, `workers/exec.ts` (token, `--allow-run`) spawns `deno run -` with NO
  permissions over pipes. The sandbox never gets a credential "so code can query" (the worker pipes
  data in), so lease RETRY is sound: a permissionless child has nothing to double.
- **Do not share stdout with a protocol. Use a FIFO pair; it is the portable extra fd.** Output
  without a trailing newline (`print(..., end="")`) prepends itself to the next frame, and the jail
  hangs (`extensions/ts/broker.ts`). `Command` exposes no extra fd, but a named pipe is reached by
  path in the run's directory. Costs: a unix socket needs `--allow-net` in the JAIL (no-network is
  proved by that flag's absence); a FIFO needs `--allow-run=mkfifo` on the HOST, which should pay.
- **Open both ends of a FIFO yourself (O_RDWR) before spawning the child.** A FIFO open blocks until
  the other end opens, so the naive open hangs the host before it spawns anything and ahead of any
  run timeout. The cost is no EOF, so end the read loop on a terminal frame plus an exit-and-quiet
  window. Planting the naive open hangs every case in the broker suite.
- **Which end of a diagnostic carries the message depends on the language, so keep both.** A Python
  traceback ends with the exception; a JavaScript uncaught error STARTS with it and the frames below
  are noise. A tail-only clip is right for one and drops the cause of the other. Size the ends for
  what each must catch rather than splitting evenly: the head needs one line, the tail needs a
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
- **A deadline on ELAPSED time cannot tell a slow answer from a dead worker.** A two-minute deadline
  abandoned a top-tier turn while the worker was still generating, so the answer landed for nobody.
  Time out on SILENCE: `awaitResult({alive})` restarts the clock on any evidence (a streamed chunk,
  a progress record). The evidence has to exist (a model can think for minutes before its first
  token), so `runInferenceWorker` beats a `progress` record every 15s while a completion is pending.
- **Routing per round plus a tool-count signal is a RATCHET.** Re-classifying each round on the tool
  count: the user's text is the same each round, so only the count changes, and it only grows.
  Measured: 14% of first rounds went to the top tier, 72% of later ones, and most calls are later
  rounds. Two fixes, and the second holds: say what happened rather than that it was hard, and BOUND
  a later round to one step above where the turn opened (`capToTurn`, workers/router.ts).
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
  renewing to a 12-hour ceiling); past that, or a restart, a worker holding only that spins on
  `token_expired`. `RadiaClient({definitionToken})` exchanges a definition token, which is mint-only
  and never expires. EXCEPT one acting for somebody else: the tools worker's session client keeps a
  run token, since minting a person's session is being that person.
- **Measure a storage-bound loop on a COLD cache.** The event-chain walk read one event per link:
  0.085ms warm, ~6.7ms cold. A 20k-link space verified in 1.7s warm and 135s after a restart, and
  batching the reads measured slightly SLOWER warm. Batched cold: 1.9s.
- **`diagnostics` spot-checks the event chain; it does not walk it.** A full walk is O(every event
  ever written) on a command an operator runs casually. `verifyIntegrity({tail})` does the newest
  500 and the output says so; `radia integrity` stays the unbounded audit.
- **A boot reconcile needs TWO bounds: the conversation's head, and the work's own deadline.**
  Sweeping history re-dispatches dead turns' work, starving the live one, and head alone is not
  enough: an abandoned multi-call turn's head asks for the next call. An age cutoff guesses both
  ways (a grant request waits on a person), so the bound is `deadline_at`, client-submitted; a
  record without one is never resumed. A key makes an emission idempotent, not appropriate.
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
- **Two truncations at opposite ends destroy the diagnosis between them.** The broker keeps the TAIL
  of stderr (a stack trace's last line is the useful one); `WorkspaceHost` keeping the first 300
  characters of the failure on top reports only the chatter of a program that logged before dying.
  Pick ONE end and one place: bound it where the text is produced, and let the reporting cap be a
  backstop wide enough to pass a bounded message through. Same for `runCode`'s stderr.
- **Cap stderr as well as stdout, and keep DRAINING past the cap.** A flood guard on one stream is
  no guard: the other one buffers just as unboundedly. And a reader that stops at the cap blocks
  the child on a full pipe instead of killing it, which converts a flood into a hang.
- **An exit code survives a kill only if the process already exited** (verified: `kill` after a
  clean exit still reports the real code, so only a live process loses it to the signal). A host
  that SIGKILLs its child at teardown therefore has to wait briefly for a natural exit before it
  can report the code at all. Worth doing: a result frame followed by a non-zero exit is code
  contradicting itself, and it used to ack clean.
- **Read access for executed code is granted separately from the file tools' roots.** A tool returns
  one file per call, visibly; a program folds a tree into a line, so widening the tools
  (`RADIA_CHAT_DIRS`) must not widen the sandbox (`RADIA_CHAT_EXEC_DIRS`). Roots are realpath'd, so
  a symlink cannot move a grant; the blob KEK and operator credential are `--deny-read`, which beats
  `--allow-read` in Deno, so a root holding them leaks nothing. Write, net, env, run stay denied.
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
- **A jail must not resolve its own interpreter through a search path, and a test must not assume an
  OPTIONAL jailer is installed.** `runCode` spawns `Deno.execPath()`: `deno` BY NAME against the
  child's `PATH=/usr/bin:/bin` fails "entity not found" on a GitHub runner. Bubblewrap cases SKIP
  without `bwrap`; CI installs it. The skip check must be FUNCTIONAL (a run through the jail):
  `bwrap --version` succeeds under Ubuntu 23.10+'s `kernel.apparmor_restrict_unprivileged_userns=1`
  while the first jail dies. Gate only what spawns, not a case merely DECLARING two backend records.
- **A hosted runner cannot run this bubblewrap jail at all, and asserting the capability only turned
  a skip into a red build.** On `ubuntu-latest` the package installs, `--version` answers, the
  namespace opens, and `--unshare-all` dies with `bwrap: loopback: Failed RTM_NEWADDR: Operation not
  permitted`: AppArmor grants the namespace but not configuring `lo` inside it, so
  `kernel.apparmor_restrict_unprivileged_userns=0` is not enough. CI attempts the relaxation, never
  fails on it, and PRINTS whether bubblewrap coverage is ON or OFF.
- **A confiner that bounds READS only, plus a runtime that writes caches, corrupts those caches.**
  On macOS under Seatbelt: Deno writes its SQLite caches whatever `--no-remote` says; a
  read-bounding profile leaves them WRITABLE BUT UNREADABLE, and every later `deno` fails
  `SQLITE_IOERR` 522 machine-wide; Deno's recovery deletes the main db but not the `-wal`/`-shm`
  siblings (delete the triples by hand). Give a confined runtime's unasked writes a private
  read-write place (`RunOptions.cacheDir`); bubblewrap escapes only via its fresh tmpfs `/tmp`.
- **A read permission does not necessarily cover MODULE LOADING, and in Deno it does not.** Measured
  2026-08-06 (package T, [plan-audit-remediation.md](plan-audit-remediation.md)): in the jail,
  `import("file:///x.json", {with:{type:"json"}})` returns the file past `--allow-read` and
  `--deny-read` while `Deno.readTextFileSync` is refused, and any `.ts`/`.js` runs; non-module text
  does not leak. No flag closes it (`--allow-import` is remote-only) and no textual `import` ban
  (`eval` can import); a mount namespace does, for 7ms (`SandboxSpec.importsConfined`).
- **Prefer a guarantee that holds by ABSENCE over one that holds by presence.** Deno's sandbox is
  safe because nothing was granted: forget every flag, get the safe answer. A bwrap or container
  jail is safe because `--unshare-net` was passed: forget one, get the unsafe answer silently. Check
  that (fail-closed versus fail-open) first for any new backend. Mitigation is a boot-time PROBE
  (connect, write, read what should not be there) and not advertising a jail that fails it.
- **Measure the isolation you are comparing, not the latency.** `python3` under bubblewrap means
  binding the host's `/usr`, and the jail then sees 4223 binaries and 289 site-packages entries,
  against NOTHING in the Deno jail and ~142 in a purpose-built container image. bwrap benchmarks
  faster (13 ms vs 35 ms) and is three orders of magnitude weaker on the dimension that matters,
  invisible in a timing table. It is inherent: an interpreter has to come from somewhere.
- **When a capability varies, make the VARIATION a record, not a worker's identity.** A runner per
  language publishing `capability{language}` conflates two axes: `language: "python"` says nothing
  about isolation, so two differently jailed runners share a name and `tool_call{language:"python"}`
  grants the weak one. An execution environment is a THING
  ([design-execution.md](design-execution.md)), a `sandbox` record whose guarantees a grant binds.
  Symptom: "how will anyone know what this guarantees?" answered "the description", unmatchable.
- **The cost of an LLM iteration loop is the model, not the runtime.** Measured locally: a full
  put+take+ack round trip is ~30ms, a sandbox spawn ~27ms, and a model round is 1-10 SECONDS, so
  routing an edit-run-test loop through records costs about 1% of an iteration. The argument against
  coordinating a tight loop through a coordination layer (true for a compiler) does not transfer to
  one gated by inference; what pays is reducing model rounds and making each one more informative.
- **An inconclusive probe was read as a passing one, which is fail-OPEN in the component whose job
  is to disbelieve.** `escaped = stdout.includes("ESCAPED")` has two outcomes for three cases: a
  denied operation says "held", an escape says "ESCAPED", and a probe that never ran (cold
  interpreter past its timeout, missing binary) says neither and counted as held, so an unverifiable
  jail passed. A probe with no conclusive output is a FAILED claim and the worker refuses to serve.
- **A conformance test that reaches the public internet is not a conformance test.** A network probe
  connecting to `1.1.1.1:53` reports "held" on a machine that is merely offline or behind an egress
  filter, so a jail with no network isolation would pass. A loopback listener opened by the prober
  discriminates as well, cannot be wrong, and spares every worker boot an outbound connection.
- **A language is a CAPABILITY NAME, not an argument or a router decision.** `run_python` is
  published only where its jail probes clean; a space without `bwrap` never offers it. A `requires:
  {language}` argument is expressible everywhere and fails at execution, mid-turn; a router's
  fallback runs weaker than asked. The `llm_call` tier router is NOT the precedent: a tier is a
  judgement about a turn, worth delegating; a language is a fact the caller holds, having written
  the program. A router fits REQUIREMENTS, not a name ([design-execution.md](design-execution.md)).
### Surfaces: HTTP, console, CLI and the SDKs

- **The ops gate and the dispatcher parse `/v0/ops/records/{id}/{verb}` through ONE function.**
  `opsRecordPath` in `src/server/http.ts`, exactly two segments. A gate regex that saw no verb in
  `…/reclaim/` while the dispatcher's `split("/")` ran `reclaim` let `radia mcp`'s default observer
  reclaim, requeue, dead-letter, declassify and shred (package Z, 2026-09-04). Each write handler
  asserts its own power as well. Guard: `test/http.test.ts`, six malformed verbs as an observer.
- **Every JSON body is read through `parseJsonBody` (`src/server/body.ts`), never `req.json()`.**
  `req.json()` buffers the whole body before the record limit sees it (nine routes did). The ceiling
  is a transport one (8 MiB), refused as `413 body_too_large` while the stream arrives, and it
  THROWS rather than returning null, so a handler's "not an object" catch cannot turn a refused body
  into a 400. Guard: `test/http.test.ts`, nine megabytes at six routes (package Z).
- **Open mode refuses a write whose `Sec-Fetch-Site` is not the space's own origin.** A cross-origin
  `text/plain` POST needs no preflight, so any page open in a developer's browser could write to an
  open space as the operator. The browser stamps the header and a page cannot forge it; curl and the
  SDKs send none and pass; reads stay open, since the response is unreadable cross-origin anyway.
  Required mode has no no-header operator. Guard: `test/http.test.ts` (package Z).

- **Never prune the credential file as a side effect of a write, and never on age alone.** An entry
  is rewritten only when a space STARTS, so age cannot tell a live dev from a dead one, and deleting
  the live one leaves every operator verb at 401. `radia credentials --prune` probes each dormant
  base URL and keeps what answers; a `#login` durable half and a `#enckey:` content key are never
  pruned. A new entry kind must join `credentialKind`, or it defaults to prunable "operator".
- **A test goes in `test/conformance/` only if it runs against several implementations.** That
  directory is the port contract (every adapter and blob store, the "never a weaker cousin" guard);
  anything with ONE implementation, or that knows a dialect, is a standalone `test/*.test.ts`.
  Extension contracts live in `extensions/conformance/`, since nothing there may import `src/`.
  `test:conformance` is the matrix, `test:runtime` all of `test/`, `test` the aggregate.
- **`radia query` reads NEWEST first and its `--json` is an OBJECT.** Ascending id gave "the
  records" as the oldest, capped at 500 (`Math.min(j.limit, 500)`, `server/handlers/records.ts`).
  The verb sends `dir: "desc"` and prints the `nextAfter` cursor as an `--after` line; `--oldest`
  restores the old order. `--json` emits `{records, nextAfter, explain, scope}`, not an array:
  `.[0]` is `.records[0]`. An `--order` pattern sends no `dir`, as `Space.query` rejects the pair.
- **A definition token exchanged per process appends an `agent_run` unless it asks for `reuse`.**
  `stats`/`doctor`/`events`/`flows`/`integrity`/`permissions`, on the observer token, wrote one per
  command (765 → 766 over three calls, 2026-08-20). `POST /v0/agent-runs {reuse: true}`
  (`ClientAuth.reuseRun`) returns the run the credential holds, so its holders SHARE a run principal
  (never for a fleet), and a stopped reused run stays so till the 12h bucket rolls.
- **Three rules the OTLP exporter learned from live Jaeger, for any second exporter or binding**
  (2026-08-06). A `run:<ulid>` principal carries NO agent name (else a "service" per 15-minute
  remint): read `agent_run` RECORDS. A `parentSpanId` the collector lacks shows Incomplete, so an
  outside parent LINKS. A span id is sent ONCE, so a family waits till its attempt settles (30s cap)
  or an ancestor freezes at `radia.open`; `end == start` is refused, so point spans get a 1ns floor.
- **A 401 is the first move of HTTP Basic, not a failure.** A server that logs every one reports a
  successful authenticated clone as a wall of errors, and (because only failures were logged) says
  nothing at all when it works: loudest precisely when nothing is wrong. Distinguish the CHALLENGE
  (a 401 to a request that carried no credentials) from a refusal, and log something on success.
- **A protocol that FALLS BACK hides its own bugs.** Git takes the smart transport only when the
  advertisement's content type is exactly `application/x-git-upload-pack-advertisement`; anything
  else walks the dumb routes, working and ten times slower. So the assertion cannot be "the clone
  succeeded": it has to be on the SHAPE of the exchange (two requests, no loose objects). Same class
  as a watch that 401s into a silent poll fallback.
- **`onShutdown` REPLACES the default signal behaviour, so a no-op handler makes a process
  unkillable.** It registers SIGINT and SIGTERM listeners, so a no-op leaves only SIGKILL. A
  long-running verb takes the `radia dev` shape (abort a controller, pass its signal to `serve`,
  await `finished`, return a status); `exit` outside `src/main.ts` is not allowed either. A port is
  never `space + 1`: a space binds two.
- **A cache in front of an authorization decision becomes an authorization decision.** The git
  server caches a client per credential, since a dumb clone is one request per object (a hundred
  `agent_run` records per clone without one), but a cached run token outlives its definition, so
  `radia revoke` took up to fifteen minutes. Re-authenticate at a boundary the protocol already has
  (`info/refs` starts every fetch): a revoked credential starts no fetch, one in flight finishes.
- **A terminal has ONE cursor, so it needs one writer.** Three writers shared the chat's (the turn
  streaming an answer, a `capability` watch wakeup, every worker's inherited stderr), so a worker
  restarting mid-turn spliced a line into the model's sentence and a crash wrote an unlabelled stack
  mid-answer. The fix is a `write` funnel tracking the cursor's column, a `notice` that holds a line
  until the turn releases it, and piped worker stderr. Guard: `examples/chat/smoke-render.ts`.
- **Owning raw mode means owning everything the line discipline was doing for you.** Cooked mode
  gives a prompt backspace, `^W` and `^U` only. Raw mode transfers four obligations: Ctrl-C is a
  key, not a signal; Ctrl-D means two things; the terminal is restored on EVERY exit path; a paste
  is bracketed or a multi-line one submits once per line. Never decide on a half-arrived escape: an
  arrow key becomes a cancel. The pure half is `examples/chat/client/edit.ts`.
- **A streaming renderer is only correct if the chunk boundaries cannot be felt.** Two bugs
  invisible to a whole string: a `_` starting an empty buffer lost its look-back (fix: remember the
  last character DEALT WITH, not the last buffered), and a closing fence consumed a newline not yet
  arrived. Guard: render one source at several chunk sizes and compare the results TO EACH OTHER,
  plus a deterministic fuzz over random splits (`examples/chat/smoke-markdown.ts`).
- **A width constant is a bug on somebody else's terminal.** The status line was cut at 100 columns
  and redrawn with `\r\x1b[2K`, which erases the row the cursor is on; on an 80-column window the
  line wrapped, the erase cleared the second row, and the first row's fragment stayed for the
  session. Measure with `Deno.consoleSize` and cut to fit. The off-by-one under it: a `trunc` that
  appends its ellipsis AFTER slicing returns n+1 characters, exactly enough to wrap.
- **A cast is still a promise, not a check; `match` was the one that got away.** `pattern.match` was
  cast straight into the compiler, and `Object.keys(3)` is empty, so `match: 3` compiled to NO
  PREDICATE and returned every record of the kind: a malformed filter that WIDENS. Validated in
  `compilePattern`, not in the handlers, because SDK/MCP/in-process callers never pass through one.
  Found by writing `test/http.test.ts`, which is a table now: add a row per field.
- **A wrong-typed field that changes WHICH records are involved is a 400; one that only sizes the
  answer falls back to its default.** `limit: "ten"`, `leaseSeconds: "60"`, `backoffSeconds: []` fall
  back; `match`, `pattern`, `orderBy`, `after`, `dir` are rejected. A bad bound cannot answer a
  different question; a bad selector can. Pinned in both directions so neither drifts.
- **An idempotency key travels as an HTTP header (a ByteString), so hash content into it, never
  embed it.** A key built from free-form content can carry Unicode (a tool description with `…`, a
  body with an em-dash) and `fetch` throws `not a valid ByteString`. Content-keying a record is
  right; the key must be a HASH of the content. `kindDefKey`/grant keys are ASCII by construction;
  the capability publish content-hashes the tool def (`extensions/ts/capability.ts`).
- **A cast is a promise to the type checker, not a check.** Handlers built a `PutRequest` by casting
  wire JSON, so `parentIds: 42`, `deadlineAt: {}`, an `orderBy` string or a null body failed deep
  inside matching and answered 500 instead of 400. Checked at the boundary (`pickPut`/`pickResult`,
  plus the numeric query-param checks) and, for `order_by`, in `compileOrderBy` so in-process
  callers are covered. **If it came off the wire, check it.**
- **`esc()` must escape quotes, because record data reaches HTML attributes.** The console escaped
  `& < >` only, but a grant's `pattern` renders as JSON inside `title="…"`, so every pattern-scoped
  grant broke out of the attribute and a crafted one could inject an event handler into a page
  holding an operator token. ONE raw call site was the defect, so `test/console.test.ts` checks
  structurally that every `${…}` in an attribute routes through `esc` or is a ternary of literals.
- **Client-supplied headers must win over the SDK's own credential.** Python's `_req` set
  `Authorization` after merging caller headers, clobbering them. It surfaced only with `create_run`,
  the one call authenticating with a DIFFERENT credential (the definition token). TS spreads caller
  headers last and was always right; any future "authenticate this call differently" API depends on
  that precedence.
- **`fetch` REJECTS when nothing is listening, so a stopped space is an exception, not a status.**
  The console's `api()` returns `{ok, status}` and every caller reads it, so an uncaught rejection
  froze the page on its last good render. It now maps a network failure to `status: 0`, distinct
  from any HTTP status.
- **Runtime paths belong in `src/paths.ts`, never at a call site.** Everything defaults under one
  `./.radia` (`RADIA_DIR` moves it), so `rm -rf .radia` is a complete reset and the chat's sandbox
  denies ONE directory. Preserve two properties: the KEK stays a SIBLING of the blob directory
  (copying blobs must not carry the key), and blobs stay `<db>-blobs` when `--db` points outside the
  runtime dir. SQLite will not create a missing parent, so a new path needs `ensureParent`.
- **A CLI verb must read its positional through `positional()`, never `argv[0]`.** A flag written
  before the argument is otherwise taken AS the argument, silently for a bare string: `radia
  permissions --json alice` reported on a principal named "--json". A new valueless switch must also
  join `VALUELESS` in `src/flags.ts`, or the scanner eats the token after it. Guard:
  `test/defaults.test.ts`, structurally, stripping comments first since one names what it forbids.
- **A layering rule and a broken shipping artifact were the same defect, seen from two sides.**
  `sdk/ts/client.ts` imported wire types AND runtime values from `../../src/`, and
  `build-release.sh` stages `sdk/` and `extensions/` into the npm package and no `src/`, so the
  entry point (`./sdk/mod.ts`) imported four paths not in it. The fix is directional:
  `sdk/ts/wire.ts` OWNS the contract vocabulary and the old definition sites re-export from it.
- **Any uncaught handler error must return problem+json, never a plain-text 500.** The SDK does
  `JSON.parse(body)`, so a bare `Deno.serve` 500 ("Internal Server Error") surfaces as a cryptic
  `Unexpected token 'I'` that hides the real fault. `makeHandler` wraps the dispatch in a
  catch-all (`src/server/http.ts`): a `RadiaError` maps by `statusFor`, anything else is a logged
  500 problem, so clients always get parseable JSON.

**A generated harness config must name a real file, and the RIGHT one.** `"command": "radia"` works
only if the harness's PATH has it, which a generated config cannot check. Naming a `radia` FOUND ON
PATH is the mirror mistake: it can be another build than the writer, and a stale install speaks an
older wire contract. The rule is the absolute path of the binary that WROTE the config
(`src/surfaces/mcp/config.ts`); from source there is none, so it says so, not a `deno run` line.

**`--scope local` is spelled out in the printed `claude mcp add` line, not left to the default.**
The `user` scope writes one config for every project, so two agents meant to be two principals
become one: their work is indistinguishable by author and stopping one stops both. Codex has no
per-directory config at all (`~/.codex/config.toml` is user-level), so per-session principals there
rest on separate server names or on environment inheritance, neither of which is enforcement.

**A run id is not an identity, and the console rendered it as one.** `created_by` names a RUN, which
dies at the 12h ceiling, so an author becomes unresolvable within a day. The console resolves it
(`agentOf`, a NARROW read of the newest `agent_run` for that run, memoized per page and FAIL-SOFT,
since an ordinary session holds no `agent_run: query` grant and a decoration must not blank what it
decorates); `radia get` prints the same line. Lasting attribution names the AGENT.

### Agent- and model-facing design

- **A word a tool description defines is what that word MEANS to the model.** `save_procedure` says
  a saved procedure "becomes one of your tools", so "list tools" routed to the saved-code listing,
  came back empty, and the assistant reported having no tools with 39 in front of it. The
  descriptions were right; missing was the disposition that its own list is the answer
  (`systemPrompt`, `examples/chat/client/thread.ts`). Check a noun's binding before adding a rule.
- **"The model says it has no tool for that" is a claim to check against the ADVERTISED set.** A
  session offering 22 tools was missing every file tool, so the model wrote files with a code runner
  and truthfully said it could not produce a link: `capability` records for three providers were
  retired and could not revive (see [Registries](#registries-and-reads-that-must-not-truncate)).
  Read the `llm_call` body's `tools` first; `radia query capability` says what is live.
- **A tool that returns a REFERENCE must name the tool that turns it into a link.** `save_content`
  cross-referenced `share_artifact` and the code runners did not, so a model holding an artifact id
  invented `sandbox:/mnt/data/…`, which resolves to nothing. The disposition belongs in the prompt
  ("a link must come from a tool"), the mechanism in the description of the tool that produced the
  id (`examples/chat/workers/exec.ts`).
- **A turn whose TEXT is trivial is not a trivial turn** (`examples/chat/workers/router.ts`). The
  router classifies the newest user message, so "retry deep" was answered `fast` on all four rounds,
  and a bare "continue" reads as small talk. Two rules ahead of the classifier: a tier NAMED in the
  message wins, and a bare continuation INHERITS the previous turn's tier. Both live in the router,
  from the discovered tier list, never a `/tier` client command. Guard: `smoke-fleet.ts`.
- **Unparseable tool arguments must be refused as a PARSE error** (`parseArgs`,
  `extensions/ts/turn.ts`; refused in `serveTools`, `tool-worker.ts`). Handed `{_unparsed}`, a tool
  names the first required field it misses (a malformed 16 KB `edit_workspace` call was refused for
  lacking a `workspace` it sent). It also escapes control characters in string literals (a model
  escapes newlines for 7 KB, then stops). Guard: `extensions/conformance/tool-worker.test.ts`.
- **Testing the client is not testing the TOOL the model calls.** `smoke-selfgrant.ts` paged the log
  itself and passed; the chat's `tools/space.ts` `space_events` fetched one page from cursor `0`,
  all foreign events, so the tool returned `{events: [], withheld: 500}` each retry, the session's
  own activity at the far end of an 11,588-event log. **A wrapper that adds a bound can hide a bug
  from every test of the thing it wraps**; `smoke-inspect.ts` drives the tools.
- **A bounded newest-first read of a thread must expand until the turn's start is in view.** "The
  newest N" of a tool-heavy round can land inside tool replies and miss the `user` message that
  began the turn: the inference worker got no question and the router scored an EMPTY one as small
  talk. Both expand the read until a `user` message is in; the router never scores an empty string.
  **When a bounded read feeds a DECISION, "not found" is not a neutral default.**
- **Mutable module state is per-PROCESS, and the chat's workers are separate processes.**
  `sessionOwner()` is set by the REPL; the tools-worker imports the same module in its own process
  where nothing sets it, so `request_grant` stamped the wrong owner and was refused. Worker-side
  code takes identity from `ToolContext.owner`, stamped on the tool_call by the session and
  runtime-checked. Guard: `smoke-login.ts` (no worker-side module may IMPORT `sessionOwner`).
- **A verdict the subject can write is not a verdict.** The exec-worker is the only principal with
  `check: put`; the chat session holds `query`, or "the code works" is the model grading itself.
  **The party being judged must not hold the pen**, for any evidence kind. Two boundaries: an ABSENT
  expectation records no verdict rather than a passing one, and a TIMEOUT fails `exit_zero` (a
  killed process has a null exit code; reading it as zero passes the worst outcome).
- **An agent that discovers its abilities from records cannot discover one nothing publishes.** Both
  SDKs had `artifactCapability`; the chat had no tool for it, so the assistant could store a file
  but not hand it over: asked for a link it quoted the id URL (a 401 in a browser) or invented one.
  **Before concluding a model "does not understand", check that a tool exists** with a description
  saying when (`share_artifact`, `examples/chat/tools/save.ts`).
- **A status hint is a DIAGNOSIS and must be evidence-based, not timer-based.** The chat showed "no
  worker serves 'x'" after 2.5 seconds without a `progress` record, but most tools emit none, so it
  accused a worker that was about to answer. A client can prove what is ADVERTISED; LIVENESS it
  cannot, since a `capability` record outlives the worker and a scoped session cannot read the
  envelope. The hint claims only the provable half and the timeout names both possibilities.
- **Anything that abandons a turn mid-flight must answer the tool call it interrupted.**
  Escape-to-cancel lands in the window that bricks a conversation, so it appends a `tool` reply like
  a timeout. **Every early exit from a turn is a candidate for the unanswered-`tool_calls` bug**;
  fix it in the shared exit path. Cancel stops only the WAITING: a claimed `llm_call` still
  completes and writes its result; do not say the work was undone.
- **An assistant `tool_calls` with no reply BRICKS a conversation, permanently.** OpenAI rejects the
  whole payload and the thread is durable, so every later turn rebuilds the same rejected history
  (59 messages, none sendable). BOTH fixes: `runToolCall` appends a reply on every exit path
  (prevention) and `assembleContext` pairs calls to replies both ways (repair, the only fix for an
  existing thread). A partially answered message keeps its answered calls; dropping it orphans them.
- **A tool scoped more narrowly than the GRANT contradicts the tools that are not.**
  `list_workspaces` filtered to the current conversation while `space_count` was owner-scoped: one
  answered 8, the other none, both correctly, and the model spent eight rounds failing to reconcile
  them. The narrowing did no security work, since the grant bounds the query anyway. Where relevance
  differs from permission, MARK the rows (`thisConversation: true`) rather than hiding them.
- **When a model cannot READ something, it reconstructs it and presents that as real.** Workspaces
  had save, list, run, no read. Asked to show a file, the model rebuilt it from the conversation,
  stored that, and answered with it (flagged as one, which no user reads as "not the file").
  **Fabrication is what fills a missing read path**, so a missing reader is a correctness gap.
  `read_workspace` exists now; `list_workspaces` reports PATHS rather than a count.
- **A precondition can be real and still guard the wrong thing.** A line-range edit required
  `expectDigest`, which proves the file unchanged and nothing about whether the range points where
  the caller meant: a model aimed at the wrong lines and removed four structural tags. Positional
  addressing needs a CONTENT check (quote the boundary lines), the last above all, since a caller
  miscounts where a region ends. Name the failure a precondition does not cover.
- **A tool that returns no evidence gets its result described from intent.** The edit returned
  `changed` and a digest and no content, deliberately, to stay cheap. The caller then reported what
  it MEANT to do, discovering the real damage a turn later. A bounded window over what changed costs
  a few dozen tokens and removes the gap between doing and describing. Frugality about output has a
  floor, and it is "enough for the caller to tell the truth about what happened".
- **A tool description is only read once the model is already considering that tool.** With
  `share_workspace` listed, a model holding a three-file page decided opaque artifact URLs made
  relative links impossible. It never read the description: it was asking "is this possible at all",
  not "which sharing tool". Fix: the RESULT carries the affordance (a saved tree with `index.html`
  says it is a browsable site and names the tool), like `forked` and `incomplete`.
- **An error that does not say what to do next gets diagnosed creatively.** `oldString not found`
  was accurate and useless: the model had guessed the text instead of reading it, concluded the
  failure was a permissions problem, and asked for a grant, which the human then narrowed, breaking
  the read access it did have. The message now names the likely cause, says to read the file, and
  states what it is NOT. Whenever a tool can fail for a reason the caller could fix, say which.
- **A write-only tool is half a tool, and the missing half is the one that saves tokens.**
  `save_workspace` shipped with no LIST, so an assistant told to "fix the bug" re-created the
  project from memory and lost every file it was not currently thinking about. Whenever a tool
  creates named state, ask what reads the names back. The listing must also distinguish "no
  workspace called X" from "I could not see all of them": only the first is safe to act on.
- **Two runners are two overlapping tools, so the same description rule applies, and only half of it
  was written.** `run_python` named `run_javascript`; `run_javascript` ignored `run_python` and
  opened with "Run JavaScript" one word ahead of four hundred about `save_as`. Asked for Python
  primes, the model called `run_javascript` with Python twice, read a `SyntaxError`, then tried
  `os.system('python3 …')`. Each must name the other AND its selecting condition, up front.
- **A description may only name a tool that EXISTS, so a cross-reference between optional tools has
  to be built per boot.** `run_python` is published only where its jail probes clean, so a static
  `run_javascript` description naming it is unreachable without bubblewrap ("unknown tool").
  `runJavascriptDef(pythonServed)` builds both variants; the sibling is published BEFORE the
  description naming it (a missing sibling fails, an unmentioned one is incomplete).
- **Adding a THIRD overlapping tool reopens a boundary two tools had already settled.** After
  `run_javascript` vs `save_content` settled, `save_workspace` arrived and `save_content` still
  claimed "the DEFAULT way to give the user a file". All three now say: documents to `save_content`,
  code of ANY size to `save_workspace`, a one-off calculation to `run_javascript {code}`. **When a
  tool lands in a space another occupies, re-read the incumbent's description**; scope its claim.
- **Two tools that reach the same outcome are chosen by their DESCRIPTIONS, so an unconditional
  claim beats a conditional one.** `save_content` and `run_javascript` + `save_as` both produce an
  artifact (a wrong pick never FAILS). `run_javascript` said "that is how you save a file"
  unconditionally and never named `save_content`, which deferred to it and gated on the user saying
  "save". Guard: `smoke-save.ts`, reading the fleet's published `capability` records.
### Method: how these were found

- **Absence from an EXCLUSION list is not evidence, and `x-reserved-operators` is the one that
  misleads.** It names only the DEFERRED operators, so `$exists` is absent BECAUSE it is
  implemented. The spec states `x-supported-operators` beside it, guarded against the compiler
  (`test/openapi.test.ts`). Grep for a symbol before claiming it does not exist.
- **A NUL byte anywhere in a source file makes `grep` silent about the WHOLE file.** `space.ts`
  used `\0` as a cache-key separator, so every search over it answered nothing, with no error. When
  a grep over a big file returns suspiciously little, or `wc -l` and `grep -c` disagree, check
  `python3 -c "print(open(f,'rb').read().count(b'\0'))"` before believing it. A collision-free
  separator that stays text: `JSON.stringify([...])`.
- **A harness more privileged than the deployment cannot see the deployment's failures.** Three bugs
  in one feature hid this way: a suite spawning a worker under `-A` while the fleet gives it
  `--allow-net --allow-env` and no filesystem, and two tests constructing the worker IN-PROCESS with
  what it needed handed in. All three were live-only. Spawn with exactly the deployment's flags and
  environment, and when a test builds a collaborator itself, ask what the launcher does differently.
- **Never size one query class by the MEAN cost of all classes.** A turn costs ~122 Postgres
  queries, 23 of them `storage.now()`, so dividing total latency by query COUNT made the clock look
  like 19% of it. Measured with a throwaway host-clock patch it is ~2%: `select now()` is nothing
  beside a put, a transaction writing a record, a runtime row and an event. Cost a change before
  building it: the two-minute hack saved a `StorageAdapter.put` change across three adapters.

- **A test for a race proves nothing until the pre-fix code fails it, and the first draft usually
  does not.** Both guards in `test/concurrency.test.ts` passed against the defect they were written
  for: a pushable pattern is filtered in SQL, so a selective take never pages, and matches at the
  tail of a queue shift toward a paging claimer, never past it. Detect ORDER rather than an empty
  answer: a later match served first is a skip, which is a trial per take rather than one per run.
- **A check written against ONE member of a set breaks the moment the set grows, and a rename is
  exactly when it grows.** The exec worker decided "saved procedure, not built-in" with
  `b.tool !== "run_code"`; renaming to `run_javascript` kept it correct, and adding `run_python`
  sent every Python call down the procedure path ("no procedure named run_python") while the jail
  worked. Now a `BUILTIN_RUNNERS` set. Grep the OLD name's comparisons before adding a sibling.
- **"Deduped" at one layer is not deduped at the next.** Identical bytes share a blob, but
  `putArtifact` creates an artifact RECORD per file per save, so a six-file tree re-saved for a
  one-line change appends six records where an edit appends one. A phase claimed the saving was
  ZERO from the blob store's property rather than a measurement.
- **A header assertion cannot tell a classic script from a module.** The tree-serving conformance
  case checked the CSP and media types and passed while a real page loaded nothing: sandboxed
  without `allow-same-origin`, its origin was opaque, every subresource fetch cross-origin, and
  `<script type="module">` failed on missing CORS. A classic `<script src>` survives that, which is
  why the fixture worked and the model's output did not. Response headers are a proxy for rendering.
- **A tool tested with an operator client does not test the WORKER's authority.** `read_workspace`
  and `edit_workspace` passed under an admin client while the worker, holding `artifact: put` and
  no `read_one`, answered `forbidden` to every real read; a worker's grants are part of any
  capability it gains, so one assertion must run through a live worker over a real `tool_call`.
  Again 2026-08-04: `attach` used `client.getRecord`, which is `/v0/ops/records/{id}`, the OPERATOR
  plane, so check an SDK helper's URL before a worker runs it; fixed by `HEAD /v0/artifacts/{id}`.
- **Check a cited rule's PRECONDITION before leaning on it.** "A label exists only where a lineage
  walk is too slow" was cited to leave workspace artifacts unlabelled, but there is no lineage walk
  from an artifact to its manifest (the reference is a body field, not a parent edge), so the rule
  never reached the case. A rule invoked outside its precondition ends the discussion while leaving
  the reasoning wrong, and the next reader inherits the citation rather than the check.
- **A dead ternary reads as a decision, which is why it survives review.**
  `{ taint: b.owner ? undefined : undefined }` read to a reviewer and an audit as a laundering hole;
  it was neither, since the parent edge already carried the labels. Branches that are identical are
  worse than a missing argument, which at least reads as missing.
- **Check whether a recorded defect is still there before fixing it.** Two thirds of one audit
  package had been fixed the day it was filed and the plan doc never caught up, so acting on the
  entry would have re-derived a decision already made. A backlog records what someone believed,
  not what is.
- **A defect that SHRINKS under checking deserves the same write-up as one that grows.** One finding
  went from "write-back carries no labels" to "artifacts only" to "correct by design" across two
  corrections. Recording only confirmed defects teaches that reviews find bugs; recording the
  walk-backs teaches checking first.
- **A structural guard certifies only what it looks at, and this one did not look at `sdk/`.**
  `layering.test.ts` checked `src/` and `extensions/` and passed while the one file breaking the
  extensions-tier claim sat in the directory it never scanned. Type imports count too: erased at run
  time, so the package runs and then fails to type-check. When adding a tier rule, enumerate every
  directory the rule is ABOUT, not the ones the violation was expected in.
- **A measurement that settles one question gets read as settling the next one.** Phase 1 measured
  manifest SCALING and found the ~6 300-entry cap, which settles where a dependency set lives (out
  of line). `plan-workspaces.md` then wrote "SETTLED", and the adjacent question, whether the
  materialisation cache that decision requires is cheap or even buildable, was never measured and is
  still unbuilt. When a measurement decides something, write down what it did NOT decide.
- **Validating a knob you do not enforce is worse than refusing it.** `scope: {leaseOwner: "self"}`
  passed grant validation and narrowed nothing, in the widening direction: `authorScope` restricts
  only when EVERY applicable grant is `createdBy`-scoped, so a grant carrying only the unenforced
  key read as unrestricted. Refused at grant-write time until it is built. A vocabulary entry is a
  PROMISE: ship it with the enforcement or refuse it.
- **An invariant that names a guard which is not running is the loudest kind of drift.** CLAUDE.md
  said the conformance suite runs on every port "in CI from day one" while the live-Postgres run
  was manual; embedded adapters are single-connection, so the claim-fairness bug behind the
  invariant never showed on them. `.github/workflows/ci.yml` runs both. Likewise the wire contract:
  `test/openapi.test.ts` found `POST /v0/capabilities` and `GET /v0/w/{capability}/{path}` unlisted.
- **A structural test nobody has seen FAIL is a structural test nobody has tested.** The layering
  guard destructured `matchAll` as `[full, spec]`, binding group 1 (the import clause) rather than
  group 2 (the path), so every comparison ran against `{ Space } ` and matched nothing, green. Plant
  a violation in each direction and assert the guard goes red, for every grep-shaped test; and strip
  comments first, since two greps in this repo have matched their own explanatory prose.
- **A cache keyed on the thing being verified turns one check into no checks.** The git exporter
  cached each artifact's blob id across versions, so a later manifest naming the SAME artifact with
  a different claimed digest hit the cache and skipped verification. The cache now holds the digest
  that was verified and every manifest ENTRY is checked against it: an artifact's own digest is
  server-computed, while a manifest's copy of it is ordinary record content, a claim.

## Rejected approaches

Do not re-propose these without re-reading the rationale; they were considered and
rejected for stated reasons.

- **CORS on the API origin, even opt-in.** Rejected 2026-08-16: its absence is what makes the
  isolated artifact origin safe. Agent-written content served from a second port makes requests
  back to the API that are cross-origin, and no CORS header permits them (`src/server/http.ts`);
  under `--auth open` a no-header request is the OPERATOR, so an allowlisted origin reads operator
  responses. A browser app proxies instead (`examples/analysis/serve.ts`: ~20 lines, no credential,
  the space's own 401 forwarded); [research-app-lessons.md](research-app-lessons.md) action 3.
- **Per-agent record signatures (single-space case).** Rejected: the runtime already authenticates
  every `put`; a signing key would live where the bearer token lives; signatures authenticate
  origin, not trustworthiness (a prompt-injected agent signs poisoned output); server-assigned
  `runtime_meta` cannot be agent-signed. Posture: content hashes, the tamper-evident event log and
  boundary signatures at federation time. See [design-observability.md](design-observability.md).
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
- **Artifact keys derived from the caller's token.** Rejected on four counts: the runtime stores
  only `sha256(token)`, so deriving needs the token at rest; run tokens expire while records are
  permanent; a DIFFERENT principal reads an artifact, so a producer-keyed blob needs per-recipient
  rewrapping (federation-gated); and the runtime must decrypt for any grant-holder, so the key lives
  where the runtime reaches it: a space KEK. A token authorizes the ASK (download capabilities), not
  key material. Built: a per-artifact AES-GCM DEK wrapped by the KEK, behind the `BlobStore` port.
- **Embedded mode as a weaker cousin.** Rejected: the conformance + fault suite runs on
  every adapter in CI from day one, or the backends drift.
- **Escalation-only tier routing, with no classifier (chat example).** Tried and reverted: "send
  to the cheapest tier, let a worker `escalate`" puts the cost where the uncertainty is, but across
  a tool-heavy session every turn routed cheap and NOTHING escalated, since escalation depends on
  the cheap model recognising its own inadequacy, the weakest judge available. The classifier is
  restored (a different model than the one judged), escalation kept as the catch for under-routing.
  - **Keep from the removal:** no tier name appears in `router.ts`. Tiers come from `model` records
    by `rank`, and the fallback heuristic picks by POSITION in that list, never by name.
  - **Related limit, partly closed.** A `model` record advertises a TIER, not a live worker. The
    publish reads before writing and a worker retires its advertisement on SIGINT/SIGTERM, but a
    `kill -9`ed worker leaves it behind and the router dispatches into silence. Closing that needs
    liveness the runtime lacks (a heartbeat record reintroduces the growth; expiring advertisements
    need the M2 retention GC). Never "fix" it with a periodic re-publish.
  - **The retire/republish trap, general to content-keyed registries.** A republish reuses the
    publish key, and an idempotency key is scoped `(principal, operation, key)`, so within one
    principal the write REPLAYS the retired record and the entry stays withdrawn, across restarts
    too, since keys scope to the AGENT behind a run (Package U). A revival keys on the retirement it
    supersedes (`…:after:<id>`); guard `smoke-fleet.ts`. Harmless for capability and model, whose
    entries survive their author; fatal for a registry keyed BY author (next entry).

- **A registry keyed by AUTHOR needs run-scoped idempotency keys** (`publishInterest`,
  `sdk/ts/client.ts`). An interest is keyed `createdBy|kind|match` and lives only while its run
  does, so a content-only key made a restarted worker REPLAY its dead predecessor's write inside the
  7-day idempotency window; the key now carries the run. The ceiling is author-scoped
  (`checkInterestBudget`, the `created_by` column), not the liveness walk (~1.6s per publish × 31
  patterns, 49s deaf). Guard: `test/exchange.test.ts`, "a restarted worker's interest survives".

- **The matching construct is a `pattern`, and never a `selector`.** It was `template` until the
  whole surface was renamed (wire contract, code, both SDKs, CLI, MCP, docs; the inner field stayed
  `match`): a template reads as a GENERATOR and Radia's is a recognizer, and once `$in`, `$gt` and
  `$or` existed it was a small query expression, not a partial instance. Do a rename totally or not
  at all; a codebase that says both is worse than either.
  - **Never rename it to `selector`.** That word is the ENVELOPE selector on the ops plane
    (`{state:"leased", expired:true}`), and one word across both planes would blur the
    body/envelope split.
  - **Never reintroduce "repeated-pattern" for the livelock feature.** It was renamed to
    repeated-SHAPE detection to free the word ([design-observability.md](design-observability.md)).
  - `notes/` keeps the old vocabulary deliberately: it is the origin outline, provenance rather
    than a maintained doc. Older prior-art reading uses the old word too, because Linda and
    JavaSpaces call this argument a template.

## Risk register

From outline §13. Each risk with its mitigation:

| Risk                       | Mitigation                                                                              |
|----------------------------|-----------------------------------------------------------------------------------------|
| Semantic-matching drift    | shadow mode first, before enforcement                                                   |
| Livelock                   | repeated-signature + no-progress detection (see design-observability.md)                 |
| Hot-record contention      | admission top-K                                                                          |
| Schema anarchy             | per-kind schemas                                                                        |
| Agenda gaming              | server-computed `effective_priority`, historical calibration                            |
| Storage-adapter drift      | conformance suite on every adapter in CI, the only guard                                |
| Naming                     | PyPI as `radia-space`, trademark screen, courtesy note to Perlman, watch Radia Inc.      |
| Side-effect duplication    | at-least-once is the contract; transactional tool gateway is the mitigation (and possibly the second product) |
| Temporal encroaches on gap | don't compete on durability (Temporal's home ground); differentiate on record-scoped classification/containment + content routing, which Temporal has no place for. The one external event that narrows the thesis: a Temporal data-classification / per-step-permission story (moderately unlikely, since taint is hard to retrofit into an opaque-payload, no-record model, but the 2026 a16z Series D funds the attempt). See [research-positioning.md](research-positioning.md). |
