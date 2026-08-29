# Plan: validation

> Status: **the fault matrix is COMPLETE as of 2026-08-29.** The M0 subset landed with Phase 6, the
> two CONTENDED cases on 2026-08-04 (`test/concurrency.test.ts`, Postgres only), and the last three
> rows (partition during renewal, DB failover, cursor expiry under reconnect storm) on 2026-08-29.
> The BASELINES and metrics below are still not run, and they are the half that gates the scheduler
> and the marketplace. Origin: outline §12. The measurement plan that proves the design's claims and
> the fault matrix each milestone must survive.

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
| partition during renewal, outbound      | `test/conformance/suites/faults.ts`              |
| partition during renewal, lost response | `test/conformance/suites/faults.ts`              |
| DB failover (6 cases)                   | `test/conformance/suites/failover.ts`            |
| cursor expiry under reconnect storm     | `test/http.test.ts`                         |

The two `concurrency.test.ts` rows are CONTENDED: they are properties of the claim path under real
concurrency, so the embedded adapters (PGlite single-connection, SQLite single-writer) cannot
express them and the file skips without `RADIA_PG_URL`. Both were validated by planting the
pre-fix adapter back in and watching them fail, which is the only evidence that a race guard
guards anything. The two rows above them were added by audit package S as code with no failing
test; that gap is now closed.

### How the last three rows are injected, and what they do not claim

**A partition is simulated by not delivering, which is exact rather than approximate**: a request
the space never receives and a request never sent are the same event at the space, and the space is
where every guarantee lives. Both directions are covered, and the second is the dangerous one: an
unheard RENEW loses the lease and the healed worker cannot renew, ack, nack or release it, while a
renew whose RESPONSE was lost extended the lease anyway, so nobody else may claim the record and the
holder's own fence still settles it.

**A failover is injected by a Proxy around one adapter method**, throwing either before delegating
(nothing committed) or after (committed, answer lost). No test-only hook goes into production code,
which is the rule `concurrency.test.ts` states, and every adapter gets the same treatment. It
CANNOT fail inside the storage transaction, so transactional rollback is not what is under test:
what is, is the contract the runtime owes a caller across a connection that died. A real primary
kill and replica promotion stays a DEPLOYMENT test, because it needs a cluster and exercises the
driver's reconnect rather than any guarantee this codebase makes.

**The storm case makes its horizon with the real sweep** (`gcEvents`), not the planted truncation
the older boundary tests use, and reconnects 24 streams at once. Beyond the 410 it pins two things
one reconnect cannot: every refusal names the SAME horizon, since a client catching up to a moving
answer never converges, and the sentinel recovery every SDK performs on that 410 still connects
under the same load.

**Proved red, and where not.** The two partition cases each failed under a distinct planted
regression (removing both fence guards from `renew`; making `renew` rotate the epoch). The storm
case failed in 37ms with the horizon check disabled, and it asserts response STATUS before reading
any body deliberately: read first, and a wrongly-served stream parks the suite forever, and a fault
suite that hangs on the regression it exists to catch is worse than no suite. Of the six failover
cases, the two resting on idempotent replay were proved red by disabling the stored-response lookup;
the other four (nothing committed, log agrees with records, chain still verifies, lease survives)
guard against behaviour a future change would have to introduce, and were not proved red.
