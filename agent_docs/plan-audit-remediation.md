# Plan: audit remediation

> Status: H, I, N and O–R are open; **E, K, L and M are closed** (2026-08-03); everything else is closed and
> its guards pass (`deno task conformance`: 437 passed, 0 failed). Each done package is a status line here; its
> durable lesson (the bug class, why it happened, the rule that prevents it) moved to
> [gotchas.md](gotchas.md), which outlives this plan. Every item was substantiated against real code
> paths; items marked **reproduced** were verified empirically. Line numbers drift; trust the symbol,
> not the number.
>
> **Two rounds.** A–J are the 2026-07-27 audit. K–Q come from a second review on 2026-08-03 and are
> marked VERIFIED (checked against source while recording them) or REPORTED (recorded on the
> reviewer's evidence, not re-derived). Do not treat a REPORTED item as confirmed without checking
> it; that distinction is the reason this file is worth trusting.

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
| H   | `lease_lost` unobservable in clients    | P2       | Side effects continue after fencing   |
| I   | SDK parity + chat example               | P2       | Drift; example-specific data loss     |
| ~~K~~ | ~~Unrevocable definition tokens~~     | ~~P0~~   | **CLOSED 2026-08-03**                 |
| ~~L~~ | ~~Watch streams cache authorization~~ | ~~P1~~   | **CLOSED 2026-08-03**                 |
| ~~M~~ | ~~`kind_def` is not write-protected~~ | ~~P1~~   | **CLOSED 2026-08-03**                 |
| N   | `clientMeta` escapes the body guards    | P2       | Unbounded, unerasable data in a record |
| O   | Multi-instance freshness and ordering   | P1       | Wakeup latency; auth-relevant id races |
| P   | Contracts nothing checks                | P2       | Drift in exactly the claims held loudest |
| Q   | Designed features unreachable           | P2       | A built feature no caller can invoke   |
| R   | Dead taint parameter; half-tested guard | P2       | Legibility, not leakage (see the entry) |

Packages A, B, C, D, E, F, G, J, K, L and M are closed. Their lessons are rules in
[gotchas.md](gotchas.md) ("Traps and critical decisions"); their guards run in the conformance and
chat suites. Git holds the rest.

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

Guard in `conformance/suites/pushdown.ts`: a differential case running each pattern through the
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

Guard: `conformance/suites/blobs.ts`, "a truncated payload heals on re-put", over both the sealed
and plaintext regimes. Verified to fail against the old existence-only dedup.

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

## Package R: a dead taint parameter, and a guard that tests one leg (P2)

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

Guards: `conformance/suites/watches.ts` (revoked grant ends a live watch; a narrowed grant narrows
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

Guards in `conformance/suites/kinds.ts`: a `put: kind_def` grant that authorizes but cannot shrink
`grant`; the same body refused through `ack`, with a valid one adopted and surviving a restart; and
a shrunken declaration planted directly through the adapter that startup declines to adopt.

## Package N: `clientMeta` escapes the body guards (P2)

**VERIFIED.** `src/core/record.ts` applies the NUL check and the `maxRecordBytes` limit to
`bodyJson`/`bodyBytes` only; `clientMeta` is client-supplied, assigned unguarded, persisted, and
returned on every read. The file's own argument for the size limit — an unbounded body is
unerasable data entering the space, because a body has no erasure path — applies to it verbatim.

Fix: include `clientMeta` in both checks, counted against the same budget.

Guard: extend the existing record-limit conformance case to assert a `clientMeta` over the limit is
refused, and that a NUL in `clientMeta` is refused like one in a body.

## Package O: multi-instance freshness and ordering (P1)

Two gaps remain now that the kind registry refreshes itself
(`Space.compileFresh`, closed 2026-08-03):

- **Cross-instance watch wakeups do not happen.** `src/core/notifier.ts` is an in-process waiter
  list and no `LISTEN`/`NOTIFY` code exists in `src/`. Self-healing (the event log is truth, poll
  catches up), so nothing is lost — but every cross-instance hop degrades to poll latency, which is
  felt per turn in an interactive agent session. This is the dimension that actually regresses with
  N>1; throughput is not.
- **ULID monotonicity is per-process.** Latest-wins registries decide "newer" by comparing ids, and
  across instances they agree only to the millisecond. Grants live in those registries, so the
  theoretical bad outcome is auth-relevant. Low probability and operator-driven, but it wants a
  DB-assigned ordering rather than a documented "do not race a retirement across instances".

Guard for the first: a two-instance test asserting a watch on A wakes for a record written through
B within the notify path rather than the poll interval.

## Package P: contracts nothing checks (P2)

- **`openapi/radia.yaml` is not verified against the implementation.** The frozen wire contract has
  exactly the enforcement status the layering rules had before `conformance/layering.test.ts`
  existed, and this project's own thesis says that is temporary. A route-table-vs-spec-paths test is
  roughly thirty lines.
- **The live-Postgres conformance run is still not in CI.** The invariant in CLAUDE.md asserts the
  full suite runs against every adapter "from day one", and the claim-fairness bug that motivated it
  was invisible on both embedded adapters. An invariant that names a guard which is not running is
  the loudest kind of drift.

## Package Q: designed features unreachable (P2)

Each of these is BUILT and cannot be invoked, which is a distinct failure from a bug: the code is
correct and the path to it is missing, so tests of the unit pass while nothing exercises the design.

- **Per-label declassify.** `Space.declassify` takes `{labels}`; the HTTP handler
  (`src/server/handlers/ops.ts`) ignores the request body and always clears everything, and the SDK
  method takes only a record id. The per-label design has no caller.
- **`scope: {leaseOwner: "self"}`** validates in a grant and is enforced nowhere.
- **Pattern-scoped artifact `put` grants on an app field** can never be satisfied, because the grant
  check runs before `appFields` are parsed (already in the deferred batch below; listed here because
  it is the same shape, not a separate bug class).

Guard for all three: a reachability test per feature that drives it through the OUTERMOST surface
(HTTP or CLI), not through `Space`. The unit tests for these pass today.

## Also reported, not re-derived here

Recorded so a later reader does not mistake absence for clearance. **REPORTED**, unverified:
`readAccess` performs three or four paged registry reads per coordination verb where one threaded
`RegistryView` would do; `authorize` silently discards `complete` (fail-closed, but silent at
scale); the `available`-state claim CAS is not guarded on `available_at`, so a record inside its
nack backoff can be reclaimed early; offset-based candidate-window paging can report a spurious
empty under Postgres contention (a keyset window fixes cost and correctness together); `stopRun`
quarantines before writing the stop record, leaving a window where the stopped run can still claim;
`parseTaintAllowlist` admits the reserved `unknown` label that three comments claim no allowlist may
contain; and `{"$or": []}` may compile and render `()`, a SQL syntax error reachable from the wire.

Plus a doc/comment reconciliation batch: the take barrier described as OR where the code correctly
intersects; `design-auth.md` still describing the one-bit taint model; the `ownerGuard` docstring
asserting an invariant the deferred list already contradicts; the operator token resolving to
`local:dev` where two docs say `human:local`; "six kinds defined in code" (it is eight).

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

## Deferred: low severity

Batch these; none warrant individual attention. Watches map never pruned and `Notifier` waiters
accumulate on timeout (unbounded growth from a cheap authenticated call); credentials file
created at umask then chmod'd, leaving a world-readable window (`src/credentials.ts`);
`parent_ids` existence documented as checked at commit but
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
