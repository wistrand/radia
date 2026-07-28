// Phase 3 conformance: take/renew/ack/nack/release, fencing (lease_lost), attempt
// semantics, lazy expiry, dead-letter, and atomic consume-and-emit. Runs on every adapter.
//
// Expiry is exercised deterministically with a negative lease (leased_until in the past),
// avoiding sleeps. Reassignment for fencing is created with nack/release, no waiting.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { type SpaceContext, Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter, ctx: Partial<SpaceContext> = {}): Space {
  const space = new Space(adapter, ctx);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function nonNull<T>(p: Promise<T | null>): Promise<T> {
  const v = await p;
  assert(v !== null, "expected a non-null take");
  return v;
}

export const leaseSuites: Suite[] = [
  {
    name: "take grants a lease; a second take finds nothing claimable (one valid lease)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });

      const first = await nonNull(space.take({ pattern: { kind: "task" } }));
      assert(first.lease.leaseId.length > 0);
      assertEquals(await space.take({ pattern: { kind: "task" } }), null);

      const env = await space.getEnvelope(first.record.id);
      assertEquals(env?.state, "leased");
    },
  },
  {
    name: "ack consumes the record and emits a result linked to it",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });
      const t = await nonNull(space.take({ pattern: { kind: "task" } }));

      const res = await space.ack(t.lease, { kind: "result", body: { ok: true } });
      assertEquals(res.status, "ok");

      assertEquals((await space.getEnvelope(id))?.state, "consumed");
      const result = await space.readOne({ kind: "result" });
      assert(result, "result record not emitted");
      assert(result!.runtimeMeta.parentIds.includes(id), "result not linked to the task");
    },
  },
  {
    name: "fencing: after reassignment, the old lease is lease_lost and emits nothing",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });

      const t1 = await nonNull(space.take({ pattern: { kind: "task" } }));
      assertEquals((await space.nack(t1.lease, { backoffSeconds: 0 })).status, "ok"); // back to available now
      const t2 = await nonNull(space.take({ pattern: { kind: "task" } }));
      assert(t2.lease.epoch > t1.lease.epoch, "epoch should advance on reclaim");

      // stale operations on the old lease are fenced
      assertEquals((await space.renew(t1.lease)).status, "lease_lost");
      const ack = await space.ack(t1.lease, { kind: "result", body: { stale: true } });
      assertEquals(ack.status, "lease_lost");
      assertEquals(await space.readOne({ kind: "result" }), null); // nothing emitted

      // the current lease still works
      assertEquals((await space.ack(t2.lease)).status, "ok");
    },
  },
  {
    name: "attempt semantics: nack +1, release +0",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });

      const t1 = await nonNull(space.take({ pattern: { kind: "task" } }));
      await space.nack(t1.lease, { backoffSeconds: 0 });
      assertEquals((await space.getEnvelope(id))?.attempt, 1);
      assertEquals((await space.getEnvelope(id))?.state, "available");

      const t2 = await nonNull(space.take({ pattern: { kind: "task" } }));
      await space.release(t2.lease);
      assertEquals((await space.getEnvelope(id))?.attempt, 1); // release is +0
      assertEquals((await space.getEnvelope(id))?.state, "available");
    },
  },
  {
    name: "lazy expiry: an expired lease is reclaimable and increments attempt (+1)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });

      const t1 = await nonNull(space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 }));
      assertEquals((await space.getEnvelope(id))?.attempt, 0);

      const t2 = await nonNull(space.take({ pattern: { kind: "task" } }));
      assert(t2.lease.epoch > t1.lease.epoch);
      assertEquals((await space.getEnvelope(id))?.attempt, 1); // expiry counted
    },
  },
  {
    name: "dead-letter after max_attempts via repeated expiry",
    run: async (adapter) => {
      const space = newSpace(adapter, { maxAttempts: 1 });
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });

      await nonNull(space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 })); // attempt 0
      await nonNull(space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 })); // reclaim -> attempt 1
      // next reclaim would be attempt 2 > max(1) -> dead_letter, nothing claimable
      assertEquals(await space.take({ pattern: { kind: "task" } }), null);
      assertEquals((await space.getEnvelope(id))?.state, "dead_letter");
    },
  },
  {
    name: "renew cannot extend past the cumulative hard cap",
    run: async (adapter) => {
      const space = newSpace(adapter, { maxCumulativeSeconds: 0 });
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await nonNull(space.take({ pattern: { kind: "task" } }));
      // hard deadline == take time, so any later renew is fenced
      assertEquals((await space.renew(t.lease)).status, "lease_lost");
    },
  },
  {
    name: "take by record_id is a selector, not a bypass (still fences and consumes)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });

      const t = await nonNull(space.take({ recordId: id }));
      assertEquals(t.record.id, id);
      assertEquals(await space.take({ recordId: id }), null); // already leased
      assertEquals((await space.ack(t.lease)).status, "ok");
    },
  },
];

// ---------------------------------------------------------------------------
// Claim fairness and candidate-set bounds
//
// `take` must hand out work that exists. The original implementation locked its ENTIRE candidate
// set (`for update ... skip locked` over every available-or-leased record of the kind) and relied
// on that lock — not on the compare-and-set update — for single-winner. Under real concurrency
// that starves: one claimer's open transaction holds every candidate, so everyone else is told
// the queue is empty while it is full. Measured on Postgres at 16 concurrent claimers: 166 empty
// takes against 120 records that were never claimed by anyone.
// ---------------------------------------------------------------------------

export const claimFairnessSuites: Suite[] = [
  {
    name: "concurrent claimers each get work while work remains (no starvation)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const N = 16;
      for (let i = 0; i < N; i++) await space.put({ kind: "task", body: { tag: "x", i } });

      // Concurrent, overlapping takes. On a single-connection adapter these serialize and the
      // assertion is trivially true; on a real backend they overlap, which is where locking the
      // whole candidate set shows up as a false "nothing available".
      const claims = await Promise.all(
        Array.from({ length: N }, () => space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 })),
      );
      const got = claims.filter((c) => c !== null);
      assertEquals(got.length, N, `every claimer must get one of the ${N} available records`);

      // …and single-winner still holds: no record claimed twice.
      const ids = new Set(got.map((c) => c!.record.id));
      assertEquals(ids.size, N, "two claimers must never win the same record");
    },
  },
  {
    name: "a match that only hits records deep in the candidate order is still found",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Guards the fix rather than the bug: bounding the candidate window must PAGE, not truncate.
      // A window of the first N records that contains no match must not report "nothing to claim"
      // when a matching record sits behind it.
      for (let i = 0; i < 300; i++) await space.put({ kind: "task", body: { tag: "common", i } });
      const { id: needle } = await space.put({ kind: "task", body: { tag: "rare" } });

      const claimed = await space.take({ pattern: { kind: "task", match: { tag: "rare" } } }, { leaseSeconds: 60 });
      assert(claimed, "the only matching record must be found however deep it sits");
      assertEquals(claimed!.record.id, needle);
    },
  },
];
