// Tool-worker. Claims `tool_call` records for the tools it serves and acks a `tool_result`.
// Launched by chat.ts with tightly scoped permissions: --allow-read=<sandbox dirs> and
// --allow-net=127.0.0.1:<port> ONLY, and NO --allow-env. So the process that can read
// files cannot reach the network beyond the local space and cannot read secrets — reading
// a file can't lead to exfiltrating it. Config comes via args, not env (it has no env access).

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { progress } from "../space/progress.ts";
import { makeTools, TOOL_SCHEMAS } from "../tools/files.ts";
import { INSPECT_SCHEMAS, makeInspectTools } from "../tools/space.ts";
import { makeRemediateTools, REMEDIATE_SCHEMAS } from "../tools/space.ts";
import { makeSaveTools, SAVE_SCHEMAS } from "../tools/save.ts";
import { arg, argAll } from "../util.ts";
import { publishCapability } from "../space/capability.ts";


const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-tools run token — the worker's own identity
const sessionToken = arg("--session-token"); // the session principal for space_* tools (absent = operator)
const roots = argAll("--dir");
const client = new RadiaClient(url, token ? { token } : {}); // claims tool_calls, publishes capabilities
// The space_* inspection/remediation tools act as the SESSION principal, not the worker: operator
// for role=admin (full /ops access), the scoped agent:chat-user for role=user (so /ops calls 403).
const spaceClient = new RadiaClient(url, sessionToken ? { token: sessionToken } : {});
// File/compute tools (sandboxed, no client) + space inspection + remediation (session-scoped).
// `save_content` writes artifacts as the WORKER (its own token, `artifact: put`), not as the
// session: storing a file is the worker's own action, unlike the space_* tools, which act as the
// session principal so a scoped user cannot launder /ops access through a privileged worker.
const tools = { ...makeTools(roots), ...makeInspectTools(spaceClient), ...makeRemediateTools(spaceClient), ...makeSaveTools(client) };

// Publish this worker's capabilities as `capability` records so agents can DISCOVER the
// available tools from the space (no hard-coded tool list). In a real system this
// registration would be grant-gated — an untrusted worker publishing a tool is a threat.
const schemas = [...TOOL_SCHEMAS, ...INSPECT_SCHEMAS, ...REMEDIATE_SCHEMAS, ...SAVE_SCHEMAS];
for (const name of Object.keys(tools)) {
  const def = schemas.find((s) => s.function.name === name);
  if (def) await publishCapability(client, def);
}

await agentLoop(client, {
  name: "tools",
  templates: Object.keys(tools).map((tool) => ({ kind: "tool_call", match: { tool } })),
  handle: async (rec, c) => {
    const callId = rec.id;
    const b = rec.body as { tool: string; args?: Record<string, unknown>; conversationId?: string; owner?: string };
    // A file search or a space query can take seconds; say who picked it up and what is running.
    await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "running", by: "agent:chat-tools", note: b.tool }, [callId]);
    try {
      const output = await tools[b.tool](b.args ?? {}, { callId, conversationId: b.conversationId, owner: b.owner });
      return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: true, output } };
    } catch (e) {
      return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: String(e) } };
    }
  },
});
