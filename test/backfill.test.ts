// The one migration path in the schema: rebuilding `record_edges` for a database written before
// that table existed.
//
// This lives outside the adapter-parameterized conformance run because it has to simulate an OLD
// database, and there is no port operation for "forget the derived index", nor should there be.
// So each dialect is driven through its own raw SQL seam, which is exactly as much adapter
// knowledge as the test needs and none of it leaks into `StorageAdapter`.
//
// It was previously verified by hand and never in CI, on the argument that a harness database is
// always created fresh by the current schema. True, and beside the point: emptying the table and
// reopening reproduces the starting condition the backfill exists for. Worth guarding because the
// failure is SILENT. A lost edge makes `childrenOf` answer "no children", which reads as an empty
// result rather than an error, and following relationships DOWN quietly stops working for every
// record written before the upgrade.
//
// Note these are PERSISTENT databases, not `:memory:`/ephemeral ones. The restart is the whole
// point, and an in-memory database does not survive one. The first draft of this test "passed a
// restart" by opening an empty database and finding, unsurprisingly, no duplicate edges in it.

import { assert, assertEquals } from "@std/assert";
import { Space } from "../src/core/space.ts";
import type { StorageAdapter } from "../src/storage/adapter.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { PgliteAdapter } from "../src/storage/pglite.ts";

interface Dialect {
  name: string;
  /** A fresh location on disk that survives close/open. */
  location: () => string;
  open: (at: string) => StorageAdapter;
  /** Delete every derived edge, leaving `parent_ids` (the source of truth) untouched: i.e. what a
   *  database written by a build without the edge table looks like. */
  wipe: (adapter: StorageAdapter) => Promise<void>;
}

const dialects: Dialect[] = [
  {
    name: "sqlite",
    location: () => `${Deno.makeTempDirSync({ prefix: "radia-backfill-" })}/space.db`,
    open: (at) => new SqliteAdapter(at),
    // deno-lint-ignore no-explicit-any
    wipe: (a) => Promise.resolve((a as any).db.exec("delete from record_edges")),
  },
  {
    name: "pglite",
    location: () => Deno.makeTempDirSync({ prefix: "radia-backfill-pg-" }),
    open: (at) => new PgliteAdapter(at),
    // deno-lint-ignore no-explicit-any
    wipe: async (a) => await (a as any).sql.exec("delete from record_edges"),
  },
];

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

for (const d of dialects) {
  Deno.test(`backfill [${d.name}]: a database with no edges rebuilds them from parent_ids on startup`, async () => {
    const at = d.location();
    let adapter = d.open(at);
    await adapter.init();
    let root = "";
    let kids: string[] = [];
    let merged = "";
    try {
      const space = newSpace(adapter);
      root = (await space.put({ kind: "task", body: { tag: "root" } })).id;
      for (let i = 0; i < 3; i++) {
        kids.push((await space.put({ kind: "task", body: { tag: `k${i}` }, parentIds: [root] })).id);
      }
      // A record with two parents, so the rebuild is checked to produce one edge PER PARENT rather
      // than one per record. That is the shape a naive rebuild gets wrong.
      merged = (await space.put({ kind: "task", body: { tag: "merged" }, parentIds: [kids[0], kids[1]] })).id;
      kids = [...kids].sort();

      assertEquals((await space.getChildren(root, 50)).map((r) => r.id).sort(), kids);

      await d.wipe(adapter);
      assertEquals(
        await space.getChildren(root, 50),
        [],
        "the wipe really did remove the index; otherwise the rebuild below proves nothing",
      );
    } finally {
      await adapter.close();
    }

    // Restart against the SAME database, as an upgraded build would.
    adapter = d.open(at);
    await adapter.init();
    try {
      const space = newSpace(adapter);
      assertEquals(
        (await space.getChildren(root, 50)).map((r) => r.id).sort(),
        kids,
        "every child is reachable again, rebuilt from parent_ids",
      );
      assertEquals((await space.getChildren(kids[0], 50)).map((r) => r.id), [merged]);
      assertEquals((await space.getChildren(kids[1], 50)).map((r) => r.id), [merged], "both parents of a merge");
    } finally {
      await adapter.close();
    }
  });

  Deno.test(`backfill [${d.name}]: later startups neither duplicate edges nor lose new ones`, async () => {
    const at = d.location();
    let adapter = d.open(at);
    await adapter.init();
    const space0 = newSpace(adapter);
    const { id: root } = await space0.put({ kind: "task", body: { tag: "root" } });
    const { id: kid } = await space0.put({ kind: "task", body: { tag: "kid" }, parentIds: [root] });
    await adapter.close();

    // The guard is `where not exists (select 1 from record_edges)`: with edges present the insert
    // reads nothing, which is what keeps this free on every startup after the first.
    for (let boot = 0; boot < 3; boot++) {
      adapter = d.open(at);
      await adapter.init();
      if (boot < 2) await adapter.close();
    }

    try {
      const space = newSpace(adapter);
      assertEquals((await space.getChildren(root, 50)).map((r) => r.id), [kid], "one child, not one per boot");

      // And a record written AFTER the re-inits still gets its edge from the normal write path.
      // The backfill must not be the only thing maintaining the table.
      const { id: later } = await space.put({ kind: "task", body: { tag: "later" }, parentIds: [root] });
      const children = (await space.getChildren(root, 50)).map((r) => r.id);
      assertEquals(children.length, 2);
      assert(children.includes(later));
    } finally {
      await adapter.close();
    }
  });
}

// A row claimed before `lease_owner` existed has none. The adapters' owner check compared only when
// an owner was stored, so on such a row anyone holding the lease id and epoch settled as the owner
// (2026-09-05). No write path leaves the column empty today, so the row is planted by SQL.
for (const d of dialects) {
  Deno.test(`backfill [${d.name}]: a lease with NO stored owner refuses every other principal's settle`, async () => {
    const adapter = d.open(d.location());
    await adapter.init();
    try {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "legacy" } });
      const claimed = await space.take({ pattern: { kind: "task" } }, { owner: "run:a" });
      assert(claimed);
      const sql = `update record_runtime set lease_owner = null where record_id = '${claimed!.record.id}'`;
      // deno-lint-ignore no-explicit-any
      const a = adapter as any;
      if (a.db) a.db.exec(sql);
      else await a.sql.exec(sql);
      assertEquals((await space.getEnvelope(claimed!.record.id))!.leaseOwner ?? null, null, "the owner is gone");
      // fail CLOSED: a principal presenting the lease is fenced out, whoever it is
      assertEquals((await space.ack(claimed!.lease, undefined, undefined, "run:b")).status, "lease_lost");
      assertEquals((await space.ack(claimed!.lease, undefined, undefined, "run:a")).status, "lease_lost");
      assertEquals((await space.getEnvelope(claimed!.record.id))!.state, "leased");
      // the runtime's own raw verb names no owner and may still settle it (remediation's path)
      assertEquals((await space.ack(claimed!.lease)).status, "ok");
    } finally {
      await adapter.close();
    }
  });
}
