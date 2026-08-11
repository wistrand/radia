// What housekeeping costs: the retention sweep, registry compaction, and the blob pass
// (plan-gc.md, all four phases). GC is on-demand and amortized onto writes, so its cost is paid
// by callers who did not ask for it — which is exactly why it needs a measured ceiling.
//
// These are ONE-SHOT measurements (a sweep is consumed by running it), so the percentile columns
// degenerate; read OPS/S, which is records-per-second of housekeeping. The shape to watch: cost
// tracks what was DELETED plus one bounded walk, never the whole space's history.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";
import { MemoryBlobStore } from "../../src/storage/blobs.ts";

const PAST = "2020-01-01T00:00:00.000Z";

export const gcBenches: Bench[] = [
  {
    name: "gc-sweep",
    note: "one live gc over a space where a third of the records expired. OPS/S = swept records per second; 'gc (nothing to do)' is the fixed cost every later verb call pays.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "note", indexedPaths: [], claimable: false });
      const out: Measurement[] = [];
      const total = 6_000 * ctx.scale;
      for (let i = 0; i < total; i++) {
        await ctx.space.put({ kind: "note", body: { i }, ...(i % 3 === 0 ? { retentionUntil: PAST } : {}) });
      }
      const m = await measure("gc: sweep 1/3 expired", 1, () => ctx.space.gc(), 0);
      m.ops = Math.floor(total / 3);
      out.push(m);
      out.push(await measure("gc: nothing to do", 5, () => ctx.space.gc(), 1));
      return out;
    },
  },
  {
    name: "gc-compact",
    note: "registry compaction: 20 keys x 200 superseded generations. OPS/S = compacted records per second. The walk is newest-first and bounded (MAX_WALK), so cost tracks the registry, not the space.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "cap", indexedPaths: [{ path: "tool", type: "keyword" }], claimable: false, contentKey: ["tool"] });
      const keys = 20;
      const gens = 200 * ctx.scale;
      for (let g = 0; g < gens; g++) {
        for (let k = 0; k < keys; k++) await ctx.space.put({ kind: "cap", body: { tool: `t${k}`, v: g } });
      }
      const m = await measure("gc: compact registries", 1, () => ctx.space.gc(), 0);
      m.ops = keys * (gens - 1);
      return [m];
    },
  },
  {
    name: "gc-blobs",
    note: "the phase-4 blob pass: live-digest set from the artifact records, then retainOnly over the store. Half the blobs are unreferenced (their records expired). OPS/S = blobs examined per second.",
    run: async (ctx) => {
      const out: Measurement[] = [];
      // The suite's Space carries a MemoryBlobStore by default; measure the port directly for the
      // store-side cost, and the whole verb for the end-to-end (records walk + pass).
      const blobs = 4_000 * ctx.scale;
      const store = new MemoryBlobStore();
      const live = new Set<string>();
      for (let i = 0; i < blobs; i++) {
        const { digest } = await store.put(new TextEncoder().encode(`payload-${i}`));
        if (i % 2 === 0) live.add(digest);
      }
      const m = await measure("retainOnly: half unreferenced", 1, () => store.retainOnly(live, { graceMs: 0 }), 0);
      m.ops = blobs;
      out.push(m);

      // End to end through the verb: the record sweep, the live-digest page walk, and the store
      // scan. The default grace window keeps these young bytes, so this measures the WALK (the
      // per-call cost every gc pays), not deletion throughput — retainOnly above measures that.
      const artifacts = 1_500 * ctx.scale;
      for (let i = 0; i < artifacts; i++) {
        await ctx.space.putArtifact(new TextEncoder().encode(`bytes-${i}`), {
          mediaType: "text/plain",
          ...(i % 2 === 0 ? { retentionUntil: PAST } : {}),
        });
      }
      const g = await measure("gc: artifact sweep + blob walk", 1, () => ctx.space.gc(), 0);
      g.ops = artifacts;
      out.push(g);
      return out;
    },
  },
];
