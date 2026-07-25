# Plan: validation

> Status: the M0 fault subset is implemented (see [plan-m0-implementation.md](plan-m0-implementation.md)
> Phase 6); the baselines/metrics and the fuller fault matrix (partition, failover, cursor
> storm) are not yet run. Origin: outline §12. The measurement plan that proves the design's
> claims and the fault matrix each milestone must survive.

## Goal

Show that content-routed coordination (and specifically the agenda scheduler) earns its
place, and that the durability guarantees hold under failure.

The same "earns its place" bar gates M2's marketplace and durable timers: build them behind a
measured baseline, not on spec. Durable execution is Temporal's ground — Radia does not
reimplement it (see [research-positioning.md](research-positioning.md)); the in-scope exception
is the delayed-visibility sweeper over `available_at` that retry backoff already needs.

## Baselines

Three, to isolate contributions:

- static graph orchestration,
- a plain worker queue,
- a blackboard **without** the agenda scheduler (isolates the scheduler's contribution).

## Metrics

Task success · tokens/cost · latency · invocation count · duplicate-execution rate ·
lease-recovery latency · wakeup amplification · orphan rate · admission accuracy ·
p50/p95/p99 take latency · throughput scaling in records × templates × agents.

## Fault-injection matrix

Each is a required case (referenced from [plan-milestones.md](plan-milestones.md) M2):

- crash before external effect
- crash after effect, before ack
- crash after commit, before HTTP response
- duplicate ack
- stale ack after reassignment
- partition during renewal
- DB failover
- conflicting idempotency payloads
- schema migration with live templates
- revocation mid-lease
- cursor expiry under reconnect storm

These exercise the guarantees in [design-api.md](design-api.md) (idempotency ordering,
fencing) and [design-auth.md](design-auth.md) (revocation).
