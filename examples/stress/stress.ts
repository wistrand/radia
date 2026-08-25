// Stress / load generator (`deno task stress`). Fills a space with a WAVE of coordinated
// activity: jobs fanned out into tasks, several worker agents claiming by content, results and
// facts piling up, plus deliberate chaos (poison records that retry into `dead_letter`, abandoned
// leases left `leased`). That gives the console's **Space** tab enough structure to develop.
//
//   deno task dev                                  # terminal 1: open http://localhost:7788
//   deno task stress                               # terminal 2: one wave
//   deno task stress -- --waves 3 --tasks 600 --rate 150 --workers 6
//
// Every run is a NEW wave: a fresh wave tag, freshly minted agents (so each run adds its own
// `run` clusters), a randomized op/topic mix, and jittered volumes. Re-run it and the map keeps
// growing instead of redrawing the same picture.
//
// What actually makes that view interesting: position there is a pure function of a record's
// PROPERTIES, never its links: kind, envelope state, owning run (`spaceNodeFor` in
// src/ui/index.html). So this generator varies all three on purpose rather than just pushing
// volume.
//
// Flags: --waves N --tasks N --facts N --workers N --rate N --chaos PCT --once

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";

// ---- knobs ----
function num(name: string, def: number): number {
  const i = Deno.args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(Deno.args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
}
const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const port = new URL(url).port || "7788";
const WAVES = Math.max(1, num("waves", 1));
const TASKS = Math.max(1, num("tasks", 240)); // work items per wave
const FACTS = Math.max(0, num("facts", 120)); // never-claimed records (a pure `available` cluster)
const WORKERS = Math.min(8, Math.max(1, num("workers", 4))); // one agent per op, each its own run
const RATE = Math.max(1, num("rate", 60)); // producer records/sec
const CHAOS = Math.min(0.6, Math.max(0, num("chaos", 12) / 100)); // share of tasks that misbehave
const ONCE = Deno.args.includes("--once"); // tear down a spawned space at the end (CI)

const MAX_ATTEMPTS = 5; // server default: the 5th nack dead-letters the record
const OPS = ["upper", "reverse", "hash", "sum", "sort", "count", "dedupe", "chunk"];
const TOPICS = ["ingest", "billing", "vision", "telemetry", "search", "payments", "routing", "cache"];
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const shuffle = <T>(a: T[]): T[] => [...a].sort(() => Math.random() - 0.5);
const phrase = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const jitter = (n: number) => Math.max(1, Math.round(n * (0.75 + Math.random() * 0.5)));
const enc = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(enc.encode(s));
const tty = Deno.stdout.isTerminal();

// ---- space ----
// The launcher is the OPERATOR of its local space, and now says so with a credential instead of by
// sending no header. `probe` is liveness only, the one call that is legitimately public.
const probe = new RadiaClient(url);
let admin: RadiaClient;

async function healthy(): Promise<boolean> {
  try {
    await probe.health();
    return true;
  } catch {
    return false;
  }
}

let server: Deno.ChildProcess | null = null;
if (await healthy()) {
  console.log(`Using the space already running at ${url}`);
} else {
  console.log(`No space at ${url}; starting one...`);
  server = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "src/main.ts", "dev", "--port", port, "--storage", "sqlite"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  for (let i = 0; i < 75 && !await healthy(); i++) await sleep(200);
  if (!await healthy()) {
    console.error("space did not start");
    Deno.exit(1);
  }
}
// The space is up either way, so its credential file exists: authenticate before the first verb.
admin = new RadiaClient(url, { token: operatorToken(url) });
console.log(`Open ${url} and switch to the Space tab (colour by kind / state / run).\n`);

// Kinds are records: redeclaring the same contract is content-keyed, so re-running is a no-op
// rather than a conflict. `wave` is indexed on every kind; that is how a run selects its own.
await admin.registerKind({ kind: "stress_job", indexedPaths: [{ path: "wave", type: "keyword" }, { path: "topic", type: "keyword" }] });
await admin.registerKind({ kind: "stress_task", indexedPaths: [{ path: "wave", type: "keyword" }, { path: "op", type: "keyword" }] });
await admin.registerKind({ kind: "stress_result", indexedPaths: [{ path: "wave", type: "keyword" }, { path: "op", type: "keyword" }], claimable: false });
await admin.registerKind({ kind: "stress_fact", indexedPaths: [{ path: "wave", type: "keyword" }, { path: "topic", type: "keyword" }], claimable: false });
await admin.registerKind({ kind: "stress_summary", indexedPaths: [{ path: "wave", type: "keyword" }], claimable: false });

/** Operator action: define an agent with its grants and mint a run token, returning its client.
 *  Every wave mints its own agents, so each run shows up as new `run` clusters in the map. */
async function mintAgent(agent: string, grants: { kind: string; operations: string[] }[]): Promise<RadiaClient> {
  const { definitionToken } = await admin.createAgentDefinition(agent, grants.map((g) => ({ principal: agent, ...g })));
  const { runToken } = await admin.createRun(definitionToken);
  return new RadiaClient(url, { token: runToken });
}

interface Stats {
  put: number;
  acked: number;
  nacked: number;
  dead: number;
  stuck: number;
  summaries: number;
}

// ---- one wave ----
async function runWave(n: number): Promise<Stats> {
  const wave = `${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
  const ops = shuffle(OPS).slice(0, WORKERS); // a different op mix per run → different task clusters
  const topic = pick(TOPICS);
  const tasks = jitter(TASKS);
  const facts = jitter(FACTS);
  const stats: Stats = { put: 0, acked: 0, nacked: 0, dead: 0, stuck: 0, summaries: 0 };
  const attempts = new Map<string, number>(); // recordId -> nacks, to know when one dead-letters
  const ac = new AbortController();
  let producing = true;

  console.log(`wave ${n}/${WAVES} · tag ${wave} · topic ${topic} · ops ${ops.join(",")} · ${tasks} tasks, ${facts} facts`);

  // Producers and workers are separate agents with least-privilege grants, so the event log
  // attributes every record to a distinct run. That is the `run` axis of the layout.
  const producer = await mintAgent(`agent:stress-producer-${wave}`, [
    { kind: "stress_job", operations: ["put"] },
    { kind: "stress_fact", operations: ["put"] },
  ]);
  const planner = await mintAgent(`agent:stress-planner-${wave}`, [
    { kind: "stress_job", operations: ["take"] },
    { kind: "stress_task", operations: ["put"] },
  ]);
  const auditor = await mintAgent(`agent:stress-auditor-${wave}`, [
    { kind: "stress_result", operations: ["query"] },
    { kind: "stress_summary", operations: ["put"] },
  ]);
  const chaos = await mintAgent(`agent:stress-chaos-${wave}`, [
    { kind: "stress_task", operations: ["take"] },
  ]);
  const workers: { op: string; client: RadiaClient }[] = [];
  for (const op of ops) {
    const agent = `agent:stress-${op}-${wave}`;
    const client = await mintAgent(agent, [{ kind: "stress_result", operations: ["put"] }]);
    // Pattern-scoped grant (grant ∧ request): this worker may only take ITS op's tasks, so the
    // content routing is enforced by authorization rather than by the take pattern it happens to send.
    await admin.grant(agent, "stress_task", ["take"], { op, wave });
    workers.push({ op, client });
  }

  // Rate limiter shared by the producers so a wave animates instead of landing in one frame.
  let nextSlot = Date.now();
  async function paced(): Promise<void> {
    nextSlot += 1000 / RATE;
    const wait = nextSlot - Date.now();
    if (wait > 0) await sleep(wait);
    else nextSlot = Date.now();
  }

  // Producer: jobs (claimable work) + facts (never claimed: they stay `available` forever).
  async function produce(): Promise<void> {
    const perJob = 8;
    let queued = 0;
    let factsLeft = facts;
    while (queued < tasks || factsLeft > 0) {
      if (queued < tasks) {
        const size = Math.min(perJob, tasks - queued);
        const items = Array.from({ length: size }, () => phrase(3));
        // The chaos share is decided here, in the DATA. Workers just react to what they claim.
        const poison = items.map(() => Math.random() < CHAOS / 2);
        await producer.put({ kind: "stress_job", body: { wave, topic, op: pick(ops), items, poison } });
        stats.put++;
        queued += size;
        await paced();
      }
      if (factsLeft > 0) {
        await producer.put({ kind: "stress_fact", body: { wave, topic: pick(TOPICS), value: phrase(4), weight: Math.random() } });
        stats.put++;
        factsLeft--;
        await paced();
      }
    }
    producing = false;
  }

  // Planner: claims a job, fans it out into per-item tasks, acks the job (→ `consumed`).
  async function plan(): Promise<void> {
    let idle = 0;
    while (!ac.signal.aborted && idle < 20) {
      const claimed = await planner.take({ pattern: { kind: "stress_job", match: { wave } } }, { leaseSeconds: 30 });
      if (!claimed) {
        if (!producing) idle++;
        await sleep(60);
        continue;
      }
      idle = 0;
      const b = claimed.record.body as { items: string[]; poison: boolean[]; op: string };
      for (let i = 0; i < b.items.length; i++) {
        await planner.put({
          kind: "stress_task",
          body: { wave, op: i % 3 === 0 ? pick(ops) : b.op, input: b.items[i], poison: b.poison[i] },
          parentIds: [claimed.record.id],
        });
        stats.put++;
      }
      await planner.ack(claimed.lease);
    }
  }

  // Worker: claims only its own op. A poison task is nacked: attempt N+1, back to `available`,
  // reclaimed, and after MAX_ATTEMPTS the runtime dead-letters it. That retry churn is the most
  // visible thing in the map: records flicker leased → available before settling into a cluster.
  async function work(op: string, client: RadiaClient): Promise<void> {
    let idle = 0;
    while (!ac.signal.aborted && idle < 25) {
      const claimed = await client.take({ pattern: { kind: "stress_task", match: { wave, op } } }, { leaseSeconds: 20 });
      if (!claimed) {
        if (!producing) idle++;
        await sleep(70);
        continue;
      }
      idle = 0;
      const b = claimed.record.body as { input: string; poison?: boolean };
      if (b.poison) {
        const n = (attempts.get(claimed.record.id) ?? 0) + 1;
        attempts.set(claimed.record.id, n);
        await client.nack(claimed.lease, { backoffSeconds: 0 });
        stats.nacked++;
        // The settle result is just ok/lease_lost, so count locally. The runtime dead-letters
        // when the attempt goes PAST maxAttempts, i.e. on the (maxAttempts+1)-th nack.
        if (n > MAX_ATTEMPTS) stats.dead++;
        continue;
      }
      await client.ack(claimed.lease, {
        kind: "stress_result",
        body: { wave, op, output: b.input.split(" ").reverse().join(" "), ms: Math.round(Math.random() * 40) },
        parentIds: [claimed.record.id],
      });
      stats.acked++;
    }
  }

  // Chaos: claim a few tasks under a long lease and walk away. They stay `leased` after the wave
  // ends: a stuck-lease cluster, and something for `space_doctor` / the remediation tools to find.
  async function abandon(): Promise<void> {
    const target = Math.ceil(tasks * CHAOS / 3);
    let idle = 0;
    while (!ac.signal.aborted && stats.stuck < target && idle < 40) {
      const claimed = await chaos.take({ pattern: { kind: "stress_task", match: { wave } } }, { leaseSeconds: 900 });
      if (!claimed) {
        if (!producing) idle++;
        await sleep(120);
        continue;
      }
      stats.stuck++; // never settled: the lease is simply dropped
      await sleep(80);
    }
  }

  // Auditor: reads results (facts are never consumed) and emits a rolling summary. That is the
  // fan-in, and a slow trickle of a third kind while everything else is churning.
  async function audit(): Promise<void> {
    let last = 0;
    while (!ac.signal.aborted) {
      const results = await auditor.queryOldest({ kind: "stress_result", match: { wave } }, 1000);
      // One summary per decade of results, not one jump to the current count. That keeps a steady
      // trickle of a third kind while the tasks churn (and content-keyed, so a re-poll never
      // duplicates).
      while (last + 10 <= results.length) {
        last += 10;
        await auditor.put({ kind: "stress_summary", body: { wave, topic, results: last }, parentIds: [] }, `summary:${wave}:${last}`);
        stats.summaries++;
      }
      await sleep(400);
    }
  }

  const line = () =>
    `  put ${stats.put} · acked ${stats.acked} · nacked ${stats.nacked} · dead ${stats.dead} · stuck ${stats.stuck} · summaries ${stats.summaries}`;
  const ticker = setInterval(() => (tty ? write(`\r\x1b[2K${line()}`) : void 0), 250);

  const fail = (e: unknown) => console.error(`\n[wave ${wave}] ${e}`);
  // The auditor runs until the wave is done. It has no work queue of its own to drain, so it is
  // awaited after the abort rather than inside the barrier.
  const auditing = audit().catch(fail);
  await Promise.all(
    [produce(), plan(), abandon(), ...workers.map((w) => work(w.op, w.client))].map((p) => p.catch(fail)),
  );
  ac.abort();
  await auditing;
  clearInterval(ticker);
  write((tty ? `\r\x1b[2K${line()}` : line()) + "\n");
  return stats;
}

// ---- run ----
const totals: Stats = { put: 0, acked: 0, nacked: 0, dead: 0, stuck: 0, summaries: 0 };
for (let i = 1; i <= WAVES; i++) {
  const s = await runWave(i);
  for (const k of Object.keys(totals) as (keyof Stats)[]) totals[k] += s[k];
}

const stats = await admin.getStats();
const rows = stats.filter((s) => s.kind.startsWith("stress_"));
const width = Math.max(...rows.map((r) => r.kind.length), 12);
console.log(`\nSpace now holds (all waves ever run against it):`);
for (const r of rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.state.localeCompare(b.state))) {
  console.log(`  ${r.kind.padEnd(width)} ${r.state.padEnd(12)} ${String(r.count).padStart(6)}`);
}
console.log(
  `\nthis run: ${totals.put} produced · ${totals.acked} acked · ${totals.nacked} nacks → ${totals.dead} dead-lettered · ${totals.stuck} stuck leases`,
);
console.log(`Space tab: colour by kind for the wave's shape, by state to see dead/stuck, by run for the agents.`);
console.log(`Run it again for another wave: new agents, new op mix, nothing overwritten.`);

if (server && !ONCE) {
  console.log(`\nSpace still running at ${url}. Ctrl-C to stop it.`);
  Deno.addSignalListener("SIGINT", async () => {
    server!.kill();
    await server!.status.catch(() => {});
    Deno.exit(0);
  });
  await server.status;
} else {
  if (server) {
    server.kill();
    await server.status.catch(() => {});
  }
  Deno.exit(0);
}
