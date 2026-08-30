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
  liveAdvertisements,
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
      .map((r) => [capabilityKey(r.body)!, r] as const),
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
    assertEquals(entry?.body.def?.function.description, "now does it better", "newest wins");
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
    let cat = collapseByTool((await liveFor(c, tool)).values());
    assertEquals(cat.tools.get(tool)?.providers, [w1, w2]);
    assertEquals(cat.tools.get(tool)?.conflicted, false, "replicas are not a conflict");
    assertEquals(cat.conflicts.size, 0, "and nothing is withheld");

    // A DIFFERENT definition under the same name is a real disagreement, and the name is WITHHELD:
    // handing a model one description while either provider may claim the call is the failure this
    // default exists to stop.
    await publishCapability(c, def(tool, "something else entirely"), w2);
    cat = collapseByTool((await liveFor(c, tool)).values());
    assertEquals(cat.tools.has(tool), false, "a contested name is not offered");
    assertEquals(cat.conflicts.get(tool)?.conflicted, true, "it is REPORTED, never silently dropped");
    assertEquals(cat.conflicts.get(tool)?.providers, [w1, w2], "and both claimants are named");

    // The opt-out, for a caller that would rather serve an ambiguous tool than none.
    const lenient = collapseByTool((await liveFor(c, tool)).values(), { onConflict: "newest" });
    assertEquals(lenient.conflicts.size, 0);
    assertEquals(lenient.tools.get(tool)?.conflicted, true, "still flagged");
    assertEquals(lenient.tools.get(tool)?.def.function.description, "something else entirely", "newest wins");
  });
});

Deno.test("[capability] a provider superseding its OWN older definition is an upgrade, not a conflict", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w1 = uniq("w");
    // The noisy case this exists to prevent: on a space with history, every upgraded worker reported
    // as disagreeing with its own past self, once per turn, forever.
    await publishCapability(c, def(tool), w1);
    await publishCapability(c, def(tool, "v2"), w1);
    assertEquals(collapseByTool((await liveFor(c, tool)).values()).tools.get(tool)?.conflicted, false);
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

// ---------------------------------------------------------------------------
// Presence: an advertisement is a claim of intent, so a reader that can tell the difference
// ---------------------------------------------------------------------------
//
// The gap this closes is stated in `retireProviderCapabilities`: a clean shutdown withdraws, a
// crash does not, so a dead fleet's tools stay on the model's list forever. `liveAdvertisements`
// is what lets a reader drop them, and every case here is about its FAIL-OPEN direction — only a
// provider that opted in can ever be dropped.

Deno.test("[capability] an untracked provider is never stale, however dead it is", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w = uniq("w");
    await publishCapability(c, def(tool), w); // no presence claim
    const { entries, unserved } = liveAdvertisements((await liveFor(c, tool)).values(), new Set());

    assertEquals(entries.length, 1, "a provider outside the convention survives an empty live set");
    assertEquals(unserved.size, 0);
    assert(collapseByTool(entries).tools.has(tool));
  });
});

Deno.test("[capability] a tracked provider that stopped beating loses its tools", async () => {
  await withSpace(async (c) => {
    const tool = uniq("calc"), w = uniq("w");
    await publishCapability(c, def(tool), w, undefined, { presence: true });
    const all = [...(await liveFor(c, tool)).values()];

    const live = liveAdvertisements(all, new Set([w]));
    assertEquals(live.entries.length, 1, "beating: the advertisement stands");
    assertEquals(live.unserved.size, 0);

    const dead = liveAdvertisements(all, new Set());
    assertEquals(dead.entries.length, 0, "not beating: the advertisement is gone");
    assertEquals(dead.unserved.get(tool), [w], "and the tool is REPORTED as unserved, not silently dropped");
    assertEquals(collapseByTool(dead.entries).tools.has(tool), false, "so the model is never offered it");
  });
});

Deno.test("[capability] a dead provider cannot manufacture a conflict against a live one", async () => {
  await withSpace(async (c) => {
    // The case that decides whether presence is worth having: two providers disagree about what a
    // name means, and one of them is gone. Judged over the live set, this is not a conflict at all.
    const tool = uniq("read_file"), livePro = uniq("w"), deadPro = uniq("w");
    await publishCapability(c, def(tool, "read a file"), livePro, undefined, { presence: true });
    await publishCapability(c, def(tool, "read a database row"), deadPro, undefined, { presence: true });
    const all = [...(await liveFor(c, tool)).values()];

    assertEquals(collapseByTool(all).conflicts.has(tool), true, "both alive, it IS a conflict and is withheld");

    const { entries, unserved } = liveAdvertisements(all, new Set([livePro]));
    const entry = collapseByTool(entries).tools.get(tool);
    assertEquals(entry?.conflicted, false, "with the rival gone there is nothing to disagree with");
    assertEquals(entry?.providers, [livePro], "and the survivor is the one serving");
    assertEquals(entry?.def.function.description, "read a file", "the live definition wins, whatever the ids say");
    assertEquals(unserved.size, 0, "a tool one provider still serves is not unserved");
  });
});

Deno.test("[capability] starting to beat supersedes an untracked advertisement", async () => {
  await withSpace(async (c) => {
    // The upgrade path, and the reason `presence` is in the content key: the body is otherwise
    // identical, so the re-publish would dedup and the provider would stay unpoliceable forever.
    const tool = uniq("calc"), w = uniq("w");
    await publishCapability(c, def(tool), w);
    await publishCapability(c, def(tool), w, undefined, { presence: true });

    const all = [...(await liveFor(c, tool)).values()];
    assertEquals(all.length, 1, "still one live entry per (provider, tool)");
    assertEquals(all[0].body.presence, true, "and it now claims tracking");
    assertEquals(liveAdvertisements(all, new Set()).entries.length, 0, "so it can now be judged dead");
  });
});

Deno.test("[capability] a provider that STOPS claiming presence is not left claiming it", async () => {
  await withSpace(async (c) => {
    // The flag alternates between two constant keys, so a value it already used REPLAYS that write
    // and the change is silently lost. Same family as the retirement replay above, and the same
    // consequence in reverse: an advertisement left claiming tracking with nothing beating for it
    // is hidden from every reader while the worker serves it.
    const tool = uniq("calc"), w = uniq("w");
    await publishCapability(c, def(tool), w); // started by hand
    await publishCapability(c, def(tool), w, undefined, { presence: true }); // started by a launcher
    await publishCapability(c, def(tool), w); // by hand again

    const all = [...(await liveFor(c, tool)).values()];
    assertEquals(all[0].body.presence, undefined, "the newest advertisement no longer claims tracking");
    assertEquals(liveAdvertisements(all, new Set()).entries.length, 1, "so an empty live set cannot hide it");
  });
});

Deno.test("[capability] not knowing who is alive polices nothing, unlike knowing nobody is", async () => {
  await withSpace(async (c) => {
    // The difference a caller must not collapse. A failed presence read (no grant, an older space)
    // is UNDEFINED; turning it into an empty set says every tracked provider is dead and strips a
    // working fleet's entire tool list.
    const tool = uniq("calc"), w = uniq("w");
    await publishCapability(c, def(tool), w, undefined, { presence: true });
    const all = [...(await liveFor(c, tool)).values()];

    const unknown = liveAdvertisements(all, undefined);
    assertEquals(unknown.entries.length, 1, "unknown keeps the advertisement");
    assertEquals(unknown.unserved.size, 0, "and reports nothing unserved");

    assertEquals(liveAdvertisements(all, new Set()).entries.length, 0, "knowing nobody beats drops it");
  });
});
