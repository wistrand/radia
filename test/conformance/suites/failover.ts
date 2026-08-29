// Fault matrix: DB FAILOVER (plan-validation.md). The storage connection dies under a live
// operation and comes back, which on a managed Postgres is a promotion and on a laptop is a
// restart. Both leave the same two shapes behind, and the second is the dangerous one:
//
//   BEFORE  the write never reached the database. Nothing committed, and the caller saw an error.
//   AFTER   the write committed and the ANSWER was lost. The caller saw an error and is wrong.
//
// Injected by wrapping the adapter in a Proxy that throws around one named method, so no test-only
// hook lives in production code (the rule `test/concurrency.test.ts` states) and every adapter gets
// the same treatment. What this deliberately does NOT claim: it cannot fail INSIDE the storage
// transaction, because that would need a hook in the adapter, so transactional rollback is not what
// is under test here. What is under test is the contract the runtime owes a caller across a
// connection that died: exactly-once effect under retry, a log that agrees with the records, a
// chain that still verifies, and a lease that outlives the outage it never noticed.
//
// A real server kill (docker stop on a primary, promotion of a replica) is a deployment test rather
// than a suite one: it needs a cluster, and it exercises the DRIVER's reconnect rather than any
// guarantee this codebase makes. That gap is stated in plan-validation.md rather than papered over.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";

class Failover extends Error {
  constructor() {
    super("connection terminated (simulated failover)");
  }
}

/**
 * `adapter` with one method made unreliable. `when: "after"` delegates first and throws the
 * response away, which is the failover that loses an answer to work the database already did.
 * Failures are consumed, so the next call is the recovered server.
 */
function failing(adapter: StorageAdapter, method: keyof StorageAdapter, when: "before" | "after", times = 1): StorageAdapter {
  let left = times;
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== method || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        if (left <= 0) return await value.apply(target, args);
        left--;
        if (when === "before") throw new Failover();
        await value.apply(target, args);
        throw new Failover(); // committed; the caller never learns what it was
      };
    },
  }) as StorageAdapter;
}

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function threw(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

export const failoverSuites: Suite[] = [
  {
    name: "failover before the write lands: nothing committed, and the retry writes exactly one record",
    run: async (adapter) => {
      const down = newSpace(failing(adapter, "put", "before"));
      assert(await threw(() => down.put({ kind: "task", body: { tag: "a" } }, "job:1")), "the outage must surface");

      const up = newSpace(adapter);
      assertEquals((await up.query({ kind: "task" }, 10)).length, 0, "a failed write must leave nothing behind");

      await up.put({ kind: "task", body: { tag: "a" } }, "job:1");
      assertEquals((await up.query({ kind: "task" }, 10)).length, 1);
    },
  },
  {
    name: "failover after the write lands: the lost answer is recovered by key, not written twice",
    run: async (adapter) => {
      // The database did the work and the failover ate the reply. The caller cannot tell this from
      // the case above, which is exactly why the retry has to carry a key.
      const down = newSpace(failing(adapter, "put", "after"));
      assert(await threw(() => down.put({ kind: "task", body: { tag: "a" } }, "job:1")));

      const up = newSpace(adapter);
      const before = await up.query({ kind: "task" }, 10);
      assertEquals(before.length, 1, "the write committed: the failover lost the answer, not the work");

      const retry = await up.put({ kind: "task", body: { tag: "a" } }, "job:1");
      assertEquals(retry.id, before[0].id, "the keyed retry must REPLAY the stored response");
      assertEquals((await up.query({ kind: "task" }, 10)).length, 1, "one effect, one record");
    },
  },
  {
    name: "failover mid-settle: the effect is not repeated, and the record settles once",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 });
      assert(t);

      // The ack commits and the connection dies before the worker hears about it. The worker's
      // retry is the same keyed ack, which is the shape `agentLoop` already writes.
      const down = newSpace(failing(adapter, "ack", "after"));
      assert(await threw(() => down.ack(t!.lease, undefined, "ack:1")));
      assertEquals((await space.getEnvelope(id))?.state, "consumed", "the settle committed before the outage");

      assertEquals((await space.ack(t!.lease, undefined, "ack:1")).status, "ok", "the keyed retry replays");
      // And an UNKEYED retry after the same outage is fenced rather than settling a second time,
      // which is what stops a lost answer from becoming a second result record.
      assertEquals((await space.ack(t!.lease)).status, "lease_lost");
      assertEquals((await space.getEnvelope(id))?.state, "consumed");
    },
  },
  {
    name: "failover leaves no event without its record, and none naming a record that is not there",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const tag of ["a", "b"]) await space.put({ kind: "task", body: { tag } });
      const down = newSpace(failing(adapter, "put", "before", 2));
      for (const tag of ["c", "d"]) await threw(() => down.put({ kind: "task", body: { tag } }));
      await space.put({ kind: "task", body: { tag: "e" } });

      const ids = new Set((await space.query({ kind: "task" }, 50)).map((r) => r.id));
      assertEquals(ids.size, 3, "the two failed writes committed nothing");
      const named = (await space.getEvents("0", 500)).filter((e) => e.recordId !== undefined);
      assert(named.length > 0);
      for (const e of named) {
        assert(ids.has(e.recordId!), `event ${e.operation} names ${e.recordId}, which no record answers`);
      }
    },
  },
  {
    name: "failover does not break the chain: integrity still verifies, and says nothing was truncated",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      const down = newSpace(failing(adapter, "put", "before", 3));
      for (const tag of ["b", "c", "d"]) await threw(() => down.put({ kind: "task", body: { tag } }));
      await space.put({ kind: "task", body: { tag: "e" } });

      await space.sealEvents();
      const v = await space.verifyIntegrity();
      assertEquals(v.ok, true, "an outage must not be indistinguishable from tampering");
      assertEquals(v.truncated, undefined, "nothing was swept, so nothing may claim it was");
    },
  },
  {
    name: "a lease outlives a failover it never noticed",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { tag: "a" } });
      const t = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: 60 });
      assert(t);

      // The outage hits somebody else's read. The lease is state in the database, not in the
      // connection, so it is untouched: nothing else may claim the record, and the holder settles.
      const down = newSpace(failing(adapter, "query", "before"));
      assert(await threw(() => down.query({ kind: "task" }, 10)));

      assertEquals(await space.take({ pattern: { kind: "task" } }), null, "a live lease survives the outage");
      assertEquals((await space.ack(t!.lease)).status, "ok");
      assertEquals((await space.getEnvelope(id))?.state, "consumed");
    },
  },
];
