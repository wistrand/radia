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

> Most of the entries below are instances of ONE mistake: a registry's writes are unbounded, its
> reads were bounded, and nothing connected the two. They are kept individually because each cost
> real debugging, but the fix is structural and lives in `src/core/registry.ts` (`readRegistry`,
> which pages to exhaustion and admits when it cannot) plus content-keyed registry writes. New code
> should not be able to re-enter this class: if you are writing `query(kind, N)` and treating the
> result as "all of them", use `readRegistry` instead.


- **"Public route" means no credential is REQUIRED, not that a bad one is ignored.** `GET /` and
  `GET /v0/health` skip authentication so the console can bootstrap in `--auth required` mode. The
  skip covered every credential error, so a request presenting an expired, stopped, or garbage
  bearer token got `200 {principal: "anonymous"}` from health — the one endpoint a client calls to
  ask whether its token still works. Not a privilege escalation (the caller is anonymous, not the
  operator), but it makes a dead credential indistinguishable from an open space. Only
  `auth_required` — the error meaning nothing was presented — is exempt now; every other resolution
  failure is a 401 on public routes too. Note a malformed `Authorization` header that is not a
  Bearer at all still reads as "no credential" in open mode, because header normalization has
  already eaten it by the time the server looks.
- **A cast is still a promise, not a check — `match` was the one that got away.** The boundary
  validation added after the fuzzing covered `parentIds`, `deadlineAt`, `orderBy` and the rest, but
  `template.match` was cast (`j.match as Record<string, unknown>`) all the way into the compiler.
  `Object.keys(3)` is empty, so `match: 3` compiled to NO PREDICATE and the query returned every
  record of the kind — a malformed filter that WIDENS, answering a question the caller never asked
  with a plausible-looking result. Validated in `compileTemplate` rather than in the handlers, for
  the same reason `compileOrderBy` is: the SDK, MCP and in-process callers never pass through a
  handler. Found by writing the HTTP boundary tests, not by reading the code — the fuzzing that
  found the original class was a one-off that was never checked in, so every endpoint added since
  had no such check. It is a table in `conformance/http.test.ts` now.
- **A wrong-typed field that changes WHICH records are involved is a 400; one that only sizes the
  answer falls back to its default.** `limit: "ten"`, `leaseSeconds: "60"` and `backoffSeconds: []`
  are ignored in favour of the default; `match`, `template`, `orderBy`, `after` and `dir` are
  rejected. The asymmetry is deliberate and easy to "fix" into inconsistency: a bad bound cannot
  answer a different question, and a bad selector can. Pinned in both directions so neither drifts.
- **Cache what cannot change; never cache what can be revoked.** Credentials looked like a registry
  (records projected into a lookup, rebuilt at startup) and were built as one — wrongly, because the
  thing a registry cache trades away is *freshness*, and freshness is the entire content of a
  credential. The bill came due twice, both fail-open and both silent: the startup rebuild read a
  bounded page of an unbounded log, so on a busy space a STOPPED run's token still resolved after a
  restart; and `stopRun` consulted the cache first, so stopping a run the cache had not seen
  returned `applied: false` and did nothing. `Space.resolveToken` now reads the records on every
  authenticated request; `CredentialStore` (`src/core/auth.ts`) keeps only operator tokens and a
  memo of which agent a run instantiates — an immutable fact. A stop is a successor carrying the
  SAME `tokenHash`, so one indexed lookup sees it, and a token minted on one instance authenticates
  on another with no replay. The same test applies to anything else you are tempted to cache: if it
  can be withdrawn, it must be discovered.
- **An ORDER BY can defeat the index that would have served the filter — and a partial index is
  unusable when its predicate column is a bound parameter.** Both bit the credential lookup, and
  both are invisible without `explain query plan`. Newest-first over a selective equality
  (`where kind=? and <expr>=? order by id desc limit 1`) makes SQLite walk the whole kind in id
  order, evaluating the filter per row, because it reasons the limit will be satisfied early — so
  a token whose record is OLD costs a full scan, and an index on the hash alone changes nothing.
  Then the obvious fix, a partial index restricted to the credential kinds, is never chosen either:
  SQLite cannot prove at plan time that a bound `kind` parameter satisfies the index predicate. The
  shape that works puts kind in the index KEY: `(kind, json_extract(body_json,'$.tokenHash'))`, and
  the expression must match what `SqliteJson.at` emits character for character. Measured at 3000
  credential records: 1.23ms → 0.05ms, and flat to 12k instead of growing. Postgres needs none of
  this — the GIN index over `body_jsonb` already serves every path, which is why this is the only
  physical per-path index in the schema.
- **`record_edges` is a DERIVED index; `parent_ids` stays the source of truth.** `childrenOf` was
  a `LIKE` scan over the `parent_ids` JSON text (safe, because ids are ULIDs and carry no `%`/`_`,
  but O(space) to find a handful of children — 87µs at 1k records → 662µs at 20k for the *same
  five children*). It is now an indexed lookup through a `(parent_id, child_id)` table: 31µs →
  32µs, flat. Three things keep the derivation honest, and all three are load-bearing: the edge is
  written **in the same transaction as the record**, so it cannot lag what it indexes; **every**
  insert path writes it — including ack-with-result, which is the path that creates a task's result
  and therefore exactly the edges most worth having (pinned by a conformance case, because a
  reverse index that only `put` maintained would look correct in every hand test); and the schema
  carries a **one-time backfill** from `parent_ids`, guarded by `where not exists (select 1 from
  record_edges)`, so a database written by an older build rebuilds its edges on next startup.
  That backfill is now covered by `conformance/backfill.test.ts`, which empties the table and
  reopens — the earlier claim that conformance "cannot reach it, every harness database is created
  fresh" was true of the harness and false of the problem. Two things the test had to get right, and
  both were wrong first: the database must be PERSISTENT, because `init()` on `:memory:` opens a new
  empty database and the first draft "survived a restart" by finding nothing in it; and
  `SqliteAdapter.init` now closes any existing handle first, since re-initializing otherwise leaked
  the previous connection and silently swapped in that empty database.
- **A graph walk should batch by LEVEL, but the reason it got faster may not be the batching.**
  `getLineage` now fetches a whole depth level with one `getRecords` call instead of one
  `getRecord` per node. Measured head to head at depth 64 in a 20k-record space: 0.224ms vs
  0.651ms. But note *where* that came from — the benchmark's lineage is a plain chain, one node
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
  NODE — its `maxNodes` cap bounds what the picture SHOWS, not what the walk reads, so a single hub
  record could still drag in an arbitrary number of rows to enqueue them. A client-side `.slice()`
  is not a bound: the rows were already fetched by then, which is what the chat's `space_children`
  was doing.
- **The credential index was rebuilt from a bounded page too — and the fix was to delete the index,
  not to widen the page.** `loadCredentials` read the oldest 5000 `agent_definition`/`agent_run`
  records. Both accumulate — one definition per re-definition, one run per mint, and a live run
  re-mints on a timer — so on a busy space the window held only ancient history. Measured on 5202
  run records: after a restart a STOPPED run's token still resolved. Reading newest-first patched
  that instance; the cache itself was the defect, and it is now gone (see "cache what cannot change"
  above). Kept as history because the reasoning that justified the cache — "credentials are a
  registry like kinds" — is exactly the reasoning to distrust next time.
  One consequence had to be handled separately, and it survives the removal. `runsForAgent` read the
  cache to answer "which principals count as me" for a self scope — but that question wants HISTORY,
  not live credentials, so it would have shrunk as the space aged and quietly narrowed "what did I
  create". It is now `Space.runPrincipalsOf`, querying `agent_run` by `agent` (a declared indexed
  path).
- **Every grant read is a bounded page over records that ACCUMULATE, and truncation misauthorizes
  silently.** Re-defining an agent used to append a fresh record per grant on every boot, so a
  long-lived principal crossed the page cap in ordinary use — and `authorize`/`authorizeWatch`/
  `authorScope`/`opsScope` all read a capped page. Measured both directions: at 101 records a
  legitimately granted principal was DENIED, and at 122 a REVOCATION written as the newest record
  was invisible, so the revoked grant kept working. Fail-open on revocation is the one that matters.
  Three parts to the fix, and the first is the only structural one: grant writes are now
  CONTENT-KEYED, so re-defining an agent with unchanged grants writes nothing (this key does dedup
  across restarts, unlike a worker republishing a capability, because agent definitions are an
  operator action and an idempotency key is scoped to the acting principal); reads take the NEWEST
  page; and the bound is generous, because the cost of truncating is silent misauthorization. Note
  what does NOT work: reading newest-first alone. An old-but-live grant then falls off the other end
  — no single page direction is correct over a set larger than the page.
- **A NUL is invisible in source and lethal in Postgres.** `grantKey` joined its parts with `\0`,
  which was fine while it was only an in-memory Map key and became `invalid byte sequence for
  encoding "UTF8": 0x00` the moment that key was used as an idempotency key. Two lessons: build
  composite keys by ENCODING the parts (`JSON.stringify([...])`) rather than joining with a
  separator no value can contain, since the encoded form is both unambiguous and printable; and
  `grep -P "\x00"` will NOT find these — grep suppresses binary matches, so scan with something
  that reads bytes.
- **Scoping by AUTHOR does not mean what "my records" means to a user.** The chat's session writes
  `message`/`llm_call`/`tool_call`; the RESULTS, chunks and artifacts are written by WORKERS under
  their own principals. So `createdBy: self` would show a session its messages and hide its own tool
  output, and the chat would hang waiting for results it could no longer read. Conversation scoping
  covers both but hides the user's OWN earlier threads, which is not what they meant either. What
  works is an application field: the session stamps `owner`, workers copy it onto everything they
  produce for that call, and the grant binds `{owner}` — enforced on writes too, so a session
  cannot stamp another identity. `RADIA_CHAT_SCOPE` picks between that and `{conversationId}`,
  because the right answer depends on the space: identity scoping separates a session from workers
  and operator sessions, but NOT two people sharing one space, since both are `agent:chat-user`.
- **Tightening a grant by adding a TEMPLATE is inert on any space that already had the loose one.**
  Scope and template are part of a grant's identity, so declaring `{message, [put,query],
  template:{conversationId}}` beside an existing `{message, [put,query]}` creates a SECOND grant —
  and grants union, so the narrower one changes nothing. Every test passed, because tests start on a
  fresh space; a live session on a two-day-old space kept reading every conversation after its
  grants were scoped to one. `createAgentDefinition` now retires the untemplated twin of each grant
  it declares — and, since testing that fix exposed the same hole one level up, every live grant on
  the same (principal, kind, operations) whose template DIFFERS. Swapping one template for another
  is not adding a grant: the two union and the wider view wins, so changing a session's scope
  silently widened it instead. Two boundaries worth keeping: `scope` is excluded on purpose, because
  `grantKey` excludes it (a self-scoped grant already replaces its unscoped twin in place) and
  including it made the rule retire the grant it had just written — the two share a key; and it is
  bounded to the exact triple declared, so a grant a human assigned out of band survives restarts. The general shape: when identity includes the thing you are changing, a
  change is an ADD, and the old value stays in force until something withdraws it.
- **A withheld count with no reason sends every agent hunting for a grant that cannot exist.**
  `/v0/ops/events` filters by which principal PERFORMED the operation, so no grant on any record
  kind widens it — but the response only said `withheld: 65923`, which reads as "you are missing a
  grant". Four sessions in a row spent their turns requesting kind grants to close that gap, two of
  them inventing a kind (`space_event`) to request, and none could have succeeded. The response now
  carries `withheldNote` saying the filter is on the actor and that seeing another principal's
  activity needs an operator session. Cheaper to say once than to have every caller learn it by
  exhaustion — and note the failure was not wrong behaviour anywhere, just an unexplained number.
- **An approval prompt whose label does not match what it grants, and whose keys read as "yes".**
  Two failures in one exchange, both from a live session. The narrow option said "only its OWN
  records — reads only" and then granted the request VERBATIM, including `take` — on `llm_call`,
  which would let a chat session claim work the inference fleet is waiting for. Self-scoping is a
  read filter (claiming a record and then rejecting it is not filtering), so the narrow answer now
  grants the reads ONLY, names what it withheld, and the prompt says up front which requested
  operations are not reads. Separately, the keys were `y`/`a`/`n`: `y` reads as plain "yes" and
  meant the NARROW grant, so a person answering "yes" to "shall I look wider?" got the opposite —
  observed twice, each time costing the assistant its following turns. The options are words now
  (`own`/`all`/`no`), nothing means "yes", and an unrecognised answer is re-asked instead of
  silently becoming a refusal, which is what the old code did with "yes".
- **An escalation that costs two turns and two human inputs per grant does not converge.** The loop
  was: assistant hits `forbidden`, calls `request_grant`, the tool returns "asked them, retry
  later", the turn ends; the human approves at the prompt; the human types "retry"; the assistant
  tries again — and every miss (wrong kind, wrong scope) costs another two. Sessions ran out of tool
  rounds mid-loop and gave up. Nothing was broken; it just could not finish. `request_grant` now
  BLOCKS on the decision and the REPL reviews pending requests WHILE the call is in flight
  (`onToolWait` in `turn.ts`), so the person is asked immediately and the answer lands in the same
  turn with rounds left to act on it. Three details that make it work: the decision travels as a
  successor `grant_request` record carrying what was ACTUALLY granted (scope included — the asker
  may have been given something narrower than it asked for, and discovering that by retrying and
  failing is the loop being removed), because the session can read its own requests and holds no
  grant on `grant`; the tool's deadline is a human one (240s) and the REPL's is longer still, or the
  REPL would abandon a decision still being made; and the between-turns review stays as the backstop
  for a request whose turn died. Watch for this shape generally: a protocol whose round trip crosses
  a turn boundary pays for the boundary every iteration.
- **Kind-scoped is not conversation-scoped: every chat session ran as one agent, so each could read
  every other session's messages.** `USER_GRANTS` said `message: {put, query}` with a comment
  promising "may drive a conversation and read its own results, nothing more" — and nothing enforced
  the "its own". A ten-minute session reconstructed two days of unrelated conversations, correctly.
  Six chat kinds index `conversationId`, so the fix is the runtime's own content scoping: the
  session's grants are TEMPLATE-scoped to its conversation, which binds reads and writes alike.
  Consequences worth keeping: the conversation record is created by the OPERATOR before the session
  token is minted (a grant is minted with the token, so the conversation has to exist first), and a
  user session therefore no longer holds `conversation: put` at all. Growth is per distinct
  CONVERSATION, not per session — the template is part of a grant's identity, so resuming re-mints
  the same content key and writes nothing. The result kinds needed the same
  treatment and lacked the field to do it with: `llm_chunk`, `llm_result` and `tool_result` are
  keyed by `callId`, so a session holding a callId from elsewhere could read another conversation's
  streamed tokens, model output and tool results whatever the conversation scoping said. They now
  carry `conversationId`, written by the worker that produces them and indexed so a template can
  bind it. The failure mode of getting THAT wrong is not a leak but a hang — a writer that forgets
  the field produces a result its own session cannot read — so the test pins both directions.
  Artifacts were the last kind and needed a RUNTIME change, because their body is computed from the
  bytes: `Space.putArtifact` now takes application fields to merge alongside it (`x-radia-meta`, an
  ASCII JSON header — a header is a ByteString, so non-ASCII is refused rather than mangled). The
  runtime's own fields are applied last and supplying one is refused outright, so nothing an app
  sends can forge a digest, size or media type. The chat stamps `conversationId` on every artifact
  it writes and REDECLARES the reserved `artifact` kind to index it — legal, since only `kind_def`
  is protected — repeating `digest`/`mediaType` because a redeclaration replaces rather than merges.
  **And the narrowing had to learn about it.** Grant templates UNION, so approving an untemplated
  self-scoped grant beside a templated one replaces "this conversation" with "everything this agent
  ever wrote" — a widening performed by the act of narrowing. The approval flow now inherits the
  template of the grants it replaces. Guarded in `smoke-inspect.ts`, both directions.
- **A self scope must narrow the plane the agent actually READS through, and grants UNION.** Two
  mistakes, one live incident. First, `scope: {createdBy: "self"}` narrowed only the ops plane while
  ordinary `query`/`read_one` returned every record of the kind — so an approval promising "only its
  own records" handed over all of them, and a session reported 98 records from `ops/stats` and 308
  from `space_count` in the same breath. `Space.authorScope` now applies the restriction to the
  coordination plane too (reads only — `take` is excluded, because claiming a record and then
  rejecting it is not a filter). Second, and subtler: grants union, so a narrow grant added BESIDE a
  broad one changes nothing. The chat's session starts with an unscoped `message: query` grant, so
  approving the self-scoped version was powerless until the approval also RETIRED the wider grant.
  The union rule is why `authorScope` only restricts when EVERY applicable grant is self-scoped:
  filtering by author while an unscoped grant applies would deny something that grant permits — and
  "applicable" means PERMITTING THAT OPERATION, since a `put`-only grant says nothing about reads and
  counting it lifted the restriction the moment narrowing reads left the write grant behind.
  Narrowing must also be per-OPERATION. The first version retired the whole overlapping grant, so
  narrowing `query` on `message` took the bootstrap `{put, query}` grant with it and the session
  could no longer write its own messages: the chat died on the next turn with "no 'put' grant for
  kind 'message'". A grant carrying operations that were not being narrowed is now replaced by one
  that keeps them.
- **`listKinds()` does not list every kind.** It reads `kind_def` RECORDS, and six kinds are defined
  in code instead (`kind_def`, `grant`, `signal`, `agent_definition`, `agent_run`, `artifact` —
  `RESERVED_KINDS`). Anything answering "does this kind exist" must add them, or it will report that
  `artifact` is not a kind while the caller is successfully counting artifacts.
- **The ops aggregate is self-scoped even where READS are not, so it must say which kinds it
  under-counts.** A principal can hold an unscoped `{put, query}` grant beside a self-scoped
  `{query}` on the same kind — different operation sets, so different grant identities, so both live
  — and then it can LIST every record while `ops/stats` counts only its own. Observed: 187 messages
  reported as the space's total by a session whose own `space_count` said 578. The self-scoping is
  deliberate and stays; the answer now carries `alsoReadableInFull` and says a query on those kinds
  returns more. Widening the aggregate to match was tried and reverted — it turns every unscoped
  bootstrap grant into full ops visibility, which is the opposite of what the plane is for.
  Guarded by "an aggregate that covers less than the caller can read says so" in `suites/selfscope.ts`.
- **The scoped-answer rule was only ever applied to the OPS plane; the plane records are actually
  read through said nothing.** `/v0/ops/*` has carried a `scope` for a while. `POST
  /v0/records/query` returned `{records, nextAfter}` — so a caller whose grant limits `message` to
  one conversation queried `message`, got its own conversation, and had no way to distinguish that
  from "this is every message there is". Four sessions in a row reported their own slice as the
  space's history, and each then went hunting for a grant to close a gap they could not see. The
  response now carries `scope: {narrowedBy, ownRecordsOnly, note}` when — and only when — a grant
  narrowed the read, so an unrestricted read is byte-identical to before (additive to the frozen
  contract). `read_one` is deliberately left alone: it returns the record itself, and a null answer
  to "give me this one thing" does not invite the same mistake. General form: the thing that makes a
  narrowed answer dangerous is that it is SHAPED exactly like a complete one.
- **A scoped answer must SAY it is scoped, or an empty one reads as an empty space.** A session
  granted ops access on one kind read `stats: []`, `events: []` and an all-zero diagnostics, and
  told its user "the space is empty and healthy". Every number was correct; the claim was wrong, and
  nothing in the response contradicted it. Scoped responses now carry
  `scope: {self, kinds, note}` (`describeScope` in `handlers/ops.ts`), and the chat's tools pass it
  through rather than projecting it away — which they were doing, so even a fixed server would not
  have reached the model. The general form: a narrowed result is only safe to publish alongside a
  statement of the narrowing, because the consumer cannot infer it from the data and an aggregate
  gives it no other clue.
- **A grant on a kind that does not exist authorizes nothing, and everything downstream reads it as
  access.** An agent that cannot list kinds guesses one, and a plausible guess is a TOOL name: a
  session asked for `space_event` (there is a `space_events` tool; there is no such kind), a human
  approved it past the prompt's warning, and from then on the phantom kind appeared in every
  `scope.kinds` line the ops plane returned — so the agent had documentary evidence of access it
  did not have. The grant is still honoured as written, because a grant may legitimately precede its
  kind (an operator bootstraps an agent before the fleet declares anything), but
  `effectivePermissions` now marks the row `kindNotDeclared: true`. That is the one answer an agent
  is told to trust about its own authority, so it is where the discrepancy has to surface.
- **A scoped agent must be able to ask what it may do, and the ops plane refused exactly the
  principal that needed to.** `GET /v0/ops/permissions` was operator-only on the reasoning that
  reading a principal's authorization is an operator question. Reading YOUR OWN is not, and the
  refusal was worse than useless: `opsScope` throws for a principal with no self-scoped grants, so
  the caller with the least authority — the one that has just asked for some — got a 403 from the
  one endpoint that would tell it whether the ask succeeded. Observed end to end: a session was
  granted precisely what it requested, retried a DIFFERENT call that was failing for an unrelated
  reason, saw no change, and told its user the request must still be awaiting approval. It had no
  way to check, so it guessed, and the guess wasted a person's time. The self-read is now checked
  BEFORE the plane's gate (`asksAboutSelf` in `http.ts`, matching the principal or its grant
  subject, since a run token asking about its agent is asking about itself); every other
  principal's authorization stays operator-only. CLAUDE.md already said `effectivePermissions` is
  how you check before believing — an agent could not reach it.
- **Testing the client is not testing the TOOL the model calls.** `smoke-selfgrant.ts` proved the
  scoped-events contract by paging the log itself, and passed. The chat does not call the server;
  it calls `tools/space.ts`, and `space_events` there fetched exactly one page from cursor `0`. On
  a busy space the server's bounded forward scan covers only the first few hundred raw events, all
  of them somebody else's, so the tool returned `{events: [], withheld: 500}` — with the SAME
  cursor on every retry — while the session's own activity sat at the far end of an 11,588-event
  log. Every layer underneath was correct. The tool now pages to the end (large raw pages, keeping
  the newest `limit`) and reports `complete` so "the end of the log" is distinguishable from "I ran
  out of budget". General rule: a wrapper that adds a bound is a place a bug can hide from every
  test of the thing it wraps — `smoke-inspect.ts` drives the tools for this reason.
- **An escalation protocol that cannot express WHOSE records are needed will keep producing grants
  that authorize nothing.** `request_grant` carried kind and operations, and the approval prompt
  offered "own records only" (recommended) or "all". An assistant that needed to read a registry
  written by others had no field to say so — it said it in prose instead ("both need to be
  un-scoped"), the human answered the narrower prompt, and the two halves of the exchange were
  talking about different things. Observed three times in one session: request, approve, "the grant
  landed", every read still empty. The request now carries `scope: "own" | "all"` — a REQUEST, not a
  decision, still assigned by the operator to the subject this process controls — and the prompt
  relays it. Two supporting details, both load-bearing: `scope` is part of the request's identity
  key, or re-asking un-scoped after a scoped grant disappointed dedups into the handled request and
  vanishes; and choosing the narrow option against a measured-empty exposure now PRINTS that the
  grant authorizes nothing, because the human's answer being allowed is not the same as it looking
  like it worked. The whole loop — warning, recommendation flip, the note, the empty reads that
  follow, and the wider approval actually answering the question — is pinned in `smoke-inspect.ts`.
- **Self-scoping a REGISTRY kind grants a view of nothing, not a narrowed one.** `scope:
  {createdBy: "self"}` is the right default for a kind the principal WRITES (its messages, its
  llm_calls) and useless for one it only reads: `kind_def`, `capability`, `model` and `procedure`
  records are written by whoever declares them, so a session self-scoped on `kind_def` sees zero of
  them and `space_kinds` answers `[]` on a space with twelve. Nothing is broken, and that is what
  makes it expensive — the session was told the grant existed, saw an empty list, and concluded the
  approval had not gone through. The approval prompt (`client/grants.ts`) now MEASURES the exposure
  before offering the choice — how many of a sampled page of that kind the principal actually
  authored — and recommends against self-scope when the answer is none. Measured, not a hardcoded
  list of registry-ish kind names, which would be wrong the moment an app adds one.
- **Filtering a cursor-paged endpoint breaks paging unless the cursor is reported separately.** The
  self-scoped `/v0/ops/events` withholds events the caller may not see — and an empty page is how
  every caller detects the end of a log, so a page whose events were all withheld reads as "nothing
  further". A scoped caller could never page PAST a run of foreign events to reach its own: measured
  as 0 visible events on a space whose first 500 were someone else's. Two things were needed, and
  the second is the one that is easy to skip: scan forward across raw pages instead of filtering
  one, and report `nextAfter` from the last RAW event examined (`getEventsPage` in the SDK) so a
  caller can advance past what it cannot see. The same shape applies to any future filtered feed.
- **A bounded page over a registry must be read NEWEST-first, or a busy space hides the newest
  entry.** Discovery reads a capped page (`query {kind: capability}` limit 500), and a limited query
  returns the OLDEST matches — so a space holding more capability records than that cap shows every
  tool EXCEPT the ones published most recently. That is not hypothetical: a live session reported
  "I don't have a request_grant tool" for a tool that was published, granted and working, because
  the chat's discovery page never reached it. Every registry projection over a capped page now
  passes `{dir: "desc"}` (`ToolSet.refresh`, `Space.loadKinds`).
  Two contributing causes worth separating. The page cap is only reached because **capability
  publication was not idempotent across restarts**: the content key makes the put idempotent, but an
  idempotency key is scoped `(principal, operation, key)` and a worker's principal is a fresh
  `run:<ulid>` every launch — so an unchanged definition wrote a NEW record on every start, and a
  long-lived space grew by the whole fleet's tool count per restart (measured: 24 records per chat
  restart, so ~21 restarts to cross 500). `publishCapability` now reads the current advertisement
  first and writes only on a real change. And the chat's startup wait was "until any tool appears",
  which returns as soon as the FIRST worker publishes — fine on an empty space, meaningless on one
  where records already exist.
- **A registry is a projection, and `retired: true` is how you withdraw from one.** Declared kinds,
  assigned grants, advertised capabilities, live models and saved procedures are all mutable-looking
  tables derived from an append-only record stream, so "remove" cannot be a delete. It is a
  successor carrying `retired: true`, honoured in ONE place (`src/core/registry.ts`) rather than by
  each consumer. Two shapes, and picking the wrong one is a correctness bug: **latest-wins**
  (`activeByKey` — kind_def by kind, capability by tool, model by tier, procedure by name) where a
  re-declaration replaces, and **additive** (`activeSet` — grants) where entries coexist and each is
  independently withdrawable. Revoking a grant keyed on `(principal, kind)` would silently take
  every other grant that principal holds on that kind with it, which is why `grantKey` is the whole
  content — operations and template included. Two rules that are easy to get wrong: retirement must
  be applied AFTER the newest-per-key pass, never as a filter over the input (filter first and an
  older non-retired record becomes "newest" and resurrects the entry); and the projection must
  compare ids rather than trust arrival order, for the same reason. Nothing is deleted, so the audit
  trail survives a revocation, and re-declaring a retired key revives it because that record is
  newer still — there is no un-retire path to implement.
- **Record ids are MONOTONIC ULIDs, and latest-wins depends on it.** A plain `ulid()` encodes the
  millisecond and randomizes the rest, so two ids minted in the same millisecond sort arbitrarily.
  Every latest-wins registry asks "which record is newer" by comparing ids — and declaring
  something then retiring it is exactly a same-millisecond pair, so with plain ULIDs a retirement
  could be outranked by the record it retired. This was latent in `loadKinds` and the capability
  projection long before retirement existed; it surfaced as a conformance test that passed alone
  and failed in a full run, which is the signature of same-millisecond id collisions. `newUlid()`
  now uses `monotonicUlid()`. The honest limit: monotonicity is PER PROCESS, so several runtime
  instances on one Postgres are still only millisecond-accurate relative to each other — do not
  race a retirement and its revival from two instances.
- **Predicate pushdown is a SOUND pre-filter, never a second opinion.** `src/storage/pushdown.ts`
  renders part of a compiled template into SQL, but the oracle in `core/matching.ts` still decides
  every match. The asymmetry is the whole safety argument: over-returning is free (the oracle
  rejects the extras), under-returning is a silent lost record — and for `take`, an empty space
  reported while work sits in it. So anything not expressible EXACTLY renders as `TRUE`: object
  and array equality (the oracle compares serialized text, so key order matters; jsonb normalizes
  it), `$any`/`$each`, a range against a non-ASCII bound, and any path segment outside
  `[A-Za-z0-9_]` (segments are inlined into a JSON path literal so the planner can match an index,
  and restricting the alphabet is what makes inlining injection-proof). Three traps that are not
  obvious until they bite: rendering a node BINDS PARAMETERS as a side effect, so a caller that
  discards the SQL must roll the parameters back too (`mark`/`rollback`) — an `$or` that discards
  one branch used to leave orphan bindings and fail the statement; `json_extract` returns SQL NULL
  for *both* an absent key and a JSON `null`, so presence is always asked via `json_type`; and an
  unguarded jsonb `>` will happily compare a string to a number, because jsonb has a total order
  across types. Every comparison is therefore type-guarded first.
- **The claim index must be ordered like the claim, and `state` must not lead it.** The candidate
  window sorts by `effective_priority desc, available_at asc, record_id asc`; an index only serves
  that if its columns are in that order. `idx_runtime_claim` is not (it leads with `available_at`)
  and is also partial on `state = 'available'` while the window needs `'leased'` too, for expired-
  lease reclaim — so it never applied. The subtle part is the fix that does NOT work: an index
  leading `(kind, state, …)` satisfies `state in ('available','leased')` but sorts only WITHIN each
  state value, so the database still sorts the whole set. Measured, that version changed a claim by
  1.4ms — indistinguishable from noise, which is why the first attempt looked like "the sort was
  never the problem". `idx_runtime_claim_order`, with the sort columns immediately after `kind` and
  no `state`, took a claim at 40k records from **19.5ms to 0.8ms** on SQLite by turning a full scan
  of the envelope table into an ordered seek that stops when the window is full.
- **A claim on Postgres is planned on a guess, and the guess is wrong by 200×.** The estimate that
  fixes it has two halves. The same query SQLite answers with an ordered seek, Postgres answered
  by collecting EVERY matching record through the body index (5,715 of 40,000), joining each to its
  envelope, and sorting — because it estimates the jsonb predicate at 26 rows and concludes the sort
  is free. Not fixable by rewriting the query: `join` vs `exists`, with and without the `@>` term,
  all plan the same way, and forcing the planner with `enable_seqscan`/`enable_bitmapscan` off makes
  it *worse* (28.6ms) because it picks a different wrong plan. The fix is a real ESTIMATE:
  `PgSqlAdapter.prepareKind` creates `create statistics … on ((body_jsonb #> '{path}')) from
  records` for each declared indexed path, via the optional `StorageAdapter.prepareKind` hook that
  `Space` calls when a kind is declared or loaded. Statistics cost ANALYZE time, not write time.
  Measured end to end on a real `take` over 20k records: **9.75ms → 3.37ms p50**, with the plan
  changing from sorting 9,168 buffers to an ordered walk of `idx_runtime_claim_order` over 1,364.
  Three things are easy to get wrong, and the first two cost an afternoon each:
  * **ANALYZE `record_runtime`, not just `records`.** A claim JOINS the two, and with no statistics
    on the envelope table the join estimate collapses however good the body estimate is. The
    isolated window query measured 48ms with neither analyzed, 11ms with the envelope table
    analyzed, 1.0ms with the expression statistics on top.
  * **The two pushed terms are redundant AND correlated, and the planner multiplies them.**
    Pushdown emits `body_jsonb @> '{...}'` (what the GIN index answers) AND `body_jsonb #> '{path}'
    = '...'` (what makes the filter exact). Measured selectivity for a value matching 2,858 of
    20,000 rows: `@>` alone estimates 2,858 — exactly right; `#>` alone estimates 100 without
    statistics and 2,858 with them; the two ANDed estimate **14 without and 408 with**, because the
    planner assumes independence. So the statistics help, but the residual 7× underestimate is
    structural, and dropping either term is not an option (one is the index, the other is the
    exactness that lets a LIMIT be pushed).
  * **The statistics expression must match `PgJson.at` character for character**, and the path is
    inlined into DDL — so `prepareKind` skips any path outside `[A-Za-z0-9_]` rather than escaping
    it, the same rule pushdown uses for the same reason.
  A fresh space declares its kinds before it has rows, so the ANALYZE at declaration time measures
  an empty table; the estimate becomes real at the next autoanalyze. Nothing is wrong when a brand
  new space plans a claim badly for a while.
  Also worth knowing before optimizing a claim: an unfiltered first window (try the head of the
  queue cheaply, fall back to the filtered query) was built and **reverted** — no measurement
  supported it. It only wins when the head happens to hold a match, and in a queue where workers
  have consumed the nearby matches it just adds a round trip: every measured cell got worse
  (sqlite 1.0 → 1.3ms, Postgres 22.7 → 28.6ms).
- **A LIMIT may only be pushed under an EXACT filter, not merely a sound one.** `Pushed.exact`
  distinguishes them, and it is the difference between an optimization and a correctness bug: with
  an inexact filter SQL returns its first N rows, the oracle rejects some, and the matching rows
  further down were never fetched — the caller silently gets fewer records than exist. `readOne`
  and `query` push the limit only when the filter is exact AND there is no `orderBy` (with no
  `orderBy` the oracle's order is its `x.id < y.id` tie-break, which `order by id` reproduces).
  Pinned by "a limit is never pushed under a filter the database cannot decide" in
  `conformance/suites/pushdown.ts`.
- **Postgres orders text by the database's collation; the oracle orders by JS string comparison.**
  Those disagree under a linguistic collation, so the pushed limit sorts `id collate "C"` (byte
  order, what JS means) against a dedicated `idx_records_id_c`. Keep it — but keep the severity
  straight too, because this entry used to claim `read_one` "could return a different record on
  Postgres than on SQLite", and for the ids the runtime actually mints it cannot. Checked directly
  (`sort` under both locales): `C` and `en_US.UTF-8` order Crockford base32 — digits and uppercase
  letters, which is all a ULID contains — IDENTICALLY. They diverge on punctuation and case, which
  is precisely what a ULID has none of. So the collation is a guard against ids ever ceasing to be
  ULIDs, not a live divergence, and no test can currently be written that fails without it. Related
  and also worth stating plainly: `scripts/pg-conformance.sh` pins no locale, so the old claim that
  "the conformance Docker image runs in C locale" was never verified by anything either.
- **`indexedPaths` are a validation contract, not per-path physical indexes.** One GIN index (`jsonb_path_ops` over the generated `body_jsonb` column) answers
  pushed equality on every path, so declaring a path costs no DDL and no migration, which is what
  keeps kinds-as-records from dragging a schema change behind it. Measured on 40k records: a
  genuinely selective `read_one` is **7.98ms without the index, 1.42ms with it**, for about 5% on
  `put`. Do not confuse that with the *headline* pushdown win — against an unselective predicate
  (the benchmark's 1-in-7 "rare") GIN is not used at all, and the speedup comes entirely from the
  pushed LIMIT letting the scan stop at the first match.

- **A claim must not lock, or even read, what it does not claim.** `take` originally selected
  *every* available-or-leased record of the kind `for update ... skip locked`, then filtered in
  the runtime. Two distinct bugs, one line. (1) **Starvation:** on a real Postgres, one claimer's
  open transaction held row locks on the entire queue, so a peer's `skip locked` found nothing
  and was told *empty* while work remained — 67 wasted takes at 4 claimers, 166 at 16. sqlite and
  PGlite hid it completely, being single-connection: the fault was invisible to `deno task
  conformance` and only appeared against a live server. (2) **Cost:** ordering the *join*
  materialized every record body of the kind before `limit` applied, making a claim O(kind size)
  in bytes, not rows. The fix is in `pgbase.ts`/`sqlite.ts` `fetchCandidates`/`take`: a bounded
  `CANDIDATE_WINDOW` (64) chosen from the narrow `record_runtime` table first, bodies fetched only
  for that window, no row locks, and single-winner resting on a **checked** compare-and-set
  (`affectedRows === 0` → try the next candidate) instead of on holding locks. Two consequences
  worth keeping straight: bounding the window is only safe because the SQL `order by` is the same
  key `rankClaimable` sorts by (`effective_priority desc, available_at asc, id asc`) — change one
  and you must change the other, or a claim silently prefers the wrong record; and a *selective*
  template pages to the next window rather than truncating, so a rare match deep in a large kind
  is still found. `take` at 40k went 183ms → 18.4ms, and empty takes 67/166 → 2/4 (the genuine
  tail as the queue drains). Pinned by `claimFairnessSuites` in `conformance/suites/leases.ts` —
  which fails on Postgres without the fix, so run `scripts/pg-conformance.sh`, not just the
  embedded suite, before trusting a change to the claim path.
  A loose end noted while fixing it was later RESOLVED THE OTHER WAY, and the sequence is worth
  keeping because the first measurement was misleading. `idx_runtime_claim` is
  `(kind, available_at, effective_priority desc, record_id) where state = 'available'` — the wrong
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
  scheduler lands (M3), which is why the two orderings are indistinguishable today — the mismatch
  becomes real the day priorities differ.
- **An idempotency key travels as an HTTP header (a ByteString) — hash content into it, never
  embed it.** `Idempotency-Key` (and any header) must be Latin1; a key built from free-form content
  can carry Unicode (a tool description with `…`/`→`, a body with an em-dash) and `fetch` throws
  `Failed to construct 'Request': 'headers' … not a valid ByteString`. Content-keying a record (so a
  changed def is a successor, not a 409) is right, but the key must be a **hash** of the content, not
  the content itself. `kindDefKey`/`grant` keys are ASCII by construction (paths, types, principals);
  the capability publish content-hashes the tool def (`examples/chat/space/capability.ts`). Bit both the 409 fix and then
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

- **`take` also ranks EXPIRED-lease records as candidates, so repeated template takes re-claim the
  same record.** Bit two test setups in a row: seven puts followed by seven `take({template})` with
  a lapsed lease leaves ONE stranded record (each take reclaims the previous one, bumping its
  attempt) and six still available — not seven stuck leases. To strand N records, take them BY ID.
  This is correct behaviour (reclaiming lapsed work is what take is for), but it makes "claim
  several, let them expire" a trap when building fixtures.

- **A cast is a promise to the type checker, not a check.** Handlers used to build a `PutRequest`
  by casting wire JSON (`j.parentIds as string[]`), so `parentIds: 42`, `deadlineAt: {}`, an
  `orderBy` string, a `template: []`, or a JSON `null` body sailed past the boundary and failed
  deep inside matching or the adapter — a malformed request answered with a 500 instead of a 400.
  Found by fuzzing every field of every endpoint with wrong types; fixed by validating shapes at
  the boundary (`pickPut`/`pickResult` in `handlers/records.ts`, template and numeric query-param
  checks in `handlers/leases.ts` and `handlers/ops.ts`) and, for `order_by`, in `compileOrderBy`
  itself so in-process callers are covered too. Keep the rule: if it came off the wire, check it.

- **Writing a payload and its key is two operations, so order them for the crash.** The encrypted
  blob store wrote ciphertext first and the wrapped DEK second. A crash between them left
  ciphertext with no sidecar, which the reader treated as a *plaintext* blob — so raw ciphertext
  was served as the artifact, and a re-upload never healed it because the content-address guard saw
  the file and skipped. Now: key first, payload second (an interrupted write is an honest miss);
  the "already stored" guard requires BOTH parts; and a blob at the ENCRYPTED name with no sidecar
  is damage, never legacy plaintext. Only the plaintext-digest name may be read as plaintext.

- **`esc()` must escape quotes, because record data reaches HTML attributes.** The console escaped
  `& < >` only. A grant's `template` is rendered as JSON inside `title="…"` — and JSON always
  contains `"` — so every template-scoped grant broke out of the attribute, and a crafted template
  or kind name (validated only as "a non-empty string") could inject an event handler into the
  page that carries an operator token. Escaping now covers `"` and `'`; the fix belongs in `esc`
  rather than at each call site, since new call sites keep appearing.
  The follow-up is the part that generalizes: `esc` being correct was never the problem, ONE call
  site interpolating raw was. `conformance/console.test.ts` now checks the property structurally —
  every `${…}` inside an HTML attribute in the page must route through `esc` or be a ternary whose
  branches are string literals — and it immediately found two more (`note`'s CSS class and
  `stateBadge`'s state, both server-supplied). The console is one file with no build step, so the
  test lifts `esc` out of the page source by brace balance rather than the page being split into
  modules; the extraction fails loudly if the function is renamed, which is what keeps the test
  from quietly testing nothing.

- **A selector on `state: available` must exclude reference kinds.** `claimable:false` records —
  the `kind_def` registry, `grant`s, `agent_run`s, plain facts — sit available forever by design.
  The first version of selector-driven remediation did not filter them, so
  `dead-letter --all --stale 0` swept the kind registry and the grants into `dead_letter`: the
  space's own control records, remediated as if they were stuck work. Caught by running the CLI
  verb against a real space, not by reading it. The starvation check had excluded them all along
  for the same reason; in remediation it is a guard, not a heuristic. `dead_letter` stays
  unfiltered so a reference record that lands there is still requeueable.

- **There is no `expired` record STATE, and the union no longer pretends otherwise.** A lapsed
  lease leaves the record `leased`; a later take reclaims it. `RecordState` used to carry an
  `expired` member nothing ever wrote, and `GET /v0/ops/records?state=expired` accepted it and
  answered zero rows — a confident nothing beside hundreds of demonstrably lapsed leases, which is
  exactly how a reader (or a model) concludes the report is broken. The member is gone from the
  union and from both OpenAPI enums, and the endpoint now answers `400` naming the query that does
  work: expiry is a PREDICATE over leased records (`state=leased&expired=1`). Diagnostics reports
  the real number as `stuckLeases`, which carries `atLeast` when its scan hit the sample cap,
  because a bounded scan must not present itself as a census. Note `take.ts` has its own
  `how: "available" | "expired"` — a different thing that happens to share the word, describing how
  a candidate was reached rather than what state it is in.

- **Client-supplied headers must win over the SDK's own credential.** The Python `_req` set
  `Authorization` from the client's token *after* merging caller headers, silently clobbering
  them. It surfaced only when `create_run` landed — the one call that authenticates with a
  DIFFERENT credential (the agent-definition token, not the client's run token). The TS client
  spreads caller headers last, so it was always correct; the two now agree. Any future
  "authenticate this one call differently" API depends on that precedence.

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

- **A process that executes model-written code must hold nothing; the process that holds a token
  must not execute.** Executing inside a worker that has a run token hands hostile code the space
  itself — `put`/`take` as that agent — which is a better target than the internet. Hence three
  processes in the chat example: `workers/exec.ts` (token, space access, `--allow-run`) spawns
  `deno run -` with NO permissions and talks to it over pipes only. Two consequences to preserve:
  the sandbox never gets a credential "so code can query" (the worker fetches and pipes data in
  instead — the confused-deputy rule again), and its emptiness is what makes lease RETRY sound,
  since a permissionless child has no side effect to double.

- **Read access for executed code is granted separately from the file tools' roots.** Both bound
  "which files", but the exposure differs: a tool returns one file per call, visibly, while a
  program can walk a whole tree and fold it into one line of output. So `RADIA_CHAT_EXEC_DIRS` is
  its own setting rather than reusing `RADIA_CHAT_DIRS` — widening the tools must not silently
  widen the sandbox. Two properties to keep if this is touched: roots are realpath'd before being
  granted (a symlink must not smuggle the grant elsewhere), and the blob KEK plus the operator
  credential are passed as `--deny-read`, which beats `--allow-read` in Deno, so pointing a root at
  a directory containing them still does not expose them. Write, net, env and run stay denied
  whatever is configured.

- **Deno's `--max-old-space-size` does not bound TypedArrays.** Measured: an object-allocation loop
  dies in ~0.3s ("Reached heap limit", exit 133), while `while(true) a.push(new Uint8Array(1e7))`
  runs until the kill timer, because the backing store is external to V8's old space. So the
  execution *timeout* is the real memory bound, not the flag — keep it short, and reach for
  `ulimit -v` or a container if that is not good enough.

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
  resolves to the privileged `human:local`, never expires, and is NOT persisted (like the in-code
  meta-kinds). It is the one credential that legitimately lives in memory — it cannot be revoked
  because it cannot outlive the process. The server bakes the plaintext into the
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
- **Only token HASHES are stored, and the records are the authority on every request.**
  Run/definition tokens are secrets returned once at mint; the `agent_definition`/`agent_run` record
  bodies hold the sha256 hash (not a secret). `Space.resolveToken` reads the newest record for that
  hash per authenticated request — there is no credential cache to miss, go stale, or replay at
  startup. A run's status change (stop) is a **successor** `agent_run` record (records are
  immutable) carrying the SAME `tokenHash`, so the one indexed lookup that finds the mint finds the
  stop instead. The lookup path is guarded by a token-shape regex so garbage tokens don't reach the
  query at all. Token expiry
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
  **Related limit, now partly closed.** A `model` record advertises a TIER, not a live worker.
  Two of the three problems are fixed (`examples/chat/space/model.ts`): the publish reads before
  writing, so restarting the fleet does not append a record per worker per launch — the same
  unbounded growth `publishCapability` was fixed for; and a worker
  retires its advertisement on SIGINT/SIGTERM (`onStop`), so a stopped tier leaves rotation instead
  of remaining an offer nobody serves. What is NOT fixed: a worker that crashes or is `kill -9`ed
  leaves its advertisement behind, and the router will dispatch into silence — the call sits
  `available` and the chat reports a stall rather than failing over. Closing that needs liveness the
  substrate does not have: a heartbeat record reintroduces exactly the growth above, and
  advertisements that expire need the retention GC that is still M2. Do not "fix" it with a periodic
  re-publish.
  **The retire/republish trap, which bit immediately and is general to content-keyed registries.**
  Withdrawing an entry and later re-publishing it looks symmetric and is not: the republish reuses
  the publish key, an idempotency key is scoped `(principal, operation, key)`, and within one
  principal that write is a REPLAY of the record being revived — so nothing is written, the
  retirement stays newest, and the entry is withdrawn permanently. It happens to work across a real
  restart, because the worker's principal is a fresh `run:<ulid>` each launch, which is precisely
  what makes it a trap: correctness would depend on who is calling. A revival must therefore key on
  the retirement it supersedes (`…:after:<retirement id>`). Caught by `smoke-fleet.ts` on the first
  run; it would not have been caught by any test that used a fresh principal per step.

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
