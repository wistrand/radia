// Phase 4 conformance: idempotency with the critical ordering. The stored response
// is checked BEFORE lease validation, so a retry after a lost response replays the
// original outcome instead of falsely returning lease_lost. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function code(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

export const idempotencySuites: Suite[] = [
  {
    // The invariant is not only "idempotency before lease validation"; it is idempotency before
    // every check that can have CHANGED since the first attempt. Authorizing the emitted result
    // eagerly in core turned the retry of an already-succeeded ack into `forbidden` the moment the
    // worker's put grant narrowed in between (audit package W5).
    name: "ack: a retry replays even after the worker's put grant has narrowed",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      space.registerKind({ kind: "answer", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
      // Grants are records; the space's own identity may write them.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["take"] } });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "answer", operations: ["put"] } });

      const { id } = await space.put({ kind: "task", body: { tag: "t" } });
      const claim = await space.take({ recordId: id }, { leaseSeconds: 300, owner: "agent:w" });
      assert(claim, "expected a claim");
      const key = "ack-once";
      const result = { kind: "answer", body: { tag: "t" } };
      assertEquals((await space.ack(claim!.lease, result, key, "agent:w")).status, "ok");

      // The grant is narrowed to something the result no longer satisfies. A pattern-scoped
      // successor on the same triple supersedes the unpatterned one.
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "answer", operations: ["put"], pattern: { tag: "other" } },
      });
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "answer", operations: ["put"], retired: true },
      });

      // The retry must REPLAY, not be refused: the write it describes already happened.
      const again = await space.ack(claim!.lease, result, key, "agent:w");
      assertEquals(again.status, "ok", "the stored response, not a refusal");
      assertEquals((await space.query({ kind: "answer" }, 10)).length, 1, "and nothing written twice");
    },
  },
  {
    name: "put replay with the same key returns the same id and inserts once",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { tag: "x" } }, "put-1");
      const b = await space.put({ kind: "task", body: { tag: "x" } }, "put-1");
      assertEquals(a.id, b.id);
      assertEquals((await space.query({ kind: "task" })).length, 1); // not duplicated
    },
  },
  {
    name: "put with a reused key but different request is a conflict",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "x" } }, "put-2");
      assertEquals(
        await code(() => space.put({ kind: "task", body: { tag: "DIFFERENT" } }, "put-2")),
        "idempotency_conflict",
      );
    },
  },
  {
    name: "ack replay after a lost response returns the stored ok, NOT lease_lost",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "x" } });
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t, "expected a take");

      const key = "ack-1";
      const r1 = await space.ack(t!.lease, { kind: "result", body: { ok: true } }, key);
      assertEquals(r1.status, "ok");
      const resultId = r1.status === "ok" ? r1.resultId : undefined;

      // The lease is now consumed. Replaying the SAME key replays the stored response,
      // because idempotency is checked before lease validation.
      const r2 = await space.ack(t!.lease, { kind: "result", body: { ok: true } }, key);
      assertEquals(r2.status, "ok"); // <-- not lease_lost
      assertEquals(r2.status === "ok" ? r2.resultId : "x", resultId);

      // Exactly one result record was emitted (no duplicate side effect).
      assertEquals((await space.query({ kind: "result" })).length, 1);

      // Contrast: a retry WITHOUT the key hits the consumed lease and is fenced.
      const bare = await space.ack(t!.lease, { kind: "result", body: { ok: true } });
      assertEquals(bare.status, "lease_lost");
    },
  },
  {
    name: "ack with a reused key but different request is a conflict",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "x" } });
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      await space.ack(t!.lease, { kind: "result", body: { ok: true } }, "ack-2");
      assertEquals(
        await code(() => space.ack(t!.lease, { kind: "result", body: { changed: true } }, "ack-2")),
        "idempotency_conflict",
      );
    },
  },
];
