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
```

Most of the three minutes is the scaling suites filling spaces to 40k records. `--suite` is the
tight loop while you work on something; the full run is for before and after a change.

Runs are reproducible enough to compare: repeating `take-ack` on the same machine moved p50 by
~1% (633µs vs 626µs). Treat a change under 10% as noise unless it repeats.

## How to read the numbers

They measure the **substrate** — core plus a storage adapter, in-memory, single process, no
HTTP, no network, no fsync. That makes them a **floor for latency and a ceiling for
throughput**: useful for finding hotspots and catching regressions, useless for capacity
planning a deployment. A disk-backed or networked space is slower, and the ordering between
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
| `suites/lineage.ts` | `childrenOf` and `getLineage` — the documented hotspot, measured |
| `suites/scale.ts` | the same operations re-measured at 2k / 10k / 40k records |
| `suites/blobs.ts` | artifact bytes, and what encryption costs |

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

`read_one` is not merely faster, it is **flat** — 31µs at 2k, 32µs at 10k, 29µs at 40k — where
before it grew linearly with the space. Postgres tells the same story: `read_one` at 40k went
513ms → 732µs. Two findings from the original run drove this and are worth keeping: every
predicate shape cost the same (equality, `$gt`, `$or`, and a match that hits nothing were within
noise of each other), and `read_one` was no faster than `query limit=100` — both scanned the kind
and both materialized every match to return one record.

What actually bought the speedup is worth separating, because it is not the obvious answer. The
GIN index over record bodies is *not* used for the benchmark's predicate at all: "rare" matches
1 record in 7, far too many for an index to beat a scan. The win is that an **exact** filter
lets the caller's `LIMIT` move into SQL, so the scan stops at the first match instead of
materializing 5,700 rows to return one. The index earns its keep on genuinely selective matches
— 1 row in 40k measured at 7.98ms without it, 1.42ms with — which is a different workload than
this table. Postgres pays about 1ms → 2.5ms on `put` for the parsed-body column and its indexes;
sqlite's writes are unchanged. See [gotchas.md](../agent_docs/gotchas.md) for the soundness rules
that constrain all of it.

`take` was the worst row on the first run — worse than the scan it contains — and is now flat at
~1.2ms on SQLite, once an index matching the claim order (`effective_priority, available_at, id`)
replaced a full scan of the envelope table with an ordered seek.

**The same claim costs ~23ms on Postgres, and the difference is the query planner, not the
storage.** Postgres estimates the body predicate at 26 rows when 5,715 match, so it collects every
match through the body index and sorts instead of walking the claim index and stopping early. No
rewrite of the query changes that, and overriding the planner makes it worse; supplying a real
estimate (`CREATE STATISTICS` on the path expression) drops it to 1.92ms. See
[gotchas.md](../agent_docs/gotchas.md), "a claim on Postgres is planned on a guess" — that is the
next thing to fix, and the numbers above are the argument for it.

**`childrenOf` grew with the whole space, not with the answer — until it got a reverse index.**
87µs at 1k records → **662µs at 20k** for the same five children, because `parent_ids` was
searched with a `LIKE` over every record. With a `record_edges` table written in the same
transaction as the record, it is 31µs → 32µs: **flat**, and 20× faster at 20k. The contrast that
originally proved this was the scan and not the table size (`getRecord` stays flat) is now the
shape `childrenOf` itself has.

**`getLineage` costs a round trip per LEVEL, not per hop.** It fetches a whole depth level in one
batched query. Measured head to head at depth 64 in a 20k-record space: **0.224ms batched vs
0.651ms walking node by node** — 2.9×, on a plain chain, where batching saves no round trips at
all. That is the tell: the gain there is not the batching but the prepared-statement cache it
forced (building the SQL text per call re-parsed an identical query every level). On a DAG that
fans out, and on a networked Postgres where a round trip is latency rather than work, the
batching itself is what pays.

**Contention found a real bug — the benchmark that counts honestly is the one that finds it.**
The contention bench counts *empty* takes separately instead of treating a null claim as
"queue drained". On Postgres that counter read **67 empty takes at 4 claimers and 166 at 16**,
for a queue that always had work: `take` was row-locking every available record of the kind,
so one claimer's open transaction hid the whole queue from its peers (`skip locked` finds
nothing unlocked, and the peer is told "empty"). See [gotchas.md](../agent_docs/gotchas.md),
"a claim must not lock what it does not claim". It is now 2 and 4 — the genuine tail as the
queue drains — with a conformance suite (`claimFairnessSuites`) pinning it.

**Contention does not scale, and it is not supposed to.** sqlite holds ~1.8–2.7k take+ack per
second whether 1, 4 or 16 claimers race for the same queue; pglite is flat at ~270/s, Postgres
rises from 143/s to ~290/s. Per-op latency rises as claimers queue behind the single-winner
gate. Flat is the correct shape for a single-winner claim; the number to watch is whether it
*drops* under load — and whether those empty takes come back.

**Encryption at rest costs about 2–3× on blob I/O.** 256KB: `file` put 419µs / get 271µs
versus `file+aes-gcm` put 1.4ms / get 1.5ms. Reads pay because an encrypted blob cannot
stream — AES-GCM verifies its tag over the whole ciphertext
([design-data-model.md](../agent_docs/design-data-model.md) §2.4).

## Writing a benchmark

Two rules the suites follow, and one thing to avoid:

- **Measure the substrate, not the harness.** Seeding, kind registration and token minting
  happen outside the timed region, and `measure()` warms up before it counts.
- **Report a shape, not a number.** If the question is "does this scale", the suite must
  re-measure the same operation at several sizes in one run — a single figure cannot answer it.
- **Do not let a payload dedup.** Content-addressed writes skip when the bytes already exist,
  so a blob benchmark that reuses one buffer measures the skip path. Vary the payload.
