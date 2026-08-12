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

**The substrate imposes no such rule.** Leases are independently fenced, there is no
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
chunks/s per answer the substrate carries ~440 concurrent streaming answers before writes saturate
one instance. The fleet, not the fan-out, is what stops you reaching that.

### The substrate is nowhere near any of this

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
   Guards: `conformance/loop.test.ts` (K slots fill from one burst; the default still serializes;
   shutdown drains in-flight claims before retiring interests), each proven red.
2. **K replicas per tier worker.** Now largely redundant for WAITING workers, which (1) covers in
   one process: replicas buy true parallelism, which matters for CPU-bound work (exec), not for a
   socket wait. Still the answer for spreading load across machines.
3. **One shared process serving many sessions**, rather than a fleet per user bootstrapping as
   operator. The remaining app-shape item, and the one that makes "N users" a deployment rather
   than N copies of a dev harness. Two decisions inside it, one of which is item 3a:
   - WHO ASSIGNS a session's grants once the session is not an operator. The substrate already
     answers this: the SUPERVISOR carve-out (`space.ts`, `authorize`) may write `grant`/`signal`
     and nothing else, and is mintable since ops-tiers phase 5. A session broker in the fleet runs
     as it. The alternative is assigning at `radia login` time, which needs no component and makes
     onboarding manual.
   - HOW `space_*` keeps running as the caller. Today `tools.ts` takes `--session-token` and acts
     as the one session it was launched for, which is exactly what stops a scoped user laundering
     ops access through a privileged worker. One worker serving many callers cannot do that. The
     near-term answer is to move `space_*` into the SESSION process, where the property holds by
     construction and the plumbing is deleted rather than generalised. It does not generalise, and
     that is item 3a.
3a. **Scope delegation, as a DELEGATED RUN.** The general form of the problem above, and what a
   shared worker needs: act with my own capability, under my caller's reach. `space_*` can move
   into the session because they are reads the session could make itself; exec cannot (it needs
   the jail, its own permissions, `--allow-run`) yet runs model-written code ON BEHALF OF a
   session. Images is the same shape, and the marketplace (M2) is entirely this shape.

   **The shape: mint a narrowed credential, do not annotate every call.**
   `POST /v0/agent-runs/delegated {actingFor: <a record I hold a lease on>}` returns an ordinary
   run token whose authority is `grants(worker) INTERSECT grants(caller)`, computed ONCE at mint.
   The worker then holds TWO credentials and chooses per operation:
   - its OWN token for its own capability. Exec writes `check` as itself, because the verdict IS
     exec's — that is the whole point of the session not having `check: put`.
   - the DELEGATED run for anything touching the caller's data, which is bounded by what the
     caller could reach.

   That is real/effective uid made explicit as two tokens, and the audit shows which was used
   because `created_by` differs.

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

   **What turns the mechanism into a guarantee: REMOVE THE AMBIENT AUTHORITY.** If the tools
   worker keeps unscoped grants on session data, minting a delegated run stays optional and
   someone will forget — setuid's failure mode, exactly. Narrow the worker's OWN grants so it
   cannot read session data as itself, and delegation becomes the only path to it.

   **Already built, which is why this is an item and not research:** `combineMatch` intersects two
   patterns (it is what grant AND request does on every scoped read); the delegator is
   SERVER-KNOWN as the leased record's `created_by`, so it is verifiable rather than asserted; and
   `delegation_context` already records the chain, which is RFC 8693's `act` by another name.

   **Left to decide:** where the attenuation lives — materialized grant records per delegated run
   (many records, but they are records) versus an inline constraint on the `agent_run` body that
   `authorize` ANDs in. The latter looks right: one field and one AND, against intersecting two
   grant sets per request. Mint per (worker, caller) pair and reuse until expiry, never per call,
   which bounds the growth.

   **Do NOT take:** unconstrained impersonation (Kerberos's original mode, Kubernetes' `impersonate`
   verb) — full authority transfer with no attenuation, where the failure mode is total. And
   `may_act`-style caller-declared allowlists are real but a second policy surface to earn later.

   **This does NOT supersede the M3 chain-intersection line** in design-auth.md. That deferral
   stays: this is a different mechanism aimed at the concrete problem, not the policy arriving
   early. Anyone marking M3 done because this shipped has read it wrong.

**Runtime. Changes the scaling law.**

4. **BUILT: kind-aware wakeup** (`notify(kind)`, `src/core/notifier.ts`). 6U -> 2U per write.
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
   staleness window. A broadcast tailer would only be needed if wakeups ever became staggered
   enough that the burst stops overlapping; nothing in the design does that today.
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

## The measurement that is still missing

A chat load test: N simulated sessions against one space, each holding its 5 streams and taking
turns, reporting queries/s and p99 turn latency as N grows. The fan-out harness already parks N
faithful stream loops (`bench/suites/fanout.ts`), so this is an extension of existing scaffolding
rather than new infrastructure. Until it exists, every user-count here is arithmetic over measured
single-op costs, not an observed limit.
