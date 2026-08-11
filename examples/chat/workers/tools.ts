// Tool-worker. Claims `tool_call` records for the tools it serves and acks a `tool_result`.
// Launched by chat.ts with tightly scoped permissions: --allow-read=<sandbox dirs> and
// --allow-net=127.0.0.1:<port> ONLY, and NO --allow-env. So the process that can read
// files cannot reach the network beyond the local space and cannot read secrets: reading
// a file can't lead to exfiltrating it. Config comes via args, not env (it has no env access).

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { makeTools, TOOL_SCHEMAS } from "../tools/files.ts";
import { INSPECT_SCHEMAS, makeInspectTools } from "../../../extensions/ts/agent-tools.ts";
import { makeRemediateTools, REMEDIATE_SCHEMAS } from "../../../extensions/ts/agent-tools.ts";
import { makeSaveTools, makeShareTools, makeWorkspaceTools, SAVE_SCHEMAS, SHARE_SCHEMAS, WORKSPACE_SCHEMAS } from "../tools/save.ts";
import { arg, argAll } from "../util.ts";
import { serveTools } from "../../../extensions/ts/tool-worker.ts";


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
// The DURABLE half: this worker re-mints its own run whenever the short one lapses, so a space
// restart or the twelve-hour ceiling does not end it. The session client below is deliberately the
// opposite, for the reason stated there.
const client = new RadiaClient(url, { definitionToken: token }); // claims tool_calls, publishes capabilities
// The space_* inspection/remediation tools act as the SESSION principal, not the worker, so the
// answer matches what the person asking is allowed to see (a scoped session gets 403 on /ops).
const spaceClient = new RadiaClient(url, { token: sessionToken });
// It needs its own keep-alive, and that is easy to miss: `agentLoop` below renews the credential of
// the client it is GIVEN, so the worker's own token stays live while this second one, the only one
// the space_* tools use, lapsed after fifteen minutes and stayed lapsed. It cannot recover on its
// own either, because it deliberately holds no definition token: the durable half mints sessions
// for a person, and a worker that could mint them would be a worker that can be that person at
// will. So renewal to the run ceiling is the whole of what this half can have.
const sessionAlive = new AbortController();
spaceClient.keepAlive(sessionAlive.signal, (reason) => {
  // A ceiling reached, or the run stopped. Say it once, plainly: the alternative is every space_*
  // call answering `token_expired` with nothing saying why, which is what a person actually saw.
  console.error(`tools worker: the session credential is over (${reason}); space_* tools will fail until the chat is restarted`);
});
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

// Serving is `serveTools` (extensions/ts/tool-worker.ts): it advertises each definition, claims one
// pattern per tool NAME (never `tool_call` wholesale, which would steal other workers' work), runs
// the tool, and answers with the one result envelope. Withdrawal is the LAUNCHER's job, not this
// process's: a worker retiring its own advertisements in a signal handler races its own death, so
// `retireProviderCapabilities` in `client/fleet.ts` does it by provider.
await serveTools(client, {
  provider: "agent:chat-tools",
  tools,
  schemas: [...TOOL_SCHEMAS, ...INSPECT_SCHEMAS, ...REMEDIATE_SCHEMAS, ...SAVE_SCHEMAS, ...SHARE_SCHEMAS, ...WORKSPACE_SCHEMAS],
  // A file search or a space query can take seconds; say who picked it up and what is running.
  stage: () => "running",
  // These tools WAIT (a space query, a file read, a fetch) rather than work, and one worker serves
  // every session's tool calls, so serializing them queues one person's `space_query` behind
  // another's. Code execution is NOT here: it is the exec worker, deliberately left at 1 because
  // it spawns a jail per call (agent_docs/plan-scaling.md).
  //
  // A FLAG, not an env read: this worker runs without `--allow-env` on purpose (the fleet grants
  // it a port and its tool roots and nothing else), so reading the environment here crashes it on
  // startup. The launcher, which does have env access, resolves the value and passes it.
  concurrency: Number(arg("--concurrency") ?? "4"),
});
sessionAlive.abort(); // the loop returned, so nothing is left to keep a credential alive for
