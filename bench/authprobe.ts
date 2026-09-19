// Does authorization see the latest committed write, on every instance? Counted, not timed.
//
//   deno run -A bench/authprobe.ts --url http://127.0.0.1:7899
//   deno run -A bench/authprobe.ts --url http://a:7899,http://b:7899 --token <ta>,<tb> --rounds 100
//   scripts/authprobe-cluster.sh 3      # throwaway Postgres + 3 `radia serve` + this probe
//
// Point it at N `radia serve` instances over ONE database. Each write goes through one instance and
// the probes go through all of them at once, so a cross-instance ordering or visibility defect
// shows as a count rather than a flake:
//
//   STALE GRANT       a grant is revoked through instance A; once the revocation is acknowledged, any
//                     instance still authorizing the grant's operation is a violation. This is the
//                     one that matters: silent misauthorization.
//   STALE DENIAL      the converse after a (re)grant is acknowledged. Not a security defect, but the
//                     same visibility lag seen from the other side.
//   STALE CREDENTIAL  a run is stopped through instance A; any instance still resolving its token
//                     afterwards is a violation.
//
// Revoke and re-grant alternate on ONE grant identity, which is the registry race `writeOrder`
// closes (gotchas.md, "`newer` orders by `runtimeMeta.writeOrder`"), and the rule against
// asynchronous read replicas (design-storage.md, "Scaling and multi-instance operation") is what
// the counts test for a deployment. Zero on one instance says little; zero across several over
// one Postgres is the claim.
//
// Like `deployment.ts` it WRITES records it cannot take back: grants, runs and one definition per
// invocation. Use a throwaway space. Nothing asserts; the summary line is the answer.

import { RadiaClient, RadiaClientError } from "../sdk/ts/client.ts";
import { flag, has } from "../src/flags.ts";
import { resolveToken } from "../src/credentials.ts";
import { benchEnv } from "./env.ts";

const argv = Deno.args;
const urlArg = flag(argv, "--url");
if (!urlArg || has(argv, "--help")) {
  console.log(
    "usage: deno run -A bench/authprobe.ts --url <base>[,<base>…] [--token <t>[,<t>…]] [--rounds n] [--window-ms n]\n\n" +
      "  Several URLs are several instances over one database, with one operator token per URL.\n" +
      "  Writes grants and runs it cannot delete: use a throwaway space. scripts/authprobe-cluster.sh\n" +
      "  starts N instances over a throwaway Postgres and runs this against them.",
  );
  Deno.exit(urlArg ? 0 : 2);
}
const urls = urlArg.split(",").map((u) => u.trim()).filter(Boolean);
// ONE OPERATOR TOKEN PER INSTANCE, in `--url` order: an operator token is held in the serving
// process's memory, never in a record, so instance A's is unknown to instance B. A single token
// is reused for every URL, which is right for one instance or for tokens a deployment shares.
const tokenArg = flag(argv, "--token") ?? Deno.env.get("RADIA_TOKEN");
const tokens = tokenArg ? tokenArg.split(",").map((t) => t.trim()) : urls.map((u) => resolveToken(u));
if (tokens.length !== 1 && tokens.length !== urls.length) {
  console.error(`--token has ${tokens.length} entries for ${urls.length} URLs: give one, or one per URL`);
  Deno.exit(2);
}
const rounds = Number(flag(argv, "--rounds") ?? 50);
const windowMs = Number(flag(argv, "--window-ms") ?? 300);

const admins = urls.map((u, i) => {
  const t = tokens.length === 1 ? tokens[0] : tokens[i];
  return new RadiaClient(u, t ? { token: t } : {});
});
const KIND = "bench_authprobe";

for (const line of await benchEnv()) console.log(line);
for (const [i, a] of admins.entries()) {
  const h = await a.health();
  console.log(`${`inst ${i}:`.padEnd(9)}${urls[i]}  radia ${h.version}, storage ${h.storage}`);
}
console.log("");

// One agent per invocation, so a second run never inherits the first one's grant history.
const agent = `agent:authprobe-${Date.now().toString(36)}`;
const { definitionToken } = await admins[0].createAgentDefinition(agent, []);
const GRANT = { principal: agent, kind: KIND, operations: ["query"] };

type Outcome = "ok" | "denied" | "unauthenticated" | "error";

async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    if (e instanceof RadiaClientError) return e.status === 403 ? "denied" : e.status === 401 ? "unauthenticated" : "error";
    return "error";
  }
}

interface Window {
  attempts: number;
  /** Attempts whose outcome contradicts the acknowledged write. */
  stale: number;
  errors: number;
  /** Milliseconds after the acknowledgement of the latest stale observation, or -1 for none. */
  lastStaleMs: number;
}

/** Probe every instance back to back for `windowMs` after an acknowledged write, all instances in
 *  parallel. `expect` is the only outcome consistent with that write. */
async function probe(fn: (i: number) => Promise<unknown>, expect: Outcome): Promise<Window> {
  const w: Window = { attempts: 0, stale: 0, errors: 0, lastStaleMs: -1 };
  const t0 = performance.now();
  await Promise.all(urls.map(async (_, i) => {
    while (performance.now() - t0 < windowMs) {
      const o = await outcome(() => fn(i));
      w.attempts++;
      if (o === "error") w.errors++;
      else if (o !== expect) {
        w.stale++;
        w.lastStaleMs = Math.max(w.lastStaleMs, performance.now() - t0);
      }
    }
  }));
  return w;
}

function add(into: Window, w: Window): void {
  into.attempts += w.attempts;
  into.stale += w.stale;
  into.errors += w.errors;
  into.lastStaleMs = Math.max(into.lastStaleMs, w.lastStaleMs);
}

const empty = (): Window => ({ attempts: 0, stale: 0, errors: 0, lastStaleMs: -1 });
const totals = { staleGrant: empty(), staleDenial: empty(), staleCredential: empty() };

// The agent's run, one client per instance. Grants attach to the agent, so one run serves every
// round of the grant probe.
const run = await admins[0].createRun(definitionToken);
const agents = urls.map((u) => new RadiaClient(u, run.runToken));
const query = (i: number) => agents[i].queryNewest({ kind: KIND }, 1);

for (let r = 0; r < rounds; r++) {
  // Rotate which instance takes each write, so every ordered pair of instances gets exercised.
  const writer = admins[r % admins.length];
  const revoker = admins[(r + 1) % admins.length];

  // A fresh idempotency key per write: the grant identity is the same every round (that is the
  // race under test), and a content key would replay the round-one write instead of appending.
  await writer.put({ kind: "grant", body: GRANT }, `authprobe:${agent}:grant:${r}`);
  add(totals.staleDenial, await probe(query, "ok"));

  await revoker.put({ kind: "grant", body: { ...GRANT, retired: true } }, `authprobe:${agent}:revoke:${r}`);
  add(totals.staleGrant, await probe(query, "denied"));

  // A run per round: mint through one instance, stop through the next, present it everywhere.
  const victim = await writer.createRun(definitionToken);
  const holders = urls.map((u) => new RadiaClient(u, victim.runToken));
  await revoker.stopRun(victim.run);
  add(totals.staleCredential, await probe((i) => holders[i].health(), "unauthenticated"));

  if ((r + 1) % 10 === 0) console.error(`  … ${r + 1}/${rounds} rounds`);
}

const rows: [string, Window][] = [
  ["stale grant (after revoke)", totals.staleGrant],
  ["stale credential (after stop)", totals.staleCredential],
  ["stale denial (after grant)", totals.staleDenial],
];
const head = ["PROBE", "ATTEMPTS", "STALE", "ERRORS", "LAST STALE"];
const body = rows.map(([name, w]) => [name, String(w.attempts), String(w.stale), String(w.errors), w.lastStaleMs < 0 ? "-" : `${w.lastStaleMs.toFixed(0)}ms`]);
const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
const line = (cells: string[]) => cells.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join("  ");
console.log(`${urls.length} instance(s), ${rounds} rounds, ${windowMs}ms window after each acknowledged write\n`);
console.log([line(head), widths.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n"));

const violations = totals.staleGrant.stale + totals.staleCredential.stale;
console.log(
  `\n${violations === 0 ? "no" : violations} authorization violation${violations === 1 ? "" : "s"} ` +
    "(stale grant + stale credential). Stale denials are lag, not misauthorization. ERRORS are\n" +
    "neither: a 5xx or a network failure is not an authorization decision, so it is counted apart.",
);
