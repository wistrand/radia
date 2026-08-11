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

### 2. Fleet concurrency: 2-3 concurrent answers, 5-10 people chatting

`agentLoop` (`sdk/ts/loop.ts`) is strictly sequential: take one record, run the handler to
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

1. **K replicas per tier worker.** Claims are single-winner and `capability` is content-keyed by
   `(provider, tool)`, so replicas are one registry entry and safe by construction.
2. **`concurrency: K` in `agentLoop`.** A handler awaiting a 60s model call is pure I/O wait, the
   worst thing to serialize. Multiplies (1) without more processes and needs no new machinery.
3. **One shared process serving many sessions**, rather than a fleet per user bootstrapping as
   operator.

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
8. **Within-kind routing.** 250 `message` watchers on different conversations still all wake on a
   `message` write. Needs the record's `conversationId` at wake time, which the event does not
   carry: a design question, not a tweak.
9. **Horizontal.** N instances behind a load balancer, which needs the shared blob store first,
   since chat writes artifacts on every attachment and exec output.

**Sizing 1,000 users** (100 concurrently streaming): ~700 records/s, so 2-4 runtime instances;
~10 worker processes at concurrency-10; 5,000 SSE streams sharded across instances; ~60M
records/day, so retention is load-bearing and `eventRetentionSeconds` should be on. The tailer is
MANDATORY at that scale: without it the fan-out alone demands 1.4M queries/s.

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
