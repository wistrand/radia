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
// This is a script, not a `*.test.ts`: `deno task conformance` is for PORT contracts, not examples.

import { RadiaClient, readRegistry } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import {
  type CapabilityBody,
  capabilityKey,
  collapseByTool,
  publishCapability,
  retireProviderCapabilities,
} from "./space/capability.ts";
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
  const view = await readRegistry<CapabilityBody>(
    (limit, after) => client.query({ kind: "capability" }, limit, { dir: "desc", after }),
    capabilityKey,
  );
  return collapseByTool(view.entries);
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
// calling a name whose description no longer matched what might claim it.
await publishCapability(client, def("read_file", "read a row from the database"), B);
tools = await toolList();
check("one name with two meanings is still one entry", tools.get("read_file")?.providers.length === 2, tools.get("read_file")?.providers.join(","));
check("…but it is reported as CONFLICTED", tools.get("read_file")?.conflicted === true);
check(
  "…and the newest definition is the one the model gets",
  tools.get("read_file")?.def.function.description === "read a row from the database",
  tools.get("read_file")?.def.function.description,
);

// ---- publishing is still cheap ----
const countCaps = async () => (await client.query({ kind: "capability" }, 500)).length;
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

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
