// Authorization (M1 slice): kind-scoped grants as records, enforced by Space.authorize.
// A privileged principal (human:* or the supervisor) has operator access; any other principal
// needs a matching grant record (kind + op); reserved control kinds (grant/signal) are
// write-protected. Grants are records, so this runs on every adapter — authorize reads them
// through the normal query path. Enforcement WIRING lives at the HTTP boundary; this exercises
// the policy directly.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter); // default supervisor = agent:supervisor
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return space;
}

async function denied(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

export const authSuites: Suite[] = [
  {
    name: "privileged principals (human:* and the supervisor) have operator access",
    run: async (adapter) => {
      const space = newSpace(adapter);
      assert(space.isPrivileged("human:local"));
      assert(space.isPrivileged("agent:supervisor"));
      assert(!space.isPrivileged("agent:worker"));
      assert(!space.isPrivileged("run:123"));
      // no grants exist, yet privileged principals pass every op
      await space.authorize("human:local", "put", "task");
      await space.authorize("agent:supervisor", "take", "task");
      await space.authorize("human:ceo", "query", "anything");
    },
  },
  {
    name: "a non-privileged principal is denied without a grant, allowed with one (kind + op scoped)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // denied before any grant
      assertEquals(await denied(() => space.authorize("agent:worker", "take", "task")), "forbidden");

      // supervisor assigns a take grant for `task` (grants are records)
      await space.put({ kind: "grant", body: { principal: "agent:worker", kind: "task", operations: ["take"] } });

      // now the granted op on the granted kind passes
      await space.authorize("agent:worker", "take", "task");
      // but a different op is still denied (op-scoped)
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "task")), "forbidden");
      // and a different kind is still denied (kind-scoped)
      assertEquals(await denied(() => space.authorize("agent:worker", "take", "job")), "forbidden");
      // and a different principal is unaffected
      assertEquals(await denied(() => space.authorize("agent:other", "take", "task")), "forbidden");
    },
  },
  {
    name: "grant bodies are validated; wildcard kinds are rejected",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // wildcard kind rejected (grants are kind-scoped, never wildcard)
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "*", operations: ["put"] } })),
        "wildcard_grant",
      );
      // unknown operation rejected
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: ["delete"] } })),
        "invalid_grant",
      );
      // empty operations rejected
      assertEquals(
        await denied(() => space.put({ kind: "grant", body: { principal: "agent:w", kind: "task", operations: [] } })),
        "invalid_grant",
      );
    },
  },
  {
    name: "a grant does not authorize writing reserved control kinds (assigned, never self-declared)",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // even with a put grant for `grant`, a non-privileged principal cannot write grants/signal
      await space.put({ kind: "grant", body: { principal: "agent:worker", kind: "grant", operations: ["put"] } });
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "grant")), "forbidden");
      assertEquals(await denied(() => space.authorize("agent:worker", "put", "signal")), "forbidden");
      // a human/supervisor still may
      await space.authorize("human:local", "put", "grant");
      await space.authorize("agent:supervisor", "put", "signal");
    },
  },
];
