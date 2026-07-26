// Predicate pushdown soundness. `src/storage/pushdown.ts` renders part of a template into SQL so
// the database can pre-filter; `core/matching.ts` remains the oracle. The contract is asymmetric,
// and this suite exists to pin the dangerous direction:
//
//   over-returning is FINE   — the oracle rejects the extra rows, nobody notices
//   under-returning is a BUG — the record is simply gone, and `take` reports an empty space
//
// So every case below asserts a record IS found. Each targets a place where SQL's instincts
// disagree with the oracle: a missing key vs a JSON null, SQL's type coercion, jsonb's key-order
// normalization, collation order, and the paths/predicates pushdown deliberately declines.
//
// These run on every adapter, which is the point — the SQL differs per dialect, the verdicts must
// not. Note that the whole matching suite is also a pushdown test now, since every query goes
// through the pre-filter; this file covers what a generic matching test would not think to try.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "doc",
    indexedPaths: [
      { path: "s", type: "keyword" },
      { path: "n", type: "integer" },
      // The declared type is a routing contract, not a value constraint — these paths hold mixed
      // types on purpose, which is exactly what the pre-filter's type guards have to survive.
      { path: "flag", type: "keyword" },
      { path: "obj", type: "keyword" },
      { path: "arr", type: "array" },
      { path: "nested.deep", type: "keyword" },
      // Not renderable as a JSON path literal, so pushdown must decline it and let the oracle
      // handle it — a path is a declared string, not necessarily an identifier.
      { path: "od-d", type: "keyword" },
    ],
    sortablePaths: ["n"],
  });
  return space;
}

/** Assert a template finds exactly the record ids given, in any order. */
async function finds(space: Space, match: Record<string, unknown>, ids: string[], why: string) {
  const got = await space.query({ kind: "doc", match });
  assertEquals(
    got.map((r) => r.id).sort(),
    [...ids].sort(),
    `${why} — template ${JSON.stringify(match)}`,
  );
}

export const pushdownSuites: Suite[] = [
  {
    name: "a JSON null is present, a missing key is not (SQL conflates them; the oracle must not)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: isNull } = await space.put({ kind: "doc", body: { s: null } });
      const { id: absent } = await space.put({ kind: "doc", body: { other: 1 } });
      const { id: set } = await space.put({ kind: "doc", body: { s: "x" } });

      // SQLite's json_extract returns SQL NULL for BOTH cases, so a pre-filter written against the
      // extracted value instead of the type would lose one of these three verdicts.
      await finds(space, { s: { $exists: true } }, [isNull, set], "a JSON null exists");
      await finds(space, { s: { $exists: false } }, [absent], "only an absent key is missing");
      await finds(space, { s: null }, [isNull], "$eq null matches the JSON null only");
    },
  },
  {
    name: "no type coercion survives the round trip through SQL",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: num } = await space.put({ kind: "doc", body: { n: 5 } });
      const { id: str } = await space.put({ kind: "doc", body: { n: "5" } });
      const { id: yes } = await space.put({ kind: "doc", body: { flag: true } });
      const { id: one } = await space.put({ kind: "doc", body: { flag: 1 } });

      await finds(space, { n: 5 }, [num], "the number 5 is not the string \"5\"");
      await finds(space, { n: "5" }, [str], "the string \"5\" is not the number 5");
      // SQLite extracts JSON true as the integer 1: without a type guard these two collapse.
      await finds(space, { flag: true }, [yes], "true is not 1");
      await finds(space, { flag: 1 }, [one], "1 is not true");
      // A range against a string-valued field must not coerce either.
      await finds(space, { n: { $gte: 5 } }, [num], "an ordered comparison is typed too");
    },
  },
  {
    name: "deep equality keeps key order significant (jsonb equality does not)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "doc", body: { obj: { a: 1, b: 2 } } });
      await space.put({ kind: "doc", body: { obj: { z: 9 } } });

      // The oracle compares JSON.stringify, so {a,b} and {b,a} are different values. Postgres
      // jsonb would call them equal — pushing an object literal into jsonb `=` would therefore
      // report a match the oracle denies. Pushdown declines objects entirely; both verdicts here
      // come from the oracle.
      await finds(space, { obj: { a: 1, b: 2 } }, [id], "same key order matches");
      await finds(space, { obj: { b: 2, a: 1 } }, [], "reversed key order does not");
    },
  },
  {
    name: "array equality and quantifiers still match after pre-filtering",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "doc", body: { arr: ["a", "b"] } });
      await space.put({ kind: "doc", body: { arr: ["c"] } });

      await finds(space, { arr: ["a", "b"] }, [id], "array literal equality");
      await finds(space, { arr: { $any: "b" } }, [id], "$any is left to the oracle, not dropped");
      await finds(space, { arr: { $each: { $in: ["a", "b"] } } }, [id], "$each likewise");
    },
  },
  {
    name: "$in mixing scalars and structures never loses the structural arm",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: scalar } = await space.put({ kind: "doc", body: { obj: 1 } });
      const { id: structural } = await space.put({ kind: "doc", body: { obj: { x: 1 } } });

      // The trap: push the scalar arms as a SQL disjunction and silently drop the object arm. The
      // disjunction then excludes the row the object arm would have matched.
      await finds(space, { obj: { $in: [1, { x: 1 }] } }, [scalar, structural], "both arms survive");
    },
  },
  {
    name: "$or keeps branches that cannot be pushed",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: pushable } = await space.put({ kind: "doc", body: { s: "hit" } });
      const { id: not } = await space.put({ kind: "doc", body: { arr: ["q"] } });

      // One branch renders to SQL, the other does not. Rendering only the first would exclude the
      // second branch's rows — an $or is only pushable when EVERY branch is.
      await finds(space, { $or: [{ s: "hit" }, { arr: { $any: "q" } }] }, [pushable, not], "both branches match");
    },
  },
  {
    name: "string ordering agrees with the oracle for ASCII and non-ASCII data alike",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: ascii } = await space.put({ kind: "doc", body: { s: "zeta" } });
      const { id: accented } = await space.put({ kind: "doc", body: { s: "é" } });
      await space.put({ kind: "doc", body: { s: "alpha" } });

      // The oracle orders by UTF-16 code unit; Postgres' default collation is linguistic and would
      // sort "é" next to "e", i.e. BELOW "z". Pushdown forces byte-order collation, under which
      // both agree. If that collation were dropped, `accented` would vanish from this result.
      await finds(space, { s: { $gt: "b" } }, [ascii, accented], "an ASCII bound, byte order");
      // A non-ASCII bound is not pushed at all (the two orderings can disagree there), so this
      // verdict comes entirely from the oracle.
      await finds(space, { s: { $gt: "é" } }, [], "a non-ASCII bound falls back to the oracle");
    },
  },
  {
    name: "a path that cannot be rendered as a JSON path literal still matches",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "doc", body: { "od-d": "v" } });
      await space.put({ kind: "doc", body: { "od-d": "other" } });
      const { id: deep } = await space.put({ kind: "doc", body: { nested: { deep: "v" } } });

      // Segments outside [A-Za-z0-9_] are declined by `pushablePath` — inlining them into a path
      // literal is what would need escaping, and escaping is what gets injection wrong.
      await finds(space, { "od-d": "v" }, [id], "an unpushable path falls back to the oracle");
      await finds(space, { "nested.deep": "v" }, [deep], "a dotted path is pushed correctly");
    },
  },
  {
    name: "a limit is never pushed under a filter the database cannot decide",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Fifty non-matching records FIRST, so they own the low ids, then ten matches.
      for (let i = 0; i < 50; i++) await space.put({ kind: "doc", body: { arr: ["miss"] } });
      const hits: string[] = [];
      for (let i = 0; i < 10; i++) hits.push((await space.put({ kind: "doc", body: { arr: ["hit"] } })).id);

      // `$any` is not pushable, so the pre-filter is `TRUE`. Pushing the caller's limit into SQL
      // would return the ten lowest ids — all misses — and the oracle would reject every one,
      // answering "no matches" for a space holding ten. The limit only moves into SQL when the
      // filter is exact.
      // Sort rather than trusting insertion order: ULIDs minted inside one millisecond differ
      // only in their random half, so "the order they were put" is not "the order they sort".
      const byId = [...hits].sort();
      const got = await space.query({ kind: "doc", match: { arr: { $any: "hit" } } }, 5);
      assertEquals(got.length, 5, "a limited query over an inexact filter still returns full pages");
      assertEquals(got.map((r) => r.id), byId.slice(0, 5), "and returns the right records, in id order");

      const one = await space.readOne({ kind: "doc", match: { arr: { $any: "hit" } } });
      assertEquals(one?.id, byId[0], "read_one likewise looks past the non-matching prefix");
    },
  },
  {
    name: "an exact filter's pushed limit agrees with the oracle's ordering",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const hits: string[] = [];
      for (let i = 0; i < 20; i++) {
        const hit = i % 2 === 0;
        const { id } = await space.put({ kind: "doc", body: { s: hit ? "hit" : "miss" } });
        if (hit) hits.push(id);
      }
      // With no order_by the oracle's order is its id tie-break, which is what the pushed
      // `order by id` reproduces — so a limited query is the first N matches by id. Sorted, not
      // insertion order: ULIDs minted inside one millisecond differ only in their random half.
      const byId = [...hits].sort();
      assertEquals((await space.query({ kind: "doc", match: { s: "hit" } }, 3)).map((r) => r.id), byId.slice(0, 3));
      assertEquals((await space.readOne({ kind: "doc", match: { s: "hit" } }))?.id, byId[0]);
      // An explicit order_by is evaluated by the oracle, so the limit must not ride along with a
      // SQL ordering that disagrees with it.
      const desc = await space.query({ kind: "doc", match: { s: "hit" }, orderBy: [{ path: "n", dir: "desc" }] }, 3);
      assertEquals(desc.length, 3, "order_by plus limit still fills the page");
    },
  },
  {
    name: "a claim finds a rare match without scanning the kind (pushdown reaches take)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Deeper than one candidate window, so an unfiltered window would page repeatedly and a
      // pushed-down filter finds it in the first.
      for (let i = 0; i < 200; i++) await space.put({ kind: "doc", body: { s: "common", n: i } });
      const { id: needle } = await space.put({ kind: "doc", body: { s: "rare" } });
      for (let i = 0; i < 200; i++) await space.put({ kind: "doc", body: { s: "common", n: i } });

      const claimed = await space.take({ template: { kind: "doc", match: { s: "rare" } } }, { leaseSeconds: 60 });
      assert(claimed, "the one matching record must be claimed");
      assertEquals(claimed!.record.id, needle);
      // And a claim whose filter matches nothing is empty, not an arbitrary record of the kind.
      assertEquals(
        await space.take({ template: { kind: "doc", match: { s: "absent" } } }, { leaseSeconds: 60 }),
        null,
      );
    },
  },
];
