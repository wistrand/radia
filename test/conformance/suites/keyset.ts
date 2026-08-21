// Keyset pagination: a cursor over record id, in either direction.
//
// The point of a keyset over an offset is that it stays correct while the space is being WRITTEN
// to. An offset counts rows, so anything inserted before the cursor shifts every later page. The
// suite therefore checks the interesting case explicitly: paging while records arrive.
//
// The other reason it exists is that without `dir: "desc"` there is no way to ask for the newest
// records at all. The deterministic tie-break is ascending id, so a plain limited query is always
// the OLDEST page.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../../src/core/space.ts";
import type { RadiaError } from "../../../src/core/errors.ts";

function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "note",
    indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }],
    sortablePaths: ["n"],
    claimable: false,
  });
  return space;
}

/** Put `count` notes; returns their ids in ASCENDING id order (which is not always put order,
 *  since ULIDs minted inside one millisecond differ only in their random half). */
async function seed(space: Space, count: number, tag = "t"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await space.put({ kind: "note", body: { n: i, tag } })).id);
  return [...ids].sort();
}

export const keysetSuites: Suite[] = [
  {
    name: "a cursor walks the whole kind in order, without repeats or gaps",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const ids = await seed(space, 25);

      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await space.query({ kind: "note" }, 7, { after });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        after = page[page.length - 1].id;
      }
      assertEquals(seen, ids, "every record exactly once, in ascending id order");
    },
  },
  {
    name: "dir:desc walks newest-first, the thing a plain limited query cannot express",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const ids = await seed(space, 12);
      const newest = [...ids].reverse();

      assertEquals(
        (await space.query({ kind: "note" }, 4, { dir: "desc" })).map((r) => r.id),
        newest.slice(0, 4),
        "the highest ids, not the lowest",
      );
      // …and without it, the same limit gives the opposite end. This is the asymmetry that made
      // "find the most recent artifact" quietly return the oldest one.
      assertEquals(
        (await space.query({ kind: "note" }, 4)).map((r) => r.id),
        ids.slice(0, 4),
        "no dir means ascending, i.e. the OLDEST page",
      );
    },
  },
  {
    name: "a descending cursor pages backwards to the start",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const ids = await seed(space, 15);

      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await space.query({ kind: "note" }, 6, { after, dir: "desc" });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        after = page[page.length - 1].id;
      }
      assertEquals(seen, [...ids].reverse(), "every record exactly once, newest first");
    },
  },
  {
    name: "a page stays stable while records are being written (the reason it is not an offset)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const first = await seed(space, 10);

      const page1 = await space.query({ kind: "note" }, 4);
      assertEquals(page1.map((r) => r.id), first.slice(0, 4));

      // Ten more records land between the two page reads. With an OFFSET, page 2 would skip or
      // repeat depending on where they sorted; with a cursor, the next page continues exactly
      // where the last one stopped.
      await seed(space, 10, "later");

      const page2 = await space.query({ kind: "note" }, 4, { after: page1[page1.length - 1].id });
      assert(page2.every((r) => r.id > page1[page1.length - 1].id), "no record before the cursor comes back");
      assertEquals(
        page2.map((r) => r.id),
        [...new Set([...first, ...(await space.query({ kind: "note" }, 100)).map((r) => r.id)])]
          .sort()
          .filter((id) => id > page1[page1.length - 1].id)
          .slice(0, 4),
        "the next four ids after the cursor, whatever arrived in between",
      );
    },
  },
  {
    name: "the cursor composes with a match, and pages only what matches",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wanted: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { id } = await space.put({ kind: "note", body: { n: i, tag: i % 2 === 0 ? "even" : "odd" } });
        if (i % 2 === 0) wanted.push(id);
      }
      wanted.sort();

      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await space.query({ kind: "note", match: { tag: "even" } }, 3, { after });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        after = page[page.length - 1].id;
      }
      assertEquals(seen, wanted, "only the matching records, each once");
    },
  },
  {
    name: "a cursor with order_by is refused, not silently resolved one way",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await seed(space, 3);
      // Sorting by a body field and paging by id are two different orders; honouring one would
      // silently ignore the other. Sorting WITHOUT a cursor still works.
      for (const page of [{ after: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }, { dir: "desc" as const }]) {
        let code = "";
        try {
          await space.query({ kind: "note", orderBy: [{ path: "n" }] }, 5, page);
        } catch (e) {
          code = (e as RadiaError).code;
        }
        assertEquals(code, "invalid_pattern", `order_by + ${JSON.stringify(page)} must be rejected`);
      }
      assertEquals((await space.query({ kind: "note", orderBy: [{ path: "n" }] }, 5)).length, 3);
    },
  },
  {
    name: "a cursor past the end is empty, not an error",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const ids = await seed(space, 3);
      assertEquals(await space.query({ kind: "note" }, 10, { after: ids[ids.length - 1] }), []);
      assertEquals(await space.query({ kind: "note" }, 10, { after: ids[0], dir: "desc" }), []);
    },
  },
];
