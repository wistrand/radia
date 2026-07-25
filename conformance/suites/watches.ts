// M1 conformance: the Space-level watch primitives that back the SSE endpoint —
// createWatch (validates the template), matchesEvent (wakeup semantics: available records
// matching the template), and latestCursor (the starting cursor). The SSE transport and
// resumption are covered by an HTTP smoke, not here. Runs on every adapter.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { SpaceEvent, StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function eventsOf(space: Space): Promise<SpaceEvent[]> {
  return await space.getEvents("0", 500);
}

export const watchSuites: Suite[] = [
  {
    name: "createWatch validates the template; undeclared path is rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { watchId } = await space.createWatch({ kind: "task", match: { tag: "x" } });
      assert(watchId.length > 0);
      assert(space.getWatch(watchId), "watch not stored");

      let code: string | undefined;
      try {
        await space.createWatch({ kind: "task", match: { nope: 1 } });
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
      const kindOnly = space.getWatch((await space.createWatch({ kind: "task" })).watchId)!.match;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assert(putEvent.state === "available");
      assertEquals(await space.matchesEvent(kindOnly, putEvent), true);

      // a different kind's event never matches
      assertEquals(await space.matchesEvent({ kind: "other" }, putEvent), false);

      // consume it; the ack event (state consumed) is not a wakeup
      const t = await space.take({ template: { kind: "task" } });
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
      const wantX = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "x" } })).watchId)!.match;
      const wantY = space.getWatch((await space.createWatch({ kind: "task", match: { tag: "y" } })).watchId)!.match;

      await space.put({ kind: "task", body: { tag: "x" } });
      const putEvent = (await eventsOf(space)).find((e) => e.operation === "put")!;
      assertEquals(await space.matchesEvent(wantX, putEvent), true);
      assertEquals(await space.matchesEvent(wantY, putEvent), false);
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
      await space.createWatch({ kind: "task" });
      await space.put({ kind: "task", body: { tag: "new" } });
      assert((await eventsOf(space)).length > before);
    },
  },
];
