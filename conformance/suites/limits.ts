// Resource limits (design-data-model §2), on every adapter.
//
// Each of these bounds a cost that BYTES do not. A pattern is stored and then evaluated against
// every candidate record, so its cost is paid per record rather than once; a body's depth and
// fan-out are walked by the matcher, the event chain and every reader, and 1 KiB of `[[[[…]]]]` is
// small and unbounded to all of them; an interest registry is read per candidate by the dry-run
// matcher and per kind by the starvation split, so its size is somebody else's cost.
//
// The rejections matter more than the acceptances: a limit nobody has seen refuse anything is a
// number in a constant.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { RadiaError } from "../../src/core/errors.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "task",
    indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }, { path: "tags", type: "array" }],
  });
  return space;
}

/** The error code a call throws, or "" when it does not throw. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${(e as Error).message}`;
  }
}

export const limitSuites: Suite[] = [
  {
    name: "a pattern too large to evaluate cheaply is refused",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const huge = { op: { $in: [] as string[] } };
      // Under the value cap but over the byte cap: the two limits catch different shapes, and a
      // pattern can be small in count and enormous in size.
      huge.op.$in = Array.from({ length: 200 }, (_, i) => `${"x".repeat(64)}${i}`);
      assertEquals(await codeOf(() => space.query({ kind: "task", match: huge })), "pattern_too_large");

      // The ordinary pattern beside it still compiles: a limit that refuses normal work is a bug.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { op: "upper" } })), "");
    },
  },
  {
    name: "a flat pattern with thousands of predicates is refused, though its DEPTH is 1",
    run: async (adapter) => {
      // Depth alone does not bound evaluation cost, which is the reason this limit exists beside
      // the nesting one: every branch here is a comparison run per candidate record.
      const space = newSpace(adapter);
      const wide = { $or: Array.from({ length: 40 }, (_, i) => ({ n: i })) };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: wide })), "too_many_branches");

      const nested = {
        $and: [{ $or: Array.from({ length: 12 }, (_, i) => ({ n: i })) }, { $or: Array.from({ length: 12 }, (_, i) => ({ n: i + 100 })) }],
      };
      // Each $or is under the branch cap; together they are over the predicate cap. The two limits
      // are not the same limit spelled twice.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: nested })), "");
      const deeper = {
        $and: [
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 100 })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 200 })) },
          { $or: Array.from({ length: 16 }, (_, i) => ({ n: i + 300 })) },
        ],
      };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: deeper })), "too_many_predicates");
    },
  },
  {
    name: "an oversized $in is refused",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const many = { op: { $in: Array.from({ length: 500 }, (_, i) => `v${i}`) } };
      assertEquals(await codeOf(() => space.query({ kind: "task", match: many })), "too_many_values");
    },
  },
  {
    name: "a body nested deeper than the limit is refused, and the check does not itself recurse",
    run: async (adapter) => {
      // The guard has to survive the input it exists to reject. A recursive checker overflows the
      // stack on a deeply nested body, which is the bug rather than the defence, so this builds one
      // far past the limit and expects an ERROR rather than a crash.
      const space = newSpace(adapter);
      let deep: unknown = "bottom";
      for (let i = 0; i < 5000; i++) deep = { next: deep };
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", deep } })), "body_too_deep");

      // Ordinary nesting is untouched.
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", a: { b: { c: 1 } } } })), "");
    },
  },
  {
    name: "an oversized array in a body is refused wherever it sits",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const long = Array.from({ length: 5000 }, (_, i) => i);
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", tags: long } })), "array_too_long");
      // Nested inside an object, not just at the top: the walk covers the whole shape.
      assertEquals(await codeOf(() => space.put({ kind: "task", body: { op: "x", a: { b: long } } })), "array_too_long");
    },
  },
  {
    name: "a principal cannot register unbounded interests, and re-publishing is always allowed",
    run: async (adapter) => {
      const space = new Space(adapter, { maxInterestsPerPrincipal: 3 });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
        { principal: "agent:w", kind: "task", operations: ["take"] },
      ]);
      const { run } = await space.mintRun(definitionToken);

      for (let i = 0; i < 3; i++) {
        await space.put({ kind: "interest", body: { kind: "task", match: { op: `op${i}` } } }, undefined, run);
      }
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "op9" } } }, undefined, run)),
        "too_many_interests",
      );

      // A restart republishes what it already declared. Refusing that would leave a worker at the
      // ceiling unable to come back, which is a worse failure than the one being prevented.
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "op0" } } }, undefined, run)),
        "",
      );
      // And a withdrawal is never refused, or the ceiling would be a trap with no way down.
      assertEquals(
        await codeOf(() =>
          space.put({ kind: "interest", body: { kind: "task", match: { op: "op9" }, retired: true } }, undefined, run)
        ),
        "",
      );

      // The budget is per principal, not global: another worker is unaffected.
      const { definitionToken: other } = await space.createAgentDefinition("agent:b", [
        { principal: "agent:b", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run: otherRun } = await space.mintRun(other);
      assertEquals(
        await codeOf(() => space.put({ kind: "interest", body: { kind: "task", match: { op: "x" } } }, undefined, otherRun)),
        "",
      );
    },
  },
  {
    name: "the limits are enforced in the RUNTIME, not only at the HTTP boundary",
    run: async (adapter) => {
      // Every one of these calls is in-process: the SDK, the MCP adapter, the examples and the
      // runtime itself never pass through a handler, and a limit that lives in a handler is a limit
      // half the callers do not have. Same reason `compilePattern` validates its own input.
      const space = newSpace(adapter);
      let deep: unknown = 1;
      for (let i = 0; i < 100; i++) deep = [deep];
      const codes = [
        await codeOf(() => space.put({ kind: "task", body: { op: "x", deep } })),
        await codeOf(() => space.query({ kind: "task", match: { op: { $in: Array.from({ length: 300 }, (_, i) => `${i}`) } } })),
      ];
      assert(codes.every((c) => c !== ""), `a limit was not enforced in-process: ${JSON.stringify(codes)}`);
    },
  },
  {
    // The measured shape (`bench/deployment.ts`): an unpushable pattern pulls the whole kind through
    // the oracle, 13.6s at a million records in a single-threaded process, so one principal's
    // pattern is everyone else's outage. The budget bounds the rows one read may EXAMINE. It fires
    // on candidates, never on results, which is what keeps it invisible to a pattern SQL can decide.
    name: "a scan budget bounds what one read may push through the oracle",
    run: async (adapter) => {
      // The budget is under the kind's size and over the claim window, so both paths have to page
      // more than once to reach it: a budget below one window would prove only that the first fetch
      // overshot.
      const space = new Space(adapter, { maxScanRows: 150 });
      space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "op", type: "keyword" }, { path: "n", type: "integer" }, { path: "tags", type: "array" }],
      });
      for (let i = 0; i < 400; i++) {
        await space.put({ kind: "task", body: { op: i === 399 ? "rare" : "common", n: i, tags: [`t${i % 5}`] } });
      }

      // `$each` is not pushable (`pushdown.ts`), so every record of the kind reaches `matchesRecord`,
      // and nothing satisfies this one, so nothing stops the walk before the budget does. That
      // combination — undecidable in SQL, and few or no matches — is the whole shape of the problem:
      // it is exactly what the deployment benchmark measured at 13.6s.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { tags: { $each: "zz" } } }, 10)), "scan_budget_exceeded");
      assertEquals(await codeOf(() => space.readOne({ kind: "task", match: { tags: { $each: "zz" } } })), "scan_budget_exceeded");
      // A claim pages in windows instead of fetching the kind, and pays the same cost for the same
      // reason: each window is a window of the queue, not of the matches.
      assertEquals(
        await codeOf(() => space.take({ pattern: { kind: "task", match: { tags: { $each: "zz" } } } })),
        "scan_budget_exceeded",
      );

      // Every pushable predicate is decided in SQL, so it returns matches rather than candidates and
      // cannot reach the budget however large the kind grows. This is the line the whole design
      // rests on: the limit is invisible to patterns the database can answer.
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { op: "rare" } }, 10)), "");
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { n: { $gte: 0 } } }, 10)), "");
      assertEquals(await codeOf(() => space.query({ kind: "task", match: { tags: { $any: "t3" } } }, 10)), "");
      assertEquals(await codeOf(() => space.take({ pattern: { kind: "task", match: { op: "rare" } } })), "");

      // And an inexact scan that finds what it needs early stops there rather than walking the kind,
      // so the budget is a bound on WORK and not a cap on how large a kind may be while an
      // unpushable pattern is in use. Matches are dense here, so the first chunk satisfies the limit.
      const hits = await space.query({ kind: "task", match: { tags: { $each: { $in: ["t0", "t1", "t2", "t3", "t4"] } } } }, 5);
      assertEquals(hits.length, 5);
    },
  },
  {
    // An unbudgeted scan is also an unbounded ALLOCATION: both adapters used to materialise every
    // row of the kind before the oracle saw the first one. The chunked walk is what makes the
    // budget enforceable partway rather than after the damage, and this pins its two edges, since
    // an off-by-one at the chunk boundary is invisible in the common case.
    name: "the chunked scan agrees with the whole-kind scan at every boundary",
    run: async (adapter) => {
      const space = new Space(adapter, { maxScanRows: 100_000 });
      space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "n", type: "integer" }, { path: "tags", type: "array" }],
        sortablePaths: ["n"],
      });
      const ids: string[] = [];
      for (let i = 0; i < 2500; i++) { // more than two chunks, and not a multiple of one
        ids.push((await space.put({ kind: "task", body: { n: i, tags: i % 250 === 0 ? ["hit"] : ["miss"] } })).id);
      }
      const sorted = [...ids].sort();
      const each = { tags: { $each: "hit" } };

      const all = await space.query({ kind: "task", match: each }, 100);
      assertEquals(all.length, 10, "every match across the chunk boundaries, none twice");
      assertEquals(all.map((r) => r.id), all.map((r) => r.id).sort(), "in id order, the oracle tie-break");

      // A limit smaller than the match count stops the walk early, and must still return the FIRST
      // matches rather than whichever chunk happened to be in hand.
      assertEquals((await space.query({ kind: "task", match: each }, 3)).map((r) => r.id), all.slice(0, 3).map((r) => r.id));
      assertEquals((await space.readOne({ kind: "task", match: each }))?.id, all[0].id);

      // A cursor into the middle resumes the walk rather than restarting it.
      const after = await space.query({ kind: "task", match: each }, 100, { after: all[4].id });
      assertEquals(after.map((r) => r.id), all.slice(5).map((r) => r.id));

      // Descending, where the chunk cursor has to walk the other way.
      const desc = await space.query({ kind: "task", match: each }, 100, { dir: "desc" });
      assertEquals(desc.map((r) => r.id), [...all].reverse().map((r) => r.id));

      // An order_by cannot stop early (the sort needs every match), so it exercises the full walk.
      const ordered = await space.query({ kind: "task", match: each, orderBy: [{ path: "n", dir: "desc" }] }, 100);
      assertEquals((ordered[0].body as { n: number }).n, 2250);
      assertEquals(ordered.length, 10);
      assertEquals(sorted.length, 2500);
    },
  },
];
