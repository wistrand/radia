# Plan: how many users a space serves, and what raises the number

> Status: analysis 2026-08-11, from source plus measured single-op costs. The three RUNTIME items
> are BUILT the same day: kind-aware wakeup, the `events(xid, seq)` index, and the shared log read
> that removes the O(U) fan-out (measured 2U -> 2 database queries per write, flat to 250 parked
> streams). What remains is app and SDK work, where the first ceiling actually is. Origin: the
> question "how many users can the chat serve", which turned out to have three different answers
> at three different layers.

The measurements behind every number here are in [bench/README.md](../bench/README.md): the
fan-out bench (`bench/suites/fanout.ts`), the 20M log-axis deployment run, and the per-op suites.
Nothing here is a load test: **no end-to-end run with N simulated chat sessions exists**, and that
is the one measurement that would confirm the layering rather than derive it.

## The three ceilings, in the order they bind

### 1. The deployment shape: 1-2 users, and it is not a performance limit

Each `deno task chat` spawns its OWN 9-process fleet (`examples/chat/client/fleet.ts`) and
bootstraps as the space OPERATOR. Ten users is ninety worker processes and ten principals holding
the control plane. That is a dev harness, not a deployment. Every number below assumes a shared
fleet and scoped sessions.

### 2. Fleet concurrency: was 2-3 concurrent answers, now K per waiting worker

FIXED by item 1 below (`concurrency: K`), so this section describes the ceiling as it WAS and why
it bound first. `agentLoop` was strictly sequential: take one record, run the handler to
completion, settle, loop. One inference worker holds one `llm_call` for the whole model response
(5-60s), and the fleet starts ONE worker per tier. Concurrent answers therefore cap at the number
of distinct tiers in flight, realistically 1-2 because the router concentrates traffic. Tool calls
queue behind the single tools worker, code behind the single exec worker.

**The runtime imposes no such rule.** Leases are independently fenced, there is no
max-leases-per-principal (only `maxWatchesPerPrincipal`), and every mechanism a concurrent handler
needs (per-claim lease, heartbeat, fencing epoch) already exists per claim. One-in-flight is a
client harness default, not a design property.

### 3. Watch fan-out: A x U <= ~200 after the kind-aware fix

A session holds 5 SSE streams: `llm_chunk`, `message`, `tool_result` (wakeups) plus `capability`,
`procedure` (registries). `Space.scopeWatch` ANDs the session's grant pattern into every watch, so
a chat watch always carries a predicate, which means every wakeup FETCHES THE RECORD to evaluate
it. Per write, with U users connected:

| | wakeups | getEvents | getRecord | total | 250 streams, measured |
|---|---|---|---|---|---|
| kind-blind (original) | 5U | 5U | U | 6U | 250 + 250, 127ms |
| kind-aware (built) | U | U | U | 2U | 250 + 250, 127ms |
| + shared log read (BUILT) | U | **1** | **1** | **2** | **1 + 1, 2.3ms** |

**The fan-out is no longer a ceiling.** One write now costs two database queries however many
streams are parked, measured flat across 1/25/100/250 watchers (`bench/suites/fanout.ts`), so the
`14 x A x U` term collapses to `14 x A`. What remains per stream is CPU: each still evaluates its
own predicate against the shared record, which is a pattern test on an in-memory object.

The load ceiling that replaces it is the write rate itself (~3.1k puts/s measured), so at ~7
chunks/s per answer the runtime carries ~440 concurrent streaming answers before writes saturate
one instance. The fleet, not the fan-out, is what stops you reaching that.

### The runtime is nowhere near any of this

3.1k puts/s sustained (~440 concurrent streaming answers of write headroom), ~250 claims/s on
Postgres (~2000 users at chat's claim rate), reads flat from 1M to 20M records, and `llm_chunk`
already declares 24h retention (`progress` 1h), swept amortized on the write path.

## What raises the number, in leverage order

**App and SDK, no runtime change. ~3 -> ~30 concurrent answers.**

1. **BUILT: `concurrency: K` in `agentLoop`** (`sdk/ts/loop.ts`). The per-claim block (fenced
   lease, heartbeat, cancellation, settle) was always self-contained, so this is slot bookkeeping
   around it and no new machinery. **Default 1**, so no existing worker changes behaviour; the
   chat opts its waiting workers in, at TWO numbers set by who pays for a slot
   (`examples/chat/client/config.ts`). Inference is PROVIDER-bound and deliberately low (4,
   `RADIA_CHAT_CONCURRENCY`): its handler never nacks, so a rate-limited call does not queue and
   retry, it delivers `[inference error: 429]` into a conversation with the tokens already spent,
   and only the operator knows their account's limit. The router and tools are bound by US and
   cost almost nothing per slot (16, `RADIA_CHAT_LOCAL_CONCURRENCY`): the router holds no API key
   at all (it dispatches a classify `llm_call` and awaits the result, so the fast tier's own limit
   still bounds real model calls) and it sits in front of EVERY turn, so a small number there
   queues turns before they are even classified. EXEC is sized from the MACHINE
   (`min(4, cores - 1)`, `RADIA_CHAT_EXEC_CONCURRENCY`): a jail is a separate OS process so jails
   really do parallelise across cores, but a wall-clock timeout judges the work, so past the core
   count contention turns a passing script into a reported TIMEOUT. Same failure shape as
   inference overshoot, reached by a different route — which is the rule for all four: **where
   something outside the harness judges the work (a vendor's rate limit, a deadline), overshoot
   becomes a visible failure rather than backpressure, so the bound belongs at that resource;
   where only we pay, queueing is the only cost and the number should be generous.**
   Guards: `test/loop.test.ts` (K slots fill from one burst; the default still serializes;
   shutdown drains in-flight claims before retiring interests), each proven red.
2. **K replicas per tier worker.** Now largely redundant for WAITING workers, which (1) covers in
   one process: replicas buy true parallelism, which matters for CPU-bound work (exec), not for a
   socket wait. Still the answer for spreading load across machines.
3. **One shared process serving many sessions**, rather than a fleet per user bootstrapping as
   operator. BUILT 2026-08-13: the operator credential is OPTIONAL, and its absence selects JOIN
   MODE — no bootstrap, no fleet, no privileged read, just the REPL on the person's own token.
   `deno task chat -- --serve` is the other half: set the space up, start the workers, park. The
   privileged work now happens once per deployment instead of once per person, which is what "N
   users" required. Guard: `examples/chat/smoke-join.ts`, which asserts both halves — a joining
   session starts its own thread and takes turns, and cannot register a kind, mint a worker, grant
   itself anything, reach the ops plane or enumerate another conversation.
   Two decisions were inside it. One is settled; the other was DEFERRED by taking the cheaper
   branch, and is the piece still outstanding:
   - WHO ASSIGNS a session's grants once the session is not an operator. Answered in two halves,
     both built. MANUALLY: `examples/chat/grant-user.ts <principal>` writes the grant records and
     deliberately no `agent_definition`, so an SSO identity gains no durable credential and IdP
     deprovisioning still bites within one run ceiling; a session that has not been let in prints
     that exact command, principal included, because it is the one thing that knows its own
     principal and an SSO one is 32 hex characters nobody retypes. AS A POLICY:
     `--serve --auto-grant` (the generic sweep is `extensions/ts/enrolment.ts`, which the chat and
     the analysis example both parameterise with their own grants) assigns the standard set as each
     identity enrols. Opt-in, because it converts "authenticated" into "authorized", which the
     runtime deliberately refuses to decide for you.
     Two properties make the policy safe to leave running, and both are guarded by tests proved red
     by a plant: a RETIRED mapping is never granted (`activeByKey` drops it, so retire-as-ban still
     works and is the ONLY way to keep someone out once the flag is on — revoking grants lasts
     until the next sweep), and a principal already holding something is never touched, because
     `RadiaClient.grant` REVIVES a retired grant and a blind re-assign would undo an operator's
     narrowing. The plant restored all 19 grants over a deliberate one-grant narrowing.
     The second property has a cost worth knowing: a power added on a LATER run reaches nobody
     already admitted, because the sweep never looks at them again. Anything meant for everyone
     enumerates `enrolledPrincipals` rather than riding the sweep.
     What is still open is the self-service case for a space with no administrator at all: a
     session broker on the SUPERVISOR identity, which may write `grant`/`signal` and nothing else
     and is mintable since ops-tiers phase 5. Note the interaction if it is built:
     `mintDelegatedRun` refuses a supervisor agent outright, so a broker can assign grants but can
     never delegate — fine for one that only writes grants, and a trap if it grows a second job.
   - HOW `space_*` keeps running as the caller. SETTLED, and the near-term answer was the right one
     for a reason nobody had yet: those tools read the ops plane, and a delegated run holds NO ops
     powers and drops self-scoped grants, so no worker can ever serve them for somebody else. They
     moved into the SESSION process (`client/session-tools.ts`), `--session-token` is deleted, and
     the rest of the tools worker reads as the caller through a delegated run. Delegation was always
     the answer for data reads and never for inspection. See plan-delegation.md phase 4.
3a. **BUILT (2026-08-12): scope delegation, as a DELEGATED RUN.** The general form of the problem
   above, and what a shared worker needs: act with my own capability, under my caller's reach. The
   build record is [plan-delegation.md](plan-delegation.md), including where it changed this
   design; the reasoning and the rejected alternatives stay here. `space_*` can move
   into the session because they are reads the session could make itself; exec cannot (it needs
   the jail, its own permissions, `--allow-run`) yet runs model-written code ON BEHALF OF a
   session. Images is the same shape, and the marketplace (M2) is entirely this shape.

   **The shape: mint a narrowed credential, do not annotate every call.**
   `POST /v0/agent-runs/delegated {for: <a record naming the caller>}` returns an ordinary run
   token whose authority is `grants(worker) INTERSECT grants(caller)`, computed ONCE at mint, and
   whose `agent_run` body carries `actingFor: <the caller>`. The worker then holds TWO credentials
   and chooses per operation:
   - its OWN token for its own capability. Exec writes `check` as itself, because the verdict IS
     exec's, which is the whole point of the session not having `check: put`.
   - the DELEGATED run for anything touching the caller's data, which is bounded by what the
     caller could reach.

   That is real/effective uid made explicit as two tokens, and the audit shows which was used
   because `created_by` differs.

   **Who the caller IS: resolve through the RUN, never through a body field.** The mint's argument
   proves ENTITLEMENT; it does not name the caller. Getting that resolution right is most of the
   feature, and the three obvious sources all fail against the chat's actual topology:
   - the leased record's `created_by`. The `tool_call` exec claims is written by the TURN WORKER
     (`extensions/ts/turn.ts`, a keyed put), so this names `agent:chat-turn`, and intersecting with
     `TURN_GRANTS` (`message` read, `llm_call`, `tool_call: put`, `turn_complete`, `cancel`) yields
     nothing on `artifact`, `workspace` or `procedure`. Exec fails closed and cannot do its job.
   - `body.owner`. Names the person, and is UNCONSTRAINED: `tool_call: put` in `TURN_GRANTS` carries
     no pattern, so the turn worker may emit a call naming anyone. Authority from an unconstrained
     body value is "provenance is not authority" wearing a different hat.
   - `delegation_context`. The right source, and absent at this hop. It is derived at exactly one
     site (`Space.deriveDelegation`, called from inside `ack`), so lease-emitted work carries a
     chain and a plain put never does, and the turn worker's links are keyed puts by the deliberate
     choice recorded in plan-chat-turn.md.

   What works is already in the shape of the data: **`created_by` names the RUN**, not the agent
   (`resolveCredential` returns `principal: b.run`, and `http.ts` passes it through), and a run is
   a record. So put `actingFor` on the `agent_run` body and caller resolution is transitive:

       caller(R) = run(R.created_by).actingFor ?? grantSubject(R.created_by)

   One indexed read, no walk: `actingFor` holds a resolved caller, never another run. The turn
   worker holds its own delegated run for the session, so the `tool_call` it emits is authored by
   that run, and exec resolving through it lands on the person. Every hop is server-derived; the
   worker asserts nothing beyond naming a record it may already reach.

   **Entitlement to mint, in two rules, because they rest on different things.** A pure narrowing
   (`grants(worker) INTERSECT grants(caller)`) needs only READ on the naming record: the result is
   a subset of what the worker already holds, so it can gain nothing. That is the turn worker's
   case, and it is why relaying identity does not require making `message` claimable, which
   plan-chat-turn.md rejected. Exercising a DELEGABLE grant (below) needs a LEASE on the naming
   record, because that is authority the worker cannot use alone, so the caller's request must be
   one it actually claimed. Exec holds the `tool_call`'s lease and qualifies.

   **Why not holes filled at call time** (the first two drafts of this item, both rejected).
   Passing `actingFor` on every request, or templating a grant pattern with `$caller` /
   `$record.owner`, both make a grant a statement completed at check time. PostgreSQL RLS shows
   that CAN work (`USING (owner = current_user)`), but note what makes RLS tolerable: it binds one
   well-known variable, not arbitrary fields of a triggering record. The general form is a small
   template language living inside a frozen wire contract, it puts `actingFor` on every verb, and
   it turns `effectivePermissions` from a list into a two-principal matrix — in a codebase where
   every grant bug so far was a promise that did not match enforcement, and the antidote was
   keeping permissions inspectable.

   **Prior art converges on the credential, not the annotation.** AWS STS `AssumeRole` with a
   session policy: effective = role policy INTERSECT session policy, computed at issuance, short
   lifetime, plus permissions boundaries as a separate ceiling. OAuth 2.0 Token Exchange
   (RFC 8693): an intermediary exchanges subject+actor tokens for a new one carrying an `act`
   chain, scopes narrowed at exchange. Kerberos constrained delegation (S4U2Proxy), whose whole
   evolution ran unconstrained impersonation -> declared targets -> the RESOURCE declaring who may
   act for it. Macaroons and Biscuit: attenuation-only tokens any holder may narrow and none may
   widen. Three independent mature systems reached the same answer, because a credential can be
   named, inspected, logged, expired and revoked, is computed once so cost and failure land at one
   point, and leaves every call site ignorant of delegation.

   **Why it fits here specifically:**
   - A run is already a RECORD, so this needs no new lifecycle: `radia query agent_run` inspects
     it, `stopRun` revokes it, `runMaxLifetimeSeconds` expires it.
   - `effectivePermissions` STAYS A LIST. Ask the delegated run and the answer is flat.
   - No change to `query`/`take`/`ack`/`put`: the authority is in the token, so one mint endpoint
     is the entire wire surface.
   - It mints into the existing bootstrap chain rather than adding a parallel credential model,
     the same rule OIDC followed.
   - The precedent is in this repo already: download capabilities are "delegation of a read the
     holder already had... authority that narrows as it travels, never widens" (design-auth.md),
     scoped to one object and expiring. A delegated run is that principle at record scope.
   - The cross-product of two pattern disjunctions is paid ONCE at mint, and an explosion fails
     there with a clear message instead of mysteriously at some later query.
   - "The caller holds no grant on this kind" stops being a hole: the delegated run simply cannot
     do it, which is correct, and the worker does it with its own token, deliberately.

   **What turned the mechanism into a guarantee: REMOVING THE AMBIENT AUTHORITY** (done; the
   reasoning is kept because it is the part that generalises). `EXEC_GRANTS`
   (`examples/chat/space/roles.ts`) held five UNSCOPED grants over session data, so one shared exec
   worker read every user's tree and minting a delegated run stayed optional. Somebody forgets,
   which is setuid's failure mode exactly. This half was larger than the endpoint, and until it
   landed the delegated run was decoration.

   It also cannot be done by plain narrowing, and that contradiction had to be resolved first:
   `grants(worker) INTERSECT grants(caller)` is a SUBSET of the worker's own grants, so removing
   exec's `artifact: read_one` empties the intersection and the delegated run cannot read the
   attachment either. The resolution is authority only a delegated run may exercise, held under a
   `delegable:<agent>` principal nothing can authenticate as: exec's own token cannot touch session
   data, the delegated run can, and the caller's pattern bounds it. That is AWS's role/principal
   split, a container of authority you can only exercise by assuming it. (A `delegable: true` FIELD
   was the shape first drafted here; plan-delegation.md phase 3 records why the principal beat it.)
   `effectivePermissions` must render it MARKED, or it is one more promise that does not match
   enforcement.

   **Whose identity the delegated run carries: the WORKER's.** The alternative is minting under the
   CALLER's agent, attenuated by the worker's grants, so `created_by` names the person and
   delegation chains through `grantSubject` with no new field. Rejected on three costs and a
   decider that does not hold:
   - `computeTaint` compares `grantSubject(createdBy) !== grantSubject(writer)`
     (`src/core/space.ts`), so a worker writing as its caller stops tainting its output `foreign`.
     A barrier label disappears quietly, in the one place anything reads it.
   - Idempotency is scoped to the agent behind the caller (audit Package U), so two workers
     delegated for one caller SHARE that namespace. The turn worker's keys are derived from record
     ids (`turn:${id}`), which a second worker delegated for the same caller can derive too.
   - Every view attributes by author, so output written by model-written code would render as
     authored by the person.
   - The decider offered for it was revocation, and it does not hold. `revokeDefinition` leaves
     runs alive ON PURPOSE ("Existing RUNS are untouched", `src/core/space.ts`) and
     `resolveCredential` checks the run's own `status`/`expiresAt`, never its definition's, so
     deprovisioning bounds by the ceiling under EITHER identity. The property actually wanted is
     that delegated runs are ENUMERABLE by caller, and an indexed `actingFor` gives it directly:
     `query agent_run{actingFor, status: "active"}` then `stopRun` each, the shape `remediate`
     already uses for leases.

   **Guard the two shortcuts BEFORE building either half.** `authorize` returns `null` for a
   privileged principal before reading any grant, and again for the supervisor's `grant`/`signal`
   carve-out, which keys on `grantSubject(principal)`: the AGENT, not the run. An inline
   attenuation is skipped by both. Item 3's first decision puts the session broker on the
   supervisor identity, and the supervisor is MINTABLE (`createAgentDefinition` refuses
   `isPrivileged`, which covers operators and the space's own principal but not `ctx.supervisor`;
   its error message says otherwise and is stale). So the MINT refuses a privileged or supervisor
   agent outright rather than trusting `authorize` to catch it, and the planted regression is two
   tests: an attenuated run of each must reach neither shortcut.

   **Already built, which is why this is an item and not research:** `combineMatch` intersects two
   patterns (it is what grant AND request does on every scoped read); `created_by` names the RUN,
   so the credential behind any record is itself a readable record; and `delegation_context` is
   RFC 8693's `act` chain by another name, for the lease-emitted half.

   **Decided in the build:** the attenuation is INLINE on the `agent_run` body (a delegated run
   reads no grant record at all), and `delegable` is neither a field nor a kind but a PRINCIPAL,
   `delegable:<agent>`, which nothing can authenticate as. Both in plan-delegation.md with the
   alternatives they beat.

   **Do NOT take:** unconstrained impersonation (Kerberos's original mode, Kubernetes' `impersonate`
   verb) — full authority transfer with no attenuation, where the failure mode is total. And
   `may_act`-style caller-declared allowlists are real but a second policy surface to earn later.

   **This does NOT supersede the M3 chain-intersection line** in design-auth.md. That deferral
   stays: this is a different mechanism aimed at the concrete problem, not the policy arriving
   early. Anyone marking M3 done because this shipped has read it wrong.

**Runtime. Changes the scaling law.**

4. **BUILT: kind-aware wakeup** (`notify(kind)`, `src/core/notifier.ts`). 6U -> 2U per write. A
   write of kind K wakes only the streams watching K plus the any-set (kindless watchers); a write
   of an authorization kind and the cross-instance poll wake everyone, since either can change what
   any stream is allowed to see.
5. **BUILT: `idx_events_xid_seq`.** Each of those log reads was a whole-log scan+sort (2005ms at
   20M events); now a tail index scan, and no longer degrading with history.
6. **BUILT: the shared log read** (`src/core/coalesce.ts`). Read the log ONCE per write, fetch the
   record ONCE, evaluate every stream's predicate IN MEMORY: 2U -> 2 queries, O(U) -> O(1).
   Implemented as SINGLE-FLIGHT COALESCING rather than a broadcast tailer, and the reason is worth
   keeping: a tailer must place a subscriber's cursor in its ring, and cursors are deliberately
   opaque and unordered (an xid8 decimal string on Postgres, a seq on SQLite), so there is no
   correct comparison to do it with. Coalescing needs none: `notify()` resumes every parked stream
   in the same tick, so their identical reads overlap by construction and collapse into one. It is
   not a cache (an entry lives only while its read is in flight), so there is no TTL to tune and no
   staleness window. A shared record fetch is still authorized PER STREAM: single-flighting the read
   never shares the verdict. A broadcast tailer would only be needed if wakeups ever became staggered
   enough that the burst stops overlapping; nothing in the design does that today. Measured in
   `bench/suites/fanout.ts`: 2 queries per write however many streams are parked.
7. **Expose `--pool-size` and cache auth per epoch.** Eight connections is the hard cap on
   concurrent DB work and is not reachable from the CLI today; ~3 round trips precede every
   request's real work.
8. **Within-kind routing: MEASURED AND DEFERRED**, see the section below. 250 `message` watchers
   on different conversations still all wake on a `message` write, but after coalescing that costs
   ~9µs per stream and is invisible on Postgres. Not worth its failure mode until `A x U` is around
   10,000.
9. **Horizontal.** N instances behind a load balancer, which needs the shared blob store first,
   since chat writes artifacts on every attachment and exec output.

**Sizing 1,000 users** (100 concurrently streaming): ~700 records/s, so 2-4 runtime instances;
~10 worker processes at concurrency-10; 5,000 SSE streams sharded across instances; ~60M
records/day, so retention is load-bearing and `eventRetentionSeconds` should be on. The shared log
read is what makes that reachable at all and it is BUILT: without it the fan-out alone would have
demanded ~1.4M queries/s at those numbers.

## Within-kind routing: measured, deferred (2026-08-11)

The idea: 250 streams watching `message` on different conversations all wake on one `message`
write, so wake only the ones whose predicate matches. The proposed mechanism was to carry the
kind's declared indexed-path values in the notify payload (same process) and in the event row
(cross-instance).

**What it would save, measured.** Post-coalescing, per-write cost as same-kind streams scale
(`bench/suites/fanout.ts`):

| streams | sqlite p50 | pglite p50 |
|---|---|---|
| 1 | 618µs | 2.4ms |
| 25 | 950µs | 3.4ms |
| 100 | 1.3ms | 2.8ms |
| 250 | 2.9ms | 2.3ms |

Flat on pglite: the database round trip swamps everything, so 249 extra streams cost nothing
measurable. Visible on sqlite only because its reads are fast: `(2.9 - 0.62) / 249` = **~9µs per
stream per write**, which is a promise resolution, an array iteration and one `matchesRecord`
against an already-in-memory record. On Postgres, the deployment target, that residual is below
the noise of a single query.

**Where it would start to matter.** CPU/s is about `7 x A x U x 9µs`: 6% of a core at A=10/U=100,
63% at A=10/U=1000, and impossible at A=100/U=1000 — which is also 700 writes/s, at or past one
instance's write ceiling, so that scale needs sharding anyway and sharding divides U per instance.
The crossover is roughly `A x U` around 10,000, and it arrives with a cheaper answer attached.

**The two halves of the mechanism are not equal.**
- The same-process notify payload is genuinely cheap: `putRaw` holds the record, so passing its
  indexed values costs no serialization and no storage. It buys nothing on its own, though: the
  win needs a watcher INDEX bucketed by equality predicates, or the N predicate tests just move
  from wake time to notify time.
- The event-row column should not be built. Events are 259 bytes and 20M of them made a 24GB
  database, so it is a permanent width cost on the highest-volume table, paid by single-instance
  spaces that gain nothing. It is redundant (the values are in the record, which the reader
  fetches once, coalesced). And the cross-instance path it would serve is rate-limited by the
  250ms poll rather than by the write rate: at most ~4 wake-alls/s whatever the other instances
  write, ~36ms/s of CPU at U=1000. Foreign kind-blindness is a LATENCY property, not a scaling one.

**The risk that dominates the saving.** Under-waking is a stall, not a slowdown: a stream that is
not woken waits out its 15s keepalive, which looks like a hang and is invisible to any test with a
short timeout. Kind-aware routing is safe because kind equality is a structural invariant of the
matcher (`matchesEvent` returns false on a kind mismatch before anything else). A value index has
no such guarantee and must be provably at least as permissive as the matcher, so non-indexed
paths, `$or`, `$exists`, taint scope and the `createdBy` restriction all have to fall into a
wake-always bucket. That is tractable, and it is real complexity in the hot path whose failure
mode is silent.

**What would change the answer:** a deployment with U in the thousands on one instance, showing
the fan-out bench's same-kind row rising off the floor. That bench already measures exactly this
(each watcher watches its own conversation; one matches), so the evidence needs no new
scaffolding. Ranked against the alternatives at that scale, shard instances first (needed for
writes anyway), then drop the two registry streams, then consider this.

## Rejected, and why

- **Dropping the `capability`/`procedure` streams for fan-out.** It was a real ~40% cut while
  `notify()` was kind-blind (every write woke all five). Kind-aware wakeup already ate that
  benefit: a message write never wakes them now, so dropping them buys two fewer connections per
  user, not fewer queries. Recorded so the pre-fix claim is not carried forward.
- **Setting retention on `llm_chunk`/`progress`.** Already set (24h and 1h).
- **Per-request JWT-style stateless auth to save round trips.** Same objection as OIDC's: fencing,
  lease ownership, idempotency scope and the event log's `runId` all key off run identity.

## The chat load test: TAKEN (2026-08-12), `bench/suites/chatload.ts`

N sessions against one space, five parked streams each, all taking turns through one shared
inference worker. Scoped principals rather than the privileged default, so every verb pays its
grant read; the turn is the real record chain (put `message`, put `llm_call`, take, 20 `llm_chunk`
puts, ack the assistant `message`), and each stream runs the SSE handler's own loop body. In
process, so latency is a floor.

|  N | streams | sqlite turns/s | p50 | pg turns/s | p50 | q/turn |
|---:|--------:|---------------:|----:|-----------:|----:|-------:|
|  1 |       5 |            113 |   9ms |          9.6 |   105ms | 126 |
|  5 |      25 |            161 |  29ms |         11.1 |   458ms | 122 |
| 20 |     100 |            133 | 149ms |         10.0 |  1978ms | 123 |
| 40 |     200 |             77 | 487ms |          8.2 |  4447ms | 122 sqlite / **344 pg** |

**A turn costs ~122 database queries, and that holds to 100 streams.** Flat from 1 to 20 sessions
on every adapter, and to 40 on sqlite: per turn the counters read ~22 puts, ~22 `getEvents` and ~24
`getRecord`, which is ONE log read and ONE record fetch per WRITE rather than per stream. The
fan-out fix is confirmed under a real workload rather than inferred from a microbench.

**Then it breaks, and where it breaks is the interesting part.** 40 sessions on live Postgres cost
**344** q/turn, and the excess is entirely one column: `getRecord` goes from 24 per turn to 242,
while puts (22), `getEvents` (25) and grant reads stay exactly where they were. Nothing regressed
in the coalescer. Single-flight collapses reads that are IN FLIGHT TOGETHER, and at 200 streams on
a store slow enough to queue, wakeups stop arriving in the same tick: with full collapse a turn
fetches 22 records and with none it fetches 880, and 242 is the middle of that range.

This is the condition `src/core/coalesce.ts` names as its own limit — "a broadcast tailer would only
be needed if wakeups ever became staggered enough that the burst stops overlapping; nothing in the
design does that today". Something does, and it is load rather than design: the stagger is caused by
the queueing, and the queueing is caused by the slow store. So the tailer is not needed yet, but the
trigger for it is now a measured number instead of a hypothetical — `A x U` around 200 on a store
whose turns are already seconds deep.

**Throughput is flat and latency is queueing.** Every row satisfies `turns/s × p50 ≈ N`: the
system is saturated at N=1, so adding sessions adds waiting rather than work. The per-instance
ceiling is ~130 turns/s on embedded sqlite and ~10 on a live Postgres, single process. At 22 puts
per turn that is ~2.9k puts/s, which lands on the 3.1k puts/s measured independently in
`bench/deployment.ts` — the write rate really is the binding constraint, as this doc predicted.

**What the number is made of.** Of ~122 queries: 22 puts, 46 fan-out reads, ~24 grant reads (one
`authorize` per write, which is one per REQUEST in production and therefore correct rather than
waste), and ~23 clock reads — `storage.now()`, once per write.

**The clock is NOT worth fixing, and the reason is a trap worth naming.** 23 of 122 queries is 19%
of the count, so moving the stamp into the insert looked like the cheapest win available. Measured
instead of reasoned — same sweep, `now()` replaced by a host clock so the round trip disappears
entirely — it is worth **~2%** of turn latency (390ms → 382ms at N=4, 771ms → 753ms at N=8; the
N=1 delta is inside a 16% run-to-run variance and says nothing). The 19% estimate came from dividing
total latency by total query COUNT and attributing that average to the cheapest query class:
`select now()` is nothing beside a put, which is a transaction writing a record row, a runtime row
and an event row. **Never size a query class by the mean cost of all classes** when they differ by
an order of magnitude. A `StorageAdapter.put` contract change across three adapters, touching the
timestamps that ordering, retention, leases and the event chain all rest on, is not a 2% trade.

**What this does NOT measure.** One process drives the sessions, the streams, the worker and the
space, so the absolute throughput is a floor and the latency includes the harness's own event loop.
HTTP, SSE framing and the provider are all absent. What it does measure honestly is the SHAPE:
queries per turn against N, which is the term a second instance would divide.

That caveat cuts both ways on the 344 row. A real deployment puts the sessions in other processes,
which removes this harness's own event-loop contention and may keep the wakeups overlapping longer
— or it adds network jitter and staggers them sooner. Nothing here can tell which, and the honest
statement is that the collapse is load-dependent rather than that it fails at 200 streams.
