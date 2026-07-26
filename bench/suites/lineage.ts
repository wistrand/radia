// The known hotspot, measured rather than assumed.
//
// `childrenOf` — the reverse edge behind `space_children`, the graph view, and any DAG walk — is
// a `LIKE` scan over the `parent_ids` JSON text, not an indexed edge (gotchas.md). This suite
// exists to put a number on when that stops being acceptable, because "fine at small scale" is
// not a size. It is also the prerequisite measurement for flow mining
// (research-self-modeling.md), which walks ancestry across the whole space repeatedly.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

export const lineageBenches: Bench[] = [
  {
    name: "lineage-scaling",
    note: "childrenOf is a LIKE scan: cost should grow with TOTAL records, not with the number of children found. If p50 rises across the sizes while the answer stays the same size, that is the scan.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "job", indexedPaths: [], claimable: false });
      ctx.space.registerKind({ kind: "step", indexedPaths: [], claimable: false });
      const out: Measurement[] = [];
      // One parent with a fixed, small number of children — then bury it in a growing space.
      const { id: root } = await ctx.space.put({ kind: "job", body: { root: true } });
      for (let i = 0; i < 5; i++) await ctx.space.put({ kind: "step", body: { i }, parentIds: [root] });

      let planted = 6;
      for (const size of [1_000, 5_000, 20_000].map((s) => s * ctx.scale)) {
        while (planted < size) {
          await ctx.space.put({ kind: "step", body: { filler: planted } });
          planted++;
        }
        out.push(await measure(`childrenOf @ ${(size / 1000).toFixed(0)}k records`, 20, () => ctx.space.getChildren(root)));
        out.push(await measure(`getRecord @ ${(size / 1000).toFixed(0)}k records`, 20, () => ctx.space.getRecord(root)));
      }
      return out;
    },
  },
  {
    name: "lineage-depth",
    note: "getLineage walks parent_ids upward one record at a time — cost is depth, not scan.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "step", indexedPaths: [], claimable: false });
      const out: Measurement[] = [];
      let prev: string | undefined;
      const tips: Record<number, string> = {};
      for (let d = 1; d <= 64; d++) {
        const { id } = await ctx.space.put({ kind: "step", body: { d }, parentIds: prev ? [prev] : [] });
        prev = id;
        if (d === 8 || d === 32 || d === 64) tips[d] = id;
      }
      for (const d of [8, 32, 64]) out.push(await measure(`getLineage depth ${d}`, 20, () => ctx.space.getLineage(tips[d])));
      return out;
    },
  },
];
