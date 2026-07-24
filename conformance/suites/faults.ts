// Phase 6 conformance: the fault-injection subset. These compose the mechanisms built in
// Phases 3-5 (fencing, lazy expiry, idempotency, transactional events) to show they
// recover correctly under worker crashes. Crashes are simulated deterministically — a
// crashed worker is one that took a lease and never acked, and its lease is forced to
// expire with a negative lease (leased_until in the past) so recovery needs no sleep. A
// "lost response" is simulated by discarding a committed ack's return and retrying. No
// test-only hooks live in production code. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

// A crashed worker: takes with a lease that is already expired, then does nothing.
function crashBeforeAck(space: Space) {
  return space.take({ template: { kind: "task" } }, { leaseSeconds: -1 });
}

export const faultSuites: Suite[] = [
  {
    name: "crash before external effect: work is reclaimed and runs once, no data lost",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });
      let effects = 0;

      // Worker A claims, then crashes before doing its effect or acking.
      await crashBeforeAck(space);

      // Recovery: worker B reclaims the expired lease and completes it.
      const b = await space.take({ template: { kind: "task" } });
      assert(b, "expected reclaim");
      effects++; // B's effect
      assertEquals((await space.ack(b!.lease)).status, "ok");

      assertEquals(effects, 1); // A never ran its effect; no duplication here
      assertEquals((await space.getEnvelope(id))?.state, "consumed");
    },
  },
  {
    name: "crash after effect, before ack: at-least-once means the effect can repeat",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });
      let effects = 0;

      // Worker A does its external effect (e.g. sends an email) then crashes before ack.
      await crashBeforeAck(space);
      effects++; // A's effect already happened externally

      // Recovery: B reclaims and, per the contract, runs the effect AGAIN.
      const b = await space.take({ template: { kind: "task" } });
      assert(b);
      effects++;
      assertEquals((await space.ack(b!.lease)).status, "ok");

      assertEquals(effects, 2); // duplicate side effect — the documented at-least-once cost
      assertEquals((await space.getEnvelope(id))?.state, "consumed"); // space state consistent
    },
  },
  {
    name: "crash after commit, before response: idempotent ack replay, no duplicate result",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ template: { kind: "task" } });
      assert(t);

      // ack commits, but the response is lost before the worker sees it.
      const r1 = await space.ack(t!.lease, { kind: "result", body: { ok: true } }, "ack-k");
      assertEquals(r1.status, "ok");

      // The worker retries with the same key. It must get the stored ok, not lease_lost.
      const r2 = await space.ack(t!.lease, { kind: "result", body: { ok: true } }, "ack-k");
      assertEquals(r2.status, "ok");
      assertEquals(r2.status === "ok" ? r2.resultId : "x", r1.status === "ok" ? r1.resultId : "y");
      assertEquals((await space.query({ kind: "result" })).length, 1); // exactly one effect
    },
  },
  {
    name: "duplicate ack: keyed replay is safe; a bare duplicate is fenced",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ template: { kind: "task" } });
      assert(t);

      assertEquals((await space.ack(t!.lease, { kind: "result", body: {} }, "k")).status, "ok");
      // keyed duplicate -> replay
      assertEquals((await space.ack(t!.lease, { kind: "result", body: {} }, "k")).status, "ok");
      // bare duplicate (no key) hits the consumed lease -> fenced
      assertEquals((await space.ack(t!.lease)).status, "lease_lost");
      assertEquals((await space.query({ kind: "result" })).length, 1);
    },
  },
  {
    name: "stale ack after reassignment: the old lease is fenced, the new one settles",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });

      const a = await crashBeforeAck(space); // A claims, lease will expire
      const b = await space.take({ template: { kind: "task" } }); // B reclaims, epoch bumps
      assert(a && b);

      // A wakes up late and acks its stale lease.
      assertEquals((await space.ack(a!.lease)).status, "lease_lost");
      // B's ack is the one that counts.
      assertEquals((await space.ack(b!.lease)).status, "ok");
      assertEquals((await space.getEnvelope(id))?.state, "consumed");
    },
  },
];
