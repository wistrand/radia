// Instance faults for the cluster benchmark (agent_docs/plan-cluster-bench.md, phase 2), and the
// report of what they cost. Each schedule is fixed, not random, so a violation reproduces; times are
// seconds from the start of the timed window, and each event is stamped on the run's timeline.
//
//   crash    SIGKILL instance 1 at 15s, restart it at 25s. In-flight requests die with it, some
//            after committing: the client's resend through another instance must converge.
//   stall    SIGSTOP instance 1 at 15s, SIGCONT at 30s: longer than the 10s lease, so leases it
//            granted lapse and are reclaimed elsewhere, and requests it held are answered LATE, after
//            the space has moved on. A late settle for a reclaimed lease must be refused.
//   rolling  restart every instance in turn (SIGTERM, start), one every 12s from 10s.
//   none     nothing: the control run, since a timeline can drift for reasons of its own.
//
// And the database under the instances (phase 3):
//
//   failover      SIGKILL the primary at 15s, promote the standby, move the proxy to it.
//   failover-lag  the same, with the standby's replication link cut at 10s first, as when the link
//                 degrades before the primary dies. Synchronous: commits wait from 10s and nothing
//                 acknowledged is lost. ASYNCHRONOUS (--async): what was acknowledged in those 5s
//                 never reached the standby, and the audit is EXPECTED to find it gone.
//   partition     every byte between the instances and the database held from 15s to 35s: queries
//                 hang rather than fail, which is the case a driver without a timeout meets.

import type { Cluster } from "./cluster.ts";
import type { Fleet } from "./fleet.ts";
import type { LoadResult } from "./load.ts";

type Mark = (what: string) => void;

export interface Schedule {
  what: string;
  run: (c: Cluster, f: Fleet, mark: Mark) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `at(15)` resolves 15s after the schedule started. */
function clock(): (seconds: number) => Promise<void> {
  const t0 = performance.now();
  return async (s) => {
    await sleep(Math.max(0, t0 + s * 1000 - performance.now()));
  };
}

async function restart(c: Cluster, f: Fleet, i: number, mark: Mark): Promise<void> {
  await c.startInstance(i);
  f.refresh(i);
  mark(`instance ${i} serving`);
}

async function failover(c: Cluster, mark: Mark): Promise<void> {
  mark("primary killed");
  await c.killPrimary();
  await c.promoteStandby();
  mark("standby promoted");
  c.proxy.retarget(c.standby);
  mark("proxy retargeted");
}

export const FAULTS: Record<string, Schedule> = {
  none: {
    what: "no fault: the control, so a trend in the timeline is not read as recovery",
    run: () => Promise.resolve(),
  },
  crash: {
    what: "SIGKILL instance 1 at 15s, restart at 25s",
    run: async (c, f, mark) => {
      const at = clock();
      await at(15);
      mark("SIGKILL instance 1");
      await c.stopInstance(1, "SIGKILL");
      await at(25);
      mark("restarting instance 1");
      await restart(c, f, 1, mark);
    },
  },
  stall: {
    what: "SIGSTOP instance 1 at 15s, SIGCONT at 30s (past the 10s lease)",
    run: async (c, _f, mark) => {
      const at = clock();
      await at(15);
      mark("SIGSTOP instance 1");
      c.signal(1, "SIGSTOP");
      await at(30);
      mark("SIGCONT instance 1");
      c.signal(1, "SIGCONT");
    },
  },
  failover: {
    what: "SIGKILL the primary at 15s, promote the standby, move the proxy",
    run: async (c, _f, mark) => {
      const at = clock();
      await at(15);
      await failover(c, mark);
    },
  },
  "failover-lag": {
    what: "cut replication at 10s, then fail over at 15s",
    run: async (c, _f, mark) => {
      const at = clock();
      await at(10);
      await c.cutReplication();
      mark("replication cut");
      await at(15);
      await failover(c, mark);
    },
  },
  partition: {
    what: "hold every database byte from 15s to 35s",
    run: async (c, _f, mark) => {
      const at = clock();
      await at(15);
      c.proxy.partition();
      mark("partitioned");
      await at(35);
      c.proxy.heal();
      mark("healed");
    },
  },
  rolling: {
    what: "restart every instance in turn, one every 12s from 10s",
    run: async (c, f, mark) => {
      const at = clock();
      for (let i = 0; i < c.instances.length; i++) {
        await at(10 + 12 * i);
        mark(`SIGTERM instance ${i}`);
        await c.stopInstance(i);
        await restart(c, f, i, mark);
      }
    },
  },
};

/**
 * The per-second timeline and what it says: throughput before the first fault, the worst second
 * after each event, how long until throughput was back to 90% of that for three seconds running,
 * and when a restarted instance first answered.
 */
export function recoveryReport(r: LoadResult): string {
  const t = r.timeline;
  // Judged over whole seconds of the timed window only: the second it ends in is partial, and the
  // drain keeps workers answering after it, so later buckets exist and mean nothing here.
  const secs = Math.max(t.ops.length, t.failovers.length);
  const judged = Math.min(secs, Math.floor(r.elapsedMs / 1000));
  const ops = (s: number) => t.ops[s] ?? 0;
  const first = t.marks[0]?.second ?? judged;
  const warm = Math.min(3, first);
  const base = Array.from({ length: Math.max(1, first - warm) }, (_, k) => ops(warm + k));
  const baseline = base.reduce((a, b) => a + b, 0) / base.length;

  const out: string[] = [];
  const n = t.perInstance.length;
  const head = ["t", "ops", "failover", ...Array.from({ length: n }, (_, i) => `inst${i}`), "event"];
  const rows = Array.from({ length: secs }, (_, s) => [
    `${s}s`,
    String(ops(s)),
    String(t.failovers[s] ?? 0),
    ...t.perInstance.map((p) => String(p[s] ?? 0)),
    t.marks.filter((m) => m.second === s).map((m) => m.what).join("; "),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => i === cells.length - 1 ? c : c.padStart(widths[i])).join("  ");
  out.push(line(head), ...rows.map(line), "");

  out.push(`baseline ${baseline.toFixed(0)} ops/s (seconds ${warm}-${first - 1}, before the first event)`);
  for (const m of t.marks) {
    // An event's worst second is looked for up to the NEXT event, so a later fault's dip is not
    // credited to an earlier one.
    const until = t.marks.find((x) => x.second > m.second)?.second ?? judged;
    let worst = m.second, back = -1;
    for (let s = m.second; s < judged; s++) {
      if (s < until && ops(s) < ops(worst)) worst = s;
      if (back < 0 && [0, 1, 2].every((k) => s + k < judged && ops(s + k) >= 0.9 * baseline)) back = s;
    }
    const served = m.what.match(/^instance (\d+) serving$/);
    const firstAnswer = served ? t.perInstance[Number(served[1])].findIndex((v, s) => s >= m.second && (v ?? 0) > 0) : -1;
    out.push(
      `  ${String(m.second).padStart(3)}s  ${m.what.padEnd(24)} worst ${ops(worst)} ops/s at ${worst}s; ` +
        (back < 0 ? "not back to 90% in the window" : `back to 90% after ${back - m.second}s`) +
        (served ? (firstAnswer < 0 ? "; never answered" : `; first answer ${firstAnswer - m.second}s after`) : ""),
    );
    // After the database comes back: when each instance first answered, and how many requests it
    // still failed in the next 10s. An instance whose pool kept handing out connections that died
    // with the old primary shows here as late and failing.
    if (m.what === "proxy retargeted" || m.what === "healed") {
      const per = t.perInstance.map((p, i) => {
        const firstOk = p.findIndex((v, s) => s >= m.second && (v ?? 0) > 0);
        const fails = t.failoversPerInstance[i].slice(m.second, m.second + 10).reduce((a, b) => a + (b ?? 0), 0);
        return `inst${i} ${firstOk < 0 ? "never" : `+${firstOk - m.second}s`}, ${fails} failed`;
      });
      out.push(`         after it: ${per.join("; ")}`);
    }
  }
  return out.join("\n");
}
