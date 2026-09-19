# Plan: the cluster and failover benchmark

**Status: PHASES 0-3 BUILT 2026-09-19; phase 4 planned.** Phase 0 is `bench/cluster/`
(`cluster.ts`, `pgproxy.ts`, `authrounds.ts`, `run.ts check`) over `docker/cluster/compose.yaml`;
phase 1 is `load.ts` and `run.ts steady`, zero violations at N = 1, 2, 4, 8 with every audit line
proved red; phase 2 is `fleet.ts`, `faults.ts` and `run.ts faults`, zero violations through a
crash, a stall and a rolling restart; phase 3 fails the database over, fixed two driver defects that
stopped every instance for good, and two more (a watch cursor from a lost timeline, an S3 key race). Claims about current behaviour were checked against source the same day.

## The problem

Every number in `bench/` comes from one process, or from one server over HTTP (`deployment.ts`).
The fault matrix in [plan-validation.md](plan-validation.md) injects failover with a Proxy around an
adapter method, and says a real primary kill and replica promotion "stays a DEPLOYMENT test". So
three claims in [design-storage.md](design-storage.md) "Scaling and multi-instance operation" have
never been run:

- N instances over one Postgres keep every coordination guarantee under load.
- An instance can die at any moment without losing a committed write or a lease's fence.
- HA survives a primary failover, and needs SYNCHRONOUS replication to keep a revocation.

The benchmark reports throughput and latency, but its purpose is the correctness line beside them:
a run reads `N turns/s AND 0 lost, 0 duplicate commits, 0 stale grants`, or it has found a defect.

## Rules

- **The oracle is the deliverable; throughput is secondary.** A phase ships when its violation
  counts are computed and trusted (proved red, below), not when its throughput table prints.
- **Every violation count is proved red once.** Plant the fault it exists to catch (async
  replication, a disabled fence, a cached grant) and see a nonzero count, as the fault matrix did.
  A counter that has never been nonzero has only been shown not to crash.
- **Nothing in `src/` changes for this.** The bench is a client of `/v0` and of Postgres's own
  statistics, like `deployment.ts`. A defect it finds is fixed in its own change.
- **Faults are scheduled and seeded**, never random at run time, so a violation reproduces.
- **Tails follow `MIN_SAMPLES`** (`bench/harness.ts`); a window too short for a p99 prints none.

## Topology

```text
            load generator (one process, round-robins every request, retries on another URL)
                 │            │            │
             radia 0      radia 1  …   radia N-1      (radia serve, shared KEK, --artifact-port 0)
                 └────────────┼────────────┘
                        pg proxy (TCP forwarder the harness flips on failover)
                         │                 │
                    pg primary ──stream── pg standby   (synchronous_standby_names, or async arm)
                                    shared S3 (docker/s3)
```

- **No load balancer.** The generator spreads requests itself and retries a failed one on the next
  URL, which is what an LB with health checks does and keeps the stack one process smaller.
- **A proxy, not multi-host connection strings.** deno-postgres 0.19 takes one host, so a failover
  has to move the endpoint, the way a managed Postgres moves its DNS name. The forwarder is a few
  dozen lines of `Deno.listen` plus a pipe, under `bench/`, and its flip is a timed event in the log.
- **One compose file** under a new docker/cluster/ directory: primary, standby (initialised with
  `pg_basebackup`), SeaweedFS from `docker/s3/compose.yaml`. Radia instances run on the host, from
  the checkout, so a run measures the working tree.
- **`pg_stat_statements` on**, for queries per operation across all instances. `chatload.ts` counts
  queries by wrapping the adapter, which a separate process cannot do.

## Workload

Mixed and concurrent, each stream at a fixed offered rate so throughput under a fault is comparable
to steady state:

| Stream           | What it does                                                              | Stresses                          |
|------------------|---------------------------------------------------------------------------|-----------------------------------|
| records          | put + read_one + query on indexed paths, idempotency key on every put      | the write path, pushdown          |
| claims           | producers put tasks; W workers take, "execute" into an effect ledger, ack a result | leases, fencing, `SKIP LOCKED` contention |
| watches          | parked SSE streams per instance, reconnecting with `Last-Event-ID` to another instance when theirs dies | the portable `<xid>.<seq>` cursor |
| authorization    | `authprobe.ts`'s revoke/re-grant and stop rounds, factored into a module   | grant registry, credential resolution |
| artifacts        | put bytes through one instance, read through another                     | the shared blob store              |
| housekeeping     | `radia gc` on a schedule, from two instances at once                      | concurrent sweeps (plan-gc.md says they are safe) |

## The oracle

Computed from the generator's own ledger plus a final audit read through a surviving instance:

| Count                     | Violation when                                                                 |
|---------------------------|--------------------------------------------------------------------------------|
| lost writes               | an acknowledged put id is absent at the end                                    |
| duplicate commits         | one idempotency key produced two records (a retry across a failure re-applied) |
| duplicate results         | a task has more than one committed result record                               |
| stale settlements         | an ack or renew under a superseded lease epoch returned success                |
| stranded work             | a task neither consumed nor claimable after the lease horizon                 |
| stale grants, credentials | `authprobe.ts`'s counts                                                        |
| resurrected grants, runs  | at the END, a revoked identity authorizes or a stopped run authenticates (a failover can undo either long after the probe windows) |
| stale reads               | a `read_one` through another instance misses a put already acknowledged        |
| watch gaps                | a committed record of a watched kind never reached a watcher that stayed subscribed |
| unreadable artifacts      | acknowledged bytes that no instance can serve                                  |
| chain                     | `radia integrity` fails at the end                                             |

Duplicate EXECUTION is not in the table: delivery is at-least-once (CLAUDE.md invariants), so the
effect ledger reports it as a rate, not a violation.

## Faults

| Fault                       | How                                                             | Expected                                   |
|-----------------------------|-----------------------------------------------------------------|--------------------------------------------|
| instance crash              | SIGKILL one `radia serve`, restart it 10s later                  | zero violations; its leases reclaim on expiry |
| instance stall              | SIGSTOP with settles in flight, past the lease time, then SIGCONT | a settle it answers late for a reclaimed lease is refused (`lease_lost`) |
| rolling restart             | restart each instance in turn under load                         | zero violations, no throughput hole        |
| primary kill, sync standby  | `docker kill` the primary, `pg_promote()` the standby, flip the proxy | zero violations; recovery time measured |
| primary kill, ASYNC standby | the same with `synchronous_standby_names` unset                  | lost writes or stale grants EXPECTED: the control arm that proves the requirement design-storage.md states |
| network partition           | `docker network disconnect` the primary for 30s                  | errors, then recovery; zero violations     |

Recovery time per fault: from the event to the first success per stream, and to p99 back within
the steady-state spread (`--trials` SPREAD from a baseline run).

## Phases

0. **Extract and harness. BUILT.** The authprobe rounds are `bench/cluster/authrounds.ts`, used
   by `bench/authprobe.ts` and `run.ts authprobe`; `Cluster.up`/`down` start and remove
   everything, every step of `down` running even when one fails. `run.ts check` verifies each part
   (the standby APPLIES a commit, bytes cross instances, reads stay fast through the proxy) and
   that nothing is left: no container, volume, process, bound port or work directory. Record below.
1. **Steady state, scaling. BUILT.** `run.ts steady [--instances 1,2,4,8] [--duration s] [--rate]
   [--plant name]`: all streams, no faults, a fresh cluster per N, then the audit. Record below.
2. **Instance faults. BUILT.** `run.ts faults --fault none|crash|stall|rolling [--plant no-cursor]`.
   Answered: a watcher's `Last-Event-ID` resumes on another instance without a gap. Record below.
3. **Database failover. BUILT.** Answered: it handed them out again, and then lost the slots on
   reconnect; both fixed in `src/storage/postgres.ts`. Record below.
4. **Soak.** Phase 1's mix for 6 and 24 hours with periodic instance faults, sampling memory,
   connections, event-log size and query plans. This is item 6 of the benchmark review, run on this
   stack rather than built separately.

A phase's findings go to [gotchas.md](gotchas.md) or [plan-audit-remediation.md](plan-audit-remediation.md),
and its numbers into `bench/README.md` with the environment header `bench/env.ts` prints.

## Phase 0 record

- **`synchronous_standby_names` cannot be a startup flag.** The image's init-time server takes the
  same flags, so the init script's first commit waited forever for a standby that cannot exist yet.
  The primary starts async and `Cluster.setSync` switches it with `alter system` plus a reload,
  which also lets one cluster change arms without a restart.
- **The proxy needs TCP_NODELAY on both legs.** Without it a Radia read through the proxy took
  about 45ms (p50) instead of 2-3ms, and the authprobe made 248 attempts in 20 rounds instead of
  about 5,000. The check that catches it measures Radia reads through an instance: a check on one
  parameterized query passed with the fault planted, and was replaced. Proved red.
- **The harness's own Postgres client needs the same fix** the runtime applies
  (`enableTcpNoDelay`, `src/storage/postgres.ts`, not exported): without it every harness query
  takes about 42ms. `cluster.ts` patches `Deno.connect` the same way.
- **SeaweedFS `server` mode ignores SIGTERM**, so `down` waited out docker's 10s grace per run
  (`init: true` did not help). `stop_grace_period: 1s`; `down` now takes about 1.5s.
- **Instances exit on SIGTERM in 0.1s with code 0**, checked every cycle, so a SIGKILL there is a
  shutdown defect rather than a slow harness.
- Up takes 7-15s, most of it the standby's `pg_basebackup` and the switch to sync.

## Phase 1 record

Default load, 30s per N, synchronous standby, one host (the header `bench/env.ts` prints is in the
run's output):

| N | ops/s | DB calls/op | connections | watch p50 / p99 | violations |
|---|-------|-------------|-------------|-----------------|------------|
| 1 | 1430  | 7.1         | 8           | 2.2 / 19ms      | 0          |
| 2 | 1603  | 7.4         | 16          | 4.6 / 62ms      | 0          |
| 4 | 1704  | 7.8         | 32          | 11.1 / 101ms    | 0          |
| 8 | 1421  | 8.9         | 61          | 15.3 / 103ms    | 0          |

- **These numbers were taken without a warm-up, so each window straddles a clock step** (found in
  phase 2, below): the first 15s or so of every run ran at turbo clock. `--warmup` (default 30s) now
  precedes every timed window; the shapes above hold, the absolute ops/s are high by up to a third.
- **Throughput does not scale with N here, and is not expected to.** Every instance shares one host
  and one Postgres, and the loops are closed at a fixed concurrency, so the ceiling is the commit:
  a put's p50 is 12-15ms at every N under synchronous replication. The table measures cost and
  correctness per instance added, not capacity.
- **Each instance holds its full pool** (`poolSize` 8, `src/storage/postgres.ts`), so 8 instances
  use 61 of Postgres's default 100 connections and a 13th cannot start. Size `max_connections` for
  `instances x poolSize` plus headroom. Since then: `--pg-pool-size` sets it, and `ClientPool` closes
  a connection idle for 60s down to one per instance. Measured (`run.ts steady --instances 4
  --pool-size n [--idle-check]`, 40s after a 30s warm-up, one run each):

  | pool | connections | ops/s | put p50 / p99 | read_one p50 / p99 | 75s after the load |
  |------|-------------|-------|---------------|--------------------|--------------------|
  | 2    | 8           | 840   | 19.1 / 91.5ms | 11.4 / 63.5ms      |                    |
  | 4    | 16          | 1,124 | 16.4 / 41.3ms | 6.4 / 22.4ms       |                    |
  | 8    | 32          | 1,090 | 16.9 / 44.6ms | 6.7 / 18.2ms       | 4 (one per instance) |

  At this load (about 5 concurrent operations per instance) 4 matches 8 within noise on half the
  connections, and 2 costs a quarter of the throughput and doubles the tails. The default stays 8:
  a single instance carrying a whole deployment's concurrency needs the headroom, and the reaper
  makes it cost nothing once a burst is over.
- **DB calls per op rise with N** (7.1 to 8.9): each instance with a parked watch polls the event log
  every `CHANGE_POLL_MS` (250ms, `src/core/notifier.ts`), so the polling is per instance.
- **Cross-instance watch latency is poll-bound**: p99 grows from 19ms at N=1 to about 100ms once most
  writes land on another instance. Inferred: under 250ms because a local write wakes the waiter,
  which then reads the foreign events already in the log; an idle instance would wait the full poll.
- **Deviations from the plan above.** Loops are closed by default (`--rate` paces them; fixed-rate
  comparison matters from phase 2). `stale reads` was added to the oracle (a `read_one` through
  another instance after the put was acknowledged). Zombies get their own kind: sharing the task
  kind, the ordinary workers took every lapsed lease first and the late settle was never asked.
  The chain check calls `integrity` until nothing is unsealed, since one call seals one 500-event batch.

**Every audit line was proved red.** Seven by `--plant` (the audit reads what it claims to), six by
a temporary edit to `src/`, reverted after the run (the runtime fault reaches the audit):

| Audit line           | Planted by                                                              | Count |
|----------------------|-------------------------------------------------------------------------|-------|
| lost writes          | `--plant lost`: delete an acknowledged record                           | 1     |
| duplicate commits    | `--plant dup-commit`; and `withIdem` skipping its lookup (pgbase.ts)    | 1; 408 |
| duplicate results    | `--plant dup-result`                                                    | 1     |
| stale settlements    | ack's `leaseValid` AND its SQL fence both removed (pgbase.ts)           | 4     |
| stranded work        | `--plant stranded`: a task held leased forever                          | 1     |
| stale reads          | query SQL hiding the newest 20 `bench_rec` rows, a lagging replica      | 2016  |
| stale grants         | `isRetired` answering false (sdk/ts/registry.ts)                        | 592   |
| stale credentials    | `resolveCredential` ignoring both a stop and the missing expiry (identity.ts) | 861 |
| watch gaps           | the SSE handler dropping every 50th wakeup (watches.ts)                 | 80    |
| unreadable artifacts | `--plant artifact`: delete one blob from the bucket                     | 1     |
| chain                | `--plant chain`: alter a SEALED event (an unsealed one is sealed as altered, correctly) | 1 |
| resurrected grants, runs (phase 3) | `--plant resurrect`: delete the newest revocation and the newest stop | 2, 1 |

The fence and the stop each have TWO layers, and removing one was not enough: `leaseValid` refuses
before the SQL fence is reached, and a stop successor carries no `expiresAt`, so the expiry check
refuses it too. Both plants reported zero until both layers were gone.

## Phase 2 record

N = 3, 60s after a 30s warm-up, 10s leases, synchronous standby. Every request goes through
`Fleet` (`bench/cluster/fleet.ts`), which does what a load balancer would: a network error, a 5s
silence, a 5xx or a stale operator token sets the instance aside until a health check through its
operator client passes, and the SAME request (same idempotency key; acks keyed by lease) goes to the
next instance. Watchers are `resumableWatch`: re-created on the next instance with `Last-Event-ID`.

| Fault (`faults.ts`)                   | Failovers | Watchers moved | Worst second       | Back to 90%        | Violations |
|---------------------------------------|-----------|----------------|--------------------|--------------------|------------|
| none (control)                        | 0         | 0              | flat, 1000-1400/s  | -                  | 0          |
| crash: SIGKILL at 15s, restart at 25s | 8         | 2              | no dip below 90%   | 1s; restarted instance answers in its first second | 0 |
| stall: SIGSTOP 15s, SIGCONT 30s       | 30        | 4              | 0 ops/s at 17s     | 5s after the stop; 1s after it resumes | 0 |
| rolling: each instance restarted, 12s apart | 22  | 8              | 218 ops/s at 34s   | 1-2s per restart   | 0          |

- **The cursor is portable.** Watchers moved in every fault run and none missed a record. Proved
  red: `--plant no-cursor` (reconnect without `Last-Event-ID`) reported 22 gaps on the one watcher
  that moved during a crash.
- **A stall costs the whole load one request timeout.** Every loop has a request on the stalled
  instance within a second, so throughput is zero until the 5s timeout fires; after that the other
  two carry it. That part is inherent to a stall behind any balancer and is bounded by its timeout.
- **Late answers converge.** Acks the stalled instance held were resent elsewhere under the same
  lease-keyed idempotency key; zero duplicate results and zero stale settlements, and no ack answered
  `lease_lost`. Inferred, not observed per request: the stalled originals, answered after SIGCONT,
  replayed the stored response. The fence itself is exercised by the zombies (phase 1).
- **Harness findings, fixed in the harness.** (1) A fixed 2s ejection re-admitted the STALLED
  instance on a timer, so every loop's next request went to it at once and the load dropped to zero
  every 7s until it resumed; ejection now lasts until a health check passes. (2) The authprobe hit
  `too_many_grants` after 128 rounds (256 grant records per principal and kind, never compacted,
  so the cap is working); `AuthRounds` moves to a fresh agent every 100 rounds. (3) A laptop CPU
  drops from about 3.2 to 2.0 GHz after about 15s of this load (sampled from `scaling_cur_freq`) and
  throughput drops a third with it, identically in the no-fault control; hence `--warmup`. It was
  first taken for a runtime regression, and ruled out as the amortized ANALYZE (disabled: same step)
  and as the buffer cache (the database was 50MB with a 100% hit rate; 1GB of buffers: same step).
  (4) The `too_many_grants` error was thrown in a background loop, and the unhandled rejection ended
  the process without its `finally`, leaving a cluster running; `run.ts` now tears down on one.
- **Not a violation, counted apart:** authorization rounds whose writer or revoker was the dead
  instance are abandoned whole (about 20 per crash run), since their probes would measure the outage.

## Phase 3 record

`run.ts faults --fault failover|failover-lag|partition [--async]`: `Cluster.killPrimary`,
`cutReplication` and `promoteStandby`, `PgProxy.partition`/`heal`, per-instance failovers on the
timeline, instance ERROR lines grouped before teardown, and `AuthRounds.finalCheck`, which re-probes
every identity whose last acknowledged write was a revocation and every stopped run at the END (a
failover can undo a revocation long after the 200ms windows).

| Arm (N = 3)                                   | Recovery                         | Violations |
|-----------------------------------------------|----------------------------------|------------|
| failover, sync                                | 90% in 1s; ~40 failed requests per instance, all failed over | 0 |
| failover, async                               | the same                         | 0 (one host: nothing was unreplicated at the kill) |
| failover-lag (link cut 5s before), sync       | commits wait from the cut, as they must; 90% 1s after the kill | 0 |
| failover-lag, ASYNC (the control)             | 90% in 4s                        | 2,861 lost writes, 273 unreadable artifacts (all on lost records), 1 stale read: EXPECTED, and the demonstration design-storage.md's synchronous-replication rule rests on. Also 3,830 watch gaps on SURVIVING records, defect 3, since fixed (re-run: 0) |
| partition (every DB byte held 20s)            | 0 ops/s for the 20s, back at once on heal | 1 unreadable artifact, defect 4, since fixed (re-run: 0) |

**Four runtime defects, all fixed:**

1. **A connection that died without the server's goodbye poisoned its pool slot for good.**
   Instances logged ~2,130 `Broken pipe` each for 9 minutes against a healthy new primary; one
   abrupt disconnect through the proxy failed 120 of the next 120 requests. (`pg_terminate_backend`
   is NOT a trigger: it sends a FATAL message first, which the driver always handled; a first
   version of the regression test was built on it and passed against the broken code.) The driver resets only on its own `ConnectionError`, and
   `end()` writes before its `finally` closes. FIXED: `hardenSocket` (`src/storage/postgres.ts`)
   makes a failed socket answer end-of-stream; the same reproduction now fails 1 of 120.
2. **The driver's `Pool` lost a slot on every failed reconnect** (`DeferredAccessStack.pop` never
   returns a client whose connect threw), so any outage emptied it and every request waited forever,
   including `/v0/health`. Traced with per-call instrumentation (reverted). FIXED: `ClientPool`.
   Guard for both: `test/pgreconnect.test.ts` (live Postgres, in `test:conformance:pg`).
3. **After an ASYNC failover, watchers silently skip records that survived.** Of 3,837 gaps, 3,830
   are on records present on the new primary. Inferred mechanism: the promoted standby's transaction
   ids are behind the cursor the watchers hold (`<xid>.<seq>`, `src/storage/pgbase.ts`), so
   `(xid, seq) > cursor` passes over new events until the counter catches up. Synchronous arms: 0
   gaps. FIXED: a cursor at or past the database's next xid (`pg_snapshot_xmax`; SQLite's
   `sqlite_sequence`, for a restore from an older copy) is refused as `cursor_expired`, checked only
   on an empty page; the watch endpoint 410s, an open stream ends into that 410, the notifier's own
   poll restarts from the head, `/v0/ops/events` answers `cursorAhead`. Re-run: 0 gaps on surviving
   records (was 3,830), 3 watchers re-synced. Residual: a client away until the new primary's xids
   pass its cursor is not detected. Guard: `test/conformance/suites/events.ts`.
4. **`S3BlobStore.put` can pair one writer's ciphertext with another's key.** A deduped put `touch`es
   the object (copy onto itself, `REPLACE`) with the key header from its earlier `HEAD`; a writer
   that replaced the object in between leaves ciphertext B under key A, undecryptable for good
   (`Decryption failed`, 264 attempts per instance on one artifact whose record exists). Two writers
   of the same bytes is exactly an idempotent retry through another instance, which a partition makes
   likely. Reproduced by forcing the interleaving (write, HEAD, replace, stale copy): the committed
   code read back `Decryption failed`. FIXED: the copy is conditional on the HEAD's `ETag`
   (`x-amz-copy-source-if-match`, which SeaweedFS honours: a stale one answers 412), and a refused
   copy makes `put` write its own complete object. Re-run: the partition arm 0 violations. Guard:
   `test/s3race.test.ts`. Unexamined: the file store's key sidecar under two concurrent puts.

What is still open (the unexecuted TLS path, 500 for an outage, and two smaller gaps) is
[plan-audit-remediation.md](plan-audit-remediation.md) package AC; a black-holed database and the
idle cost of the cursor check were fixed there since.

Also found: a database outage reaches clients as `500 internal`, not a retryable `503`; the SDK
and any load balancer treat those differently. Harness fixes: `run.ts` tears down on SIGTERM (a
`timeout` left a cluster running); the drain asks the DATABASE for unconsumed tasks (comparing
ledger counts let it end with a task still leased, reported as stranded); a failed authorization
round backs off 250ms (a one-second outage counted as ~190 abandoned rounds). A proxy half-close
(`closeWrite`) was tried and reverted: an isolated test showed Deno delivers end-of-stream on close
even with a read pending, so it fixed nothing.

## Known exclusions

- **Download capabilities** (`CapabilityStore`, `src/core/artifacts.ts`) are process-local and need
  sticky routing (design-storage.md). The artifact stream reads through `/v0` only.
- **Operator tokens are per process**, so the generator provisions through one instance and holds
  one operator token per instance, re-read from `--operator-token-file` after a restart.
- **One host.** Everything shares a machine, so latency is flattered and CPU contended. Numbers
  from this stack compare runs with each other, never with a production deployment.
- **Not in CI.** A run takes minutes to hours and needs docker; it runs by hand before a release.

## Open questions

- Whether the proxy flip should instead be a restart of every instance with a new `--db`, which
  is what a deployment without a stable endpoint does. Inferred: both are worth one run, and the
  proxy is the default.
- Whether a failover arm with a connection pooler (PgBouncer) in front belongs here or in its own
  row. In transaction mode a session `SET` does not stay with the connection, and the adapter pins
  a non-default schema with `set search_path` outside a transaction on every acquire
  (`withConn`, `src/storage/postgres.ts`). Inferred: correct only with the default schema.
