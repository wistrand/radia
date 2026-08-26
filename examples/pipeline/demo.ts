// End-to-end agent demo (`deno task demo`). A planner + two workers + an aggregator run
// against a space over HTTP, seed a job plus a standalone task, and produce a summary.
//
// Visibility: the demo prefers a space you already have open, so the run shows up in its
// web console **Feed** tab. Start `deno task dev`, open http://localhost:7788, then run
// `deno task demo` and watch it. If no space is running, the demo starts one and leaves it
// up so you can open it (Ctrl-C to stop). Pass `--once` to spawn an ephemeral space, run,
// and exit. That is the self-contained integration smoke test used in CI.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerDemoKinds } from "./kinds.ts";
import { plannerLoop } from "./planner.ts";
import { workerLoop } from "./worker.ts";
import { aggregatorLoop } from "./aggregator.ts";

const once = Deno.args.includes("--once");
const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const port = new URL(url).port || "7788";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Stagger the pipeline so it animates in the Feed tab. Instant for --once (CI).
const pace = once ? 0 : Number(Deno.env.get("RADIA_DEMO_PACE") ?? "500");

async function healthy(client: RadiaClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(client: RadiaClient, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(client)) return true;
    await sleep(200);
  }
  return false;
}

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let client: RadiaClient;
const ac = new AbortController();
const log = (m: string) => console.log(m);

let server: Deno.ChildProcess | null = null;
const usingRunning = await healthy(probe);

if (usingRunning) {
  console.log(`Using the space already running at ${url}`);
  console.log(`Open ${url} and watch the Feed tab.\n`);
} else {
  console.log(`No space at ${url}; starting one...`);
  server = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "src/main.ts", "dev", "--port", port, "--storage", "sqlite"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  if (!await waitHealthy(probe)) {
    console.error("server did not become healthy");
    server.kill();
    Deno.exit(1);
  }
  console.log(`Space up at ${url}. Open it and watch the Feed tab.\n`);
}

// The space is up either way, so its credential file exists: authenticate before the first verb.
client = new RadiaClient(url, { token: operatorToken(url) });

try {
  await registerDemoKinds(client);

  // Independent agents, no routing table; each self-selects by content.
  const agents = [
    plannerLoop(client, ac.signal, log, pace),
    workerLoop(client, "upper", ac.signal, log, pace),
    workerLoop(client, "reverse", ac.signal, log, pace),
    aggregatorLoop(client, ac.signal, log),
  ];
  void agents;

  const job = await client.put({ kind: "job", body: { text: "the quick brown fox" } });
  await client.put({ kind: "task", body: { op: "reverse", input: "radia" } });
  console.log(`[coordinator] posted job ${job.id.slice(-6)} + standalone reverse task\n`);

  let summary = null;
  for (let i = 0; i < 60 && !summary; i++) {
    summary = await client.readOne<{ text: string }>({ kind: "summary", match: { jobId: job.id } });
    if (!summary) await sleep(200);
  }

  console.log("");
  console.log(summary ? `RESULT: "${summary.body.text}"` : "RESULT: (timed out)");

  const events = await client.getEvents("0", 200);
  console.log(`\nEVENT LOG (${events.length} events), also visible in the Feed tab:`);
  for (const e of events) {
    console.log(`  ${String(e.seq).padStart(2)} ${e.operation.padEnd(8)} ${(e.kind ?? "").padEnd(8)} ${e.state ?? ""}`);
  }
  if (summary) {
    const lineage = await client.getLineage(summary.id);
    const depth = Math.max(...lineage.map((n) => n.depth));
    console.log(`\nLINEAGE of summary: ${lineage.length} records, ${depth + 1} levels (summary -> results -> tasks -> job)`);
  }

  ac.abort();
  await sleep(300);
} finally {
  ac.abort();
}

if (server && !once) {
  console.log(`\nSpace still running at ${url}. Open it to explore, then press Ctrl-C to stop.`);
  Deno.addSignalListener("SIGINT", async () => {
    server!.kill();
    await server!.status.catch(() => {});
    Deno.exit(0);
  });
  await server.status; // stay up until Ctrl-C
} else {
  if (server) {
    server.kill();
    await server.status.catch(() => {});
  }
  Deno.exit(0);
}
