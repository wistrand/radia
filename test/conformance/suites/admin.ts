// Diagnostics + control-plane remediation (reclaim / dead-letter / requeue). Remediation
// bypasses lease fencing (fixing another worker's stuck record), so it is not a lease
// settlement: reclaim only touches an EXPIRED lease, never a valid one. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";

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
      await space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 }); // one expired lease

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
      const t = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 });
      assertEquals(t?.record.id, a.id);
      assertEquals(await space.reclaim(a.id), true);
      const env = await space.getEnvelope(a.id);
      assertEquals(env?.state, "available");
      assertEquals(env?.attempt, 1); // bumped

      // valid lease -> reclaim does NOT disturb it
      const t2 = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: 30 });
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
      const tb = await space.take({ pattern: { kind: "task", match: { tag: "b" } } });
      assert(tb);
      await space.ack(tb!.lease);
      assertEquals(await space.forceDeadLetter(b.id), false);
      assertEquals((await space.getEnvelope(b.id))?.state, "consumed");
    },
  },
];

// ---------------------------------------------------------------------------
// Selector-driven remediation
//
// Fixing a backlog one id at a time is a call per record, preceded by diagnostics calls just to
// learn the ids, and the report only samples ten. `remediate` takes the SAME envelope selector
// the ops query takes, so "what is wrong" and "fix it" share one vocabulary.
// ---------------------------------------------------------------------------

export const remediateSuites: Suite[] = [
  {
    name: "remediate: reclaims every expired lease, and is bounded by limit with `more`",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Claim BY ID: a pattern take also ranks expired-lease records as candidates, so repeated
      // pattern takes would keep re-claiming the same lapsed record instead of stranding seven.
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await space.put({ kind: "task", body: { tag: "x" } })).id);
      for (const recordId of ids) await space.take({ recordId }, { leaseSeconds: -1 });

      const first = await space.remediate("reclaim", { state: "leased", expired: true, limit: 3 });
      assertEquals(first.applied, 3);
      assertEquals(first.more, true, "a full page must say there is more");

      let drained = first.applied;
      for (let guard = 0; guard < 10; guard++) {
        const next = await space.remediate("reclaim", { state: "leased", expired: true, limit: 3 });
        drained += next.applied;
        if (!next.more) break;
      }
      assertEquals(drained, 7);
      const after = await space.diagnostics();
      assertEquals(after.stuckLeases.count, 0, "no stuck leases should remain");
    },
  },
  {
    name: "remediate: a VALID lease is never reclaimed by the expired selector",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "live" } });
      const claimed = await space.take({ pattern: { kind: "task" } }, { leaseSeconds: 300 });
      assert(claimed, "expected a claim");

      const out = await space.remediate("reclaim", { state: "leased", expired: true });
      assertEquals(out.matched, 0, "an unexpired lease must not match");
      const env = await space.getEnvelope(claimed!.record.id);
      assertEquals(env?.state, "leased", "the live worker keeps its lease");
    },
  },
  {
    name: "remediate: requeues every dead-lettered record",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (let i = 0; i < 4; i++) await space.put({ kind: "task", body: { tag: "poison" } });
      const dead = await space.remediate("dead-letter", { state: "available" });
      assertEquals(dead.applied, 4);

      const back = await space.remediate("requeue", { state: "dead_letter" });
      assertEquals(back.applied, 4);
      const d = await space.diagnostics();
      assertEquals(d.counts.dead_letter, 0);
      assert(d.counts.available >= 4);
    },
  },
  {
    name: "remediate: a broad available selector never touches reference kinds",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "fact", indexedPaths: [], claimable: false });
      const work = await space.put({ kind: "task", body: { tag: "work" } });
      const fact = await space.put({ kind: "fact", body: {} });

      // `{state:"available"}` is the broadest selector there is. A `claimable:false` kind sits
      // available forever by design, so sweeping it into dead_letter would break the space. The
      // kind registry and the grants are themselves records of such kinds.
      const out = await space.remediate("dead-letter", { state: "available" });
      assertEquals(out.applied, 1, "only the claimable record should be remediated");
      assertEquals((await space.getEnvelope(work.id))?.state, "dead_letter");
      assertEquals((await space.getEnvelope(fact.id))?.state, "available", "a reference record must be left alone");

      // …but the recovery path is not filtered: a reference record that somehow landed in
      // dead_letter must still be requeueable.
      await space.forceDeadLetter(fact.id);
      const back = await space.remediate("requeue", { state: "dead_letter" });
      assert(back.applied >= 1);
      assertEquals((await space.getEnvelope(fact.id))?.state, "available");
    },
  },
  {
    name: "diagnostics: no `expired` count (expiry is implicit), and a capped scan says so",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" } });
      await space.take({ pattern: { kind: "task" } }, { leaseSeconds: -1 });
      const d = await space.diagnostics();
      // A lapsed lease leaves the record in state `leased`; nothing ever writes `expired`, so
      // reporting that count would always be a confident zero beside real stuck leases.
      assertEquals((d.counts as Record<string, number>).expired, undefined);
      assertEquals(d.stuckLeases.count, 1);
      assertEquals(d.stuckLeases.atLeast, false, "an uncapped scan is an exact count");
    },
  },
];
