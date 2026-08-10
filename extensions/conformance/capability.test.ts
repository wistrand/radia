// The capability registry: tools advertised as records (`extensions/ts/capability.ts`).
//
//   deno task extensions
//
// A registry projection, which is why it gets a contract of its own: a bounded read mistaken for a
// population is the most repeated bug in this codebase, and this one decides what tools a model is
// offered. The cases are the four states a (provider, tool) pair can be in — new, unchanged,
// changed, retired-then-revived — plus the collapse that separates replicas from a real conflict.

import { assert, assertEquals } from "@std/assert";
import { activeByKey, RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import {
  CAPABILITY,
  CAPABILITY_KIND,
  capabilityKey,
  type CapabilityBody,
  collapseByTool,
  publishCapability,
  retireCapability,
  retireProviderCapabilities,
  type ToolDef,
} from "../ts/capability.ts";

const PORT = 7826;
const url = `http://127.0.0.1:${PORT}`;

const def = (name: string, description = "does a thing"): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind(CAPABILITY_KIND);
  try {
    return await fn(c);
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
}

/** What discovery sees: the live projection, latest per (provider, tool), retirements dropped. */
const live = async (c: RadiaClient) =>
  activeByKey<CapabilityBody>(await c.queryAll({ kind: CAPABILITY }), capabilityKey);

Deno.test("[capability] an unchanged re-publish writes nothing; a changed one supersedes", async () => {
  await withSpace(async (c) => {
    await publishCapability(c, def("calc"), "w1");
    await publishCapability(c, def("calc"), "w1");
    assertEquals((await c.queryAll({ kind: CAPABILITY })).length, 1, "the same definition twice is one record");

    await publishCapability(c, def("calc", "now does it better"), "w1");
    const all = await c.queryAll({ kind: CAPABILITY });
    assertEquals(all.length, 2, "a CHANGED definition is a successor, never a 409");
    const entry = (await live(c)).get("w1|calc");
    assertEquals((entry?.body as CapabilityBody).def?.function.description, "now does it better", "newest wins");
  });
});

Deno.test("[capability] retiring drops it from the projection, and re-publishing REVIVES it", async () => {
  await withSpace(async (c) => {
    await publishCapability(c, def("calc"), "w1");
    await retireCapability(c, "calc", "w1");
    assert(!(await live(c)).has("w1|calc"), "a retired tool is not offered");

    // The trap: an unchanged re-publish replays the ORIGINAL write under the same key, so nothing
    // lands and the retirement stays newest. The `:after:` anchor makes it a fresh write.
    await publishCapability(c, def("calc"), "w1");
    assert((await live(c)).has("w1|calc"), "an identical definition after a retirement must come back");
  });
});

Deno.test("[capability] the audit trail survives a withdrawal", async () => {
  await withSpace(async (c) => {
    await publishCapability(c, def("calc"), "w1");
    await retireCapability(c, "calc", "w1");
    assert((await c.queryAll({ kind: CAPABILITY })).length >= 2, "retirement is a successor, not a delete");
  });
});

Deno.test("[capability] replicas of one worker are ONE tool; two tools wearing one name are loud", async () => {
  await withSpace(async (c) => {
    // Same definition from two providers: a fleet scaled out. Legitimate, and it must be silent.
    await publishCapability(c, def("calc"), "w1");
    await publishCapability(c, def("calc"), "w2");
    let one = collapseByTool(await live(c)).get("calc");
    assertEquals(one?.providers, ["w1", "w2"]);
    assertEquals(one?.conflicted, false, "replicas are not a conflict");

    // A DIFFERENT definition under the same name is a real disagreement.
    await publishCapability(c, def("calc", "something else entirely"), "w2");
    one = collapseByTool(await live(c)).get("calc");
    assertEquals(one?.conflicted, true, "two tools wearing one name must be reported");
    assertEquals(one?.def.function.description, "something else entirely", "and the newest still wins");
  });
});

Deno.test("[capability] a provider superseding its OWN older definition is an upgrade, not a conflict", async () => {
  await withSpace(async (c) => {
    // The noisy case this exists to prevent: on a space with history, every upgraded worker reported
    // as disagreeing with its own past self, once per turn, forever.
    await publishCapability(c, def("calc"), "w1");
    await publishCapability(c, def("calc", "v2"), "w1");
    assertEquals(collapseByTool(await live(c)).get("calc")?.conflicted, false);
  });
});

Deno.test("[capability] a launcher withdraws everything its providers advertised", async () => {
  await withSpace(async (c) => {
    await publishCapability(c, def("calc"), "w1");
    await publishCapability(c, def("time"), "w1");
    await publishCapability(c, def("read_file"), "w2");

    assertEquals(await retireProviderCapabilities(c, ["w1"]), 2);
    const offered = collapseByTool(await live(c));
    assertEquals([...offered.keys()], ["read_file"], "another provider's tools are untouched");
  });
});
