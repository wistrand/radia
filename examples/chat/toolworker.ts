// Tool-worker. Claims `tool_call` records for the tools it serves and acks a `tool_result`.
// Launched by chat.ts with tightly scoped permissions: --allow-read=<sandbox dirs> and
// --allow-net=127.0.0.1:<port> ONLY, and NO --allow-env. So the process that can read
// files cannot reach the network beyond the local space and cannot read secrets — reading
// a file can't lead to exfiltrating it. Config comes via args, not env (it has no env access).

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { makeTools } from "./tools.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Deno.args.length; i++) if (Deno.args[i] === name) out.push(Deno.args[i + 1]);
  return out;
}

const url = arg("--url") ?? "http://127.0.0.1:7788";
const roots = argAll("--dir");
const tools = makeTools(roots);
const client = new RadiaClient(url);

await agentLoop(client, {
  name: "tools",
  templates: Object.keys(tools).map((tool) => ({ kind: "tool_call", match: { tool } })),
  handle: async (rec) => {
    const callId = rec.id;
    const b = rec.body as { tool: string; args?: Record<string, unknown> };
    try {
      const output = await tools[b.tool](b.args ?? {});
      return { kind: "tool_result", body: { callId, ok: true, output } };
    } catch (e) {
      return { kind: "tool_result", body: { callId, ok: false, output: String(e) } };
    }
  },
});
