// Diagnostics + control-plane remediation (reclaim / dead-letter / requeue). Remediation
// bypasses lease fencing (fixing another worker's stuck record), so it is not a lease
// settlement — reclaim only touches an EXPIRED lease, never a valid one. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

export const adminSuites: Suite[] = [
  {
    name: "diagnostics reports counts and expired-but-stuck leases",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      await space.put({ kind: "task", body: { tag: "b" } });
      await space.take({ template: { kind: "task" } }, { leaseSeconds: -1 }); // one expired lease

      const d = await space.diagnostics();
      assert(d.counts.available >= 1, "expected an available record");
      assert(d.counts.leased >= 1, "expected a leased record");
      assert(d.stuckLeases.count >= 1, "expected the expired lease to be flagged stuck");
    },
  },
  {
    name: "diagnostics stale-available counts only CLAIMABLE kinds (reference kinds are excluded)",
    run: async (adapter) => {
      // diagnosticsStaleSeconds:-1 → every attempt-0 available record is 'stale' (no waiting).
      const space = new Space(adapter, { diagnosticsStaleSeconds: -1 });
      space.registerKind({ kind: "task", indexedPaths: [] }); // claimable (work)
      space.registerKind({ kind: "fact", indexedPaths: [], claimable: false }); // reference

      await space.put({ kind: "task", body: {} }); // a work record sitting available = starvation
      await space.put({ kind: "fact", body: {} }); // reference data at rest = NOT stale
      await space.put({ kind: "fact", body: {} });
      // grant/kind_def records exist too (reserved, claimable:false) and must also be excluded
      await space.put({ kind: "grant", body: { principal: "agent:x", kind: "task", operations: ["take"] } });

      const d = await space.diagnostics();
      assertEquals(d.staleAvailable.count, 1); // only the task, not the facts/grant/kind_defs
      const kinds = (d.staleAvailable.sample as { kind: string }[]).map((s) => s.kind);
      assertEquals(kinds, ["task"]);
    },
  },
  {
    name: "reclaim un-sticks an expired lease (attempt +1); leaves a valid lease alone",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { tag: "a" } });

      // expired lease -> reclaim applies
      const t = await space.take({ template: { kind: "task" } }, { leaseSeconds: -1 });
      assertEquals(t?.record.id, a.id);
      assertEquals(await space.reclaim(a.id), true);
      const env = await space.getEnvelope(a.id);
      assertEquals(env?.state, "available");
      assertEquals(env?.attempt, 1); // bumped

      // valid lease -> reclaim does NOT disturb it
      const t2 = await space.take({ template: { kind: "task" } }, { leaseSeconds: 30 });
      assert(t2);
      assertEquals(await space.reclaim(a.id), false);
      assertEquals((await space.getEnvelope(a.id))?.state, "leased");
    },
  },
  {
    name: "dead-letter and requeue force state; no-op on consumed records",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { tag: "a" } });

      assertEquals(await space.forceDeadLetter(a.id), true);
      assertEquals((await space.getEnvelope(a.id))?.state, "dead_letter");
      assertEquals(await space.requeue(a.id), true);
      assertEquals((await space.getEnvelope(a.id))?.state, "available");

      // a consumed record can't be dead-lettered (not in available/leased)
      const b = await space.put({ kind: "task", body: { tag: "b" } });
      const tb = await space.take({ template: { kind: "task", match: { tag: "b" } } });
      assert(tb);
      await space.ack(tb!.lease);
      assertEquals(await space.forceDeadLetter(b.id), false);
      assertEquals((await space.getEnvelope(b.id))?.state, "consumed");
    },
  },
];
