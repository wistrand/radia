// Phase 2 conformance: per-kind indexing contract and pattern validation. Registration
// rejects bad declarations; pattern compilation rejects predicates on undeclared paths
// and order_by on non-sortable paths. Runs on every adapter (validation is in core, but
// running on both proves the Space wiring is adapter-independent).

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../../src/core/space.ts";
import { buildRecord } from "../../../src/core/record.ts";
import { RadiaError } from "../../../src/core/errors.ts";
import { rawExec } from "./integrity.ts";

function expectError(fn: () => unknown, code: string): void {
  let got: string | undefined;
  try {
    fn();
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  assertEquals(got, code);
}

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

/** The `grant` declaration the runtime compiles `authorize` against, minus `principal`. */
const SHRUNK_GRANT = {
  kind: "grant",
  indexedPaths: [{ path: "kind", type: "keyword" as const }],
  claimable: false,
};

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
      // `number` is a declarable type, and a NESTED path is declarable and sortable. Both are load
      // bearing for anything that records what an operation cost: a provider's `cost` is fractional
      // and lives under `usage`, and every honest declaration for it was missing before.
      space.registerKind({
        kind: "priced",
        indexedPaths: [{ path: "usage.cost", type: "number" }, { path: "usage.total_tokens", type: "integer" }],
        sortablePaths: ["usage.cost", "usage.total_tokens"],
      });
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
  {
    name: "a redeclaration cannot drop what a reserved kind's own machinery compiles against",
    run: async (adapter) => {
      const space = new Space(adapter);

      // The vector is an ORDINARY grant, not an operator. `kind_def` is deliberately not
      // write-protected (an app declares its own kinds), so `put: kind_def` is a grant a worker
      // legitimately holds, and it used to be enough to drop `grant.principal`, after which every
      // authorization in the space failed `undeclared_path`, fail-closed but space-wide.
      await space.createAgentDefinition("agent:dev", [
        { principal: "agent:dev", kind: "kind_def", operations: ["put"] },
      ]);
      assertEquals(await space.authorize("agent:dev", "put", "kind_def"), null, "declaring kinds stays an ordinary grant");

      // Refused as a DECLARATION, so which principal wrote it never enters into it.
      assertEquals(
        await errorCode(() => space.put({ kind: "kind_def", body: SHRUNK_GRANT }, undefined, "agent:dev")),
        "reserved_kind",
      );
      assertEquals(await errorCode(() => space.persistKind(SHRUNK_GRANT)), "reserved_kind", "…including for an operator");

      // Nor may it be flipped to claimable: authorization state must not become work.
      assertEquals(
        await errorCode(() =>
          space.persistKind({
            kind: "grant",
            indexedPaths: [{ path: "principal", type: "keyword" }, { path: "kind", type: "keyword" }],
            claimable: true,
          })
        ),
        "reserved_kind",
      );

      // EXTENSION stays legal. The rule is about shrinking, not about redeclaring: an app adding an
      // index to a reserved kind is an ordinary thing to want, and nothing here should stop it.
      await space.persistKind({
        kind: "grant",
        indexedPaths: [
          { path: "principal", type: "keyword" },
          { path: "kind", type: "keyword" },
          { path: "note", type: "keyword" },
        ],
        claimable: false,
      });
      assertEquals(await space.authorize("agent:dev", "put", "kind_def"), null, "authorization survives the extension");
      assertEquals(await space.readOne({ kind: "grant", match: { note: "x" } }), null, "…and the new path is queryable");
    },
  },
  {
    name: "an ack result declaring a kind is validated and adopted exactly like a put",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await space.put({ kind: "task", body: { tag: "a" } });
      const claim = await space.take({ pattern: { kind: "task" } });
      assert(claim, "expected a claim");

      // `ack` is the second way a record enters the space and it grew after `put` learned this
      // rule, so it skipped every kind_def check: an emitted result could declare what a `put` of
      // the identical body is refused for.
      assertEquals(
        await errorCode(() => space.ack(claim.lease, { kind: "kind_def", body: SHRUNK_GRANT })),
        "reserved_kind",
      );
      assertEquals(
        await errorCode(() => space.ack(claim.lease, { kind: "kind_def", body: { kind: "", indexedPaths: [] } })),
        "invalid_kind",
        "an invalid declaration is refused through ack too",
      );
      // Refused BEFORE anything is consumed: the lease is intact and the task is still leased.
      assertEquals((await space.ack(claim.lease, { kind: "kind_def", body: { kind: "ticket", indexedPaths: [{ path: "status", type: "keyword" }] } })).status, "ok");

      // …and a valid one is ADOPTED, not merely stored: the declaring process can use the kind on
      // the next line, which is the whole reason `put` registers after commit.
      assertEquals(await space.readOne({ kind: "ticket", match: { status: "open" } }), null);
      const reloaded = new Space(adapter);
      await reloaded.loadKinds();
      assertEquals(await reloaded.readOne({ kind: "ticket", match: { status: "open" } }), null, "and it survives a restart");
    },
  },
  {
    name: "a reserved-incompatible declaration already in the log is not adopted at startup",
    run: async (adapter) => {
      // The damage persisted across restarts, which is the part a write-path check alone does not
      // undo: `loadKinds` cast the stored body straight into the registry, so a declaration written
      // before this rule existed would reinstate itself on every boot. Planted through the adapter
      // because no write path will accept it any more.
      const seeded = new Space(adapter);
      seeded.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await seeded.createAgentDefinition("agent:dev", [
        { principal: "agent:dev", kind: "task", operations: ["put"] },
      ]);

      const now = await adapter.now();
      const { record, bodyJson } = await buildRecord({ kind: "kind_def", body: SHRUNK_GRANT }, {
        principal: "agent:dev",
        schemaVersion: 1,
        maxRecordBytes: 1 << 20,
        now,
      });
      await adapter.put({
        record,
        bodyJson,
        envelope: { kind: record.kind, availableAt: now, claimUntil: undefined, deadlineAt: undefined, effectivePriority: 0 },
      });

      const restarted = new Space(adapter);
      restarted.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await restarted.loadKinds();
      // Still the code-defined contract, so the grant lookup still compiles and still answers.
      assertEquals(await restarted.authorize("agent:dev", "put", "task"), null, "a granted principal still authorizes");
    },
  },
  {
    name: "an unknown kind_def field is refused on WRITE and still loads from the LOG",
    run: async (adapter) => {
      // Both halves matter and they pull opposite ways.
      //
      // WRITE: `contentKey` is optional and absence means "not a registry", so a misspelling costs
      // the kind its compaction with nothing to see. That is the whole subject of
      // plan-registry-cost.md, reachable by a typo. Same for `sortablePaths`, and for
      // `{path, type, sortable: true}` one level down, where the declarer instead meets
      // `unsortable_path` at query time, far from the cause.
      //
      // LOAD: both readers of a stored declaration SKIP what their validator rejects and keep what
      // they have (`loadKinds` at startup, `refreshKind` on a stale projection), so making the
      // shared validator strict would turn a stored kind_def carrying an unknown field into an
      // UNLOADABLE KIND, and through `refreshKind` a kind declared on ANOTHER INSTANCE would never
      // register on this one. The check therefore lives on the write path only, and structurally:
      // both readers call `kindDefFromBody` directly and cannot reach `assertKnownKindDefFields`.
      const space = new Space(adapter);
      await assertRejects(
        () => space.put({ kind: "kind_def", body: { kind: "reg", indexedPaths: [{ path: "t", type: "keyword" }], contentKeys: ["t"] } }),
        RadiaError,
        "contentKeys",
        "a typo'd contentKey must not commit a kind that silently never compacts",
      );
      await assertRejects(
        () => space.put({ kind: "kind_def", body: { kind: "reg", indexedPaths: [{ path: "t", type: "number", sortable: true }] } }),
        RadiaError,
        "sortable",
        "sortability is declared once for the kind, and the wrong spelling must say so here",
      );
      // The real declaration, with every optional field, still writes; so does a retirement.
      await space.put({
        kind: "kind_def",
        body: {
          kind: "reg",
          indexedPaths: [{ path: "t", type: "keyword" }],
          sortablePaths: [],
          contentKey: ["t"],
          claimable: false,
          defaultRetentionSeconds: 60,
        },
      });
      await space.put({ kind: "kind_def", body: { kind: "gone", indexedPaths: [], retired: true } });

      // Now the load half. A declaration carrying a field this build does not know can only get
      // into the log from another build, so it is planted the way the gc suite plants states the
      // honest path cannot reach.
      await space.put({ kind: "kind_def", body: { kind: "legacy", indexedPaths: [{ path: "t", type: "keyword" }] } });
      await rawExec(
        adapter,
        `update records set body_json = ? where kind = 'kind_def' and body_json like '%"legacy"%'`,
        [JSON.stringify({ kind: "legacy", indexedPaths: [{ path: "t", type: "keyword" }], futureField: 1 })],
      );
      const restarted = new Space(adapter);
      await restarted.loadKinds();
      assertEquals(
        (await restarted.query({ kind: "legacy", match: { t: "x" } }, 5)).length,
        0,
        "a stored declaration with an unknown field must still load, or its kind becomes unqueryable",
      );
    },
  },
];
