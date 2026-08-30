// Tool-worker. Claims `tool_call` records for the tools it serves and acks a `tool_result`.
// Launched by chat.ts with tightly scoped permissions: --allow-read=<sandbox dirs> and
// --allow-net=127.0.0.1:<port> ONLY, and NO --allow-env. So the process that can read
// files cannot reach the network beyond the local space and cannot read secrets: reading
// a file can't lead to exfiltrating it. Config comes via args, not env (it has no env access).
//
// IT HOLDS NO SESSION CREDENTIAL. It used to take `--session-token` and act as the one person it
// was launched for, which is what kept the fleet to one user per process. Two things replaced it:
// the inspection tools moved into the SESSION process (client/session-tools.ts), because a
// delegated run can never carry the ops plane; and anything that must read a caller's data mints a
// DELEGATED RUN per caller instead (agent_docs/plan-delegation.md).

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { makeTools, TOOL_SCHEMAS } from "../tools/files.ts";
import { makeSaveTools, makeShareTools, makeWorkspaceTools, SAVE_SCHEMAS, SHARE_SCHEMAS, WORKSPACE_SCHEMAS } from "../tools/save.ts";
import { conversationKeys, fleetKeyPair } from "../space/keys.ts";
import { arg, argAll, argOn } from "../util.ts";
import { serveTools } from "../../../extensions/ts/tool-worker.ts";

const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-tools run token (the worker's own identity)
const roots = argAll("--dir");
if (!token) {
  // No credential means no default: an unauthenticated client would resolve to the operator under
  // the space's open mode, so a missing flag would silently hand this worker the control plane.
  console.error("tools worker: --token is required");
  Deno.exit(1);
}
// The DURABLE half: this worker re-mints its own run whenever the short one lapses, so a space
// restart or the twelve-hour ceiling does not end it.
const client = new RadiaClient(url, { definitionToken: token });
const fleet = await fleetKeyPair();

// File/compute tools (sandboxed, no client) + the two that write.
// `save_content` writes artifacts as the WORKER (its own `artifact: put`): storing a file is the
// worker's own action. `share_artifact` is the opposite and has to be, because a download
// capability is authorized at MINT time against the CALLER's read grant — minting it as the worker
// would let a scoped user turn an artifact it cannot read into a link that needs no token. That is
// exactly what a delegated run is for, so it takes one per caller.
const tools = {
  ...makeTools(roots),
  ...makeSaveTools(client),
  ...makeShareTools(client),
  // Authors a tree as the WORKER (it holds `workspace: put`), reads one as the caller.
  ...makeWorkspaceTools(client),
};

// Serving is `serveTools` (extensions/ts/tool-worker.ts): it advertises each definition, claims one
// pattern per tool NAME (never `tool_call` wholesale, which would steal other workers' work), runs
// the tool, and answers with the one result envelope. Withdrawal is the LAUNCHER's job, not this
// process's: a worker retiring its own advertisements in a signal handler races its own death, so
// `retireProviderCapabilities` in `client/fleet.ts` does it by provider.
await serveTools(client, {
  provider: "agent:chat-tools",
  // Set by the launcher that beats for this provider (`spawn` in client/fleet.ts), so these
  // advertisements may be judged stale once it stops. Absent when a worker is started by hand.
  presence: argOn("--presence"),
  // A tool ACTS on its arguments, so this worker must open them; its answer is sealed under the
  // same key on the way back (plan-encryption.md phase 4). The private half comes from the
  // launcher's environment, never from disk.
  ...(fleet ? { keys: conversationKeys(client, { kind: "fleet", privateKey: fleet.privateKey, keyId: fleet.keyId }) } : {}),
  tools,
  schemas: [...TOOL_SCHEMAS, ...SAVE_SCHEMAS, ...SHARE_SCHEMAS, ...WORKSPACE_SCHEMAS],
  // A file search can take seconds; say who picked it up and what is running.
  stage: () => "running",
  // These tools WAIT (a file read, a query) rather than work, and one worker serves every
  // session's calls, so serializing them queues one person's behind another's. Code execution is
  // NOT here: it is the exec worker, sized by cores because it spawns a jail per call.
  //
  // A FLAG, not an env read: this worker runs without `--allow-env` on purpose, so reading the
  // environment here crashes it on startup. The launcher, which does have env access, resolves it.
  concurrency: Number(arg("--concurrency") ?? "16"),
});
