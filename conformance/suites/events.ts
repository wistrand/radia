// Phase 5 conformance: the transactional event log and lineage. Every MUTATION appends exactly
// one event, in the same transaction that performs it; no-op outcomes (lease_lost, idempotency
// replay) append nothing. Usually one op means one mutation. The exception is `ack` with a
// result, which both consumes the parent and inserts a new record, so it appends two: the
// result's `put` then the parent's `ack`. Runs on every adapter.

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
    name: "each mutation appends one event, in seq order, with run identity",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      const acked = await space.ack(t!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok");

      const ops = (await space.getEvents()).map((e) => e.operation);
      // ack-with-result is two mutations: the result enters the space, then the parent is
      // consumed. The result's put comes first, mirroring the order inside the transaction.
      assertEquals(ops, ["put", "take", "put", "ack"]);

      const events = await space.getEvents();
      const resultPut = events[2];
      assertEquals(resultPut.kind, "result"); // its OWN kind, so a watcher on it can wake
      assertEquals(resultPut.state, "available");
      assertEquals(resultPut.recordId, acked.resultId);
      assertEquals((resultPut.detail as { ackOf: string }).ackOf, t!.lease.recordId);

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
      const t = await space.take({ pattern: { kind: "task" } });
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

      const t1 = await space.take({ pattern: { kind: "task" } });
      await space.nack(t1!.lease, { backoffSeconds: 0 }); // attempt 1 -> available
      const t2 = await space.take({ pattern: { kind: "task" } });
      await space.nack(t2!.lease, { backoffSeconds: 0 }); // attempt 2 > max -> dead_letter

      const nacks = (await space.getEvents()).filter((e) => e.operation === "nack");
      assertEquals(nacks.map((e) => e.state), ["available", "dead_letter"]);
    },
  },
  {
    name: "latestEvents is the tail: newest N ascending, and following from it is gap-free",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const tag of ["a", "b", "c", "d", "e"]) await space.put({ kind: "task", body: { tag } });

      const tail = await adapter.latestEvents(3);
      const all = await space.getEvents();
      assertEquals(tail.map((e) => e.seq), all.slice(-3).map((e) => e.seq), "the newest three, in ascending order");

      // The whole point of the tail: a live view seeds from it and FOLLOWS. The next event after
      // the tail's last cursor must be exactly the next thing that happens, no gap, no replay.
      const { id } = await space.put({ kind: "task", body: { tag: "f" } });
      const next = await adapter.getEvents(tail[tail.length - 1].cursor, 10);
      assertEquals(next.length, 1);
      assertEquals(next[0].recordId, id);

      // Wider than the log: everything, still ascending, never padded.
      assertEquals((await adapter.latestEvents(100)).length, 6);
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
