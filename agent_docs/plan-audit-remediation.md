# Plan: audit remediation

> Status: E, G, H and I are open; everything else is closed and its guards pass (`deno task conformance`: 353 passed, 0 failed);
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
| E   | Pushdown soundness                      | P1       | Records invisible to `take` on SQLite |
| G   | Blob write durability                   | P2       | Permanent unhealable corruption       |
| H   | `lease_lost` unobservable in clients    | P2       | Side effects continue after fencing   |
| I   | SDK parity + chat example               | P2       | Drift; example-specific data loss     |

Packages A, B, C, D, F and J are closed. Their lessons are rules in
[gotchas.md](gotchas.md) ("Traps and critical decisions"); their guards run in the conformance and
chat suites. Git holds the rest.

**Downstream dependencies, now satisfied.** Both gates on
[plan-inspection.md](plan-inspection.md) are cleared: B gave the inspection backlog a scoped-read
path to build on (every new view must route through `readAccess` and add a row to the guard
table), and D made a churning registry (the interest registry, saved lenses) safe to write.

---

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
result: `src/surfaces/mcp/server.ts` (`.catch(() => {})` on an interval that only `takeClaim` clears),
`sdk/ts/loop.ts`, `sdk/py/radia.py`. So a quarantined or reclaimed run keeps renewing a dead
lease for the process lifetime and its handler keeps producing side effects. The design contract
"a fenced worker runs until it observes `lease_lost`" is currently unmeetable through the SDKs:
the only observation point is the final ack, after the work is done.

Fix: inspect the renew result; on `lease_lost` stop the heartbeat and signal the handler. That
needs an abort channel the handler can observe (an `AbortSignal` passed into the handler is the
obvious shape). This is an SDK surface addition, so land it in both SDKs together.

Guard: conformance case asserting a quarantined run's heartbeat stops and its handler observes
cancellation.

## Package I: SDK drift and the chat example (P2)

**Parity is no longer the goal.** Python is frozen to the core coordination surface and TS carries
the full one; [sdk/README.md](../sdk/README.md) states the policy. What remains here are defects,
not gaps:

- The TS `watch()` omits `Authorization` on the SSE connect, so in a token-authenticated space
  every connect 401s and silently retries; `agentLoop` degrades to poll-only. Python sends it.
- Neither SDK re-creates a watch after a server restart: watches are in-memory, both treat the 404
  as transient and hammer the dead id forever.
- Python `get_children` takes no paging arguments despite the paged endpoint, and `query_page`
  drops the `scope` field, so a scoped Python caller cannot tell a narrowed read from a complete
  one. These are core-surface bugs, in scope despite the freeze.
- Chat example: the escalation ladder reads `model` records without the registry projection and can
  route to a gracefully stopped tier, hanging until the deadline.

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
