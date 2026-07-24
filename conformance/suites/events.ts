// Phase 5 conformance: the transactional event log and lineage. Every successful
// state-changing op appends exactly one event, in the same transaction as its mutation;
// no-op outcomes (lease_lost, idempotency replay) append nothing. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

export const eventSuites: Suite[] = [
  {
    name: "each successful op appends one event, in seq order, with run identity",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ template: { kind: "task" } });
      assert(t);
      await space.ack(t!.lease, { kind: "result", body: { ok: true } });

      const ops = (await space.getEvents()).map((e) => e.operation);
      assertEquals(ops, ["put", "take", "ack"]); // one each, in order

      const events = await space.getEvents();
      for (const e of events) {
        assert(e.seq > 0 && e.id.length > 0 && e.ts.length > 0, "event missing seq/id/ts");
        assert(e.runId.length > 0, "event missing run identity");
      }
    },
  },
  {
    name: "no event without a mutation: lease_lost and idempotency replay append nothing",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ template: { kind: "task" } });
      assert(t);
      await space.ack(t!.lease, undefined, "ack-k"); // 3 events: put, take, ack

      const before = (await space.getEvents()).length;
      assertEquals(before, 3);

      // fenced ack (no mutation) -> no event
      const fenced = await space.ack(t!.lease);
      assertEquals(fenced.status, "lease_lost");
      // idempotency replay (no mutation) -> no event
      const replay = await space.ack(t!.lease, undefined, "ack-k");
      assertEquals(replay.status, "ok");

      assertEquals((await space.getEvents()).length, before);
    },
  },
  {
    name: "nack backoff and dead-letter are evented with the resulting state",
    run: async (adapter) => {
      const space = new Space(adapter, { maxAttempts: 1 });
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await space.put({ kind: "task", body: { tag: "a" } });

      const t1 = await space.take({ template: { kind: "task" } });
      await space.nack(t1!.lease, { backoffSeconds: 0 }); // attempt 1 -> available
      const t2 = await space.take({ template: { kind: "task" } });
      await space.nack(t2!.lease, { backoffSeconds: 0 }); // attempt 2 > max -> dead_letter

      const nacks = (await space.getEvents()).filter((e) => e.operation === "nack");
      assertEquals(nacks.map((e) => e.state), ["available", "dead_letter"]);
    },
  },
  {
    name: "lineage query returns a record's ancestry via parent_ids",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "fact", body: { v: 1 } });
      const b = await space.put({ kind: "fact", body: { v: 2 }, parentIds: [a.id] });
      const c = await space.put({ kind: "fact", body: { v: 3 }, parentIds: [b.id, a.id] });

      const lineage = await space.getLineage(c.id);
      const ids = new Set(lineage.map((n) => n.record.id));
      assert(ids.has(a.id) && ids.has(b.id) && ids.has(c.id), "lineage missing an ancestor");
      assertEquals(lineage.find((n) => n.record.id === c.id)?.depth, 0);
      assertEquals(lineage.find((n) => n.record.id === b.id)?.depth, 1);
    },
  },
];
