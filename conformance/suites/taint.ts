// Taint (M1): untrusted-DATA lineage. A client may RAISE taint (source attestation) but never
// clear it; taint propagates along data parents (put + ack); a sensitive consumer can skip
// tainted work (`requireUntainted`); and only a privileged DECLASSIFY yields a clean successor.
// Runs on every adapter: propagation is core policy, so both backends must agree.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { RadiaError } from "../../src/core/errors.ts";

/** The error CODE a call raised, or undefined if it succeeded. */
async function denied(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${e}`;
  }
}

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
      assertEquals(await taintOf(space, clean), []);

      // a client raises taint (source attestation)
      const dirty = (await space.put({ kind: "task", body: { tag: "b" }, taint: ["file"] })).id;
      assertEquals(await taintOf(space, dirty), ["file"]);

      // a client CANNOT clear taint: taint:false with a tainted parent stays tainted (propagation wins)
      const child = (await space.put({ kind: "task", body: { tag: "c" }, parentIds: [dirty] })).id;
      assertEquals(await taintOf(space, child), ["file"], "labels flow down data parents");

      // a child of only-clean parents is clean
      const cleanChild = (await space.put({ kind: "task", body: { tag: "d" }, parentIds: [clean] })).id;
      assertEquals(await taintOf(space, cleanChild), []);
    },
  },
  {
    name: "taint: propagates through ack, so a tainted task yields a tainted result",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const t = (await space.put({ kind: "task", body: { tag: "t" }, taint: ["file"] })).id;
      const claimed = await space.take({ pattern: { kind: "task", match: { tag: "t" } } });
      const acked = await space.ack(claimed!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok" && acked.resultId);
      assertEquals(await taintOf(space, acked.resultId!), ["file"]); // inherited from the leased (data) parent

      // sanity: the record we consumed was the tainted one
      assertEquals(claimed!.record.id, t);
    },
  },
  {
    name: "taint: a sensitive consumer (requireUntainted) skips tainted candidates",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "x" }, taint: ["file"] }); // classified
      const cleanId = (await space.put({ kind: "task", body: { tag: "x" } })).id; // clean

      // requireUntainted claims only the clean one; the tainted one is skipped
      const first = await space.take({ pattern: { kind: "task", match: { tag: "x" } } }, { allowTaint: [] });
      assertEquals(first!.record.id, cleanId);
      // no more untainted candidates → nothing claimable
      const second = await space.take({ pattern: { kind: "task", match: { tag: "x" } } }, { allowTaint: [] });
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
      const dirty = (await space.put({ kind: "task", body: { tag: "secret", v: 1 } , taint: ["file"] })).id;

      const out = await space.declassify(dirty);
      assert(out);
      const clean = (await space.getRecord(out!.id))!;
      assertEquals(clean.runtimeMeta.taint, []); // cleared
      assertEquals(clean.body, { tag: "secret", v: 1 }); // same content
      assertEquals(clean.runtimeMeta.parentIds, [dirty]); // audit: derived from the tainted original
      // the original is untouched (immutable) and still tainted
      assertEquals(await taintOf(space, dirty), ["file"]);
      // declassifying a missing record is a no-op
      assertEquals(await space.declassify("01000000000000000000000000"), null);
    },
  },
  {
    name: "taint: a declassify names WHO cleared it, and is its own operation in the log",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const dirty = (await space.put({ kind: "task", body: { tag: "secret" } , taint: ["file"] })).id;

      // Declassify is the human decision that lets untrusted data reach a side-effecting worker.
      // Written with no principal it was ANONYMOUS: `created_by` (and so the event's `runId`) was
      // the space's own identity, so the trail said what was cleared and never who cleared it,
      // and a tamper-evident log over that record would protect the wrong fact.
      const approver = "human:auditor";
      const out = await space.declassify(dirty, approver);
      assert(out);
      const clean = (await space.getRecord(out!.id))!;
      assertEquals(clean.runtimeMeta.createdBy, approver, "the successor is authored by the approver");
      assertEquals(clean.runtimeMeta.taint, []);

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
  {
    name: "taint: labels UNION along data parents, so a barrier can tell sources apart",
    run: async (adapter) => {
      // The whole reason for a vocabulary. With one bit, a record touched by a file read and one
      // touched by a network fetch were indistinguishable, so a policy could only say "anything
      // untrusted" — which, after the first tool call, is everything.
      const space = newSpace(adapter);
      const f = (await space.put({ kind: "task", body: { tag: "f" }, taint: ["file"] })).id;
      const n = (await space.put({ kind: "task", body: { tag: "n" }, taint: ["net"] })).id;
      const both = (await space.put({ kind: "task", body: { tag: "both" }, parentIds: [f, n] })).id;
      assertEquals(await taintOf(space, both), ["file", "net"], "union, not OR");
      // Sorted and deduplicated, so equality on the set is stable across write order.
      const dup = (await space.put({ kind: "task", body: { tag: "d" }, parentIds: [both, f], taint: ["net"] })).id;
      assertEquals(await taintOf(space, dup), ["file", "net"]);
    },
  },
  {
    name: "taint: an unknown label is refused, never silently dropped",
    run: async (adapter) => {
      // Dropping it would leave a caller believing it had restricted a record that is in fact
      // unrestricted. The vocabulary is closed for the same reason grant scopes are.
      const space = newSpace(adapter);
      const err = await denied(() => space.put({ kind: "task", body: { tag: "x" }, taint: ["nope"] }));
      assertEquals(err, "invalid_taint");
    },
  },
  {
    name: "taint: the claim barrier is an ALLOWLIST, so an unlisted label bars the claim",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "a" }, taint: ["file"] });
      await space.put({ kind: "task", body: { tag: "a" }, taint: ["net"] });

      // Allows `file`: takes the file one, never the net one. This is what one bit could not do.
      const first = await space.take({ pattern: { kind: "task", match: { tag: "a" } } }, { allowTaint: ["file"] });
      assertEquals(await taintOf(space, first!.record.id), ["file"]);
      const second = await space.take({ pattern: { kind: "task", match: { tag: "a" } } }, { allowTaint: ["file"] });
      assertEquals(second, null, "the net-labelled record is not claimable under a file-only allowlist");

      // An empty allowlist is the strictest barrier, NOT the absence of one.
      await space.put({ kind: "task", body: { tag: "b" }, taint: ["file"] });
      assertEquals(await space.take({ pattern: { kind: "task", match: { tag: "b" } } }, { allowTaint: [] }), null);
      assert(await space.take({ pattern: { kind: "task", match: { tag: "b" } } }), "no barrier still claims it");
    },
  },
  {
    name: "taint: a record written before labels existed is claimable by nothing that states a barrier",
    run: async (adapter) => {
      // A legacy row carries the reserved `unknown`, which no allowlist may contain: the space
      // cannot know what it touched, and inventing a classification is the failure this avoids.
      const space = newSpace(adapter);
      const legacy = (await space.put({ kind: "task", body: { tag: "old" }, taint: ["unknown"] })).id;
      assertEquals(await taintOf(space, legacy), ["unknown"]);
      for (const allow of [[], ["file"], ["file", "net", "foreign"]]) {
        assertEquals(
          await space.take({ pattern: { kind: "task", match: { tag: "old" } } }, { allowTaint: allow }),
          null,
          `allowlist ${JSON.stringify(allow)} must not admit an unclassifiable record`,
        );
      }
      assert(await space.take({ pattern: { kind: "task", match: { tag: "old" } } }), "no barrier still claims it");
    },
  },
  {
    name: "taint: no allowlist may name the reserved label, though a raise still may",
    run: async (adapter) => {
      // "A label no allowlist may contain" was a comment, not a rule: `unknown` passed validation
      // anywhere a label did, so `scope: {taint: "unknown"}` on a grant — or `allowTaint:
      // ["unknown"]` on a take — admitted exactly the pre-labels records the marker holds back.
      // Refused in the WIDENING direction only. A raise is monotone (a client marking its own
      // record unclassifiable only narrows who will claim it), which is how the case above seeds
      // a legacy row at all.
      const space = newSpace(adapter);
      assertEquals(await denied(() => space.take({ pattern: { kind: "task" } }, { allowTaint: ["unknown"] })), "invalid_taint");
      assertEquals(
        await denied(() => space.take({ pattern: { kind: "task" } }, { allowTaint: ["file", "unknown"] })),
        "invalid_taint",
        "…and it cannot ride along beside a real label",
      );
      assertEquals(
        await denied(() =>
          space.put({
            kind: "grant",
            body: { principal: "agent:w", kind: "task", operations: ["take"], scope: { taint: "unknown" } },
          })
        ),
        "invalid_taint",
        "a grant naming it is refused when ASSIGNED, not silently at claim time",
      );

      // The raise direction is unchanged, and an operator can still clear the marker: refusing that
      // would leave a pre-labels record permanently unclaimable by anything stating a barrier.
      const legacy = (await space.put({ kind: "task", body: { tag: "old" }, taint: ["unknown"] })).id;
      const cleared = await space.declassify(legacy, "human:local", { labels: ["unknown"] });
      assertEquals(cleared!.cleared, ["unknown"]);
      assertEquals(await taintOf(space, cleared!.id), [], "the successor is claimable again");
    },
  },
  {
    name: "taint: declassify clears ONE label and leaves the rest standing",
    run: async (adapter) => {
      // "Cleared" without "cleared of what" was the weakness of a bit: an operator who reviewed a
      // file read had to clear a network fetch along with it, or nothing.
      const space = newSpace(adapter);
      const both = (await space.put({ kind: "task", body: { tag: "m" }, taint: ["file", "net"] })).id;
      const partial = await space.declassify(both, "human:local", { labels: ["file"] });
      assertEquals(partial!.cleared, ["file"]);
      assertEquals(partial!.remaining, ["net"]);
      assertEquals(await taintOf(space, partial!.id), ["net"], "the reviewed label goes, the other stays");

      const all = await space.declassify(partial!.id, "human:local");
      assertEquals(await taintOf(space, all!.id), [], "unspecified clears everything, as before");
      // The original is untouched: declassify emits a successor, it does not rewrite.
      assertEquals(await taintOf(space, both), ["file", "net"]);
    },
  },
  {
    name: "taint: `foreign` marks another principal's lineage, and only that",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const alice = (await space.put({ kind: "task", body: { tag: "al" } }, undefined, "agent:alice")).id;
      const own = await space.put({ kind: "result", body: {}, parentIds: [alice] }, undefined, "agent:alice");
      assertEquals(await taintOf(space, own.id), [], "deriving from your own record is not foreign");
      const theirs = await space.put({ kind: "result", body: {}, parentIds: [alice] }, undefined, "agent:bob");
      assertEquals(await taintOf(space, theirs.id), ["foreign"]);
    },
  },
];
