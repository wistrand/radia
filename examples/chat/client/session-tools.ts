// The inspection tools, served BY THE SESSION rather than by a worker.
//
// These are the one tool set that cannot be delegated, and the reason is two guards that exist on
// purpose (agent_docs/plan-delegation.md). `space_stats` and `space_doctor` read `/v0/ops/*`, and a
// delegated run holds NO ops powers, because that refusal is what stops a worker's `observe` riding
// along on a caller's request. The other route onto that plane is a self-scoped read grant, and the
// intersection DROPS `scope: {createdBy: "self"}`, because "self" is relative to the holder and a
// delegated run's writer is the worker. Both are right, and together they mean a delegated run can
// never answer these.
//
// So the answer is the one plan-scaling.md reached before delegation existed: move them to where
// the property holds by construction. The session serves its own inspection tools with its own
// credential, and the plumbing is DELETED rather than generalised — no worker holds a person's
// session token for its lifetime, which is what stopped the fleet from being shared.
//
// NOT ADVERTISED. `serveTools` publishes a `capability` record per schema it is given, and one per
// session per tool is a registry entry per user for tools nobody else can serve: every other
// session would see them, offer them, and never be able to claim one. Passing no schemas keeps them
// callable without advertising ("a tool with no definition is served but never advertised"), and
// the client injects the definitions into its own `ToolSet` instead. That is setup, not substrate
// knowledge: a session genuinely does know what it itself serves.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { INSPECT_SCHEMAS, makeInspectTools, makeRemediateTools, REMEDIATE_SCHEMAS } from "../../../extensions/ts/agent-tools.ts";
import type { ToolDef } from "../provider/openrouter.ts";
import { serveTools } from "../../../extensions/ts/tool-worker.ts";
import type { ConversationKey } from "../../../extensions/ts/encrypted.ts";

/** The definitions the session serves, for the client to offer the model directly. */
export const SESSION_TOOL_SCHEMAS: ToolDef[] = [...INSPECT_SCHEMAS, ...REMEDIATE_SCHEMAS];

/** Every tool name served in-process, so the session's `tool_call: take` grant can be scoped to
 *  exactly these and no further. A session must never be able to claim `run_javascript` and answer
 *  its own execution: a `tool_result` has to keep meaning "a worker produced this". */
export const SESSION_TOOL_NAMES: string[] = SESSION_TOOL_SCHEMAS.map((s) => s.function.name);

/**
 * Claim and answer this session's own inspection calls, until `signal` aborts.
 *
 * Runs in the REPL process on the session's credential, so the answer is exactly what the person
 * asking is allowed to see: a scoped session gets 403 on `/ops` here, which is the correct answer
 * and the same one it got when a worker held its token.
 */
export function serveSessionTools(
  session: RadiaClient,
  signal: AbortSignal,
  keys?: (conversationId: string, owner?: string) => Promise<ConversationKey | undefined>,
): Promise<string[]> {
  return serveTools(session, {
    provider: "session",
    name: "session-tools",
    tools: { ...makeInspectTools(session), ...makeRemediateTools(session) },
    // These run in the REPL on the SESSION's credential, so the key is the person's own rather than
    // the fleet's: this process holds no fleet secret and should not (plan-encryption.md phase 4).
    ...(keys ? { keys } : {}),
    schemas: [], // served, never advertised: see the header
    // These WAIT (a query, an ops read) rather than work, and a turn can ask for several at once.
    concurrency: 4,
    signal,
  });
}
