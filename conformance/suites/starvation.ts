// Why unclaimed work is unclaimed: the orphaned/starving split in `diagnostics` (M1).
//
// The report used to call every old available record "stale", which conflates two failures whose
// remedies point in opposite directions. Nothing is listening for an ORPHAN, so waiting never helps
// and somebody has to start a worker or fix a pattern; a STARVING record has a listener that is not
// claiming, so the fault is over there. These cases pin the distinction, and equally pin what the
// split refuses to claim when the evidence is thin.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";

/**
 * Diagnostics calls a record stale after `diagnosticsStaleSeconds`. NEGATIVE, so the threshold sits
 * in the future and every put is stale on arrival: at 0 the comparison is `availableAt < now`,
 * which is false inside the same millisecond and makes the whole suite a clock race. Same shape as
 * the fault suite's negative `leaseSeconds`, and for the same reason.
 */
function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter, { diagnosticsStaleSeconds: -1 });
  space.registerKind({ kind: "task", indexedPaths: [{ path: "op", type: "keyword" }] });
  space.registerKind({ kind: "chore", indexedPaths: [] });
  return space;
}

/** A live interest, published the way `agentLoop` does: a run that exists, owning the record. */
async function listener(space: Space, agent: string, pattern: { kind: string; match?: Record<string, unknown> }): Promise<string> {
  const { definitionToken } = await space.createAgentDefinition(agent, [
    { principal: agent, kind: "interest", operations: ["put", "query"] },
    { principal: agent, kind: pattern.kind, operations: ["take", "query"] },
  ]);
  const { run } = await space.mintRun(definitionToken);
  await space.put({ kind: "interest", body: pattern }, undefined, run);
  return run;
}

export const starvationSuites: Suite[] = [
  {
    name: "work nobody listens for is ORPHANED, not merely old",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await listener(space, "agent:worker", { kind: "task", match: { op: "upper" } });
      await space.put({ kind: "task", body: { op: "upper" } }); // a listener matches this
      await space.put({ kind: "task", body: { op: "reverse" } }); // nothing matches this one

      const d = await space.diagnostics();
      assertEquals(d.staleAvailable.count, 2);
      const split = d.staleAvailable.split;
      assert(split, "the split is missing on a space that publishes interests");
      assertEquals(split.orphaned.count, 1);
      assertEquals(split.starving.count, 1);
      // The report names WHICH record, because "1 orphaned" is not something anyone can act on.
      assertEquals((split.orphaned.sample[0] as { kind: string }).kind, "task");
    },
  },
  {
    name: "a whole kind with no listener is orphaned, pattern or not",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await listener(space, "agent:worker", { kind: "task" }); // the whole kind, no pattern
      await space.put({ kind: "task", body: { op: "anything" } });
      await space.put({ kind: "chore", body: {} }); // a kind nobody registered an interest in

      const split = (await space.diagnostics()).staleAvailable.split;
      assert(split);
      assertEquals(split.starving.count, 1, "an interest with no match takes the whole kind");
      assertEquals(split.orphaned.count, 1);
      assertEquals((split.orphaned.sample[0] as { kind: string }).kind, "chore");
    },
  },
  {
    name: "a listener whose RUN is gone stops counting as one",
    run: async (adapter) => {
      // The reason presence of an interest record is never taken as proof: a clean shutdown retires
      // its interests and a crash cannot, so liveness is asked of the run.
      const space = newSpace(adapter);
      const runId = await listener(space, "agent:worker", { kind: "task" });
      await space.put({ kind: "task", body: { op: "upper" } });
      assertEquals((await space.diagnostics()).staleAvailable.split?.starving.count, 1);

      await space.stopRun(runId);
      const after = (await space.diagnostics()).staleAvailable.split;
      // The split SURVIVES a fleet going away, and reports the work as orphaned. That is the
      // difference between "nobody ever declared what they listen for", where no answer is
      // possible, and "the workers that declared it have stopped", which is a finding.
      assert(after, "a dead fleet still declared its interests, so the split is still answerable");
      assertEquals(after.orphaned.count, 1, "a stopped run is not listening");
      assertEquals(after.starving.count, 0);
    },
  },
  {
    name: "a space that publishes NO interests gets no split, rather than a false alarm",
    run: async (adapter) => {
      // Publishing an interest is best-effort in `agentLoop` (a worker without the grant is
      // invisible), so an empty registry means "nobody said", not "nobody is listening". Reporting
      // every record as orphaned there would be a confident answer about the wrong thing.
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { op: "upper" } });
      const d = await space.diagnostics();
      assertEquals(d.staleAvailable.count, 1);
      assertEquals(d.staleAvailable.split, undefined);
    },
  },
  {
    name: "the split always carries its caveat, and no stale work means no split",
    run: async (adapter) => {
      const space = newSpace(adapter);
      assertEquals((await space.diagnostics()).staleAvailable.split, undefined, "nothing stale, nothing to split");

      await listener(space, "agent:worker", { kind: "task" });
      await space.put({ kind: "task", body: { op: "upper" } });
      const split = (await space.diagnostics()).staleAvailable.split;
      assert(split);
      // Both counts rest on a registry that is only ever best-effort. A number without that
      // sentence beside it gets quoted as a census of the fleet.
      assert(/best-effort/.test(split.caveat), `the caveat is missing: ${split.caveat}`);
      assertEquals(split.complete, true);
    },
  },
];
