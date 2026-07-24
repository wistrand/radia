// Auth roles for the chat example. The launcher of `deno task chat` is the OPERATOR of its
// local space, so it bootstraps: it registers kinds and, as operator, creates least-privilege
// agent definitions + grants and mints short-lived run tokens (the bootstrap chain, design-auth).
//
// Two session roles:
//   admin — the REPL (and its space_* inspection/remediation tools) run as the operator: full
//           access, including the /ops/* observability+control plane.
//   user  — the REPL runs under a scoped `agent:chat-user` run token: it can converse (put/query
//           the conversation kinds) but is DENIED the /ops/* plane and any kind it wasn't granted.
//
// The two workers are ALWAYS scoped agents (least privilege), regardless of role — each holds
// only the grants it needs to do its job.

import { RadiaClient } from "../../sdk/ts/client.ts";

export type Role = "admin" | "user";

interface Grant {
  kind: string;
  operations: string[];
}

// inference-worker: claims llm_call (its tier), emits llm_result + streamed llm_chunk, advertises
// its tier→model (`model` record) + the `escalate` capability, and reads the thread. On
// self-escalation it re-dispatches an llm_call to a stronger tier (put llm_call) and reads the
// `model` fleet to find that tier. One token serves all tier-workers.
const INFERENCE_GRANTS: Grant[] = [
  { kind: "llm_call", operations: ["take", "put"] },
  { kind: "llm_result", operations: ["put"] },
  { kind: "llm_chunk", operations: ["put"] },
  { kind: "model", operations: ["put", "query"] },
  { kind: "capability", operations: ["put"] },
  { kind: "message", operations: ["query"] },
];

// router-worker: claims UNTIERED llm_calls, classifies the turn, and re-dispatches a tiered one.
// Model selection is delegated here (a substrate worker), not decided in the chat client.
const ROUTER_GRANTS: Grant[] = [
  { kind: "llm_call", operations: ["take", "put"] },
  { kind: "message", operations: ["query"] },
  { kind: "model", operations: ["query"] },
];

// tool-worker: claims tool_call, emits tool_result, and publishes its capability records.
const TOOLS_GRANTS: Grant[] = [
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] },
  { kind: "capability", operations: ["put"] },
];

// plain user (the REPL): may drive a conversation and read its own results, nothing more.
// Note what's ABSENT: no /ops/* (space_stats/doctor/events/lineage/reclaim/declassify), and
// query is granted only per-kind — so `space_query {kind: grant}` or {kind: agent_run} is denied.
const USER_GRANTS: Grant[] = [
  { kind: "conversation", operations: ["put"] },
  { kind: "message", operations: ["put", "query"] },
  { kind: "llm_call", operations: ["put"] },
  { kind: "tool_call", operations: ["put"] },
  { kind: "llm_chunk", operations: ["query"] },
  { kind: "llm_result", operations: ["read_one"] },
  { kind: "tool_result", operations: ["read_one"] },
  { kind: "capability", operations: ["query"] },
];

/** Operator action: define an agent with its grants and mint a short-lived run token. */
async function mint(admin: RadiaClient, agent: string, grants: Grant[]): Promise<string> {
  const { definitionToken } = await admin.createAgentDefinition(
    agent,
    grants.map((g) => ({ principal: agent, kind: g.kind, operations: g.operations })),
  );
  const { runToken } = await admin.createRun(definitionToken);
  return runToken;
}

export interface Bootstrapped {
  inferenceToken: string;
  routerToken: string;
  toolsToken: string;
  /** The REPL/session token: undefined for admin (operator), a scoped run token for user. */
  sessionToken?: string;
}

/** Bootstrap the run tokens for this session (called by chat.ts as the operator). */
export async function bootstrap(admin: RadiaClient, role: Role): Promise<Bootstrapped> {
  const inferenceToken = await mint(admin, "agent:chat-inference", INFERENCE_GRANTS);
  const routerToken = await mint(admin, "agent:chat-router", ROUTER_GRANTS);
  const toolsToken = await mint(admin, "agent:chat-tools", TOOLS_GRANTS);
  const sessionToken = role === "user" ? await mint(admin, "agent:chat-user", USER_GRANTS) : undefined;
  return { inferenceToken, routerToken, toolsToken, sessionToken };
}
