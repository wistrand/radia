// Taint (M1): untrusted-DATA lineage. A client may RAISE taint (source attestation) but never
// clear it; taint propagates along data parents (put + ack); a sensitive consumer can skip
// tainted work (`requireUntainted`); and only a privileged DECLASSIFY yields a clean successor.
// Runs on every adapter: propagation is core policy, so both backends must agree.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  space.registerKind({ kind: "result", indexedPaths: [] });
  return space;
}

const taintOf = async (space: Space, id: string) => (await space.getRecord(id))!.runtimeMeta.taint;

export const taintSuites: Suite[] = [
  {
    name: "taint: a client can RAISE taint but never clear it; propagation ORs data parents",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // a plain put is untainted
      const clean = (await space.put({ kind: "task", body: { tag: "a" } })).id;
      assertEquals(await taintOf(space, clean), false);

      // a client raises taint (source attestation)
      const dirty = (await space.put({ kind: "task", body: { tag: "b" }, taint: true })).id;
      assertEquals(await taintOf(space, dirty), true);

      // a client CANNOT clear taint: taint:false with a tainted parent stays tainted (propagation wins)
      const child = (await space.put({ kind: "task", body: { tag: "c" }, parentIds: [dirty], taint: false })).id;
      assertEquals(await taintOf(space, child), true);

      // a child of only-clean parents is clean
      const cleanChild = (await space.put({ kind: "task", body: { tag: "d" }, parentIds: [clean] })).id;
      assertEquals(await taintOf(space, cleanChild), false);
    },
  },
  {
    name: "taint: propagates through ack, so a tainted task yields a tainted result",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const t = (await space.put({ kind: "task", body: { tag: "t" }, taint: true })).id;
      const claimed = await space.take({ pattern: { kind: "task", match: { tag: "t" } } });
      const acked = await space.ack(claimed!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok" && acked.resultId);
      assertEquals(await taintOf(space, acked.resultId!), true); // inherited from the leased (data) parent

      // sanity: the record we consumed was the tainted one
      assertEquals(claimed!.record.id, t);
    },
  },
  {
    name: "taint: a sensitive consumer (requireUntainted) skips tainted candidates",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "x" }, taint: true }); // tainted
      const cleanId = (await space.put({ kind: "task", body: { tag: "x" } })).id; // clean

      // requireUntainted claims only the clean one; the tainted one is skipped
      const first = await space.take({ pattern: { kind: "task", match: { tag: "x" } } }, { requireUntainted: true });
      assertEquals(first!.record.id, cleanId);
      // no more untainted candidates → nothing claimable
      const second = await space.take({ pattern: { kind: "task", match: { tag: "x" } } }, { requireUntainted: true });
      assertEquals(second, null);
      // without the filter, the tainted one is still claimable
      const third = await space.take({ pattern: { kind: "task", match: { tag: "x" } } });
      assert(third && third.record.runtimeMeta.taint);
    },
  },
  {
    name: "taint: declassify emits a clean successor of a tainted record (the only way to clear)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const dirty = (await space.put({ kind: "task", body: { tag: "secret", v: 1 } , taint: true })).id;

      const out = await space.declassify(dirty);
      assert(out);
      const clean = (await space.getRecord(out!.id))!;
      assertEquals(clean.runtimeMeta.taint, false); // cleared
      assertEquals(clean.body, { tag: "secret", v: 1 }); // same content
      assertEquals(clean.runtimeMeta.parentIds, [dirty]); // audit: derived from the tainted original
      // the original is untouched (immutable) and still tainted
      assertEquals(await taintOf(space, dirty), true);
      // declassifying a missing record is a no-op
      assertEquals(await space.declassify("01000000000000000000000000"), null);
    },
  },
  {
    name: "taint: a declassify names WHO cleared it, and is its own operation in the log",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const dirty = (await space.put({ kind: "task", body: { tag: "secret" } , taint: true })).id;

      // Declassify is the human decision that lets untrusted data reach a side-effecting worker.
      // Written with no principal it was ANONYMOUS: `created_by` (and so the event's `runId`) was
      // the space's own identity, so the trail said what was cleared and never who cleared it,
      // and a tamper-evident log over that record would protect the wrong fact.
      const approver = "human:auditor";
      const out = await space.declassify(dirty, approver);
      assert(out);
      const clean = (await space.getRecord(out!.id))!;
      assertEquals(clean.runtimeMeta.createdBy, approver, "the successor is authored by the approver");
      assertEquals(clean.runtimeMeta.taint, false);

      // …and it is greppable rather than hidden among ordinary puts.
      const events = await space.getEvents("0", 500);
      const dec = events.filter((e) => e.operation === "declassify");
      assertEquals(dec.length, 1, `expected one declassify event, got ${dec.length}`);
      assertEquals(dec[0].runId, approver, "the event names the approver");
      assertEquals(dec[0].recordId, out!.id);
      assertEquals((dec[0].detail as { declassifiedFrom?: string })?.declassifiedFrom, dirty);
      // An ordinary put is still an ordinary put.
      assert(events.some((e) => e.operation === "put" && e.recordId === dirty), "the original put is unchanged");
    },
  },
];
