// What a DEPLOYMENT costs: one space, over HTTP, against whatever storage it was started with,
// re-measured as the space fills.
//
//   deno run -A bench/deployment.ts --url http://127.0.0.1:7899
//   deno run -A bench/deployment.ts --url … --checkpoints 25000,100000,400000,1000000 --concurrency 64
//
// STANDALONE, like `edit-cost.ts`, because it measures something the harness cannot express. The
// suites under `suites/` construct a `Space` over an adapter in this process, which makes them a
// floor for latency and a ceiling for throughput; this one needs a server on the other end of a
// socket, so it takes a URL instead of an adapter and reuses only the timing and the table.
//
// THE TWO AXES THE OTHER SUITES DO NOT VARY, and the reason this exists:
//
//   THE TRANSPORT. `suites/records.ts` measures `put` at ~42µs. The same put over HTTP against a
//   real Postgres with fsync is ~4ms serially, and ~0.32ms of wall clock at 64 in flight. Two
//   orders of magnitude, so a capacity estimate taken from the in-process numbers is not wrong at
//   the margin, it is wrong about the shape of the machine you need.
//
//   THE ORACLE. `pushdown.ts` is a SOUND pre-filter, never a complete one: what it cannot express
//   renders as TRUE, and the whole kind is pulled into JS for `core/matching.ts` to decide. Every
//   predicate in the other suites is pushable, so that path had never been measured; it turned out
//   to be the worst row here by three orders of magnitude, and single-threaded, which makes it an
//   isolation finding as much as a performance one. `$any` was pushed in response. The `$each` row
//   keeps the unpushable path measured, since a benchmark of only the fast paths is what hid it.
//
// IT WRITES RECORDS AND CANNOT TAKE THEM BACK. There is no delete. Point it at a throwaway space
// (a `--db` of its own, or a scratch Postgres database), never at one you care about. Its kinds are
// prefixed `bench_` so at least it cannot collide with an application's.

import { RadiaClient, RadiaClientError } from "../sdk/ts/client.ts";
import { measure, type Measurement, renderTable } from "./harness.ts";
import { flag, has } from "../src/flags.ts";
import { resolveToken } from "../src/credentials.ts";

const argv = Deno.args;
const url = flag(argv, "--url");
if (!url || has(argv, "--help")) {
  console.log(
    "usage: deno run -A bench/deployment.ts --url <base> [--token <t>] [--checkpoints n,n,…] [--concurrency n]\n\n" +
      "  Writes up to `max(checkpoints)` records and cannot delete them. Use a throwaway space.\n" +
      "  --url is required on purpose: there is no safe default to point this at.",
  );
  Deno.exit(url ? 0 : 2);
}
const token = flag(argv, "--token") ?? Deno.env.get("RADIA_TOKEN") ?? resolveToken(url);
const checkpoints = (flag(argv, "--checkpoints") ?? "25000,100000,400000").split(",").map(Number);
const concurrency = Number(flag(argv, "--concurrency") ?? 64);

const client = new RadiaClient(url, token ? { token } : {});

const DOC = "bench_doc";
const JOB = "bench_job";
const DONE = "bench_job_done";

// `labels` is declared as an array so the `$any` row below exercises a real indexed path rather
// than an undeclared one, which would be refused before it could be slow.
await client.registerKind({
  kind: DOC,
  indexedPaths: [
    { path: "tag", type: "keyword" },
    { path: "owner", type: "keyword" },
    { path: "seq", type: "integer" },
    { path: "labels", type: "array" },
  ],
});
await client.registerKind({ kind: JOB, indexedPaths: [{ path: "tag", type: "keyword" }] });
await client.registerKind({ kind: DONE, indexedPaths: [] });

/** Fill to `to` with `concurrency` requests in flight, reporting achieved writes per second. */
async function fill(from: number, to: number): Promise<Measurement> {
  const started = performance.now();
  let next = from;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = next++;
      if (i >= to) return;
      await client.put({
        kind: DOC,
        body: {
          tag: i % 7 === 0 ? "rare" : "common", // 1 in 7, too many for an index to beat a scan
          seq: i,
          owner: `human:t${i % 8}`,
          labels: [`l${i % 5}`, `l${(i + 1) % 5}`],
        },
      });
    }
  }));
  const elapsedMs = performance.now() - started;
  // Concurrent, so per-op samples would measure queueing rather than the operation. Report the
  // aggregate only: this row answers "how fast can it be filled", not "what does one put cost".
  return { label: `fill @ ${concurrency} in flight`, samples: [], ops: to - from, elapsedMs };
}

const rows: { adapter: string; m: Measurement }[] = [];

/**
 * Where the space already is, rather than assuming it starts empty.
 *
 * Two things this buys, both learned by wanting them mid-run. A long fill can be RESUMED after an
 * interruption instead of starting over, and an already-filled space can be measured as it stands
 * (`--checkpoints` just above its current count fills almost nothing and measures everything). A
 * counter that starts at zero against a populated space writes the whole corpus a second time.
 */
const existing = (await client.getStats()).filter((s) => s.kind === DOC).reduce((n, s) => n + s.count, 0);
if (existing > 0) console.error(`  … ${existing.toLocaleString()} ${DOC} records already here; filling from there`);
let filled = existing;

for (const target of checkpoints) {
  // Past this checkpoint already: skip the FILL, still take the measurements. Skipping both was the
  // first version and it made the useful case impossible — pointing this at a space that is already
  // the size you care about, and asking what it costs there.
  if (target <= filled) console.error(`  … already past ${target.toLocaleString()}; measuring without filling`);
  else rows.push({ adapter: target.toLocaleString(), m: await fill(filled, target) });
  filled = target;
  const at = (m: Measurement) => rows.push({ adapter: target.toLocaleString(), m });

  // Serial, so these are the latency of ONE operation with the whole stack in the path.
  at(await measure("put (serial)", 150, (i) => client.put({ kind: DOC, body: { tag: "common", seq: 2e9 + i, owner: "human:t0", labels: ["l0"] } })));
  at(await measure("read_one indexed", 150, (i) => client.readOne({ kind: DOC, match: { seq: Math.abs(i) % filled } })));
  at(await measure("query limit=25", 80, () => client.query({ kind: DOC, match: { tag: "rare" } }, 25)));
  at(await measure("query owner-scoped", 80, () => client.query({ kind: DOC, match: { owner: "human:t3" } }, 25)));
  // The row this file was written for, and the pair is the point. `$any` is pushed into SQL and
  // exact, so the caller's LIMIT rides with it; `$each` is not (see `pushdown.ts`), so the pre-filter
  // is TRUE and the whole kind is pulled into JS for the oracle to decide, single-threaded.
  //
  // The first run measured `$any: ["l3"]`, an element compared against a one-element ARRAY, which
  // matches nothing at all. It timed the scan correctly and it is not a pattern anyone writes; the
  // scalar below is.
  at(await measure("query $any (pushed)", 20, () => client.query({ kind: DOC, match: { labels: { $any: "l3" } } }, 25)));
  // The same predicate matching NOTHING, which is the only honest before/after: a limit cannot cut
  // a scan short when no row satisfies it, so this row is a full pass over the kind either way and
  // the difference is purely where the pass happens. `$each` below is the shape the pre-pushdown
  // `$any` row had (unpushable AND empty), kept so the oracle path stays measured.
  at(await measure("query $any miss (pushed)", 5, () => client.query({ kind: DOC, match: { labels: { $any: "zz" } } }, 25)));
  // Past `maxScanRows` (200k by default) this is REFUSED rather than served, which is the scan
  // budget doing its job: an unpushable pattern is bounded by the work it may cause instead of by
  // the size of the kind. The refusal is timed like anything else, because the number that matters
  // is what a refused query COSTS — it should stay flat as the kind grows, where the same row was
  // linear before. Swallowed here rather than thrown, so one expected 429 does not end a two-hour
  // run; `refusals` says how many landed, and a row that is part served and part refused would be
  // meaningless, so it is reported.
  let refused = 0;
  let attempts = 0; // counted, not assumed: `measure` warms up before it counts, so the calls that
  // reach the space outnumber the samples, and a label reading "refused 10/5" is a number nobody
  // can act on.
  const each = await measure("query $each (oracle)", 5, async () => {
    attempts++;
    try {
      await client.query({ kind: DOC, match: { labels: { $each: "l3" } } }, 25);
    } catch (e) {
      if (e instanceof RadiaClientError && e.code === "scan_budget_exceeded") refused++;
      else throw e;
    }
  });
  at({ ...each, label: refused === 0 ? each.label : `query $each (refused ${refused}/${attempts})` });
  at(await measure("stats", 10, () => client.getStats()));

  await Promise.all(Array.from({ length: 120 }, (_, i) => client.put({ kind: JOB, body: { tag: "a", n: i } })));
  // `warmup: 0`: each iteration CONSUMES a claimable record, so a warmup would eat the supply.
  at(await measure("take+ack", 100, async () => {
    // `null` is an empty queue, not an error: the loop above supplies 120 and this counts 100, so a
    // null here would mean claims are being lost rather than that the bench ran out.
    const claim = await client.take({ pattern: { kind: JOB, match: { tag: "a" } } }, { leaseSeconds: 30 });
    if (claim) await client.ack(claim.lease, { kind: DONE, body: { ok: true } });
  }, 0));

  // PRINTED PER CHECKPOINT, not only at the end. A run to twenty million takes hours, and the
  // version that rendered once at the end meant stopping it early — because the shape was already
  // clear, or because something looked wrong — threw away every measurement it had taken. A
  // benchmark you cannot abandon is one you have to finish to learn anything from.
  console.error(`  … ${target.toLocaleString()} records`);
  console.log(`\n${renderTable(rows.filter((r) => r.adapter === target.toLocaleString()), "RECORDS")}`);
}

console.log(`\n${url}  (${concurrency} in flight while filling)\n`);
console.log(renderTable(rows, "RECORDS"));
console.log(
  "\nOne machine runs the client, the space and the database unless you point --url elsewhere, so\n" +
    "latency is flattered and throughput is penalised. Watch the SHAPE down a column, not the value.",
);
