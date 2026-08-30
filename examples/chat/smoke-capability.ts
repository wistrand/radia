// Tool advertisements: whose tool is whose, and what happens when a worker goes away.
//
//   deno run -A examples/chat/smoke-capability.ts
//
// No model, no API key. The registry key used to be the bare tool name, which conflated two cases
// that need opposite answers: replicas of one worker (identical definitions, legitimate, and the
// normal shape of scaling out) and two DIFFERENT tools wearing one name (a silent takeover, where
// the model is handed one description while either worker may claim the call). Keying by
// `(provider, tool)` keeps both entries and `collapseByTool` decides which case it is.
//
// The withdrawal half is the honest one. A capability record is an advertisement, never evidence of
// liveness, so a clean shutdown retires and a crash cannot. That is the whole reason the chat's tool
// timeout still names two possibilities instead of blaming the worker.
//
// This is a script, not a `*.test.ts`: `deno task test:runtime` is for PORT contracts, not examples.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { declareTeamKinds } from "../../extensions/ts/team.ts";
import {
  collapseByTool,
  liveAdvertisements,
  liveCapabilities,
  publishCapability,
  retireProviderCapabilities,
} from "../../extensions/ts/capability.ts";
import { announcePresence, livePresence } from "../../extensions/ts/presence.ts";
import { FLEET_PRESENCE } from "./space/kinds.ts";
import type { ToolDef } from "./provider/openrouter.ts";

const PORT = 7804;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
const client = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(client);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

/** The tool list exactly as `ToolSet.refresh` builds it: the shared projection, not a copy. A
 *  re-implementation here could only ever prove that this file's own loop was right. */
async function toolList() {
  const view = await liveCapabilities(client);
  return collapseByTool(view.entries).tools;
}

/** The names withheld because live providers disagree about them. */
async function conflictList() {
  const view = await liveCapabilities(client);
  return collapseByTool(view.entries).conflicts;
}

const def = (name: string, description: string): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

const READ_FILE = def("read_file", "read a file from disk");
const A = "agent:alpha";
const B = "agent:beta";

// ---- an upgrade is not a disagreement ----
// The bug this exists for was live and loud. Records written before providers existed carry no
// provider, so they key under `?`; treating that as a rival meant every upgraded worker was reported
// as disagreeing with its own past self, on every turn, forever. An anonymous advertisement is an
// OLDER one, not somebody else's.
await publishCapability(client, def("legacy_tool", "the old description"));
await publishCapability(client, def("legacy_tool", "the new description"), A);
let tools = await toolList();
check("a pre-namespacing record is superseded, not treated as a rival", tools.get("legacy_tool")?.conflicted === false);
check("…and the named provider's newer description wins", tools.get("legacy_tool")?.def.function.description === "the new description", tools.get("legacy_tool")?.def.function.description);
check("…and only the real provider is listed", tools.get("legacy_tool")?.providers.join(",") === "agent:alpha", tools.get("legacy_tool")?.providers.join(","));

// With nobody claiming it, the anonymous record is still the tool: an old space keeps working.
await publishCapability(client, def("orphan_tool", "nobody claimed this"));
tools = await toolList();
check("an unclaimed legacy tool still appears", tools.get("orphan_tool")?.def.function.description === "nobody claimed this");
check("…and is not reported as conflicted", tools.get("orphan_tool")?.conflicted === false);

// ---- replicas: the same tool from two workers is ONE tool ----
await publishCapability(client, READ_FILE, A);
await publishCapability(client, READ_FILE, B);
tools = await toolList();
check("two workers serving the same tool advertise one name", tools.size === 3, `${tools.size} tools`);
check("…and both are recorded as providers", tools.get("read_file")?.providers.join(",") === "agent:alpha,agent:beta", tools.get("read_file")?.providers.join(","));
check("…and identical definitions are not a conflict", tools.get("read_file")?.conflicted === false);

// ---- a genuine collision: one name, two meanings ----
// Under the flat key this was invisible: the newer record replaced the older one and the model kept
// calling a name whose description no longer matched what might claim it. Reporting it was the
// first fix and was not enough, since either provider may still claim the call: the name is now
// WITHHELD, so the model is told nothing rather than told one of two answers.
await publishCapability(client, def("read_file", "read a row from the database"), B);
tools = await toolList();
let contested = await conflictList();
check("a contested name is not offered to the model", !tools.has("read_file"), [...tools.keys()].join(","));
check("…it is REPORTED instead of silently dropped", contested.get("read_file")?.conflicted === true);
check("…and both claimants are named", contested.get("read_file")?.providers.join(",") === "agent:alpha,agent:beta", contested.get("read_file")?.providers.join(","));

// The opt-out, for a caller that would rather serve an ambiguous tool than none.
const lenient = collapseByTool((await liveCapabilities(client)).entries, { onConflict: "newest" });
check("newest-wins survives as an explicit choice", lenient.tools.get("read_file")?.conflicted === true);
check(
  "…and then the newest definition is the one the model gets",
  lenient.tools.get("read_file")?.def.function.description === "read a row from the database",
  lenient.tools.get("read_file")?.def.function.description,
);

// ---- publishing is still cheap ----
const countCaps = async () => (await client.queryOldest({ kind: "capability" }, 500)).length;
const before = await countCaps();
await publishCapability(client, READ_FILE, A);
check("re-publishing an unchanged advertisement writes nothing", (await countCaps()) === before, `${before} records`);

// A DIFFERENT provider publishing the same definition must still write: the read-before-write is
// narrowed to this provider, or the first worker to advertise a name would suppress every other.
await publishCapability(client, def("write_file", "write a file"), A);
const beforeSecond = await countCaps();
await publishCapability(client, def("write_file", "write a file"), B);
check("a second provider's identical advertisement is not suppressed", (await countCaps()) === beforeSecond + 1);

// ---- withdrawal ----
await retireProviderCapabilities(client, [B]);
tools = await toolList();
check("retiring a provider leaves the tools its peers still serve", tools.has("read_file") && tools.has("write_file"), [...tools.keys()].join(","));
check(
  "…and read_file falls back to the remaining provider's definition",
  tools.get("read_file")?.def.function.description === "read a file from disk",
  tools.get("read_file")?.def.function.description,
);
check("…and is no longer conflicted", tools.get("read_file")?.conflicted === false);
check("…and only that provider remains", tools.get("read_file")?.providers.join(",") === "agent:alpha", tools.get("read_file")?.providers.join(","));

await retireProviderCapabilities(client, [A]);
tools = await toolList();
check("retiring the last provider withdraws the tool entirely", !tools.has("read_file") && !tools.has("write_file"), [...tools.keys()].join(","));
check("…and the history is still there", (await countCaps()) > 0, `${await countCaps()} records`);

// Reviving is the trap retire-then-republish sets everywhere in this codebase: if the publish key
// collided with the retirement it replaces, the write would be an idempotent replay and the tool
// would stay dead.
await publishCapability(client, READ_FILE, A);
tools = await toolList();
check("a restarted worker's tool comes back", tools.has("read_file"), [...tools.keys()].join(","));

// ---------------------------------------------------------------------------
// A crashed fleet's tools stop being offered
// ---------------------------------------------------------------------------
//
// Everything above is about a CLEAN shutdown, which is the case a crash never reaches. A provider
// that beats (extensions/ts/presence.ts) can be judged dead by a reader instead, which is what
// makes the tool list reflect who is actually serving rather than everyone who ever started.

{
  const beating = "agent:beating", crashed = "agent:crashed";
  const stop = new AbortController();
  const handle = await announcePresence(client, FLEET_PRESENCE, beating, { signal: stop.signal });
  await publishCapability(client, def("tracked_tool", "served by a live worker"), beating, undefined, { presence: true });
  await publishCapability(client, def("orphan_tracked", "served by nobody"), crashed, undefined, { presence: true });

  const filtered = async () => {
    const view = await liveCapabilities(client);
    const live = new Set((await livePresence(client, FLEET_PRESENCE)).live.keys());
    const { entries, unserved } = liveAdvertisements(view.entries, live);
    return { tools: collapseByTool(entries).tools, unserved };
  };

  let f = await filtered();
  check("a beating provider's tool is offered", f.tools.has("tracked_tool"));
  check("a provider that claims presence and never beats is treated as gone", f.unserved.has("orphan_tracked"), [...f.unserved.keys()].join(","));
  check("…so its tool is hidden rather than offered", !f.tools.has("orphan_tracked"));

  // The crash: no retirement, no withdrawal, the advertisement still standing.
  await handle.retire();
  f = await filtered();
  check("a fleet that stops beating loses its tools with no withdrawal", !f.tools.has("tracked_tool"), [...f.tools.keys()].join(","));
  check("…and the session is told which provider went away", f.unserved.get("tracked_tool")?.join(",") === beating);
  check("…while an untracked provider's tools are untouched", f.tools.has("read_file"), [...f.tools.keys()].join(","));

  stop.abort();
}

// SHARING A SPACE, and MIGRATING one. Two independent failures the chat hit on a real space, both
// of which stopped it starting at all rather than degrading.
//
// 1. SHARING. `radia team add` extends `artifact` and `capability` with a `team` path and keys
//    capability by (provider, tool, team). Declaring this app's list flat drops those, which the
//    runtime refuses outright, so the chat would not start on a space a team had touched.
{
  await declareTeamKinds(client);
  const first = await registerChatKinds(client).then(() => "ok", (e) => String(e).slice(0, 110));
  check("the chat starts on a space `radia team add` has touched", first === "ok", first);
  const again = await registerChatKinds(client).then(() => "ok", (e) => String(e).slice(0, 110));
  check("…and starts again, since a declaration already live must not be re-put", again === "ok", again);

  const rows = await client.queryAll<{ kind: string; contentKey?: string[]; indexedPaths: { path: string }[] }>({ kind: "kind_def" });
  const newest = new Map<string, { contentKey?: string[]; indexedPaths: { path: string }[] }>();
  for (const r of rows) if (!newest.has(r.body.kind)) newest.set(r.body.kind, r.body); // newest-first
  const artifact = newest.get("artifact")!.indexedPaths.map((p) => p.path).sort().join(",");
  check("…keeping BOTH apps' paths on the kind they share", artifact.includes("team") && artifact.includes("conversationId"), artifact);
  check(
    "…and the team's wider content key, which this app alone would have narrowed",
    newest.get("capability")!.contentKey?.join(",") === "provider,tool,team",
    newest.get("capability")!.contentKey?.join(","),
  );
}

// 2. MIGRATING, which needs a space this build has never touched: a kind of this app's OWN gaining
//    a `contentKey` in a later build reads as an incompatible change to the declaration an older
//    space stored. That is acknowledged once, and the SECOND run must then write nothing, because
//    `supersedes` is not part of the declaration key and re-putting without it collides.
{
  const PORT2 = 7829;
  const old = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT2)],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe2 = new RadiaClient(`http://127.0.0.1:${PORT2}`);
  for (let i = 0; i < 100; i++) {
    try {
      await probe2.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c2 = new RadiaClient(`http://127.0.0.1:${PORT2}`, { token: operatorToken(`http://127.0.0.1:${PORT2}`) });
  // The chat of an earlier build: `fleet_key` before it became a latest-wins registry.
  await c2.registerKind({ kind: "fleet_key", indexedPaths: [{ path: "keyId", type: "keyword" }], claimable: false });

  const migrated = await registerChatKinds(c2).then(() => "ok", (e) => String(e).slice(0, 110));
  check("the chat starts on a space an OLDER build of itself set up", migrated === "ok", migrated);
  const restarted = await registerChatKinds(c2).then(() => "ok", (e) => String(e).slice(0, 110));
  check("…and starts again after the acknowledged migration", restarted === "ok", restarted);

  const fk = (await c2.queryAll<{ kind: string; contentKey?: string[] }>({ kind: "kind_def" }))
    .find((r) => r.body.kind === "fleet_key")!;
  check("…with this app's own key migration landed", fk.body.contentKey?.join(",") === "keyId", fk.body.contentKey?.join(",") ?? "(none)");
  old.kill();
  await old.status;
}

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
