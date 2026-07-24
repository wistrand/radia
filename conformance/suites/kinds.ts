// Phase 2 conformance: per-kind indexing contract and template validation. Registration
// rejects bad declarations; template compilation rejects predicates on undeclared paths
// and order_by on non-sortable paths. Runs on every adapter (validation is in core, but
// running on both proves the Space wiring is adapter-independent).

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";

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

      // kind-only template on an unregistered kind is allowed (no path lookup)
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
];
