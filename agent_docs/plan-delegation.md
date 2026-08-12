# Delegated runs: acting with my own capability, under my caller's reach

The build plan for [plan-scaling.md](plan-scaling.md) item 3a, which holds the design and the
rejected alternatives. Read that first; this file is the sequence, the seams and the guards.

**Status: PLANNED.** Nothing below is built.

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
already folds a run's successors and is the read to extend.

### 1c. Entitlement

Phase 1 mints a PURE NARROWING, so the naming record only needs to be READABLE by the worker: the
result is a subset of what the worker already holds and can gain it nothing. Phase 3 raises this to
a LEASE, because a delegable grant is authority the worker cannot use alone. Implement the read
check as the ordinary `readAccess` path, so a worker cannot mint for a caller whose records it
cannot see.

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

### 1e. Enforcement: one seam, three call sites

`authorize`, `readAccess` and `effectivePermissions` all begin by reading the grant registry for
`grantSubject(principal)`. Add one helper they share:

    private async grantsFor(principal, kind): Promise<{entries, complete}>

which returns the delegated run's inline grants when the principal is one, and the registry view
otherwise. `constraintFrom` then works unchanged, because inline grants are already `GrantDef`s.

**The fail-open to design against.** If `grantsFor` cannot tell that a run is delegated, it falls
through to the WORKER's full grants. `resolveCredential` reads the run body on every request and
already calls `creds.rememberRun(run, agent)`, so extend that memo entry to carry the delegation
and the authenticated path is always warm. The cold path is real and must be handled: `ack`
authorizes the LEASE OWNER, which may be a run this process never authenticated, so `grantsFor`
falls back to `runRecord` exactly as `Space.agentForRun` already does. A cold miss must never
resolve to the agent's grants.

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

`deno task quick` (openapi round-trip), then a new `conformance/delegation.test.ts`:
the two phase-0 plants; the intersection is a strict subset of the worker's authority on every
kind; a caller's pattern actually binds the delegated run's reads; a kind the caller lacks is
refused; a kind the WORKER lacks is refused; the ops plane is refused; `effectivePermissions` of
the delegated run is a flat list matching what it can actually do; a cold-memo `authorize` on a
delegated run (simulating `ack` by another instance) does NOT fall back to the worker's grants.

## Phase 2: enumerate and revoke before relying on it

`revokeDefinition` deliberately leaves runs alive ("Existing RUNS are untouched"), and
`resolveCredential` checks the run's own `status`/`expiresAt`, never its definition's. So a
delegated run outlives its caller's deprovisioning up to the ceiling unless something stops it.

- `radia runs --acting-for <principal>`: an indexed `agent_run{actingFor, status: "active"}` query.
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

1. The TURN WORKER mints a delegated run for the session and emits `tool_call` under it, so the
   record exec claims carries a resolvable caller. It needs no data authority to do this: the
   delegated run exists to carry `actingFor`. This is why relaying identity does not require making
   `message` claimable, which plan-chat-turn.md rejected.
2. `EXEC_GRANTS` (`examples/chat/space/roles.ts`) holds five UNSCOPED grants over session data:
   `artifact: put/read_one`, `workspace: query/put`, `procedure: put/query`, `message: put`,
   `tool_result: put`. Each becomes a grant for `delegable:agent:chat-exec`. Exec's own token keeps
   `check: put`, `capability`, `progress`, `sandbox` and `tool_call: take`.

Until (2) lands, one shared exec worker reads every user's tree and delegation is decoration. This
phase is larger than the endpoint. `agent:chat-tools` follows the same treatment, at which point
`--session-token` (`examples/chat/workers/tools.ts`) is deleted rather than generalised.

Verify (`deno task chat-test`, which needs no API key): a tool call for conversation A cannot read
conversation B's artifact, asserted through the real fleet; `save_procedure` still works; `check`
is still written by exec as itself; a session whose grants were revoked mid-turn loses the
delegated run's reach on the next mint.

## Phase 5: docs

`design-auth.md` (the delegation section already points here), `plan-scaling.md` item 3a marked
BUILT with the phase record, `architecture-ops-tiers.md` if the ops-power refusal changes its
table, CLAUDE.md's `src/core` and reserved-kind touchpoints, and this file's status line.

## Accepted gaps

- **Ceiling-bounded revocation.** A delegated run survives its caller's deprovisioning until the
  cascade runs or the token expires, the same bound OIDC accepted for the same reason.
- **No chain intersection.** This does not supersede the M3 line in design-auth.md. A delegated run
  intersects TWO principals at mint; it says nothing about a chain of five.
- **Per-pair minting is a cache.** Mint per (worker, caller) and reuse until expiry. A grant revoked
  mid-window still holds for that window, which is the standard session-policy trade and worth
  stating rather than discovering.
