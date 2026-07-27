# Plan: audit remediation

> Status: not started. Source: a full-codebase bug audit (2026-07-27) run as six parallel
> reviews (core, storage, server/CLI/MCP, SDKs, chat example, working-tree diff). Every item
> below was substantiated against real code paths; items marked **reproduced** were verified
> empirically. Line numbers are from the audit and drift — trust the symbol, not the number.

## Goal

Close the defects the audit confirmed, and in each case leave behind the guard that would have
caught it. Several findings share one root cause; the packages below are grouped by root cause,
not by file, because fixing them per-site re-creates the same class next quarter.

Ordering rule: **P0 before anything else ships to a non-loopback host.** P0 and P1 are
correctness/security; P2 is durability and drift.

## Priority summary

| Pkg | Theme                                   | Severity | Blast radius                          |
|-----|-----------------------------------------|----------|---------------------------------------|
| A   | Operator credential + console bootstrap | P0       | Total auth bypass; CLI/MCP unusable   |
| B   | Per-handler scope enforcement           | P0       | Cross-principal record + body leak    |
| C   | Lease fencing not enforced at settle    | P1       | Fenced writes commit; quarantine leaks|
| D   | Grant supersede vs. idempotency         | P1       | Permanent, silent lockout             |
| E   | Pushdown soundness                      | P1       | Records invisible to `take` on SQLite |
| F   | Bounded reads treated as populations    | P2       | Silent shrinkage as a space ages      |
| G   | Blob write durability                   | P2       | Permanent unhealable corruption       |
| H   | `lease_lost` unobservable in clients    | P2       | Side effects continue after fencing   |
| I   | SDK parity + chat example               | P2       | Drift; example-specific data loss     |

---

## Package A — operator credential and console bootstrap (P0)

Two defects that compose into a full bypass. Fix together; they are one story.

**A1. The console serves the operator token to unauthenticated callers.** `loadUi`
(`src/server/http.ts`) substitutes the live operator token into the page
(`__RADIA_OPERATOR_TOKEN__`, `src/ui/index.html`), and `isPublic` exempts `GET /` even under
`--auth required`. `POST /v0/agent-runs` is routed *before* `resolveAuth`, so the harvested
token mints a run for `local:dev` that `isPrivileged` accepts. **Reproduced** end to end
through to `POST /v0/ops/remediate` returning 200.

**A2. The provisioned operator token 401s on every coordination request.** `resolveCredential`
(`src/core/space.ts`) returns `kind: "def"` for an operator hash and `resolveAuth`
(`src/server/http.ts`) rejects `kind: "def"`. `radia dev` writes exactly this token to the
credentials file, so the CLI, the MCP adapter and the console all authenticate worse than
sending no header at all. Regression; no conformance test covers `mintOperatorToken` through
the handler.

Fix:

- Never bake a credential into a public response. Either serve the console only to an
  authenticated caller, or have the page mint its own short-lived run token through a
  bootstrap endpoint that requires a credential the browser already holds.
- Decide the operator token's kind deliberately and encode it once: it either authorizes
  coordination (resolve it to a run-equivalent principal) or it does not (then `radia dev` must
  stop writing it as the client credential and provision a run token instead). The audit did
  not establish which was intended — **resolve this before coding**, it changes A1's fix.
- Re-check `isPublic`: `GET /` is public so the console can bootstrap in required mode. If the
  console stops carrying a baked token, that exemption may be droppable entirely.

Guard: a `conformance/http.test.ts` case per surface asserting that the credential
`radia dev` provisions actually authenticates a request, and one asserting an unauthenticated
`GET /` body contains no token-shaped string under `--auth required`.

## Package B — scope enforcement is per-handler and inconsistent (P0)

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

Fix: make scope structural rather than remembered. Route every read-shaped handler through one
helper that takes the principal and returns both the grant and its author scope, so omitting
the scope is a type error rather than an oversight. Give `Space.take` an author-scope parameter
(it currently has none). Store the owning principal on `Watch` and re-check the grant on
attach; consider re-checking periodically so revocation terminates a live stream.

Guard: one conformance case per read verb asserting a self-scoped principal cannot observe a
foreign record through it — `query`, `read_one`, `take`, lineage, children, graph, artifact
get, artifact capability, watch. Table-drive it so a new verb without a row is visible.

## Package C — lease fencing is not enforced at settle (P1)

`ack`, `renew`, `nack` and `release` (`src/storage/pgbase.ts`, same shape in
`src/storage/sqlite.ts`) select the envelope without `FOR UPDATE`, validate the lease in
application code, then run a guarded `UPDATE ... and lease_id = $ and lease_epoch = $` — and
never inspect the affected-row count. Under pooled Postgres at READ COMMITTED another
connection can reclaim the lease or bump the epoch in the gap. The result record and its event
are inserted *before* the guarded update, so the transaction commits and returns
`{status: "ok"}`. A quarantined run can land one final result despite the epoch bump that
exists to fence it out.

Fix: check the affected-row count of the guarded update and return `lease_lost`, aborting the
transaction so the result-record insert rolls back. The embedded adapters are immune only
because they serialize in-process — fix both, the pattern is identical.

Guard: this is fault-matrix material. Add "stale ack after reassignment" and "ack after
quarantine" to the adapter conformance suite, driven concurrently enough to hit the window on
Postgres. See [plan-validation.md](plan-validation.md).

## Package D — grant supersede vs. idempotency (P1)

`supersedeGrantsFor` (`src/core/space.ts`) retires live grants whose template differs, but
grants are put under a content-derived idempotency key and idempotency rows never expire. So
re-declaring a previously-used template writes **nothing** while the supersede still retires
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

- Declaring two templated grants on one (principal, kind, operations) in a single definition
  keeps only the last — `supersedeGrantsFor` runs per grant inside the loop and retires its own
  sibling. `authorize` is explicitly built to union templates; a definition can no longer
  express that.
- Retire records are keyed so a grant identity can be retired **at most once, ever**. A
  re-granted wide grant then survives the next supersede silently — misauthorization in the
  widening direction, the class CLAUDE.md flags.

Fix: idempotency keys for registry writes must not collide across the retire/revive cycle.
`examples/chat/space/model.ts` already solves this by suffixing the key with the superseded
record id; apply that shape to grants (and to `save_procedure`/`retire_procedure`, package I).
Move `supersedeGrantsFor` out of the per-grant loop so one definition supersedes as a set.

Guard: `conformance/suites/retire.ts` currently covers only a one-way swap, which is why the
suite passes. Add the **round trip** (A → B → A) and the two-templates-one-definition case.

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

Guard: a differential conformance test — same template and fixture set against every adapter and
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

## Deferred — low severity

Batch these; none warrant individual attention. Watches map never pruned and `Notifier` waiters
accumulate on timeout (unbounded growth from a cheap authenticated call); credentials file
created at umask then chmod'd, leaving a world-readable window (`src/credentials.ts`); reserved
control kinds other than `kind_def` can be redeclared and brick authorization across restarts
(fail-closed, operator-recoverable); `parent_ids` existence documented as checked at commit but
never is; `valueEq` compares objects by `JSON.stringify` and is key-order-sensitive;
`PutResult.deduped` is never true; template-take OFFSET pagination transiently skips claimable
rows; `lease_epoch` is not monotonic per record; `ownerGuard` can turn a succeeded settle's
retry into a false `lease_lost`; the chat router omits `owner` from progress records; Python SSE
lacks backoff on clean close; TS `req`/`putArtifact` call `JSON.parse` before checking
`res.ok`. Separately, the artifact write-side grant check matches a body omitting `appFields`
(`src/server/handlers/artifacts.ts`), so template-scoped put grants on an app field can never be
satisfied — fail-closed, so legitimate writes just 403.

## Verified clean

Recorded so a later audit does not re-walk them: `src/storage/crypto.ts` throughout (fresh DEK
per seal, tag verified, digest-as-AAD, AES-KW); no SQL injection (template path segments are
alphabet-restricted before inlining, blob digests shape-checked before touching the
filesystem); time comparisons use the DB clock; idempotency-before-lease-validation ordering
holds in both adapters; RFC 9457 bodies leak nothing internal; server-assigned metadata is not
client-settable and `taint` can only be raised; the `asksAboutSelf` permissions carve-out
resists encoded-path tricks; the OpenAPI `scope`/`withheldNote` additions match the
implementation with no contract break.
