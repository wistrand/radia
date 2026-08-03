// Phase 2 conformance: per-kind indexing contract and pattern validation. Registration
// rejects bad declarations; pattern compilation rejects predicates on undeclared paths
// and order_by on non-sortable paths. Runs on every adapter (validation is in core, but
// running on both proves the Space wiring is adapter-independent).

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import { RadiaError } from "../../src/core/errors.ts";

function expectError(fn: () => unknown, code: string): void {
  let got: string | undefined;
  try {
    fn();
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  assertEquals(got, code);
}

export const kindSuites: Suite[] = [
  {
    name: "registration rejects invalid declarations",
    run: (adapter) => {
      const space = new Space(adapter);
      expectError(() => space.registerKind({ kind: "", indexedPaths: [] }), "invalid_kind");
      expectError(
        () => space.registerKind({ kind: "k", indexedPaths: [{ path: "a.", type: "keyword" }] }),
        "invalid_path",
      );
      expectError(
        () =>
          space.registerKind({
            kind: "k",
            // deno-lint-ignore no-explicit-any
            indexedPaths: [{ path: "a", type: "money" as any }],
          }),
        "invalid_type",
      );
      expectError(
        () =>
          space.registerKind({
            kind: "k",
            indexedPaths: [{ path: "a", type: "keyword" }, { path: "a", type: "integer" }],
          }),
        "duplicate_path",
      );
      expectError(
        () =>
          space.registerKind({
            kind: "k",
            indexedPaths: [{ path: "a", type: "keyword" }],
            sortablePaths: ["b"],
          }),
        "unsortable_path",
      );
      return Promise.resolve();
    },
  },
  {
    name: "kind declarations persist and reload (loadKinds round-trip)",
    run: async (adapter) => {
      const def = { kind: "task", indexedPaths: [{ path: "tag", type: "keyword" as const }] };
      const space = new Space(adapter);
      space.registerKind(def);
      await space.persistKind(def);

      // A fresh Space over the same adapter starts with an empty in-memory registry, and recovers
      // the declaration ON DEMAND. This assertion used to be the opposite — `unknown_kind` until
      // `loadKinds()` ran — which was the multi-instance gap written down as expected behaviour: an
      // instance that had not restarted since another declared a kind could not read it.
      const onDemand = new Space(adapter);
      assertEquals(await onDemand.readOne({ kind: "task", match: { tag: "x" } }), null);

      // `loadKinds()` is still the STARTUP read, and still the right one: "every declared kind" is a
      // population, so it pages to exhaustion rather than fetching one row at a time as queries
      // happen to arrive. The on-demand path closes the gap between startups; it does not replace it.
      const reloaded = new Space(adapter);
      await reloaded.loadKinds();
      assertEquals(await reloaded.readOne({ kind: "task", match: { tag: "x" } }), null);
    },
  },
  {
    name: "a predicate on an undeclared path is a registration error",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });

      // declared path is fine
      assertEquals(await space.readOne({ kind: "task", match: { tag: "x" } }), null);

      // undeclared path rejected
      let code: string | undefined;
      try {
        await space.readOne({ kind: "task", match: { nope: "x" } });
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      assertEquals(code, "undeclared_path");
    },
  },
  {
    name: "predicates on an unregistered kind, and order_by on a non-sortable path, are rejected",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "task",
        indexedPaths: [{ path: "tag", type: "keyword" }],
        // note: tag not declared sortable
      });

      // kind-only pattern on an unregistered kind is allowed (no path lookup)
      assertEquals(await space.readOne({ kind: "ghost", match: {} }), null);

      // predicate on an unregistered kind is rejected
      let unknown: string | undefined;
      try {
        await space.readOne({ kind: "ghost", match: { a: 1 } });
      } catch (e) {
        unknown = (e as { code?: string }).code;
      }
      assertEquals(unknown, "unknown_kind");

      // order_by on a non-sortable declared path is rejected
      let unsortable: string | undefined;
      try {
        await space.readOne({ kind: "task", orderBy: [{ path: "tag" }] });
      } catch (e) {
        unsortable = (e as { code?: string }).code;
      }
      assertEquals(unsortable, "unsortable_path");
    },
  },
  {
    name: "forbidden and deferred operators are rejected at compile",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "n", type: "integer" }] });

      const cases: [unknown, string][] = [
        [{ $regex: "x" }, "operator_forbidden"],
        [{ $where: "1" }, "operator_forbidden"],
        [{ $ne: 1 }, "operator_deferred"],
        [{ $prefix: "a" }, "operator_deferred"],
        [{ $bogus: 1 }, "unknown_operator"],
      ];
      for (const [spec, code] of cases) {
        let got: string | undefined;
        try {
          await space.readOne({ kind: "task", match: { n: spec } });
        } catch (e) {
          got = (e as { code?: string }).code;
        }
        assertEquals(got, code, `expected ${code} for ${JSON.stringify(spec)}`);
      }
    },
  },
  {
    name: "a second instance adopts a kind declared, and redeclared, through the first",
    run: async (adapter) => {
      // TWO Space objects over ONE adapter: the multi-instance deployment, in a test. Nothing is
      // shared between them but the database, which is the whole architecture.
      const a = new Space(adapter);
      const b = new Space(adapter);

      await a.persistKind({
        kind: "ticket",
        indexedPaths: [{ path: "status", type: "keyword" }],
        claimable: true,
      });

      // `put` registers a declaration in the WRITING process's registry only, so B has never heard
      // of `ticket`. Its write path is fine — one GIN index serves every path, so the record is
      // indexed and matchable — and it was only READS that failed, which is why this is a
      // correctness gap and not a freshness one.
      const wrote = await b.put({ kind: "ticket", body: { status: "open", who: "b" } });
      assert(wrote.id, "an instance can write a kind it has not heard of");

      // The read path recovers by re-reading the one declaration rather than failing.
      const found = await b.readOne({ kind: "ticket", match: { status: "open" } });
      assert(found, "instance B must find the record it just wrote");
      assertEquals((found!.body as { who: string }).who, "b");
      // …and by then it is registered, so the next call costs nothing extra.
      assertEquals((await b.query({ kind: "ticket", match: { status: "open" } }, 10)).length, 1);

      // REDECLARATION is the half a refresh-on-miss would have missed: B already holds a
      // declaration, so nothing is "missing" — it is just older than A's, and a query naming the
      // new path fails against the old contract. Driving the refresh from the ERROR covers both.
      await a.persistKind({
        kind: "ticket",
        indexedPaths: [{ path: "status", type: "keyword" }, { path: "priority", type: "integer" }],
        claimable: true,
      });
      await b.put({ kind: "ticket", body: { status: "open", priority: 3, who: "b2" } });
      const byNewPath = await b.query({ kind: "ticket", match: { priority: 3 } }, 10);
      assertEquals(byNewPath.length, 1, "a path added by another instance must become queryable here");
      assertEquals((byNewPath[0].body as { who: string }).who, "b2");

      // A genuinely undeclared kind still FAILS, and fails as a client error rather than looping:
      // the refresh happens once, finds nothing, and the original error stands.
      await assertRejects(
        () => b.readOne({ kind: "no-such-kind", match: { x: 1 } }),
        RadiaError,
      );
      // …as does a genuinely undeclared PATH on a kind that does exist.
      await assertRejects(
        () => b.query({ kind: "ticket", match: { nope: 1 } }, 10),
        RadiaError,
      );
    },
  },
];
