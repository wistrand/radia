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
];

/**
 * Direct SQL against the adapter under test: the only way to simulate a tamper honestly.
 *
 * Every other suite in this directory asserts through the port on purpose. This one has to reach
 * past it, because the threat being modelled is exactly someone who does: an edit made through
 * `Space` would append an event and be a legitimate history rather than a forged one.
 */
async function rawExec(adapter: StorageAdapter, sqlite: string, params: unknown[]): Promise<void> {
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
