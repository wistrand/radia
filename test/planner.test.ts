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

Deno.test("planner: statistics are re-gathered as the space fills, amortized, and the read plan follows", async () => {
  // `prepareKind`'s ANALYZE runs at declaration, on an empty table. Postgres's autovacuum catches
  // up later; PGlite has none, so a `radia dev` space planned every read on empty-table statistics
  // for its whole life: a GIN bitmap over every match plus a sort, where the id index would stop at
  // the first row (8.7ms vs 0.47ms at 40k, 2026-09-05). The adapter now analyzes on a 10%-of-rows
  // rule with a 500-write floor. Pinned two ways: the COUNT of analyses over a fill (amortized,
  // never per write) and the plan the read gets afterwards.
  const adapter = new PgliteAdapter();
  await adapter.init();
  try {
    // deno-lint-ignore no-explicit-any
    const sql = (adapter as any).sql as { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
    const raw = sql.query.bind(sql);
    let analyzes = 0;
    sql.query = (q: string, p?: unknown[]) => {
      if (/^\s*analyze/i.test(q)) analyzes++;
      return raw(q, p);
    };
    const space = new Space(adapter);
    // Declared as a RECORD, the production path: that is what creates the expression statistics
    // the amortized ANALYZE refreshes. Without them the planner has no estimate for the path at
    // all and guesses one row, whatever the table holds.
    const def = { kind: "task", indexedPaths: [{ path: "op", type: "keyword" as const }], claimable: true };
    space.registerKind(def);
    await space.put({ kind: "kind_def", body: def });
    analyzes = 0; // the declaration's own analyze is not what this counts
    for (let i = 0; i < 1200; i++) await space.put({ kind: "task", body: { op: i % 7 === 0 ? "rare" : "common", n: i } });
    // 1200 inserts on a 500-write floor: at 500 and at 1000, two tables each. Not per write.
    assertEquals(analyzes, 4);
    const plan = (await raw(
      `explain select id from records where kind = $1 and (body_jsonb @> $2::jsonb and body_jsonb #> '{op}' = $3::jsonb) order by id collate "C" asc limit 1`,
      ["task", JSON.stringify({ op: "rare" }), JSON.stringify("rare")],
    )).rows.map((r) => String(r["QUERY PLAN"])).join("\n");
    assert(!/Bitmap/.test(plan), `the read still collects every match through the GIN index:\n${plan}`);
  } finally {
    await adapter.close();
  }
});
