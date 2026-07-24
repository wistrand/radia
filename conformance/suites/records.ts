// Phase 1 conformance: put + read_one, record immutability, body_sha256 integrity, the
// client-vs-runtime metadata split, and parent-must-exist. Each suite runs on every
// adapter (see harness.ts), so a behavior is only done when green on both.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import { sha256Hex } from "../../src/core/ids.ts";
import { handlePut } from "../../src/server/handlers/records.ts";

/** Register the kinds these suites match on (predicates require declared indexed paths). */
function newSpace(adapter: Parameters<Suite["run"]>[0]): Space {
  const space = new Space(adapter);
  space.registerKind({
    kind: "task",
    indexedPaths: [
      { path: "tag", type: "keyword" },
      { path: "seq", type: "integer" },
      { path: "n", type: "integer" },
    ],
    sortablePaths: ["seq"],
  });
  space.registerKind({ kind: "fact", indexedPaths: [{ path: "v", type: "integer" }] });
  return space;
}

export const recordSuites: Suite[] = [
  {
    name: "put returns an id; read_one returns the committed record",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { n: 1, tag: "alpha" } });
      assert(id.length > 0, "put returned empty id");

      const rec = await space.readOne({ kind: "task", match: { tag: "alpha" } });
      assert(rec, "read_one returned null");
      assertEquals(rec!.id, id);
      assertEquals(rec!.body, { n: 1, tag: "alpha" });
    },
  },
  {
    name: "read_one returns null when nothing matches",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "alpha" } });
      const miss = await space.readOne({ kind: "task", match: { tag: "nope" } });
      assertEquals(miss, null);
      const wrongKind = await space.readOne({ kind: "fact", match: {} });
      assertEquals(wrongKind, null);
    },
  },
  {
    name: "body_sha256 is present and correct over the stored body",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const body = { a: 1, b: ["x", "y"], c: { d: true } };
      await space.put({ kind: "task", body });
      const rec = await space.readOne({ kind: "task", match: {} });
      assert(rec);
      const expected = await sha256Hex(JSON.stringify(rec!.body));
      assertEquals(rec!.bodySha256, expected);
    },
  },
  {
    name: "server assigns authoritative metadata; client claims are preserved but not promoted",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({
        kind: "task",
        body: { tag: "meta" },
        clientMeta: { requested_priority: 99, confidence: 0.5 },
      });
      const rec = await space.readOne({ kind: "task", match: { tag: "meta" } });
      assert(rec);
      // authoritative, server-assigned
      assertEquals(rec!.runtimeMeta.createdBy, "local:dev");
      assertEquals(rec!.runtimeMeta.schemaVersion, 1);
      assertEquals(rec!.runtimeMeta.taint, false);
      assert(rec!.runtimeMeta.createdAt.length > 0, "createdAt not assigned");
      // client claims preserved as-is, not turned into authority
      assertEquals(rec!.clientMeta?.requested_priority, 99);
    },
  },
  {
    name: "client-supplied authoritative fields are ignored at the API boundary",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const req = new Request("http://x/v0/records", {
        method: "POST",
        body: JSON.stringify({
          kind: "task",
          body: { tag: "boundary" },
          createdBy: "attacker",
          schemaVersion: 999,
          taint: false,
          runtimeMeta: { createdBy: "attacker" },
        }),
      });
      const res = await handlePut(space, req, "human:local");
      assertEquals(res.status, 201);

      const rec = await space.readOne({ kind: "task", match: { tag: "boundary" } });
      assert(rec);
      assertEquals(rec!.runtimeMeta.createdBy, "local:dev"); // not "attacker"
      assertEquals(rec!.runtimeMeta.schemaVersion, 1); // not 999
    },
  },
  {
    name: "records are immutable: a second put creates a new id, the first is unchanged",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { seq: 1 } });
      const b = await space.put({ kind: "task", body: { seq: 2 } });
      assert(a.id !== b.id, "expected distinct ids");

      const first = await space.readOne({ kind: "task", match: { seq: 1 } });
      const second = await space.readOne({ kind: "task", match: { seq: 2 } });
      assertEquals(first?.id, a.id);
      assertEquals(second?.id, b.id);
      assertEquals(first?.body, { seq: 1 }); // untouched by the second put
    },
  },
  {
    name: "parent_ids must all exist at commit",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // a real parent is accepted
      const parent = await space.put({ kind: "fact", body: { v: 1 } });
      const child = await space.put({
        kind: "task",
        body: { tag: "child" },
        parentIds: [parent.id],
      });
      assert(child.id.length > 0);

      // a dangling parent is rejected
      let rejected = false;
      try {
        await space.put({
          kind: "task",
          body: { tag: "orphan" },
          parentIds: ["01BOGUSPARENTIDDOESNOTEXIST"],
        });
      } catch (e) {
        rejected = true;
        assertEquals((e as { code?: string }).code, "parent_not_found");
      }
      assert(rejected, "expected a dangling parent to be rejected");
    },
  },
];
