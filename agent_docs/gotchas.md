# Gotchas, rejected approaches, and risk register

Non-obvious decisions and the reasoning behind them: the "why is it like this" that the
spec alone doesn't carry. Skim before proposing a change to signing, encryption,
idempotency ordering, storage backends, or the delivery guarantee. Origin: outline §9.1,
§9.2, §13, and rationale scattered through §2–§8.

## Contents
- Findings (diagnosed during implementation)
- Traps and critical decisions
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


- **"Public route" means no credential is REQUIRED, not that a bad one is ignored.** `GET /` and
  `GET /v0/health` skip authentication so the console can bootstrap in `--auth required` mode. The
  skip covered every credential error, so a request presenting an expired, stopped, or garbage
  bearer token got `200 {principal: "anonymous"}` from health, the one endpoint a client calls to
  ask whether its token still works. Not a privilege escalation (the caller is anonymous, not the
  operator), but it makes a dead credential indistinguishable from an open space. Only
  `auth_required`, the error meaning nothing was presented, is exempt now; every other resolution
  failure is a 401 on public routes too. Note a malformed `Authorization` header that is not a
  Bearer at all still reads as "no credential" in open mode, because header normalization has
  already eaten it by the time the server looks.
- **A cast is still a promise, not a check. `match` was the one that got away.** The boundary
  validation added after the fuzzing covered `parentIds`, `deadlineAt`, `orderBy` and the rest, but
  `pattern.match` was cast (`j.match as Record<string, unknown>`) all the way into the compiler.
  `Object.keys(3)` is empty, so `match: 3` compiled to NO PREDICATE and the query returned every
  record of the kind: a malformed filter that WIDENS, answering a question the caller never asked
  with a plausible-looking result. Validated in `compilePattern` rather than in the handlers, for
  the same reason `compileOrderBy` is: the SDK, MCP and in-process callers never pass through a
  handler. Found by writing the HTTP boundary tests, not by reading the code. The fuzzing that
  found the original class was a one-off that was never checked in, so every endpoint added since
  had no such check. It is a table in `conformance/http.test.ts` now.
- **A wrong-typed field that changes WHICH records are involved is a 400; one that only sizes the
  answer falls back to its default.** `limit: "ten"`, `leaseSeconds: "60"` and `backoffSeconds: []`
  are ignored in favour of the default; `match`, `pattern`, `orderBy`, `after` and `dir` are
  rejected. The asymmetry is deliberate and easy to "fix" into inconsistency: a bad bound cannot
  answer a different question, and a bad selector can. Pinned in both directions so neither drifts.
- **Cache what cannot change; never cache what can be revoked.** Credentials looked like a registry
  (records projected into a lookup, rebuilt at startup) and were built as one. That was wrong,
  because the thing a registry cache trades away is *freshness*, and freshness is the entire content
  of a credential. The bill came due twice, both fail-open and both silent: the startup rebuild read a
  bounded page of an unbounded log, so on a busy space a STOPPED run's token still resolved after a
  restart; and `stopRun` consulted the cache first, so stopping a run the cache had not seen
  returned `applied: false` and did nothing. `Space.resolveToken` now reads the records on every
  authenticated request; `CredentialStore` (`src/core/auth.ts`) keeps only operator tokens and a
  memo of which agent a run instantiates, an immutable fact. A stop is a successor carrying the
  SAME `tokenHash`, so one indexed lookup sees it, and a token minted on one instance authenticates
  on another with no replay. The same test applies to anything else you are tempted to cache: if it
  can be withdrawn, it must be discovered.
- **An ORDER BY can defeat the index that would have served the filter, and a partial index is
  unusable when its predicate column is a bound parameter.** Both bit the credential lookup, and
  both are invisible without `explain query plan`. Newest-first over a selective equality
  (`where kind=? and <expr>=? order by id desc limit 1`) makes SQLite walk the whole kind in id
  order, evaluating the filter per row, because it reasons the limit will be satisfied early, so
  a token whose record is OLD costs a full scan, and an index on the hash alone changes nothing.
  Then the obvious fix, a partial index restricted to the credential kinds, is never chosen either:
  SQLite cannot prove at plan time that a bound `kind` parameter satisfies the index predicate. The
  shape that works puts kind in the index KEY: `(kind, json_extract(body_json,'$.tokenHash'))`, and
  the expression must match what `SqliteJson.at` emits character for character. Measured at 3000
  credential records: 1.23ms → 0.05ms, and flat to 12k instead of growing. Postgres needs none of
  this: the GIN index over `body_jsonb` already serves every path, which is why this is the only
  physical per-path index in the schema.
- **`record_edges` is a DERIVED index; `parent_ids` stays the source of truth.** `childrenOf` was
  a `LIKE` scan over the `parent_ids` JSON text (safe, because ids are ULIDs and carry no `%`/`_`,
  but O(space) to find a handful of children: 87µs at 1k records → 662µs at 20k for the *same
  five children*). It is now an indexed lookup through a `(parent_id, child_id)` table: 31µs →
  32µs, flat. Three things keep the derivation honest, and all three matter: the edge is
  written **in the same transaction as the record**, so it cannot lag what it indexes; **every**
  insert path writes it, including ack-with-result, which is the path that creates a task's result
  and therefore exactly the edges most worth having (pinned by a conformance case, because a
  reverse index that only `put` maintained would look correct in every hand test); and the schema
  carries a **one-time backfill** from `parent_ids`, guarded by `where not exists (select 1 from
  record_edges)`, so a database written by an older build rebuilds its edges on next startup.
  That backfill is now covered by `conformance/backfill.test.ts`, which empties the table and
  reopens. The earlier claim that conformance "cannot reach it, every harness database is created
  fresh" was true of the harness and false of the problem. Two things the test had to get right, and
  both were wrong first: the database must be PERSISTENT, because `init()` on `:memory:` opens a new
  empty database and the first draft "survived a restart" by finding nothing in it; and
  `SqliteAdapter.init` now closes any existing handle first, since re-initializing otherwise leaked
  the previous connection and silently swapped in that empty database.
- **A graph walk should batch by LEVEL, but the reason it got faster may not be the batching.**
  `getLineage` now fetches a whole depth level with one `getRecords` call instead of one
  `getRecord` per node. Measured head to head at depth 64 in a 20k-record space: 0.224ms vs
  0.651ms. But note *where* that came from: the benchmark's lineage is a plain chain, one node
  per level, so batching saves no round trips there at all. The first version of the batched walk
  was **slower** than the per-node one (1.247ms vs 0.780ms), because SQLite's `getRecords` builds
  its SQL text from the id count and so re-parsed an identical statement every level. Caching the
  prepared statement by placeholder count is what actually won; the batching pays on a DAG that
  fans out and on a networked Postgres, where a round trip is latency rather than work. Worth
  remembering before attributing a speedup to the change you meant to make.

- **Fan-out needs a bound even when the caller has one.** `childrenOf` returned EVERY child, which
  was fine as a `LIKE` scan nobody used at scale and became a materialize-the-subtree once it was an
  indexed edge lookup people walk. Two separate limits were needed: the endpoint pages by keyset over
  child id (same contract as `query`, `nextAfter` and all), and the graph walk bounds children PER
  NODE. Its `maxNodes` cap bounds what the picture SHOWS, not what the walk reads, so a single hub
  record could still drag in an arbitrary number of rows to enqueue them. A client-side `.slice()`
  is not a bound: the rows were already fetched by then, which is what the chat's `space_children`
  was doing.
- **The credential index was rebuilt from a bounded page too, and the fix was to delete the index,
  not to widen the page.** `loadCredentials` read the oldest 5000 `agent_definition`/`agent_run`
  records. Both accumulate (one definition per re-definition, one run per mint, and a live run
  re-mints on a timer), so on a busy space the window held only ancient history. Measured on 5202
  run records: after a restart a STOPPED run's token still resolved. Reading newest-first patched
  that instance; the cache itself was the defect, and it is now gone (see "cache what cannot change"
  above). Kept as history because the reasoning that justified the cache, "credentials are a
  registry like kinds", is exactly the reasoning to distrust next time.
  One consequence had to be handled separately, and it survives the removal. `runsForAgent` read the
  cache to answer "which principals count as me" for a self scope, but that question wants HISTORY,
  not live credentials, so it would have shrunk as the space aged and quietly narrowed "what did I
  create". It is now `Space.runPrincipalsOf`, querying `agent_run` by `agent` (a declared indexed
  path).
- **A bounded read that decides a SCOPE is not a performance question, it is an authorization one.**
  `runPrincipalsOf` (`src/core/space.ts`) answered "which principals count as me" from 1000 rows of
  `agent_run`, so a long-lived agent's OLDEST records dropped out of its own self-scoped reads, the
  exact failure its doc comment claimed to prevent. That list is the allowlist for `take`, lineage,
  graph, artifact bytes and watch wakeups, so a truncated one makes an agent's own older records
  unclaimable and `rankClaimable` skips them indistinguishably from an empty queue: it fails
  silently, and it looks like a drained queue. It pages to exhaustion through `readRegistry` now and
  throws `registry_incomplete` rather than narrowing. The client side had the same shape in five
  places (`listKinds`, Python's `list_kinds`, the chat's grant and `agent_run` reads, and the exec
  worker's capability and procedure reads, where a miss re-opens the tool-name hijack that check
  exists to block), all routed through `RadiaClient.queryAll` / `query_all`, which keyset-pages
  newest-first and THROWS instead of returning a plausible prefix. Python's `list_kinds` was
  additionally reading OLDEST-first and ignoring `retired`, so withdrawn kinds reappeared. Guarded
  by `conformance/suites/auth.ts`, which seeds 1201 `agent_run` records for one agent and asserts
  its oldest run is still in the self scope on both adapters. Where a bound is genuinely right,
  bound it by RELEVANCE (only what can still be presented) rather than by page size, and say so at
  the call site.
- **Every grant read is a bounded page over records that ACCUMULATE, and truncation misauthorizes
  silently.** Re-defining an agent used to append a fresh record per grant on every boot, so a
  long-lived principal crossed the page cap in ordinary use, and `authorize`/`authorizeWatch`/
  `authorScope`/`opsScope` all read a capped page. Measured both directions: at 101 records a
  legitimately granted principal was DENIED, and at 122 a REVOCATION written as the newest record
  was invisible, so the revoked grant kept working. Fail-open on revocation is the one that matters.
  Three parts to the fix, and the first is the only structural one: grant writes are now
  CONTENT-KEYED, so re-defining an agent with unchanged grants writes nothing (this key does dedup
  across restarts, unlike a worker republishing a capability, because agent definitions are an
  operator action and an idempotency key is scoped to the acting principal); reads take the NEWEST
  page; and the bound is generous, because the cost of truncating is silent misauthorization. Note
  what does NOT work: reading newest-first alone. An old-but-live grant then falls off the other end;
  no single page direction is correct over a set larger than the page.
- **A NUL is invisible in source and lethal in Postgres.** `grantKey` joined its parts with `\0`,
  which was fine while it was only an in-memory Map key and became `invalid byte sequence for
  encoding "UTF8": 0x00` the moment that key was used as an idempotency key. Two lessons: build
  composite keys by ENCODING the parts (`JSON.stringify([...])`) rather than joining with a
  separator no value can contain, since the encoded form is both unambiguous and printable; and
  `grep -P "\x00"` will NOT find these, because grep suppresses binary matches, so scan with something
  that reads bytes.
- **Scoping by AUTHOR does not mean what "my records" means to a user.** The chat's session writes
  `message`/`llm_call`/`tool_call`; the RESULTS, chunks and artifacts are written by WORKERS under
  their own principals. So `createdBy: self` would show a session its messages and hide its own tool
  output, and the chat would hang waiting for results it could no longer read. Conversation scoping
  covers both but hides the user's OWN earlier threads, which is not what they meant either. What
  works is an application field: the session stamps `owner`, workers copy it onto everything they
  produce for that call, and the grant binds `{owner}`, enforced on writes too, so a session
  cannot stamp another identity. `RADIA_CHAT_SCOPE` picks between that and `{conversationId}`,
  because the right answer depends on the space: identity scoping separates a session from workers
  and operator sessions, and separates two PEOPLE only if they are two principals. They were not:
  `agent:chat-user` is one constant, so every person running the chat was the same principal and the
  scope bound to the same value for all of them. `RADIA_CHAT_TOKEN` (a `radia login` session) fixes
  the identity rather than the scope, which is the level the defect was at. Without one, only
  `{conversationId}` keeps two people apart.
- **Tightening a grant by adding a PATTERN is inert on any space that already had the loose one.**
  Scope and pattern are part of a grant's identity, so declaring `{message, [put,query],
  pattern:{conversationId}}` beside an existing `{message, [put,query]}` creates a SECOND grant,
  and grants union, so the narrower one changes nothing. Every test passed, because tests start on a
  fresh space; a live session on a two-day-old space kept reading every conversation after its
  grants were scoped to one. `createAgentDefinition` now retires the unpatterned twin of each grant
  it declares, and, since testing that fix exposed the same hole one level up, every live grant on
  the same (principal, kind, operations) whose pattern DIFFERS. Swapping one pattern for another
  is not adding a grant: the two union and the wider view wins, so changing a session's scope
  silently widened it instead. Two boundaries worth keeping: `scope` is excluded on purpose, because
  `grantKey` excludes it (a self-scoped grant already replaces its unscoped twin in place) and
  including it made the rule retire the grant it had just written, since the two share a key; and it is
  bounded to the exact triple declared, so a grant a human assigned out of band survives restarts. The general shape: when identity includes the thing you are changing, a
  change is an ADD, and the old value stays in force until something withdraws it.
- **A content-keyed registry write cannot revive what it retired, and a supersede that runs per
  entry retires its own siblings.** Grants are written under a content-derived idempotency key and
  idempotency rows never expire, so re-declaring a previously-used grant pattern wrote NOTHING while
  `supersedeGrantsFor` still retired the live one. Net: zero active grants, and
  `createAgentDefinition` returning success. Reproduced as identity scope, then conversation scope,
  then identity scope again, where the third step ends in `forbidden: no 'query' grant`, reachable
  from an ordinary chat resume. Three changes in `src/core/space.ts`. The grant write suffixes its
  idempotency key with `:after:<recordId>` when the newest record for that grant identity is a
  retirement, which needed `RegistryView.newest` (`src/core/registry.ts`) because `entries` drops
  retirements, so a writer could not see the record it had to supersede. `supersedeGrantsFor` takes
  the WHOLE declared set and skips any grant whose key is in it, so two patterns on one (principal,
  kind, operations) survive together, which `authorize` is built to union. And retirements are keyed
  on the RECORD being retired rather than on the grant identity alone, so an identity can be retired
  more than once: keyed the old way, a re-granted wide grant survived the next supersede silently,
  misauthorization in the widening direction. Always anchor the revival on the newest RETIREMENT,
  never on "is the newest record retired": that test was tried, and after one revival it falls back
  to the plain key the original record already consumed, so the next repeat replays and returns the
  RETIRED record. Both SDK `grant()` helpers had the same defect on the public path and anchor the
  same way. `createAgentDefinition` reads the grant registry once per principal and throws
  `registry_incomplete` rather than superseding on a partial view, because a truncated read leaves
  stale grants live. Guarded by `conformance/suites/retire.ts` on both adapters (round trip, two
  patterns on one triple, re-narrowing a retired-then-re-granted grant) and by
  `examples/chat/smoke-selfgrant.ts` (assign, retire, revive, repeat). Same class as "the
  retire/republish trap" under Rejected approaches.
- **A withheld count with no reason sends every agent hunting for a grant that cannot exist.**
  `/v0/ops/events` filters by which principal PERFORMED the operation, so no grant on any record
  kind widens it, but the response only said `withheld: 65923`, which reads as "you are missing a
  grant". Four sessions in a row spent their turns requesting kind grants to close that gap, two of
  them inventing a kind (`space_event`) to request, and none could have succeeded. The response now
  carries `withheldNote` saying the filter is on the actor and that seeing another principal's
  activity needs an operator session. Cheaper to say once than to have every caller learn it by
  exhaustion. Note the failure was not wrong behaviour anywhere, just an unexplained number.
- **An approval prompt whose label does not match what it grants, and whose keys read as "yes".**
  Two failures in one exchange, both from a live session. The narrow option said "only its OWN
  records, reads only" and then granted the request VERBATIM, including `take`, on `llm_call`,
  which would let a chat session claim work the inference fleet is waiting for. Self-scoping is a
  read filter (claiming a record and then rejecting it is not filtering), so the narrow answer now
  grants the reads ONLY, names what it withheld, and the prompt says up front which requested
  operations are not reads. Separately, the keys were `y`/`a`/`n`: `y` reads as plain "yes" and
  meant the NARROW grant, so a person answering "yes" to "shall I look wider?" got the opposite.
  Observed twice, each time costing the assistant its following turns. The options are words now
  (`own`/`all`/`no`), nothing means "yes", and an unrecognised answer is re-asked instead of
  silently becoming a refusal, which is what the old code did with "yes".
- **An escalation that costs two turns and two human inputs per grant does not converge.** The loop
  was: assistant hits `forbidden`, calls `request_grant`, the tool returns "asked them, retry
  later", the turn ends; the human approves at the prompt; the human types "retry"; the assistant
  tries again, and every miss (wrong kind, wrong scope) costs another two. Sessions ran out of tool
  rounds mid-loop and gave up. Nothing was broken; it just could not finish. `request_grant` now
  BLOCKS on the decision and the REPL reviews pending requests WHILE the call is in flight
  (`onToolWait` in `turn.ts`), so the person is asked immediately and the answer lands in the same
  turn with rounds left to act on it. Three details that make it work: the decision travels as a
  successor `grant_request` record carrying what was ACTUALLY granted (scope included, since the
  asker may have been given something narrower than it asked for, and discovering that by retrying
  and failing is the loop being removed), because the session can read its own requests and holds no
  grant on `grant`; the tool's deadline is a human one (240s) and the REPL's is longer still, or the
  REPL would abandon a decision still being made; and the between-turns review stays as the backstop
  for a request whose turn died. Watch for this shape generally: a protocol whose round trip crosses
  a turn boundary pays for the boundary every iteration.
- **Kind-scoped is not conversation-scoped: every chat session ran as one agent, so each could read
  every other session's messages.** `USER_GRANTS` said `message: {put, query}` with a comment
  promising "may drive a conversation and read its own results, nothing more", and nothing enforced
  the "its own". A ten-minute session reconstructed two days of unrelated conversations, correctly.
  Six chat kinds index `conversationId`, so the fix is the runtime's own content scoping: the
  session's grants are PATTERN-scoped to its conversation, which binds reads and writes alike.
  Consequences worth keeping: the conversation record is created by the OPERATOR before the session
  token is minted (a grant is minted with the token, so the conversation has to exist first), and a
  user session therefore no longer holds `conversation: put` at all. Growth is per distinct
  CONVERSATION, not per session: the pattern is part of a grant's identity, so resuming re-mints
  the same content key and writes nothing. The result kinds needed the same
  treatment and lacked the field to do it with: `llm_chunk`, `llm_result` and `tool_result` are
  keyed by `callId`, so a session holding a callId from elsewhere could read another conversation's
  streamed tokens, model output and tool results whatever the conversation scoping said. They now
  carry `conversationId`, written by the worker that produces them and indexed so a pattern can
  bind it. The failure mode of getting THAT wrong is not a leak but a hang: a writer that forgets
  the field produces a result its own session cannot read, so the test pins both directions.
  Artifacts were the last kind and needed a RUNTIME change, because their body is computed from the
  bytes: `Space.putArtifact` now takes application fields to merge alongside it (`x-radia-meta`, an
  ASCII JSON header; a header is a ByteString, so non-ASCII is refused rather than mangled). The
  runtime's own fields are applied last and supplying one is refused outright, so nothing an app
  sends can forge a digest, size or media type. The chat stamps `conversationId` on every artifact
  it writes and REDECLARES the reserved `artifact` kind to index it (legal: a reserved kind may be
  extended, only not shrunk), repeating `digest`/`mediaType` because a redeclaration replaces rather
  than merges. That repetition is now also what keeps the redeclaration accepted.
  **And the narrowing had to learn about it.** Grant patterns UNION, so approving an unpatterned
  self-scoped grant beside a patterned one replaces "this conversation" with "everything this agent
  ever wrote", a widening performed by the act of narrowing. The approval flow now inherits the
  pattern of the grants it replaces. Guarded in `smoke-inspect.ts`, both directions.
- **A self scope must narrow the plane the agent actually READS through, and grants UNION.** Two
  mistakes, one live incident. First, `scope: {createdBy: "self"}` narrowed only the ops plane while
  ordinary `query`/`read_one` returned every record of the kind, so an approval promising "only its
  own records" handed over all of them, and a session reported 98 records from `ops/stats` and 308
  from `space_count` in the same breath. `Space.authorScope` now applies the restriction to the
  coordination plane too (reads only; `take` is excluded, because claiming a record and then
  rejecting it is not a filter). Second, and subtler: grants union, so a narrow grant added BESIDE a
  broad one changes nothing. The chat's session starts with an unscoped `message: query` grant, so
  approving the self-scoped version was powerless until the approval also RETIRED the wider grant.
  The union rule is why `authorScope` only restricts when EVERY applicable grant is self-scoped:
  filtering by author while an unscoped grant applies would deny something that grant permits.
  "Applicable" here means PERMITTING THAT OPERATION, since a `put`-only grant says nothing about reads and
  counting it lifted the restriction the moment narrowing reads left the write grant behind.
  Narrowing must also be per-OPERATION. The first version retired the whole overlapping grant, so
  narrowing `query` on `message` took the bootstrap `{put, query}` grant with it and the session
  could no longer write its own messages: the chat died on the next turn with "no 'put' grant for
  kind 'message'". A grant carrying operations that were not being narrowed is now replaced by one
  that keeps them.
- **Every read verb must resolve its scope through ONE path, or the verbs that forget serve
  everything.** `scope.createdBy: "self"` used to be applied by each handler calling
  `space.authorScope` by hand, and five sites did not: `handleTake` returned full foreign bodies and
  drained the kind, `handleLineage` returned an entire ancestor DAG (and `put` never checks parent
  readability, so a scoped run could name any foreign id in `parentIds` and read its whole
  upstream), `handleGraph` leaked foreign node ids and labels, artifact reads served foreign bytes
  and minted a bearer capability over them, and `authorizeWatch` ignored the scope, so wakeups
  arrived for every author. `Space.readAccess(principal, op, kind)` now returns `{constraint,
  createdBy}` TOGETHER, so the author scope cannot be fetched separately and then forgotten. Five
  details worth keeping. `take` carries the scope into the CLAIM (`LeaseSpec.createdBy` →
  `rankClaimable`) and it cannot ride in the pattern, because `created_by` is envelope metadata that
  patterns never see. `getLineage`/`getGraph` treat a foreign record as a WALL and stop there rather
  than skipping it, since continuing still exposes the shape. Artifact reads apply the scope before
  the bytes AND before minting a download capability, because a bearer URL outlives the check, and a
  foreign artifact answers 404 rather than 403. A `Watch` carries its `owner` and its author scope,
  `getWatch` requires the creating principal and `matchesEvent` filters wakeups, because watch ids
  come from the same monotonic ULID generator as record ids and are enumerable, so the id was never
  a secret. And `effectivePermissions` computes ops-reachability per GRANT (one grant carrying both
  `query` and the self scope), the rule `opsScope` actually enforces, instead of ORing `scoped` and
  `query` across different grants: a believed view that drifts from enforcement is worse than no
  view. The guard is a table in `conformance/http.test.ts` with one row per read verb, plus the
  watch-attach check. **A read verb with no row is a verb nobody checked.** Add a row when you add a
  verb. This is a convention, not a type: a new handler can still call `authorize` alone, and making
  that a compile error needs a read-context type threaded through every handler signature.
- **`listKinds()` does not list every kind.** It reads `kind_def` RECORDS, and six kinds are defined
  in code instead (`kind_def`, `grant`, `signal`, `agent_definition`, `agent_run`, `artifact`; see
  `RESERVED_KINDS`). Anything answering "does this kind exist" must add them, or it will report that
  `artifact` is not a kind while the caller is successfully counting artifacts.
- **The ops aggregate is self-scoped even where READS are not, so it must say which kinds it
  under-counts.** A principal can hold an unscoped `{put, query}` grant beside a self-scoped
  `{query}` on the same kind (different operation sets, so different grant identities, so both
  live), and then it can LIST every record while `ops/stats` counts only its own. Observed: 187 messages
  reported as the space's total by a session whose own `space_count` said 578. The self-scoping is
  deliberate and stays; the answer now carries `alsoReadableInFull` and says a query on those kinds
  returns more. Widening the aggregate to match was tried and reverted: it turns every unscoped
  bootstrap grant into full ops visibility, which is the opposite of what the plane is for.
  Guarded by "an aggregate that covers less than the caller can read says so" in `suites/selfscope.ts`.
- **The scoped-answer rule was only ever applied to the OPS plane; the plane records are actually
  read through said nothing.** `/v0/ops/*` has carried a `scope` for a while. `POST
  /v0/records/query` returned `{records, nextAfter}`, so a caller whose grant limits `message` to
  one conversation queried `message`, got its own conversation, and had no way to distinguish that
  from "this is every message there is". Four sessions in a row reported their own slice as the
  space's history, and each then went hunting for a grant to close a gap they could not see. The
  response now carries `scope: {narrowedBy, ownRecordsOnly, note}` when, and only when, a grant
  narrowed the read, so an unrestricted read is byte-identical to before (additive to the frozen
  contract). `read_one` is deliberately left alone: it returns the record itself, and a null answer
  to "give me this one thing" does not invite the same mistake. General form: the thing that makes a
  narrowed answer dangerous is that it is SHAPED exactly like a complete one.
- **A scoped answer must SAY it is scoped, or an empty one reads as an empty space.** A session
  granted ops access on one kind read `stats: []`, `events: []` and an all-zero diagnostics, and
  told its user "the space is empty and healthy". Every number was correct; the claim was wrong, and
  nothing in the response contradicted it. Scoped responses now carry
  `scope: {self, kinds, note}` (`describeScope` in `handlers/ops.ts`), and the chat's tools pass it
  through rather than projecting it away, which they were doing, so even a fixed server would not
  have reached the model. The general form: a narrowed result is only safe to publish alongside a
  statement of the narrowing, because the consumer cannot infer it from the data and an aggregate
  gives it no other clue.
- **A grant on a kind that does not exist authorizes nothing, and everything downstream reads it as
  access.** An agent that cannot list kinds guesses one, and a plausible guess is a TOOL name: a
  session asked for `space_event` (there is a `space_events` tool; there is no such kind), a human
  approved it past the prompt's warning, and from then on the phantom kind appeared in every
  `scope.kinds` line the ops plane returned, so the agent had documentary evidence of access it
  did not have. The grant is still honoured as written, because a grant may legitimately precede its
  kind (an operator bootstraps an agent before the fleet declares anything), but
  `effectivePermissions` now marks the row `kindNotDeclared: true`. That is the one answer an agent
  is told to trust about its own authority, so it is where the discrepancy has to surface.
- **A scoped agent must be able to ask what it may do, and the ops plane refused exactly the
  principal that needed to.** `GET /v0/ops/permissions` was operator-only on the reasoning that
  reading a principal's authorization is an operator question. Reading YOUR OWN is not, and the
  refusal was worse than useless: `opsScope` throws for a principal with no self-scoped grants, so
  the caller with the least authority, the one that has just asked for some, got a 403 from the
  one endpoint that would tell it whether the ask succeeded. Observed end to end: a session was
  granted precisely what it requested, retried a DIFFERENT call that was failing for an unrelated
  reason, saw no change, and told its user the request must still be awaiting approval. It had no
  way to check, so it guessed, and the guess wasted a person's time. The self-read is now checked
  BEFORE the plane's gate (`asksAboutSelf` in `http.ts`, matching the principal or its grant
  subject, since a run token asking about its agent is asking about itself); every other
  principal's authorization stays operator-only. CLAUDE.md already said `effectivePermissions` is
  how you check before believing; an agent could not reach it.
- **Testing the client is not testing the TOOL the model calls.** `smoke-selfgrant.ts` proved the
  scoped-events contract by paging the log itself, and passed. The chat does not call the server;
  it calls `tools/space.ts`, and `space_events` there fetched exactly one page from cursor `0`. On
  a busy space the server's bounded forward scan covers only the first few hundred raw events, all
  of them somebody else's, so the tool returned `{events: [], withheld: 500}`, with the SAME
  cursor on every retry, while the session's own activity sat at the far end of an 11,588-event
  log. Every layer underneath was correct. The tool now pages to the end (large raw pages, keeping
  the newest `limit`) and reports `complete` so "the end of the log" is distinguishable from "I ran
  out of budget". General rule: a wrapper that adds a bound is a place a bug can hide from every
  test of the thing it wraps. `smoke-inspect.ts` drives the tools for this reason.
- **An escalation protocol that cannot express WHOSE records are needed will keep producing grants
  that authorize nothing.** `request_grant` carried kind and operations, and the approval prompt
  offered "own records only" (recommended) or "all". An assistant that needed to read a registry
  written by others had no field to say so. It said it in prose instead ("both need to be
  un-scoped"), the human answered the narrower prompt, and the two halves of the exchange were
  talking about different things. Observed three times in one session: request, approve, "the grant
  landed", every read still empty. The request now carries `scope: "own" | "all"` (a REQUEST, not a
  decision, still assigned by the operator to the subject this process controls), and the prompt
  relays it. Two supporting details, both essential: `scope` is part of the request's identity
  key, or re-asking un-scoped after a scoped grant disappointed dedups into the handled request and
  vanishes; and choosing the narrow option against a measured-empty exposure now PRINTS that the
  grant authorizes nothing, because the human's answer being allowed is not the same as it looking
  like it worked. The whole loop (warning, recommendation flip, the note, the empty reads that
  follow, and the wider approval actually answering the question) is pinned in `smoke-inspect.ts`.
- **Self-scoping a REGISTRY kind grants a view of nothing, not a narrowed one.** `scope:
  {createdBy: "self"}` is the right default for a kind the principal WRITES (its messages, its
  llm_calls) and useless for one it only reads: `kind_def`, `capability`, `model` and `procedure`
  records are written by whoever declares them, so a session self-scoped on `kind_def` sees zero of
  them and `space_kinds` answers `[]` on a space with twelve. Nothing is broken, and that is what
  makes it expensive: the session was told the grant existed, saw an empty list, and concluded the
  approval had not gone through. The approval prompt (`client/grants.ts`) now MEASURES the exposure
  before offering the choice (how many of a sampled page of that kind the principal actually
  authored) and recommends against self-scope when the answer is none. Measured, not a hardcoded
  list of registry-ish kind names, which would be wrong the moment an app adds one.
- **Filtering a cursor-paged endpoint breaks paging unless the cursor is reported separately.** The
  self-scoped `/v0/ops/events` withholds events the caller may not see, and an empty page is how
  every caller detects the end of a log, so a page whose events were all withheld reads as "nothing
  further". A scoped caller could never page PAST a run of foreign events to reach its own: measured
  as 0 visible events on a space whose first 500 were someone else's. Two things were needed, and
  the second is the one that is easy to skip: scan forward across raw pages instead of filtering
  one, and report `nextAfter` from the last RAW event examined (`getEventsPage` in the SDK) so a
  caller can advance past what it cannot see. The same shape applies to any future filtered feed.
- **A bounded page over a registry must be read NEWEST-first, or a busy space hides the newest
  entry.** Discovery reads a capped page (`query {kind: capability}` limit 500), and a limited query
  returns the OLDEST matches, so a space holding more capability records than that cap shows every
  tool EXCEPT the ones published most recently. That is not hypothetical: a live session reported
  "I don't have a request_grant tool" for a tool that was published, granted and working, because
  the chat's discovery page never reached it. Every registry projection over a capped page now
  passes `{dir: "desc"}` (`ToolSet.refresh`, `Space.loadKinds`).
  Two contributing causes worth separating. The page cap is only reached because **capability
  publication was not idempotent across restarts**: the content key makes the put idempotent, but an
  idempotency key is scoped `(principal, operation, key)` and a worker's principal is a fresh
  `run:<ulid>` every launch, so an unchanged definition wrote a NEW record on every start, and a
  long-lived space grew by the whole fleet's tool count per restart (measured: 24 records per chat
  restart, so ~21 restarts to cross 500). `publishCapability` now reads the current advertisement
  first and writes only on a real change. And the chat's startup wait was "until any tool appears",
  which returns as soon as the FIRST worker publishes: fine on an empty space, meaningless on one
  where records already exist.
- **A registry is a projection, and `retired: true` is how you withdraw from one.** Declared kinds,
  assigned grants, advertised capabilities, live models and saved procedures are all mutable-looking
  tables derived from an append-only record stream, so "remove" cannot be a delete. It is a
  successor carrying `retired: true`, honoured in ONE place (`src/core/registry.ts`) rather than by
  each consumer. Two shapes, and picking the wrong one is a correctness bug: **latest-wins**
  (`activeByKey`: kind_def by kind, capability by tool, model by tier, procedure by name) where a
  re-declaration replaces, and **additive** (`activeSet`: grants) where entries coexist and each is
  independently withdrawable. Revoking a grant keyed on `(principal, kind)` would silently take
  every other grant that principal holds on that kind with it, which is why `grantKey` is the whole
  content, operations and pattern included. Two rules that are easy to get wrong: retirement must
  be applied AFTER the newest-per-key pass, never as a filter over the input (filter first and an
  older non-retired record becomes "newest" and resurrects the entry); and the projection must
  compare ids rather than trust arrival order, for the same reason. Nothing is deleted, so the audit
  trail survives a revocation, and re-declaring a retired key revives it because that record is
  newer still; there is no un-retire path to implement.
- **Record ids are MONOTONIC ULIDs, and latest-wins depends on it.** A plain `ulid()` encodes the
  millisecond and randomizes the rest, so two ids minted in the same millisecond sort arbitrarily.
  Every latest-wins registry asks "which record is newer" by comparing ids, and declaring
  something then retiring it is exactly a same-millisecond pair, so with plain ULIDs a retirement
  could be outranked by the record it retired. This was latent in `loadKinds` and the capability
  projection long before retirement existed; it surfaced as a conformance test that passed alone
  and failed in a full run, which is the signature of same-millisecond id collisions. `newUlid()`
  now uses `monotonicUlid()`. The honest limit: monotonicity is PER PROCESS, so several runtime
  instances on one Postgres are still only millisecond-accurate relative to each other. Do not
  race a retirement and its revival from two instances.
- **Predicate pushdown is a SOUND pre-filter, never a second opinion.** `src/storage/pushdown.ts`
  renders part of a compiled pattern into SQL, but the oracle in `core/matching.ts` still decides
  every match. The asymmetry is the whole safety argument: over-returning is free (the oracle
  rejects the extras), under-returning is a silent lost record, and for `take`, an empty space
  reported while work sits in it. So anything not expressible EXACTLY renders as `TRUE`: object
  and array equality (the oracle compares serialized text, so key order matters; jsonb normalizes
  it), `$any`/`$each`, a range against a non-ASCII bound, any path segment outside
  `[A-Za-z0-9_]` (segments are inlined into a JSON path literal so the planner can match an index,
  and restricting the alphabet is what makes inlining injection-proof), and any ALL-DIGIT segment
  (the next entry). Three traps that are not
  obvious until they bite: rendering a node BINDS PARAMETERS as a side effect, so a caller that
  discards the SQL must roll the parameters back too (`mark`/`rollback`), since an `$or` that discards
  one branch used to leave orphan bindings and fail the statement; `json_extract` returns SQL NULL
  for *both* an absent key and a JSON `null`, so presence is always asked via `json_type`; and an
  unguarded jsonb `>` will happily compare a string to a number, because jsonb has a total order
  across types. Every comparison is therefore type-guarded first.
- **A path segment means three different things to the oracle, Postgres and SQLite, and the
  disagreement is in the unsound direction.** Two shapes, both closed at their root rather than per
  dialect (audit package E). **All-digit segments** (`items.0`, `a.00`): the oracle indexes an array
  element through property access, Postgres' `#>` takes it as a subscript (`00` too, parsed as 0),
  SQLite's `$.items.0` is a KEY lookup that is NULL over an array, and the `@>` containment term
  asks whether an array contains `{"0": v}`, which it does not. So a record the oracle accepts got
  EXCLUDED on both dialects, and the leading-zero case over-included while still marked `exact`,
  which drags the caller's LIMIT along with it. `pushablePath` (`src/storage/pushdown.ts`) now
  declines them; the oracle handles every path, so the cost is a lost pre-filter on a shape no kind
  in this repo declares. **Prototype-shaped names** (`arr.length`, `obj.constructor`): the fix is
  the opposite direction, in the ORACLE. `getPath` used bare property access, so those resolved for
  every record while SQL correctly saw nothing there. Teaching SQL about JavaScript's prototype
  chain would be absurd, so `getPath` resolves own properties only, and an array only by a
  canonical index. A body that really holds a key named `length` is still data and still routes.
  The reusable rule: when the oracle and SQL disagree, ask which one is describing STORED DATA;
  usually it is SQL, and the oracle is the thing to narrow. Pinned by the differential case in
  `conformance/suites/pushdown.ts`, which runs each pattern through the adapter and through the
  bare oracle over one corpus and demands identical result sets, because under-return is invisible
  to any test that only checks the adapter against itself.
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
- **A claim on Postgres is planned on a guess, and the guess is wrong by 200×.** The estimate that
  fixes it has two halves. The same query SQLite answers with an ordered seek, Postgres answered
  by collecting EVERY matching record through the body index (5,715 of 40,000), joining each to its
  envelope, and sorting, because it estimates the jsonb predicate at 26 rows and concludes the sort
  is free. Not fixable by rewriting the query: `join` vs `exists`, with and without the `@>` term,
  all plan the same way, and forcing the planner with `enable_seqscan`/`enable_bitmapscan` off makes
  it *worse* (28.6ms) because it picks a different wrong plan. The fix is a real ESTIMATE:
  `PgSqlAdapter.prepareKind` creates `create statistics … on ((body_jsonb #> '{path}')) from
  records` for each declared indexed path, via the optional `StorageAdapter.prepareKind` hook that
  `Space` calls when a kind is declared or loaded. Statistics cost ANALYZE time, not write time.
  Measured end to end on a real `take` over 20k records: **9.75ms → 3.37ms p50**, with the plan
  changing from sorting 9,168 buffers to an ordered walk of `idx_runtime_claim_order` over 1,364.
  Three things are easy to get wrong, and the first two cost an afternoon each:
  * **ANALYZE `record_runtime` as well as `records`.** A claim JOINS the two, and with no statistics
    on the envelope table the join estimate collapses however good the body estimate is. The
    isolated window query measured 48ms with neither analyzed, 11ms with the envelope table
    analyzed, 1.0ms with the expression statistics on top.
  * **The two pushed terms are redundant AND correlated, and the planner multiplies them.**
    Pushdown emits `body_jsonb @> '{...}'` (what the GIN index answers) AND `body_jsonb #> '{path}'
    = '...'` (what makes the filter exact). Measured selectivity for a value matching 2,858 of
    20,000 rows: `@>` alone estimates 2,858, exactly right; `#>` alone estimates 100 without
    statistics and 2,858 with them; the two ANDed estimate **14 without and 408 with**, because the
    planner assumes independence. So the statistics help, but the residual 7× underestimate is
    structural, and dropping either term is not an option (one is the index, the other is the
    exactness that lets a LIMIT be pushed).
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
  A fresh space declares its kinds before it has rows, so the ANALYZE at declaration time measures
  an empty table; the estimate becomes real at the next autoanalyze. Nothing is wrong when a brand
  new space plans a claim badly for a while.
  Also worth knowing before optimizing a claim: an unfiltered first window (try the head of the
  queue cheaply, fall back to the filtered query) was built and **reverted**; no measurement
  supported it. It only wins when the head happens to hold a match, and in a queue where workers
  have consumed the nearby matches it just adds a round trip: every measured cell got worse
  (sqlite 1.0 → 1.3ms, Postgres 22.7 → 28.6ms).
- **A LIMIT may only be pushed under an EXACT filter, not merely a sound one.** `Pushed.exact`
  distinguishes them, and it is the difference between an optimization and a correctness bug: with
  an inexact filter SQL returns its first N rows, the oracle rejects some, and the matching rows
  further down were never fetched, so the caller silently gets fewer records than exist. `readOne`
  and `query` push the limit only when the filter is exact AND there is no `orderBy` (with no
  `orderBy` the oracle's order is its `x.id < y.id` tie-break, which `order by id` reproduces).
  Pinned by "a limit is never pushed under a filter the database cannot decide" in
  `conformance/suites/pushdown.ts`.
- **Postgres orders text by the database's collation; the oracle orders by JS string comparison.**
  Those disagree under a linguistic collation, so the pushed limit sorts `id collate "C"` (byte
  order, what JS means) against a dedicated `idx_records_id_c`. Keep it, but keep the severity
  straight too, because this entry used to claim `read_one` "could return a different record on
  Postgres than on SQLite", and for the ids the runtime actually mints it cannot. Checked directly
  (`sort` under both locales): `C` and `en_US.UTF-8` order Crockford base32 (digits and uppercase
  letters, which is all a ULID contains) IDENTICALLY. They diverge on punctuation and case, which
  is precisely what a ULID has none of. So the collation is a guard against ids ever ceasing to be
  ULIDs, not a live divergence, and no test can currently be written that fails without it. Related
  and also worth stating plainly: `scripts/pg-conformance.sh` pins no locale, so the old claim that
  "the conformance Docker image runs in C locale" was never verified by anything either.
- **`indexedPaths` are a validation contract, not per-path physical indexes.** One GIN index (`jsonb_path_ops` over the generated `body_jsonb` column) answers
  pushed equality on every path, so declaring a path costs no DDL and no migration, which is what
  keeps kinds-as-records from dragging a schema change behind it. Measured on 40k records: a
  genuinely selective `read_one` is **7.98ms without the index, 1.42ms with it**, for about 5% on
  `put`. Do not confuse that with the *headline* pushdown win: against an unselective predicate
  (the benchmark's 1-in-7 "rare") GIN is not used at all, and the speedup comes entirely from the
  pushed LIMIT letting the scan stop at the first match.

- **A claim must not lock, or even read, what it does not claim.** `take` originally selected
  *every* available-or-leased record of the kind `for update ... skip locked`, then filtered in
  the runtime. Two distinct bugs, one line. (1) **Starvation:** on a real Postgres, one claimer's
  open transaction held row locks on the entire queue, so a peer's `skip locked` found nothing
  and was told *empty* while work remained: 67 wasted takes at 4 claimers, 166 at 16. sqlite and
  PGlite hid it completely, being single-connection: the fault was invisible to `deno task
  conformance` and only appeared against a live server. (2) **Cost:** ordering the *join*
  materialized every record body of the kind before `limit` applied, making a claim O(kind size)
  in bytes, not rows. The fix is in `pgbase.ts`/`sqlite.ts` `fetchCandidates`/`take`: a bounded
  `CANDIDATE_WINDOW` (64) chosen from the narrow `record_runtime` table first, bodies fetched only
  for that window, no row locks, and single-winner resting on a **checked** compare-and-set
  (`affectedRows === 0` → try the next candidate) instead of on holding locks. Two consequences
  worth keeping straight: bounding the window is only safe because the SQL `order by` is the same
  key `rankClaimable` sorts by (`effective_priority desc, available_at asc, id asc`); change one
  and you must change the other, or a claim silently prefers the wrong record; and a *selective*
  pattern pages to the next window rather than truncating, so a rare match deep in a large kind
  is still found. `take` at 40k went 183ms → 18.4ms, and empty takes 67/166 → 2/4 (the genuine
  tail as the queue drains). Pinned by `claimFairnessSuites` in `conformance/suites/leases.ts`,
  which fails on Postgres without the fix, so run `scripts/pg-conformance.sh` rather than only the
  embedded suite before trusting a change to the claim path.
  A loose end noted while fixing it was later RESOLVED THE OTHER WAY, and the sequence is worth
  keeping because the first measurement was misleading. `idx_runtime_claim` is
  `(kind, available_at, effective_priority desc, record_id) where state = 'available'`, the wrong
  column order for the claim sort (priority leads), and partial on a predicate the candidate query
  widens (`state in ('available','leased')`, needed to reclaim expired leases), so it cannot serve
  the window's `order by`. Adding a correctly-ordered index was measured at the time and changed
  nothing (58.8ms vs 60.2ms at 40k), and this entry concluded "don't add it". That conclusion was
  wrong: the measurement was taken against a claim whose cost was dominated elsewhere. The index
  was later added as `idx_runtime_claim_order` and took a claim from **19.5ms to 0.8ms** (see the
  entry above). If you are reading this to decide whether to remove one of them: keep BOTH.
  `idx_runtime_claim_order` serves the claim window; `idx_runtime_claim` is still chosen for
  `envelopesInState`/diagnostics, where it narrows the scan to available rows (verified with
  `explain query plan`, not assumed). Also note `effective_priority` is uniformly 0 until the
  scheduler lands (M3), which is why the two orderings are indistinguishable today; the mismatch
  becomes real the day priorities differ.
- **An idempotency key travels as an HTTP header (a ByteString), so hash content into it, never
  embed it.** `Idempotency-Key` (and any header) must be Latin1; a key built from free-form content
  can carry Unicode (a tool description with `…`/`→`, a body with an em-dash) and `fetch` throws
  `Failed to construct 'Request': 'headers' … not a valid ByteString`. Content-keying a record (so a
  changed def is a successor, not a 409) is right, but the key must be a **hash** of the content, not
  the content itself. `kindDefKey`/`grant` keys are ASCII by construction (paths, types, principals);
  the capability publish content-hashes the tool def (`examples/chat/space/capability.ts`). Bit both the 409 fix and then
  this.
- **Lineage goes UP; to follow links DOWN you need children, not lineage.** `parent_ids` points
  from a record to what it was derived from, so `getLineage`/`space_lineage` returns *ancestors*;
  a **root** record (a `conversation`, a `job`) has none. To find records that *reference* a record
  (a conversation's messages, an llm_call's chunks/result, a task's results) use `getChildren` /
  `GET /v0/ops/records/{id}/children` / `space_children` (backed by `childrenOf`). This bit the
  chatbot: asked to summarize a conversation it called `space_lineage`, got just the conversation
  back, and wrongly concluded it was empty. The messages are its *children*. The two directions
  are why the console has both a lineage view and a graph view. (Guidance for the assistant lives
  in the discovered tool *descriptions*, not the chat's system prompt.)
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

- **A cast is a promise to the type checker, not a check.** Handlers used to build a `PutRequest`
  by casting wire JSON (`j.parentIds as string[]`), so `parentIds: 42`, `deadlineAt: {}`, an
  `orderBy` string, a `pattern: []`, or a JSON `null` body sailed past the boundary and failed
  deep inside matching or the adapter, so a malformed request was answered with a 500 instead of a
  400.
  Found by fuzzing every field of every endpoint with wrong types; fixed by validating shapes at
  the boundary (`pickPut`/`pickResult` in `handlers/records.ts`, pattern and numeric query-param
  checks in `handlers/leases.ts` and `handlers/ops.ts`) and, for `order_by`, in `compileOrderBy`
  itself so in-process callers are covered too. Keep the rule: if it came off the wire, check it.

- **Writing a payload and its key is two operations, so order them for the crash.** The encrypted
  blob store wrote ciphertext first and the wrapped DEK second. A crash between them left
  ciphertext with no sidecar, which the reader treated as a *plaintext* blob, so raw ciphertext
  was served as the artifact, and a re-upload never healed it because the content-address guard saw
  the file and skipped. Now: key first, payload second (an interrupted write is an honest miss);
  the "already stored" guard requires BOTH parts; and a blob at the ENCRYPTED name with no sidecar
  is damage, never legacy plaintext. Only the plaintext-digest name may be read as plaintext.

- **`esc()` must escape quotes, because record data reaches HTML attributes.** The console escaped
  `& < >` only. A grant's `pattern` is rendered as JSON inside `title="…"`, and JSON always
  contains `"`, so every pattern-scoped grant broke out of the attribute, and a crafted pattern
  or kind name (validated only as "a non-empty string") could inject an event handler into the
  page that carries an operator token. Escaping now covers `"` and `'`; the fix belongs in `esc`
  rather than at each call site, since new call sites keep appearing.
  The follow-up is the part that generalizes: `esc` being correct was never the problem, ONE call
  site interpolating raw was. `conformance/console.test.ts` now checks the property structurally:
  every `${…}` inside an HTML attribute in the page must route through `esc` or be a ternary whose
  branches are string literals, and it immediately found two more (`note`'s CSS class and
  `stateBadge`'s state, both server-supplied). The console is one file with no build step, so the
  test lifts `esc` out of the page source by brace balance rather than the page being split into
  modules; the extraction fails loudly if the function is renamed, which is what keeps the test
  from quietly testing nothing.

- **A selector on `state: available` must exclude reference kinds.** `claimable:false` records
  (the `kind_def` registry, `grant`s, `agent_run`s, plain facts) sit available forever by design.
  The first version of selector-driven remediation did not filter them, so
  `dead-letter --all --stale 0` swept the kind registry and the grants into `dead_letter`: the
  space's own control records, remediated as if they were stuck work. Caught by running the CLI
  verb against a real space, not by reading it. The starvation check had excluded them all along
  for the same reason; in remediation it is a guard, not a heuristic. `dead_letter` stays
  unfiltered so a reference record that lands there is still requeueable.

- **There is no `expired` record STATE, and the union no longer pretends otherwise.** A lapsed
  lease leaves the record `leased`; a later take reclaims it. `RecordState` used to carry an
  `expired` member nothing ever wrote, and `GET /v0/ops/records?state=expired` accepted it and
  answered zero rows: a confident nothing beside hundreds of demonstrably lapsed leases, which is
  exactly how a reader (or a model) concludes the report is broken. The member is gone from the
  union and from both OpenAPI enums, and the endpoint now answers `400` naming the query that does
  work: expiry is a PREDICATE over leased records (`state=leased&expired=1`). Diagnostics reports
  the real number as `stuckLeases`, which carries `atLeast` when its scan hit the sample cap,
  because a bounded scan must not present itself as a census. Note `take.ts` has its own
  `how: "available" | "expired"`, a different thing that happens to share the word, describing how
  a candidate was reached rather than what state it is in.

- **Client-supplied headers must win over the SDK's own credential.** The Python `_req` set
  `Authorization` from the client's token *after* merging caller headers, silently clobbering
  them. It surfaced only when `create_run` landed, the one call that authenticates with a
  DIFFERENT credential (the agent-definition token, not the client's run token). The TS client
  spreads caller headers last, so it was always correct; the two now agree. Any future
  "authenticate this one call differently" API depends on that precedence.

- **A bounded newest-first read of a thread must expand until the turn's start is in view.** Bit
  twice, in two files, within one change. A tool-heavy round is a dozen messages (one assistant
  `tool_calls` message plus a reply per call), so "read the newest N messages" can land entirely
  inside the tool replies and miss the `user` message that began the turn. In the inference-worker
  that produced a context window with no question in it (the model summarizes tool output it can no
  longer attribute); in the router it produced an EMPTY question, which the length heuristic scored
  as small talk and routed to the CHEAPEST tier, so the synthesis round, the one that most needs
  capability, systematically got the weakest model. Both now expand the descending read until a
  `user` message is included (`inference.ts` windowing, `router.ts` `currentTurn`), and the router's
  heuristic never scores an empty string as small talk. General rule: when a bounded read feeds a
  DECISION, the absence of the thing you are looking for is not a neutral default. Decide what
  "not found" means explicitly.

- **A process that executes model-written code must hold nothing; the process that holds a token
  must not execute.** Executing inside a worker that has a run token hands hostile code the space
  itself (`put`/`take` as that agent), which is a better target than the internet. Hence three
  processes in the chat example: `workers/exec.ts` (token, space access, `--allow-run`) spawns
  `deno run -` with NO permissions and talks to it over pipes only. Two consequences to preserve:
  the sandbox never gets a credential "so code can query" (the worker fetches and pipes data in
  instead, which is the confused-deputy rule again), and its emptiness is what makes lease RETRY
  sound,
  since a permissionless child has no side effect to double.

- **Read access for executed code is granted separately from the file tools' roots.** Both bound
  "which files", but the exposure differs: a tool returns one file per call, visibly, while a
  program can walk a whole tree and fold it into one line of output. So `RADIA_CHAT_EXEC_DIRS` is
  its own setting rather than reusing `RADIA_CHAT_DIRS`: widening the tools must not silently
  widen the sandbox. Two properties to keep if this is touched: roots are realpath'd before being
  granted (a symlink must not smuggle the grant elsewhere), and the blob KEK plus the operator
  credential are passed as `--deny-read`, which beats `--allow-read` in Deno, so pointing a root at
  a directory containing them still does not expose them. Write, net, env and run stay denied
  whatever is configured.

- **Deno's `--max-old-space-size` does not bound TypedArrays.** Measured: an object-allocation loop
  dies in ~0.3s ("Reached heap limit", exit 133), while `while(true) a.push(new Uint8Array(1e7))`
  runs until the kill timer, because the backing store is external to V8's old space. So the
  execution *timeout* is the real memory bound, not the flag. Keep it short, and reach for
  `ulimit -v` or a container if that is not good enough.

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

- **The graph/lineage viewer excludes nothing by default except what the caller asks**
  (`?exclude=llm_chunk`): streaming `llm_chunk` records would otherwise dominate a
  conversation graph. Keep chunk flushing coarse for the same reason (event-log volume).

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

- **A reserved kind may be EXTENDED by a redeclaration, never SHRUNK, and that is enforced on
  every path a declaration enters by.** `authorize` compiles against `grant.principal`/`grant.kind`
  and credential resolution against `agent_definition.tokenHash`, so a successor `kind_def` dropping
  one of those paths made every authorization in the space fail `undeclared_path` (fail-closed, but
  space-wide), and reinstated on every restart by `loadKinds`. It needed no operator: `kind_def` is
  deliberately NOT write-protected (an app declares its own kinds), so an ordinary `put: kind_def`
  grant was the whole vector. The fix is `assertReservedCompatible` (`src/core/kinds.ts`), which
  refuses dropping a code-defined path of a `META_RESERVED` kind or changing its `claimable`, and is
  principal-independent. Adding an index to a reserved kind stays legal, which the chat relies on
  (`conversationId` on `artifact`); note a redeclaration REPLACES rather than merges, so an
  extension must repeat the runtime's own paths. Two subtler halves are the reusable lesson:
  **the check belongs on every write path, not the one you thought of** (`ack` results skipped
  `Space.put`'s `kind_def` validation entirely, so a lease was a way around a rule the direct write
  obeyed; both go through `validateReservedBody` now), and **a startup that CASTS what a live write
  validates cannot recover from anything already in the log** (`loadKinds` adopted the stored body
  unchecked, so a pre-rule declaration outlived the fix; it validates now and skips what it would
  refuse).

- **`created_by` and idempotency scope are the RESOLVED caller, threaded from the handler, not
  `ctx.principal`.** `put`/`ack`/settle take an optional trailing `principal`; the handlers pass the
  resolved caller, so `created_by` is the token's principal (or `human:local` for no-auth), the
  event `run_id` follows it, and idempotency keys are scoped **per principal** (two agents reusing
  the same `Idempotency-Key` don't collide; that was a real bug). It defaults to the space's own
  identity, so **in-process callers** (conformance, `demo.ts`) omit it → `created_by = local:dev`,
  which is why those tests still pin `local:dev` while the handler tests pin the caller. Grant
  *enforcement* still lives at the HTTP boundary (`Space` verbs don't call `authorize` themselves),
  so in-process callers bypass enforcement and exercise `authorize`/`bodyMatchesGrant` directly.
- **Lease settlement is owner-bound, not fenced alone.** `ack` (and the other settle verbs, via the
  threaded principal) reject a non-operator principal that doesn't own the lease (`lease_owner`)
  with `lease_lost`, on top of the `leaseId`+`epoch` fencing. This closes lease-leak impersonation, which
  matters because an ack-emitted result is authorized as, and carries the delegation chain of, the
  lease owner. In-process/operator callers (no principal / privileged) skip the check.
- **The guarded UPDATE is the fence, so always check its affected-row count, and always fence
  BEFORE writing.** `ack`, `renew`, `nack` and `release` (`src/storage/pgbase.ts`, same shape in
  `src/storage/sqlite.ts`) selected the envelope without `FOR UPDATE`, validated the lease in
  application code, then ran `update … and lease_id = $ and lease_epoch = $` without ever inspecting
  how many rows it touched. Under pooled Postgres at READ COMMITTED another connection can reclaim
  the lease or bump the epoch in that gap, so the guard matched nothing and the transaction still
  committed and returned `{status: "ok"}`: a quarantined run landing one final result despite the
  epoch bump that exists to fence it out. All four settle verbs in both adapters check the count now
  and return `lease_lost` on zero, and `ack` was REORDERED so the guarded update runs before the
  result insert and its event. That makes the fence a plain early return instead of a rollback, so
  no path lets a fenced-out worker commit a result and be told `ok`. Keep the guard's limits
  straight: the new branch is unreachable on the embedded adapters, which serialize in-process and
  whose update `WHERE` is a subset of what `leaseValid` already checked, so a conformance case there
  would assert nothing. The observable contract stays covered by the fencing case in
  `conformance/suites/leases.ts`; exercising the race itself is fault-matrix work against a live
  Postgres ("stale ack after reassignment", "ack after quarantine", driven concurrently). See
  [plan-validation.md](plan-validation.md).
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
  travels in the served page.** `Space.mintOperatorToken` (startup) registers a hash in `CredentialStore`
  that resolves to the privileged `human:local`, never expires, and is NOT persisted (like the
  in-code meta-kinds). It is the one credential that legitimately lives in memory: it cannot be
  revoked because it cannot outlive the process. **Never bake it into `index.html`.** `GET /` is
  public so the console can bootstrap under `--auth required`, so an embedded token is readable by
  anyone who can reach the port, and it authorizes every verb. The console prompts for a token and
  keeps it in `sessionStorage`; `conformance/console.test.ts` fails if a credential-shaped literal
  or a substitution placeholder reappears in the page. The substitution machinery is gone rather
  than disabled: `loadUi` interpolates nothing and `ServerOptions.operatorToken` no longer exists,
  so there is no path to reinstate it by passing an option.
- **The operator token resolves as `kind: "operator"`, never `"def"`.** It authorizes coordination
  directly, as the space's own principal. The CLI, the MCP adapter and `curl` all present it, so
  resolving it to anything that 401s breaks every local tool. Resolving it as a DEFINITION token
  breaks the other way: definition tokens mint runs, so a leaked operator credential would convert
  into a long-lived run token, and a credential that cannot be revoked would become one that
  outlives the process. It authorizes everything and mints nothing. Encoded once as a distinct
  `ResolvedToken` variant (`src/core/auth.ts`): `Space.resolveCredential` returns
  `kind: "operator"`, `resolveAuth` (`src/server/http.ts`) accepts it beside `run`, and `mintRun`
  refuses it, so the escalation is closed at the source rather than at each caller. Guarded by
  `conformance/http.test.ts`, which asserts the provisioned operator token reaches health, the ops
  plane and a `put` under `--auth required`, and that it cannot mint a run.
- **The open-mode no-header shortcut is for `curl`, and nothing radia ships may rely on it.** A
  request with no credential resolves to `human:local`, the operator, which is the largest authority
  a space has and the least visible way to acquire it: a client gets it by nobody having typed
  anything. The CLI and MCP adapter always presented a token; the console and the chat did not, and
  both silently ran privileged. Both now refuse to start without one (`api()` in `src/ui/index.html`
  short-circuits any non-public path; `examples/chat/chat.ts` exits before touching the space), and
  the chat's two credentials are separate on purpose, since the person at the keyboard is not the
  operator that bootstraps the fleet. The shortcut is now behind an explicit `--auth open`, so a
  space nobody configured is closed. The examples were the last holdouts and now read the
  provisioned operator credential (`examples/operator.ts`) instead of sending no header, which also
  means they exercise the authenticated path they exist to demonstrate.
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
- **`fetch` REJECTS when nothing is listening, so a stopped space is an exception, not a status.**
  The console's `api()` returns `{ok, status}` and every caller reads it, so an uncaught rejection
  froze the page on its last good render. It now maps a network failure to `status: 0`, distinct
  from any HTTP status.
- **Runtime paths belong in `src/paths.ts`, never at a call site.** A space writes a database,
  artifact blobs and (optionally) the space KEK, and each was named where it was needed:
  `.radia-blobs/`, `.radia-kek.json`, `.radia-chat-space.db` and `.radia-chat-space.db-blobs/`, four
  top-level entries nobody chose as a set. They now default under one `./.radia` (`RADIA_DIR` moves
  it), which makes `rm -rf .radia` a complete reset and lets the chat's sandbox deny ONE directory
  instead of a list that drifts as paths are added. Two properties to preserve when adding one: the
  KEK stays a SIBLING of the blob directory rather than inside it (copying blobs must not carry the
  key), and blobs stay `<db>-blobs` when `--db` names a place outside the runtime dir (a space's
  bytes and its records belong together). Also note SQLite will not create a missing parent
  directory, so a new path needs `ensureParent`; the error otherwise names the file and reads like
  corruption.
- **The provisioned credential is keyed by HOST, so `localhost` and `127.0.0.1` are two spaces.**
  `baseKey` (`src/credentials.ts`) keys on `protocol//host`, and `radia dev` binds `127.0.0.1`, so
  anything defaulting to `http://localhost:7788` finds no credential for a space it can otherwise
  reach. Two examples and the TS SDK defaulted to `localhost` and started failing the moment auth
  became required. Every default now agrees on `127.0.0.1`. The aliasing was NOT fixed in
  `baseKey`: two names for one host is exactly the kind of helpful normalization that surprises
  someone later, and the error message names the trap instead.
- **Mutable module state is per-PROCESS, and the chat's workers are separate processes.**
  `sessionOwner()` (`examples/chat/space/roles.ts`) is set by the REPL after it resolves the login
  token. The tools-worker imports the same module in its own process, where nothing sets it, so
  `request_grant` stamped `owner: agent:chat-user` on a space whose session grant was
  `{owner: human:alice}` and the write was refused. That killed the ONE escalation path the system
  prompt tells the model to use, and the model reported it as its own request being restricted, so
  the symptom pointed at authorization rather than at a stale global. Worker-side code takes
  identity from `ToolContext.owner`, the value the session stamped on the tool_call and the runtime
  already checked against that session's write pattern. Guarded structurally in `smoke-login.ts`
  (no worker-side module may IMPORT `sessionOwner`), because the bug is invisible at the call site:
  the function reads correctly and is wrong only because of which process is running it.
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
- **A verdict the subject can write is not a verdict.** `check` records say whether a run did what
  was claimed of it, and the exec-worker is the only principal with `check: put`; the chat session
  holds `query` alone. If the session could write one, "the code works" would be the model grading
  its own output, which is exactly what the prose it already produces does. The same shape applies
  to any evidence kind: the party being judged must not hold the pen. Two boundaries that look like
  details and are not: an ABSENT expectation records no verdict rather than a passing one (an
  unverified run must not read as successful), and a TIMEOUT fails `exit_zero` (a killed process has
  a null exit code, and treating that as zero turns the worst outcome into a pass).
- **A CLI verb must read its positional through `positional()`, never `argv[0]`.** A flag written
  before the argument is otherwise taken AS the argument, and for a verb whose argument is a bare
  string the failure is silent: `radia permissions --json alice` reported on a principal named
  "--json" and printed a well-formed answer about nobody. Three verbs had it (`login`, `shred`,
  `permissions`), all added recently, all reading `argv[0]` while the other ten used the scanner.
  A new valueless switch must also join `VALUELESS` in `src/flags.ts`, or the scanner eats the token
  after it. Guarded structurally in `conformance/defaults.test.ts`, which strips comments first,
  because the rule is explained in a comment that names the thing it forbids.
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
- **A column that exists is not a behaviour that happens.** `record_runtime` carries `claim_until`
  and `effective_priority`; both are written as `undefined`/`0` at every call site and neither is
  consulted, so "no new claims after this time" and "aged by sweeper" described nothing. Same shape
  as `retention_until`, and `schema_version` is a constant. The schema, the indexes and the ranking
  code are all real, which is what makes this convincing: `Space.take` genuinely orders by
  `effective_priority` and therefore always falls through to the next tiebreak. Before planning
  against a documented field, grep for a WRITE of a non-default value and for a read that filters on
  it; scaffolding for a later milestone looks identical to a live feature from the schema alone.
- **An unenforced record-size limit is an ERASURE hole, not a performance note.** Nothing rejects a
  large body (verified: 4 MiB accepted, while the same bytes as an artifact hit a 32 MiB cap), and
  the erasure boundary is precisely "payloads are out of line, so they can be destroyed; bodies are
  not, so they cannot". So the missing limit is the mechanism by which unerasable data enters a
  space: base64 a secret into a body and no operator verb reaches it. That moves the record-size
  limit above the rest of the unbuilt resource limits, which only bound cost.
- **A jail's own description is the first thing to distrust, including your own.** `bwrapSandbox`
  claimed `writablePaths: []` and the probe caught it on the first run: bubblewrap's root is a
  tmpfs, so a program CAN write there. Nothing escapes and nothing persists, but the claim was
  false, and a record is only worth something if it says what the jail GOT rather than what was
  intended. Write the probe before believing the spec, even when you wrote both.
- **Prefer a guarantee that holds by ABSENCE over one that holds by presence.** Deno's sandbox is
  safe because nothing was granted: forget every flag and you get the safe answer. A bubblewrap or
  container jail is safe because `--unshare-net` / `--network=none` was passed: forget one and you
  get the unsafe answer, silently. That is not "property versus configuration", it is fail-closed
  versus fail-open, and it is the thing to check first when a second isolation backend is proposed.
  The mitigation is a boot-time PROBE (try to connect, try to write, try to read a path that should
  not be there) and refusing to advertise a jail that fails it, because a structured claim nobody
  tested is more convincing and no more true than a sentence in a description.
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
- **An agent that discovers its abilities from records cannot discover one nothing publishes.**
  Both SDKs have had `artifactCapability` since artifacts shipped, and the chat had no tool for it,
  so the assistant could store a file and not hand it over. Asked for a link it quoted the id-based
  URL (a `401` in a browser) or invented a capability URL, because inventing was the only move left:
  `run_javascript` has no network, and `request_grant` asks for a permission when what was missing is a
  VERB. Before concluding a model "does not understand" something, check that a tool for it exists
  and that a description says when to reach for it. See `share_artifact` in
  `examples/chat/tools/save.ts`.
- **The capability URL is the one URL a PERSON handles, so its length is a real property.** It was
  122 characters: origin, `/v0/artifacts/`, a 26-character ULID, `?capability=`, and 64 hex. The
  capability already names one record, so the id and the query string were redundant; `GET
  /v0/a/{capability}` is 46. The token is now 16 bytes as base64url (22 chars) rather than 32 as
  hex, which is not a weakening: it opens one object for a few minutes, is not an identity, and the
  short form carries no id to substitute. Two boundaries kept: it stays under `/v0` (a root path
  saves three characters and buys an unversioned public surface), and the long form still works,
  since that is the one OpenAPI marks `stable`.
- **A capability URL must come back ABSOLUTE to anything that is not the console.**
  `POST /v0/artifacts/{id}/capability` returns a RELATIVE url when no isolated artifact origin is
  running (`--artifact-port 0`). The console resolves that against its own origin; an agent hands it
  to a user verbatim and it opens nothing, with no way for the model to know what to prepend. The
  chat's tool resolves it against the client's base before returning.
- **A check written against ONE member of a set breaks the moment the set grows, and a rename is
  exactly when it grows.** The exec worker decided "this is a saved procedure, not a built-in" with
  `b.tool !== "run_code"`. Renaming that to `run_javascript` kept it correct; adding `run_python`
  beside it did not, so every Python call went down the procedure path and came back as "no
  procedure named run_python" — with the capability published and the jail working, which is why it
  read as an execution bug. It is now a `BUILTIN_RUNNERS` set. Grep for the OLD name's remaining
  comparisons before adding a sibling, not after.
- **"Refuse or fabricate" is usually a false pair.** The git export refused an erased payload
  because the obvious repair (a placeholder blob) would make the tree hash to something the manifest
  never described. OMITTING the entry is a third option and an honest one: a tree that does not
  contain the file makes no claim about it. What made it honest was closing the remaining gap,
  silence — the subject line, the commit trailers and the repository `description` each say what is
  missing, the last because it is the only channel that survives the directory being passed on.
- **Discriminate a skippable failure by its STATUS, never by how its message reads.** `--partial`
  skips a 410 (bytes deliberately destroyed) and nothing else. A 404 is a manifest pointing at
  something that never existed; a digest mismatch is content disagreeing with its claim. Both look
  like "cannot read that file" and neither is erasure, and skipping them would return a repository
  that looks complete. Any "best effort" option needs this line drawn explicitly, with a test on the
  wrong side of it.
- **A worker handler must ANSWER a permanent failure, never throw it.** `agentLoop` nacks a throwing
  handler and the record becomes claimable again (`sdk/ts/loop.ts`), which is right for a transient
  fault and exactly wrong for one that cannot succeed on retry. A shredded file in a workspace made
  `materialize` throw, so `run_python {workspace}` re-failed in a loop until the CLIENT's tool
  deadline and the user saw `timed out waiting for 'run_python'` with no reason given. Returning a
  `tool_result` turned a two-minute hang into a one-line explanation in about a second. Ask of every
  throw in a handler: can a retry possibly help? If not, it is a result.
- **A status hint is a DIAGNOSIS and must be evidence-based, not timer-based.** The chat showed
  "no worker serves 'x'" after 2.5 seconds without a `progress` record — but most tools emit no
  progress records at all, so it accused a worker that was about to answer, then vanished under the
  reply. What a client can actually prove is what is ADVERTISED (that set is what it handed the
  model); LIVENESS it cannot, since a `capability` record is an advertisement and a stopped worker's
  record lingers, and a scoped session cannot read the envelope. So the hint now claims only the
  provable half and the timeout names both possibilities.
- **Anything that abandons a turn mid-flight must answer the tool call it interrupted.** Escape-to-
  cancel lands in precisely the window that bricks a conversation, so it appends a `tool` reply
  exactly as a timeout does. The general rule: every early exit from a turn is a candidate for the
  unanswered-`tool_calls` bug, and the place to fix it is the one exit path all of them share, not
  each new feature. Cancelling also stops only the WAITING — a claimed `llm_call` or `tool_call`
  still completes and still writes its result, so a message that implies the work was undone is
  wrong about an at-least-once substrate.
- **An assistant `tool_calls` with no reply BRICKS a conversation, permanently.** OpenAI rejects the
  whole payload ("must be followed by tool messages responding to each tool_call_id"), and the thread
  is durable, so every later turn reassembles the same rejected history: 59 messages, none of them
  sendable. Produced by any throw between writing the assistant message and writing the reply —
  `awaitToolResult` throwing on the tool deadline was the live one. Two fixes, and BOTH are needed:
  `runToolCall` appends a reply on every exit path including failure (prevention, and the model gets
  to see "timed out"), and `assembleContext` pairs calls to replies in both directions (repair,
  which is the only thing that helps a conversation already holding one). A partially answered
  message keeps the calls that WERE answered — dropping it whole orphans the surviving replies and
  trades one protocol violation for the other.
- **A tool scoped more narrowly than the GRANT contradicts the tools that are not.** `list_workspaces`
  filtered to the current conversation while `space_count` was owner-scoped by the grant: one
  answered 8, the other none, both correctly, and the model spent eight tool rounds failing to
  reconcile them before giving up. The narrowing was doing no security work either, since the query
  is bounded by the grant regardless. Where relevance really does differ from permission, MARK the
  rows (`thisConversation: true`) rather than hiding them, and say in the description what to do
  about the difference — a name the model cannot use, with no way to know why, is worse than a
  longer list.
- **When a model cannot READ something, it reconstructs it, and says so while presenting it as
  real.** Workspaces had save, list and run, and no read. Asked to show a file in a tree, the model
  tried `read_file` (sandbox paths only, denied), rebuilt the contents from earlier in the
  conversation, stored the reconstruction with `save_content`, and answered with it — noting that it
  was a reconstruction, which no user reads as "this is not the file". Fabrication is what fills a
  missing read path, so the absence of a reader is not a convenience gap, it is a correctness one.
  Two fixes: `read_workspace` exists, and `list_workspaces` reports the PATHS rather than a count,
  because "what files are in X" had no data source either and was already being answered from memory
  one question earlier.
- **"Deduped" at one layer is not deduped at the next.** Phase 10 asserted the storage saving from an
  edit was ZERO, reasoning from the blob store: identical bytes share a blob, so re-saving a tree
  moves no bytes. True, and the wrong layer. `putArtifact` is called once per file per save and
  creates an artifact RECORD each time, so a six-file tree re-saved for a one-line change appends six
  records where an edit appends one. The claim was made from a real property of a neighbouring
  component instead of from a measurement, which is the same shape as citing a rule whose
  precondition does not hold — and it survived until someone measured it on the way to measuring
  something else.
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
- **A header assertion cannot tell a classic script from a module.** The tree-serving conformance
  case checked the CSP and the media types and passed, while the first real page in a browser loaded
  nothing: the document was sandboxed without `allow-same-origin`, so its origin was opaque, so every
  subresource fetch was cross-origin, so `<script type="module">` failed on missing CORS. A classic
  `<script src>` survives that, which is why the hand-written fixture worked and the model's output
  did not. Where the contract is "a browser can render this", a test over response headers is a
  proxy, and the gap between the proxy and the thing is exactly one browser behaviour nobody
  remembered.
- **A bounded read of a registry stays a bug after you fix its DIRECTION.** The chat's tool list read
  an ascending page of 500 and lost the newest tool on a space with 505 records. The fix was
  `dir: "desc"` — which corrected which tools vanish (least-recently-republished instead of newest)
  and left the boundedness. Measured mid-session on a real space: **737 capability records for 33
  tools**, so the page was within 1.5x of silently dropping tools again. CLAUDE.md already said
  registry state is read through `readRegistry`, never a hand-rolled `query(kind, N)`; this was the
  hand-rolled one, in the most consequential place, and the failure mode is invisible — "the
  assistant does not have that tool" is indistinguishable from "it did not think to use it".
- **A tool description is only read once the model is already considering that tool.** With
  `share_workspace` in its list, a model holding a freshly split three-file page reasoned that opaque
  artifact URLs made relative links impossible and told the user no link could be given. The
  description was correct and never consulted, because the model was not asking "which sharing tool"
  — it was asking "is this possible at all". Fix: the RESULT carries the affordance at the moment it
  applies (a saved tree containing `index.html` says it is a browsable site and names the tool), the
  same move as `forked` and `incomplete`. Where a capability only becomes relevant because of what
  just happened, announce it in the thing that just happened.
- **A tool tested with an operator client does not test the WORKER's authority.** `read_workspace`
  and `edit_workspace` were driven in `smoke-save.ts` through `makeWorkspaceTools(admin)`, which is
  right for testing descriptions and edit semantics and cannot catch what shipped: the tools worker
  held `artifact: put` and no `read_one`, so every read and every edit in a real chat answered
  `forbidden` while the suite stayed green. The comment beside the grant said "WRITE only, it never
  reads one back" — true when written, false the moment a reader was added and the grant list did
  not follow. Third instance of this exact shape (the exec worker's missing `workspace: put`, then
  its missing `sandbox: put`). **When a worker gains a capability, its grants are part of the
  change**, and at least one assertion has to run through a live worker over a real `tool_call`,
  because that is the only thing that exercises the identity rather than the code.
- **An error that does not say what to do next gets diagnosed creatively.** `oldString not found`
  was accurate and useless: the model had guessed the text instead of reading it, concluded the
  failure was a permissions problem, and asked for a grant — which the human then narrowed, breaking
  the read access it did have. One bad message produced a three-step cascade ending in less access
  than it started with. The message now names the likely cause, says to read the file, and states
  what it is NOT. Whenever a tool can fail for a reason the caller could fix, say which reason.
- **A RAISE and an INHERITANCE look alike and need opposite rules.** Asking "should file artifacts
  carry labels at all" admitted no answer that was right for both: a caller asserting what the graph
  does not know ("this tree came off a filesystem") may label whatever it likes, because raising is
  monotone and needs no trust; a derived tree carrying what its predecessor carried must travel on
  the record graph and nowhere else, or the copy can drift from the fact. `writeWorkspace` does the
  first, a write-back and an edit do the second. The question that produced a decision was the wrong
  question, and taking its answer literally would have deleted a tested feature.
- **Check a cited rule's PRECONDITION before leaning on it.** "A label exists only where a lineage
  walk is too slow" was cited to justify leaving workspace file artifacts unlabelled — but there is
  no lineage walk from an artifact to its manifest (the reference is a body field, not a parent
  edge), so the rule does not reach the case it was used to decide. The decision survived on two
  different arguments (recovery by query, and additivity making it reversible), which is lucky
  rather than sound. A rule invoked outside its precondition is worse than no rule: it ends the
  discussion while leaving the reasoning wrong, and the next reader inherits the citation, not the
  check.
- **A dead ternary reads as a decision, which is why it survives review.**
  `{ taint: b.owner ? undefined : undefined }` sat in the exec worker's write-back call and looked
  deliberate enough that a reviewer and an audit both read it as a laundering hole. It was neither:
  the parent edge already carried the labels, so the parameter was redundant rather than unfilled.
  A leftover expression whose branches are identical is worse than a missing argument, because a
  missing argument reads as missing.
- **A defect that SHRINKS under checking deserves the same write-up as one that grows.** The same
  finding went from "write-back carries no labels at all" to "artifacts only" to "correct by design",
  across two corrections, because each check narrowed it. Recording only the confirmed defects
  teaches the reader that reviews find bugs; recording the walk-backs teaches them to check first,
  which is the more useful habit and the one that produced the right answer here.
- **Two branches of one function, one of which checked its credential's status and one of which did
  not.** `resolveCredential` checked `agent_run` for `status === "stopped"` AND `expiresAt`, then
  returned `{ok: true}` for `agent_definition` on the mere EXISTENCE of a record — no status, no
  expiry, and no revocation path existed to check for. So the credential design's whole argument
  ("credentials resolve from records per request, so revocation is immediate") held for every
  credential except the one that never expires, and a leaked definition token minted fresh runs
  forever. The fix is the run's own shape: a successor carrying the SAME `tokenHash`, so revocation
  lands in the single indexed lookup authentication already performs. When two things in one
  function are the same KIND of thing, read them side by side and ask what one does that the other
  does not; the asymmetry was two lines apart for a milestone.
- **A credential that mints authority must not be able to name a privileged subject.** A definition
  mints runs for its subject, so `createAgentDefinition("human:root")` on a space whose operators
  include it was a permanent way to mint privileged runs — and until revocation existed, a permanent
  one. Refused at mint. The general rule: wherever a factory takes a principal, check it against the
  identities whose authority is NOT expressed as grants, because nothing downstream narrows those.
- **Revoke and stop are different decisions and must stay separate verbs.** Revoking a definition
  leaves already-minted runs alive on purpose: conflating them would make "stop handing out new
  authority" also mean "kill the work in flight", which have different blast radii and belong to
  different moments in an incident. Revoke first, then stop the runs that matter.
- **A layering rule and a broken shipping artifact were the same defect, seen from two sides.**
  `sdk/ts/client.ts` imported the wire types AND runtime values from `../../src/`, with its own
  header saying a standalone type surface would be extracted in Phase 7. Phase 7 shipped and it was
  not, so `build-release.sh` — which stages `sdk/` and `extensions/` into the npm package and no
  `src/` — published a package whose entry point (`"." : "./sdk/client.ts"`) imported four paths
  that are not in it. The fix is directional: `sdk/ts/wire.ts` OWNS the contract vocabulary and the
  old definition sites re-export from it, so nothing inside `src/` had to move. A contract the
  client cannot ship is not a contract.
- **A structural guard certifies only what it looks at, and this one did not look at `sdk/`.**
  `layering.test.ts` checked `src/` and `extensions/` and passed while the one file breaking the
  extensions-tier claim sat in the directory it never scanned. Type imports count too: erased at run
  time, so the package runs and then fails to type-check, which is a later and more confusing
  failure than a missing value. When adding a tier rule, enumerate every directory the rule is
  ABOUT, not the ones the violation was expected in.
- **A registry rebuilt only at startup is single-instance by accident.** `loadKinds` ran once, and
  `put` of a `kind_def` registers the declaration in the WRITING process's registry only, so with
  N instances over one database a kind declared on A was unknown to B until B restarted, and a kind
  REDECLARED on A left B compiling against the old contract. Reads failed; writes were always fine,
  because one GIN index serves every path, so the declaration governs COMPILATION and not physical
  storage. Fixed by driving the refresh from the SYMPTOM (`unknown_kind` / `undeclared_path` →
  re-read that one kind → retry once) rather than from a timer: a periodic refresh has a staleness
  window by construction and polls forever to close a gap that is usually not open, and refresh-on-
  MISS alone would have fixed only the first half, since a stale declaration is not a missing one.
  The old conformance test asserted `unknown_kind` before `loadKinds()` — the bug written down as
  expected behaviour, which is the form these live longest in.
- **An undone erasure was not just a no-op, it was INVISIBLE.** `shredOf` had exactly one caller,
  inside the branch that runs after a read has already failed, so once the bytes returned nothing in
  the system ever consulted the shred record again. The fix is detection, not enforcement: a marker
  plus a present blob is a reversed erasure, derivable in one `stat`, reported by `Space.erasures`,
  `GET /v0/ops/erasures` and `radia doctor`. Scoped callers get the field OMITTED rather than zero,
  because "no erasure was undone" is the one reassurance nobody should receive on no evidence.
- **A measurement that settles one question gets read as settling the next one.** Phase 1 measured
  manifest SCALING and found the ~6 300-entry cap, which genuinely settles where a dependency set
  lives (out of line, no choice). `plan-workspaces.md` then wrote "SETTLED", and the adjacent
  question — whether the materialisation cache that decision requires is cheap or even buildable —
  was never measured and is still unbuilt. When a measurement decides something, write down what it
  did NOT decide, or the confidence leaks sideways.
- **Erasure leaves a confirmation oracle, and the argument against it was already in the repo,
  pointed at the neighbouring case.** The plaintext sha256 lives in the artifact record's body,
  which has no erasure path, so a shredded payload stays confirmable to anyone with a candidate —
  while `BlobCipher.storageName` HMACs the same value precisely because a storage name must reveal
  nothing about its content. Two layers, opposite postures, one documented. And
  `design-data-model.md` already reasoned that a retained `body_sha256` leaves a low-entropy body
  brute-forceable, concluding "the digest that makes artifact erasure safe is the thing that makes
  body erasure unsafe" — its own counter-example, carried one case short. When a doc states a
  hazard, check the sentence next to it for the case it was not applied to.
- **Erasure by content cannot mean "these bytes may never exist here again".** A pre-write check
  refusing any payload whose digest was ever shredded was written and reverted the same hour: it
  poisons a content address for the whole space, so shredding an empty file or `"hello\n"` blocks
  every later write of it, and it breaks any program that legitimately recomputes the same output.
  Erasure destroys the runtime's copy; someone re-uploading bytes they already hold learned nothing
  from it. What IS worth fixing is that the erasure must be legible where it bites — the runner and
  the reader now say "ERASED, permanently, save a successor without this path" instead of hanging or
  returning nothing.
- **A write-only tool is half a tool, and the missing half is the one that saves tokens.**
  `save_workspace` shipped without a way to LIST, so an assistant told to "fix the bug" re-created
  the project from memory and lost every file it was not currently thinking about: "what did I
  already build" had no answer. Whenever a tool creates named state, ask what reads the names back
  before shipping it. The listing also has to distinguish "no workspace called X" from "I could not
  see all of them", since only the first is safe to act on by re-creating X.
- **`query <kind>` is not a listing when versions are records.** Three saves of one workspace are
  three `workspace` records, so a raw query answers a question nobody asked and counting its rows is
  wrong twice over. Anything registry-shaped needs the latest-wins-minus-retired projection, and it
  belongs in ONE place: `summarizeWorkspaces` is shared by `radia workspaces` and the chat's
  `list_workspaces` precisely so the two cannot disagree about what exists.
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
- **A git tree can hold two entries with one name, and it builds, hashes and writes fine.** `a` as a
  file plus `a/b` produced exactly that. Only `git fsck` rejects it, which is why the export suite
  round-trips through the real binary where one is installed rather than trusting its own vectors:
  vectors written by the same author who wrote the encoding are wrong in the same direction.
- **A git export's author is `created_by`, never the manifest's `owner`.** Provenance is not
  authority. `owner` is a body field a client submits, so taking the author line from it would let a
  record name whoever it liked as its writer. It travels as a trailer instead, where it reads as the
  claim it is.
- **Two runners are two overlapping tools, so the SAME description rule applies, and only one half
  of it was written.** `run_python` named `run_javascript`; `run_javascript` did not name
  `run_python`, and it opened with "Run JavaScript" as one word ahead of four hundred about
  `save_as`. Asked for "python code finding the first 10 primes", the model called
  `run_javascript` with a Python program, twice, read back a `SyntaxError`, and then tried
  `os.system('python3 …')` to get out of it. Nothing was broken. The fix is the rule that already
  existed for `save_content`/`run_javascript`: each names the other AND states the condition that
  selects it (here: the language written), in the OPENING clause where a model comparing tools
  reads. The shelling-out attempt needed its own sentence, because "cannot start processes" was
  true and buried.
- **A description may only name a tool that EXISTS, so a cross-reference between optional tools has
  to be built per boot.** `run_python` is published only where its jail probes clean, so a static
  `run_javascript` description naming it is unreachable advice on every host without bubblewrap:
  the model calls it and gets "unknown tool", which is the same defect as naming no alternative.
  `runJavascriptDef(pythonServed)` builds both variants, and the sibling is published BEFORE the
  description that names it — a description pointing at a tool that is not there yet is a failure,
  while one that does not mention it yet is merely incomplete.
- **A language is a CAPABILITY NAME, not an argument or a router decision.** `run_python` is
  published only where its jail probes clean, so a space without `bwrap` never advertises it. A
  `requires: {language}` argument would be expressible everywhere and fail at execution, after the
  model committed a turn to it; a router would have to fall back, and a fallback means running
  somewhere weaker than asked. The `llm_call` tier router is NOT the precedent: a tier is a
  judgement about a turn, worth delegating; a language is a fact the caller already holds, because
  it wrote the program. A router earns its place only when a caller states REQUIREMENTS rather than
  a name. See [design-execution.md](design-execution.md).
- **Adding a THIRD overlapping tool reopens a boundary two tools had already settled.** Fixing
  `run_javascript` vs `save_content` did not survive `save_workspace` arriving: `save_content` still
  listed "code" among what it stores and still claimed to be "the DEFAULT way to give the user a
  file", so for a program it competed with a tool strictly better at it (a workspace can be RUN,
  keeps every version, and is what a verdict attaches to; an artifact is bytes). The rule now stated
  in all three: a document goes to `save_content`, code of ANY size goes to `save_workspace`, a
  throwaway calculation goes to `run_javascript {code}`. Whenever a tool lands in a space another already
  occupies, re-read the incumbent's description rather than only writing the newcomer's.
  Rebalancing also has a trap: cutting the incumbent's claim too far reintroduces the ORIGINAL bug,
  and the suite caught exactly that here (removing "DEFAULT" from `save_content` un-fixed the
  reason it was added). Scope the claim instead of dropping it.
- **Two tools that reach the same outcome are chosen by their DESCRIPTIONS, so an unconditional
  claim beats a conditional one.** `save_content` (authored text) and `run_javascript` + `save_as`
  (computed bytes) both produce an artifact, so nothing fails when the wrong one is picked. The
  model consistently picked `run_javascript` because its description said "that is how you save a file"
  with no condition and never named `save_content`, while `save_content` deferred to `run_javascript`,
  gated its trigger on the user saying "save", and did not list HTML. Asked to "create a web page",
  the assistant wrapped the HTML in a `console.log` and stored stdout, sending the content twice.
  When two tools overlap, each must name the other AND state the condition that selects it; a
  one-way cross-reference is what produces the silent-but-wasteful path. Guarded by
  `examples/chat/smoke-save.ts`, which reads the descriptions back from the `capability` records the
  running fleet publishes rather than importing them, since a fix that is never republished changes
  nothing for the model.
- **Privilege is a NAMED SET, not a name prefix, and `human:` is a namespace.** `isPrivileged`
  (`src/core/space.ts`) checks `ctx.operators` (default `["human:local"]`), the supervisor, and the
  space's own identity. It used to treat every `human:*` as an operator, which meant a space could
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
- **Graceful stop ≠ quarantine.** A lease is owned by the claiming principal (`take` threads it
  into `lease_owner`; a run token → `run:*`). `stopRun` (default) only stops the token resolving:
  the run's in-flight leases expire on their own clocks, NOT immediately. `stopRun({quarantine:true})`
  is the emergency path: `quarantineLeasesOf` force-releases them now with an **epoch bump**, so a
  late `ack`/`renew` fences out as `lease_lost` (that bump is essential; without it the stale
  holder could still settle). Don't assume a plain stop kills live leases.
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
- **The one operation whose purpose is accountability must name its actor, and must be its own event
  operation.** `Space.declassify` called `putRaw` with NO principal, so the clean successor's
  `created_by` (and therefore the emitted event's `runId`) was the space's own `ctx.principal`, not
  the operator who approved the clearance, and the event carried `operation: "put"` because there
  was no `declassify` operation in the log at all. The entire audit trail for a clearance was the
  successor's `parentIds` plus an anonymous put. That outranks the hash-chained log (M1–M2): a
  tamper-evident chain over a record that omits the approver protects the wrong fact.
  `Space.declassify(recordId, principal)` threads the approver, and the commit records a distinct
  `declassify` operation carrying `{declassifiedFrom}`, via an optional `event` override on
  `PutInput` that both adapters honour, so a clearance is greppable instead of hiding among ordinary
  puts. Guarded by `conformance/suites/taint.ts`: the successor is authored by the approver, exactly
  one `declassify` event names them, and ordinary puts are unchanged. The general shape: if an
  operation exists to be audited, it needs its own verb in the log, because an entry that looks like
  every other write is not findable after the fact.
- **The taint barrier filters candidates in core, not SQL.** It lives in `rankClaimable` (skips a
  candidate carrying any label outside the allowlist), threaded via `LeaseSpec.allowTaint`, so
  both adapters get it for free and it stays backend-neutral. It's a claim-time skip, not a query
  predicate (taint is runtime metadata, not body; the content-routing DSL can't see it, same as the
  envelope).
- **Pattern-scoped grants apply to reads/claims AND writes.** A grant's `pattern` is AND-ed into
  `query`/`read_one`/`take` (`grant ∧ request` via `combineMatch`), and on `put`/ack the record body
  must satisfy it (`Space.bodyMatchesGrant`), so a scoped principal writes only records inside its
  pattern. Note the asymmetry: read-side ANDs the pattern into the *query*; write-side matches the
  *body* against it. Also: the read constraint nests as `$and[request, $or[patterns]]`, so a grant
  pattern must be a flat equality map: a `$or`/`$and` inside one can exceed the depth-3 compile
  limit. And a pattern's paths are validated (indexed-path check) only when it compiles at use, not
  at grant creation (the kind may not be registered yet), so a bad path surfaces as a 400/denied later.

- **Stale-available diagnostics count only `claimable` kinds; reference records are not "stuck".**
  A record sitting `available` isn't necessarily starved work. Reference kinds (`claimable:false`:
  facts, config, `grant`/`kind_def`/`agent_*`, conversation history) are written once and read by
  `query`, never `take`n, so they sit available forever by design. `Space.diagnostics` excludes
  them (`excludeKinds`, filtered in the adapter query *before* the 500 sample cap, so a real starved
  `task` is never crowded out by hundreds of `message`/`capability` records). Reserved control kinds
  default `claimable:false`; user reference kinds must declare it. Don't "fix" a large
  stale-available count by raising the threshold; check the kinds are marked reference.
- **`KindRegistry.register` copies fields explicitly, so add new `KindDef` fields there or they're
  silently dropped.** It rebuilds the stored def (`{kind, indexedPaths, sortablePaths, …}`) rather
  than spreading, so a new field (like `claimable`) is lost on registration unless you add it to the
  copy. This bit the `claimable` work: the flag validated and persisted fine but read back as
  `undefined` everywhere until `register` was taught to carry it (caught by conformance). Same
  applies to `kindDefKey`: include a new field there too, or a changed value won't mint a successor.
- **The ops query language is body-only by design; the envelope query is the ops exception.**
  The content-routing pattern DSL matches record *bodies* (for routing) and deliberately can't
  see the runtime envelope (state/attempt/lease). So observability that needs the envelope
  (diagnostics, "what's stuck") is NOT a pattern query; it's `GET /v0/ops/records?state=…`
  (`Space.queryEnvelopes`), and diagnostics composes that. Don't try to fold envelope-state,
  aggregation (stats), DAG-traversal (lineage/graph), or get-by-id into the pattern DSL:
  those are legitimately first-class ops capabilities, not endpoints pretending to be queries.

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
- **The Postgres driver needs TCP_NODELAY or every parameterized query costs ~40ms.** deno-postgres
  (0.19.x) does not set `TCP_NODELAY`, so its extended-protocol (parameterized) queries send several
  small packets and hit Nagle + delayed-ACK, measured at **42ms per query vs 0.18ms** with NODELAY, a
  230× hit that made pg-backed chat feel broken (a put+take+ack cycle went 602ms → 10ms). Simple
  (unparameterized) queries don't show it, so it hides in microbenchmarks. The driver connects via
  `Deno.connect` and exposes no socket option, so `src/storage/postgres.ts` enables NODELAY by
  wrapping `Deno.connect` once (only raw TCP connects are affected; `fetch`/`Deno.serve` use a
  different path). Remove the wrapper if deno-postgres starts setting it. Not docker-specific;
  reproduced identically via the published port and the container IP.
- **Any uncaught handler error must return problem+json, never a plain-text 500.** The SDK does
  `JSON.parse(body)`, so a bare `Deno.serve` 500 ("Internal Server Error") surfaces as a cryptic
  `Unexpected token 'I'` that hides the real fault. `makeHandler` wraps the dispatch in a
  catch-all (`src/server/http.ts`): a `RadiaError` maps by `statusFor`, anything else is a logged
  500 problem, so clients always get parseable JSON.
- **At-least-once means external side effects can duplicate.** The space protects its own
  state atomically, not your emails. Side-effecting agents need idempotency at the effect
  boundary, an outbox, or the (candidate) transactional tool gateway. This is the
  contract, not a bug.
- **Physical execution overlaps lease expiry.** A fenced worker keeps running until it
  observes `lease_lost`. "At most one valid lease" is not "at most one running process".
- **`take(record_id=...)` is a selector, not a bypass.** The server re-verifies pattern,
  grants, admission, availability, and `claim_until` every time.
- **Encrypted content is coordination-invisible by construction.** Client-side-encrypted
  bodies are unmatchable, untaint-trackable, and invisible to diagnostics. E2E-from-the-
  runtime while plaintext is exposed to the LLM provider is rarely a coherent threat
  model. See [design-observability.md](design-observability.md) confidentiality layers.
- **Timing fields are never overloaded.** Reusing `deadline_at` as `available_at` (or any
  such shortcut) breaks retention-vs-lease separation. Keep the five distinct.
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
- **In a content-addressed store, a partial write is permanent, not transient.** Ordinary storage
  self-corrects because something writes that address again. Content addressing removes that: the
  only party who would ever write those bytes is a caller holding exactly them, and dedup-on-
  existence is precisely the rule that tells that caller to skip. So a truncated blob survived every
  attempt to repair it. Two rules follow, and both are needed: write atomically (temp plus rename,
  `FileBlobStore.writeAtomic`) so damage cannot be created, and VALIDATE before deduping (compare
  length, not existence) so damage that exists can still be repaired. "The file is there" is not
  "the bytes are there". Closed in package G.
- **Re-derive a narrowed scope from the ORIGINAL request, never from the narrowed result.**
  Scope is `grant ∧ request`. Recombining the already-combined match with a fresh grant ratchets:
  each check ANDs another constraint on, so the scope only ever shrinks and a re-widened grant never
  takes effect. `Watch.request` keeps the client's pattern for this reason. The bug is invisible
  while grants only get revoked, and appears the first time one is restored.

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
- **Artifact keys derived from the caller's token.** Rejected. The runtime stores only
  `sha256(token)` (`core/auth.ts`) precisely so a leaked DB yields no usable credential, so it
  cannot re-derive such a key without keeping the token at rest, trading the strongest part of
  the auth model for the weakest kind of encryption. Three more, any one fatal: run tokens expire
  while records are permanent (the blob would die with the run); an artifact exists to be consumed
  by a *different* principal, so a producer-keyed blob needs per-recipient rewrapping, which is the
  federation-gated recipient-keyed scheme; and since the runtime must decrypt for any grant-holder,
  the key must live where the runtime reaches it anyway, which is exactly what a space KEK gives,
  without the other three problems. A token authorizes the *ask* (that is what download capabilities
  are); it is not key material. The planned scheme is per-artifact random DEK + AES-GCM, DEK wrapped
  by a space KEK from env/keyring, behind the `BlobStore` port. Token-keyed encryption only makes
  sense client-side (confidentiality layer 3), where it is incompatible with the point of the
  feature: an image the runtime cannot read is one it cannot validate, taint, or route.
- **Embedded mode as a weaker cousin.** Rejected: the conformance + fault suite runs on
  every adapter in CI from day one, or the backends drift.
- **Escalation-only tier routing, with no classifier (chat example).** Tried, then reverted on
  evidence. This is the interesting one, because the argument for it was sound and the assumption
  under it was false. The router's pre-classifier (a cheap `llm_call` served by the fleet, answering
  with a tier word) was removed in favour of: dispatch every turn to the cheapest advertised tier
  and let a worker `escalate` when it finds itself out of depth. Rationale: a classifier taxes
  every turn, in front of the first token, to answer a question that is only in doubt on a
  minority of them, while escalation pays only on the turns actually misrouted. Cost belongs where
  the uncertainty is.
  **What happened:** across a tool-heavy analytical session every turn routed to the cheap tier
  and *nothing* escalated: the model answered an aggregation question from invented numbers
  instead. Escalation depends on the cheap model recognizing its own inadequacy, which is the
  weakest available judge; a model confident enough to confabulate is exactly the one that will
  not reach for `escalate`. Restored, with the judgment made by a different model than the one
  being judged. Escalation is kept as the catch for under-routing: two mechanisms for one decision
  is deliberate here.
  **Keep from the removal:** no tier name appears in `router.ts` any more. Live tiers come from
  `model` records by `rank`, the classifier answers with one of those words, and the fallback
  heuristic picks by *position* in that list, not by name. The original fallback hardcoded
  `"fast"|"balanced"|"deep"` in the file whose thesis is that tiers are discovered.
  **Related limit, now partly closed.** A `model` record advertises a TIER, not a live worker.
  Two of the three problems are fixed (`examples/chat/space/model.ts`): the publish reads before
  writing, so restarting the fleet does not append a record per worker per launch, the same
  unbounded growth `publishCapability` was fixed for; and a worker
  retires its advertisement on SIGINT/SIGTERM (`onStop`), so a stopped tier leaves rotation instead
  of remaining an offer nobody serves. What is NOT fixed: a worker that crashes or is `kill -9`ed
  leaves its advertisement behind, and the router will dispatch into silence: the call sits
  `available` and the chat reports a stall rather than failing over. Closing that needs liveness the
  substrate does not have: a heartbeat record reintroduces exactly the growth above, and
  advertisements that expire need the retention GC that is still M2. Do not "fix" it with a periodic
  re-publish.
  **The retire/republish trap, which bit immediately and is general to content-keyed registries.**
  Withdrawing an entry and later re-publishing it looks symmetric and is not: the republish reuses
  the publish key, an idempotency key is scoped `(principal, operation, key)`, and within one
  principal that write is a REPLAY of the record being revived, so nothing is written, the
  retirement stays newest, and the entry is withdrawn permanently. It happens to work across a real
  restart, because the worker's principal is a fresh `run:<ulid>` each launch, which is precisely
  what makes it a trap: correctness would depend on who is calling. A revival must therefore key on
  the retirement it supersedes (`…:after:<retirement id>`). Caught by `smoke-fleet.ts` on the first
  run; it would not have been caught by any test that used a fresh principal per step.

- **The matching construct is a `pattern`, and never a `selector`.** It was called a `template`
  until the whole surface was renamed (wire contract, code, both SDKs, CLI, MCP tool definitions,
  docs; the inner field stayed `match`). The reason: to most engineers a template is a GENERATOR,
  something filled in to produce instances, and Radia's is the opposite, a recognizer. The
  misreading had somewhere to land because `kind_def` genuinely is blueprint-shaped. The word had
  also drifted from what justified it: once `$in`, `$gt` and `$or` existed it was no longer a
  partial instance but a small query expression.
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
