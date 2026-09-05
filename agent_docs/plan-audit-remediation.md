# Plan: audit remediation

> Status: **Package X (2026-08-25) is the first entry here that is not a codebase audit**: it is what
> reviewing ONE change set twice produced, and it produced more defects than the change set fixed.
> Two are P1 (an unscoped grant from a typo, a fail-open taint barrier), five were pre-existing and
> share one shape, and every one of the five was already a rule written in code that did not follow
> it. Read it before picking a request field by name. CLOSED same day. **Package Y (2026-08-29)** is
> the fourth audit, run by CLASS rather than by file; **Package Z (2026-09-04)** is the fifth, an
> external review re-derived line by line. Both CLOSED the day they opened. **NO PACKAGE IS OPEN as
> of 2026-09-04**, and no P0 ever stayed open (K closed 2026-08-03: definitions are revocable).
>
> **A third audit opened package W on 2026-08-22 and CLOSED it the same day** (fourteen
> findings across seven root causes, five guards proved red first; two reported findings did not
> survive the check and are recorded with the correction, and the structural debt it named stays
> open). **T closed 2026-08-06**: the confiner shipped the day the defect was measured, and this
> entry said otherwise until 2026-08-30, which is a projection read as state over an append-only
> ledger, in prose rather than in code; in those three weeks four independent external reviewers
> each reported the shipped fix as an open P1. Everything else closed: A–G and J–O by 2026-08-03, **H, I, N, P, Q, R
> and S** on 2026-08-04. What remains is the deferred low-severity batch below. The two pooled-Postgres races
> package S fixed without a failing test now have one each (`test/concurrency.test.ts`, both
> validated against the pre-fix adapter planted back in). The guards pass: `deno task test:runtime`
> is 518 passed, 0 failed, and 734 with a live Postgres (counts move as suites are added; the
> claim to check is 0 failed). Each done package is a status line here; its
> durable lesson (the bug class, why it happened, the rule that prevents it) moved to
> [gotchas.md](gotchas.md), which outlives this plan. Every item was substantiated against real code
> paths; items marked **reproduced** were verified empirically. Line numbers drift; trust the symbol,
> not the number.
>
> **Two rounds, and a re-derivation.** A–J are the 2026-07-27 audit. K–Q come from a second review
> on 2026-08-03, marked VERIFIED (checked against source while recording them) or REPORTED (recorded
> on the reviewer's evidence). **No REPORTED item is left**: package S re-derived all twelve on
> 2026-08-04 and eleven reproduce, so the distinction now separates what was checked WHEN, not what
> can be trusted. Keep marking new findings this way; the pass that turned one report into a live
> 500 and shrank another to a narrow race is why.

## Goal

Close the defects the audit confirmed, and in each case leave behind the guard that would have
caught it. Several findings share one root cause; the packages below are grouped by root cause,
not by file, because fixing them per-site re-creates the same class next quarter.

Ordering rule: **P0 before anything else ships to a non-loopback host.** P0 and P1 are
correctness/security; P2 is durability and drift. Round two opened the first P0 (**K**, a credential
with no revocation path); it was closed the same day, and no P0 is open.

## Priority summary

| Pkg | Theme                                   | Severity | Blast radius                          |
|-----|-----------------------------------------|----------|---------------------------------------|
| ~~E~~ | ~~Pushdown soundness~~                | ~~P1~~   | **CLOSED 2026-08-03**                 |
| ~~G~~ | ~~Blob write durability~~             | ~~P2~~   | **CLOSED 2026-08-03**                 |
| ~~H~~ | ~~`lease_lost` unobservable in clients~~ | ~~P2~~ | **CLOSED 2026-08-04**                 |
| ~~I~~ | ~~SDK parity + chat example~~         | ~~P2~~   | **CLOSED 2026-08-04**                 |
| ~~K~~ | ~~Unrevocable definition tokens~~     | ~~P0~~   | **CLOSED 2026-08-03**                 |
| ~~L~~ | ~~Watch streams cache authorization~~ | ~~P1~~   | **CLOSED 2026-08-03**                 |
| ~~M~~ | ~~`kind_def` is not write-protected~~ | ~~P1~~   | **CLOSED 2026-08-03**                 |
| ~~N~~ | ~~`clientMeta` escapes the body guards~~ | ~~P2~~ | **CLOSED 2026-08-04**                 |
| ~~O~~ | ~~Multi-instance freshness + ordering~~ | ~~P1~~   | **CLOSED 2026-08-03**                 |
| ~~P~~ | ~~Contracts nothing checks~~          | ~~P2~~   | **CLOSED 2026-08-04**                 |
| ~~Q~~ | ~~Designed features unreachable~~     | ~~P2~~   | **CLOSED 2026-08-04**                 |
| ~~R~~ | ~~Dead taint parameter; half-tested guard~~ | ~~P2~~ | **CLOSED 2026-08-04**                 |
| ~~S~~ | ~~Round-two reports, re-derived~~     | ~~P1/P2~~ | **CLOSED 2026-08-04** (11 of 12 reproduced) |
| ~~T~~ | ~~Module loading escapes the Deno jail's read permission~~ | ~~P1~~ | **CLOSED 2026-08-06** (macOS confiner unexecuted in CI; native Windows unsupported) |
| ~~U~~ | ~~Idempotency keys scoped to one run token~~ | ~~P2~~ | **CLOSED 2026-08-09** |
| ~~V~~ | ~~A worker dereferences a body field with its OWN authority~~ | ~~P1~~ | **CLOSED 2026-08-16** (reproduced, then fixed) |
| ~~W~~ | ~~Third audit: SDK parity, audit-event integrity, two orderings of "newest"~~ | ~~P1/P2~~ | **CLOSED 2026-08-22** (14 findings; 5 guards proved red) |
| ~~X~~ | ~~One change set reviewed twice: unscoped grant from a typo, fail-open taint barrier~~ | ~~P1/P2~~ | **CLOSED 2026-08-25** (7 findings, 2 P1) |
| ~~Y~~ | ~~Fourth audit, by class: a write bound on one of two write paths~~ | ~~P2/P3~~ | **CLOSED 2026-08-29** |
| ~~Z~~ | ~~External review of v2026.8.5: sandbox claims the code did not deliver~~ | ~~P1~~ | **CLOSED 2026-09-02** |
| ~~Z~~ | ~~External review re-derived: ops gate parse, event cursor, grant `$or` cap, `newestByHash` order~~ | ~~P1/P2~~ | **CLOSED 2026-09-04** (7 of 8 fixed; 1 not found) |

**Every package is closed as of 2026-09-04**, T included (2026-08-06; this line said otherwise until
2026-08-30), Y (2026-08-29) and both Z entries (2026-09-02 and 2026-09-04, external reviews, each
closed the same day). When a package closes, the heading, the table row and this summary line are
three places and all three are the ledger; a reviewer reads whichever one they land on, so a
close recorded in one of them is not recorded. Closed lessons are rules in
[gotchas.md](gotchas.md) ("Traps and critical decisions"); their guards run in the conformance and
chat suites. Git holds the rest.

## Package Z: an external review of v2026.8.5 (2026-09-02), CLOSED 2026-09-02

An outside reviewer traced attack paths against the tagged release; most findings re-derived
documented decisions, two were P1 and both are one class: **a machine-readable sandbox claim the
code did not deliver**, in the subsystem whose doctrine is verify-before-serve. Its P2/P3 residue
landed the same day, each guard proved red: `radia host` tries the platform confiner by default
and grew `--require-confinement`; brokered dynamic reads flow into lineage (`read_one` → forced
parent, any read's labels raised; `InvokeContext.observed`); and the non-brokered result marker
is nonced per run so the module sharing stdout cannot steer the parse.

### Z1. The brokered host ignored a resolved sandbox record's confiner (P1), FIXED

`runBrokered` chose its backend on `spec?.isolation === "bubblewrap"` alone and never read
`confiner`/`importsConfined`, and `radia host` never sets `opts.run.confine`; so a binding resolved
to the `deno-confined` record (declared by the chat exec worker and `exec-tool.ts` wherever the
probe passes) ran in the PLAIN Deno jail while the record advertised `importsConfined: true`. The
plain jail's module-loading hole (package T) then reaches any JSON/module the host user can read.
Fix: the record's `confiner` is now spawned (bubblewrap), and a claim this spawn cannot build
(Seatbelt, or `importsConfined` with no confiner) is refused, the `assertHostCanRun` rule on a
second axis. Guards: `broker.test.ts` "refused, never downgraded" + "DELIVERED, not merely
not-refused" (canary import; bwrap-gated). VERIFIED in source; both guards proved RED against the
planted pre-fix spawn (spec.confiner unread, throws disabled), then green on the fix.

### Z2. `bwrapSandbox`/`seatbeltPythonSandbox` declared a `memoryMb` nothing enforces (P1), FIXED

`runBwrap`/`runSeatbelt` consume only the timeout and the output cap (no rlimit anywhere in
`sandbox.ts`), yet both specs published `memoryMb` from `DEFAULTS`, and `probeSandbox` has no
memory claim to catch it. Fix: both specs now say `0` (unbounded, stated), the web backend's rule;
only the Deno jail keeps a number, because `--max-old-space-size` enforces one. Asserted beside the
existing spec-honesty cases in `workspace.test.ts`. Enforce a real rlimit before ever declaring a
number again ([design-execution.md](design-execution.md), "Exhaustion has more dimensions").

## Package Y: the fourth audit (2026-08-29), CLOSED 2026-08-29

Run by CLASS rather than by file, using the classes this file and
[plan-bounded-reads.md](plan-bounded-reads.md) already name. Three findings, each verified against
source and each guarded; the two that matter are both the SAME class, a second write path that grew
after the first learned a rule.

### Y1. An `ack` result reached none of the registry ceilings (P2), FIXED

`checkBudgets` and `checkInterestBudget` live in `Space.putRaw`, whose comment claimed they run "on
every write path". An `ack` result is built by `buildRecord` in `settle` and written by the
adapter's settle, so it reached neither. MEASURED: `maxInterestsPerPrincipal` of 3, six interests
emitted as ack results, **zero refused and nine entries standing**. Any worker holding
`interest: put` and a claim could evade a cap that exists because somebody else pays to read that
registry (the dry-run matcher and the starvation split).

**Rule.** A rule that bounds a write runs on BOTH write paths, which is what
`validateReservedBody`'s own comment says and what its neighbours did not do.
**Fix.** `Space.checkCeilings`, called from `settle`. CEILINGS ONLY: the absorb answers "here is the
record that already carries this", which a settle cannot use, since it must name its own result.
**Guard.** `test/conformance/suites/limits.ts`, proved red.

### Y2. Two handlers picked request fields BY NAME with no `rejectUnknown` (P2), FIXED

`POST /watches` and `POST /agent-definitions` read a body and picked fields by spelling. Both had a
field where the typo removes a CONSTRAINT rather than a convenience: a watch's `match` NARROWS, so
`macth` left a kind-wide watch the caller believed was scoped; and a definition's `supersedes` is
the compare-and-set that stops two racers leaving an agent with two live minting tokens.
**Guard.** `test/http.test.ts`; both now 400 and name the field.

### Y3. The contract promised a field no implementation ever honoured (P3), FIXED

Adding the check above made `test/openapi.test.ts` fire: `POST /watches` `$ref`s the whole `Pattern`
schema, so the contract has always promised `orderBy` while the handler hardcoded
`orderBy: undefined`. A watch has no order. The spec now describes what the handler does.

Fixing it also found the GUARD itself wrong in two ways that cancelled out: it flattened a `$ref`
nested under `properties` into the top-level field set (reporting `GrantDef`'s own fields as
`/agent-definitions` request fields), and it unioned a handler's body-level and NESTED-object
guards. Each was wrong; together they agreed, which is why no mapped row ever failed. Both fixed,
and the corrected guard was proved to still catch a planted mismatch.

## Package U: idempotency keys were scoped to one run token (P2) — CLOSED 2026-08-09

VERIFIED 2026-08-09 by reading the scope; CLOSED the same day.

The fix is one seam: `Space.idem` (`src/core/space.ts`) scopes `IdempotencyKey.principal` to the
agent behind a `run:*` caller, via the same `agentForRun` resolution `created_by` and flow mining
already rely on. The agent behind a run is immutable, and the resolver falls back to reading the
space, so the scope survives a runtime restart; an unresolvable run scopes to itself (no dedupe,
never a shared scope). Contract case: `test/exchange.test.ts` "an idempotency key survives a
re-mint", covering both directions (a second run of the same agent replays; a different agent with
the identical key writes its own record), proved to FAIL against the planted old behavior. This
also makes CLAUDE.md's registry claim ("restarting a fleet does not append a duplicate per entry")
true for definition-token workers, which is what the 39-tools-to-1,498-records measurement in
[plan-gc.md](plan-gc.md) was.

[architecture-workspace-agents.md](architecture-workspace-agents.md) states that keying a brokered
put on `(claimed record, output ordinal)` makes a retried attempt's writes a replay. It does, WITHIN
one run token. An idempotency row is scoped to the RESOLVED CALLER (`IdempotencyKey.principal`,
`src/storage/adapter.ts:285`, filled from `ctx.principal` in `Space.idem`), and a run token resolves
to its own `run:*` principal (`src/server/http.ts:198`). So a retry after the SDK re-mints on expiry,
or after a host restart, is a different principal and writes duplicates.

The contract case (`extensions/conformance/broker.test.ts`, "a retried attempt's writes dedupe")
retries through the SAME host, so it passes without covering that boundary: a guard reading stronger
than it is.

Decided: scope to the agent. The isolation cost was considered and accepted: a replay is returned
only when the request hash matches an identical request from the same agent's earlier run, which is
the same actor with the same authority retrying the same write. The alternative (documenting the
bound) left three sites over-claiming and the aggregator pattern unusable across restarts.

Surfaced while analysing [plan-chat-turn.md](plan-chat-turn.md), and that plan now lists this as
its PREREQUISITE: its keyed links are the aggregator pattern (watch a fact, emit derived work under
a content-derived key), which cannot survive a worker restart while keys are run-scoped. A second over-claim sits in `examples/pipeline/aggregator.ts:3`, whose
`summary:<jobId>` key is said to make the emit safe "even if two aggregators race": true for two
runs of one principal, false for two identities. Three sites now assume a key spans more than it
does, which is what makes this systemic rather than a broker defect.

## Package V: a worker dereferences a body field with its own authority (P1) — CLOSED 2026-08-16

**VERIFIED and CLOSED 2026-08-16.** Found while costing phase 0 of
[plan-encryption.md](plan-encryption.md), which would have added a second dereference of the same
shape. Recorded as REPORTED first, then REPRODUCED: the guard below fails on the pre-fix code with
a forged owner reaching another conversation's messages at `window=0`, and passes after.

**The defect.** `contextFor` takes the conversation to load from the CALL BODY and reads it with the
worker's own unscoped `message` grant. Its two branches disagree about whether the caller is checked:

```ts
// window <= 0                      no owner: the reader's authority is the worker's
match: { conversationId: body.conversationId }
// window > 0                       owner conjoined: effectively the caller's reach
match: { conversationId: body.conversationId, owner: body.owner, index: { $lte: upTo } }
```

The windowed path is safe, and only by that conjunction. A session's `llm_call: put` grant is
patterned `{owner: me}` under the default identity scope, so it MAY write
`{owner: alice, conversationId: <bob's>}` — the body matches its own grant — but the message query
then demands `owner: alice`, and Bob's messages carry `owner: bob`, so it returns nothing.

**Blast radius.** `window` is `--window` / `RADIA_CHAT_WINDOW`, default 40, and **`0` reads like
"no limit"**. With it set, Alice writes an `llm_call` naming Bob's conversation, the worker loads
Bob's whole thread into the model, and streams it back as `llm_chunk` records stamped
`owner: alice` (copied from the call), which Alice is granted to read. A cross-user read of an
entire conversation, reachable by configuration, in the shared-fleet deployment
(plan-scaling.md item 3) that makes two people share one worker at all.

**The rule, which is the general form.** A worker must NEVER read a record named by a body field
using its own authority. Bodies are claims; `bodyMatchesGrant` only constrains what a caller may
WRITE, never what a worker may then be induced to read on their behalf. Either dereference as the
caller (a delegated run, plan-delegation.md) or conjoin the caller's scope into the query the way
the windowed branch does. The conjunction is cheaper; the delegated run is the one that stays
correct when the scope field changes.

**The fix.** One match, built once (`const mine = {conversationId, owner}`) and used by all three
queries, so the branches cannot drift apart again. The conjunction IS the check: it reduces the
read to records the caller could have read themselves, because their own put grant is what forced
`owner` to be them.

**Guard.** `extensions/conformance/inference.test.ts`: a call naming another owner's conversation
gets an EMPTY context at BOTH window settings, and her own thread still loads. Proved red by
restoring the unconjoined query — it fails on `window=0` and passes at 40, which is exactly why a
guard covering only the default would have missed this.

## Package X: auditing a change set (2026-08-25), CLOSED 2026-08-25

Not a codebase audit. This is what fell out of reviewing ONE change set (steps 4 and 8 of
[plan-bounded-reads.md](plan-bounded-reads.md)) twice, and it is here because the ratio is the
finding: **the audit produced more defects than the work it audited**, and the worst of them were
pre-existing and unrelated to the change. Eight items, all VERIFIED by planting the defect and
watching a new guard go red.

**Three introduced by the change set** (recorded in detail under steps 4 and 8 of that plan):

1. **The query handler resolved the page direction a SIXTH time** (`page?.dir ?? "asc"`), written as
   a default rather than a comparison, so step 7's guard did not match it. It builds the cursor, so
   a wrong answer sends the next page backwards. Fixed to `pageIsDescending`; the guard now matches
   `??`/`||` defaulting too.
2. **Both RELAY sites broke.** The MCP adapter's `space_query` and the broker's query proposal pass
   a pattern written by someone else, so `order_by` is DATA there; the mechanical rewrite gave them
   `queryOldest`, whose new local refusal turned every ordered query from a model or a jail into an
   error, on a NORMATIVE surface in the broker's case. Neither had coverage. Guard:
   `extensions/conformance/broker.test.ts` plus a structural rule in `test/registrycost.test.ts`.
3. **`queryAll` moved its termination from evidence it computed to a field the space sends.** Any
   space not sending `nextCursor` would turn the read that REFUSES to truncate into one that
   truncates silently and brands the prefix a `Population`. Three sibling walks had it too, two of
   which set `complete: true`. Guard: `test/exhaustion.test.ts`, over a real socket with the field
   stripped.

**Five pre-existing, one shape: a dropped FIELD presented as a bound.** Code picks request fields by
name, so a misspelled one falls on the floor, and wherever that field NARROWS, dropping it WIDENS.
Worst first:

| # | where | misspelling | consequence |
|---|-------|-------------|-------------|
| 4 | `grant` body | `patern` | **P1**: an UNSCOPED grant. `effectivePermissions` reported `patterns: []` for an author who wrote a bound |
| 5 | `POST /v0/takes` | `allow_taint` | **P1**: NO taint barrier. An absent `allowTaint` means "send me anything", so the strictest request became the weakest |
| 6 | `POST /v0/ops/remediate` | `Kind`, `expired: "true"` | a sweep across every app's backlog; one reclaiming LIVE leases |
| 7 | `POST /v0/records/registry` | `mach` | the whole registry returned as a slice |
| 8 | reads, and the chat tool | `order_by` | 200 with records in id order. A model told to "order_by the numeric path descending" reported the OLDEST row as the maximum |

Fixed by `rejectUnknown` (`src/server/problem.ts`) at six surfaces, by `validateGrantDef` and
`assertKnownKindDefFields` in CORE where a record arrives by more than one route, and by accepting
both spellings at a TOOL boundary, which the wire cannot reach because the pattern is rebuilt from
the model's arguments. `kind_def` is deliberately one-sided (strict on write, lenient on load):
both readers of a stored declaration swallow a validation failure and keep what they have, so
strictness in the shared validator would make a stored declaration an unloadable kind. Guards:
`test/http.test.ts` (six surfaces), `test/conformance/suites/auth.ts`,
`test/conformance/suites/kinds.ts` (both halves of the split, each proved red by planting the other
arrangement).

THE LESSON, and it is about method rather than about any of these: **every one of the five was
already written down as a rule in code that did not follow it.** `handleTake` said "dropping it
would claim a different record than asked", `bodyTaint` said "a wrong-typed field is a caller
believing it restricted a record", `clientTaint` said "collapsing it to `undefined` turned the
strictest possible request into no barrier at all", and `validateGrantDef` said a silent no-op on an
authorization record is what gets mistaken for a working grant. The rule existed four times and had
never been generalised from VALUES to FIELD NAMES. Look for a rule stated locally that was never
applied at the level above it.

## Package W: the third audit (2026-08-22) — CLOSED 2026-08-22

**All seven groups are fixed, each with the guard named below, and five of the guards were proved
red against the pre-fix code before being accepted.** Fourteen findings from a four-agent read of
the whole tree, every one re-derived against source before it was written down.

Two guards could not be proved red and say so in their own comments rather than here: the
quarantine race needs concurrent connections the embedded adapters do not have (only the ACTOR half
is planted-red), and the `explain` spec entry is a documentation fix with nothing to plant.

One guard found a defect the audit had not: the decided-set check over `ENCRYPTED_FIELDS` failed on
its first run naming `cancel` and `sandbox`, two kinds nobody had ruled on. Both turned out to be
routing-only and are now recorded as such.

**Two of the reported findings did not survive the check, and are recorded because a wrong
mechanism is the expensive kind of wrong:**

- ~~The report said the OpenAPI info block "still says OIDC, keyset cursors and the event-log sweep
  are not implemented". It says no such thing; the phrase appears nowhere in the file.~~ **THIS
  REFUTATION WAS WRONG and is corrected here (2026-08-26).** The file said exactly that, at the end
  of the `info.description` block: "Not implemented yet: OIDC, scheduler admission,
  request/bid/award, keyset query cursor, the event-log sweep itself", while the same file
  documented `/sessions/oidc`, `cursor`/`nextCursor` and the sweep horizon. The refutation searched
  for the REPORT'S PHRASING rather than the claim, found no literal match, and closed a live
  finding; it then survived two further rounds because a checked-and-refuted entry does not get
  re-checked. A refutation is a claim like any other and needs the same evidence as the finding:
  quote the file, do not report the absence of a quote. The other half stands (see W7).
- The report attributed the newest-record split to "two instances whose wall clocks skew". It
  cannot be that: `created_at` comes from the DATABASE clock on every instance
  (`Space.putRaw` -> `storage.now()`), which is the invariant. The real split is that record IDs are
  ULIDs minted from the PROCESS clock (`core/ids.ts` -> `monotonicUlid`), so the two orderings
  diverge exactly as far as the app-server clocks diverge from each other. Same defect, different
  fix surface: see W3.

Grouped by root cause, because fixing them per site re-creates the class.

### W1. A second implementation that never learned the first one's rule (P2) — FIXED

The recurrence of closed package I, which is the finding. The TS client carries the rule in a
comment; Python was written from the wire and skipped it.

- **`put_artifact(taint=True)` is a live bug.** It sends `X-Radia-Taint: true` (`sdk/py/radia.py`),
  and since the boolean-to-label migration the server refuses that: `clientTaint` splits the header,
  `normalizeTaint` rejects `true` as an unknown label, and the write fails `invalid_taint`. Every
  Python caller raising taint on an artifact gets a 4xx. Python also cannot express `allowTaint`, so
  a Python worker cannot claim a classified record at all.
- **`register_kind` computes a non-normative idempotency key**: `json.dumps(..., sort_keys=True)`
  instead of `kindDefKey` (`sdk/ts/wire.ts`), which `wire.ts` declares NORMATIVE for both sides. A
  kind declared from Python and from TS appends two records instead of deduping.
- **`agent_loop` has no failure-streak suppression or backoff**, while `sdk/README.md` describes
  both under a heading that reads as the loop's behaviour in general.

**Rule.** A NORMATIVE pure function is implemented once per language and pinned by the parity
suite, or it is not normative. **Guard.** `test/py-parity.test.ts` covers `content_key` only; extend
it to `kindDefKey` and to a live `put_artifact` raise against a real space. Both fail today.

### W2. An event written from a read rather than from the write it describes (P1) — FIXED

- **`quarantineLeasesOf` derives its events and its return count from the SELECT, not from the
  guarded UPDATE** (`src/storage/pgbase.ts`, and the sqlite twin). A lease acked between the two
  statements gets a `quarantine` event in the tamper-evident chain for a transition that never
  happened, and the caller is told one more record was quarantined than was.
- **Admin and quarantine events record `runId: "admin"`**, so the acting operator is lost on
  precisely the operations that bypass fencing.

**Rule.** An event describes a write, so it is emitted from the write's own result set, and it names
the principal who caused it. A chain over an event nobody performed protects the wrong fact, which
is the sentence design-auth.md already uses about declassify. **Guard.** A conformance case that
acks one of two held leases inside the quarantine window and asserts one event and a count of one;
and an assertion that no `admin`-operation event carries a literal `"admin"` run.

### W3. Two orderings of "newest" over one append-only log (P2, P1 once a second instance shares a database) — FIXED

`sdk/ts/registry.ts` `newer()` compares `createdAt` first (DB clock) and falls back to id. GC
compaction keeps the FIRST record per key while paging by id (`src/core/gc.ts`), as do credential
resolution and the run fold. On one instance the two agree. Across instances they diverge by the
app-server clock skew, because ids carry the process clock, and the dangerous direction is
compaction: it can delete the record the projection considers newest, which for an authorization
registry is a `retired: true` tombstone or a run's stop successor. That is the resurrection failure
plan-gc.md says compaction exists to prevent.

**Rule.** One definition of newest, used by the projection and by the sweep that deletes on it.
**Fix surface.** Either make the projection id-only (ids are already the tie-break, and the DB clock
buys nothing an id does not) or make compaction order by `createdAt`. The first is cheaper and
removes a clock from the comparison entirely. **Guard.** A conformance case with two records whose
id order and `createdAt` order disagree, asserting the projection's winner survives compaction.

### W4. A bounded read standing in for a population, still (P2) — FIXED

The disease CLAUDE.md names as the most repeated in the codebase, now in the SDK's own grant helper.

- **`RadiaClient.grant()` scans 500 records** to find the retirement anchor a revival must key on
  (`sdk/ts/client.ts`, mirrored in `sdk/py/radia.py`). Past 500 records for one (principal, kind),
  the anchor is missed, the write dedupes against the original, and the call reports success while
  the principal holds nothing. **It fails CLOSED**, so this is a silent no-op rather than the silent
  widening the report implied, and that is the whole difference in severity.
- Smaller instances, same shape: `turn.ts` reconciles over the newest 50 messages globally,
  `forksOf` reads 500 versions, `listSandboxes` reads 200 rows.

**Rule.** `readExhaustively`/`queryAll` semantics, or report `complete: false`; never a plausible prefix.
**Guard.** A case that retires and re-grants past the page size and asserts the principal actually
holds the grant afterwards.

### W5. A check placed before the replay decision (P2) — FIXED

`Space.ack` authorizes the result body (`authorize(owner, "put", result.kind)`) before
`storage.ack` decides whether this is an idempotent replay. A retry of an ack that already succeeded,
arriving after the worker's put grant was narrowed, gets `forbidden` instead of the stored response.
The FOREIGN branch of the same function already does this correctly and says why in its comment
("storage still decides, so a stored response for this key replays instead of being fenced"), which
is what makes this an oversight rather than a decision.

**Rule.** The invariant is not only "idempotency before lease validation" (CLAUDE.md); it is
idempotency before every check that can have changed since the first attempt. **Guard.** Ack, narrow
the grant, retry with the same key, assert the stored response.

### W6. Loops that stop while there is more to do (P2) — FIXED

- **`pollForForeignChanges` reads `getEvents(cursor, 1)`**, so a burst of K foreign-instance events
  takes K polls at 250ms, and each one returns "changed" and fires the kind-blind `notify()` that
  wakes every parked stream. It partially defeats the kind-aware wakeup in the multi-instance case
  the wakeup was built for. Jumping to `latestCursor()` on a hit is the cheap fix.
- **The SSE loop parks on its 15s race after draining a full 200-event batch**
  (`src/server/handlers/watches.ts`), so a watch resuming from an old cursor over an idle space
  crawls through its backlog 200 events per 15 seconds. Loop while the batch is full.

### W7. Contracts nothing checks (P2) — FIXED

The recurrence of closed package P.

- **`explain` is live on the frozen data plane and absent from `openapi/radia.yaml`** (zero
  occurrences). `test/openapi.test.ts` checks paths and methods, which is one level above where this
  sits.
- **The broker's `read_one` returns an ARRAY** (`extensions/ts/broker.ts` wraps it and filters),
  while the SDK call of the same name returns `record | null`. The broker frame format is one of the
  four NORMATIVE extension surfaces and the conformance suite does not pin this.
- **`ENCRYPTED_FIELDS` is a hand-maintained kind-to-field table** (`extensions/ts/encrypted.ts`). A
  new prose-bearing chat kind without an entry ships plaintext, and the fail-closed `enc` marker
  cannot catch it: nothing stamped a marker to refuse. It is the one direction the whole
  fail-closed design is blind to.

**Guard.** BUILT 2026-08-26, the openapi half: `test/openapi.test.ts` now checks request fields in
both directions, comparing each handler's own `rejectUnknown(j, [...])` list against the operation's
`requestBody` properties (resolving `allOf` + `$ref`, since `/records/query` composes `Pattern` that
way and a reader that skips it reports `kind` as undocumented). It found one live defect on its
first working run: `POST /ops/remediate` accepted an undocumented `kinds` alias beside `kind`, which
no client in this repo ever sent, so the alias was REMOVED rather than frozen into the contract.
Package X is the argument for having built it: five of its eight defects were request-field-name
drift, which this catches from the contract side.

`test/agentdocs.test.ts` covers the second gap (nothing checked `agent_docs/`, the files CLAUDE.md
routes every task through): links resolve, backticked source paths exist, and the contract's own
"not implemented yet" paragraph is checked against the paths the same file documents. It found four
stale pointers on its first run, all files that had moved: a bare src/cli.ts (now
`src/surfaces/cli.ts`) and three chat-space paths for what are now `extensions/ts/capability.ts`
and `extensions/ts/model.ts`. Writing this entry tripped the guard again, because naming a dead
path in backticks is indistinguishable from a stale pointer: say the old location in plain text.

The other two guards this package promised were ALREADY BUILT, and an earlier version of this
paragraph called them open. `extensions/conformance/broker.test.ts` pins `read_one` to record-or-null
(the entrypoint reports the SHAPE it was handed, so the assertion is about the frame rather than
about what the query found), and `examples/chat/smoke-encrypt.ts` holds the decided-set check over
`ENCRYPTED_FIELDS`. Both pass.

**That mistake is the third status line in this file to be wrong about its own subject**, after the
OpenAPI refutation above and this sentence. The pattern is always the same: a status claim gets
copied forward without re-deriving it, and the file's own convention (VERIFIED vs REPORTED) exists
precisely because that keeps happening. A "still open" entry needs the same evidence as a finding:
grep for the guard before saying it does not exist.

### Structural debt, not defects

Recorded here because the audit named them and they have no other home; none is a bug.

- **`src/core/space.ts` was 4,044 lines** and held credential lifecycle, authorization and chain
  verification that its own extraction pattern (flows, inspection, artifacts, GC each went out
  through a narrow port) says belong outside. The measurable symptom is orphaned and doubled doc
  comments where a comment now describes the declaration above the one it precedes; two were
  sampled and both confirmed. **PARTLY DONE**: authorization left in `authorization.ts` (515
  lines), and the credential chain on 2026-08-26 in `identity.ts` (1,073 lines: definitions, runs,
  delegation, OIDC), taking the file to 3,036. Both predicted comment defects were in the moved
  region and are fixed. `identity.ts` is the first extracted port that WRITES, which is what a
  credential needs; the discipline moved to what it may not hold, namely a credential cache.
  Chain verification and the sweeps followed on 2026-08-26, into the two modules that already held
  their pure halves: `seal.ts` (+223, `ChainHost` two members wide) and `gc.ts` (+264, the
  amortization counters as a `SweepState` holder). **`src/core/space.ts` is now 2,616 lines**, from
  4,044. What remains is the service proper (put/take/settle, watches, lineage and graph, kinds,
  envelope query) plus the ops-plane verbs, and no further cluster in it has the shape these four
  did: a coherent feature reachable through a narrow port.
- **Core verbs do not authorize themselves.** Enforcement lives in the handlers, and the core's own
  comments record what that produced once. `Space.access` is the seam; any new surface calling
  `Space` directly has to remember to use it.
- **`agent_docs/` was guarded by nothing**, and a prose-only commit runs no tests by design. The
  project's own thesis is that an invariant naming a guard that is not running is worthless, and
  this was its largest unguarded artifact. **DONE**: `test/agentdocs.test.ts` checks the three
  things a machine can (links resolve, named source paths exist modulo `.gitignore`, and the frozen
  contract's own "Not implemented yet" paragraph against the paths it documents), plus CLAUDE.md's
  status marker for a doc against that doc's own `**Status:**` header, which is where three
  PLANNED-for-shipped-work claims were found on 2026-08-26. What stays unguarded is prose status
  outside those two places, which is review's job.

### What each fix was

- **W1**: `kind_def_key` ported to Python from the normative TS function and pinned by a new
  `test/py-parity.test.ts` case (proved red against the old `json.dumps` key); `put_artifact` takes
  LABELS and sends them comma-separated; `sdk/README.md` now says the streak-suppression paragraph
  is TS only.
- **W2**: both dialects derive the events and the count from `UPDATE … RETURNING`, and `stopRun`
  takes `by` so the acting principal reaches the event instead of the literal `"admin"`.
- **W3**: the projection's comparator is exported (`newer` in `sdk/ts/registry.ts`) and compaction
  uses it instead of trusting page order. Guard stages two records whose id order and `created_at`
  order disagree, which needs the ADAPTER because the runtime refuses to stamp them inconsistently.
- **W4**: both SDKs page the revival-anchor scan to exhaustion (`queryAll` / `query_all`).
- **W5**: the result's authorization is handed to storage as a `beforeWrite` thunk, run only when
  the ack is not a replay, and OUTSIDE the transaction so core does not re-enter storage on another
  pooled connection. Each adapter gates it on its own advisory idempotency pre-read.
- **W6**: the foreign-change poll jumps to `latestCursor()` instead of advancing one event per tick;
  the SSE loop continues on a full batch instead of parking on the 15s keepalive.
- **W7**: `explain` documented on the query request and response (its items are STRINGS, which the
  first draft of the spec entry got wrong); the broker's `read_one` returns the record or null like
  every other caller of that name, pinned in `extensions/conformance/broker.test.ts`; and the chat
  smoke now refuses to pass while any kind it declares is neither sealed nor deliberately clear.

The structural debt below is untouched and stays open.

## Package T: module loading escapes the read permission (P1) — CLOSED 2026-08-06

**The defect, measured 2026-08-06.** Inside the `deno-permissions` jail,
`import("file:///anywhere.json", { with: { type: "json" } })` returns the file. It is bounded by
neither `--allow-read` roots nor `--deny-read`, while `Deno.readTextFileSync` on the same path is
correctly refused. Any `.ts`/`.js` module can also be imported, which exposes its exports and RUNS
its top-level code inside the jail.

**Blast radius.** `examples/chat/workers/exec.ts` passes `--deny-dir` for the space's blob KEK and
the operator credential. Both are JSON, so that protection does not hold. Reaching them needs an
absolute path, which is a real obstacle and not a defence: the runner's own tool description hands
the model its read roots verbatim, `.radia/` sits under a project root by convention, and
`Deno.cwd()`, `import.meta.url` and `Deno.execPath()` all work unpermissioned, so jailed code can
locate itself.

**Bounded, deliberately stated.** Non-module text does NOT leak: importing a `.txt` or `.yaml`
fails with "Expected a JavaScript or TypeScript module" and no file contents in the message. So
this reaches JSON and JS/TS, not arbitrary bytes. Distinct error messages do make file EXISTENCE
probeable anywhere, which is an enumeration oracle.

**No flag closes it.** `--allow-import` / `--deny-import` gate remote hosts only (Deno 2.9.2). A
source-level ban on `import` is not a control: dynamic import works from `eval`.

**Not Linux-specific.** Reproduced on macOS 26.4.1 with Deno 2.9.5 (arm64) while verifying the
remedy, so this is the permission model rather than one platform's filesystem.

**What is done.** The record no longer lies: `SandboxSpec.importsConfined` states whether the read
restriction covers module loading (`denoSandbox` false, `bwrapSandbox` true), absent reads as
unconfined, and `probeSandbox` breaks out of any spec CLAIMING confinement it does not have. Two
cases in `extensions/conformance/workspace.test.ts`, both proved against plants; the second plant is
the one that matters, since a probe without a real canary reports `held: true` for a wide-open
jail.

**The fix, SHIPPED 2026-08-06.** A mount namespace closes it, because an unbound path does not
exist to open. A filesystem-only confiner sits under the unchanged permission jail: bubblewrap on
Linux (`bwrapSandbox`, `extensions/ts/sandbox.ts`) and `sandbox-exec` on macOS, both measured, with
`defaultConfiner` choosing per platform and `probeSandbox` deciding at boot whether it actually
holds. `examples/chat/workers/exec.ts`, the blast radius named above, applies it. The measurements
and the per-platform story are in
[architecture-jail-confinement.md](architecture-jail-confinement.md). One finding there needed no
jail and closed the same day: the jail honoured a `deno.json` written into the model's own
workspace, and now runs with `--no-config --no-lock --no-npm`.

**Why this was never as large as it reads, and the reason to read `SandboxSpec` before the CVE.**
The Deno jail is ONE BACKEND, not the isolation mechanism. A sandbox is a record
([design-execution.md](design-execution.md)), so confinement is a PROPERTY ON THE RECORD
(`importsConfined`) rather than a language's name, and a grant binds that property. Building
another jail is a record plus a probe, which is why the remedy took one day: nothing above the
backend had to change, and `sandbox-web.ts` later added a fourth backend on the same seam without
touching this one.

**Scope: no supported platform is affected.** Native Windows has no confiner and says so, and
native Windows is NOT SUPPORTED (README; WSL2 reports `linux` and takes the bubblewrap branch with
no code added, though that path is unverified in CI). An unsupported platform cannot hold a package
open, so this closes rather than staying open against a target the project does not ship for.

Do NOT reach for the obvious cheap mitigation. The vector is decided by file EXTENSION, so renaming
this space's secrets off `.json` looks like a free fix; it was proposed, and rejected, because the
protection is Deno's file-type heuristic rather than a boundary, nothing here could detect it
changing, and the compatibility shim across the CLI, the MCP adapter and the Python SDK would
outlive the problem. See phase 2 of the plan.

---

**Downstream dependencies, now satisfied.** Both gates on
[plan-inspection.md](plan-inspection.md) are cleared: B gave the inspection backlog a scoped-read
path to build on (every new view must route through `readAccess` and add a row to the guard
table), and D made a churning registry (the interest registry, saved lenses) safe to write.

---

## Package E: pushdown soundness (P1) — CLOSED 2026-08-03

**VERIFIED.** Four findings (the three recorded on 2026-07-27 plus the shared-path extension found
in round two), all of them one question: what does a path SEGMENT address? The oracle answered with
JavaScript property access, the two dialects each answered with their own JSON path grammar, and
the pre-filter excluded records the oracle accepts, which is the one direction
`src/storage/pushdown.ts` may never take.

Closed at two roots rather than per dialect:

- **`pushablePath` declines all-digit segments** (`src/storage/pushdown.ts`). That single rule
  covers the SQLite `$.a.0` case (a key lookup, NULL over an array), the Postgres `@>` containment
  term (`{"items":{"0":v}}` is not what an array contains), and the leading-zero over-inclusion
  (`{a,00}` subscripts to element 0 while the oracle finds no such property) — the last of which
  mattered because the node was marked `exact`, so the caller's LIMIT rode into SQL under a filter
  that over-includes. The oracle handles every path, so the cost is a lost pre-filter on a shape no
  kind here declares.
- **`getPath` resolves own properties only** (`src/core/matching.ts`), and an array only by a
  canonical index (`0`, never `00` or `length`). The prototype half of the finding is the opposite
  direction from the rest: SQL was right and the ORACLE was inventing values, so narrowing the
  oracle is the root fix rather than teaching SQL about the prototype chain. A body that genuinely
  carries a key named `length` or `constructor` is data and still routes.

Not done: nothing needed dropping `exact`, because both shapes that could not honor it are no
longer pushed at all. `PgSqlAdapter.prepareKind` now calls `pushablePath` instead of carrying a
copy of the alphabet rule, which is what let the statistics expression and the pushed predicate
drift apart in the first place.

Guard in `test/conformance/suites/pushdown.ts`: a differential case running each pattern through the
adapter AND through the bare oracle over one fixture corpus (array indexes, digit keys, leading
zeros, prototype-shaped names, and real keys that happen to use those names), asserting identical
result sets plus an explicit expected set so both halves cannot break together; and a second case
pinning that an array-index pattern still fills a limited page and still finds work through `take`,
which is the headline symptom (a space reported empty while holding ten matching records).

## Package G: blob write durability (P2) — CLOSED 2026-08-03

**VERIFIED.** `FileBlobStore` (`src/storage/blobs.ts`) wrote payloads non-atomically and deduped on
file EXISTENCE. A crash mid-write left a truncated file at the final content address, and every
later `put` of those bytes saw a file there and skipped the write, so the store never healed.
Unencrypted `get` streamed the corrupt prefix with no digest verification; encrypted failed GCM
forever. The encrypted path was no safer than the plaintext one, only louder: the "an interrupted
write leaves a key with no payload, self-healing on the next put" comment held for a payload write
that produced NO file, not for one that produced a short file.

Two changes, because atomicity alone does not satisfy the guard:

- **`writeAtomic`** (temp name plus `renameFile`, new in `src/platform.ts`) so a crash leaves the
  address absent rather than short. The temp name carries a random suffix so concurrent puts of the
  same payload cannot land on each other's partial file.
- **Length-validated dedup.** `put` compares `fileSize(path)` against the expected on-disk length
  (plaintext bytes, plus `GCM_TAG_BYTES` when sealed) instead of testing existence. This is what
  repairs damage that already exists — from before this fix, or from anything outside the process —
  because the only party who can repair a content-addressed object is the caller holding those
  exact bytes, and that caller was the one being told to skip. Length rather than digest: the
  expected value is already in hand, so it costs a `stat` rather than re-hashing every put.

Not done, deliberately: `get` still does not re-hash a plaintext blob. It would cost a full pass
and force the object into memory, which is what streaming exists to avoid, and it defends only
against same-length corruption that no longer has a path in from a crash. The overstated
"self-verifying" claim in the module header is corrected rather than implemented.

Guard: `test/conformance/suites/blobs.ts`, "a truncated payload heals on re-put", over both the sealed
and plaintext regimes. Verified to fail against the old existence-only dedup.

## Package H: `lease_lost` is unobservable in clients (P2) — CLOSED 2026-08-04

`renew` reports fencing as a **200 body**, not an error, and every heartbeat discarded the
result: `src/surfaces/mcp/server.ts` (`.catch(() => {})` on an interval that only `takeClaim` cleared),
`sdk/ts/loop.ts`, `sdk/py/radia.py`. So a quarantined or reclaimed run kept renewing a dead
lease for the process lifetime and its handler kept producing side effects. The design contract
"a fenced worker runs until it observes `lease_lost`" was unmeetable through the SDKs: the only
observation point was the final ack, after the work was done.

All three heartbeats now act on the verdict, and the cancellation channel is part of the handler
contract: TS passes an `AbortSignal` as a third argument, Python a `threading.Event` as a third
parameter (given only to a handler whose signature declares it, checked once with `inspect`, so
existing two-parameter handlers are untouched). Neither loop settles a claim it knows it lost:
an ack would only be answered `lease_lost`, and a nack risks bumping the attempt count of whoever
holds the record now. The MCP adapter keeps the lost claim in its map so settling by `claimId`
explains what happened instead of answering "unknown claimId", which reads like the model's own
mistake rather than the space taking the work back.

**Two outcomes are authoritative, not one.** `{status: "lease_lost"}` is the fence, and 401/403 is
the other half: quarantining a run kills its TOKEN first, so its heartbeat never reaches
`lease_lost` at all. Handling only the documented case would have left the package's own guard
("a quarantined run's heartbeat stops") failing. Everything else stays ignored — a network blip or
a 5xx is not a fence, and the lease has until its expiry.

Fixed alongside, because the guard found it: a stopped run's watchers retried a 401 connect every
second forever (only 403 was treated as permanent), and `agentLoop` awaits its watchers on the way
out, so the loop could never finish. They now run on the credential's signal rather than the
caller's.

Guard: `test/loop.test.ts`, two cases (a reclaimed lease, and a quarantined run) asserting
the handler observes cancellation rather than waiting out a 20s failsafe, that nothing is settled
on a lease that was lost, and that the loop stops claiming once its credential is dead. Verified to
fail against the old discard-the-result heartbeat: both cases sat on the failsafe. This is the one
test in `test/` that binds a real port, because the SDK client and its SSE watchers are what
is under test, and a stubbed `fetch` would only test a mock's idea of streaming and cancellation.

## Package I: SDK drift and the chat example (P2) — CLOSED 2026-08-04

**Parity is no longer the goal.** Python is frozen to the core coordination surface and TS carries
the full one; [sdk/README.md](../sdk/README.md) states the policy. What was here were defects, not
gaps, and all five are closed:

- **The TS `watch()` omitted `Authorization` on the SSE connect** (a raw `fetch`, so it inherited
  nothing from `req`), so under `--auth required` every connect 401'd and `agentLoop` degraded to
  poll-only — slow rather than broken, which is why it survived. Python always sent it.
- **Neither SDK re-created a watch after a server restart.** Watches are in-memory, so a restart
  404s every id permanently, and both treated it as transient and retried the dead id forever. Both
  re-create on a 404 now; events during the gap are missed by construction, which is what the poll
  fallback is for.
- **Python `get_children` took no paging arguments** despite the endpoint being paged (so a caller
  silently saw the first page of a fan-out), and **`query_page` dropped `scope`**, leaving a scoped
  caller unable to tell its slice from the whole space. `get_children(limit, after)` plus
  `get_children_page`, and `query_page` returns `(records, next_after, scope)`.
- **Python `agent_loop` had no run-token renewal** (the round-two finding), so a Python worker
  stopped claiming at ~15 minutes and said nothing. `RadiaClient.renew_run` + `keep_alive(stop,
  on_lost)` renews at half-life in a daemon thread, mirroring TS `keepAlive`, and `agent_loop`
  starts it.
- **The chat's escalation ladder read `model` records raw**, so a gracefully stopped tier stayed a
  valid escalation target and escalating to it hung until the deadline. The projection is now a
  shared `liveModels` (`extensions/ts/model.ts`) that the router, the ladder and the fleet
  smoke all call — three copies of it existed, and the smoke's own copy meant that suite could only
  ever prove its own loop right.

Guards: two cases in `test/loop.test.ts` (a watch under `--auth required` delivers a wakeup;
a 404'd watch is re-created under a NEW id rather than retried), both verified to fail against the
old client — the first with the 401 problem document in the assertion message. Three cases in
`examples/chat/smoke-fleet.ts` pin the ladder against a retired tier, and that file now drives the
shared projection instead of a copy. Python has no harness in this repo; `renew_run`/`keep_alive`
and the paging changes were exercised directly against a stub client.

---

# Round two (2026-08-03)

Three of this round's findings were already open packages, independently re-found: blob write
atomicity (**G**), `lease_lost` unobservable through heartbeats (**H**), and Python SDK loop parity
— specifically that `agent_loop` has no run-token renewal, so a Python worker silently stops
claiming at ~15 minutes (**I**). Being re-found by a fresh reader is evidence about their severity,
not new work; close them where they are.

## Package K: definition tokens cannot be revoked (P0) — CLOSED 2026-08-03

**Done.** `Space.revokeDefinition`, `POST /v0/agent-definitions/{agent}/revoke` (operator only),
`radia revoke <principal>`, both SDKs, and a privileged-subject refusal at mint time. Three
conformance cases in `suites/auth.ts`. The lesson is in [gotchas.md](gotchas.md).

**VERIFIED.** `Space.resolveCredential` (`src/core/space.ts`) reads `agent_run` and checks BOTH
`status === "stopped"` and `expiresAt`; it then falls through to `newestByHash(AGENT_DEFINITION, …)`
and returns `{ok: true, kind: "def"}` on the mere existence of the record. No status, no expiry, no
retirement path exists for `agent_definition` at all. A leaked definition token mints fresh run
tokens forever, and `createAgentDefinition` accepts any subject — including an operator name —
so the worst case is an irrevocable privileged minting credential.

This contradicts the project's own argument for reading credentials from records per request
("credentials resolve from records, so a revocation is immediate"): it is immediate for every
credential except the one that never expires.

Fix: give `agent_definition` the same shape `agent_run` has — a `status`/`retired` successor and a
check beside the existing one. The asymmetry is two adjacent branches in one function.

Guard: three conformance cases, written against the run-stop case so the two cannot drift apart —
the token stops minting everywhere (revoked from a Space that never minted it, like the run-stop
case), running work is untouched and still separately stoppable, and a definition naming a
privileged principal is refused while an ordinary `human:` one is not.

## Package R: a dead taint parameter, and a guard that tests one leg (P2) — CLOSED 2026-08-04

**Two of the three were already fixed when this was re-checked**, in `87e4077` on 2026-08-03 — the
same day the entry was written — and the plan simply never caught up. Re-derived rather than
assumed: the dead ternary is gone from `exec.ts`, `captureWorkspace` takes no `taint` option (its
doc names the ternary as the reason), `commitWorkspace` keeps one narrowed to "A RAISE, never
inheritance", and `extensions/conformance/` carries "labels survive the RETURN trip, which is the
leg the name promised" — asserting the successor manifest inherits, a record naming it inherits, the
written-back file artifacts are bare, and an untouched file still points at the raised original.
Both label cases pass.

**What was left is the third bullet**, the standing one: the carrier depends on every derived record
naming the manifest, and `exec.ts` doing so was asserted nowhere — the round-trip case simulates the
result record rather than driving the worker. Now guarded end to end in
`examples/chat/smoke-runners.ts`: a workspace raised with `net`, run through the REAL exec worker via
a `tool_call`, and the `tool_result` must carry `net`. The label matters — any workspace run also
picks up `file` from its read roots, so asserting that would pass whether or not the edge exists,
while `net` can only have arrived along the manifest edge. It sits in the js-only path, so it runs
where `bwrap` does not. Verified by dropping `wsParent` from the result's `parentIds`:
`FAIL … labels=["foreign"]`.

**Downgraded twice while being written, which is the part worth recording.** It was filed as
"write-back launders classification labels (P1)" on the strength of
`captureWorkspace(c, wsManifest, wsRoot, { taint: b.owner ? undefined : undefined })` in
`examples/chat/workers/exec.ts` — a ternary whose branches are identical. Checking the propagation
path found the successor manifest carries `parentIds: [manifest.id]` and the run's result carries
`parentIds: [..., wsParent]`, so `Space.computeTaint` unions the predecessor's labels into both with
no explicit taint anywhere. Nothing launders. The claim went from "carries no labels at all" to
"artifacts only" to "correct by design".

What remains, after the 2026-08-03 decision that the union is the semantics and the MANIFEST is the
carrier (see [plan-workspaces.md](plan-workspaces.md) §10.0):

- The dead ternary should go, and `captureWorkspace` should not take a `taint` option at all — file
  artifacts are bare by decision, so the parameter implies a mechanism that is not the mechanism.
  `commitWorkspace` keeps one, narrowed to a monotone RAISE rather than inheritance.
- The conformance case "a classified tree does not launder its labels through the filesystem" covers
  `materialize` and not the return trip, so it is named for a round trip and tests the outbound leg.
- The carrier depends on every derived record naming the manifest. `exec.ts` does; a future path
  that forgets loses the labels silently, which is the documented parent-edge hole landing somewhere
  specific enough to test.

Guard: materialise a labelled tree, change it through a real run, assert the successor manifest AND
the tool_result still carry the label.

## Package L: watch streams cache authorization for their lifetime (P1) — CLOSED 2026-08-03

**VERIFIED, and wider than reported.** `authorizeWatch` ran once, in `handleCreateWatch`, and the
compiled scope was stored on the `Watch` for its lifetime. Two holes, not one:

1. The live stream never re-checked, so a stopped run or a revoked grant kept receiving wakeups
   until the client happened to disconnect.
2. **Re-attaching never re-checked either.** `getWatch` tests OWNERSHIP, which passes for the
   creator forever, so a client that reconnected with `Last-Event-ID` after its grant was revoked
   got the stream back. Reconnection restored an authority that revocation had removed.

The second is the worse half and was not in the original report: the first is a window that closes
when the connection drops, the second is a window the client can reopen at will.

Fixed:

- `Space.scopeWatch` is now the ONE derivation of a watch's scope, called by `createWatch` and by
  the new `Space.revalidateWatch`. The handler used to do the authorize-and-combine itself, which
  would have meant two implementations of the same policy the moment re-derivation existed.
- `Watch.request` keeps the client's ORIGINAL pattern. Re-deriving recombines that with a fresh
  grant set; recombining the already-narrowed match would ratchet the scope tighter on every check
  and never widen back. There is a planted-bug-verified guard for exactly this.
- `handleWatchEvents` re-authorizes on attach (403, since the caller owns the watch and 404 would
  be a lie) and re-derives inside the loop.
- The trigger is the EVENT LOG, not a timer: authorization state is records, so the log the loop
  already reads carries every change that could revoke the stream (`AUTHORIZATION_KINDS`, derived
  from `WRITE_PROTECTED_KINDS` so it cannot be too small without that one being wrong first). The
  re-check runs BEFORE the events that follow it in the same batch, so a revocation and a matching
  record arriving together do not deliver the record. A 30s interval remains as a backstop.
- Credential liveness re-resolves through `resolveAuth`, passed in as a closure, so there is no
  second implementation of "is this token still good".
- Both SDKs now treat revocation as terminal: a `revoked` SSE frame (control, never a wakeup) and a
  401/403 on reconnect both raise. Previously the TS client's reconnect loop turned a revocation
  into a silent 3/s spin, which reads exactly like an idle space.

Guards: `test/conformance/suites/watches.ts` (revoked grant ends a live watch; a narrowed grant narrows
it and does not ratchet).

Left open deliberately: a watch lives in a per-process `Map`, so multi-instance revocation latency
is whatever package O ends up being. Within one process it is now immediate.

## Package M: `kind_def` is not write-protected (P1) — CLOSED 2026-08-03

**VERIFIED.** `WRITE_PROTECTED_KINDS` (`src/core/kinds.ts`) is
`{GRANT, SIGNAL, AGENT_DEFINITION, AGENT_RUN, SHRED}` — `KIND_DEF` is absent. So any principal
holding an ordinary `put: kind_def` grant could redeclare a reserved kind and drop the indexed paths
that `authorize` and credential resolution compile against, producing `undeclared_path` on every
authorization and persisting across restarts through `loadKinds`.

This sharpened the "Deferred: low severity" entry below, which recorded that reserved kinds *other
than* `kind_def` can be redeclared. The vector is what changed: not an operator mistake but an
ordinary grant, which moved it out of the deferred batch.

Fixed the narrow way rather than by protecting the kind. `KIND_DEF` stays writable, because
declaring kinds is a thing an app legitimately does with an ordinary grant; what is refused is the
SHRINK. `assertReservedCompatible` (`src/core/kinds.ts`) rejects a redeclaration of a `META_RESERVED`
kind that drops one of the code-defined indexed paths or changes `claimable`; extending one (the
chat adds `conversationId` to `artifact`) stays legal. Principal-independent, so the operator is
bound by it too: nobody has a reason to remove `grant.principal`.

Three entry points, not one. `Space.put` and `Space.ack` now share `validateReservedBody`, closing
the second write path (an `ack` result skipped the `kind_def` checks entirely, and a valid one was
never adopted into the writing process's registry). `loadKinds` validates instead of casting, so a
declaration written before this rule cannot reinstate itself at startup. The write-path check alone
would have left the damage in place across every reboot.

Guards in `test/conformance/suites/kinds.ts`: a `put: kind_def` grant that authorizes but cannot shrink
`grant`; the same body refused through `ack`, with a valid one adopted and surviving a restart; and
a shrunken declaration planted directly through the adapter that startup declines to adopt.

## Package N: `clientMeta` escapes the body guards (P2) — CLOSED 2026-08-04

**VERIFIED.** `src/core/record.ts` applied the NUL check and the `maxRecordBytes` limit to
`bodyJson`/`bodyBytes` only; `clientMeta` was client-supplied, assigned unguarded, persisted, and
returned on every read. The file's own argument for the size limit — an unbounded body is
unerasable data entering the space, because a body has no erasure path — applied to it verbatim, so
the limit was walked past by moving the payload one field sideways.

Both checks now cover it, and the size one shares ONE budget (`bodyBytes + metaBytes`) rather than
giving each field its own: two independent limits are a limit on neither, since the same payload
passes by being split. What the erasure promise bounds is how much unerasable data a record carries,
which is their sum, and the error names the split so a caller can see which half is the problem.

The NUL check is the honest half of the fix. A body's reason is storage — `body_jsonb` cannot hold
U+0000 and the write fails from inside the driver — but `client_meta` is plain text in both
dialects, so that argument is the body's, not its. It is refused for the boundary's own sake: a
caller cannot see why the neighbouring JSON field would accept what this one rejects, the value
lands in the same documents every reader parses, and the day `client_meta` becomes queryable it
would already hold data the column cannot take. The comment says so rather than implying a storage
failure that does not exist today.

Guard: `test/conformance/suites/records.ts`, "clientMeta is guarded exactly like a body, and counts
against the same budget" — an oversized `clientMeta`, a body and a `clientMeta` that each fit but
together do not, a NUL in either, and the literal six-character text that SPELLS the escape still
storable. Verified to fail against the body-only checks.

## Package O: multi-instance freshness and ordering (P1) — CLOSED 2026-08-03

Two gaps remain now that the kind registry refreshes itself
(`Space.compileFresh`, closed 2026-08-03):

- **Cross-instance watch wakeups did not happen.** `src/core/notifier.ts` was an in-process waiter
  list and no `LISTEN`/`NOTIFY` code existed in `src/`. Self-healing (the event log is truth, poll
  catches up), so nothing was lost — but every cross-instance hop degraded to the caller's
  keepalive, 15s in the SSE loop, which is felt per turn in an interactive agent session. This is
  the dimension that actually regresses with N>1; throughput is not.
- **ULID monotonicity is per-process.** Latest-wins registries decided "newer" by comparing ids,
  and across instances a ULID's timestamp is the writing PROCESS's clock. Grants live in those
  registries, so the bad outcome is auth-relevant.

**CLOSED 2026-08-03**, both, and the second one narrower than it was stated.

The wakeup is a POLL OF THE EVENT LOG driven by the waiter, not `LISTEN`/`NOTIFY`: the Postgres
driver this build uses (deno-postgres 0.19) exposes no asynchronous notification API at all, which
was checked rather than assumed. `Notifier` takes an optional `poll` and runs it every
`CHANGE_POLL_MS` (250ms) **only while somebody is waiting**, so an idle space holds no timer and
issues no queries, and a busy one costs one query per interval per SPACE however many streams are
open. `Space.pollForForeignChanges` reads a single event after its cursor; the first poll of a
space's life reports a change unconditionally, because a record written before it took a baseline
would otherwise be the one wakeup the mechanism exists to deliver. Two properties fell out: a
timed-out waiter now removes itself (the deferred "Notifier waiters accumulate" item below is
closed with it), and the poll's failures never reach the stream.

Ordering is now the DB-assigned `created_at`, with the id as the tie-break (`newer`, in
`sdk/ts/registry.ts`, mirrored in the Python SDK's `list_kinds`). What that fixes is CLOCK SKEW,
which is the unbounded part: two instances a second apart ordered a second of writes backwards, so
a revocation could lose to the grant it revoked. What it does not fix is commit order — `created_at`
is read before the transaction commits, so two instances writing one key inside a single DB
millisecond remain a tie broken by id. Closing that needs the `xid8` + watermark machinery the
event cursor already uses, carried on the record and therefore through the frozen wire contract;
not done, and the residual race is one millisecond wide instead of one clock-skew wide.

Guards: `suites/watches.ts` runs two Space objects over one database and asserts the watch wakes
from the other's write rather than its keepalive (verified to fail at 19.2s with the poll removed);
`test/notifier.test.ts` pins the waiter/poll state machine (no polling while idle, no
wakeup without a change, a failing poll never reaching the stream, waiters not accumulating); and
`registry.test.ts` pins the skewed-clock revocation, in both arrival orders and in the revive
direction, plus the same-millisecond tie still following the ids.

## Package P: contracts nothing checks (P2) — CLOSED 2026-08-04

Both halves closed, and the first one immediately earned its place.

**`openapi/radia.yaml` is verified against the implementation** by `test/openapi.test.ts`,
in both directions, because they fail differently: a documented path that is not routed is a
promise to a client that 404s, and a routed path that is not documented is surface nobody agreed to
freeze. The estimate in this entry ("a route-table-vs-spec-paths test is roughly thirty lines") was
wrong about the shape, though not the size: the router has no TABLE to diff — 21 literal `case`
labels plus ten `startsWith` families — so direction 1 is BEHAVIOURAL, driving every documented
operation through the handler and asserting the answer is not "no route for …". A 400 or a
not-found for the id passes; the question is whether the path is recognised. Direction 2 is
structural over the `/v0` literals in `http.ts`.

**It found two undocumented endpoints on the first run:** `POST /v0/capabilities` (mint a
capability over a SET of artifacts by path) and `GET /v0/w/{capability}/{path}` (serve one file
from it) — the machinery workspaces are served through, public, unmentioned by the contract. Both
are now in the spec, marked `x-stability: experimental`. Two smaller lessons are in the test:
capability URLs are served by the ARTIFACT origin, so an operation counts as routed if either
handler answers, and the switch labels carry the method inside the string (`"GET /v0/health"`), so
a naive `/v0/…` regex matched nine of twenty-five literals and would have passed while checking
almost nothing. Both directions were verified to fail on a planted violation.

**The first CI run paid for itself**, which is the argument for the whole package: `deno task
extensions` passed on every machine here and failed on a runner, for two environment assumptions
nobody had tested. `runCode` spawned `deno` BY NAME against the `PATH` the jail invents for its
child, so it could not find the runtime wherever Deno is not in `/usr/bin` (it uses
`Deno.execPath()` now, which is also the stronger rule: a jail must not resolve its interpreter
through a search path). And the bubblewrap cases failed rather than skipped where `bwrap` is absent,
though the design treats that backend as optional; they skip now, on a FUNCTIONAL check (running a
trivial program through the real jail — `bwrap --version` proves only that a binary exists).

Measured after that: **a hosted runner cannot run this jail at all.** On `ubuntu-latest` the package
installs, the user namespace is created, and `--unshare-all` dies with `loopback: Failed RTM_NEWADDR:
Operation not permitted`, because Ubuntu's AppArmor profile grants the namespace and withholds the
capability to configure `lo` inside it. Asserting the capability, as this workflow first did, turned
a skip into a red build over an environment nobody chose. CI now attempts the documented sysctl
relaxation, never fails on it, and PRINTS whether bubblewrap coverage is ON or OFF — the fix for a
silent skip is a loud skip. Real coverage for that backend needs a machine with unprivileged user
namespaces.

**The live-Postgres run is in CI** (`.github/workflows/ci.yml`), in a `postgres` job with a service
container, beside an `embedded` job that runs check + conformance + extensions. This is the invariant
CLAUDE.md already asserted ("every implementation of every port … in CI from day one") while the pg
run was manual — an invariant that names a guard which is not running, which is the loudest kind of
drift. The repo had no CI at all, so this is the first workflow. Verified locally with the exact
command the job runs: **634 passed, 0 failed** (458 embedded + 176 postgres).

## Package Q: designed features unreachable (P2) — CLOSED 2026-08-04

Each of these was BUILT and could not be invoked, which is a distinct failure from a bug: the code
is correct and the path to it is missing, so tests of the unit pass while nothing exercises the
design. Every guard drives the OUTERMOST surface for that reason (`test/http.test.ts`), and
all three were verified to fail against the old behaviour.

- **Per-label declassify, reachable.** `Space.declassify` has always taken `{labels}` and the SPEC
  already described the behaviour ("the named labels removed… the response and the event both
  record which were `cleared` and which `remaining`"); the handler ignored the request body and
  cleared everything, and returned an id alone. So the documented feature had no caller and the
  answer could not say what a clearance was FOR — the exact weakness per-label exists to remove.
  The handler parses `{labels}`, reports `cleared`/`remaining`, 400s an unrecognized label rather
  than 500ing from inside the core, and an absent body still means "all of them". Both SDKs take an
  optional `labels`, and the spec gained the `requestBody` it was describing without documenting.
- **`scope: {leaseOwner: "self"}` REFUSED rather than enforced,** which is a scope call worth
  stating. It validated and narrowed nothing: `authorScope` restricts only when every applicable
  grant says `createdBy: "self"`, so a grant carrying `leaseOwner` alone read as UNRESTRICTED — an
  operator wrote a narrowing scope, got no narrowing, silently, in the widening direction.
  Enforcing it is not a line but a feature: an envelope-side filter on `lease_owner` in every read
  verb, which means the storage port, since a `query` reads `records` and would have to join
  `record_runtime`. Inventing that semantics for take/lineage/graph on the way past is how a
  "reachability fix" becomes an unreviewed feature, so the key is refused at grant-write time until
  it is built. `design-auth.md`'s selector table keeps it, marked not-built.
- **Pattern-scoped artifact `put` grants on an app field, satisfiable.** The grant check ran against
  `{mediaType}` alone, BEFORE `x-radia-meta` was parsed, so a grant scoped to an app field — the
  shape the chat uses for `conversationId` — matched a body that structurally could not carry the
  field, and every write 403'd. The parse moved above the check, which now matches everything
  knowable before the payload, composed in `putArtifact`'s order (app fields first, the runtime's
  own last and unforgeable). A pattern naming `digest` or `size` still cannot be satisfied and
  deliberately: those are unknown until the bytes are read, and buffering 32 MiB to answer an
  authorization question is a free denial of service. Said in the comment rather than left as the
  next instance of this bug class.

## Package S: the round-two reports, re-derived (2026-08-04)

All twelve were checked against source, and eleven reproduce; nothing was cleared, and all twelve
are now **CLOSED**. Ranked below by whether a caller could reach them, which is also the order they
were fixed in. Two of the pooled-Postgres races ship without a test that fails today — stated in
their section, not buried — because staging them needs concurrent connections the embedded adapters
cannot provide.

**Reachable from the wire — CLOSED 2026-08-04:**

- **`{"$or": []}` is a 500.** VERIFIED empirically on both adapters: `near ")": syntax error`, from
  a well-formed request any caller with a `query` grant can send. `compileObject` builds
  `{t:"or", nodes:[]}` and pushdown renders `()`. `{"$and": []}` is fine (it matches everything).
  **Fixed in the RENDERER, not at compile**: the oracle was always right (`[].some()` is false), so
  an empty disjunction renders `SQL_FALSE` and stays `exact` — both sides now say "matches
  nothing". Refusing the pattern instead would have been a new error class for a query whose
  meaning was never in doubt. Guard: `suites/pushdown.ts`, including the nested case.
- **`ownerGuard` turns a SUCCEEDED settle's retry into `lease_lost`,** and its own docstring claims
  the opposite ("No succeeded op can be turned into a false `lease_lost`"). VERIFIED empirically:
  A nacks with an idempotency key and the response is lost; B claims the record; A retries the same
  key and is told `lease_lost` rather than replaying `ok`. The docstring's argument covers only
  "`lease_owner` is not cleared on settle" and misses REASSIGNMENT. It is also a breach of the
  named CLAUDE.md invariant, since `ownerGuard` runs ahead of storage's idempotency check —
  the exact ordering that invariant exists to forbid. **Fixed by moving the check into the
  adapter**, on `LeaseRef.expectOwner`: it now runs inside the settle's transaction, after
  `withIdem` has replayed any stored response, so a legitimate retry replays and a stranger still
  meets an opaque `lease_lost`. `renew`/`nack`/`release` no longer pre-read the envelope at all
  (one read saved on each); `ack` still reads it, because it needs the authoritative owner to
  authorize the emitted result — but on a mismatch it now skips building and authorizing that
  result, which would otherwise have been authorized as the OWNER and could tell a stranger what
  that principal may write. The diagnostic warn survives on the failure path (`explainLeaseLost`).
  Guard: `suites/auth.ts`, "the owner check runs BEHIND idempotency", asserting both halves — the
  replay, and that a stranger with no stored response is still fenced.

**Pooled Postgres only, invisible to the embedded suites — ALL CLOSED 2026-08-04.** Two of the three
are races no single-connection adapter can stage, so they ship as code with no test that fails
today: the embedded suites serialize, and forcing the interleaving needs the fault matrix
([plan-validation.md](plan-validation.md)) driving concurrent connections. That is the same standing
the guarded-UPDATE fix has, and it is stated rather than dressed up. What IS pinned is that both
adapters still agree: the full suite is green embedded and against a live Postgres.

- **The available-branch claim CAS guarded neither `available_at` nor `lease_epoch`**
  (`where record_id=? and state='available'`; the expired branch did check the epoch). It does NOT
  reproduce single-connection — a nack with a 3600s backoff is respected by pattern-take and
  take-by-id on both embedded adapters, so the report's flat wording overstated it. The race is a
  concurrent take+nack-with-backoff between the candidate read and the CAS, which claims inside the
  backoff AND writes a stale epoch over a live fence. **The guard now names everything the read
  relied on**: state, `available_at <= now`, and the epoch the candidate was read at (null-safe, for
  a record never leased). Both adapters, because a claim rule they disagree about is one the
  conformance suite cannot test. Guard: `test/concurrency.test.ts`, "a claim never lands
  inside another worker's nack backoff" (Postgres only; failed on every planted pre-fix run).
- **Offset-based candidate paging could report a spurious empty.** An offset assumes the rows before
  the cursor stay put, and in a queue those are exactly the rows other claimers are removing: each
  departure shifts the rest forward and the next window skips them, so `take` answers "nothing
  claimable" while work sits in the kind. **Both adapters page by KEYSET now**, on the claim order's
  own key (`ClaimCursor` in `src/core/take.ts`, shared so the two cannot drift). The cursor is
  mixed-direction — priority descends, the other two ascend — so it is spelled out rather than
  written as a row comparison, and it must stay identical to `CLAIM_ORDER`. This also closes the
  deferred-list entry that recorded the same defect. Guard: `test/concurrency.test.ts`, "a
  claim never steps over a record in a shifting candidate window" (Postgres only; failed on six of
  seven planted pre-fix runs). The detector is ORDER, not an empty answer: a single claimer must be
  served matches in claim order, so a later one arriving first proves the scan skipped one, and that
  gives a trial per take instead of one per run.
- **`stopRun` quarantined BEFORE writing the stop record**, so the token kept resolving while the
  run's leases were force-released: it could claim fresh work during its own revocation, and a throw
  between the two never closed the window. **The stop record is written first.** The partial failure
  is now the safe one — token dead, leases lapsing on their own clocks, which is exactly a graceful
  stop. Guard: `suites/auth.ts`, "a quarantine kills the TOKEN before the leases".

**Real but quiet — CLOSED 2026-08-04:**

- **`readAccess` cost four storage reads per coordination verb — now two.** Measured by
  instrumenting the adapter, before and after: `grant` was read three times (`authorize`,
  `authorScope`, `taintBarrier`) plus one `agent_run` for the self scope; it is one `grant` read
  plus the `agent_run` now. The three rules moved into pure helpers over an already-read set
  (`constraintFrom`, `selfScoped`, `barrierFrom`), so the public methods keep working for their own
  callers and the rules themselves are unchanged.
- **`authorize` discarded `complete`.** Five of the eight grant-registry call sites took `.entries`
  and never looked. Truncation needs >20,000 grant records for one (principal, kind) and is
  fail-CLOSED in both directions (reads are newest-first, so a retirement is inside the window while
  what it retires may not be, and the entry drops out either way), so the cost is silence rather
  than misauthorization — which is why `readAccess` now WARNS with the scanned count rather than
  throwing. A denial computed from part of a principal's grants should say so; turning it into a 500
  for the pathological case would be a worse trade.
- **`parseTaintAllowlist` admitted the reserved `unknown` label — CLOSED 2026-08-04.** VERIFIED:
  it returned `["unknown"]`, so a grant could allow exactly the label `TAINT_UNKNOWN`'s own comment
  says "no allowlist may contain", admitting every pre-labels record the marker holds back.
  `normalizeTaint` refuses it now, with `{reserved: true}` for the two server paths that
  legitimately handle it (a legacy record's stored labels travelling back out, and an operator
  declassifying the marker — refusing that would leave such a record permanently unclaimable by
  anything stating a barrier, with no remedy).

  **Refused in the WIDENING direction only**, which the suite forced into the open: the existing
  "claimable by nothing that states a barrier" case seeds its legacy row by RAISING `unknown`, and
  a blanket refusal broke it. That is the taint model's own asymmetry — raising is monotone, so a
  client marking its own record unclassifiable only narrows who will claim it, while an allowlist
  widens. `clientTaint` takes the same flag, so the two boundary raises (`put`, artifact header)
  permit it and `take {allowTaint}` does not.

  Fixed the third path too, though nothing reported it: `Space.take` validated no allowlist at all,
  so the check existed only at the HTTP boundary and an SDK/MCP/in-process caller walked past it.
  It normalizes now, the same reason `compilePattern` validates its own input. Guard:
  `suites/taint.ts`, "no allowlist may name the reserved label, though a raise still may" —
  verified to fail with the check disabled.

**Doc/comment batch — all four confirmed, all four CLOSED 2026-08-04:**

- `handleTake` said the grant barrier is "ORed with the caller's own flag" eight lines above the
  comment that correctly says the two INTERSECT. The code intersects; the stale half is gone.
- `design-auth.md`'s taint section carried a corrected blockquote and then described the OLD model
  underneath it (`taint:false`, a successor with "same body, `taint:false`", and a "known limit"
  that taint is "one bit with no provenance"). The body now matches the blockquote: labels union,
  a client may only ADD, declassify is per-label, and the real limit is that a label says WHAT was
  touched rather than which ancestor contributed it.
- `Space.mintOperatorToken` and `CredentialStore.addOperator` both said the operator token "resolves
  to the privileged `human:local`". It resolves to `SpaceContext.principal` (`local:dev` by
  default), which `isPrivileged` covers as the space's own identity. `human:local` is the NAMED
  operator, a principal a person can hold — a distinction the whole "privilege is a named set, not
  a name prefix" rule rests on, so the two docstrings were undoing it.
- `gotchas.md` said six kinds are defined in code; `RESERVED_KINDS` has eight (`interest` and
  `shred` arrived without the sentence being updated). It now names all eight and points at the
  list, so the next addition has one place to look.

## Extends Package E: the array-index hole is in the SHARED path — CLOSED 2026-08-03

Closed with E, by the `pushablePath` rule described there; the record of what it was follows.

**VERIFIED**, and it was latent rather than active. `pushablePath` (`src/storage/pushdown.ts`) admitted
all-digit segments (`SEGMENT = /^[A-Za-z0-9_]+$/`), while the oracle's `getPath` resolved `items.0`
into an array element through ordinary property access. So Postgres's `@>` containment term
(`{items:{"0":v}}` against a JSON array) and SQLite's `$.items.0` both fail where the oracle
matches: the pre-filter excludes a record the oracle would have returned, silently.

Reachability requires a kind to declare `items.0` as an indexed path, which `validPath`
(`src/core/kinds.ts`) permits — it requires only non-empty segments — and which no kind in this
repo does today. So this is a contract violation waiting for an unusual-but-legal declaration, not
work currently being missed. Rejecting all-digit segments in `pushablePath` is a one-line fix at the
shared root and covers both dialects at once, which is why it belongs in E rather than beside it.

---

## Package Z: an external review, re-derived (2026-09-04) — CLOSED 2026-09-04

An outside reviewer read the source and reported eight defects with line numbers. Each was
re-derived here before anything changed (quote the file, never report the absence of a quote):
four confirmed as reported, two narrower than reported (the body cap, the open-mode CSRF), one inert
and fixed by construction (the epoch binding), one not found. Seven fixed the same day, each fix
carrying a test that fails on the planted defect.

| # | Claim | Verdict | Fix and guard |
|---|-------|---------|---------------|
| 1 | Ops write gate bypassed by a trailing slash (P1) | VERIFIED | `requiredOpsPower` anchored a regex, the dispatcher split on `/` and took the second segment, so `…/reclaim/` matched no power (a read, which `observe` opens) and still dispatched. One parser now, `opsRecordPath` in `src/server/http.ts`, exactly two segments, for both halves; and `handleAdmin`, `handleDeclassify` and `handleShredArtifact` assert their power themselves. `test/http.test.ts` posts six malformed verbs as an observer |
| 2 | Postgres event cursor skips siblings of one transaction (P1) | VERIFIED | `getEvents` compared `xid > cursor` and paged with a limit; the seal walk already compared `(xid, seq)`. The cursor is now `<xid>.<seq>` and resuming compares the pair; a bare `<xid>` keeps its old meaning. `test/conformance/suites/events.ts` follows an ack's two-event transaction one event per page, on every adapter |
| 3 | Seventeen pattern grants make a kind unreadable (P2) | VERIFIED | `combineMatch` folded every grant into one `$or` and the compiler capped a caller's `$or` at 16. The union is now marked with a symbol property no JSON can carry (`GRANT_UNION`), excused from all three caller budgets (branches, the 64-node count, the 8 KB byte cap; a first fix lifted only the first and was caught on re-review), and single-field primitive equalities fold into one `$in`. The caller's own caps stand. `test/conformance/suites/auth.ts`, forty grants of each shape with 240-byte values |
| 4 | Credential resolution orders by id (P2, multi-instance) | VERIFIED | `newestByHash` took the newest by ULID, minted per instance; a stop from an instance whose clock ran behind sorted before the run it stopped. Now a handful of rows by id and the newest by the DB clock through `newer`, still one narrow read. `test/credential-order.test.ts` plants the skew |
| 5 | No body cap on JSON routes | NARROWER, fixed | Nine `req.json()` calls buffered before the size check; only artifacts had a capped reader. `src/server/body.ts` now holds that reader and `parseJsonBody`, an 8 MiB transport ceiling every JSON route reads through, refused as `413 body_too_large` while the body streams. The record limit still decides what is stored. `test/http.test.ts` posts nine megabytes at six routes |
| 6 | Open-mode CSRF | NARROWER, fixed | The mechanism is real, but `radia dev` defaults to `--auth required` (`main.ts`, `flag(args, "--auth") ?? "required"`) and the console authenticates with Bearer tokens, so the exposure was a space started with `--auth open`. There, a write with no token whose `Sec-Fetch-Site` says `cross-site` or `same-site` is now `403 cross_site`: a browser stamps that header and a page cannot forge it, curl and the SDKs send none. Reads stay open. `test/http.test.ts` |
| 7 | Two dead `taintBarrier` copies | VERIFIED (2026-09-05), first refuted wrongly | The first pass counted DEFINITIONS (one function, one delegating method) and called the report's "two copies" not found. The finding was about CALLERS, and a grep finds none: the barrier is enforced through `barrierFrom` inside `readAccess`, and the standalone entry point was unreachable. Both deleted; the refutation broke this ledger's own rule, since a search for callers was the evidence and it was not run |
| 8 | Postgres binds an undefined epoch as NULL on expired reclaim | VERIFIED, inert, fixed | `pgbase.ts` bound it raw and `sqlite.ts` bound `?? 0`; every claim sets an epoch, so the input that separated them did not exist after the backfill. Both expired paths now use NULL-safe equality with `?? null`, the binding their available paths already used, so the adapters agree on every input by construction. The lease suites on all three adapters |

### Follow-up (2026-09-05), CLOSED the same day

The same reviewer re-read the ledger and listed what it had not covered. Every item re-derived
against the code, all confirmed, all fixed with a guard:

| # | Claim | Fix and guard |
|---|-------|---------------|
| 9 | A settle skips the owner check when the row stores no owner | Both adapters' `settleGuard` fail closed when `expectOwner` is set and `lease_owner` is NULL. `test/backfill.test.ts`, the owner nulled by SQL on both dialects |
| 10 | `authorizeWatch` unions patterns across every operation, so an unscoped put widens a scoped query's watch to the kind | Only grants carrying `query`/`take`/`read_one` count (`WATCH_OPS`, `src/core/authorization.ts`); a put-only principal is `forbidden`. `test/conformance/suites/auth.ts` |
| 11 | `queryOrdered` accepts a pattern without `orderBy` and answers oldest-first | Refused by name in `sdk/ts/client.ts`; `query_ordered` added to the Python SDK with the same refusal |
| 12 | `TakeResult` and `DelegatedRun` missing from the barrel; nothing imports `sdk/ts/mod.ts` | Every wire type a public method uses is re-exported (`client.ts`), `kindDefKey` joins the barrel, and `test/docs.test.ts` imports the barrel and stats every exports-map target |
| 13 | A prose-only commit runs no workflow, so the doc guards never run on the changes they guard | `docs.yml` triggers on `agent_docs/**` and `**/*.md` as well as `docs/**` |
| 14 | Python `agent_loop` publishes no interest records | `publish_interest` keyed per run as the TS client does; the loop announces at start, re-announces on a new run, retires on a clean stop. `examples/pipeline-py/demo.py --once` |
| 15 | The npm tarball ships raw `.ts` with no `types` field | A stance, not a build: `sdk/README.md` names the runtimes that load it as is (Deno, Bun, Node 22.18+) and says a build step is not planned |

### Self-review of the harness worker (2026-09-05), CLOSED the same day

`radia team up`, `extensions/ts/harness-worker.ts` and `src/surfaces/teamfile.ts` were written in
one day against live harnesses. A read-through of the three files found six defects, each fixed
with a contract case in `extensions/conformance/harness-worker.test.ts` or `test/teamup.test.ts`:

| # | Defect | Fix and guard |
|---|--------|---------------|
| 1 | The MCP config `team up` writes carries the member's DEFINITION TOKEN and was created at the umask, world-readable | `restrictToOwner` after the write, as `--operator-token-file` does; the session-id file too. `test/teamup.test.ts` asserts mode 600 |
| 2 | A harness that ignored SIGTERM held its lease, its heartbeat and the loop's slot open past the timeout | SIGKILL five seconds after SIGTERM. A fixture that swallows SIGTERM is dead within the escalation |
| 3 | A harness that NACKED its claim read as `ok`, and the loop's own ack then answered `lease_lost`; with zero backoff the record bounced back to the same worker five times in one `--once` | "Settled by the harness" now means the record is no longer under OUR lease id (a nack keeps the epoch, so the epoch could not tell). A nacking fixture is reported `settled` with no ack over it |
| 4 | A warm session (one harness session per member) under `concurrency > 1` would resume one session from two processes at once | Refused at start, naming the two settings |
| 5 | `--once` on a failed launch waited out the failure pause (5s and up) before returning, and the worker's abort was not among the things that cut the pause | The pause is skipped under `once` and cut by the worker's own abort as well as the fence |
| 6 | `--fresh` looked for leftovers in the newest 200 `task` records, so an OLD open task, the exact leftover it is for, was missed | The ops-plane envelope query by STATE (`queryEnvelopes`, every predicate before the cap), capped at 1000 and saying so when hit |

Two more were tidied on the way: the three privileged steps built three admin clients, each an
exchange, and now share one; and a worker stopping under Ctrl-C consulted the envelope before
killing its child, which is pointless when the worker itself is going.

The hardcoded chat vocabulary in `extensions/ts/inference.ts` and `encrypted.ts` was reported too
and is not a defect as framed: every extension names its own kinds (`workspace.ts` names
`workspace`). Whether those kinds are the chat's or the extension's is a naming decision for
[design-workspaces.md](design-workspaces.md)'s sibling docs, not a coupling to remove.

## Deferred: low severity

Batch these; none warrant individual attention. Credentials file created at umask then chmod'd, leaving a world-readable
window (`src/credentials.ts`); `parent_ids` existence documented as checked at commit but never is;
`valueEq` compares objects by `JSON.stringify` and is key-order-sensitive; `PutResult.deduped` is
never true; `lease_epoch` is not monotonic per record; the chat router omits `owner` from progress
records; Python SSE lacks backoff on clean close; TS `req`/`putArtifact` call `JSON.parse` before
checking `res.ok`. Separately, the artifact write-side grant check matches a body omitting
`appFields` (`src/server/handlers/artifacts.ts`), so pattern-scoped put grants on an app field can
never be satisfied. It is fail-closed, so legitimate writes just 403.

REPORTED 2026-08-11 (found during the OIDC review, not yet re-derived): a redeclaration carrying
a `contentKey` is a legal EXTENSION of a reserved kind (`assertReservedCompatible` pins only
indexedPaths and claimable), and `gc.ts` compaction honours it for any reserved kind not in
`NEVER_COMPACT` — today `shred` and `interest`. For `shred` that could delete erasure markers
under a hostile key; `interest` is liveness-scoped so the harm is smaller. `oidc_identity`
answered it the third way: a RUNTIME key (`RUNTIME_KEYS` in core/gc.ts) takes precedence over
any declared contentKey, so the registry compacts safely AND the redeclaration is inert (guard:
`test/oidc.test.ts` "compacts under the RUNTIME's key"). Decide whether `shred` gets the
same treatment (it has no natural succession key, so NEVER_COMPACT membership may be right) or
compaction stops honouring app-declared keys on reserved kinds altogether.

Three entries LEFT this batch on 2026-08-04. Two were re-derived under package S: pattern-take
OFFSET paging (the same defect as the spurious-empty report) and `ownerGuard` turning a succeeded
settle's retry into a false `lease_lost`, which reproduces and breaches the
idempotency-before-lease-validation invariant, so it is not low severity. The third, the unpruned
WATCHES MAP, was promoted for a different reason: it is the one prerequisite
[plan-inspection.md](plan-inspection.md) names for its whole backlog. Closed with an idle sweep plus
a per-principal ceiling; the `Notifier` half had gone with package O.

## Verified clean

Recorded so a later audit does not re-walk them: `src/storage/crypto.ts` throughout (fresh DEK
per seal, tag verified, digest-as-AAD, AES-KW); no SQL injection (pattern path segments are
alphabet-restricted before inlining, blob digests shape-checked before touching the
filesystem); time comparisons use the DB clock; idempotency-before-lease-validation ordering
holds in both adapters; RFC 9457 bodies leak nothing internal; server-assigned metadata is not
client-settable and `taint` can only be raised; the `asksAboutSelf` permissions carve-out
resists encoded-path tricks; the OpenAPI `scope`/`withheldNote` additions match the
implementation with no contract break.
