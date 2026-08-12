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
3a. **Scope delegation: my capabilities, the caller's identity.** The general form of the problem
   above, and what the shared fleet's SECOND worker will demand. `space_*` can move into the
   session because they are reads the session could make itself; exec cannot (it needs the jail,
   its own permissions, `--allow-run`), yet it runs model-written code ON BEHALF OF a session and
   must not reach past what that session may touch. Images is the same shape, and the marketplace
   (M2) is entirely this shape: a bidder acting for a requester.

   **The axis is capability vs scope, and only one of them delegates.** This was first written as
   "authorize as `grants(worker) INTERSECT grants(caller)`" and that is WRONG, for the same reason
   the hard chain-intersection gate is wrong — it just takes one more step to see. The chat's
   security properties are IMPLEMENTED BY workers holding more than sessions: `EXEC_GRANTS` has
   `check: put` where the session has `query`, so "the code did what was claimed" is never a record
   the model authored about itself, and the same for `procedure` (only exec may write one, so a
   saved procedure always went through the sandbox). Intersecting grant SETS deletes exactly those
   properties, and deletes them in the unsafe direction: to restore function you would grant the
   session `check: put`, which is the thing the design refuses. A worker is setuid-shaped. What it
   holds beyond its caller is the reason it exists.

   | dimension | what it means | whose applies |
   |---|---|---|
   | kind + operations | CAPABILITY: why the worker exists | the WORKER's, always |
   | pattern / scope | WHOSE DATA: what must never be laundered | the CALLER's |

   Both leaks a shared fleet creates are scope leaks, never capability leaks. A shared tools worker
   with an unscoped `message: query` hands user A user B's messages. And user A can ask a shared
   worker to write a body stamped with B's `owner`: today `bodyMatchesGrant` refuses that because
   the write happens AS A (`--session-token`), and with one worker serving everyone that check
   evaporates. So the primitive is: **the worker acts with its own capabilities under the caller's
   identity** — effective uid the worker, real uid the caller.

   - READS: the caller must hold the kind AT ALL (this is what stops A asking a worker to query
     `grant`), and the effective pattern is `worker AND caller` via `combineMatch`.
   - WRITES: the worker's capability stands, and the BODY must satisfy the caller's scope. Exec
     writes `procedure`, but only into A's space.

   Checked against every case this repo has: exec writes `check` for A (capability kept, scope A);
   tools reads only A's messages; A cannot reach `grant`; A cannot write a body carrying B's owner.

   MOSTLY ALREADY BUILT, which is why this is an item and not a research question:
   - `combineMatch` intersects two patterns; it is what grant AND request already does on every
     scoped read, and it is the whole scope half.
   - The delegator is SERVER-KNOWN: the worker claims a record whose `created_by` the runtime
     assigned, so "act under whoever wrote the record I hold a lease on" is verifiable rather than
     asserted. That is usually the dangerous part of delegation, and it is already solved.
   - `delegation_context` (`Space.deriveDelegation`) already records the chain, server-derived from
     the claimed lease and never from data parents.

   What is missing: an opt-in at the call site, and `authorize` applying the caller's scope while
   leaving kind and operations to the worker.

   **This does NOT supersede the M3 chain-intersection line** in design-auth.md. That deferral
   stays: this is a different mechanism aimed at the concrete problem, not the policy arriving
   early. Anyone marking M3 done because this shipped has read it wrong.

   Risks, real and bounded: it sits on the hot authorization path (one extra grant registry read
   per call — indexed, and concurrent identical reads already coalesce), and scope composition
   fails SILENTLY TOWARD OVER-PERMISSION, which is the direction nobody notices. So it gets the
   treatment the grant work already got: `effectivePermissions` must be able to report the
   delegated answer, or the promise is not inspectable before something depends on it. One limit
   worth stating rather than discovering: this works only where the caller's scope is DERIVABLE.
   The chat's grants are pattern-scoped (`{owner}`/`{conversationId}`), so it is; a caller holding
   an UNSCOPED grant delegates an unscoped read, which is correct and still worth knowing.

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
