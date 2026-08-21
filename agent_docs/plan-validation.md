# Plan: validation

> Status: the M0 fault subset is implemented (see [plan-m0-implementation.md](plan-m0-implementation.md)
> Phase 6) and the two CONTENDED cases were added 2026-08-04 (`test/concurrency.test.ts`,
> Postgres only); the baselines/metrics and the rest of the matrix (partition, failover, cursor
> storm) are not yet run. Origin: outline §12. The measurement plan that proves the design's
> claims and the fault matrix each milestone must survive.

## Goal

Show that content-routed coordination (and specifically the agenda scheduler) earns its
place, and that the durability guarantees hold under failure.

The same "earns its place" bar gates M2's marketplace: build it behind a measured baseline, not on
spec. Durable execution is Temporal's ground, and Radia does not reimplement it (see
[research-positioning.md](research-positioning.md)).

The timing half is settled and needed no baseline, because it turned out not to be machinery.
DELAYED VISIBILITY shipped 2026-08-21 as one optional field on `put` (`availableAt`) over the
envelope column retry backoff already drove, and the sweeper this paragraph used to call the
"in-scope exception" was deliberately NOT built: the claim path is lazy, so nothing needs sweeping.
See [plan-milestones.md](plan-milestones.md) and [design-marketplace.md](design-marketplace.md).

## Baselines

Three, to isolate contributions:

- static graph orchestration,
- a plain worker queue,
- a blackboard **without** the agenda scheduler (isolates the scheduler's contribution).

## Metrics

Task success · tokens/cost · latency · invocation count · duplicate-execution rate ·
lease-recovery latency · wakeup amplification · orphan rate · admission accuracy ·
p50/p95/p99 take latency · throughput scaling in records × patterns × agents.

## Fault-injection matrix

Each is a required case (referenced from [plan-milestones.md](plan-milestones.md) M2). They
exercise the guarantees in [design-api.md](design-api.md) (idempotency ordering, fencing) and
[design-auth.md](design-auth.md) (revocation).

| Case                                    | Where                                       |
|-----------------------------------------|---------------------------------------------|
| crash before external effect            | `test/conformance/suites/faults.ts`              |
| crash after effect, before ack          | `test/conformance/suites/faults.ts`              |
| crash after commit, before response     | `test/conformance/suites/faults.ts`              |
| duplicate ack                           | `test/conformance/suites/faults.ts`              |
| stale ack after reassignment            | `test/conformance/suites/faults.ts`              |
| conflicting idempotency payloads        | `test/conformance/suites/idempotency.ts`         |
| revocation mid-lease                    | `test/conformance/suites/auth.ts`                |
| schema migration with live patterns     | `test/backfill.test.ts` (schema only) |
| claim inside another worker's backoff   | `test/concurrency.test.ts` (Postgres) |
| claim over a shifting candidate window  | `test/concurrency.test.ts` (Postgres) |
| partition during renewal                | not written                                 |
| DB failover                             | not written                                 |
| cursor expiry under reconnect storm     | not written                                 |

The last two written cases are CONTENDED: they are properties of the claim path under real
concurrency, so the embedded adapters (PGlite single-connection, SQLite single-writer) cannot
express them and the file skips without `RADIA_PG_URL`. Both were validated by planting the
pre-fix adapter back in and watching them fail, which is the only evidence that a race guard
guards anything. The two rows above them were added by audit package S as code with no failing
test; that gap is now closed.
