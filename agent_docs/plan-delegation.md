# Delegated runs: acting with my own capability, under my caller's reach

The build plan for [plan-scaling.md](plan-scaling.md) item 3a, which holds the design and the
rejected alternatives. Read that first; this file is the sequence, the seams and the guards.

**Status: BUILT (2026-08-12), all phases.** `Space.mintDelegatedRun` +
`POST /v0/agent-runs/delegated` (`src/core/identity.ts`, `src/server/handlers/agents.ts`), the
`access` seam every authorization read goes through, `delegable:<agent>` grants, `radia runs
--acting-for`, and the chat cutover. Guards: `test/delegation.test.ts`, each proved red by
a plant. What each phase decided is kept below; where the build changed the plan, the entry says
so.

## What it is, in one paragraph

A worker serving many callers needs two authorities at once: its own (exec writes `check` because
the verdict is exec's) and its caller's (the attachment it must read belongs to one person).
`POST /v0/agent-runs/delegated` mints an ordinary run whose grants are
`grants(worker) INTERSECT grants(caller)`, computed once, recorded on the `agent_run` body. The
worker then holds two credentials and picks per operation. The caller is never asserted: it is
resolved through the RUN behind the naming record's `created_by`.

## Ordering principle

By MODEL RISK, not feature value (the plan-workspaces.md rule). Phase 0 is guards for shortcuts
that already exist, phases 1-2 make delegation possible and revocable, phase 3 makes it the only
path, phase 4 is the chat cutover. **A delegated run that fails open is worse than no delegation
at all**, so every phase's verify step is a fail-closed test before a works-as-intended test.

## Phase 0: guard the shortcuts that skip attenuation

`Space.authorize` returns `null` before reading any grant in two places, and both would skip an
inline attenuation entirely:

- `if (this.isPrivileged(principal)) return null` (`src/core/space.ts`), where `isPrivileged`
  resolves `grantSubject` internally, so a run inherits it from its agent.
- the supervisor's `grant`/`signal` carve-out, keyed on `subject === this.ctx.supervisor`, which
  is the AGENT and not the run.

The supervisor is mintable (`createAgentDefinition` refuses `isPrivileged`, which covers the
operator set and the space's own principal, NOT `ctx.supervisor`), and item 3's first decision puts
the session broker on that identity. So the risk is concrete, not theoretical.

Work: fix `createAgentDefinition`'s error message, which claims it refuses "an operator or the
supervisor" and refuses only the former. Write the two tests as PLANTS against the phase-1 mint
(they cannot pass before it exists, so they land with phase 1 and are written first): a delegated
mint naming a privileged agent and one naming the supervisor are both REFUSED at the mint, and an
attenuated run of each reaches neither shortcut.

The mint refusing is the guard that matters. `authorize` catching it later is the backstop.

## Phase 1: mint, resolve, enforce

### 1a. The `agent_run` body

Two new fields, written only by the delegated mint:

    actingFor: string          // the resolved caller principal
    delegated: { grants: GrantDef[] }   // the materialized intersection

`META_RESERVED` for `AGENT_RUN` gains `{path: "actingFor", type: "keyword"}` (phase 2 reads it).
No backfill: `prepareKind` creates STATISTICS, not indexes, and matching is an expression over the
body, so an existing `agent_run` simply carries no such field. `assertReservedCompatible` is a
floor rather than an equality check, so adding a required path does not invalidate a stored
redeclaration.

### 1b. Resolving the caller

`created_by` names the RUN (`resolveCredential` returns `principal: b.run`), and a run is a record:

    caller(R) = run(R.created_by).actingFor ?? grantSubject(R.created_by)

One read, no walk: `actingFor` holds a resolved caller and never another run. `Space.runRecord`
already folds a run's successors and is the read to extend. Never a body field, and never the
leased record's author: in the chat a `tool_call` is authored by the turn worker, so the leased
record's `created_by` names another worker rather than the person.

### 1c. Entitlement

A pure narrowing needs only READ on the naming record: the result is a subset of what the worker
already holds and can gain it nothing. A worker holding DELEGABLE grants (phase 3) needs a LEASE,
because that is authority it cannot use alone. Both in `Space.mayActOn`.

BUILT DIFFERENTLY in one respect: the read proof accepts `query` OR `read_one`, not `read_one`
alone. A tool worker holds `take` on the kind it serves and commonly no `read_one` at all, so the
narrower check refused exactly the callers this exists for.

### 1d. The intersection

Per kind held by BOTH sides, then per operation held by both:

- patterns: `null` on either side means unrestricted there, so the other side's list stands; two
  lists become the cross product under `combineMatch` (the same function grant-AND-request already
  uses on every scoped read).
- `scope.taint`: intersect the allowlists, narrower wins.
- `scope.createdBy: "self"`: REFUSED as an input in phase 1. "Self" is relative to the holder, and
  a delegated run's writer is the worker, so materializing it wrong inverts the grant. The chat's
  session grants scope by `pattern`, not by `self`, so nothing is lost. Revisit only with a
  concrete caller.

Emit one `GrantDef` per (kind, operation, pattern). Refuse above 64 entries with a named error, so
a cross-product explosion fails AT THE MINT with a clear message rather than at some later query.

### 1e. Enforcement: one seam, SIX call sites

Not three: `authorize`, `readAccess`, `authorScope`, `authorizeWatch` and
`effectivePermissions` (plus `opsScope`, and `taintBarrier` until it was found dead and deleted
on 2026-09-05) each began by reading the grant registry for
`grantSubject(principal)`. Adding the branch per site is how five of them would have kept reading
the worker's grants. They now share `Space.access(principal, kind?)`, which returns the delegated
run's inline grants or the registry view; `constraintFrom`, `selfScoped` and `barrierFrom` take
`GrantDef[]` and are unchanged otherwise.

**The fail-open to design against.** If `access` cannot tell that a run is delegated, it falls
through to the WORKER's full grants. `resolveCredential` reads the run body on every request and
already called `creds.rememberRun(run, agent)`, so that memo entry now carries the delegation and
the authenticated path is always warm. The cold path is real and handled: `ack` authorizes the
LEASE OWNER, which may be a run this process never authenticated, so `delegationOf` falls back to
`runRecord` exactly as `Space.agentForRun` does. Absence from the memo means UNKNOWN, never "not
delegated".

A SECOND fail-open, found by planting rather than by design: successors must COPY `actingFor` and
`delegated`, because `resolveCredential` resolves a token through `newestByHash` and never folds.
A renewal that dropped them would hand back a run resolving as an ordinary one. `renewRun` and
`stopRun` copy them, the way `mintedAt` is copied. The test has to present the TOKEN to catch this:
asserting through `authorize(run)` passes either way, since that path reaches `runRecord`, which
folds. The first version of that test did exactly that and stayed green against the plant.

`grantSubject` is NOT changed. Its other consumers want the worker's agent and are right to:
`computeTaint` compares authorship (so a worker writing under delegation still tags its output
`foreign`), `idem` wants a durable scope, `isPrivileged` wants the agent.

**A delegated run holds NO ops powers.** `ops_grant` is keyed by principal and the gate resolves
`grantSubject`, so without an explicit check a delegated run inherits the worker's `observe` or
`remediate`. Refuse in `opsPowers` for any principal carrying a delegation, and test it.

### 1f. Surface

- `POST /v0/agent-runs/delegated` beside `handleCreateRun` in `src/server/handlers/agents.ts`.
  Body `{for: <record id>}`; authenticated as the worker (NOT in the pre-auth block, unlike the
  OIDC mint). Returns `{run, agent, runToken, expiresAt, actingFor}`.
- Refusals: `403` for a privileged or supervisor agent; `403` when the worker cannot read the
  naming record; `422` when the intersection is empty (a delegated run that can do nothing is a
  configuration error worth naming, not a token to hand back); `422` on cross-product overflow.
- `openapi/radia.yaml` entry (2-space path, 4-space method, for the round-trip test).
- `sdk/ts/client.ts`: `mintDelegatedRun(recordId)` returning a token, plus the one-line factory for
  a second `RadiaClient`. `sdk/py/radia.py` at parity.
- `sdk/ts/wire.ts` owns the request/response shapes.

### Verify

`deno task test:quick` (openapi round-trip), then a new `test/delegation.test.ts`:
the two phase-0 plants; the intersection is a strict subset of the worker's authority on every
kind; a caller's pattern actually binds the delegated run's reads; a kind the caller lacks is
refused; a kind the WORKER lacks is refused; the ops plane is refused; `effectivePermissions` of
the delegated run is a flat list matching what it can actually do; a cold-memo `authorize` on a
delegated run (simulating `ack` by another instance) does NOT fall back to the worker's grants.

## Phase 2: enumerate and revoke before relying on it

`revokeDefinition` deliberately leaves runs alive ("Existing RUNS are untouched"), and
`resolveCredential` checks the run's own `status`/`expiresAt`, never its definition's. So a
delegated run outlives its caller's deprovisioning up to the ceiling unless something stops it.

- `radia runs --for <principal>`: BOTH classes a principal can act through — `agent_run{agent: X}`
  (their own sessions) and `agent_run{actingFor: X}` (delegated, held by workers). It shipped
  matching only the second, under `--acting-for`, which meant the documented offboarding command
  left the person's own session working for up to twelve hours. Proved by test before the fix.
- Cascade: stop every active delegated run for a caller, the shape `remediate` already uses for
  leases. A CLI verb, not a timer.
- The console's Auth tab renders delegated runs as what they are (`acting for X`, stoppable), the
  same gap OIDC sessions had.

Verify: retiring a caller then running the cascade kills the token within one call; the delegated
run's own `stopRun` works unchanged; a delegated run does not renew past its caller's ceiling.

## Phase 3: `delegable` grants, which is what removes the ambient authority

A plain intersection cannot narrow the worker, because `grants(worker) INTERSECT grants(caller)` is
a SUBSET of the worker's grants: remove exec's `artifact: read_one` and the delegated run loses it
too. The fix is authority the worker holds only on a caller's behalf.

**Recommended: express it as a PRINCIPAL, not a field.** A grant whose principal is
`delegable:agent:chat-exec` is invisible to every existing lookup, because nothing resolves a
credential to that string: `grantSubject` produces `agent:`/`human:`/`run:` only,
`createAgentDefinition` requires `agent:`/`human:`, OIDC requires `human:`. The mint reads that
second subject in addition to the worker's own and unions it into the worker side of the
intersection.

What that buys over a `delegable: true` field on `GrantDef`: no wire change, no `grantKey` change
(a field would have to enter the key or a delegable and a plain grant with identical
principal/kind/ops/pattern collapse into one registry entry, latest-wins, silently), no change to
`authorize`'s direct path, and it FAILS CLOSED on a build that predates it, where the field
approach silently widens. It reuses the registry, the projection, revocation and
`radia permissions delegable:agent:chat-exec` unchanged. This supersedes the field-vs-kind question
left open in plan-scaling.md 3a.

Costs to pay deliberately: `effectivePermissions("agent:chat-exec")` would omit authority the
worker can reach, so it gains a `delegable` section reading the second subject. And the prefix is a
naming convention, so it needs a guard test that no credential can ever resolve to it.

Phase 3 also raises entitlement from READ to LEASE (1c), because the intersection is no longer a
subset of what the worker holds alone.

Verify: the worker's own token is refused on a delegable grant; a delegated run minted from one
succeeds and is bounded by the caller's pattern; no credential resolves to a `delegable:` principal;
a `delegable:` grant never appears in the worker's own `effectivePermissions.kinds`.

## Phase 4: the chat cutover, which is where the guarantee lands

Two changes, and the second is the point:

1. The TURN WORKER mints a delegated run and emits `tool_call` under it (`runTurnWorker`'s
   `delegate` option), so the record exec claims carries a resolvable caller. It needs no data
   authority to do this: the delegated run exists to carry `actingFor`. This is why relaying
   identity does not require making `message` claimable, which plan-chat-turn.md rejected.

   **Minted from the SEED `llm_call`, not from the triggering message.** The seed is the one record
   in a conversation whose author IS the person; an assistant message is authored by the INFERENCE
   worker, which acks it under its own lease and cannot ack under any other credential. That
   constraint is worth keeping in mind generally: `ack` is performed by the lease owner, so no
   ack-emitted record can carry a delegated author.

2. Exec's grants over session data move to `delegable:agent:chat-exec`. Which ones is narrower than
   this plan first said, and the mechanism decides it rather than caution: a delegated run is
   `worker INTERSECT caller`, so it can never exceed the CALLER, and the session holds no
   `procedure: put` and (since 2026-09-04) `workspace: put` only within its own `{owner}` scope,
   for a person's `git push`. Delegating those would intersect to nothing, or to the caller's own
   scope, and break `save_procedure` and write-back for anything beyond it. So the split is READ
   versus WRITE:
   - delegable: `artifact: read_one`, `workspace: query`, `procedure: query`.
   - exec's own: the `put` half of those three, plus `check`, `capability`, `progress`, `sandbox`,
     `tool_call: take`, and `message`/`tool_result` (both written through `ack`).
   The rule behind the split: a capability the caller lacks can NEVER be delegated, since the
   intersection is a subset of the caller's grants, which is why `check: put` and workspace
   authoring stay on the worker's own token. The two lists are `EXEC_GRANTS` in
   `examples/chat/space/roles.ts`.

   What stays ambient is therefore authoring INTO another session's scope: an integrity reach, not
   a confidentiality one. The cross-user exposure was the read half, and that is closed.

**A read-then-write function needs BOTH credentials, and that is the shape to expect.**
`writeWorkspace` looks up the predecessor and asks whether the tree forked; `commitWorkspace` asks
the fork question too. Under delegation the write half is the worker's and the read half is the
caller's, so both take an optional `reader` defaulting to `client` (every existing caller is
unchanged). Missing one of `writeWorkspace`'s two internal reads produced a `forbidden` three
frames deep in an extension, which is worth knowing before splitting a credential anywhere else:
grep the function for reads rather than trusting its name.

**The tools worker: BUILT, and it split in two rather than being delegated.** `--session-token` is
gone, which is what made a fleet serve one person. The split is forced by the same subset property:

- The inspection tools (`space_*`, `request_grant`, the remediate set) moved into the SESSION
  process (`examples/chat/client/session-tools.ts`). A delegated run can carry neither the ops
  plane (`opsPowers` refuses one outright) nor a self-scoped grant (`intersectGrants` drops it), and
  those two refusals are exactly what these tools need. Both refusals are right, so this set has no
  delegated future and had to move to where the property holds by construction.
- Everything else stays in the worker and reads as the caller through `ToolContext.caller()`, a
  delegated run minted from the claimed record and cached per author-run. `share_artifact` is the
  clearest case: a download capability is authorized at mint time against the CALLER's read grant,
  so minting it as the worker would turn an unreadable artifact into a link needing no token.

Two consequences worth knowing. The session now CLAIMS work, so it needs `interest: put` (without
it `agentLoop` skips publishing and claims nothing, silently) and `tool_call: take` — the latter
scoped by `$in` to the tool NAMES it serves, because a bare `take` would let a session claim its own
`run_javascript` call and write the result, and a `tool_result` has to keep meaning "a worker
produced this". And these tools are served WITHOUT being advertised: one `capability` record per
session per tool would be a registry entry per user for something no other session can claim, so the
client injects the definitions into its own `ToolSet` instead. That is the narrow exception to
"discovered, never hard-coded" — what a process serves is a fact about that process.

**The harness had to change too, and the change is the point.** `smoke-procedures.ts` and
`smoke-runners.ts` wrote their `tool_call` records as the OPERATOR, so every call had a privileged
author and the mint refused them (correctly: an operator has no grant set to narrow to). They now
write as a person, which is what the real fleet does. A privileged caller stays refused rather than
being read as "unrestricted", because with delegable grants that would hand a worker its full
delegable reach on any operator-triggered call.

**A failed mint FALLS BACK, loudly, in both workers.** Throwing was the first design and it is
wrong in each place for its own reason: in the turn worker it kills the whole turn, so one
undelegatable conversation stops advancing instead of one tool call failing; in exec it nacks, and
at-least-once then retries a call that cannot succeed. The fallback is safe because the worker's
own token does not hold the delegable grants, so it still reaches no other session's data, and the
downstream failure is a legible `forbidden` rather than a stall. Both log a line naming the caller:
a silent fallback makes a delegation that did not happen look like a grant bug.

Verify (`deno task test:chat`, which needs no API key): a tool call for conversation A cannot read
conversation B's artifact, asserted through the real fleet; `save_procedure` still works; `check`
is still written by exec as itself; a session whose grants were revoked mid-turn loses the
delegated run's reach on the next mint.

## Phase 5: docs — DONE

`design-auth.md` (the three counter-intuitive properties), `plan-scaling.md` items 3 and 3a,
`architecture-ops-tiers.md` (a delegated run holds NO ops powers, and why that refusal has to come
first), `plan-milestones.md` (M1), `gotchas.md` (four entries: the subset property, read-then-write
helpers needing two credentials, `agent_run` growth, and a harness acting as the operator),
`test/README.md`, `extensions/README.md` (the `reader` split), `sdk/README.md` (the parity
row), the chat's README and CLAUDE.md, plus `docs/authorization.html` for the reader-facing summary.

## The token is DERIVED, because a mint per call is permanent growth

`agent_run` is reserved, so the retention sweep never touches it, and compaction keeps
newest-per-`run`: every distinct run is one row that outlives everything around it. A worker
re-mints whenever its cached credential lapses, and a delegated run deliberately cannot renew
itself, so the first build grew rows in proportion to CONVERSATION-MINUTES (roughly one per active
conversation per run-token lifetime) rather than to how many callers there are. Worse than the disk
cost: `runPrincipalsOf` pages an agent's runs TO EXHAUSTION on every self-scoped authorization and
refuses loudly rather than narrowing, so unbounded growth there eventually breaks an authorization
path for the worker.

The fix is the OIDC mint's own move. The run token is derived from
`(presented worker credential, caller, grant-set digest, ceiling bucket)`, so an unchanged
delegation finds its own run through the indexed `tokenHash` lookup resolution already performs and
writes NOTHING while it is live; expired-but-inside-its-ceiling extends the same run with a
`renewRun`-shaped successor, which compacts back to one row. Growth is now one row per distinct
delegation.

Four details are load-bearing:

- **The grant set is IN the derivation.** A run's authority must stay immutable, because
  `CredentialStore` memoizes it and other instances would otherwise serve a stale, possibly wider
  set from a cold path. A changed intersection therefore derives a different token and becomes a
  different run, never an edit of the old one.
- **Derived from the presented TOKEN, never its hash.** The hash is in a record; anyone who can read
  `agent_run` could otherwise compute a live credential. Holding the plaintext already permits
  minting, so this leaks nothing new — the same argument OIDC makes.
- **A stopped run is never revived**, or the deprovisioning cascade would be undone by the worker's
  next call. Refused as `run_stopped`, matching the OIDC replay path.
- **The ceiling bucket exists so two runs never share a `tokenHash`.** A stop writes a successor
  carrying that hash, so a collision would let stopping one run shadow another.

Guards: "an unchanged delegation REUSES its run" and "reuse never revives a STOPPED run", both
proved red by disabling the derivation.

## Accepted gaps

- **Ceiling-bounded revocation.** A delegated run survives its caller's deprovisioning until the
  cascade runs or the token expires, the same bound OIDC accepted for the same reason.
- **No chain intersection.** This does not supersede the M3 line in design-auth.md. A delegated run
  intersects TWO principals at mint; it says nothing about a chain of five.
- **A grant revoked mid-window still holds for that window.** A worker caches its delegated
  credential, so a narrowing lands at its next mint rather than instantly. The standard
  session-policy trade, and bounded by the run token rather than by the 12h ceiling, because a
  delegated run cannot renew itself.
