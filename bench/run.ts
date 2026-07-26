// `deno task bench` — throughput, latency percentiles, and scaling curves for a Radia space.
//
//   deno task bench                     every suite, both embedded adapters, quick profile
//   deno task bench -- --suite lineage  one suite
//   deno task bench -- --scale 4        4x the iterations (slower, steadier numbers)
//   deno task bench -- --adapter sqlite one adapter
//   RADIA_PG_URL=postgres://… deno task bench      adds a live Postgres column
//
// What these numbers are: single-process, in-memory storage by default, measuring the SUBSTRATE
// (core + adapter) with no HTTP, no serialization, no network. They are a floor for latency and a
// ceiling for throughput — useful for spotting hotspots and regressions, not for capacity planning
// a deployment. A disk-backed or networked space will be slower, and the ordering between adapters
// can change under real fsync.
//
// Nothing here asserts. A benchmark that moved is a fact to explain, not a failing build.

import { PgliteAdapter } from "../src/storage/pglite.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { PostgresAdapter } from "../src/storage/postgres.ts";
import type { StorageAdapter } from "../src/storage/adapter.ts";
import { newUlid } from "../src/core/ids.ts";
import { type Bench, renderTable, withSpace } from "./harness.ts";
import { recordBenches } from "./suites/records.ts";
import { claimBenches } from "./suites/claims.ts";
import { lineageBenches } from "./suites/lineage.ts";
import { scaleBenches } from "./suites/scale.ts";
import { blobBenches } from "./suites/blobs.ts";

const ALL: Bench[] = [...recordBenches, ...claimBenches, ...lineageBenches, ...scaleBenches, ...blobBenches];

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const scale = Number(arg("scale") ?? "1");
const only = arg("suite");
const onlyAdapter = arg("adapter");
const benches = only ? ALL.filter((b) => b.name === only || b.name.startsWith(only)) : ALL;
if (benches.length === 0) {
  console.error(`no suite matches '${only}'. available: ${ALL.map((b) => b.name).join(", ")}`);
  Deno.exit(2);
}

const factories: { name: string; create: () => StorageAdapter }[] = [
  { name: "sqlite", create: () => new SqliteAdapter(":memory:") },
  { name: "pglite", create: () => new PgliteAdapter() },
];
const pgUrl = Deno.env.get("RADIA_PG_URL");
if (pgUrl) {
  factories.push({ name: "postgres", create: () => new PostgresAdapter(pgUrl, { schema: `radia_bench_${newUlid()}`, ephemeral: true }) });
}
const running = onlyAdapter ? factories.filter((f) => f.name === onlyAdapter) : factories;

console.log(`radia bench — scale ${scale}, adapters: ${running.map((f) => f.name).join(", ")}${pgUrl ? "" : "  (set RADIA_PG_URL for a live Postgres column)"}`);
console.log("in-memory storage, single process, no HTTP — a floor for latency, not capacity planning\n");

const started = performance.now();
for (const bench of benches) {
  const rows: { adapter: string; m: import("./harness.ts").Measurement }[] = [];
  for (const f of running) {
    // The blob suites do not touch storage; run them once rather than once per adapter.
    if (bench.name === "blobs" && f.name !== running[0].name) continue;
    await withSpace(f.create(), async (space) => {
      for (const m of await bench.run({ space, scale })) rows.push({ adapter: bench.name === "blobs" ? "—" : f.name, m });
    });
  }
  console.log(`## ${bench.name}`);
  console.log(renderTable(rows));
  if (bench.note) console.log(`\n${bench.note}`);
  console.log("");
}
console.log(`total ${(performance.now() - started) / 1000 | 0}s`);
