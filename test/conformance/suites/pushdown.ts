// Predicate pushdown soundness. `src/storage/pushdown.ts` renders part of a pattern into SQL so
// the database can pre-filter; `core/matching.ts` remains the oracle. The contract is asymmetric,
// and this suite exists to pin the dangerous direction:
//
//   over-returning is FINE:   the oracle rejects the extra rows, nobody notices
//   under-returning is a BUG: the record is simply gone, and `take` reports an empty space
//
// So every case below asserts a record IS found. Each targets a place where SQL's instincts
// disagree with the oracle: a missing key vs a JSON null, SQL's type coercion, jsonb's key-order
// normalization, collation order, and the paths/predicates pushdown deliberately declines.
//
// These run on every adapter, which is the point: the SQL differs per dialect, the verdicts must
// not. Note that the whole matching suite is also a pushdown test now, since every query goes
// through the pre-filter; this file covers what a generic matching test would not think to try.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../../src/core/space.ts";
import { compilePattern, matchesRecord } from "../../../src/core/matching.ts";
import type { KindDef } from "../../../src/core/kinds.ts";

function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "doc",
    indexedPaths: [
      { path: "s", type: "keyword" },
      { path: "n", type: "integer" },
      // The declared type is a routing contract, not a value constraint. These paths hold mixed
      // types on purpose, which is exactly what the pre-filter's type guards have to survive.
      { path: "flag", type: "keyword" },
      { path: "obj", type: "keyword" },
      { path: "arr", type: "array" },
      { path: "nested.deep", type: "keyword" },
      // Not renderable as a JSON path literal, so pushdown must decline it and let the oracle
      // handle it: a path is a declared string, not necessarily an identifier.
      { path: "od-d", type: "keyword" },
    ],
    sortablePaths: ["n"],
  });
  return space;
}

/** Assert a pattern finds exactly the record ids given, in any order. */
async function finds(space: Space, match: Record<string, unknown>, ids: string[], why: string) {
  const got = await space.query({ kind: "doc", match });
  assertEquals(
    got.map((r) => r.id).sort(),
    [...ids].sort(),
    `${why}; pattern ${JSON.stringify(match)}`,
  );
}

/**
 * The path shapes where SQL, the two dialects, and the oracle each have their own instinct: an
 * array index, a leading zero, a digit segment mid-path, and a name that is a property of every
 * JavaScript object but of no JSON document. Declared as indexed paths because a kind may declare
 * any non-empty segments (`validPath`), so none of this needs an exotic client to reach.
 */
const AWKWARD: KindDef = {
  kind: "awkward",
  indexedPaths: [
    { path: "label", type: "keyword" },
    { path: "arr.0", type: "keyword" },
    { path: "arr.00", type: "keyword" },
    { path: "arr.length", type: "integer" },
    { path: "m.0", type: "keyword" },
    { path: "m.00", type: "keyword" },
    { path: "obj.constructor", type: "keyword" },
    { path: "obj.toString", type: "keyword" },
    { path: "deep.0.k", type: "keyword" },
  ],
};

/** The fixture corpus, keyed by `label` so a failure names the record rather than a ULID. */
const CORPUS: Record<string, unknown>[] = [
  { label: "array", arr: ["a", "b"] },
  { label: "digit-keys", m: { "0": "a", "00": "z" } },
  { label: "proto-named-keys", obj: { constructor: "c", toString: "t" } },
  { label: "plain-obj", obj: { other: 1 } },
  { label: "nested-index", deep: [{ k: "v" }] },
  { label: "empty-array", arr: [] },
  { label: "bare", other: 1 },
];

export const pushdownSuites: Suite[] = [
  {
    // The guard for audit package E. Every case is differential: the same pattern goes through the
    // adapter (pre-filter, then oracle over what came back) and through the BARE oracle over the
    // same corpus, and the two result sets must be identical. That comparison is what catches
    // under-return, since a record excluded by SQL never reaches the oracle to be rejected — the
    // adapter simply answers with less. The explicit label list on each case then keeps the
    // comparison honest, so a change that broke both halves the same way cannot pass.
    name: "the pre-filter agrees with the oracle on array indexes, digit segments and prototype names",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind(AWKWARD);
      const ids = new Map<string, string>();
      for (const body of CORPUS) {
        const { id } = await space.put({ kind: "awkward", body });
        ids.set(id, body.label as string);
      }

      const all = await space.query({ kind: "awkward" }, 100);
      assertEquals(all.length, CORPUS.length, "the unfiltered corpus is what both sides filter");

      const differential = async (match: Record<string, unknown>, expected: string[], why: string) => {
        const compiled = compilePattern({ kind: "awkward", match }, AWKWARD);
        const oracle = all.filter((r) => matchesRecord(r, compiled)).map((r) => ids.get(r.id)!).sort();
        const got = (await space.query({ kind: "awkward", match }, 100)).map((r) => ids.get(r.id)!).sort();
        const pattern = JSON.stringify(match);
        assertEquals(got, oracle, `pre-filter and oracle disagree on ${pattern}: ${why}`);
        assertEquals(oracle, [...expected].sort(), `the oracle itself changed verdict on ${pattern}: ${why}`);
      };

      // An array element. The oracle indexes it; SQLite's `$.arr.0` is a KEY lookup and NULL over
      // an array; the `@>` term Postgres pushes asks whether the array contains {"0": "a"}. Both
      // dialects excluded this record before the segment stopped being pushed.
      await differential({ "arr.0": "a" }, ["array"], "an array index must not be pushed");
      // Leading zero: no such own property, so the oracle says no. Postgres' path parser reads
      // `00` as subscript 0 and would have matched — and marked the node exact, so a caller's
      // limit would ride along into SQL on a filter that over-includes.
      await differential({ "arr.00": "a" }, [], "a leading-zero subscript is not a property");
      // `length` is on the prototype, not in the document. The oracle used to resolve it to 2 and
      // SQL saw nothing, so the record vanished from the answer instead of being rejected.
      await differential({ "arr.length": 2 }, [], "an array length is not stored data");
      await differential({ "arr.length": { $exists: true } }, [], "nor does it exist");
      await differential({ "obj.toString": { $exists: true } }, ["proto-named-keys"], "nor does a method");
      // The other half of that rule: a document that really carries those names is ordinary data
      // and must still route.
      await differential({ "obj.constructor": "c" }, ["proto-named-keys"], "a real key of that name routes");
      // Digit segments over an object, where the disagreement is SQLite-only, and mid-path.
      await differential({ "m.0": "a" }, ["digit-keys"], "a digit KEY is still a key");
      await differential({ "m.00": "z" }, ["digit-keys"], "a leading-zero key likewise");
      await differential({ "deep.0.k": "v" }, ["nested-index"], "a digit segment mid-path");
      await differential({ label: { $exists: true } }, CORPUS.map((b) => b.label as string), "the control path");
    },
  },
  {
    name: "an unpushable digit segment does not carry the caller's limit into SQL",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind(AWKWARD);
      // Non-matching records first, so they own the low ids and a pushed limit would return only
      // misses. `arr.0` is exactly the shape that used to render as an exact filter matching
      // nothing at all, which is worse: `take` reported an empty space holding ten records.
      for (let i = 0; i < 50; i++) await space.put({ kind: "awkward", body: { label: "miss", arr: ["miss"] } });
      const hits: string[] = [];
      for (let i = 0; i < 10; i++) {
        hits.push((await space.put({ kind: "awkward", body: { label: "hit", arr: ["hit"] } })).id);
      }
      const byId = [...hits].sort();

      const page = await space.query({ kind: "awkward", match: { "arr.0": "hit" } }, 5);
      assertEquals(page.map((r) => r.id), byId.slice(0, 5), "a limited query looks past the miss prefix");
      assertEquals((await space.readOne({ kind: "awkward", match: { "arr.0": "hit" } }))?.id, byId[0]);

      const claimed = await space.take({ pattern: { kind: "awkward", match: { "arr.0": "hit" } } }, {
        leaseSeconds: 60,
      });
      assert(claimed, "and a claim on an array-index pattern finds work rather than an empty space");
      assert(hits.includes(claimed!.record.id), "the claimed record is one of the matches");
    },
  },
  {
    name: "an empty $or matches nothing instead of rendering a SQL syntax error",
    run: async (adapter) => {
      // `{"$or": []}` is well formed and reachable from the wire (a caller building the array from
      // an empty list sends it), and it rendered as `()` — `near ")": syntax error`, a 500. The
      // oracle was always right (`[].some()` is false), so the renderer follows it: matches
      // nothing. `$and: []` is the same identity read the other way and matches everything.
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "doc", body: { s: "x" } });

      await finds(space, { $or: [] }, [], "an empty disjunction matches nothing");
      await finds(space, { $and: [] }, [id], "an empty conjunction matches everything");
      await finds(space, { s: "x", $or: [] }, [], "and it still matches nothing beside a predicate");
      await finds(space, { $or: [{ s: "x" }, { $or: [] }] }, [id], "nested, the live branch still matches");
    },
  },
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
      // jsonb would call them equal, so pushing an object literal into jsonb `=` would
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
      await finds(space, { arr: { $any: "b" } }, [id], "$any finds an element");
      await finds(space, { arr: { $each: { $in: ["a", "b"] } } }, [id], "$each is left to the oracle, not dropped");
    },
  },
  {
    // `$any` is pushed (see `pushdown.ts`), and every case here is one where a plausible SQL
    // rendering EXCLUDES a record the oracle accepts, or admits one it rejects while claiming to be
    // exact. Measured motive: an unpushed `$any` scanned the whole kind into JS, 14s at 1M records
    // (`bench/deployment.ts`).
    name: "$any matches the oracle on the shapes SQL gets wrong",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const put = async (body: Record<string, unknown>) => (await space.put({ kind: "doc", body })).id;
      const strings = await put({ arr: ["a", "b"] });
      const numbers = await put({ arr: [1, 2] });
      const bools = await put({ arr: [true] });
      const nulls = await put({ arr: [null] });
      const empty = await put({ arr: [] });
      const nested = await put({ arr: [["a"]] });
      await put({ arr: "a" }); // a scalar at the path, NOT an array
      await put({ arr: { "0": "a" } }); // nor is an object whose keys look like indexes
      const objects = await put({ arr: [{ a: 1 }] });

      await finds(space, { arr: { $any: "a" } }, [strings], "a string element");
      await finds(space, { arr: { $any: 1 } }, [numbers], "a number element");
      // The distinction SQL erases: SQLite extracts JSON `true` and the number 1 both as 1, so a
      // rendering without a type guard answers `{arr:[true]}` to `$any: 1`. The scalar `"a"` and the
      // nested `["a"]` are the mirror image: `json_each` over a scalar yields it as one row, and
      // jsonb `@>` calls both of them a match, so neither the guard nor the exact test is optional.
      await finds(space, { arr: { $any: true } }, [bools], "a boolean element, not the number 1");
      await finds(space, { arr: { $any: null } }, [nulls], "a null element; `[null]` HAS an element");
      await finds(space, { arr: { $any: ["a"] } }, [nested], "a nested array matches as itself, not by its contents");
      await finds(space, { arr: { $any: "zz" } }, [], "no element, no record; and the empty array has none");

      // An element predicate over a structure is deep equality, so it stays with the oracle.
      await finds(space, { arr: { $any: { $in: [{ a: 1 }] } } }, [objects], "a structural element still matches");

      // Ordered comparisons over elements, where the type guard is again what SQL loses.
      await finds(space, { arr: { $any: { $gt: 1 } } }, [numbers], "some element > 1");
      await finds(space, { arr: { $any: { $gte: 1 } } }, [numbers], "…and >= includes the boundary");
      await finds(space, { arr: { $any: { $gt: 0 } } }, [numbers], "a boolean element is not a number 1 > 0");
      await finds(space, { arr: { $any: { $lt: "b" } } }, [strings], "some element < 'b'");
      await finds(space, { arr: { $any: { $in: ["b", 2] } } }, [strings, numbers], "$in commutes with $any");

      // Why `$each` is NOT pushed alongside `$any` (`pushdown.ts` header): the empty array satisfies
      // every element predicate and no element test. Rendering `$each` as its `$any` twin is the
      // shortcut that looks right on every corpus that happens to hold no empty array.
      await finds(space, { arr: { $each: "zz" } }, [empty], "$each over an empty array is vacuously true");
      await finds(space, { arr: { $each: { $gt: 0 } } }, [empty, numbers], "…and it does not exclude real matches");
    },
  },
  {
    // The case above only proves the pre-filter does not UNDER-return. `$any` also claims to be
    // exact, which sends the caller's LIMIT into SQL, and there an over-returning filter is just as
    // wrong: the decoys fill the page and the oracle rejects all of them, so a space holding ten
    // matches answers with none. Every decoy shape here is one a dialect calls a match on its own
    // (`json_each` over a scalar yields the scalar; jsonb `@>` descends into a nested array; both
    // read JSON `true` as 1 without a type guard), and they own the low ids so a lost guard shows up
    // as an empty page rather than a reordering.
    name: "$any's pushed limit does not fill the page with what the oracle rejects",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const decoys = [{ arr: "hit" }, { arr: [["hit"]] }, { arr: [true] }, { arr: ["miss"] }];
      for (let i = 0; i < 50; i++) await space.put({ kind: "doc", body: decoys[i % decoys.length] });
      const hits: string[] = [];
      const numbers: string[] = [];
      for (let i = 0; i < 10; i++) hits.push((await space.put({ kind: "doc", body: { arr: ["hit"] } })).id);
      for (let i = 0; i < 10; i++) numbers.push((await space.put({ kind: "doc", body: { arr: [1] } })).id);

      const page = async (match: Record<string, unknown>) =>
        (await space.query({ kind: "doc", match }, 5)).map((r) => r.id);
      assertEquals(await page({ arr: { $any: "hit" } }), [...hits].sort().slice(0, 5), "a full page of real matches");
      assertEquals(await page({ arr: { $any: 1 } }), [...numbers].sort().slice(0, 5), "…and `true` is not the number 1");
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
      // second branch's rows. An $or is only pushable when EVERY branch is.
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

      // Segments outside [A-Za-z0-9_] are declined by `pushablePath`. Inlining them into a path
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

      // `$each` is not pushable, so the pre-filter is `TRUE`. Pushing the caller's limit into SQL
      // would return the ten lowest ids (all misses), and the oracle would reject every one,
      // answering "no matches" for a space holding ten. The limit only moves into SQL when the
      // filter is exact.
      //
      // This case used `$any` until `$any` became pushable, at which point it still passed while
      // testing nothing: an exact filter returns the right five whether or not the limit rode into
      // SQL. A test whose vehicle stops being an example of the thing it tests goes quiet rather
      // than red, so the vehicle has to be the remaining inexact quantifier.
      // Sort rather than trusting insertion order: ULIDs minted inside one millisecond differ
      // only in their random half, so "the order they were put" is not "the order they sort".
      const byId = [...hits].sort();
      const inexact = { arr: { $each: "hit" } };
      const got = await space.query({ kind: "doc", match: inexact }, 5);
      assertEquals(got.length, 5, "a limited query over an inexact filter still returns full pages");
      assertEquals(got.map((r) => r.id), byId.slice(0, 5), "and returns the right records, in id order");

      const one = await space.readOne({ kind: "doc", match: inexact });
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
      // `order by id` reproduces, so a limited query is the first N matches by id. Sorted, not
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

      const claimed = await space.take({ pattern: { kind: "doc", match: { s: "rare" } } }, { leaseSeconds: 60 });
      assert(claimed, "the one matching record must be claimed");
      assertEquals(claimed!.record.id, needle);
      // And a claim whose filter matches nothing is empty, not an arbitrary record of the kind.
      assertEquals(
        await space.take({ pattern: { kind: "doc", match: { s: "absent" } } }, { leaseSeconds: 60 }),
        null,
      );
    },
  },
];
