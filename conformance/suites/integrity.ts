// The tamper-evident event chain (M1), on every adapter.
//
// The tests that matter here are the ones that TAMPER: a chain nobody has seen reject anything is
// a chain nobody has tested. Each case edits the database directly, the way a restore, a support
// session or an attacker would, and asserts on the FIRST divergence rather than merely on `ok`.
//
// The guarantee under test is deliberately narrow and the suite says which half is which. A chain
// stored in the database it protects catches corruption and careless edits; catching a REWRITE
// needs the signature, whose key lives outside the database. Both are exercised.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { SealKey } from "../../src/core/seal.ts";
import { CHAIN_GENESIS } from "../../sdk/ts/wire.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

/** A deterministic key, so a failure means a behaviour change rather than a coin flip. */
function sealKey(): Promise<SealKey> {
  return SealKey.fromBytes(new Uint8Array(32).fill(7), "test");
}

/** Some history worth sealing: a put, a claim, and an ack that emits a result. */
async function work(space: Space): Promise<void> {
  await space.put({ kind: "task", body: { tag: "a" } });
  await space.put({ kind: "task", body: { tag: "b" } });
  const t = await space.take({ pattern: { kind: "task" } });
  assert(t);
  await space.ack(t!.lease, { kind: "result", body: { ok: true } });
}

export const integritySuites: Suite[] = [
  {
    name: "sealing covers the log and is idempotent",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);

      const first = await space.sealEvents();
      assert(first.sealed > 0, "nothing was sealed over a space with history");
      assertEquals(first.head?.idx, first.sealed - 1, "the chain is dense from 0");

      // Running again seals nothing: the events are already covered. A sealer that re-seals would
      // fork the chain on every call.
      assertEquals((await space.sealEvents()).sealed, 0);

      const r = await space.verifyIntegrity();
      assertEquals(r.ok, true);
      assertEquals(r.checked, first.sealed);
      assertEquals(r.sealed, first.sealed);
      assertEquals(r.unsealed, 0);
    },
  },
  {
    // `appendSeals` was batched into one INSERT for Postgres (2026-08-11: 500 sequential
    // inserts cost 650ms, paid inside every diagnostics poll). The contract it must keep,
    // whatever the dialect: it lands the CONTIGUOUS PREFIX from the head, and a position another
    // sealer already holds stops the prefix AND leaves nothing of ours beyond the gap — or the
    // chain grows a hole the caller, which re-reads the head at `prefix`, never revisits.
    name: "appendSeals lands a contiguous prefix and yields conflicting positions whole",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents(); // seal the existing log so the next idx is known
      const head = await adapter.sealHead();
      const base = head ? head.idx + 1 : 0;
      const prev = head ? head.hash : "genesis";
      // Three would-be links at base, base+1, base+2. Plant the MIDDLE one first, as a rival
      // sealer's row, then attempt all three.
      const mk = (idx: number, tag: string) => ({
        idx,
        eventId: `ev-${idx}-${tag}`,
        cursor: `c-${idx}`,
        seq: 1000 + idx,
        hash: `hash-${idx}-${tag}`,
        prevHash: prev,
      });
      // Plant the rival's row at base+1 directly (appendSeals inserts what it is given; it does
      // not itself check contiguity against the head, the caller does). This stands in for a
      // second sealer that reached base+1 first.
      assertEquals(await adapter.appendSeals([mk(base + 1, "rival")]), 1, "the rival's own write lands");
      const got = await adapter.appendSeals([mk(base, "mine"), mk(base + 1, "mine"), mk(base + 2, "mine")]);
      assertEquals(got, 1, "only base is contiguous; base+1 was taken, so the prefix stops there");
      // base+1 must still be the RIVAL's row, and base+2 (a stray win past the gap) must be gone.
      const seals = await adapter.getSeals(base - 1, 10);
      const at = (idx: number) => seals.find((s) => s.idx === idx);
      assertEquals(at(base)?.eventId, `ev-${base}-mine`, "our contiguous row landed");
      assertEquals(at(base + 1)?.eventId, `ev-${base + 1}-rival`, "the rival's row stands");
      assertEquals(at(base + 2), undefined, "a win beyond the gap was discarded, not left as a hole's far side");
    },
  },
  {
    name: "the chain continues across a restart rather than starting over",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      const before = await space.sealEvents();

      // A second Space over the same adapter is what a restart looks like to the chain: the head
      // comes from storage, never from memory, or every restart would begin a new chain that
      // verifies perfectly and proves nothing about what came before.
      const restarted = newSpace(adapter);
      await restarted.put({ kind: "task", body: { tag: "c" } });
      const after = await restarted.sealEvents();
      assert(after.sealed > 0, "the restarted space sealed nothing");
      assertEquals(after.head!.idx, before.head!.idx + after.sealed);
      assertEquals((await restarted.verifyIntegrity()).ok, true);
    },
  },
  {
    name: "an edited event body is caught, at its own position",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();
      const events = await space.getEvents();
      const target = events[1];

      // The edit an auditor is looking for: rewriting what an event says happened, leaving the
      // chain structurally intact.
      await rawExec(adapter, "update events set operation = 'nack' where id = ?", [target.id]);

      const r = await space.verifyIntegrity();
      assertEquals(r.ok, false);
      assertEquals(r.failure?.reason, "hash_mismatch");
      assertEquals(r.failure?.eventId, target.id);
      assertEquals(r.failure?.idx, 1, "the report names the position, not just the fact");
    },
  },
  {
    name: "a deleted event is caught, and so is a deleted LINK",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();
      const events = await space.getEvents();

      await rawExec(adapter, "delete from events where id = ?", [events[2].id]);
      const gone = await space.verifyIntegrity();
      assertEquals(gone.ok, false);
      assertEquals(gone.failure?.reason, "missing_event");

      // Deleting the seal too is the cover-up, and it is the case a naive verifier misses: what is
      // left is a shorter chain that recomputes perfectly. The dense-index check is what catches it.
      await rawExec(adapter, "delete from event_seal where event_id = ?", [events[2].id]);
      const covered = await space.verifyIntegrity({ seal: false });
      assertEquals(covered.ok, false);
      assertEquals(covered.failure?.reason, "gap");
      assertEquals(covered.failure?.idx, 2);
    },
  },
  {
    name: "record CONTENT is inside the chain, not merely referenced by it",
    run: async (adapter) => {
      // Without the content hash on the put event, the chain proves the events happened in this
      // order and says nothing about whether a record body is still what it was: editing a body
      // directly would leave a perfect chain. This is that test.
      const space = newSpace(adapter);
      const put = await space.put({ kind: "task", body: { tag: "original" } });
      await space.sealEvents();
      assertEquals((await space.verifyIntegrity()).ok, true);

      await rawExec(adapter, "update events set body_sha256 = ? where record_id = ?", ["0".repeat(64), put.id]);
      const r = await space.verifyIntegrity();
      assertEquals(r.ok, false);
      assertEquals(r.failure?.reason, "hash_mismatch");
    },
  },
  {
    name: "an UNSIGNED chain cannot detect a rewrite, and a signed one can",
    run: async (adapter) => {
      // The honest limit of the feature, pinned so nobody quotes the guarantee as broader than it
      // is. An attacker who can edit a row can also recompute every hash after it.
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();
      const events = await space.getEvents();

      // Rewrite an event AND rebuild the chain over it, which is what recomputing looks like.
      await rawExec(adapter, "update events set operation = 'nack' where id = ?", [events[1].id]);
      await rawExec(adapter, "delete from event_seal", []);
      const rebuilt = await space.sealEvents();
      assert(rebuilt.sealed > 0);
      assertEquals((await space.verifyIntegrity()).ok, true, "an unsigned chain accepts a rebuild; that is the known limit");

      // Now the same forgery under a key the database does not hold. The rewriter can rebuild the
      // chain and cannot sign it, so the seals over it fail.
      const signed = newSpace(adapter);
      signed.sealKey = await sealKey();
      await rawExec(adapter, "delete from event_seal", []);
      await signed.sealEvents();
      assertEquals((await signed.verifyIntegrity()).ok, true);

      const forger = newSpace(adapter); // same database, no key
      await rawExec(adapter, "update events set operation = 'release' where id = ?", [events[2].id]);
      await rawExec(adapter, "delete from event_seal", []);
      await forger.sealEvents(); // rebuilt, unsigned

      const auditor = newSpace(adapter);
      auditor.sealKey = await sealKey();
      const caught = await auditor.verifyIntegrity();
      assertEquals(caught.ok, false);
      assertEquals(caught.failure?.reason, "bad_signature");
    },
  },
  {
    // ROTATION vs FORGERY. Both leave links this space's current key cannot verify, and the two want
    // opposite responses: one is a key to supply, the other is a chain to distrust. A signature
    // carries the id of the key that made it so the report can tell them apart.
    name: "a link signed under a retired key verifies with it, and is un-checkable without it",
    run: async (adapter) => {
      const first = new Uint8Array(32).fill(7);
      const second = new Uint8Array(32).fill(9);

      const space = newSpace(adapter);
      space.sealKey = await SealKey.fromBytes(first, "test");
      for (let i = 0; i < 3; i++) await space.put({ kind: "doc", body: { i } });
      await space.sealEvents();
      assertEquals((await space.verifyIntegrity()).ok, true);

      // Rotated, old key retained: the chain still verifies end to end.
      const rotated = newSpace(adapter);
      rotated.sealKey = await SealKey.fromBytes(second, "test", [first]);
      assertEquals((await rotated.verifyIntegrity()).ok, true, "a retained key must still verify what it signed");

      // Rotated, old key gone: un-checkable, and it must NOT read as tampering.
      const blind = newSpace(adapter);
      blind.sealKey = await SealKey.fromBytes(second, "test");
      const report = await blind.verifyIntegrity();
      assertEquals(report.ok, false);
      assertEquals(report.failure?.reason, "unknown_key", "a rotation was reported as a forgery");

      // And new links sign under the CURRENT key, so a chain can be re-signed forward.
      await rotated.put({ kind: "doc", body: { after: "rotation" } });
      await rotated.sealEvents();
      assertEquals((await rotated.verifyIntegrity()).ok, true);
    },
  },
  {
    name: "a tampered SEAL is caught by the link it no longer matches",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();

      await rawExec(adapter, "update event_seal set hash = ? where idx = 1", ["f".repeat(64)]);
      const r = await space.verifyIntegrity({ seal: false });
      assertEquals(r.ok, false);
      // The hash at 1 no longer matches its own event, which is found before the broken link at 2.
      assertEquals(r.failure?.idx, 1);
      assertEquals(r.failure?.reason, "hash_mismatch");
    },
  },
  {
    name: "an empty space verifies, and says it checked nothing",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const r = await space.verifyIntegrity();
      assertEquals(r.ok, true);
      assertEquals(r.sealed, 0);
      assertEquals(r.checked, 0);
      assertEquals(r.head, undefined, "there is no head to quote on an unsealed space");
    },
  },
  {
    name: "the first link chains from genesis, so the head cannot be re-rooted",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();
      const [first] = await adapter.getSeals(-1, 1);
      assertEquals(first.idx, 0);
      assertEquals(first.prevHash, CHAIN_GENESIS);
    },
  },

  // --- event-log truncation (plan-gc.md phase 3, step 2): honest GC is anchored and attested;
  // everything that is not stays a tamper verdict. The truncated states are planted with raw SQL
  // in the sweep's REQUIRED order (statement sealed first, then events and seals together),
  // because the sweep itself is step 3.

  {
    name: "an anchored truncation with its sealed statement verifies, and says what it cannot check",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      assert(seals.length >= 4, "expected enough links to truncate");
      const anchor = seals[2];

      const { attested } = await space.attestEventTruncation(anchor);
      assert(attested, "the statement must seal before any deletion");
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

      const r = await space.verifyIntegrity();
      assertEquals(r.ok, true);
      assertEquals(r.truncated, { anchorIdx: anchor.idx, swept: anchor.idx + 1, attested: true });
      // The anchor's content cannot be rechecked, so it is not counted among the verified links.
      assertEquals(r.checked, r.sealed - anchor.idx - 1);
      // And the truncation IS the horizon phase 1's boundary reads back.
      assertEquals((await adapter.eventHorizon("0")).horizon, { cursor: anchor.cursor, swept: anchor.idx + 1 });
    },
  },
  {
    name: "a sweep in flight verifies: statement sealed, planned anchor not yet content-swept",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);

      const { attested } = await space.attestEventTruncation(seals[2]);
      assert(attested);
      // Oldest-first pair deletion has reached idx 1: idx 0 fully gone, idx 1 intact, the planned
      // anchor (2) untouched. The chain begins BELOW the attested anchor, which is honest.
      await rawExec(adapter, "delete from events where seq <= ?", [seals[0].seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [seals[1].idx]);

      const r = await space.verifyIntegrity();
      assertEquals(r.ok, true);
      assertEquals(r.truncated, { anchorIdx: seals[1].idx, swept: seals[1].idx, attested: true });
    },
  },
  {
    name: "a truncation nothing attests is a tamper verdict, and deeper-than-attested too",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);

      // No statement at all: the chain merely begins late. Honest GC never produces this.
      await rawExec(adapter, "delete from events where seq <= ?", [seals[1].seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [seals[1].idx]);
      const bare = await space.verifyIntegrity();
      assertEquals(bare.ok, false);
      assertEquals(bare.failure?.reason, "unattested_truncation");
      assertEquals(bare.truncated?.attested, false);

      // Attest an anchor, then truncate DEEPER than declared: the statement survives but does
      // not cover the chain's actual start, which is exactly a tamper hiding behind honest GC.
      const { attested } = await space.attestEventTruncation(seals[2]);
      assert(attested);
      await rawExec(adapter, "delete from events where seq <= ?", [seals[3].seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [seals[3].idx]);
      const deeper = await space.verifyIntegrity();
      assertEquals(deeper.ok, false);
      assertEquals(deeper.failure?.reason, "unattested_truncation");
    },
  },
  {
    name: "a mid-chain gap past the anchor is still a gap",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      const anchor = seals[1];
      const { attested } = await space.attestEventTruncation(anchor);
      assert(attested);
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);
      assertEquals((await space.verifyIntegrity()).ok, true);

      // The cover-up shape, inside the retained suffix: a pair deleted mid-chain. Anchoring must
      // not have widened what a gap means.
      await rawExec(adapter, "delete from events where seq = ?", [seals[3].seq]);
      await rawExec(adapter, "delete from event_seal where idx = ?", [seals[3].idx]);
      const r = await space.verifyIntegrity({ seal: false });
      assertEquals(r.ok, false);
      assertEquals(r.failure?.reason, "gap");
      assertEquals(r.failure?.idx, seals[3].idx);
    },
  },
  {
    name: "deleting the horizon statement un-attests the anchor",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      const anchor = seals[1];
      const { attested } = await space.attestEventTruncation(anchor);
      assert(attested);
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);
      assertEquals((await space.verifyIntegrity()).ok, true);

      // The statement sits at the head here, so deleting its pair leaves a SHORTER chain that
      // recomputes perfectly: the one variant the dense-idx check cannot catch. What catches it
      // is the anchor losing its attestation.
      const events = await space.getEvents("0");
      const stmt = events.find((e) => e.operation === "gc");
      assert(stmt, "the horizon statement must be in the retained log");
      await rawExec(adapter, "delete from events where seq = ?", [stmt!.seq]);
      await rawExec(adapter, "delete from event_seal where seq = ?", [stmt!.seq]);
      const r = await space.verifyIntegrity({ seal: false });
      assertEquals(r.ok, false);
      assertEquals(r.failure?.reason, "unattested_truncation");
    },
  },
  {
    name: "an anchor whose signature does not verify is a rebuilt chain, not GC",
    run: async (adapter) => {
      const space = newSpace(adapter);
      space.sealKey = await sealKey();
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      const anchor = seals[2];
      const { attested } = await space.attestEventTruncation(anchor);
      assert(attested);
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

      // The anchor's hash cannot be recomputed (its event is gone), so its SIGNATURE is the only
      // thing tying the retained suffix to the history it claims. Forge it and the whole anchored
      // construction must collapse.
      await rawExec(adapter, "update event_seal set sig = ? where idx = ?", ["AAAA", anchor.idx]);
      const r = await space.verifyIntegrity({ seal: false });
      assertEquals(r.ok, false);
      assertEquals(r.failure?.reason, "bad_signature");
      assertEquals(r.failure?.idx, anchor.idx);
    },
  },
  {
    name: "unsigned: an attested truncation passes with the caveat the whole chain carries",
    run: async (adapter) => {
      // Extends the pinned posture above ("an UNSIGNED chain accepts a rebuild"): unsigned
      // anchoring is naive-edit evidence only, so an attested truncation is accepted and the
      // report's `signed: false` is what says how much that means. An UNATTESTED one still fails,
      // which is exactly the naive edit the bare chain exists to catch.
      const space = newSpace(adapter);
      await work(space);
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      const anchor = seals[1];
      const { attested } = await space.attestEventTruncation(anchor);
      assert(attested);
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

      const r = await space.verifyIntegrity();
      assertEquals(r.ok, true);
      assertEquals(r.signed, false);
      assertEquals(r.truncated, { anchorIdx: anchor.idx, swept: anchor.idx + 1, attested: true });
    },
  },
];

/**
 * Direct SQL against the adapter under test: the only way to simulate a tamper honestly.
 *
 * Every other suite in this directory asserts through the port on purpose. This one has to reach
 * past it, because the threat being modelled is exactly someone who does: an edit made through
 * `Space` would append an event and be a legitimate history rather than a forged one. Exported
 * for the gc suite, which plants event-truncation states the same way (the sweep that would
 * create them honestly is M2, not built).
 */
export async function rawExec(adapter: StorageAdapter, sqlite: string, params: unknown[]): Promise<void> {
  const a = adapter as unknown as {
    db?: { prepare: (s: string) => { run: (...p: unknown[]) => unknown } };
    sql?: { query: (text: string, params?: unknown[]) => Promise<unknown> };
  };
  if (a.db) { // SQLite: `?` placeholders
    a.db.prepare(sqlite).run(...(params as (string | number | null)[]));
    return;
  }
  // Postgres dialect: the same statement with $n placeholders.
  let i = 0;
  const pg = sqlite.replace(/\?/g, () => `$${++i}`);
  await a.sql!.query(pg, params);
}
