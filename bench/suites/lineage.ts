// A hotspot that was measured, then fixed — and is kept measured so it stays fixed.
//
// `childrenOf` — the reverse edge behind `space_children`, the graph view, and any DAG walk —
// used to be a `LIKE` scan over the `parent_ids` JSON text: cost grew with the size of the SPACE
// rather than with the number of children found. It is now an indexed lookup through
// `record_edges`, and the shape these benches watch for is a FLAT line across the sizes. A rising
// one means the edge table stopped being used. This is also the prerequisite measurement for flow
// mining (research-self-modeling.md), which walks ancestry across the whole space repeatedly.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

export const lineageBenches: Bench[] = [
  {
    name: "lineage-scaling",
    note: "childrenOf is an indexed edge lookup: p50 should stay FLAT across the sizes, since the answer size is fixed. A rising line means it has gone back to scanning.",
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
    note: "getLineage walks parent_ids upward one LEVEL at a time (a batched fetch per depth) — cost is depth, not space size.",
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
