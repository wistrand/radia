// Phase 2 conformance: matching operators, the divergence semantics, array quantifiers,
// $or, and order_by. Runs on every adapter (results must be identical since the oracle is
// backend-neutral).

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { RadiaRecord } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import type { RadiaError } from "../../src/core/errors.ts";

/** Read a body field (body is typed `unknown`). */
function bf(rec: RadiaRecord | null, key: string): unknown {
  return rec ? (rec.body as Record<string, unknown>)[key] : undefined;
}

function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "task",
    indexedPaths: [
      { path: "tag", type: "keyword" },
      { path: "n", type: "integer" },
      { path: "opt", type: "keyword" },
      { path: "tags", type: "array" },
      { path: "nums", type: "array" },
    ],
    sortablePaths: ["n"],
  });
  return space;
}

export const matchingSuites: Suite[] = [
  {
    name: "order_by shape is validated, not trusted (a wrong type is a bad request, not a crash)",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "n", type: "integer" }], sortablePaths: ["n"] });
      await space.put({ kind: "task", body: { n: 1 } });
      // A handler casts wire JSON to a type; a cast is a promise, not a check. `"n"` instead of
      // [{path:"n"}] used to reach `.map` on a string and surface as a 500.
      for (const bad of ["n", 42, {}, [null], [{}], [{ path: 1 }]] as unknown[]) {
        let threw = false;
        try {
          await space.query({ kind: "task", orderBy: bad as never });
        } catch (e) {
          threw = true;
          assertEquals((e as RadiaError).code, "invalid_template", `wrong code for ${JSON.stringify(bad)}`);
        }
        assert(threw, `order_by ${JSON.stringify(bad)} must be rejected`);
      }
      // …and the valid shape still works.
      assertEquals((await space.query({ kind: "task", orderBy: [{ path: "n" }] })).length, 1);
    },
  },

  {
    name: "range operators and $in",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const n of [1, 5, 10]) await space.put({ kind: "task", body: { tag: "r", n } });

      assertEquals((await space.readOne({ kind: "task", match: { n: { $gt: 4 } }, orderBy: [{ path: "n" }] }))?.body, { tag: "r", n: 5 });
      assertEquals((await space.readOne({ kind: "task", match: { n: { $gte: 5, $lt: 10 } } }))?.body, { tag: "r", n: 5 });
      assertEquals(await space.readOne({ kind: "task", match: { n: { $gt: 100 } } }), null);
      assertEquals((await space.readOne({ kind: "task", match: { n: { $in: [10, 999] } } }))?.body, { tag: "r", n: 10 });
    },
  },
  {
    name: "missing != null; $exists distinguishes absent from present",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "present", opt: "here" } });
      await space.put({ kind: "task", body: { tag: "absent" } }); // no `opt`
      await space.put({ kind: "task", body: { tag: "null", opt: null } });

      // eq to a value never matches a missing field
      assertEquals(bf(await space.readOne({ kind: "task", match: { opt: "here" } }), "tag"), "present");
      // $exists:false matches ONLY the absent field (not the explicit null)
      const absent = await space.readOne({ kind: "task", match: { opt: { $exists: false } } });
      assertEquals(bf(absent, "tag"), "absent");
      // $exists:true matches present-including-null, but not absent
      const existsTrue = await space.readOne({
        kind: "task",
        match: { opt: { $exists: true } },
        orderBy: [{ path: "n" }],
      });
      assert(existsTrue && bf(existsTrue, "tag") !== "absent");
    },
  },
  {
    name: "no type coercion: cross-type comparison is false",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "str", n: 5 } });

      // template value "5" (string) vs stored 5 (number) -> no match
      assertEquals(await space.readOne({ kind: "task", match: { n: "5" } }), null);
      assertEquals(await space.readOne({ kind: "task", match: { n: { $gt: "3" } } }), null);
      // correct type matches
      assert(await space.readOne({ kind: "task", match: { n: 5 } }));
    },
  },
  {
    name: "scalar predicates do not distribute over arrays; $any/$each are explicit",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "arr", tags: ["red", "blue"], nums: [1, 2, 3] } });

      // scalar eq against an array field does NOT match an element
      assertEquals(await space.readOne({ kind: "task", match: { tags: "red" } }), null);
      // $any: some element equals
      assert(await space.readOne({ kind: "task", match: { tags: { $any: "red" } } }));
      assertEquals(await space.readOne({ kind: "task", match: { tags: { $any: "green" } } }), null);
      // $any with a comparison
      assert(await space.readOne({ kind: "task", match: { nums: { $any: { $gt: 2 } } } }));
      // $each: every element satisfies
      assert(await space.readOne({ kind: "task", match: { nums: { $each: { $lt: 10 } } } }));
      assertEquals(await space.readOne({ kind: "task", match: { nums: { $each: { $lt: 3 } } } }), null);
    },
  },
  {
    name: "$or and $and combine predicates",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a", n: 1 } });
      await space.put({ kind: "task", body: { tag: "b", n: 2 } });

      const or = await space.readOne({
        kind: "task",
        match: { $or: [{ tag: "a" }, { tag: "z" }] },
        orderBy: [{ path: "n" }],
      });
      assertEquals(bf(or, "tag"), "a");
      assertEquals(
        await space.readOne({ kind: "task", match: { $or: [{ tag: "y" }, { tag: "z" }] } }),
        null,
      );
      // implicit AND across fields
      assert(await space.readOne({ kind: "task", match: { tag: "b", n: 2 } }));
      assertEquals(await space.readOne({ kind: "task", match: { tag: "b", n: 1 } }), null);
    },
  },
  {
    name: "order_by with deterministic id tie-break",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "o", n: 3 } });
      await space.put({ kind: "task", body: { tag: "o", n: 1 } });
      await space.put({ kind: "task", body: { tag: "o", n: 2 } });

      assertEquals(bf(await space.readOne({ kind: "task", match: { tag: "o" }, orderBy: [{ path: "n" }] }), "n"), 1);
      assertEquals(
        bf(await space.readOne({ kind: "task", match: { tag: "o" }, orderBy: [{ path: "n", dir: "desc" }] }), "n"),
        3,
      );
    },
  },
];
