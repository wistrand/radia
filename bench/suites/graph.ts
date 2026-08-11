// The graph walk behind the console's Graph tab and waterfall (`GET /v0/ops/records/{id}/graph`).
//
// It was measured once, ad hoc, when wave-batching landed (174ms -> 27ms on Postgres for a
// 346-record conversation) and then never again, which is exactly how `childrenOf` regressed the
// first time. The shape to watch: cost tracks the SUBGRAPH RETURNED (maxNodes-capped), not the
// space, and the wave batching keeps depth from multiplying round trips.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

export const graphBenches: Bench[] = [
  {
    name: "graph",
    note: "getGraph over a conversation-shaped DAG (hub root, chained turns, chunk fan-out). Flat p50 across space sizes = the walk is bounded by the answer; 'down' walks one turn's subtree.",
    run: async (ctx) => {
      ctx.space.registerKind({ kind: "conv", indexedPaths: [], claimable: false });
      ctx.space.registerKind({ kind: "hop", indexedPaths: [], claimable: false });
      const out: Measurement[] = [];

      // One conversation: every hop parents to its cause AND the hub, chunks fan off each call
      // (the chat's turn shape, plan-chat-turn.md). ~8 records per turn.
      const { id: root } = await ctx.space.put({ kind: "conv", body: {} });
      let prev = root;
      let midTurn = root;
      for (let t = 0; t < 40; t++) {
        const { id: call } = await ctx.space.put({ kind: "hop", body: { t, role: "call" }, parentIds: [prev, root] });
        for (let c = 0; c < 5; c++) await ctx.space.put({ kind: "hop", body: { t, c }, parentIds: [call] });
        const { id: msg } = await ctx.space.put({ kind: "hop", body: { t, role: "msg" }, parentIds: [call, root] });
        prev = msg;
        if (t === 20) midTurn = call;
      }

      // Bury the same conversation in a growing space: the walk must not notice.
      let planted = 0;
      for (const size of [2_000, 10_000].map((s) => s * ctx.scale)) {
        while (planted < size) {
          await ctx.space.put({ kind: "hop", body: { filler: planted } });
          planted++;
        }
        const label = `@ ${(size / 1000).toFixed(0)}k records`;
        out.push(await measure(`graph 150 nodes ${label}`, 15, () => ctx.space.getGraph(root)));
        out.push(await measure(`graph 400 nodes ${label}`, 15, () => ctx.space.getGraph(root, { maxNodes: 400 })));
        out.push(await measure(`graph down (one turn) ${label}`, 15, () => ctx.space.getGraph(midTurn, { direction: "down", maxNodes: 400 })));
      }
      return out;
    },
  },
];
