# Plan: ending the bounded-read disease

**Status: ALL EIGHT STEPS BUILT 2026-08-25.** Rewritten 2026-08-24 after counting the actual
incidents: the first draft led with direction work, the census says that is the wrong order, and the
reason is recorded in Finding 1 rather than quietly fixed.

Sibling: [plan-registry-cost.md](plan-registry-cost.md), which covers what a registry read COSTS and
whose items 1 and 3 shipped 2026-08-22/23.

**AUDITING THE WORK FOUND MORE DEFECTS THAN THE WORK FIXED**, and the ones that mattered most were
not in this plan's subject at all. Three were introduced by steps 4 and 8 and are recorded under
those steps. Five were pre-existing and share one shape, which the plan had not named: a field the
code picks BY NAME is silently dropped when misspelled, and wherever that field NARROWS, dropping it
WIDENS. Two of those are security-relevant (a fail-open taint barrier, an unscoped grant). See
"The sibling disease" below, and [gotchas.md](gotchas.md).

## The census

Eighteen distinct incidents across the project's life, in the runtime, both SDKs, the CLI, the
console and three examples. At least three security-relevant. Sources: [gotchas.md](gotchas.md),
[plan-audit-remediation.md](plan-audit-remediation.md), and two found while writing this.

**Partial read of a population (11).** Tool list read an ascending page of 500 and a live session
reported "I don't have a request_grant tool" for a tool that was published, granted and working.
Tool list AGAIN after the `dir: "desc"` fix: 737 records for 33 tools, within 1.5x of dropping them
again. Credential index read the oldest 5000, so at 5202 a STOPPED run's token still resolved after
restart. Grant reads capped: at 101 records a granted principal was DENIED, at 122 a REVOCATION was
invisible and the revoked grant kept working. `query_page` dropped `scope`. The SDK's own `grant()`
revival anchor scanned 500. The chat's procedure lookup read the oldest 50 twice over, so 51 saves
resolved to the 50th. `runs --for` reads the oldest 1000, so offboarding reports 0 active and
`--stop` stops nothing. Five `readRegistry` callers page ascending and keep the wrong half. Three
minor: `turn.ts` newest-50 global, `forksOf` 500, `listSandboxes` 200.

**Order confusion (7).** `readOne` answers with the OLDEST match, hit TWICE: the second time a newly
enrolled machine was told it had no key while the record granting it sat one row later. Compaction
paged by ULID against a projection ordering by `created_at`. `radia query` truncated at 500
oldest-first. The console's record browser shipped the oldest-50-as-"the records" trap. `runs --for`
sorts by ULID rather than the shared comparator. And a five-site direction change that missed one
site paged 139 records of 25, with repeats, silently.

**How they were found: audits 6, symptoms 3, manual review 5, guards 2.** The grep guard added
2026-08-23 found two on its first run. Everything else cost a person.

## Finding 1: leading with direction repeats the tool-list mistake

Two sentences from [gotchas.md](gotchas.md), which the first draft of this plan did not obey:

> **A bounded read of a registry stays a bug after you fix its DIRECTION.** The fix was
> `dir: "desc"`, which corrected which tools vanish and left the boundedness.

> **No single page direction is correct over a set larger than the page.** Reading newest-first
> alone does not work either: an old-but-live grant falls off the other end.

Naming the direction at every call site (`queryNewest` / `queryOldest`) is that same partial fix at
API scale: everyone states a direction, everyone feels safer, the boundedness is untouched. For a
POPULATION question direction is irrelevant. It matters for DISPLAY and for WALKING, and the plan
must keep those apart or it ships incident 2 again.

## Finding 2: three strategies, and the best one was missing

The credential fix neither paged nor exhausted:

```ts
private async newestByHash(kind: string, tokenHash: string) {
  const rows = await this.query({ kind, match: { tokenHash } }, 1, { dir: "desc" });
```

| | strategy | cost | when |
|---|----------|------|------|
| 1 | **exhaust** (`queryAll`, `readRegistry`) | O(history) | the whole set |
| 2 | **page** (explicit, with a cursor) | O(page) | display, walking |
| 3 | **narrow** (match to a key, take newest 1) | O(1) | one current thing |

Every incident in the census is a strategy-1 or strategy-3 question answered with strategy 2.

Strategy 3 is the best where it applies and it needs no ceiling, no projection and no direction
debate. It also indicts a fix made on 2026-08-23: `lookupProcedure` matches `{name, conversationId}`
and wants the newest, which is strategy 3, and it was "fixed" with `queryAll`, reading that name's
whole history to discard all but one. Correct, wasteful, and the wrong pattern to copy.

## Finding 3: the rejection of a server-side registry read has expired

[plan-registry-cost.md](plan-registry-cost.md) rejected it because it hides an O(history) walk where
the caller cannot see it, and because it removes the pressure to sweep. **Both were dissolved by
that same plan's items 1 and 3, which shipped.** Automatic per-kind compaction made registries flat
(measured: 21 pages and 4.9 MiB became 1 page and 10 KiB), so the hidden cost is now a FLAT hidden
cost, which is the stated bar; and nobody has to remember to sweep, so there is no pressure to
remove.

It is also the only mechanism that reaches **Python**, where a type brand cannot go, and the only
one that makes a hand-rolled projection UNNECESSARY rather than merely discouraged.

## Finding 4: a missing invariant, one violation left

> **A registry is either compactable or capped. Never neither.**

| kind | compactable | capped |
|------|-------------|--------|
| app kinds with a `contentKey` | yes (auto, 2026-08-23) | |
| `agent_run`, `oidc_identity` | yes (runtime keys) | |
| `grant` | never | yes, 256, plus the absorb |
| `ops_grant` | never | yes, 64, plus the absorb |
| `kind_def` | never | the absorb alone; no ceiling fits |
| `signal`, `agent_definition` | never | neither, and neither is a registry |

**The absorb is what actually holds the invariant; the ceilings are backstops.** An identical live
re-put of a `grant`, `ops_grant` or `kind_def` is ANSWERED with the record that already carries it
rather than written, always, not merely at a threshold. That removes the growth at its source:
content-keying dedupes a re-put for the idempotency window and not past it, so a fleet restarting
weekly appended one record per entry forever on kinds nothing can sweep. Measured after the change:
25 identical declarations are one record, and 30 identical power assignments are one record. The
ceilings now only ever meet DISTINCT identities, which is the shape repetition cannot reach.

Three rules make it safe, and each has a failure behind it. Compared by BODY, never by identity:
`grantKey` excludes `scope`, so a grant adding `scope: {createdBy: "self"}` carries the same identity,
and absorbing on identity alone DROPPED the narrowing while reporting success, leaving the wider
grant standing. A live identity with a DIFFERENT body writes even past the ceiling, because it is a
replacement rather than a new entry and a ceiling must never block a write that REDUCES authority. A
withdrawal is never refused, and `entries` rather than `newest` is what makes a re-put after a
retirement revive rather than be absorbed.

`signal` and `agent_definition` are excluded deliberately: a signal is a BROADCAST, so two identical
ones are two events and absorbing the second would lose one; an agent definition carries a freshly
minted `tokenHash`, so no two bodies are ever identical and the read would buy nothing.

**`ops_grant` was the live one. CAPPED 2026-08-25** at 64 per principal
(`maxOpsGrantRecordsPerPrincipal`, `429 too_many_ops_grants`). `Space.opsPowers` reads it per
principal, exhaustively, on EVERY ops-plane request (`src/server/http.ts`, the gate), which is the
same hot-path shape as the grant read that measured 1.72ms at one record and 93.57ms at 5,000 on
Postgres; the 2026-08-22 ceiling covered `grant` only.

64 rather than the grant ceiling's 256, because the healthy number is far smaller: an identity here
is (principal, sorted operations) over a CLOSED five-power vocabulary, so at most 31 can exist per
principal and a real deployment holds one or two. Reaching the ceiling therefore always means
history, never variety.

The two checks now share `Space.checkRegistryBudget`, which holds the three rules a ceiling on an
uncompactable registry needs (a withdrawal is never refused; at the ceiling a live identical re-put
is ANSWERED with the record already carrying it rather than written; an incomplete read refuses
rather than guessing). Guard in `test/conformance/suites/limits.ts`, proved red twice: with no
ceiling, and with the exempt-instead-of-answer version that the grant ceiling shipped with first.

**`kind_def` gets the absorb and NO ceiling**, because neither ceiling shape fits it: a cap per kind
NAME would not bound what `loadKinds` pays (that read is over the whole kind, so 100 names x 64 is
still 6,400 records), and a cap on the TOTAL would refuse declaring a new kind, which is the one
thing here that legitimately grows. The ceiling would land on variety instead of history, which is
backwards. The absorb is enough because the growth had exactly one source, and a real schema change
still writes, which is what keeps the declaration history this kind is excluded from compaction for.

Its exposure was also lower than the other two: `refreshKind` narrows to `{kind}` and takes the
newest 1 (strategy 3, O(1)) on the per-request path, so only `loadKinds` at STARTUP ever paid.

`signal` and `agent_definition` accumulate too, but every read site narrows them (`{agent}` limit 5,
`{tokenHash}` limit 1), so their growth is storage rather than read cost. That is a property of the
current call sites, not of the kinds, and it is why the invariant is worth stating rather than
inferring.

## What each mechanism would have caught

| mechanism | incidents |
|-----------|-----------|
| server-side registry read | tool list x2, credentials, grants, procedures x2, `runs --for`, the five readRegistry callers, the minor trio, **and in Python** |
| `Population` brand | tool list x2, credentials, grants, procedures x2, the minor trio (TS only) |
| `readRegistry` builds the `Page` | the five callers, by construction |
| strategy-3 discipline | procedures x2, and the shape behind the credential index |
| `pageClause` | the 139-of-25 walk, and future drift |
| cursor + SDK rename | **none of them** |

Caught by nothing: the HAND-ROLLED projection in `runs --for` (a `Map` and a loop is just code), and
`grant()`'s revival anchor scan, which needs exhaustiveness but never projects, so no brand sees it.

## The plan, in order

**1. Name the three strategies in CLAUDE.md. DONE 2026-08-25**, in the stopping-rule section, as
NARROW / EXHAUST / PAGE with the rule that direction is not the question.

**2. The compactable-or-capped invariant, enforced. DONE 2026-08-25.** One shared
`Space.checkRegistryBudget` over the three uncompactable registries, with the absorb as the primary
mechanism and the ceilings as backstops (see Finding 4). This was a prerequisite for 3, not a
follow-up: without it the server-side read is exactly the thing plan-registry-cost.md rejected.

**3. Server-side registry read. DONE 2026-08-25.** `POST /v0/records/registry` ->
`{entries, complete, scanned, scope?}`, `Space.registryOf`, `client.registry(kind, match?)` and
`client.registry(kind, match=None)` in Python.

WHAT THE CALLER DOES NOT SUPPLY IS THE POINT: no direction, no cursor, no page size, and NO KEY
FUNCTION. The key comes from what the kind declares (`contentKey`, or `RUNTIME_KEYS` for a reserved
kind), which is now the single statement `gc` compacts by and readers project by. It was stated
TWICE per registry before, and `examples/chat/space/kinds.ts` carried a comment recording that a
human had checked the two agreed. Disagreement is silent and one-directional in the worst way: `gc`
deletes by its key while readers project by theirs. A kind with no declared key is REFUSED
(`kind_not_keyed`) rather than projected by a guess.

It also gives PYTHON a correct path at all: that SDK has `query_all` and no projection whatsoever,
so a Python caller wanting the current set had to hand-roll latest-wins, which is the shape no guard
can see and which `radia runs --for` got wrong three ways at once.

Authorized exactly as a query, and that matters more here than elsewhere because the answer LOOKS
absolute: the grant's pattern is ANDed in, an author scope applies, and `scope` rides along so a
narrowed set is not mistaken for the whole registry. Pinned as a row in `test/http.test.ts`'s
per-read-verb table, proved red by dropping the author scope, on a KEYED fixture kind so the row
cannot pass by erroring.

`liveModels` is converted as the worked example; its `queryAll` + `activeByKey(b => b.tier)` pair is
gone, and with it the hand-checked agreement. Its `complete: false` now refuses to route rather than
routing on a prefix.

**4. `Population` brand. DONE 2026-08-25.** `Population = RadiaRecord[] & { readonly [exhaustive]: true }`
in `sdk/ts/registry.ts`, produced only by `queryAll` and `readRegistry`, required by `activeByKey` /
`newestByKey` / `activeSet`.

IT FOUND TWO LIVE DEFECTS THE MOMENT IT COMPILED, and the prediction of "zero call-site changes" was
simply wrong: both were in `examples/chat/client/`, both invisible to step 2's grep because that
window looks BACKWARD from the projection and both reads were inline arguments AFTER it. The grant
review projected the newest 50 `grant_request` records and the tool list the newest 200 `procedure`
records. `dir: "desc"` makes those look careful, and both carried a comment saying so, but a page
does not drop stale VERSIONS: it drops whole KEYS, so the request left waiting longest and the
earliest-saved procedure are exactly what disappears. Both now exhaust. This is the third and fourth
instance of the same defect in the chat's registries, after the two step 2 found.

The window bug is fixed too (it looks both ways now, proved red against the defect it missed), but
the type is the primary rule: it cannot be defeated by where the read sits relative to the call.

The brand does NOT mean "complete" (`readRegistry` brands its accumulation while reporting
`complete: false`); it means **this read either exhausted or told you it did not**, which is exactly
what separates it from `query(p, 500)`. `unsafeAsPopulation(records, why: string)` is the named
escape, `why` mandatory, and the ledger in `test/registrycost.test.ts` asserts the EXACT set of
sites, so a new one is a deliberate edit and a rising count is the signal the brand is being routed
around. Six escapes today: the two reads that earn it, a concatenation of two `queryAll` halves in
`runs --for`, and three tests over sets they wrote themselves.

The idiom matters: `{ __exhaustive: unique symbol }` as a property TYPE degrades the intersection to
`{}` and takes `.map`/`.length` with it. `declare const exhaustive: unique symbol` plus a computed
key is the form that keeps the array half intact.

**5. `readRegistry` constructs the `Page`. DONE 2026-08-25.** The reader now receives a
`RegistryPage` (limit, dir and cursor together) and passes it through:
`(page) => client.query(pattern, page.limit, page)`. All 14 call sites converted; the five that
paged ascending against the prose contract are fixed BY CONSTRUCTION, and no caller names a
direction any more. Guard: `test/registrycost.test.ts` refuses a `dir` near a `readRegistry` call,
proved red by planting one back.

**6. Move the known sites onto the right strategy. DONE 2026-08-25.** `runs --for` now exhausts
(`queryAll`) and projects with `newestByKey`, so all three of its defects go together. Its guard
DRIVES THE REAL VERB rather than re-implementing the correct read, which mattered: the first version
re-implemented it and passed against the broken CLI. Staging it correctly mattered too, and the
first attempt did not: what defeats a bounded read is many DISTINCT runs, not a long history of one,
because the oldest page is then full of long-expired runs whose projection is still expired.

`lookupProcedure` moved to strategy 3 (`readNewest`, O(1)). Its sibling `read_procedure` did NOT,
and the split is the point: it also answers `versions`, which is a question about the whole history,
so exhausting is the right answer there. Match the strategy to the question, not to the file.

**7. `pageClause` plus the guard. DONE 2026-08-25.** `pageClause(page, {column, placeholder})` in
`src/core/matching.ts` emits the `where`, the `orderBy` and the params together, so there is no pair
to mismatch; `placeholder` is a callback that PUSHES, so a bind number cannot drift from its
parameter, and `column` carries the dialect's own qualification (`r.id`, `id collate "C"`). It also
hands back `dir` and `cmp` for the one caller that must build a SECOND cursor on the same axis (the
chunked scan), so that cursor cannot pick a different direction than the page it belongs to.

The guard flags a comparison of `page.dir` against a direction literal, not any mention: asking
whether a caller SUPPLIED one is a different question, and two sites legitimately do (refusing a
cursor combined with `orderBy`, and reporting "no dir was given" in an explain note). Proved red.

**8. Cursor and the SDK rename. DONE 2026-08-25. DISPLAY HONESTY, explicitly not the disease**, and
last so nobody mistakes it for the fix.

A cursor only exists after the first page, so `dir` cannot go away: the cursor replaces `after`, not
`dir`. `cursor` with `dir` is a 400, matching the existing refusal of a cursor with `orderBy`;
with `orderBy` no cursor is offered at all. Encoding is legible (`a:01M0…` / `d:01M0…`), not base64:
a bare ULID is 26 characters of Crockford base32 and cannot contain `:`, so an old-style `after` is
DISTINGUISHABLE rather than silently misread, and the CLI prints it. Opaque stays the contract, as
with the events cursor. It does not encode the pattern (8 KiB, and it re-introduces the ambiguity it
removes) or the limit (a caller may change page size mid-walk).

The rename is `queryNewest` / `queryOldest` / `queryOrdered` / `queryPage` / `queryAll`, removing
bare `query(pattern, limit)`: 213 call sites, each a compile error that forced a choice (61
`queryNewest`, 139 `queryOldest`, 13 pass-throughs and hand-rolled walks). It ships with 4 or not at
all: the rename without the brand is documentation, and the brand without the rename leaves
`query(p, n)` ambiguous.

`queryOrdered` WAS NOT IN THE PLAN and the rename could not land without it. `query(p, n)` sent no
`dir`, and `queryOldest` sends `dir: "asc"`, which the space refuses combined with `order_by` (a
pattern that already states its order). 18 sites read that way, so a purely mechanical rename turned
them into 400s. The direction verbs now throw LOCALLY on an `orderBy` pattern and name
`queryOrdered`, which caught the six multi-line sites a line-based sweep had missed. The lesson
generalises: a vocabulary that names the direction has to name "the pattern decides" too, or the
default is the thing with no name.

THREE DEFECTS IN THIS STEP'S OWN WORK, found by auditing it rather than by the suite, which was
green for all three:

- **The handler resolved the direction a SIXTH time.** `encodeCursor(page?.dir ?? "asc", ...)` is the
  decision `pageClause` owns, written as a default instead of a comparison, so step 7's guard did
  not match it. A cursor saying `a:` for a walk the storage ran descending sends the next page
  backwards. Now `pageIsDescending`, and the guard matches `??`/`||` defaulting too.
- **Both RELAY sites broke.** The MCP adapter's `space_query` and the broker's query proposal pass a
  pattern written by someone else (a model, jailed code), so `order_by` is DATA there. The
  mechanical rewrite made them `queryOldest`, whose new local refusal turned every ordered query
  from a model or a jail into an error, on a NORMATIVE surface in the broker's case. Neither had
  coverage. Both now dispatch to `queryOrdered`; there is a broker conformance test and a
  structural guard for the class, both proved red.
- **Python accepted `cursor` with `dir="asc"`.** `dir` defaulted to `"asc"`, so passing it was
  indistinguishable from not passing it, and Python accepted the exact pair the server and the TS
  SDK refuse. Default is `None` now. `query_newest`/`query_oldest` also refuse `order_by` locally,
  matching TS.

A FOURTH, found by asking what `queryAll` now trusts: **its termination moved from evidence it
computed to a field the space chooses to send.** It used to stop on `rows.length < 500`; walking by
cursor made it stop on a missing `nextCursor`, so any space that does not send one would turn the
read that REFUSES to truncate into one that truncates silently and brands the prefix a `Population`.
The three walks with the same shape (`readAllManifests`, git's version walk, Python's `query_all`)
had it too, and the workspace ones set `complete: true`, the flag `radia workspaces` and the chat's
`list_workspaces` both read. Now: a SHORT PAGE is the only thing that says stop, `nextCursor` only
says where to continue, and a full page with nowhere to continue raises (or reports
`complete: false`). `test/exhaustion.test.ts` drives it over a real socket with the field stripped.

The generalisation is worth more than the three fixes: **a call site that did not write the pattern
cannot make assumptions about it.** A literal pattern with `order_by` and a direction is a
programmer error and throwing is right; the same pattern arriving from a tool call is a request to
honour.

`Page` is a DISCRIMINATED UNION, so `{cursor, dir}` is a TypeScript error rather than only a 400:
`{after?, dir?, cursor?: never} | {cursor, after?: never, dir?: never}`.

The audit also turned up a PRE-EXISTING member of the same family, and a worse one, because it
needs no rename to bite: **a handler picks fields by name, so a misspelled one is silently dropped,
and wherever that field narrows, dropping it WIDENS.** `order_by` (the spelling this repo uses in
prose everywhere) answered 200 unsorted; `match` dropped on the registry verb returns the whole
registry as a slice; `kind` dropped on `remediate` drains every app; `parent_ids` dropped on `put`
costs the record its lineage. `rejectUnknown` in `src/server/problem.ts` now refuses them by name.
Two are worse than a wrong answer. FAIL-OPEN: `take`'s `allowTaint` is the caller's own barrier, an
absent one means no barrier, so `allow_taint: []` (the strictest request there is) was read as "send
me anything". And PRIVILEGE-WIDENING: a `grant` body's `pattern` is optional and omitting it means
the whole kind, so a misspelled `patern` committed an UNSCOPED grant, with
`effectivePermissions` reporting `patterns: []` for an author who had written a bound.
`kind_def` is covered too, but ONE-SIDED: strict on the write path, lenient on load. `loadKinds`
skips what its validator rejects, so a shared strict validator would turn a stored declaration
carrying an unknown field into an unloadable kind and fail every query against it after a restart.
`assertKnownKindDefFields` therefore hangs off `validateReservedBody` and not `kindDefFromBody`,
so the load path cannot reach it by construction rather than by remembering a flag.

The rule was already written down THREE times in the code that lacked it, in `handleTake`
("dropping it would claim a different record than asked"), in `bodyTaint`, and in `clientTaint`
("collapsing it to `undefined` turned the strictest possible request into no barrier at all"); it
had just never been applied to FIELDS. See [gotchas.md](gotchas.md).

The CLI gained `--cursor` and LOST the need to re-carry `--oldest`: the continuation line used to
repeat the flag at every hop, one dropped word from a walk that reversed. `--cursor` with `--after`
or `--oldest` is a usage error, mirroring the server's 400. `/v0/ops/events` and `children` keep
`nextAfter`, and the differing names now mean something: `nextCursor` carries a direction, while
`nextAfter` is a forward-only position in a log.

## The sibling disease: a dropped FIELD, not a truncated READ

Found while auditing this plan's own work, 2026-08-25, and it belongs here because the failure is
the same sentence with one word changed. The disease this plan is named for is **a bounded read
presented as a population**. Its sibling is **a dropped field presented as a bound**: the code picks
fields by name, so a misspelled one falls on the floor, and wherever that field NARROWS, dropping it
WIDENS. Both answer confidently with something smaller or larger than was asked for, and neither has
a symptom.

Five instances, worst first:

| where | the misspelling | what the caller got |
|-------|-----------------|---------------------|
| `grant` body | `patern` | an UNSCOPED grant: every record of the kind, with `effectivePermissions` reporting `patterns: []` |
| `POST /v0/takes` | `allow_taint` | NO taint barrier: an absent `allowTaint` means "send me anything", so the strictest request became the weakest |
| `POST /v0/ops/remediate` | `Kind`, or `expired: "true"` | a sweep across EVERY app's backlog, and one reclaiming LIVE leases |
| `POST /v0/records/registry` | `mach` | the whole registry returned as a slice |
| `POST /v0/records` | `parent_ids` | a record with no lineage, so graph, Feed, `children` and flow mining all lose the edge |

Plus the one with a named victim: `order_by` on a read. That is the spelling the design docs, the
Python docstrings and the chat's own tool description all use in PROSE, while the wire field is
`orderBy`, so it answered 200 with records in id order. `space_query`'s description tells a model to
"order_by the numeric path descending" to answer *which X had the most Y*; a model following the
prose got the OLDEST rows and reported one of them as the maximum.

**The rule was already written down three times in the code that lacked it**: `handleTake`
("dropping it would claim a different record than asked"), `bodyTaint` ("a wrong-typed field is a
caller believing it restricted a record"), and `clientTaint` ("collapsing it to `undefined` turned
the strictest possible request into no barrier at all"). It had simply never been applied to FIELDS.
`rejectUnknown` in `src/server/problem.ts` is that rule, with a near-miss table naming the field
meant. `put` refuses only near-misses, because ignoring the rest is how the server-assigned half
gets dropped there.

TWO PLACES NEEDED THE CHECK IN CORE RATHER THAN AT THE BOUNDARY, and both for the same reason: the
record arrives by more than one route. A `grant` reaches validation from `put`, from
`createAgentDefinition` and from a definition's grant list, so `validateGrantDef` owns it. A
`kind_def` is stricter still on one side and lenient on the other: `assertKnownKindDefFields` hangs
off `validateReservedBody` (write) and NOT off `kindDefFromBody` (load), because both readers of a
stored declaration swallow a validation failure and keep what they have, so strictness there would
make a stored kind_def an unloadable kind, and through `refreshKind` a kind declared on ANOTHER
INSTANCE would never register on this one.

AND ONE THE WIRE CANNOT REACH. A tool boundary rebuilds the pattern from the model's arguments, so
the model's key never crosses the socket and no server-side refusal can see it. Those accept BOTH
spellings, because the key is chosen by a model and a dropped sort key is a wrong answer rather than
an error.

## The core default stays `asc`

Decided 2026-08-24. It matches the claim order (`take` ranks `available_at asc, record_id asc`),
which is what makes `after` a forward walk through time, and the mud's event tail depends on it.
The registry reading wants newest and the coordination reading wants oldest; naming the two readings
is the fix, and per Finding 1 neither is correct for a population anyway.

## What this cannot do

- **A hand-rolled projection is undetectable in general.** Step 6 removes the incentive; nothing
  removes the possibility.
- **A non-projection history scan** (`grant()`'s revival anchor) needs exhaustiveness and never
  projects, so no brand sees it. Only review catches that shape.
- **Python gets no type work.** The grep guard and the parity suite are what it has, which is why
  step 3 (server-side) matters more than step 4 (brand) despite being the larger change.
- **If step 3 ships without step 2**, it becomes a read whose cost the caller cannot see, on
  `ops_grant`, on every ops request. That is the failure this plan is most likely to cause.
