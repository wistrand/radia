// The cluster benchmark's entry point (agent_docs/plan-cluster-bench.md). Needs docker.
//
//   deno run -A bench/cluster/run.ts check [--instances 3] [--cycles 2] [--async]
//   deno run -A bench/cluster/run.ts authprobe [--instances 3] [--async] [--rounds 50] [--window-ms 300]
//
// `check` is phase 0's exit test: bring the cluster up, prove each part works (every instance
// serves Postgres, the standby streams in the requested mode and APPLIES what the primary commits,
// bytes written through one instance read back through another, the proxy carries the traffic),
// tear it down, prove nothing is left (no container, no volume, no process, no bound port), and do
// it again. It exits 1 on any failed check.
//
// `authprobe` runs `bench/cluster/authrounds.ts` against a fresh cluster.

import { flag, has } from "../../src/flags.ts";
import { benchEnv } from "../env.ts";
import { renderTable } from "../harness.ts";
import { AuthRounds } from "./authrounds.ts";
import { Cluster } from "./cluster.ts";
import { audit, DEFAULT_LOAD, PLANTS, runLoad } from "./load.ts";
import { FAULTS, recoveryReport } from "./faults.ts";

const argv = Deno.args;
const mode = argv[0];
if (!mode || has(argv, "--help") || !["check", "authprobe", "steady", "faults"].includes(mode)) {
  console.log(
    "usage: deno run -A bench/cluster/run.ts check [--instances n] [--cycles n] [--async]\n" +
      "       deno run -A bench/cluster/run.ts authprobe [--instances n] [--async] [--rounds n] [--window-ms n]\n" +
      "       deno run -A bench/cluster/run.ts steady [--instances 1,2,4,8] [--duration s] [--warmup s] [--rate ops/s/loop] [--async]\n" +
      "                                               [--pool-size n] [--idle-check]\n" +
      `                                               [--plant ${Object.keys(PLANTS).join("|")}]\n` +
      `       deno run -A bench/cluster/run.ts faults --fault ${Object.keys(FAULTS).join("|")} [--instances 3] [--duration 60] [--warmup 30] [--rate] [--plant no-cursor]`,
  );
  Deno.exit(mode ? 0 : 2);
}
const instances = mode === "steady" || mode === "faults" ? 0 : Number(flag(argv, "--instances") ?? 3);
const sync = !has(argv, "--async");
const log = (line: string) => console.error(`  · ${line}`);

// Ctrl-C tears down whatever is up; a leaked Postgres pair and N servers are the failure this
// harness exists to avoid.
let live: Cluster | undefined;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  // SIGTERM too: `timeout` sends it, and one that went unhandled left a whole cluster running.
  Deno.addSignalListener(sig, async () => {
    console.error(`\n${sig}: tearing down`);
    await live?.down().catch((e) => console.error(String(e)));
    Deno.exit(130);
  });
}
// The same for an error thrown in a background loop: an unhandled rejection ends the process
// without running any `finally`, which once left a whole cluster running for an hour.
globalThis.addEventListener("unhandledrejection", async (e) => {
  e.preventDefault();
  console.error("unhandled:", e.reason);
  await live?.down().catch((err) => console.error(String(err)));
  Deno.exit(1);
});

for (const line of await benchEnv()) console.log(line);

if (mode === "steady") {
  const sizes = (flag(argv, "--instances") ?? "1,2,4,8").split(",").map(Number);
  const durationMs = Number(flag(argv, "--duration") ?? 30) * 1000;
  const rate = flag(argv, "--rate") ? Number(flag(argv, "--rate")) : undefined;
  const plant = flag(argv, "--plant");
  if (plant && !PLANTS[plant]) {
    console.error(`unknown --plant '${plant}': ${Object.keys(PLANTS).join(", ")}`);
    Deno.exit(2);
  }
  const warmupMs = Number(flag(argv, "--warmup") ?? 30) * 1000;
  const opts = { ...DEFAULT_LOAD, durationMs, rate, warmupMs, log };
  // Per-instance Postgres connections (`--pg-pool-size`), and whether to wait out the idle timeout
  // after the load to count what the pool gave back.
  const poolSize = flag(argv, "--pool-size");
  const serveArgs = poolSize ? ["--pg-pool-size", poolSize] : [];
  const idleCheck = has(argv, "--idle-check");
  console.log(
    `cluster steady state: N = ${sizes.join(", ")}, ${durationMs / 1000}s each after ${warmupMs / 1000}s warm-up, ${sync ? "synchronous" : "ASYNCHRONOUS"} standby, ` +
      `${rate ? `${rate} ops/s per loop` : "closed loops"}, pool ${poolSize ?? "8 (default)"}${plant ? `, PLANTED: ${plant}` : ""}\n` +
      `loops: ${opts.recordLoops} records, ${opts.producers} producers, ${opts.workers} workers, ${opts.artifactLoops} artifacts, ` +
      `1 authorization, gc every ${opts.gcEveryMs / 1000}s from two instances, one watcher per instance\n`,
  );
  const summary: string[][] = [];
  let violations = 0;
  let plantSeen = true;
  for (const n of sizes) {
    console.log(`## N = ${n}`);
    live = await Cluster.up({ instances: n, sync, log, serveArgs });
    try {
      const r = await runLoad(live, opts);
      let afterIdle = "-";
      if (idleCheck) {
        // The pool closes connections idle past 60s down to one per instance (`ClientPool`).
        log("idle check: waiting 75s after the load");
        await new Promise((res) => setTimeout(res, 75_000));
        const [row] = await live.sql<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = 'radia' and backend_type = 'client backend' and pid <> pg_backend_pid()",
        );
        afterIdle = String(row.n);
      }
      if (plant) await PLANTS[plant].apply(live, r);
      const found = await audit(live, r);
      console.log(renderTable(r.measurements.map((m) => ({ adapter: `N=${n}`, m })), "N"));
      console.log("");
      for (const v of found) console.log(`  ${v.count === 0 ? "ok  " : "FAIL"}  ${v.name.padEnd(22)} ${String(v.count).padStart(5)}  ${v.detail ?? ""}`);
      const total = found.reduce((a, v) => a + v.count, 0);
      violations += total;
      if (plant) plantSeen &&= (found.find((v) => v.name === PLANTS[plant].breaks)?.count ?? 0) > 0;
      const l = r.ledger;
      const lat = [...l.watchLatencies].sort((a, b) => a - b);
      const dupExec = [...l.executions.values()].filter((x) => x > 1).length;
      const errors = [...l.errors.values()].reduce((a, b) => a + b, 0);
      if (l.errors.size) console.log(`  transport errors: ${JSON.stringify(Object.fromEntries(l.errors))}`);
      summary.push([
        String(n),
        ((r.ops / r.elapsedMs) * 1000).toFixed(0),
        (r.dbCalls / Math.max(1, r.ops)).toFixed(1),
        `${r.connections.max} / ${r.connections.mean.toFixed(0)}`,
        afterIdle,
        String(l.emptyTakes),
        `${dupExec} / ${l.executions.size}`,
        lat.length ? `${lat[Math.floor(lat.length / 2)].toFixed(1)}ms` : "-",
        lat.length >= 100 ? `${lat[Math.floor(lat.length * 0.99)].toFixed(1)}ms` : "-",
        String(errors),
        String(total),
      ]);
    } finally {
      await live.down();
      live = undefined;
    }
    console.log("");
  }
  const head = ["N", "OPS/S", "DB CALLS/OP", "CONNS MAX/MEAN", "CONNS IDLE", "EMPTY TAKES", "DUP EXEC", "WATCH p50", "WATCH p99", "ERRORS", "VIOLATIONS"];
  const widths = head.map((h, i) => Math.max(h.length, ...summary.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join("  ");
  console.log([line(head), widths.map((w) => "─".repeat(w)).join("  "), ...summary.map(line)].join("\n"));
  console.log(
    "\nOPS/S counts client operations in the timed window; DB CALLS/OP is pg_stat_statements over the same window. " +
      "DUP EXEC is tasks executed more than once, which at-least-once delivery permits (the zombies are all of it).",
  );
  if (plant) {
    console.log(plantSeen ? `\nplanted '${plant}' was caught: '${PLANTS[plant].breaks}' is nonzero` : `\nplanted '${plant}' was NOT caught`);
    Deno.exit(plantSeen ? 0 : 1);
  }
  console.log(violations === 0 ? "\nno violations" : `\n${violations} violation(s)`);
  Deno.exit(violations === 0 ? 0 : 1);
}

if (mode === "faults") {
  const fault = flag(argv, "--fault") ?? "crash";
  const n = Number(flag(argv, "--instances") ?? 3);
  const durationMs = Number(flag(argv, "--duration") ?? 60) * 1000;
  const rate = flag(argv, "--rate") ? Number(flag(argv, "--rate")) : undefined;
  const warmupMs = Number(flag(argv, "--warmup") ?? 30) * 1000;
  // The one fault-mode plant: watchers reconnect without their cursor, so a move must show gaps.
  const noCursor = flag(argv, "--plant") === "no-cursor";
  const schedule = FAULTS[fault];
  if (!schedule) {
    console.error(`unknown --fault '${fault}': ${Object.keys(FAULTS).join(", ")}`);
    Deno.exit(2);
  }
  // Leases short enough that a stall outlasts one inside the window, and an orphan lease (a take
  // whose answer died with its instance) comes back before the drain gives up.
  const leaseSeconds = 10;
  console.log(
    `cluster faults: '${fault}' (${schedule.what}), N = ${n}, ${durationMs / 1000}s after ${warmupMs / 1000}s warm-up, lease ${leaseSeconds}s, ` +
      `${sync ? "synchronous" : "ASYNCHRONOUS"} standby, ${rate ? `${rate} ops/s per loop` : "closed loops"}` +
      `${noCursor ? ", PLANTED: watchers reconnect without their cursor" : ""}\n`,
  );
  live = await Cluster.up({ instances: n, sync, log });
  let total = 0;
  try {
    const cluster = live;
    const r = await runLoad(cluster, {
      ...DEFAULT_LOAD,
      durationMs,
      rate,
      leaseSeconds,
      warmupMs,
      watchResume: !noCursor,
      log,
      during: (fleet, mark) => schedule.run(cluster, fleet, mark),
    });
    const found = await audit(cluster, r);
    // What the instances logged, grouped: the harness sees a 500, the log says why. Read before
    // teardown, which deletes the logs with the work directory.
    for (const inst of cluster.instances) {
      const lines = await Deno.readTextFile(inst.logPath).catch(() => "");
      const by = new Map<string, number>();
      for (const m of lines.matchAll(/ERROR (.*)$/gm)) {
        const k = m[1].replace(/\x1b\[[0-9;]*m/g, "").replace(/\b[0-9A-Z]{26}\b/g, "<id>").slice(0, 180);
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      const top = [...by].sort((x, y) => y[1] - x[1]).slice(0, 4);
      if (top.length) console.log(`instance ${inst.index} logged:\n${top.map(([k, c]) => `  ${String(c).padStart(5)}  ${k}`).join("\n")}`);
    }
    console.log(renderTable(r.measurements.map((m) => ({ adapter: `N=${n}`, m })), "N"));
    console.log("");
    for (const v of found) console.log(`  ${v.count === 0 ? "ok  " : "FAIL"}  ${v.name.padEnd(22)} ${String(v.count).padStart(5)}  ${v.detail ?? ""}`);
    total = found.reduce((a, v) => a + v.count, 0);
    console.log(`\n${recoveryReport(r)}`);
    const l = r.ledger;
    console.log(
      `\nfailovers ${r.fleet.failovers}, watch reconnects ${r.watchStats.reconnects} (${r.watchStats.moved} to another instance, ${r.watchStats.resyncs} re-synced after a 410), ` +
        `tasks executed more than once ${[...l.executions.values()].filter((x) => x > 1).length}, acks lease_lost ${l.ackLost}` +
        (l.errors.size ? `\ngiven up after failing over for ${r.fleet.opts.deadlineMs / 1000}s: ${JSON.stringify(Object.fromEntries(l.errors))}` : "") +
        [...l.firstError].map(([k, m]) => `\n  first ${k} error: ${m}`).join(""),
    );
  } finally {
    await live.down();
  }
  console.log(total === 0 ? "\nno violations" : `\n${total} violation(s)`);
  Deno.exit(total === 0 ? 0 : 1);
}

console.log(`cluster: ${instances} instance(s), ${sync ? "synchronous" : "ASYNCHRONOUS"} standby\n`);

if (mode === "authprobe") {
  const rounds = Number(flag(argv, "--rounds") ?? 50);
  const windowMs = Number(flag(argv, "--window-ms") ?? 300);
  live = await Cluster.up({ instances, sync, log });
  try {
    const probe = await AuthRounds.create(live.admins(), live.urls, { windowMs });
    for (let r = 0; r < rounds; r++) {
      await probe.round(r);
      if ((r + 1) % 10 === 0) log(`${r + 1}/${rounds} rounds`);
    }
    console.log(`${rounds} rounds, ${windowMs}ms window after each acknowledged write\n`);
    console.log(probe.table());
    console.log(`\n${probe.verdict()}`);
  } finally {
    await live.down();
  }
  Deno.exit(0);
}

// ---- check ----

const cycles = Number(flag(argv, "--cycles") ?? 2);
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

for (let c = 1; c <= cycles; c++) {
  console.log(`cycle ${c}/${cycles}`);
  const t0 = performance.now();
  const cluster = live = await Cluster.up({ instances, sync, log });
  check("up", true, `${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const admins = cluster.admins();
  const ports = cluster.instances.map((i) => i.port);
  try {
    const health = await Promise.all(admins.map((a) => a.health()));
    check("every instance serves postgres", health.every((h) => h.storage === "postgres"), health.map((h) => h.storage).join(","));

    const repl = await cluster.replication();
    const want = sync ? "sync" : "async";
    check(`standby streams as ${want}`, repl.some((r) => r.state === "streaming" && r.sync_state === want), JSON.stringify(repl));

    // A record through the first instance, read through the last, then found on the STANDBY: the
    // replica applies what the primary commits, not merely connects.
    const { id } = await admins[0].put({ kind: "bench_cluster_check", body: { cycle: c } });
    const seen = await admins[admins.length - 1].getRecord(id).catch(() => null);
    check("a record written through one instance reads through another", seen?.id === id);
    let onStandby = false;
    for (let i = 0; i < 40 && !onStandby; i++) {
      const rows = await cluster.sql<{ n: number }>("select count(*)::int as n from records where id = $1", { params: [id], on: cluster.standby });
      onStandby = rows[0]?.n === 1;
      if (!onStandby) await new Promise((r) => setTimeout(r, 250));
    }
    check("the standby applied it", onStandby);

    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const art = await admins[0].putArtifact(bytes, { mediaType: "application/octet-stream" });
    const back = await admins[admins.length - 1].getArtifact(art.id).catch(() => new Uint8Array());
    check("artifact bytes written through one instance read through another", back.length === bytes.length && back.every((b, i) => b === bytes[i]));

    const px = cluster.proxy.stats();
    check("instances reach postgres through the proxy", px.accepted > 0, `${px.accepted} accepted, ${px.open} open`);

    // The proxy must cost next to nothing. Without TCP_NODELAY on its legs it stalled on Nagle plus
    // delayed ACK, which cut the authprobe's throughput twentyfold. Measured on RADIA's traffic: a
    // single parameterized query through the proxy did not trigger the stall, so a check on one
    // passed with the fault planted. One host, so an absolute bound: the stall is 40ms or more.
    const reads: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await admins[i % admins.length].getRecord(id);
      reads.push(performance.now() - t0);
    }
    const p50 = reads.sort((a, b) => a - b)[25];
    check("a read through an instance and the proxy stays under 10ms", p50 < 10, `p50 ${p50.toFixed(2)}ms over 50`);
  } finally {
    const t1 = performance.now();
    const statuses = await Promise.all(cluster.instances.map((_, i) => cluster.stopInstance(i)));
    // A SIGKILL here means SIGTERM went unanswered for 10s: a shutdown defect, not a pass.
    check(
      "every instance exited on SIGTERM",
      statuses.every((s) => s !== undefined && s.signal !== "SIGKILL"),
      `${((performance.now() - t1) / 1000).toFixed(1)}s, ${statuses.map((s) => s?.signal ?? s?.code).join(",")}`,
    );
    const t2 = performance.now();
    const downError = await cluster.down().then(() => "", (e) => String(e));
    live = undefined;
    check("down", downError === "", downError || `${((performance.now() - t2) / 1000).toFixed(1)}s`);
  }

  // Nothing left behind: containers and volumes by the project label, ports by binding them.
  const label = `label=com.docker.compose.project=${cluster.project}`;
  const leftovers = async (what: string[]) => {
    const out = await new Deno.Command("docker", { args: [...what, "--filter", label, "-q"], stdout: "piped" }).output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  check("no container left", await leftovers(["ps", "-a"]) === "");
  check("no volume left", await leftovers(["volume", "ls"]) === "");
  const bound = ports.filter((p) => {
    try {
      Deno.listen({ hostname: "127.0.0.1", port: p }).close();
      return false;
    } catch {
      return true;
    }
  });
  check("every instance port is free", bound.length === 0, bound.join(","));
  check("work directory removed", await Deno.stat(cluster.workDir).then(() => false, () => true));
  console.log("");
}

console.log(failed === 0 ? `phase 0 check passed: ${cycles} cycle(s)` : `${failed} check(s) FAILED`);
Deno.exit(failed === 0 ? 0 : 1);
