// M1 conformance: the Space-level watch primitives that back the SSE endpoint.
// createWatch (validates the pattern), matchesEvent (wakeup semantics: available records
// matching the pattern), and latestCursor (the starting cursor). The SSE transport and
// resumption are covered by an HTTP smoke, not here. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { SpaceEvent, StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import type { RadiaError } from "../../src/core/errors.ts";

async function forbidden(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as RadiaError).code === "forbidden";
  }
}

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function eventsOf(space: Space): Promise<SpaceEvent[]> {
  return await space.getEvents("0", 500);
}

/** The suite drives the Space directly as the local operator. */
const OWNER = "human:local";

export const watchSuites: Suite[] = [
  {
    name: "createWatch validates the pattern; undeclared path is rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { watchId } = await space.createWatch({ kind: "task", match: { tag: "x" } }, OWNER);
      assert(watchId.length > 0);
      assert(space.getWatch(watchId, OWNER), "watch not stored");

      let code: string | undefined;
      try {
        await space.createWatch({ kind: "task", match: { nope: 1 } }, OWNER);
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      assertEquals(code, "undeclared_path");
    },
  },
  {
    name: "matchesEvent: available matching records wake; consumed do not",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const kindOnly = space.getWatch((await space.createWatch({ kind: "task" }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assert(putEvent.state === "available");
      assertEquals(await space.matchesEvent(kindOnly, putEvent), true);

      // a different kind's event never matches
      assertEquals(
        await space.matchesEvent({ request: { kind: "other" }, match: { kind: "other" }, cursor0: "0", owner: OWNER }, putEvent),
        false,
      );

      // consume it; the ack event (state consumed) is not a wakeup
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      await space.ack(t!.lease);
      const ackEvent = (await eventsOf(space)).find((e) => e.operation === "ack")!;
      assertEquals(await space.matchesEvent(kindOnly, ackEvent), false);
    },
  },
  {
    name: "matchesEvent honors predicates (fetches the record)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wantX = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "x" } }, OWNER)).watchId, OWNER)!;
      const wantY = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "y" } }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assertEquals(await space.matchesEvent(wantX, putEvent), true);
      assertEquals(await space.matchesEvent(wantY, putEvent), false);
    },
  },
  {
    name: "a record created by ack wakes a watch on the RESULT's kind",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wantResult = space.getWatch((await space.createWatch({ kind: "result" }, OWNER)).watchId, OWNER)!;

      await space.put({ kind: "task", body: { tag: "x" } });
      const t = await space.take({ pattern: { kind: "task" } });
      assert(t);
      const acked = await space.ack(t!.lease, { kind: "result", body: { ok: true } });
      assert(acked.status === "ok");

      // The ack event is `consumed` and carries the parent's kind, so it can never be the
      // wakeup: the result needs a `put` event of its own or the watcher sleeps forever.
      const wakeups: SpaceEvent[] = [];
      for (const e of await eventsOf(space)) {
        if (await space.matchesEvent(wantResult, e)) wakeups.push(e);
      }
      assertEquals(wakeups.length, 1, "expected exactly one wakeup for the result record");
      assertEquals(wakeups[0].operation, "put");
      assertEquals(wakeups[0].recordId, acked.resultId);
    },
  },
  {
    name: "a fresh watch starts after existing events (cursor from now)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "old" } });
      const before = (await eventsOf(space)).length;
      assert(before >= 1);
      // createWatch records the current seq as its start cursor; new events come after it.
      await space.createWatch({ kind: "task" }, OWNER);
      await space.put({ kind: "task", body: { tag: "new" } });
      assert((await eventsOf(space)).length > before);
    },
  },
  {
    name: "interest: a dry run reports who would receive a record, before it is written",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run, runToken: _t } = await space.mintRun(definitionToken);

      // The run declares what it listens for. Authorship is server-assigned, so the body never
      // claims which run it belongs to.
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" } } }, undefined, run);

      const hit = await space.matchingInterests("task", { tag: "x" });
      assertEquals(hit.interests.length, 1, "the interest matches a record it would claim");
      assertEquals(hit.interests[0].run, run);
      assertEquals(hit.interests[0].agent, "agent:w", "the agent is resolved, not taken from the body");

      // The candidate need not exist: that is the point of asking before the write.
      const miss = await space.matchingInterests("task", { tag: "y" });
      assertEquals(miss.interests.length, 0, "a record outside the pattern reaches nobody");
      assertEquals((await space.matchingInterests("other", { tag: "x" })).interests.length, 0, "wrong kind");
    },
  },
  {
    name: "interest: liveness comes from the RUN, so a stopped worker stops appearing",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task" } }, undefined, run);
      assertEquals((await space.matchingInterests("task", {})).interests.length, 1);

      // A crashed worker never retires its interest, so the record outlives the process. Presence
      // must never be read as "someone is listening"; the run is the fact.
      await space.stopRun(run);
      assertEquals(
        (await space.matchingInterests("task", {})).interests.length,
        0,
        "a stopped run's interest is dead even though the record is still there",
      );
    },
  },
  {
    name: "interest: retiring withdraws exactly one pattern and leaves the others",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" } } }, undefined, run);
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "y" } } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { tag: "x" })).interests.length, 1);
      assertEquals((await space.matchingInterests("task", { tag: "y" })).interests.length, 1);

      // One entry per (author, kind, pattern), so a retirement targets one of them.
      await space.put({ kind: "interest", body: { kind: "task", match: { tag: "x" }, retired: true } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { tag: "x" })).interests.length, 0, "withdrawn");
      assertEquals((await space.matchingInterests("task", { tag: "y" })).interests.length, 1, "the sibling stands");
    },
  },
  {
    name: "interest: an unpatterned interest takes everything of its kind",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { definitionToken } = await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
      ]);
      const { run } = await space.mintRun(definitionToken);
      await space.put({ kind: "interest", body: { kind: "task" } }, undefined, run);
      assertEquals((await space.matchingInterests("task", { anything: 1 })).interests.length, 1);
      assertEquals((await space.matchingInterests("task", {})).interests.length, 1);
    },
  },
  {
    name: "revalidateWatch: a revoked grant ends a watch that already exists",
    run: async (adapter) => {
      // The defect this closes: a watch compiled its scope ONCE, at creation, and then streamed
      // under it until the client disconnected. Revocation is a successor record, so `authorizeWatch`
      // saw it immediately and every future watch was refused; the one already streaming was not.
      const space = newSpace(adapter);
      const grant = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: grant });
      const { watchId } = await space.createWatch({ kind: "task" }, "agent:w");

      await space.put({ kind: "grant", body: { ...grant, retired: true } });
      assert(
        await forbidden(() => space.revalidateWatch(watchId, "agent:w")),
        "the live watch must lose its scope when the grant is revoked, not at disconnect",
      );
    },
  },
  {
    name: "revalidateWatch: a NARROWED grant narrows the live watch, and does not ratchet",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const wide = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: wide });
      const { watchId } = await space.createWatch({ kind: "task" }, "agent:w");
      assertEquals(space.getWatch(watchId, "agent:w")!.match.where, undefined, "unrestricted to start");

      // Replace the unscoped grant with a pattern-scoped one: the stream must pick up the narrower
      // scope, not keep the one it compiled at creation.
      await space.put({ kind: "grant", body: { ...wide, retired: true } });
      await space.put({ kind: "grant", body: { ...wide, pattern: { tag: "a" } } });
      const narrowed = await space.revalidateWatch(watchId, "agent:w");
      assert(narrowed.match.where, "the live watch did not pick up the grant's pattern");

      // Re-deriving from the ORIGINAL request, not from the already-narrowed match: widening the
      // grant back must restore the wide scope. Recombining the compiled match instead would
      // ratchet it tighter on every check and never let go.
      await space.put({ kind: "grant", body: { ...wide, pattern: { tag: "a" }, retired: true } });
      await space.put({ kind: "grant", body: wide });
      assertEquals(
        (await space.revalidateWatch(watchId, "agent:w")).match.where,
        undefined,
        "scope must be re-derived from the client's original pattern, not the narrowed one",
      );
    },
  },
];
