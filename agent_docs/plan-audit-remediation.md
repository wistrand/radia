# Plan: audit remediation

> Status: A–D are done and their guards pass (`deno task conformance`: 348 passed, 0 failed);
> E–J are open. Every item was substantiated against real code paths; items marked **reproduced**
> were verified empirically. Line numbers drift — trust the symbol, not the number.

## Goal

Close the defects the audit confirmed, and in each case leave behind the guard that would have
caught it. Several findings share one root cause; the packages below are grouped by root cause,
not by file, because fixing them per-site re-creates the same class next quarter.

Ordering rule: **P0 before anything else ships to a non-loopback host.** P0 and P1 are
correctness/security; P2 is durability and drift.

## Priority summary

| Pkg | Theme                                   | Severity | Blast radius                          |
|-----|-----------------------------------------|----------|---------------------------------------|
| A   | Operator credential + console bootstrap | P0       | **DONE** — was: auth bypass; CLI/MCP unusable |
| B   | Per-handler scope enforcement           | P0       | **DONE** — was: cross-principal leak  |
| C   | Lease fencing not enforced at settle    | P1       | **DONE** — was: fenced writes commit  |
| D   | Grant supersede vs. idempotency         | P1       | **DONE** — was: permanent silent lockout |
| E   | Pushdown soundness                      | P1       | Records invisible to `take` on SQLite |
| F   | Bounded reads treated as populations    | P2       | Silent shrinkage as a space ages      |
| G   | Blob write durability                   | P2       | Permanent unhealable corruption       |
| H   | `lease_lost` unobservable in clients    | P2       | Side effects continue after fencing   |
| I   | SDK parity + chat example               | P2       | Drift; example-specific data loss     |
| J   | Declassify is unattributed              | P1       | The approval step names no approver   |

**Downstream dependencies, now satisfied.** Both gates on
[plan-inspection.md](plan-inspection.md) are cleared: B gave the inspection backlog a scoped-read
path to build on (every new view must route through `readAccess` and add a row to the guard
table), and D made a churning registry — the interest registry, saved lenses — safe to write.

---

## Package A — operator credential and console bootstrap (P0) — DONE

Decision taken: **the operator token authorizes coordination.** Encoded once as a distinct
`ResolvedToken` variant, `kind: "operator"` (`src/core/auth.ts`), resolving to the space's own
principal.

- `resolveCredential` (`src/core/space.ts`) returns `kind: "operator"`, and `resolveAuth`
  (`src/server/http.ts`) accepts it alongside `run`. The CLI, the MCP adapter and `curl` work
  again; a definition token is still rejected for coordination.
- Because it is no longer a `def` token, `mintRun` refuses it, so an operator credential cannot be
  converted into a durable run token. That closes the escalation half of A1 at the source.
- `loadUi` no longer substitutes anything; `ServerOptions.operatorToken` is gone. The console
  prompts for a token and keeps it in `sessionStorage` (`src/ui/index.html`). `GET /` stays public
  — it is now safe, because it carries no credential.

Guards added: `conformance/http.test.ts` asserts the provisioned
operator token reaches health, the ops plane and a `put` under `--auth required`, and that it
cannot mint a run. `conformance/console.test.ts` asserts the served page contains no
credential-shaped literal and no substitution placeholder.

## Package B — scope enforcement is per-handler and inconsistent (P0) — DONE

`scope.createdBy: "self"` is applied by each handler calling `space.authorScope` by hand.
Handlers that forget it silently serve everything. Confirmed misses:

| Site                                                     | Leak                                              |
|----------------------------------------------------------|---------------------------------------------------|
| `handleTake` (`src/server/handlers/leases.ts`)             | Full foreign record bodies; drains the whole kind |
| `handleLineage` (`src/server/handlers/ops.ts`)             | Entire ancestor DAG with bodies                   |
| `handleGraph` (`src/server/handlers/ops.ts`)               | Foreign node ids + labels (feeds the above)       |
| `handleGetArtifact` + capability mint (`artifacts.ts`)     | Foreign bytes; capability makes it bearer-free    |
| `authorizeWatch` (`src/core/space.ts`)                     | Self-scope ignored: wakeups for every author      |

`handleLineage` is the worst: `put` never checks parent readability, so a scoped run can name
any foreign id in `parentIds` and read its whole upstream. **Reproduced.**

Also in this package, same theme:

- **Watch streams are not bound to their creating principal.** `handleWatchEvents`
  (`src/server/handlers/watches.ts`) takes only a watch id; `Watch` (`src/core/space.ts`)
  stores no owner. Ids come from the same monotonic ULID generator as record ids, so they are
  enumerable. Revocation also never terminates a live stream — the compiled constraint is
  frozen at creation. **Reproduced** (a grantless principal streamed another's watch).
- **`effectivePermissions` disagrees with `opsScope`** about ops-reachability
  (`src/core/space.ts`): the view ORs `scoped` and `query` across different grants, the
  enforcement requires one grant carrying both. The comment claiming they cannot drift is
  wrong. Per this file's own doctrine, a believed view that drifts is worse than no view.

**DONE.** Every read verb now answers both halves of the scope from one place:

- `Space.readAccess(principal, op, kind)` returns `{constraint, createdBy}` together. `query`,
  `read_one`, `take` and both artifact reads go through it, so the author scope cannot be fetched
  separately and then forgotten.
- `take` carries the author scope into the CLAIM (`LeaseSpec.createdBy` → `rankClaimable`), beside
  `requireUntainted`. It cannot ride in the pattern: `created_by` is envelope metadata, which
  patterns never see.
- `getLineage` and `getGraph` take an author scope and treat a foreign record as a WALL — traversal
  stops there rather than skipping it, since continuing would still expose the shape above.
- Artifact reads apply the scope before serving bytes, and before minting a download capability
  (a bearer URL outlives the check). A foreign artifact is 404, not 403.
- `authorizeWatch` returns `ReadAccess` and honours self-scope; `Watch` carries its `owner` and
  author scope; `getWatch` requires the creating principal; `matchesEvent` filters wakeups by
  author. A non-owner gets 404 — watch ids are monotonic ULIDs, so the id is not a secret.
- `effectivePermissions` computes ops-reachability per GRANT (one grant carrying both `query` and
  the self scope), the rule `opsScope` enforces, instead of ORing across grants.

Verified against the reproductions: `take`, lineage, graph, `query` and a stolen watch attach all
refuse a self-scoped principal foreign data.

Guard added: a table-driven case in `conformance/http.test.ts` — one row per read verb
(`query`, `read_one`, `take`, lineage, children, graph, get record) asserting a self-scoped
principal sees no foreign record through it, plus the watch-attach check. **A verb with no row is
a verb nobody checked** — add a row when adding a read verb.

Not done: full type-level enforcement. `readAccess` makes the right thing convenient and
one-call, but a new handler can still call `authorize` alone. Making that a compile error needs a
read-context type threaded through every handler signature; the table-driven guard is the backstop
until then.

## Package C — lease fencing is not enforced at settle (P1) — DONE

`ack`, `renew`, `nack` and `release` (`src/storage/pgbase.ts`, same shape in
`src/storage/sqlite.ts`) select the envelope without `FOR UPDATE`, validate the lease in
application code, then run a guarded `UPDATE ... and lease_id = $ and lease_epoch = $` — and
never inspect the affected-row count. Under pooled Postgres at READ COMMITTED another
connection can reclaim the lease or bump the epoch in the gap. The result record and its event
are inserted *before* the guarded update, so the transaction commits and returns
`{status: "ok"}`. A quarantined run can land one final result despite the epoch bump that
exists to fence it out.

**DONE.** All four settle operations in both adapters now check the affected-row count of the
guarded update and return `lease_lost` when it matches nothing. `ack` was additionally reordered so
the guarded update runs BEFORE the result insert and its event — that makes the fence a plain early
return rather than a rollback, so a fenced-out worker cannot commit a result under any path.

Guard, honestly bounded: the new branch is **unreachable on the embedded adapters**, because they
serialize in-process and the update's `WHERE` is a subset of what `leaseValid` already checked — so
whenever the check passes, the update matches. A conformance test there would assert nothing. The
observable contract ("a fenced ack emits nothing") stays covered by the existing
`conformance/suites/leases.ts` fencing case, which now holds for a second reason. Exercising the
race itself is **fault-matrix work against a live Postgres**: "stale ack after reassignment" and
"ack after quarantine", driven concurrently. See [plan-validation.md](plan-validation.md).

## Package D — grant supersede vs. idempotency (P1) — DONE

`supersedeGrantsFor` (`src/core/space.ts`) retires live grants whose pattern differs, but
grants are put under a content-derived idempotency key and idempotency rows never expire. So
re-declaring a previously-used pattern writes **nothing** while the supersede still retires
the currently-live grant. Net: zero active grants, `createAgentDefinition` returns success.
**Reproduced:**

```
after identity scope:             [ { owner: "agent:w" } ]
after conversation scope:         [ { conversationId: "c1" } ]
after switching BACK to identity:  THROWS -> forbidden: no 'query' grant
```

Reachable today: chat conversation A → B → `--resume` A, or flipping `RADIA_CHAT_SCOPE`
identity → conversation → identity (`examples/chat/space/roles.ts`, `examples/chat/chat.ts`).

Two more defects in the same mechanism:

- Declaring two patterned grants on one (principal, kind, operations) in a single definition
  keeps only the last — `supersedeGrantsFor` runs per grant inside the loop and retires its own
  sibling. `authorize` is explicitly built to union patterns; a definition can no longer
  express that.
- Retire records are keyed so a grant identity can be retired **at most once, ever**. A
  re-granted wide grant then survives the next supersede silently — misauthorization in the
  widening direction, the class CLAUDE.md flags.

**DONE.** Three changes in `src/core/space.ts`, all verified against the original reproduction:

- The grant write suffixes its idempotency key with `:after:<recordId>` when the newest record for
  that grant identity is a retirement — the shape `examples/chat/space/model.ts` already uses. This
  needed `RegistryView.newest` (`src/core/registry.ts`), which exposes the newest record per key
  *including* retirements; `entries` drops them, so a writer could not see what it had to revive.
- `supersedeGrantsFor` takes the WHOLE declared set instead of one grant at a time, and skips any
  grant whose key is in that set, so siblings no longer retire each other.
- Retirements are keyed on the record being retired, not on the grant identity alone, so an
  identity can be retired more than once.

`createAgentDefinition` now reads the grant registry once per principal before writing, and
**throws `registry_incomplete` rather than superseding on a partial view** — a truncated read would
silently leave stale grants live.

Guards added in `conformance/suites/retire.ts` (they run on both adapters): the round trip (A → B → A), two patterns
on one triple in one definition, and re-narrowing a grant that was retired and re-granted.

## Package E — pushdown soundness (P1)

The contract at the top of `src/storage/pushdown.ts` is that the SQL pre-filter may over-include
but never over-exclude. Three violations:

- **SQLite numeric path segments.** `SqliteJson.at` (`src/storage/sqlite.ts`) compiles
  `choices.0.message` to `json_extract(..., '$.a.0')`, which is NULL for arrays — only `$.a[0]`
  indexes. The oracle and Postgres both resolve element 0. Records become invisible to `take`
  on SQLite only: a false-empty space, plus direct backend drift.
- **Prototype/property paths.** `getPath` (`src/core/matching.ts`) uses bare property access, so
  `length` on an array and `constructor`/`toString` on any object resolve for the oracle and are
  absent in SQL. Marked `exact`, so the pushed LIMIT compounds it. Arguably the root fix belongs
  in `getPath` — restrict to own properties of plain objects.
- **Postgres leading-zero segments.** `{a,00}` integer-parses to element 0; the oracle returns
  undefined. Over-inclusion, but marked `exact`, so a pushed LIMIT can return fewer records than
  exist.

Fix the compilation for the first, tighten `getPath` for the second, and drop `exact` where the
dialect cannot promise it for the third.

Guard: a differential conformance test — same pattern and fixture set against every adapter and
the bare oracle, asserting identical result sets, over a fixture corpus that includes array
paths, digit segments, leading zeros, and prototype-shaped names.

## Package F — bounded reads treated as populations (P2)

CLAUDE.md calls this the most repeated bug in the codebase; the audit found five more.

| Site                                              | Consequence                                        |
|---------------------------------------------------|----------------------------------------------------|
| `runPrincipalsOf` (`src/core/space.ts`, 1000 rows) | Long-lived agent's oldest records vanish from its own self-scoped reads — the exact failure its doc comment claims to prevent |
| `listKinds` (`sdk/ts/client.ts`)                   | Asks 1000, server clamps to 500, never pages        |
| `list_kinds` (`sdk/py/radia.py`)                   | Reads **oldest-first** and ignores `retired`, so withdrawn kinds reappear |
| `client/grants.ts` (grants 100, `agent_run` 200)   | `selfExposure` misreports exposure, steering a human toward the wide grant |
| `workers/exec.ts` (capability/procedure 500)       | A miss re-opens the tool-name hijack the check exists to block |

Fix: route each through `readRegistry` (`src/core/registry.ts`), which pages to exhaustion and
reports `complete: false` rather than a plausible prefix. Where a true registry read is wrong
(`runPrincipalsOf` is relevance-bounded by design), bound it by *relevance* — only credentials
that can still be presented — and say so at the call site.

Guard: a test that seeds past the page limit and asserts the older entries are still observed.

## Package G — blob write durability (P2)

`FileBlobStore` (`src/storage/blobs.ts`) writes payloads non-atomically (`writeBinaryFile` is a
plain write, `src/platform.ts`) and dedups on file existence. A crash mid-write leaves a
truncated file at the final content address, and every later `put` of those bytes sees the file
present and skips the write, so the store never heals. Unencrypted `get` streams the corrupt
bytes with no digest verification; encrypted fails GCM forever.

Fix: write to a temp name and rename (atomic on the same filesystem). That also removes the
need for the key-sidecar-first ordering dance.

Guard: blob-store conformance case — truncate a stored blob, re-`put` the same bytes, assert
`get` returns intact content.

## Package H — `lease_lost` is unobservable in clients (P2)

`renew` reports fencing as a **200 body**, not an error, and every heartbeat discards the
result: `src/mcp/server.ts` (`.catch(() => {})` on an interval that only `takeClaim` clears),
`sdk/ts/loop.ts`, `sdk/py/radia.py`. So a quarantined or reclaimed run keeps renewing a dead
lease for the process lifetime and its handler keeps producing side effects. The design contract
"a fenced worker runs until it observes `lease_lost`" is currently unmeetable through the SDKs —
the only observation point is the final ack, after the work is done.

Fix: inspect the renew result; on `lease_lost` stop the heartbeat and signal the handler. That
needs an abort channel the handler can observe (an `AbortSignal` passed into the handler is the
obvious shape) — this is an SDK surface addition, so land it in both SDKs together.

Guard: conformance case asserting a quarantined run's heartbeat stops and its handler observes
cancellation.

## Package I — SDK parity and the chat example (P2)

**SDK.** `watch()` in `sdk/ts/client.ts` omits `Authorization` on the SSE GET, so in any
token-authenticated space every connect 401s and retries every 300ms forever with no surfaced
error — `agentLoop` silently degrades to poll-only. **Reproduced.** Python sends it. Also:
neither SDK re-creates a watch after a server restart (watches are in-memory; both treat the
404 as transient and hammer the dead id); Python lacks `permissions`, event/children paging and
the `query_page` `scope` field, so a scoped Python caller cannot page past withheld events or
tell a narrowed query from a complete one; the two SDKs derive different idempotency keys for
identical registry writes, so a mixed fleet appends duplicates — which feeds package F.

**Chat.** Adding `owner` to the context match (`examples/chat/workers/inference.ts`) blinds
resumed pre-upgrade conversations: older messages carry no `owner`, so the assistant loses all
history while the UI still prints "resumed conversation — N earlier messages are in context".
Needs a backfill or an `$exists`-tolerant match. Admin-role sessions stamp
`owner: agent:chat-user` anyway (`client/thread.ts`, `client/turn.ts`), contradicting the
posture `client/config.ts` documents; `smoke-scope.ts` passes only because it hand-writes
owner-less operator records, testing a model the client does not implement. The escalation
ladder reads `model` records without `activeByKey` (`workers/inference.ts`) and can escalate to
a gracefully-stopped tier, hanging for the full deadline. `save_procedure`/`retire_procedure`
idempotency keys replay against their own successors (`workers/exec.ts`), so the advertised
"save it again to bring it back" silently no-ops — same root cause as package D. The exec
sandbox denies `~/.radia` but the credential resolves via `RADIA_CREDENTIALS` and
`$XDG_STATE_HOME/radia` first (`client/fleet.ts`), so on a typical Linux box model-written code
can read the operator token.

## Package J — declassify is unattributed (P1)

`declassify` (`src/core/space.ts`) calls `putRaw` with **no principal**, so the successor's
`created_by` — and therefore the emitted event's `runId` — is the space's own `ctx.principal`, not
the operator who approved. The event carries `operation: "put"`; there is no `declassify` operation
in the event log at all (operations are put/take/ack/nack/release/expire/admin/quarantine). The
entire audit trail for a clearance is the successor's `parentIds` plus an anonymous put.

This is the wrong thing to be missing for the one operation whose purpose is accountability, and it
outranks the hash-chained log (M1–M2): a tamper-evident chain over a record that omits the approver
protects the wrong fact. See [research-applications.md](research-applications.md) §5.

Fix: thread the invoking principal through `declassify` into `putRaw`, and give the event log a
distinct `declassify` operation so the clearance is greppable rather than hidden among ordinary
puts.

Guard: a conformance case asserting the declassify event names the invoking principal, and that the
successor's `created_by` is that principal rather than the space.

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
  re-hashing (the encrypted path is fine — the digest is the AES-GCM AAD). Integrity against a
  compromised blob store is unverified in the default configuration.

## Deferred — low severity

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
satisfied — fail-closed, so legitimate writes just 403.

## Verified clean

Recorded so a later audit does not re-walk them: `src/storage/crypto.ts` throughout (fresh DEK
per seal, tag verified, digest-as-AAD, AES-KW); no SQL injection (pattern path segments are
alphabet-restricted before inlining, blob digests shape-checked before touching the
filesystem); time comparisons use the DB clock; idempotency-before-lease-validation ordering
holds in both adapters; RFC 9457 bodies leak nothing internal; server-assigned metadata is not
client-settable and `taint` can only be raised; the `asksAboutSelf` permissions carve-out
resists encoded-path tricks; the OpenAPI `scope`/`withheldNote` additions match the
implementation with no contract break.
