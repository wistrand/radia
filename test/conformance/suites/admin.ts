// Diagnostics + control-plane remediation (reclaim / dead-letter / requeue). Remediation
// bypasses lease fencing (fixing another worker's stuck record), so it is not a lease
// settlement: reclaim only touches an EXPIRED lease, never a valid one. Runs on every adapter.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";
import { RadiaError } from "../../../src/core/errors.ts";

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
    // PLANTED REGRESSION. `expired` is evaluated in `Space.queryEnvelopes` AFTER the adapter's
    // `LIMIT`, and the adapter orders by `available_at` (both dialects). So a page can be filled
    // entirely by LIVE leases whose records are older, and the expired ones behind them are never
    // examined: the verb reports nothing to do, and `more: false` stops `--drain`.
    //
    // The existing "bounded by limit with `more`" case above cannot see this, because every lease
    // in it is expired: a homogeneous population never exercises the pre-filter cap.
    name: "remediate: expired leases hidden behind a page of LIVE ones are still found",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Ten live leases FIRST, so their `available_at` is the oldest and they lead the page.
      for (let i = 0; i < 10; i++) {
        const { id } = await space.put({ kind: "task", body: { tag: "live" } });
        await space.take({ recordId: id }, { leaseSeconds: 300 });
      }
      // Three stuck ones behind them. Claimed BY ID so a pattern take cannot re-rank them.
      const stuck: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await space.put({ kind: "task", body: { tag: "stuck" } });
        await space.take({ recordId: id }, { leaseSeconds: -1 });
        stuck.push(id);
      }

      const out = await space.remediate("reclaim", { state: "leased", expired: true, limit: 5 });
      assertEquals(out.applied, 3, "every expired lease must be reclaimed, whatever sits in front of it");
      for (const id of stuck) {
        assertEquals((await space.getEnvelope(id))?.state, "available", "a stuck record must come back");
      }
    },
  },
  {
    // The other half, and the one that makes it silent: a page emptied by the post-filter reports
    // `more: false`, so `radia reclaim --all --drain` stops on the first page and says it is done.
    name: "remediate: a page emptied by the expired filter does not claim to be the end",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (let i = 0; i < 10; i++) {
        const { id } = await space.put({ kind: "task", body: { tag: "live" } });
        await space.take({ recordId: id }, { leaseSeconds: 300 });
      }
      const { id: stuck } = await space.put({ kind: "task", body: { tag: "stuck" } });
      await space.take({ recordId: stuck }, { leaseSeconds: -1 });

      const page = await space.remediate("reclaim", { state: "leased", expired: true, limit: 5 });
      assert(
        page.applied > 0 || page.more,
        `a caller that drains until 'more' is false must not be told the work is done: ` +
          `applied=${page.applied} more=${page.more}`,
      );
    },
  },
  {
    // Diagnostics reads the same way (`inspection.ts`: state=leased, expired, limit SAMPLE=500), so
    // `radia doctor` under-reports on the same shape once a space holds more than 500 live leases.
    // Sized to the constant on purpose: a smaller population passes for the wrong reason, and a
    // test that cannot fail is one nobody has tested.
    name: "diagnostics: stuck leases are counted behind a full page of live ones",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (let i = 0; i < 501; i++) {
        const { id } = await space.put({ kind: "task", body: { tag: "live" } });
        await space.take({ recordId: id }, { leaseSeconds: 300 });
      }
      const { id: stuck } = await space.put({ kind: "task", body: { tag: "stuck" } });
      await space.take({ recordId: stuck }, { leaseSeconds: -1 });

      const d = await space.diagnostics();
      assertEquals(d.stuckLeases.count, 1, "one lapsed lease, whatever else is leased");
    },
  },
  {
    // Quarantine's events describe the rows that MOVED (`RETURNING`), not the rows a prior read
    // happened to see. WHAT THIS PINS, exactly, because the honest scope matters: the actor on the
    // event (planted-red: restoring `runId: "admin"` fails this), that an already-settled lease is
    // neither moved nor counted, and the RETURNING semantics both dialects now rely on.
    //
    // WHAT IT CANNOT STAGE is the race the fix exists for: a lease acked BETWEEN the old SELECT and
    // its UPDATE. That needs two concurrent connections, which the embedded adapters do not have
    // (the same limit package S recorded for its pooled-Postgres races). Reverting to the
    // SELECT-then-emit shape leaves this test GREEN, and that is stated rather than discovered:
    // a Postgres-only case in `test/concurrency.test.ts` is where that half belongs.
    name: "quarantine: events and count describe the leases that actually moved",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { tag: "a" } });
      const b = await space.put({ kind: "task", body: { tag: "b" } });
      const first = await space.take({ recordId: a.id }, { leaseSeconds: 300 });
      const second = await space.take({ recordId: b.id }, { leaseSeconds: 300 });
      assert(first && second, "both must be claimable");
      const run = first!.lease.ownerRun;
      assertEquals(second!.lease.ownerRun, run, "one taker, so one owner run");

      // One of them settles before the quarantine, exactly as a worker racing a stop would.
      assertEquals((await space.ack(first!.lease)).status, "ok");

      const moved = await adapter.quarantineLeasesOf(run, await adapter.now(), "human:operator");
      assertEquals(moved, 1, "only the still-held lease moved");
      assertEquals((await space.getEnvelope(b.id))?.state, "available");
      assertEquals((await space.getEnvelope(a.id))?.state, "consumed", "the acked one is untouched");

      const quarantines = (await adapter.getEvents("0", 500)).filter((e) => e.operation === "quarantine");
      assertEquals(quarantines.length, 1, "one event, for the one transition that happened");
      assertEquals(quarantines[0].recordId, b.id);
      // And WHO did it. `"admin"` lost the actor on the one operation that bypasses fencing.
      assertEquals(quarantines[0].runId, "human:operator");
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
    // The selector's kind filter, which is what makes a shared space's backlog drainable: an
    // operator fixing one app must not revive another app's dead-lettered work.
    name: "remediate: a kind selector drains one app's backlog and leaves the other's alone",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "chore", indexedPaths: [] });
      const mine: string[] = [];
      const theirs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = await space.put({ kind: "task", body: { tag: "x" } });
        const b = await space.put({ kind: "chore", body: { tag: "x" } });
        mine.push(a.id);
        theirs.push(b.id);
        await space.forceDeadLetter(a.id);
        await space.forceDeadLetter(b.id);
      }

      const out = await space.remediate("requeue", { state: "dead_letter", kinds: ["task"] });
      assertEquals(out.applied, 3, "every dead-lettered task, and only those");
      for (const id of mine) assertEquals((await space.getEnvelope(id))?.state, "available");
      for (const id of theirs) {
        assertEquals((await space.getEnvelope(id))?.state, "dead_letter", "another kind must be untouched");
      }
    },
  },
  {
    // A kind filter must NARROW a scoped caller's read, never widen it. The grant scope and the
    // caller's kinds are separate SQL clauses, ANDed, so naming a kind outside the scope answers
    // nothing rather than reaching it.
    name: "envelope query: a kind outside the caller's scope answers nothing, not the kind",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "chore", indexedPaths: [] });
      await space.put({ kind: "task", body: { tag: "x" } });
      await space.put({ kind: "chore", body: { tag: "x" } });

      const scoped = { kinds: ["task"] };
      const inScope = await space.queryEnvelopes({ state: "available", kinds: ["task"], scope: scoped });
      assertEquals(inScope.length, 1, "a kind inside the scope is answered");
      const outOfScope = await space.queryEnvelopes({ state: "available", kinds: ["chore"], scope: scoped });
      assertEquals(outOfScope.length, 0, "a kind outside the scope must not be reachable by naming it");
    },
  },
  {
    // Refused, not silently empty. The reference-kind guard would subtract the named kind and
    // answer `matched: 0`, which reads as "nothing to fix" rather than "not a thing to fix".
    name: "remediate: naming a reference kind is refused rather than answered with zero",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.registerKind({ kind: "note", indexedPaths: [], claimable: false });
      await space.put({ kind: "note", body: { tag: "x" } });

      const e = await assertRejects(
        () => space.remediate("dead-letter", { state: "available", kinds: ["note"] }),
        RadiaError,
      );
      assertEquals((e as RadiaError).code, "kind_not_remediable");
      assertEquals((await space.query({ kind: "note" }, 10)).length, 1, "and it is still there");
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
