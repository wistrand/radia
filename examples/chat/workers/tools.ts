// Tool-worker. Claims `tool_call` records for the tools it serves and acks a `tool_result`.
// Launched by chat.ts with tightly scoped permissions: --allow-read=<sandbox dirs> and
// --allow-net=127.0.0.1:<port> ONLY, and NO --allow-env. So the process that can read
// files cannot reach the network beyond the local space and cannot read secrets: reading
// a file can't lead to exfiltrating it. Config comes via args, not env (it has no env access).

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { progress } from "../space/progress.ts";
import { makeTools, TOOL_SCHEMAS } from "../tools/files.ts";
import { INSPECT_SCHEMAS, makeInspectTools } from "../tools/space.ts";
import { makeRemediateTools, REMEDIATE_SCHEMAS } from "../tools/space.ts";
import { makeSaveTools, makeShareTools, makeWorkspaceTools, SAVE_SCHEMAS, SHARE_SCHEMAS, WORKSPACE_SCHEMAS } from "../tools/save.ts";
import { arg, argAll } from "../util.ts";
import { publishCapability } from "../space/capability.ts";


const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-tools run token (the worker's own identity)
const sessionToken = arg("--session-token"); // the session principal the space_* tools act as
const roots = argAll("--dir");
if (!token || !sessionToken) {
  // No credential means no default: an unauthenticated client would resolve to the operator under
  // the space's open mode, so a missing flag would silently hand this worker the control plane.
  console.error("tools worker: --token and --session-token are both required");
  Deno.exit(1);
}
const client = new RadiaClient(url, { token }); // claims tool_calls, publishes capabilities
// The space_* inspection/remediation tools act as the SESSION principal, not the worker, so the
// answer matches what the person asking is allowed to see (a scoped session gets 403 on /ops).
const spaceClient = new RadiaClient(url, { token: sessionToken });
// File/compute tools (sandboxed, no client) + space inspection + remediation (session-scoped).
// `save_content` writes artifacts as the WORKER (its own token, `artifact: put`), not as the
// session: storing a file is the worker's own action, unlike the space_* tools, which act as the
// session principal so a scoped user cannot launder /ops access through a privileged worker.
// `share_artifact` is on the session side of that line for the same reason: it READS an artifact
// to decide whether a link may exist for it.
const tools = {
  ...makeTools(roots),
  ...makeInspectTools(spaceClient),
  ...makeRemediateTools(spaceClient),
  ...makeSaveTools(client),
  // SESSION client, like the space_* tools and unlike save_content: a download capability is
  // authorized at mint time against the caller's read grant, so minting it as the worker would let
  // a scoped user turn an artifact it cannot read into a link that needs no token.
  ...makeShareTools(spaceClient),
  // Authors a tree as the WORKER (it holds `workspace: put`), stamped with the session's owner.
  ...makeWorkspaceTools(client),
};

// Publish this worker's capabilities as `capability` records so agents can DISCOVER the
// available tools from the space (no hard-coded tool list). In a real system this
// registration would be grant-gated: an untrusted worker publishing a tool is a threat.
const schemas = [...TOOL_SCHEMAS, ...INSPECT_SCHEMAS, ...REMEDIATE_SCHEMAS, ...SAVE_SCHEMAS, ...SHARE_SCHEMAS, ...WORKSPACE_SCHEMAS];
for (const name of Object.keys(tools)) {
  const def = schemas.find((s) => s.function.name === name);
  if (def) await publishCapability(client, def);
}

// Credential renewal is `agentLoop`'s job, not each worker's: every process running that loop is
// long-lived by definition, and copying the keep-alive into five workers is five places to forget.
await agentLoop(client, {
  name: "tools",
  patterns: Object.keys(tools).map((tool) => ({ kind: "tool_call", match: { tool } })),
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
