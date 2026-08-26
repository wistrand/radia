// The capability registry: tools advertised as records (`extensions/ts/capability.ts`).
//
//   deno task test:extensions
//
// A registry projection, which is why it gets a contract of its own: a bounded read mistaken for a
// population is the most repeated bug in this codebase, and this one decides what tools a model is
// offered. The cases are the four states a (provider, tool) pair can be in — new, unchanged,
// changed, retired-then-revived — plus the collapse that separates replicas from a real conflict.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import {
  CAPABILITY,
  CAPABILITY_KIND,
  capabilityKey,
  type CapabilityBody,
  collapseByTool,
  liveCapabilities,
  publishCapability,
  retireCapability,
  retireProviderCapabilities,
  type ToolDef,
} from "../ts/capability.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7826;

const def = (name: string, description = "does a thing"): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

const shared = await bootSpace(PORT);
await shared.registerKind(CAPABILITY_KIND);

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  return await fn(shared);
}

/** The live projection scoped to one TOOL: latest per (provider, tool), retirements dropped. The
 *  space is shared across tests now, so an unscoped read would see every other test's tools. */
const liveFor = async (c: RadiaClient, tool: string) =>
  new Map(
    [...(await liveCapabilities(c, { tool })).entries]
      .map((r) => [capabilityKey(r.body as CapabilityBody)!, r] as const),
  );

Deno.test("[capability] an unchanged re-publish writes nothing; a changed one supersedes", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w1 = uniq("w");
    await publishCapability(c, def(tool), w1);
    await publishCapability(c, def(tool), w1);
    assertEquals((await c.queryAll({ kind: CAPABILITY, match: { tool } })).length, 1, "the same definition twice is one record");

    await publishCapability(c, def(tool, "now does it better"), w1);
    const all = await c.queryAll({ kind: CAPABILITY, match: { tool } });
    assertEquals(all.length, 2, "a CHANGED definition is a successor, never a 409");
    const entry = (await liveFor(c, tool)).get(`${w1}|${tool}`);
    assertEquals((entry?.body as CapabilityBody).def?.function.description, "now does it better", "newest wins");
  });
});

Deno.test("[capability] retiring drops it from the projection, and re-publishing REVIVES it", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w1 = uniq("w");
    await publishCapability(c, def(tool), w1);
    await retireCapability(c, tool, w1);
    assert(!(await liveFor(c, tool)).has(`${w1}|${tool}`), "a retired tool is not offered");

    // The trap: an unchanged re-publish replays the ORIGINAL write under the same key, so nothing
    // lands and the retirement stays newest. The `:after:` anchor makes it a fresh write.
    await publishCapability(c, def(tool), w1);
    assert((await liveFor(c, tool)).has(`${w1}|${tool}`), "an identical definition after a retirement must come back");
  });
});

Deno.test("[capability] the audit trail survives a withdrawal", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w1 = uniq("w");
    await publishCapability(c, def(tool), w1);
    await retireCapability(c, tool, w1);
    assert((await c.queryAll({ kind: CAPABILITY, match: { tool } })).length >= 2, "retirement is a successor, not a delete");
  });
});

Deno.test("[capability] replicas of one worker are ONE tool; two tools wearing one name are loud", async () => {
  await withSpace(async (c) => {
    // Suffixes off one base so the two providers sort as written, whatever the global counter says.
    const tool = uniq("calc"), base = uniq("w"), w1 = `${base}a`, w2 = `${base}b`;
    // Same definition from two providers: a fleet scaled out. Legitimate, and it must be silent.
    await publishCapability(c, def(tool), w1);
    await publishCapability(c, def(tool), w2);
    let one = collapseByTool((await liveFor(c, tool)).values()).get(tool);
    assertEquals(one?.providers, [w1, w2]);
    assertEquals(one?.conflicted, false, "replicas are not a conflict");

    // A DIFFERENT definition under the same name is a real disagreement.
    await publishCapability(c, def(tool, "something else entirely"), w2);
    one = collapseByTool((await liveFor(c, tool)).values()).get(tool);
    assertEquals(one?.conflicted, true, "two tools wearing one name must be reported");
    assertEquals(one?.def.function.description, "something else entirely", "and the newest still wins");
  });
});

Deno.test("[capability] a provider superseding its OWN older definition is an upgrade, not a conflict", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w1 = uniq("w");
    // The noisy case this exists to prevent: on a space with history, every upgraded worker reported
    // as disagreeing with its own past self, once per turn, forever.
    await publishCapability(c, def(tool), w1);
    await publishCapability(c, def(tool, "v2"), w1);
    assertEquals(collapseByTool((await liveFor(c, tool)).values()).get(tool)?.conflicted, false);
  });
});

Deno.test("[capability] a withdrawal after a revival is a fresh write, not a replay of the first one", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w = uniq("w");
    // The full cycle a restarted fleet performs. Both halves used a CONSTANT key once, and each
    // constant swallowed the write that followed it: an unchanged re-publish replayed the original
    // publish (so a retired tool never came back), and a second withdrawal replayed the first (so a
    // revived tool could never be withdrawn again). Anchoring each on the record it supersedes is
    // what makes the cycle close instead of latching after one turn of it.
    await publishCapability(c, def(tool), w);
    assertEquals(await retireProviderCapabilities(c, [w]), 1);
    assert(!(await liveFor(c, tool)).has(`${w}|${tool}`), "withdrawn");

    await publishCapability(c, def(tool), w); // UNCHANGED definition: revival, not an upgrade
    assert((await liveFor(c, tool)).has(`${w}|${tool}`), "an unchanged definition revives it");

    assertEquals(await retireProviderCapabilities(c, [w]), 1);
    assert(!(await liveFor(c, tool)).has(`${w}|${tool}`), "and the second withdrawal lands");
  });
});

Deno.test("[capability] a launcher withdraws everything its providers advertised", async () => {
  await withSpace(async (c) => {
    const calc = uniq("calc"), time = uniq("time"), read = uniq("read_file");
    const w1 = uniq("w"), w2 = uniq("w");
    await publishCapability(c, def(calc), w1);
    await publishCapability(c, def(time), w1);
    await publishCapability(c, def(read), w2);

    assertEquals(await retireProviderCapabilities(c, [w1]), 2);
    assert(!(await liveFor(c, calc)).has(`${w1}|${calc}`), "the launcher's first tool is withdrawn");
    assert(!(await liveFor(c, time)).has(`${w1}|${time}`), "…and its second");
    assert((await liveFor(c, read)).has(`${w2}|${read}`), "another provider's tools are untouched");
  });
});
