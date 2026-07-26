// The write and read path: put, read_one, query — the operations every agent does constantly.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

function seedKind(ctx: { space: import("../../src/core/space.ts").Space }) {
  ctx.space.registerKind({
    kind: "task",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }],
    sortablePaths: ["n"],
  });
}

export const recordBenches: Bench[] = [
  {
    name: "put",
    note: "The write path: build record, hash body, insert record + envelope + event in one transaction.",
    run: async (ctx) => {
      seedKind(ctx);
      const n = 200 * ctx.scale;
      return [await measure("put", n, (i) => ctx.space.put({ kind: "task", body: { op: "upper", n: i, text: "the quick brown fox" } }))];
    },
  },
  {
    name: "read",
    note: "read_one stops at the first match; query scans to the limit. Both compile the template first.",
    run: async (ctx) => {
      seedKind(ctx);
      const seed = 500 * ctx.scale;
      for (let i = 0; i < seed; i++) await ctx.space.put({ kind: "task", body: { op: i % 2 ? "upper" : "reverse", n: i } });
      const out: Measurement[] = [];
      out.push(await measure("read_one (indexed match)", 100 * ctx.scale, () => ctx.space.readOne({ kind: "task", match: { op: "upper" } })));
      out.push(await measure("query limit=10", 100 * ctx.scale, () => ctx.space.query({ kind: "task", match: { op: "upper" } }, 10)));
      out.push(await measure("query limit=100", 50 * ctx.scale, () => ctx.space.query({ kind: "task", match: { op: "upper" } }, 100)));
      out.push(await measure("query ordered (sortable path)", 50 * ctx.scale, () => ctx.space.query({ kind: "task", orderBy: [{ path: "n" }] }, 100)));
      return out;
    },
  },
  {
    name: "match-complexity",
    note: "Cost of the predicate itself: equality vs. range vs. $or across the same population.",
    run: async (ctx) => {
      seedKind(ctx);
      const seed = 500 * ctx.scale;
      for (let i = 0; i < seed; i++) await ctx.space.put({ kind: "task", body: { op: i % 3 ? "upper" : "reverse", n: i } });
      const reps = 100 * ctx.scale;
      return [
        await measure("match {op}", reps, () => ctx.space.query({ kind: "task", match: { op: "upper" } }, 50)),
        await measure("match {n: $gt}", reps, () => ctx.space.query({ kind: "task", match: { n: { $gt: seed / 2 } } }, 50)),
        await measure("match {$or}", reps, () => ctx.space.query({ kind: "task", match: { $or: [{ op: "upper" }, { n: { $lt: 10 } }] } }, 50)),
        await measure("no match (full scan to limit)", reps, () => ctx.space.query({ kind: "task", match: { op: "nonexistent" } }, 50)),
      ];
    },
  },
];
