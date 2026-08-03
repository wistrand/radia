// Planner statistics for declared body paths (Postgres only).
//
// `StorageAdapter.prepareKind` is an OPTIONAL physical hint, so there is nothing to assert about
// it in the shared conformance run. SQLite implements none of it and must not be expected to.
// What is worth pinning is on the Postgres side and structural rather than timed: the statistics
// object is created for a declared path, declaring the same kind again does not accumulate
// objects, and a path that cannot be inlined into DDL is skipped rather than escaped.
//
// Deliberately NOT asserted here: the speedup. It is real and reproducible. A claim over 20k
// records goes 9.75ms → 3.37ms p50, and the plan changes from sorting 9,168 buffers to an ordered
// walk of `idx_runtime_claim_order` over 1,364. But a timing assertion in CI is a flake
// generator, and the plan text is a Postgres version detail. See gotchas.md, "a claim on Postgres
// is planned on a guess", for the measurements and the method to re-run them.

import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import { Space } from "../src/core/space.ts";
import { PgliteAdapter } from "../src/storage/pglite.ts";

async function statNames(adapter: PgliteAdapter): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const r = await (adapter as any).sql.query("select stxname from pg_statistic_ext order by stxname");
  return (r.rows as { stxname: string }[]).map((x) => x.stxname);
}

Deno.test("planner: declaring a kind creates statistics for its indexed paths, once", async () => {
  const adapter = new PgliteAdapter();
  await adapter.init();
  try {
    const space = new Space(adapter);
    assertEquals(await statNames(adapter), [], "nothing before any kind is declared");

    await space.persistKind({
      kind: "task",
      indexedPaths: [{ path: "tag", type: "keyword" }, { path: "score", type: "integer" }],
    });
    assertEquals(await statNames(adapter), ["radia_stat_score", "radia_stat_tag"]);

    // Every startup re-declares its kinds. The hint must be idempotent, or a long-lived space
    // accumulates DDL objects (and an ANALYZE) on every boot.
    for (let boot = 0; boot < 3; boot++) await space.loadKinds();
    assertEquals(await statNames(adapter), ["radia_stat_score", "radia_stat_tag"], "one per path, not one per boot");

    // A second kind sharing a path name shares the statistics object: the expression is over the
    // records table, which holds every kind, so the object is per PATH and not per kind.
    await space.persistKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }] });
    assertEquals(await statNames(adapter), ["radia_stat_score", "radia_stat_tag"]);
  } finally {
    await adapter.close();
  }
});

Deno.test("planner: a path that cannot be inlined into DDL is skipped, not escaped", async () => {
  const adapter = new PgliteAdapter();
  await adapter.init();
  try {
    // The path is INLINED into the statistics expression (as it is into pushdown's JSON path), so
    // the alphabet restriction is what makes inlining injection-proof. A path outside it simply
    // gets no statistics; it also cannot be pushed down, so there is nothing to estimate.
    await adapter.prepareKind("odd", ["with space", "quote'; drop table records; --", "", "a..b", "a-b"]);
    assertEquals(await statNames(adapter), [], "no object created for an unpushable path");

    // …and the table is still there, which is the point of the previous line.
    const space = new Space(adapter);
    space.registerKind({ kind: "task", indexedPaths: [] });
    const { id } = await space.put({ kind: "task", body: { ok: true } });
    assert(await space.getRecord(id));

    // A nested path IS pushable (dots separate segments) and gets an object named for the segments.
    await adapter.prepareKind("task", ["outer.inner"]);
    assertEquals(await statNames(adapter), ["radia_stat_outer_inner"]);
  } finally {
    await adapter.close();
  }
});

Deno.test("planner: statistics are per SCHEMA, so a second space on one server is not starved", async () => {
  // `pg_statistic_ext` is server-wide while a statistics object belongs to a schema. Asking it
  // only by NAME meant the first space to declare `tag` claimed the name for the whole server,
  // and every other space in its own schema silently ran on the planner's guess forever. Two
  // spaces on one server is the standalone Postgres deployment, and (since the conformance
  // harness shares one PGlite) also every run of this suite.
  const db = new PGlite();
  const one = new PgliteAdapter(undefined, { instance: db, schema: "plan_one", ephemeral: true });
  const two = new PgliteAdapter(undefined, { instance: db, schema: "plan_two", ephemeral: true });
  const declare = async (a: PgliteAdapter) => {
    await a.init();
    await new Space(a).persistKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  };
  try {
    await declare(one);
    await declare(two);
    const r = await db.query<{ nsp: string }>(
      "select stxnamespace::regnamespace::text as nsp from pg_statistic_ext where stxname = 'radia_stat_tag' order by 1",
    );
    assertEquals(r.rows.map((x) => x.nsp), ["plan_one", "plan_two"], "each schema gets its own object");
  } finally {
    await one.close();
    await two.close(); // ephemeral: the schemas go with them
    await db.close();
  }
});

Deno.test("planner: a failed hint never fails the kind declaration", async () => {
  const adapter = new PgliteAdapter();
  await adapter.init();
  try {
    const space = new Space(adapter);
    // Statistics are an optimization: a server too old for expression statistics, a read-only
    // role, or a concurrent creator must leave the declaration itself untouched.
    // deno-lint-ignore no-explicit-any
    (adapter as any).prepareKind = () => Promise.reject(new Error("no DDL for you"));
    await space.persistKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
    assert(space.listKinds().some((k) => k.kind === "task"), "the kind is declared regardless");

    const { id } = await space.put({ kind: "task", body: { tag: "x" } });
    const found = await space.query({ kind: "task", match: { tag: "x" } }, 10);
    assertEquals(found.map((r) => r.id), [id], "and queries on the path still work, just planned on a guess");
  } finally {
    await adapter.close();
  }
});
