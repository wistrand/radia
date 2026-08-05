// Does the cost of an ordinary operation grow with the size of the space?
//
// This is the "limits" question. Everything else measures an operation in isolation; this one
// re-measures the same operations as the space fills, so a flat line means the indexes are doing
// their job and a rising one names the size where something needs attention.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

export const scaleBenches: Bench[] = [
  {
    name: "growth",
    note: "put / read_one / query / take, re-measured as the space fills. Rising p50 with a constant result size is the signal.",
    run: async (ctx) => {
      ctx.space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }, { path: "tags", type: "array" }],
      });
      const out: Measurement[] = [];
      let planted = 0;
      for (const size of [2_000, 10_000, 40_000].map((s) => s * ctx.scale)) {
        while (planted < size) {
          await ctx.space.put({
            kind: "task",
            body: { op: planted % 7 === 0 ? "rare" : "common", n: planted, tags: [`t${planted % 5}`] },
          });
          planted++;
        }
        const tag = `@ ${(size / 1000).toFixed(0)}k`;
        out.push(await measure(`put ${tag}`, 50, (i) => ctx.space.put({ kind: "task", body: { op: "common", n: 1e9 + i } })));
        out.push(await measure(`read_one rare ${tag}`, 50, () => ctx.space.readOne({ kind: "task", match: { op: "rare" } })));
        out.push(await measure(`query 25 rare ${tag}`, 50, () => ctx.space.query({ kind: "task", match: { op: "rare" } }, 25)));
        // The operation a work queue lives on: claim ranking has to find a candidate among
        // everything already in the space.
        out.push(await measure(`take ${tag}`, 20, async () => {
          const c = await ctx.space.take({ pattern: { kind: "task", match: { op: "rare" } } }, { leaseSeconds: 1 });
          if (c) await ctx.space.ack(c.lease);
        }));
        // The pushable/unpushable pair, at three sizes. `$any` is rendered into SQL and exact, so
        // the limit rides with it; `$each` is not, so the oracle sees the whole kind. Over HTTP at
        // 1M records that gap was three orders of magnitude (`../deployment.ts`), and no in-process
        // row showed it, because every other predicate here is pushable.
        out.push(await measure(`query 25 $any ${tag}`, 20, () => ctx.space.query({ kind: "task", match: { tags: { $any: "t3" } } }, 25)));
        out.push(await measure(`query 25 $each ${tag}`, 5, () => ctx.space.query({ kind: "task", match: { tags: { $each: "t3" } } }, 25)));
        out.push(await measure(`stats ${tag}`, 10, () => ctx.space.stats()));
        out.push(await measure(`diagnostics ${tag}`, 10, () => ctx.space.diagnostics()));
      }
      return out;
    },
  },
];
