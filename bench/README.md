# Benchmarks

Where a space is fast, where it stops scaling, and what a change cost. Not a test suite:
**nothing here asserts**, because a benchmark that moved is a fact to explain, not a failing
build.

```bash
deno task bench                          # every suite, both embedded adapters (~3 min)
deno task bench -- --suite lineage       # one suite
deno task bench -- --adapter sqlite      # one adapter
deno task bench -- --scale 4             # 4x iterations: slower, steadier
RADIA_PG_URL=postgres://… deno task bench    # adds a live Postgres column

deno run -A bench/deployment.ts --url http://127.0.0.1:7899   # a real server, over HTTP
```

Most of the three minutes is the scaling suites filling spaces to 40k records. `--suite` is the
tight loop while you work on something; the full run is for before and after a change.

Runs are reproducible enough to compare: repeating `take-ack` on the same machine moved p50 by
~1% (633µs vs 626µs). Treat a change under 10% as noise unless it repeats.

## How to read the numbers

They measure the **substrate**: core plus a storage adapter, in-memory, single process, no
HTTP, no network, no fsync. That makes them a **floor for latency and a ceiling for
throughput**, useful for finding hotspots and catching regressions, useless for capacity
planning a deployment. `deployment.ts` is the other side of that sentence, and the gap between
them is about 95x on a single `put`. A disk-backed or networked space is slower, and the ordering between
adapters can change under real fsync.

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
| `deployment.ts` | standalone: one space over HTTP against whatever storage it was started with, re-measured as it fills. Takes a `--url` instead of an adapter, so it measures the thing the suites above cannot. **It writes records and cannot delete them**; point it at a throwaway space |
| `edit-cost.ts` | standalone: what an edit costs versus rewriting a tree, in emitted characters and in records written. Not a timing suite, so it is run directly rather than through the harness |

## What the first run found

Measured on one developer machine, sqlite in-memory, scale 1. Absolute numbers will differ;
the **shapes** are the point.

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
513ms → 732µs. Two findings from the original run drove this and are worth keeping: every
predicate shape cost the same (equality, `$gt`, `$or`, and a match that hits nothing were within
noise of each other), and `read_one` was no faster than `query limit=100`, since both scanned the
kind and both materialized every match to return one record.

**That flatness needs an index nobody would think to add, and it regressed once already.** A
pushed `LIMIT` only helps if the database can produce rows in id order without reading the whole
kind first, and SQLite's primary key alone does not do that: `where kind = ? … order by id limit N`
plans as USE TEMP B-TREE FOR ORDER BY, sorting every record of the kind before the limit applies.
`read_one` was back to 12.0ms at 40k, growing linearly, exactly the shape this section says was
fixed. `idx_records_kind_id (kind, id)` turns it into an ordered seek that stops at the Nth match:
12.0ms → 0.05ms, flat again. Postgres has the same index for a different reason (`idx_records_id_c`,
byte-order ids), which is why only the SQLite side drifted, and why a claim about the SHAPE of a
number is worth re-running rather than trusting.

What actually bought the speedup is worth separating, because it is not the obvious answer. The
GIN index over record bodies is *not* used for the benchmark's predicate at all: "rare" matches
1 record in 7, far too many for an index to beat a scan. The win is that an **exact** filter
lets the caller's `LIMIT` move into SQL, so the scan stops at the first match instead of
materializing 5,700 rows to return one. The index earns its keep on genuinely selective matches
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

**Contention found a real bug. The benchmark that counts honestly is the one that finds it.**
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
penalised; the shapes are the point. p50/p99 in ms.

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
things worth learning had already answered themselves, both taken WHILE 64 writers were filling, so
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

Not reached: the LOG axis. 5.5M records is about 11M events, and nothing sweeps them, so the
question of whether cost grows with history rather than contents is still open — that is what a run
to twenty million would actually be for, rather than another confirmation that the indexed paths
are flat.

**Two things this run changed about the bench itself**, both discovered by wanting them mid-run.
It prints each checkpoint's table AS IT COMPLETES, because a version that renders once at the end
means stopping early (the shape is clear, or something looks wrong) throws away every measurement
taken so far. And it seeds its counter from the space's own record count, so a long fill can be
resumed after an interruption, and an already-filled space can be measured as it stands by naming a
checkpoint at or below its current size.

## Writing a benchmark

Two rules the suites follow, and one thing to avoid:

- **Measure the substrate, not the harness.** Seeding, kind registration and token minting
  happen outside the timed region, and `measure()` warms up before it counts.
- **Report a shape, not a number.** If the question is "does this scale", the suite must
  re-measure the same operation at several sizes in one run. A single figure cannot answer it.
- **Do not let a payload dedup.** Content-addressed writes skip when the bytes already exist,
  so a blob benchmark that reuses one buffer measures the skip path. Vary the payload.
