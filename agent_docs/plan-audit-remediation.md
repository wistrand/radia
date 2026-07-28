# Plan: audit remediation

> Status: A–D, F and J are done and their guards pass (`deno task conformance`: 353 passed, 0 failed);
> E, G, H and I are open. Each done package is a status line here; its durable lesson (the bug class,
> why it happened, the rule that prevents it) moved to [gotchas.md](gotchas.md), which outlives this
> plan. Every item was substantiated against real code paths; items marked **reproduced** were
> verified empirically. Line numbers drift; trust the symbol, not the number.

## Goal

Close the defects the audit confirmed, and in each case leave behind the guard that would have
caught it. Several findings share one root cause; the packages below are grouped by root cause,
not by file, because fixing them per-site re-creates the same class next quarter.

Ordering rule: **P0 before anything else ships to a non-loopback host.** P0 and P1 are
correctness/security; P2 is durability and drift.

## Priority summary

| Pkg | Theme                                   | Severity | Blast radius                          |
|-----|-----------------------------------------|----------|---------------------------------------|
| A   | Operator credential + console bootstrap | P0       | **DONE** (was: auth bypass; CLI/MCP unusable) |
| B   | Per-handler scope enforcement           | P0       | **DONE** (was: cross-principal leak)  |
| C   | Lease fencing not enforced at settle    | P1       | **DONE** (was: fenced writes commit)  |
| D   | Grant supersede vs. idempotency         | P1       | **DONE** (was: permanent silent lockout) |
| E   | Pushdown soundness                      | P1       | Records invisible to `take` on SQLite |
| F   | Bounded reads treated as populations    | P2       | **DONE** (was: silent shrinkage)      |
| G   | Blob write durability                   | P2       | Permanent unhealable corruption       |
| H   | `lease_lost` unobservable in clients    | P2       | Side effects continue after fencing   |
| I   | SDK parity + chat example               | P2       | Drift; example-specific data loss     |
| J   | Declassify is unattributed              | P1       | **DONE** (was: no approver recorded)  |

**Downstream dependencies, now satisfied.** Both gates on
[plan-inspection.md](plan-inspection.md) are cleared: B gave the inspection backlog a scoped-read
path to build on (every new view must route through `readAccess` and add a row to the guard
table), and D made a churning registry (the interest registry, saved lenses) safe to write.

---

## Package A: operator credential and console bootstrap (P0, DONE)

Was: the served console page carried a substituted operator token, and the operator credential
resolved as a definition token, so a leak converted into a durable run token. Now the operator token
is a distinct `ResolvedToken` variant (`kind: "operator"`, `src/core/auth.ts`) that authorizes
coordination and mints nothing, and the console prompts for a token instead.

Lesson: [gotchas.md](gotchas.md), "The operator token is a server-lifetime in-memory credential" and
"The operator token resolves as `kind: "operator"`, never `"def"`".

Guards: `conformance/http.test.ts` (the provisioned token reaches health, the ops plane and a `put`
under `--auth required`, and cannot mint a run); `conformance/console.test.ts` (no credential-shaped
literal and no substitution placeholder in the served page).

## Package B: scope enforcement is per-handler and inconsistent (P0, DONE)

Was: `scope.createdBy: "self"` was applied by each handler calling `space.authorScope` by hand, and
five read paths forgot it (`handleTake`, `handleLineage`, `handleGraph`, both artifact reads, and
`authorizeWatch`), plus watch streams were not bound to their creating principal and
`effectivePermissions` disagreed with `opsScope`. **Reproduced.** Now every read verb resolves both
halves of the scope through `Space.readAccess`.

Lesson: [gotchas.md](gotchas.md), "Every read verb must resolve its scope through ONE path".

Guard: a table-driven case in `conformance/http.test.ts` with one row per read verb (`query`,
`read_one`, `take`, lineage, children, graph, get record) plus the watch-attach check. **A verb with
no row is a verb nobody checked.** Add a row when adding a read verb.

Not done: full type-level enforcement. A new handler can still call `authorize` alone; making that a
compile error needs a read-context type threaded through every handler signature, so the
table-driven guard is the backstop until then.

## Package C: lease fencing is not enforced at settle (P1, DONE)

Was: `ack`, `renew`, `nack` and `release` ran their guarded `UPDATE ... and lease_id = $ and
lease_epoch = $` without inspecting the affected-row count, and `ack` inserted the result and its
event first, so under pooled Postgres a fenced-out run could commit a final result and be told
`{status: "ok"}`. Now all four check the count in both adapters, and `ack` fences before it writes.

Lesson: [gotchas.md](gotchas.md), "The guarded UPDATE is the fence".

Guard, honestly bounded: the new branch is unreachable on the embedded adapters, so the observable
contract stays covered by the fencing case in `conformance/suites/leases.ts`, which now holds for a
second reason. Exercising the race is fault-matrix work against a live Postgres ("stale ack after
reassignment", "ack after quarantine", driven concurrently). See
[plan-validation.md](plan-validation.md).

## Package D: grant supersede vs. idempotency (P1, DONE)

Was: grants are written under a content-derived idempotency key, so re-declaring a
previously-used pattern wrote nothing while `supersedeGrantsFor` still retired the live grant, and
`createAgentDefinition` reported success with zero active grants. **Reproduced** (identity scope,
then conversation scope, then identity scope again, ending in `forbidden: no 'query' grant`).
Same mechanism also let a definition's sibling grants retire each other and allowed a grant identity
to be retired only once, ever. Fixed in `src/core/space.ts` (revival keyed on the retirement it
supersedes, whole-set supersede, retirements keyed on the record retired) and in both SDKs'
`client.grant()`.

Lesson: [gotchas.md](gotchas.md), "A content-keyed registry write cannot revive what it retired".

Guards: `conformance/suites/retire.ts` on both adapters (the round trip A to B to A, two patterns on
one triple in one definition, and re-narrowing a grant that was retired and re-granted), plus
`examples/chat/smoke-selfgrant.ts` (assign, retire, revive, repeat).

## Package E: pushdown soundness (P1)

The contract at the top of `src/storage/pushdown.ts` is that the SQL pre-filter may over-include
but never over-exclude. Three violations:

- **SQLite numeric path segments.** `SqliteJson.at` (`src/storage/sqlite.ts`) compiles
  `choices.0.message` to `json_extract(..., '$.a.0')`, which is NULL for arrays; only `$.a[0]`
  indexes. The oracle and Postgres both resolve element 0. Records become invisible to `take`
  on SQLite only: a false-empty space, plus direct backend drift.
- **Prototype/property paths.** `getPath` (`src/core/matching.ts`) uses bare property access, so
  `length` on an array and `constructor`/`toString` on any object resolve for the oracle and are
  absent in SQL. Marked `exact`, so the pushed LIMIT compounds it. Arguably the root fix belongs
  in `getPath`: restrict to own properties of plain objects.
- **Postgres leading-zero segments.** `{a,00}` integer-parses to element 0; the oracle returns
  undefined. Over-inclusion, but marked `exact`, so a pushed LIMIT can return fewer records than
  exist.

Fix the compilation for the first, tighten `getPath` for the second, and drop `exact` where the
dialect cannot promise it for the third.

Guard: a differential conformance test running the same pattern and fixture set against every
adapter and the bare oracle, asserting identical result sets, over a fixture corpus that includes
array paths, digit segments, leading zeros, and prototype-shaped names.

## Package F: bounded reads treated as populations (P2, DONE)

Was: five more instances of the class CLAUDE.md calls the most repeated bug in this codebase, the
one that mattered being `runPrincipalsOf` (`src/core/space.ts`), which decides a principal's self
scope and therefore what package B lets it `take`, trace, and read bytes for. Now it pages to
exhaustion through `readRegistry` and throws `registry_incomplete`; the client-side sites
(`listKinds`, `list_kinds`, the chat's grant and `agent_run` reads, the exec worker's
capability/procedure reads) route through `RadiaClient.queryAll` / `query_all` in both SDKs.

Lesson: [gotchas.md](gotchas.md), "A bounded read that decides a SCOPE is not a performance
question".

Guard: `conformance/suites/auth.ts` seeds 1201 `agent_run` records for one agent and asserts its
OLDEST run is still in the self scope, past the old 1000-row cap, on both adapters.

## Package G: blob write durability (P2)

`FileBlobStore` (`src/storage/blobs.ts`) writes payloads non-atomically (`writeBinaryFile` is a
plain write, `src/platform.ts`) and dedups on file existence. A crash mid-write leaves a
truncated file at the final content address, and every later `put` of those bytes sees the file
present and skips the write, so the store never heals. Unencrypted `get` streams the corrupt
bytes with no digest verification; encrypted fails GCM forever.

Fix: write to a temp name and rename (atomic on the same filesystem). That also removes the
need for the key-sidecar-first ordering dance.

Guard: a blob-store conformance case that truncates a stored blob, re-`put`s the same bytes, and
asserts `get` returns intact content.

## Package H: `lease_lost` is unobservable in clients (P2)

`renew` reports fencing as a **200 body**, not an error, and every heartbeat discards the
result: `src/mcp/server.ts` (`.catch(() => {})` on an interval that only `takeClaim` clears),
`sdk/ts/loop.ts`, `sdk/py/radia.py`. So a quarantined or reclaimed run keeps renewing a dead
lease for the process lifetime and its handler keeps producing side effects. The design contract
"a fenced worker runs until it observes `lease_lost`" is currently unmeetable through the SDKs:
the only observation point is the final ack, after the work is done.

Fix: inspect the renew result; on `lease_lost` stop the heartbeat and signal the handler. That
needs an abort channel the handler can observe (an `AbortSignal` passed into the handler is the
obvious shape). This is an SDK surface addition, so land it in both SDKs together.

Guard: conformance case asserting a quarantined run's heartbeat stops and its handler observes
cancellation.

## Package I: SDK parity and the chat example (P2)

**SDK.** `watch()` in `sdk/ts/client.ts` omits `Authorization` on the SSE GET, so in any
token-authenticated space every connect 401s and retries every 300ms forever with no surfaced
error, and `agentLoop` silently degrades to poll-only. **Reproduced.** Python sends it. Also:
neither SDK re-creates a watch after a server restart (watches are in-memory; both treat the
404 as transient and hammer the dead id); Python lacks `permissions`, event/children paging and
the `query_page` `scope` field, so a scoped Python caller cannot page past withheld events or
tell a narrowed query from a complete one; the two SDKs derive different idempotency keys for
identical registry writes, so a mixed fleet appends duplicates, which feeds package F.

**Chat.** Adding `owner` to the context match (`examples/chat/workers/inference.ts`) blinds
resumed pre-upgrade conversations: older messages carry no `owner`, so the assistant loses all
history while the UI still prints "resumed conversation <id>: N earlier messages are in context".
Needs a backfill or an `$exists`-tolerant match. Admin-role sessions stamp
`owner: agent:chat-user` anyway (`client/thread.ts`, `client/turn.ts`), contradicting the
posture `client/config.ts` documents; `smoke-scope.ts` passes only because it hand-writes
owner-less operator records, testing a model the client does not implement. The escalation
ladder reads `model` records without `activeByKey` (`workers/inference.ts`) and can escalate to
a gracefully-stopped tier, hanging for the full deadline. `save_procedure`/`retire_procedure`
idempotency keys replay against their own successors (`workers/exec.ts`), so the advertised
"save it again to bring it back" silently no-ops, the same root cause as package D. The exec
sandbox denies `~/.radia` but the credential resolves via `RADIA_CREDENTIALS` and
`$XDG_STATE_HOME/radia` first (`client/fleet.ts`), so on a typical Linux box model-written code
can read the operator token.

## Package J: declassify is unattributed (P1, DONE)

Was: `declassify` called `putRaw` with no principal and emitted an ordinary `put` event, so the one
operation whose purpose is accountability named no approver and was not greppable. Now
`Space.declassify(recordId, principal)` threads the approver and the commit records a distinct
`declassify` operation carrying `{declassifiedFrom}`. See
[research-applications.md](research-applications.md) §5 for why this outranks the hash-chained log.

Lesson: [gotchas.md](gotchas.md), "The one operation whose purpose is accountability must name its
actor".

Guard: `conformance/suites/taint.ts` asserts the successor is authored by the approver, that exactly
one `declassify` event exists naming them, and that ordinary puts are unchanged.

Related, same area, lower severity:

- **Taint launders by omission.** `parent_ids` on a direct put is client-asserted
  (`src/core/record.ts` says so). An agent that reads tainted content and writes a fresh record
  without naming the parent produces an untainted record; only `ack` force-prepends the leased
  record. Containment therefore holds for lease-mediated work, not arbitrary writes. This is
  arguably by design, but it is undocumented as a limit and should be stated in
  [design-auth.md](design-auth.md) rather than discovered.
- **`requireUntainted` is per-call, not bindable.** It is a worker's own flag, not a property of a
  grant or identity, so an operator cannot force a principal's takes to be untainted.
- **`declassify` mints a new record id** with the same `body_sha256`, so a clearance keyed on record
  id and one keyed on digest behave differently across it. Pick one and say which.
- **`body_sha256` is never re-verified on read**, and unencrypted blob `get` streams bytes without
  re-hashing (the encrypted path is fine; the digest is the AES-GCM AAD). Integrity against a
  compromised blob store is unverified in the default configuration.

## Deferred: low severity

Batch these; none warrant individual attention. Watches map never pruned and `Notifier` waiters
accumulate on timeout (unbounded growth from a cheap authenticated call); credentials file
created at umask then chmod'd, leaving a world-readable window (`src/credentials.ts`); reserved
control kinds other than `kind_def` can be redeclared and brick authorization across restarts
(fail-closed, operator-recoverable); `parent_ids` existence documented as checked at commit but
never is; `valueEq` compares objects by `JSON.stringify` and is key-order-sensitive;
`PutResult.deduped` is never true; pattern-take OFFSET pagination transiently skips claimable
rows; `lease_epoch` is not monotonic per record; `ownerGuard` can turn a succeeded settle's
retry into a false `lease_lost`; the chat router omits `owner` from progress records; Python SSE
lacks backoff on clean close; TS `req`/`putArtifact` call `JSON.parse` before checking
`res.ok`. Separately, the artifact write-side grant check matches a body omitting `appFields`
(`src/server/handlers/artifacts.ts`), so pattern-scoped put grants on an app field can never be
satisfied. It is fail-closed, so legitimate writes just 403.

## Verified clean

Recorded so a later audit does not re-walk them: `src/storage/crypto.ts` throughout (fresh DEK
per seal, tag verified, digest-as-AAD, AES-KW); no SQL injection (pattern path segments are
alphabet-restricted before inlining, blob digests shape-checked before touching the
filesystem); time comparisons use the DB clock; idempotency-before-lease-validation ordering
holds in both adapters; RFC 9457 bodies leak nothing internal; server-assigned metadata is not
client-settable and `taint` can only be raised; the `asksAboutSelf` permissions carve-out
resists encoded-path tricks; the OpenAPI `scope`/`withheldNote` additions match the
implementation with no contract break.
