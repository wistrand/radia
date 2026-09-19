// The cluster benchmark's workload, its ledger, and the oracle that audits one against the other
// (agent_docs/plan-cluster-bench.md, "Workload" and "The oracle").
//
// Every stream runs as concurrent loops, each request through the next instance in rotation, so no
// stream is pinned to an instance and every cross-instance path is exercised. The generator writes
// down what the space ACKNOWLEDGED; the audit, after the load stops, compares that ledger with the
// database and with what the instances serve. A violation is a disagreement between the two, never a
// slow answer.
//
// Streams: records (put with an idempotency key, a cross-instance retry of some, read_one and query),
// claims (producers and workers), zombies (a task of its own kind whose 1s lease is left to lapse,
// reclaimed through another instance, then settled by the original holder, which must be refused),
// watches (one SSE
// stream per instance on the record kind), authorization (`AuthRounds`), artifacts (bytes through one
// instance, read back through another) and housekeeping (`gc` from two instances at once).

import type { RadiaClient } from "../../sdk/ts/client.ts";
import type { Lease } from "../../sdk/ts/wire.ts";
import type { Measurement } from "../harness.ts";
import { AuthRounds } from "./authrounds.ts";
import type { Cluster } from "./cluster.ts";
import { Fleet, resumableWatch, unavailable, type WatchStats } from "./fleet.ts";

export const REC = "bench_rec";
export const TASK = "bench_task";
export const RESULT = "bench_result";
export const ZTASK = "bench_zombie_task";

export interface LoadOptions {
  durationMs: number;
  recordLoops: number;
  producers: number;
  workers: number;
  artifactLoops: number;
  /** Per-loop pacing in operations per second; undefined runs each loop closed (as fast as it can). */
  rate?: number;
  /** Fraction of record puts re-sent through ANOTHER instance with the same idempotency key. */
  retryFraction: number;
  /** Loops producing zombies: a lease left to lapse, reclaimed elsewhere, then settled late. */
  zombieLoops: number;
  /** A worker's lease. Fault runs shorten it so a stall can outlast it inside the window. */
  leaseSeconds: number;
  /** False makes a reconnecting watcher drop its cursor: the planted fault for watch gaps. */
  watchResume?: boolean;
  /** Load before the timed window, discarded from every measurement (see `runLoad`). */
  warmupMs: number;
  /** A fault schedule, started with the timed window; `mark` stamps an event on the timeline. */
  during?: (fleet: Fleet, mark: (what: string) => void) => Promise<void>;
  gcEveryMs: number;
  authWindowMs: number;
  /** After the load stops: how long workers may drain the task backlog, and watchers catch up. */
  drainMs: number;
  graceMs: number;
  log: (line: string) => void;
}

export const DEFAULT_LOAD: Omit<LoadOptions, "log"> = {
  durationMs: 30_000,
  recordLoops: 8,
  producers: 2,
  workers: 8,
  artifactLoops: 2,
  retryFraction: 0.1,
  zombieLoops: 1,
  leaseSeconds: 30,
  warmupMs: 0,
  gcEveryMs: 10_000,
  authWindowMs: 200,
  drainMs: 60_000,
  graceMs: 3_000,
};

/** What the space acknowledged, and what the generator saw that already contradicts it. */
export class Ledger {
  readonly recByKey = new Map<string, string>();
  readonly recAckedAt = new Map<string, number>();
  readonly tasks = new Set<string>();
  readonly results = new Set<string>();
  readonly executions = new Map<string, number>();
  readonly completed = new Set<string>();
  readonly artifacts: { id: string; bytes: Uint8Array }[] = [];
  /** One set of delivered record ids per watcher. */
  readonly seen: Set<string>[] = [];
  // Violations observed in flight.
  retryNewId = 0;
  staleReads = 0;
  staleSettlements = 0;
  artifactMismatch = 0;
  // Not violations, but what a reader needs to interpret the rest.
  emptyTakes = 0;
  ackLost = 0;
  zombies = 0;
  zombieReclaimMiss = 0;
  errors = new Map<string, number>();
  watchLatencies: number[] = [];

  /** The first message per stream, since a count alone cannot say what kept failing. */
  readonly firstError = new Map<string, string>();

  error(stream: string, e?: unknown): void {
    this.errors.set(stream, (this.errors.get(stream) ?? 0) + 1);
    if (e !== undefined && !this.firstError.has(stream)) this.firstError.set(stream, String(e).slice(0, 160));
  }
}

/** Per-operation samples, one Measurement per label at the end. */
class Samples {
  readonly #by = new Map<string, number[]>();
  /** Forget everything, at the end of the warm-up. */
  reset(): void {
    this.#by.clear();
  }
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    const list = this.#by.get(label) ?? [];
    list.push(performance.now() - t0);
    this.#by.set(label, list);
    return out;
  }
  measurements(elapsedMs: number): Measurement[] {
    return [...this.#by].map(([label, samples]) => ({ label, samples, elapsedMs }));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface LoadResult {
  ledger: Ledger;
  auth: AuthRounds;
  fleet: Fleet;
  watchStats: WatchStats;
  timeline: Timeline;
  measurements: Measurement[];
  elapsedMs: number;
  /** Client operations issued during the timed window, for queries per operation. */
  ops: number;
  dbCalls: number;
  connections: { max: number; mean: number };
}

export async function declareKinds(admin: RadiaClient): Promise<void> {
  await admin.registerKind({ kind: REC, indexedPaths: [{ path: "key", type: "keyword" }, { path: "bucket", type: "integer" }] });
  await admin.registerKind({ kind: TASK, indexedPaths: [{ path: "key", type: "keyword" }] });
  await admin.registerKind({ kind: ZTASK, indexedPaths: [{ path: "key", type: "keyword" }] });
  await admin.registerKind({ kind: RESULT, indexedPaths: [{ path: "task", type: "keyword" }], claimable: false });
}

export async function runLoad(cluster: Cluster, o: LoadOptions): Promise<LoadResult> {
  const fleet = new Fleet(cluster);
  const call = <T>(fn: (c: RadiaClient) => Promise<T>) => fleet.call(fn);
  const ledger = new Ledger();
  const s = new Samples();
  const tag = Date.now().toString(36);
  let ops = 0;
  let stopped = false; // the timed load
  let draining = false; // producers stopped, workers finishing the backlog
  let drained = false; // the database holds no unconsumed task, or the drain gave up
  const pace = o.rate ? 1000 / o.rate : 0;
  let t0 = performance.now();
  const second = () => Math.floor((performance.now() - t0) / 1000);
  let timeline = new Timeline(fleet.n);
  fleet.onSuccess = (i) => timeline.success(second(), i);
  fleet.onFailover = (i) => timeline.failover(second(), i);
  const done = () => ops++;

  await declareKinds(fleet.clients[0]);

  // Watchers first, and given a moment to connect: a watch sees what commits after it exists. Each
  // starts on its own instance and resumes on another when that one fails.
  const watchAbort = new AbortController();
  const watchStats: WatchStats = { reconnects: 0, moved: 0, resyncs: 0 };
  const watchers = fleet.clients.map((_, i) => {
    ledger.seen[i] = new Set();
    return resumableWatch(fleet, i, { kind: REC }, (w) => {
      ledger.seen[i].add(w.recordId);
      const at = ledger.recAckedAt.get(w.recordId);
      if (at !== undefined) ledger.watchLatencies.push(performance.now() - at);
    }, watchAbort.signal, watchStats, 5_000, o.watchResume !== false, async () => {
      // Every record of the kind, exhaustively, through any instance: what the stream cannot deliver.
      const all = await fleet.call((c) => c.queryAll({ kind: REC }));
      for (const rec of all) ledger.seen[i].add(rec.id);
    });
  });
  await sleep(1_000);

  // `fleet.clients` is replaced in place on a restart, so the rounds follow the new tokens.
  const auth = await AuthRounds.create(fleet.clients, cluster.urls, { windowMs: o.authWindowMs });

  let connSamples: number[] = [];
  t0 = performance.now();

  const loop = (stream: string, body: (i: number) => Promise<void>, until: () => boolean = () => stopped) =>
    async (i: number) => {
      while (!until()) {
        const started = performance.now();
        try {
          await body(i);
        } catch (e) {
          if (unavailable(e)) ledger.error(stream, e);
          else throw e;
        }
        if (pace) await sleep(Math.max(0, pace - (performance.now() - started)));
      }
    };

  let recN = 0;
  const records = loop("records", async (i) => {
    const k = recN++;
    const key = `${tag}:r:${k}`;
    const body = { key, bucket: k % 64, loop: i };
    const { id } = await s.time("rec put", () => call((c) => c.put({ kind: REC, body }, key)));
    done();
    ledger.recByKey.set(key, id);
    ledger.recAckedAt.set(id, performance.now());
    if (Math.random() < o.retryFraction) {
      // The retry a client makes when it never saw the answer: same key, another instance.
      const again = await s.time("rec put retry", () => call((c) => c.put({ kind: REC, body }, key)));
      done();
      if (again.id !== id) ledger.retryNewId++;
    }
    const read = await s.time("rec read_one", () => call((c) => c.readOne({ kind: REC, match: { key } })));
    done();
    if (read?.id !== id) ledger.staleReads++;
    await s.time("rec query", () => call((c) => c.queryNewest({ kind: REC, match: { bucket: k % 64 } }, 10)));
    done();
  });

  let taskN = 0;
  const producers = loop("claims", async () => {
    const key = `${tag}:t:${taskN++}`;
    const { id } = await s.time("task put", () => call((c) => c.put({ kind: TASK, body: { key } }, key)));
    done();
    ledger.tasks.add(id);
  });

  // Keyed by the LEASE, so an ack whose answer was lost and is resent through another instance
  // replays the stored answer instead of reading as lease_lost (idempotency before lease validation).
  const settle = async (lease: Lease, task: string, via?: RadiaClient) => {
    const ack = (c: RadiaClient) => c.ack(lease, { kind: RESULT, body: { task } }, `ack:${lease.leaseId}`);
    const r = await s.time("ack", () => via ? ack(via) : call(ack));
    done();
    if (r.status === "ok") {
      ledger.completed.add(task);
      if (r.resultId) ledger.results.add(r.resultId);
    } else ledger.ackLost++;
  };
  let drainTurn = 0;
  const workers = loop("claims", async () => {
    // During the drain, every other take is for the zombie kind: a zombie task whose put timed out
    // but committed later is in no ledger, and only a worker can finish it.
    const kind = draining && drainTurn++ % 2 === 1 ? ZTASK : TASK;
    const claim = await s.time("take", () => call((c) => c.take({ pattern: { kind } }, { leaseSeconds: o.leaseSeconds })));
    done();
    if (!claim) {
      ledger.emptyTakes++;
      await sleep(20);
      return;
    }
    const id = claim.record.id;
    ledger.executions.set(id, (ledger.executions.get(id) ?? 0) + 1);
    await settle(claim.lease, id);
  }, () => draining ? drained : stopped);

  // The zombie: a task of its OWN kind, so no ordinary worker claims it first (with them sharing
  // one kind, every lapsed lease was taken by a worker and the late settle was never asked). Its
  // lease lapses, another instance reclaims it by id, and only then does the original holder try to
  // settle. Both of its settles must be refused. The holder's settles go through the instance that
  // granted the lease, without failover, since which instance asks is the point.
  let zombieN = 0;
  const zombies = loop("claims", async () => {
    const key = `${tag}:z:${zombieN++}`;
    const { id } = await call((c) => c.put({ kind: ZTASK, body: { key } }, key));
    ledger.tasks.add(id);
    let holder: RadiaClient | undefined;
    const claim = await call((c) => (holder = c).take({ recordId: id }, { leaseSeconds: 1 }));
    ops += 2;
    if (!claim || !holder) return void ledger.zombieReclaimMiss++;
    ledger.zombies++;
    ledger.executions.set(id, 1);
    await sleep(1_300);
    const again = await call((c) => c.take({ recordId: id }, { leaseSeconds: o.leaseSeconds }));
    ops++;
    if (!again) {
      // Not reclaimable after its lease lapsed: nothing to fence against, so the late settle is not
      // asked, and the task is settled by its holder rather than left stranded.
      ledger.zombieReclaimMiss++;
      return settle(claim.lease, id);
    }
    ledger.executions.set(id, 2);
    try {
      const late = await holder.ack(claim.lease, { kind: RESULT, body: { task: id, zombie: true } });
      const renew = await holder.renew(claim.lease, { leaseSeconds: 30 });
      ops += 2;
      if (late.status === "ok") ledger.staleSettlements++;
      if (renew.status === "ok") ledger.staleSettlements++;
    } catch (e) {
      // The holder's instance went away: its late settle was never asked, which proves nothing.
      if (!unavailable(e)) throw e;
      ledger.error("zombie holder", e);
    }
    await settle(again.lease, id);
  });

  const artifacts = loop("artifacts", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024 + Math.floor(Math.random() * 63 * 1024)));
    const key = `${tag}:a:${crypto.randomUUID()}`;
    const rec = await s.time("artifact put", () => call((c) => c.putArtifact(bytes, { mediaType: "application/octet-stream", idempotencyKey: key })));
    ledger.artifacts.push({ id: rec.id, bytes });
    const back = await s.time("artifact get", () => call((c) => c.getArtifact(rec.id)));
    ops += 2;
    if (await hex(back) !== await hex(bytes)) ledger.artifactMismatch++;
  });

  const authLoop = (async () => {
    for (let r = 0; !stopped; r++) {
      try {
        await s.time("auth round", () => auth.round(r));
      } catch (e) {
        // A round whose writer or revoker is down is abandoned whole: its probes would measure the
        // outage, not authorization.
        if (unavailable(e)) ledger.error("authorization", e);
        else throw e;
        // A round that fails does so in milliseconds, so without a pause an outage of one second
        // is counted as hundreds of abandoned rounds.
        await sleep(250);
      }
    }
  })();

  const gcLoop = (async () => {
    while (!stopped) {
      await sleep(o.gcEveryMs);
      if (stopped) break;
      // Two at once: plan-gc.md says concurrent sweeps are safe, and this is where that meets a live space.
      await Promise.all([0, 1].map(() =>
        s.time("gc", () => call((c) => c.gc({ compact: true }))).then(done, (e) => unavailable(e) ? ledger.error("gc", e) : Promise.reject(e))
      ));
    }
  })();

  const connLoop = (async () => {
    while (!stopped) {
      // A sample the database cannot answer (its primary just died) is skipped, not fatal.
      const row = await cluster.sql<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = 'radia' and backend_type = 'client backend' and pid <> pg_backend_pid()",
      ).then(([r]) => r, () => undefined);
      if (row) connSamples.push(row.n);
      await sleep(1_000);
    }
  })();

  const all = [
    ...Array.from({ length: o.recordLoops }, (_, i) => records(i)),
    ...Array.from({ length: o.producers }, (_, i) => producers(i)),
    ...Array.from({ length: o.workers }, (_, i) => workers(i)),
    ...Array.from({ length: o.artifactLoops }, (_, i) => artifacts(i)),
    ...Array.from({ length: o.zombieLoops }, (_, i) => zombies(i)),
  ];
  const progress = setInterval(() => o.log(`${second()}s: ${ops} ops, ${fleet.failovers} failovers`), 10_000);
  if (o.warmupMs > 0) {
    // The load runs, and then everything that MEASURES starts over: samples, the op count, the
    // timeline, the connection samples and pg_stat_statements. A laptop holds its turbo clock for
    // the first 15s or so of sustained load and then drops about a third of its frequency, and a
    // window straddling that step reads as a fault or a recovery. The ledger is not reset: every
    // write, warm-up included, is audited.
    o.log(`warming up for ${o.warmupMs / 1000}s`);
    await sleep(o.warmupMs);
    s.reset();
    ops = 0;
    connSamples = [];
    timeline = new Timeline(fleet.n);
    t0 = performance.now();
  }
  await cluster.sql("select pg_stat_statements_reset()");
  const faults = o.during?.(fleet, (what) => {
    timeline.mark(second(), what);
    o.log(`${second()}s: ${what}`);
  });
  await sleep(o.durationMs);
  await faults; // a schedule longer than the window finishes before the load stops
  stopped = true;
  draining = true;
  const elapsedMs = performance.now() - t0;
  clearInterval(progress);

  // Read the counters before the drain and the audit add their own statements.
  const [calls] = await cluster.sql<{ calls: string }>(
    "select coalesce(sum(calls), 0)::text as calls from pg_stat_statements where query not ilike '%pg_stat%'",
  ).catch(() => [{ calls: "0" }]);
  const opsInWindow = ops;

  // Drain: producers and the record loops end with the window; workers keep claiming until the
  // DATABASE holds no unconsumed task, or the budget runs out, which the audit reports as stranded.
  // Asked of the database, not the ledger: a put that timed out and committed later is a task no
  // ledger holds, and comparing counts let the drain end while a ledger task was still leased.
  const drainStart = performance.now();
  const drainWatch = (async () => {
    while (performance.now() - drainStart < o.drainMs) {
      const [row] = await cluster.sql<{ n: number }>(
        "select count(*)::int as n from records r join record_runtime rt on rt.record_id = r.id where r.kind = any($1::text[]) and rt.state <> 'consumed'",
        { params: [[TASK, ZTASK]] },
      ).catch(() => [{ n: -1 }]);
      if (row.n === 0) break;
      await sleep(500);
    }
    drained = true;
  })();
  await Promise.all([...all, authLoop, gcLoop, connLoop, drainWatch]);
  await sleep(o.graceMs); // watchers catch up to the last write
  watchAbort.abort();
  await Promise.all(watchers);
  fleet.close();

  const mean = connSamples.reduce((a, b) => a + b, 0) / Math.max(1, connSamples.length);
  return {
    ledger,
    auth,
    fleet,
    watchStats,
    timeline,
    measurements: s.measurements(elapsedMs),
    elapsedMs,
    ops: opsInWindow,
    dbCalls: Number(calls.calls),
    connections: { max: Math.max(0, ...connSamples), mean },
  };
}

/** Successes per second, overall and per instance, failovers per second, and the fault marks. */
export class Timeline {
  readonly ops: number[] = [];
  readonly failovers: number[] = [];
  readonly perInstance: number[][];
  readonly failoversPerInstance: number[][];
  readonly marks: { second: number; what: string }[] = [];
  constructor(n: number) {
    this.perInstance = Array.from({ length: n }, () => []);
    this.failoversPerInstance = Array.from({ length: n }, () => []);
  }
  success(sec: number, i: number): void {
    this.ops[sec] = (this.ops[sec] ?? 0) + 1;
    this.perInstance[i][sec] = (this.perInstance[i][sec] ?? 0) + 1;
  }
  failover(sec: number, i: number): void {
    this.failovers[sec] = (this.failovers[sec] ?? 0) + 1;
    this.failoversPerInstance[i][sec] = (this.failoversPerInstance[i][sec] ?? 0) + 1;
  }
  mark(sec: number, what: string): void {
    this.marks.push({ second: sec, what });
  }
}

/**
 * Faults planted AFTER the load and BEFORE the audit, each damaging the state one audit line reads,
 * so a run with one reports that line nonzero. They prove the audit can see what it claims to; they
 * do not prove the runtime can produce it. The faults that need the RUNTIME broken (a settle that
 * ignores the fence, a projection that ignores a retirement, a dropped wakeup) are planted by a
 * temporary edit to `src/`, recorded in plan-cluster-bench.md's phase 1 record.
 */
export const PLANTS: Record<string, { breaks: string; apply: (c: Cluster, r: LoadResult) => Promise<void> }> = {
  lost: {
    breaks: "lost writes",
    apply: async (c, r) => {
      const id = r.ledger.recByKey.values().next().value!;
      await c.sql("delete from record_edges where child_id = $1 or parent_id = $1", { params: [id] });
      await c.sql("delete from record_runtime where record_id = $1", { params: [id] });
      await c.sql("delete from records where id = $1", { params: [id] });
    },
  },
  "dup-commit": { breaks: "duplicate commits", apply: (c, r) => copyRecord(c, r.ledger.recByKey.values().next().value!) },
  "dup-result": { breaks: "duplicate results", apply: (c, r) => copyRecord(c, r.ledger.results.values().next().value!) },
  stranded: {
    breaks: "stranded work",
    apply: async (c, r) => {
      await c.sql(
        "update record_runtime set state = 'leased', lease_id = 'planted', leased_until = '9999-01-01T00:00:00.000Z' where record_id = $1",
        { params: [r.ledger.tasks.values().next().value!] },
      );
    },
  },
  artifact: {
    breaks: "unreadable artifacts",
    apply: async (c, r) => {
      const meta = await c.admins()[0].artifactMeta(r.ledger.artifacts[0].id);
      await (await c.blobStore()).delete(meta!.digest);
    },
  },
  resurrect: {
    // What a failover to a standby that never received them does: the newest revocation and the
    // newest stop are gone, so the grant and the run are live again. Only the END-state probe
    // (`AuthRounds.finalCheck`) can see that; the 200ms windows closed long ago.
    breaks: "resurrected grants",
    apply: async (c) => {
      for (const where of ["kind = 'grant' and body_json::jsonb->>'retired' = 'true'", "kind = 'agent_run' and body_json::jsonb->>'status' = 'stopped'"]) {
        const [row] = await c.sql<{ id: string }>(`select id from records where ${where} order by write_order desc limit 1`);
        await c.sql("delete from record_edges where child_id = $1 or parent_id = $1", { params: [row.id] });
        await c.sql("delete from record_runtime where record_id = $1", { params: [row.id] });
        await c.sql("delete from records where id = $1", { params: [row.id] });
      }
    },
  },
  chain: {
    breaks: "chain",
    apply: async (c) => {
      // Seal first. Sealing is lazy, so an event altered before it was sealed is sealed AS altered,
      // and the chain rightly reports nothing: it attests what happened after sealing, not before.
      const admin = c.admins()[0];
      for (let i = 0; i < 10_000 && (await admin.integrity()).unsealed > 0; i++);
      await c.sql("update events set ts = '2000-01-01T00:00:00.000Z' where seq = (select min(seq) from events)");
    },
  },
};

/** A second row with the same content and a new id: what a replayed write that missed its
 *  idempotency row would leave. */
async function copyRecord(c: Cluster, id: string): Promise<void> {
  const cols = "kind, body_json, body_sha256, client_meta, created_by, delegation_context, parent_ids, taint, taint_labels, " +
    "schema_version, created_at, deadline_at, retention_until";
  await c.sql(`insert into records (id, ${cols}) select id || 'P', ${cols} from records where id = $1`, { params: [id] });
}

export interface Violation {
  name: string;
  count: number;
  detail?: string;
}

/** The oracle: the ledger against the database and against what the instances serve. */
export async function audit(cluster: Cluster, r: LoadResult): Promise<Violation[]> {
  const l = r.ledger;
  const admins = cluster.admins();
  const acked = [...l.recByKey.values(), ...l.tasks, ...l.results, ...l.artifacts.map((a) => a.id)];
  const [present] = await cluster.sql<{ n: number }>("select count(*)::int as n from records where id = any($1::text[])", { params: [acked] });

  const dupKeys = await cluster.sql<{ k: string }>(
    "select body_json::jsonb->>'key' as k from records where kind = any($1::text[]) group by 1 having count(*) > 1",
    { params: [[REC, TASK]] },
  );
  const dupResults = await cluster.sql<{ t: string }>(
    "select body_json::jsonb->>'task' as t from records where kind = $1 group by 1 having count(*) > 1",
    { params: [RESULT] },
  );
  const stranded = await cluster.sql<{ id: string; state: string }>(
    "select r.id, rt.state from records r join record_runtime rt on rt.record_id = r.id where r.kind = any($1::text[]) and rt.state <> 'consumed'",
    { params: [[TASK, ZTASK]] },
  );

  // Which acknowledged records still exist: a gap or an unreadable artifact on a record the database
  // LOST is the lost write again, while one on a record that SURVIVED is a separate defect.
  const survivors = new Set((await cluster.sql<{ id: string }>("select id from records where id = any($1::text[])", { params: [acked] })).map((r) => r.id));

  // Every watcher stayed subscribed for the whole run, so each must have seen every record.
  const recIds = [...l.recByKey.values()];
  const gaps = l.seen.map((seen) => recIds.filter((id) => !seen.has(id)));
  const gapsOnSurvivors = gaps.reduce((a, g) => a + g.filter((id) => survivors.has(id)).length, 0);

  // Every artifact, read back through the LAST instance, which wrote few of them.
  let unreadable = l.artifactMismatch, unreadableSurvivors = 0;
  for (const a of l.artifacts) {
    const back = await admins[admins.length - 1].getArtifact(a.id).catch(() => new Uint8Array());
    if (back.length !== a.bytes.length || !back.every((b, i) => b === a.bytes[i])) {
      unreadable++;
      if (survivors.has(a.id)) unreadableSurvivors++;
    }
  }

  // Sealing is lazy, one batch per call, so a single call verified the first 500 events of tens of
  // thousands. Call until nothing is left unsealed, so the verdict covers the whole log.
  let integrity = await admins[0].integrity();
  for (let i = 0; i < 10_000 && integrity.ok && integrity.unsealed > 0; i++) integrity = await admins[0].integrity();
  const t = r.auth.totals;
  const end = await r.auth.finalCheck();
  return [
    { name: "lost writes", count: acked.length - present.n, detail: `${acked.length} acknowledged` },
    { name: "duplicate commits", count: dupKeys.length + l.retryNewId, detail: `${l.retryNewId} retries answered with a new id` },
    { name: "duplicate results", count: dupResults.length },
    { name: "stale settlements", count: l.staleSettlements, detail: `${l.zombies} zombies, ${l.zombieReclaimMiss} not reclaimable` },
    { name: "stranded work", count: stranded.length, detail: stranded.slice(0, 3).map((s) => `${s.id}:${s.state}`).join(" ") },
    { name: "stale reads", count: l.staleReads, detail: "read_one through another instance after the put was acknowledged" },
    { name: "stale grants", count: t.staleGrant.stale, detail: `${t.staleGrant.attempts} probes` },
    { name: "stale credentials", count: t.staleCredential.stale, detail: `${t.staleCredential.attempts} probes` },
    { name: "resurrected grants", count: end.resurrectedGrants, detail: `${end.identities} revoked identities, probed at the end through every instance` },
    { name: "resurrected runs", count: end.resurrectedRuns, detail: `${end.runs} stopped runs, probed at the end` },
    {
      name: "watch gaps",
      count: gaps.reduce((a, g) => a + g.length, 0),
      detail: `per watcher ${gaps.map((g) => g.length).join(",")} of ${recIds.length}; ${gapsOnSurvivors} on records that still exist`,
    },
    {
      name: "unreadable artifacts",
      count: unreadable,
      detail: `${l.artifacts.length} written; ${unreadableSurvivors} whose record still exists`,
    },
    { name: "chain", count: integrity.ok ? 0 : 1, detail: `${integrity.checked} checked, ${integrity.unsealed} unsealed` },
  ];
}
