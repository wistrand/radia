// The coordination loop (take/ack), and what happens when workers contend for the same work.
//
// Contention is the interesting measurement: a claim is a single-winner gate (`FOR UPDATE …
// SKIP LOCKED` on Postgres/PGlite), so throughput under N concurrent claimers is the number that
// says whether the substrate scales with workers or serializes them.

import type { Bench, Measurement } from "../harness.ts";
import { measure, percentile, timed } from "../harness.ts";

export const claimBenches: Bench[] = [
  {
    name: "take-ack",
    note: "One worker, uncontended: the full claim→settle cycle an agent runs per unit of work.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      const n = 150 * ctx.scale;
      for (let i = 0; i < n + 20; i++) await ctx.space.put({ kind: "task", body: { op: "upper", i } });
      const out: Measurement[] = [];
      const leases: import("../../src/storage/adapter.ts").Lease[] = [];
      out.push(await measure("take", n, async () => {
        const c = await ctx.space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 });
        if (c) leases.push(c.lease);
      }, 0)); // warmup 0: each take consumes a record, and the acks below settle exactly these leases
      let k = 0;
      // warmup 0: every iteration settles a lease prepared above, so a warmup would consume them.
      out.push(await measure("ack (no result)", leases.length, () => ctx.space.ack(leases[k++]), 0));
      return out;
    },
  },
  {
    name: "ack-with-result",
    note: "Ack that emits a result record. This is the fan-in write path, two records in one transaction.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "task", indexedPaths: [] });
      ctx.space.registerKind({ kind: "result", indexedPaths: [], claimable: false });
      const n = 100 * ctx.scale;
      for (let i = 0; i < n + 20; i++) await ctx.space.put({ kind: "task", body: { i } });
      const leases: import("../../src/storage/adapter.ts").Lease[] = [];
      for (let i = 0; i < n; i++) {
        const c = await ctx.space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 });
        if (c) leases.push(c.lease);
      }
      let k = 0;
      return [await measure("ack + emit result", leases.length, () => ctx.space.ack(leases[k++], { kind: "result", body: { ok: true } }), 0)];
    },
  },
  {
    name: "contention",
    note: "N claimers racing for one queue. Compare ops/s across N: flat means the single-winner gate serializes; rising means it scales.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "task", indexedPaths: [] });
      const out: Measurement[] = [];
      for (const workers of [1, 4, 16]) {
        const total = 120 * ctx.scale;
        for (let i = 0; i < total; i++) await ctx.space.put({ kind: "task", body: { i, workers } });
        const samples: number[] = [];
        const state = { claimed: 0, empties: 0 };
        const t0 = performance.now();
        // Concurrent, not parallel: one isolate, so this measures the substrate's serialization,
        // not CPU parallelism. That is the property under test.
        //
        // A null take is NOT proof the queue is drained. `take` locks its whole candidate set
        // (`for update ... skip locked` with no limit), so under contention a claimer can be
        // handed nothing while thousands of records remain, because every candidate is locked by
        // somebody else's open transaction. Counting a null as "drained" ends the run early and
        // reports a throughput figure for work that never happened, so nulls are counted
        // separately and the loop keeps going until the claims actually add up.
        await Promise.all(Array.from({ length: workers }, async () => {
          while (state.claimed < total) {
            let got = false;
            const ms = await timed(async () => {
              const c = await ctx.space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 });
              if (c) {
                got = true;
                state.claimed++;
                await ctx.space.ack(c.lease);
              }
            });
            samples.push(ms);
            if (!got) {
              state.empties++;
              if (state.empties > total * 4) return; // genuinely nothing left, or livelocked
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }));
        const starved = state.empties > 0 ? `  (${state.empties} empty takes)` : "";
        out.push({
          label: `take+ack × ${String(workers).padStart(2)} claimers${starved}`,
          samples,
          ops: state.claimed,
          elapsedMs: performance.now() - t0,
        });
      }
      void percentile;
      return out;
    },
  },
];
