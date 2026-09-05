# Benchmarks

The benchmark suite measures runtime latency, throughput, scaling curves and storage-query costs.
It reports measurements without pass/fail thresholds.

```bash
deno task bench                          # every suite, both embedded adapters (~3 min)
deno task bench -- --suite lineage       # one suite
deno task bench -- --adapter sqlite      # one adapter
deno task bench -- --scale 4             # 4x iterations: slower, steadier
RADIA_PG_URL=postgres://… deno task bench    # adds a live Postgres column

deno run -A bench/deployment.ts --url http://127.0.0.1:7899   # a real server, over HTTP
```

Scaling suites account for most of the run time because they populate spaces with up to 40,000
records. Use `--suite` for focused iteration and the full run for before/after comparisons.

On the same machine, changes below ten percent should be treated as noise unless repeated runs
confirm them.

## How to read the numbers

The main suites measure the core and one in-memory storage adapter in a single process. They omit
HTTP, network latency and fsync, so they are useful for implementation comparisons but not
deployment capacity planning: an in-process number is a floor for latency and a ceiling for
throughput. `deployment.ts` measures a running server over HTTP. Nothing here asserts; a bench
prints, and a regression is read off the table by a person.

Every row carries p50/p95/p99 rather than a mean, because the tail is what a stalled agent
feels. Scaling suites re-measure the *same* operation as the space fills; a rising p50 with a
constant result size is the signal.

## Layout

| File | Role |
|------|------|
| `run.ts` | entry point: flags, adapter selection, table output |
| `harness.ts` | timing, percentiles, table rendering, per-bench fresh space |
| `suites/records.ts` | put, read_one, query, predicate complexity |
| `suites/claims.ts` | take/ack, ack-with-result, and contention across 1/4/16 claimers |
| `suites/lineage.ts` | `childrenOf` and `getLineage`, the documented hotspot, measured |
| `suites/scale.ts` | the same operations re-measured at 2k / 10k / 40k records |
| `suites/blobs.ts` | artifact bytes, and what encryption costs |
| `suites/graph.ts` | `getGraph` (the console's Graph/waterfall walk) over a conversation-shaped DAG: bounded by the answer, not the space |
| `suites/gc.ts` | what housekeeping costs: the retention sweep, registry compaction, and the phase-4 blob pass |
| `suites/oidc.ts` | the one UNAUTHENTICATED write path: what a rejected flood costs vs a first login vs a replay |
| `suites/fanout.ts` | the watch fan-out: queries one write triggers as N streams park, counting the kind-blind `notify` tax directly |
| `suites/chatload.ts` | N chat sessions against one space, five parked streams each, taking real turns through one shared worker. Reports turns/s, p99 turn latency and QUERIES PER TURN as N grows, the column that decides whether the shape scales and the one that caught coalescing decaying at 200 streams on a queueing store (plan-scaling.md); `CHATLOAD_DEBUG=1` prints the per-method breakdown that says which term moved |
| `profile.ts` | `deno task profile <script> [args…]`: CPU-profile any workload with zero external tooling (see Profiling below) |
| `deployment.ts` | standalone: one space over HTTP against whatever storage it was started with, re-measured as it fills. Takes a `--url` instead of an adapter, so it measures the thing the suites above cannot. **It writes records and cannot delete them**; point it at a throwaway space |
| `baselines.ts` | standalone: plan-validation.md's BASELINES. One pipeline workload run three ways (static orchestration, a plain worker queue, content-routed) over the same storage, measured clean, with a worker death, and with work of an unforeseen shape. `deno task bench:baselines [-- --items N]` |
| `edit-cost.ts` | standalone: what an edit costs versus rewriting a tree, in emitted characters and in records written. Not a timing suite, so it is run directly rather than through the harness |

## What the first run found

Measured on one developer machine, sqlite in-memory, scale 1. Absolute numbers will differ;
compare the **shapes** down a column, not the values.

**Matching used to be a scan, and that was the limit.** The first run measured the cost of
deferring predicate pushdown, and the numbers were the argument for building it:

| operation (sqlite, 40k records) | first run | now |
|---|---|---|
| `put` | 47µs | 42µs |
| `read_one` on an indexed path | 102ms | **29µs** |
| `query limit=25` on an indexed path | 102ms | **147µs** |
| `take` matching an indexed path | 183ms | **1.2ms** |

`read_one` got faster, and it also became **flat**: 31µs at 2k, 32µs at 10k, 29µs at 40k, where
before it grew linearly with the space. Postgres tells the same story: `read_one` at 40k went
513ms → 732µs. Two findings from the original run drove this and still hold: every
predicate shape cost the same (equality, `$gt`, `$or`, and a match that hits nothing were within
noise of each other), and `read_one` was no faster than `query limit=100`, since both scanned the
kind and both materialized every match to return one record.

**That flatness needs `idx_records_kind_id`, a `(kind, id)` index, and it regressed once already.** A
pushed `LIMIT` only helps if the database can produce rows in id order without reading the whole
kind first, and SQLite's primary key alone does not do that: `where kind = ? … order by id limit N`
plans as USE TEMP B-TREE FOR ORDER BY, sorting every record of the kind before the limit applies.
`read_one` was back to 12.0ms at 40k, growing linearly, exactly the shape this section says was
fixed. `idx_records_kind_id (kind, id)` turns it into an ordered seek that stops at the Nth match:
12.0ms → 0.05ms, flat again. Postgres has the same index for a different reason (`idx_records_id_c`,
byte-order ids), which is why only the SQLite side drifted, and why a claim about the SHAPE of a
number is re-run, not trusted.

**The planner takes an index only when its statistics say so, and on PGlite they were gathered once, on an empty table.** A
2026-09-05 rerun of the growth suite read PGlite `read_one` at 744µs, 2.1ms and 7.7ms across 2k,
10k and 40k records while Postgres stayed near 190µs: the same query, planned on statistics gathered
when the kind was declared on an empty table. EXPLAIN at 40k showed a GIN bitmap over 2,858 matches
and a sort; after one ANALYZE (150ms) the same read walked `idx_records_id_c` to the first match,
8.7ms to 0.47ms through the space. Postgres autoanalyzes within a minute of 10% growth; PGlite has no
autovacuum, so the adapters now analyze on that rule themselves (`PgSqlAdapter.maybeAnalyze`):
re-measured, PGlite `read_one` reads 399µs, 358µs and 349µs across the same three sizes, and
`query 25` 611µs, 577µs and 563µs.
The same rerun found nothing else moved: SQLite `put` 53 to 56µs and `read_one` 31 to 35µs across
the sizes, chat load at 122 to 127 queries per turn to 100 streams, and the HTTP fill at 3.0k puts/s.

The speedup came from two separate changes. The
GIN index over record bodies is *not* used for the benchmark's predicate at all: "rare" matches
1 record in 7, far too many for an index to beat a scan. The win is that an **exact** filter
lets the caller's `LIMIT` move into SQL, so the scan stops at the first match instead of
materializing 5,700 rows to return one. The index helps on selective matches
(1 row in 40k measured at 7.98ms without it, 1.42ms with), which is a different workload than
this table. Postgres pays about 1ms → 2.5ms on `put` for the parsed-body column and its indexes;
sqlite's writes are unchanged. See [gotchas.md](../agent_docs/gotchas.md) for the soundness rules
that constrain all of it.

`take` was the worst row on the first run, worse even than the scan it contains. It is now flat at
~1.2ms on SQLite, once an index matching the claim order (`effective_priority, available_at, id`)
replaced a full scan of the envelope table with an ordered seek.

**The same claim costs ~23ms on Postgres, and the difference is the query planner, not the
storage.** Postgres estimates the body predicate at 26 rows when 5,715 match, so it collects every
match through the body index and sorts instead of walking the claim index and stopping early. No
rewrite of the query changes that, and overriding the planner makes it worse; supplying a real
estimate (`CREATE STATISTICS` on the path expression) drops it to 1.92ms. See
[gotchas.md](../agent_docs/gotchas.md), "a claim on Postgres is planned on a guess".

**`childrenOf` grew with the whole space, not with the answer, until it got a reverse index.**
87µs at 1k records → **662µs at 20k** for the same five children, because `parent_ids` was
searched with a `LIKE` over every record. With a `record_edges` table written in the same
transaction as the record, it is 31µs → 32µs: **flat**, and 20× faster at 20k.

**`getLineage` costs a round trip per LEVEL, not per hop.** It fetches a whole depth level in one
batched query. Measured head to head at depth 64 in a 20k-record space: **0.224ms batched vs
0.651ms walking node by node**, a 2.9× gap on a plain chain, where batching saves no round trips at
all. That is the tell: the gain there is not the batching but the prepared-statement cache it
forced (building the SQL text per call re-parsed an identical query every level). On a DAG that
fans out, and on a networked Postgres where a round trip is latency rather than work, the
batching itself is what pays.

**Contention found a real bug, because the benchmark counts empty takes separately.**
The contention bench counts *empty* takes separately instead of treating a null claim as
"queue drained". On Postgres that counter read **67 empty takes at 4 claimers and 166 at 16**,
for a queue that always had work: `take` was row-locking every available record of the kind,
so one claimer's open transaction hid the whole queue from its peers (`skip locked` finds
nothing unlocked, and the peer is told "empty"). See [gotchas.md](../agent_docs/gotchas.md),
"a claim must not lock what it does not claim". It is now 2 and 4 (the genuine tail as the
queue drains), with a conformance suite (`claimFairnessSuites`) pinning it.

**Contention does not scale, and it is not supposed to.** sqlite holds ~1.8–2.7k take+ack per
second whether 1, 4 or 16 claimers race for the same queue; pglite is flat at ~270/s, Postgres
rises from 143/s to ~290/s. Per-op latency rises as claimers queue behind the single-winner
gate. Flat is the correct shape for a single-winner claim; the number to watch is whether it
*drops* under load, and whether those empty takes come back.

**Encryption at rest costs about 2–3× on blob I/O.** 256KB: `file` put 419µs / get 271µs
versus `file+aes-gcm` put 1.4ms / get 1.5ms. Reads pay because an encrypted blob cannot
stream: AES-GCM verifies its tag over the whole ciphertext
([design-data-model.md](../agent_docs/design-data-model.md) §2.4).

## What the deployment run found

One space over HTTP against a live Postgres with fsync, filled to a million records, 64 requests in
flight. Client, space and database on one machine, so latency is flattered and throughput
penalised; compare the shapes down a column. p50/p99 in ms.

| records | put/s | put | read_one | query | scoped | `$any` | `$each` | stats | take+ack |
|---|---|---|---|---|---|---|---|---|---|
| 25 000    | 3000 | 2.6/5.3 | 2.5/4.1 | 2.6/5.2 | 2.0/5.4 | 1.9/3.2 | 278/292 | 3.3/5.3 | 15.3/19.6 |
| 100 000   | 3200 | 2.6/6.4 | 1.8/3.2 | 2.3/10.1 | 2.6/4.6 | 1.6/3.1 | 1218/1239 | 10.7/14.7 | 16.4/23.4 |
| 400 000   | 2700 | 2.5/5.4 | 1.5/3.8 | 2.1/4.8 | 2.2/4.3 | 1.6/1.8 | 5332/5487 | 24.1/24.7 | 19.0/26.6 |
| 1 000 000 | 2600 | 2.9/6.3 | 2.0/3.8 | 1.6/3.2 | 1.5/2.8 | 1.7/2.8 | **13634**/13960 | 51.1/52.2 | 20.4/27.5 |
| 5 500 000 | 3200 | 2.4/4.3 | 2.2/3.2 | 2.2/3.8 | 1.6/2.9 | 1.9/2.8 | **refused** 2476 | 298/321 | 16.3/21.7 |

The 5.5M row was taken after the scan budget landed, and it is a different measurement in one
column: `$each` is no longer served at all. See "the budget, measured at scale" below.

**The pushable paths are flat to a million records.** `put`, `read_one`, `query`, the owner-scoped
query and `$any` stay in single-digit milliseconds with no trend across a 40x range. Pushdown plus
declared indexes do the job they were built for.

**Concurrency is doing all of the throughput.** One put over HTTP is 2.9ms serially and 0.38ms of
wall clock at 64 in flight. Against `suites/records.ts`'s in-process 42µs that is about 70x, which
is what the caveat above means in practice: sizing a deployment from the in-process numbers is not
wrong at the margin, it is wrong about the machine you need.

**The oracle path WAS the wall, and it grew with the record count exactly.** `$each` went 278ms →
1.2s → 5.3s → **13.6 seconds**, because `pushdown.ts` cannot express it and the whole kind was
pulled into JS for the oracle to decide, in a single-threaded process that therefore served nobody
else meanwhile. That is what the scan budget was built for, and the row above it now reads
`refused`.

**The budget, measured at scale.** A run toward twenty million was stopped at 5.5M because the two
questions it was run for were both answered, both taken WHILE 64 writers were filling, so
they are comparable to each other rather than to the idle table above:

| records | `$each` (refused) | stats |
|---|---|---|
| 2.09M | 4269ms | 143ms |
| 3.72M | 3994ms | 249ms |
| 5.32M | 4119ms | 397ms |

A refused query costs the SAME at 5.3M as at 2.1M while the kind grows 2.5×, which is the whole
claim the budget makes: the cost of an undecidable pattern is bounded by the work it may cause
rather than by the size of the kind. Unloaded it is 2.5s, which is 200k rows of oracle plus the
chunk round trips.

**And it does not hold the runtime, which is the half that matters.** A neighbour polling an indexed
read while one refused `$each` ran: the scan took 2538ms and the neighbour's worst wait was **48ms**
(99 completed reads). Before the walk was chunked, the same neighbour waited the entire scan. The
yield between chunks is what makes an expensive query one caller's delay instead of everyone's
outage, and it holds at five and a half million records.

**`$any` used to be that row, at 14.1s.** It is now rendered into SQL as a type-guarded `EXISTS`
over the array's elements, exact rather than merely sound, so the caller's `LIMIT` rides into the
database with it (`src/storage/pushdown.ts`). The comparison that means something is the one where
nothing matches, because a limit cannot cut a scan short when no row satisfies it: a matching
`$any` could always stop early, so the first run's 14.1s was really the cost of an EMPTY predicate
the database could not decide. At a million records (a second run, `--checkpoints 1000000`), `$any`
matching nothing is **2.4ms**, a GIN lookup, since an empty match is what an index is best at,
against 13.5s for the same shape left to the oracle. `$each` is that shape, and it stays with the oracle on purpose: expressing "every
element matches" means negating the element predicate, and a negation that is sound-but-incomplete
EXCLUDES rows, the one direction a pre-filter may never be wrong in.

**`stats` is linear and it is the one still unbounded**: 3.3ms → 51ms → **298ms at 5.5M**, about
54ms per million, so ~1.1s at twenty. It has no budget, and `GET /v0/ops/digest` reaches it for a
self-scoped caller. Measured before assuming the worst, though: it does NOT hold the runtime. During
one 210ms `stats` a neighbour completed 171 indexed reads with a worst wait of 8ms, because this is
a `count(*) group by` the runtime AWAITS rather than CPU it holds. So it is a Postgres backend per
request, not an outage — a different and milder class than the oracle path, and the reason to treat
it as a thing to watch rather than the next thing to bound.

**`take+ack` does not drift after all.** It read 15ms → 20ms to a million and then 16.3ms at 5.5M,
so the earlier "drift" was noise across runs rather than a trend. Claim-order index and all.

## The log-axis run (2026-08-11): 20M records

The run the previous paragraph called for. 20,000,000 records over HTTP against a live Postgres
with fsync and sealing ON, into an isolated `radia_bench` database, 64 in flight, checkpoints at
1M/5M/10M/20M. Final DB: 24 GB, 20.0M records, 20.0M events (this workload is ~1 put = 1 event,
so records ≈ events; a take/ack workload is the 2:1 the earlier note assumed). p50/p99 in ms.

| records | put/s | put | read_one | query | scoped | `$any` | `$each` | stats | take+ack |
|---|---|---|---|---|---|---|---|---|---|
| 1 000 000  | 2800 | 2.1/3.3 | 2.1/3.8 | 1.5/2.8 | 1.3/2.8 | 0.96/1.4 | 2581 (refused) | 43.9 | 12.8/19.9 |
| 5 000 000  | 3200 | 1.8/2.6 | 1.3/1.6 | 1.4/2.8 | 1.5/2.6 | 1.3/1.4  | 2464 (refused) | 184  | 11.9/21.1 |
| 10 000 000 | 3200 | 2.0/3.0 | 1.9/4.8 | 0.76/1.8 | 0.74/1.3 | 0.69/0.71 | 2563 (refused) | 353 | 8.6/17.9 |
| 20 000 000 | 3100 | 2.0/4.0 | 2.0/2.6 | 0.80/4.2 | 0.81/2.4 | 1.4/2.0  | 2739 (refused) | 675 | 11.6/18.3 |

**The answer to "does cost grow with history": for the coordination paths, no.** Every pushable
path is flat from 1M to 20M — put, read_one, query, owner-scoped, `$any` all sit in single-digit
ms across a 20× range, some a touch faster at 20M than 1M (warmer cache, settled plans). **The
fill never slowed** (3.1k/s at the end, same as the start), so 20M accumulated events do NOT drag
the write path — the seal design's off-the-hot-path claim holds at scale. `$each` stays refused
flat at ~2.6s, the scan budget bounding an undecidable pattern by work, not size. `stats` is the
one operation that tracks contents, cleanly linear (44 → 184 → 353 → 675ms, ~34ms/M).

**But the fill hid the real log-axis cost, and probing for it found a scan.** Sealing is
on-demand, so a pure-write workload seals NOTHING (`event_seal` had 0 rows at 20M). The cost lives
in the operator path that DOES seal — `radia integrity` / `radia doctor` / the console Overview —
and there it was **14.4s** on the 20M-event space, flat regardless of integrity tail size. Cause,
confirmed by EXPLAIN: `sealableEvents` asks for the next 500 events in (xid, seq) order, and the
events table's only index was the `seq` primary key, so Postgres **parallel-seq-scanned all 20M
rows and top-N sorted** them to return 500 — 2005ms per call, and verify runs it per page. Fixed
with `idx_events_xid_seq` (`src/storage/pgbase.ts`, a `create index if not exists` that doubles as
the migration): the window query **2005ms → 0.19ms**, `radia integrity` **14.4s → 0.32s (45×)**,
and diagnostics 13.6s → 4.3s (its remainder is `stats` + the stale-envelope scan, both bounded and
smaller). SQLite orders the same walk by its `seq` PK already, so this is the Postgres half only.
Guard: the seal suites in `test/conformance/suites/integrity.ts` run on every adapter; the index is
exercised by the pg conformance run.

**Two things still genuinely grow with size, both operator-facing, neither on the coordination
path:** `stats` (~34ms/M, the count-group-by, ~700ms at 20M) and the diagnostics stale-envelope
scan (~1s at 20M). Both AWAIT Postgres rather than holding the runtime, so they are a backend query
per call, not an outage. Left as documented shapes to watch, not bounded, since a health check that
costs a second on a 20M space is not the emergency an unbounded coordination path would be.

## The watch fan-out, measured (`suites/fanout.ts`)

The other measurement the scaling analysis called for and nobody had taken. It parks N watch
streams (each on its own conversation, the chat shape) and counts the queries ONE write triggers,
faithfully replaying the SSE loop (`getEvents` → `matchesEvent` → `waitForEvents`) against an
adapter that counts the two fan-out reads. Query counts are exact; the ms is per-write wall time.

Measured before the kind-aware wakeup fix (the kind-blind baseline this documents):

| write, N streams parked | getEvents | getRecord | useful | pglite p50 |
|---|---|---|---|---|
| same-kind (a message in 1 of N convs) @ 25 | 25 | 25 | 1 | 15.9ms |
| same-kind @ 100 | 100 | 100 | 1 | 52ms |
| same-kind @ 250 | 250 | 250 | 1 | **127ms** |
| other-kind (a write nobody watches) @ 250 | 250 | 0 | 0 | 68ms |

**The derivation was a fact: one write cost N `getEvents` + (same-kind) N `getRecord`, of which
ONE was useful.** `notify()` was kind-blind, so even a write no stream watched woke all N and each
read the log (the other-kind row: 250 getEvents, 0 useful). At 250 streams (~50 users at 5 streams
each) a single chunk write was 127ms of DB work on pglite — the O(U) coefficient behind the chat's
quadratic.

**Kind-aware wakeup (`notify(kind)`, done) — the other-kind row now reads 0/0.** `Space.notify`
wakes only streams watching the written kind (authorization-kind writes still wake everyone, since
the SSE loop re-scopes on them). A watch matches only its own kind, so waking a foreign kind's
watchers was always pure waste. Re-run with the fix:

| write, N=250 streams | getEvents | getRecord | before → after |
|---|---|---|---|
| other-kind (foreign kind) | **0** | **0** | 250 → **0** |
| same-kind (all watch `feed`) | 250 | 250 | unchanged |

The chat opens 5 streams per user of DIFFERENT kinds (llm_chunk, message, tool_result — the three
wakeup watches; capability, procedure — the two registry watches), so a `message` write used to
wake all 5U and now wakes only the U message streams: **5U → U per write.**

**Then the shared log read took the rest of it** (`src/core/coalesce.ts`). Kind-aware wakeup does
not discriminate WITHIN a kind, so 250 streams watching `message` on different conversations still
all wake on a `message` write. They now cost one query between them instead of one each:

| write, N=250 streams | getEvents | getRecord | p50 |
|---|---|---|---|
| original (kind-blind) | 250 | 250 | 127ms |
| + kind-aware wakeup | 250 | 250 | 127ms |
| **+ shared log read** | **1** | **1** | **2.3ms** |

Measured flat across 1/25/100/250 watchers: **one write is two database queries however many
streams are parked.** The remaining per-stream cost is CPU (each evaluates its own predicate
against the shared record), and the record is shared but still AUTHORIZED per stream, so this
changed how often it is read and never who may see it. Together the two fixes take a write from
6U queries to 2.

**What is left per stream, measured, because it is what the NEXT optimization would target.**
Re-run post-coalescing, same-kind writes as parked streams scale:

| streams | sqlite p50 | pglite p50 |
|---|---|---|
| 1 | 618µs | 2.4ms |
| 25 | 950µs | 3.4ms |
| 100 | 1.3ms | 2.8ms |
| 250 | 2.9ms | 2.3ms |

Flat on pglite (the round trip swamps it); visible on sqlite only because its reads are fast, at
`(2.9 − 0.62) / 249` = **~9µs per stream per write** — a promise resolution, an array iteration and
one `matchesRecord` against an already-in-memory record. That figure is the whole budget for
within-kind routing (waking only the streams whose predicate matches), which is why it is deferred:
see agent_docs/plan-scaling.md, "Within-kind routing: measured, deferred".

Two notes on what did NOT turn out to matter:
- **Dropping `capability`/`procedure` to periodic refresh no longer helps the fan-out.** Before
  kind-aware wakeup it cut 5U→3U; now a message write never wakes them, and coalescing makes the
  count independent of N anyway. It buys two fewer connections per user, not fewer queries. Noted
  so the pre-fix "~40% off" claim is not carried forward.
- **A broadcast tailer is not needed.** It would have to place a subscriber's cursor in a ring,
  and cursors are opaque and unordered by design; coalescing gets the same O(1) because one
  `notify()` resumes every stream in the same tick, so their reads overlap by construction.

Guards: `test/notifier.test.ts` (notify(kind) wakes the kind + any-set, not foreign kinds;
a re-registered same-kind waiter wakes again), both proven red against a kind-blind `notify`; the
whole turn still delivers over watches (`deno task test:chat`).

**Two things this run changed about the bench itself**, both discovered by wanting them mid-run.
It prints each checkpoint's table AS IT COMPLETES, because a version that renders once at the end
means stopping early (the shape is clear, or something looks wrong) throws away every measurement
taken so far. And it seeds its counter from the space's own record count, so a long fill can be
resumed after an interruption, and an already-filled space can be measured as it stands by naming a
checkpoint at or below its current size.

## What the 2026-08-11 re-run confirmed (and the two things it flagged)

Full three-adapter run after OIDC, blob GC and the artifact-sweep change landed. The shapes
held: `read_one`/`query`/`$any` flat across 2k→40k, `childrenOf` flat, contention flat with
single-digit empty takes. First numbers for the new suites (sqlite): an OIDC cheap-reject is
**27µs** (a flood pays a string compare), a signature reject 552µs (the WebCrypto verify), a
first login 1.4ms (mapping + profile artifact + run), a replay 570µs; `getGraph` is flat across
space sizes (6.8ms for 150 nodes, 11.5ms for 400, at 2k and at 10k alike); gc sweeps ~635k
records/s and `retainOnly` scans ~7M blobs/s in memory.

**The OIDC suite found a fix on its first Postgres run.** A wrong-issuer reject cost 562µs
there against 27µs on sqlite, because `mintOidcRun` fetched the DB clock BEFORE verifying: an
anonymous flood bought a database round trip per garbage token. The clock is now a lazy thunk
the verifier calls only after the string-compare claims pass (`src/core/oidc.ts` `verify`),
and the same reject is **45µs** — 1.4k/s → 18.5k/s of flood capacity. Flagged, not yet
explained:

- **Postgres `take` grows with the space again**: 9.8ms @ 2k → 22.9ms @ 40k in the growth
  suite. The planner-guess shape (see "planned on a guess" above). The profiling session's
  first target — see "the profiling session found two things", below, where it turned out to be
  the BENCH, not the runtime.
- **`diagnostics` is the heaviest read everywhere**: 33ms (sqlite) / 213ms (pglite) / 657ms
  (postgres) at 40k. `doctor` and the console Overview pay it; second target, and a real
  runtime fix (below).

## The profiling session found two things (2026-08-11)

Both flagged rows above, run down with `deno task profile` and a pair of throwaway scripts. One
was a benchmark artifact; one was a real hotspot, now fixed.

**Postgres `take` was the BENCH lying, not the runtime.** The growth suite declared its kind
with `registerKind`, the in-memory path, which never calls `prepareKind` — so Postgres had no
planner statistics on the body paths and fell back to the guess the "planned on a guess" section
describes (`take` 23.6ms, "growing"). A real client declares durably (a `kind_def` record),
which creates the statistics; measured that way the same claim is **10.5ms and flat**, and an
explicit `ANALYZE` takes it to 6.3ms. The fix was in the bench: `suites/scale.ts` now declares
its kind durably, so it measures the plan a real deployment gets. The finding is
that a benchmark using the convenience registration path measures a plan no client sees.

**`diagnostics` was `appendSeals` doing 500 sequential INSERTs.** `verifyIntegrity` seals before
it checks, diagnostics runs a spot check, and every seal batch on Postgres was one round trip
PER LINK — so a doctor poll on a space with a seal backlog paid ~650ms of insert latency, flat
regardless of the integrity tail size (the tell: 614ms at tail 50, 698ms at tail 500). Batched
into one multi-row INSERT ... RETURNING (`src/storage/pgbase.ts`), preserving the
contiguous-prefix contract that concurrent sealers depend on (a win past a rival's position is
discarded, not left as a hole — pinned by `test/conformance/suites/integrity.ts` "appendSeals lands
a contiguous prefix"). **diagnostics on a 10k Postgres space: ~650ms → ~80ms, 8×.** SQLite is
single-connection and its loop was already fast, so it kept it.

## Profiling

`deno task profile <script> [args…]` CPU-profiles any Deno workload with nothing installed: no
`perf` (this machine has none, and `perf_event_paranoid=2`), no Chrome, no node. It drives V8's
own sampler over raw CDP: the target runs under `--inspect-brk` through `profile-wrap.ts`
(which imports the script, then HOLDS the process so the profiler can stop before exit — the
tail of a run is usually the part under investigation), and the controller writes:

- `bench/<name>.cpuprofile` — load in Chrome DevTools (Performance → Load) or speedscope
- `bench/<name>.folded` — flamegraph.pl-compatible folded stacks
- a top-20 self-time table in the terminal, which is usually enough

```bash
deno task profile bench/run.ts --suite take-ack --adapter postgres
deno task profile --out oidc bench/run.ts --suite oidc --adapter sqlite
```

Two caveats: the profiled script runs via dynamic import, so `import.meta.main` is false inside
it; and an await-heavy workload shows large `(idle)`, which is correct (the CPU really is
waiting), so profile the adapter under load, not a latency bench, when hunting CPU.

## Writing a benchmark

Two rules the suites follow, and one thing to avoid:

- **Measure the runtime, not the harness.** Seeding, kind registration and token minting
  happen outside the timed region, and `measure()` warms up before it counts.
- **Report a shape, not a number.** If the question is "does this scale", the suite must
  re-measure the same operation at several sizes in one run. A single figure cannot answer it.
- **Do not let a payload dedup.** Content-addressed writes skip when the bytes already exist,
  so a blob benchmark that reuses one buffer measures the skip path. Vary the payload.
