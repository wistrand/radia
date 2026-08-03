// Auth roles for the chat example. The launcher of `deno task chat` is the OPERATOR of its
// local space, so it bootstraps: it registers kinds and, as operator, creates least-privilege
// agent definitions + grants and mints short-lived run tokens (the bootstrap chain, design-auth).
//
// There are no session roles. The REPL runs under the credential the person supplies
// (`RADIA_CHAT_TOKEN`, from `radia login`), and the space decides what that is worth. Whether the
// space_* tools reach the /ops/* plane follows from the grants that principal holds, not from a
// flag the launcher passed. A role flag chose between "scoped" and "operator" out of band, so the
// most privileged posture was the one you got by omitting it.
//
// The two workers are ALWAYS scoped agents (least privilege), regardless of role. Each holds
// only the grants it needs to do its job.

import { RadiaClient } from "../../../sdk/ts/client.ts";

/** The scoped principal a `user`-role session runs as. Exported because the REPL grants TO it when
 *  a human approves a request. The subject comes from what this process minted, never from the
 *  request record, so an approval cannot be redirected by anything the model wrote. */
export const CHAT_USER = "agent:chat-user";

/**
 * Who this session's records belong to.
 *
 * Defaults to the shared `agent:chat-user`, which is fine for one person on a laptop and wrong the
 * moment two people share a space: they would be the same principal, so identity scope could not
 * separate them. A login token replaces it with the person behind that token, and everything the
 * session writes is stamped with the result.
 */
//
// PROCESS-LOCAL. This is mutable module state that only the REPL sets, so it is correct in the chat
// process and silently WRONG in every worker: a worker importing it stamps the default while the
// session's grant pattern names a person, and the write is refused. Anything running worker-side
// takes the owner from the tool_call it is serving (`ToolContext.owner`), which the session stamped
// and the runtime already checked. Guarded by `smoke-login.ts`.
let SESSION_OWNER = CHAT_USER;
export function sessionOwner(): string {
  return SESSION_OWNER;
}
export function setSessionOwner(principal: string): void {
  SESSION_OWNER = principal;
}

interface Grant {
  kind: string;
  operations: string[];
  /** ANDed into every read and matched against every write body (the runtime's own content
   *  scoping). Used to pin a session to ITS conversation; see `userGrants`. */
  pattern?: Record<string, unknown>;
}

// inference-worker: claims llm_call (its tier), emits llm_result + streamed llm_chunk, advertises
// its tier→model (`model` record) + the `escalate` capability, and reads the thread. On
// self-escalation it re-dispatches an llm_call to a stronger tier (put llm_call) and reads the
// `model` fleet to find that tier. One token serves all tier-workers.
const INFERENCE_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "llm_call", operations: ["take", "put"] },
  { kind: "llm_result", operations: ["put"] },
  { kind: "llm_chunk", operations: ["put"] },
  { kind: "model", operations: ["put", "query"] },
  { kind: "capability", operations: ["put"] },
  { kind: "message", operations: ["query"] },
  { kind: "progress", operations: ["put"] }, // reports which tier/model is generating
];

// router-worker: claims UNTIERED llm_calls, classifies the turn with a cheap model, and
// re-dispatches a tiered one. Model selection is delegated here (a substrate worker), not decided
// in the chat client. It reads the newest messages (to classify) and its own classifier call's
// result; it never holds the API key: the classification is itself an llm_call served by the fleet.
const ROUTER_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "llm_call", operations: ["take", "put"] },
  { kind: "llm_result", operations: ["read_one"] }, // reads its classifier call's result
  { kind: "message", operations: ["query"] },
  { kind: "model", operations: ["query"] },
  { kind: "progress", operations: ["put"] }, // reports classifying + the tier it picked
];

// image-worker: claims `tool_call{tool:generate_image}`, calls an image model, stores the bytes as
// an ARTIFACT and acks a reference to it. Holds the API key (its own process, no file access), so
// it needs egress. On the space, though, it can only do these five things.
const IMAGE_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] },
  { kind: "artifact", operations: ["put"] }, // the bytes; the record carries only a reference
  { kind: "capability", operations: ["put"] },
  { kind: "model", operations: ["put"] }, // advertises itself as modalities:["image"]
  { kind: "progress", operations: ["put"] },
];

// tool-worker: claims tool_call, emits tool_result, and publishes its capability records.
const TOOLS_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] },
  { kind: "artifact", operations: ["put"] }, // save_content: WRITE only, it never reads one back
  { kind: "capability", operations: ["put"] },
  { kind: "progress", operations: ["put"] }, // reports which tool it is running
  { kind: "workspace", operations: ["put", "query"] }, // save_workspace: authors a tree for a session
];

// exec-worker: claims `tool_call{run_code}` and runs the model's program in a permissionless
// subprocess. It needs --allow-run (to spawn) but holds no API key and reads no files itself.
//
// Saved procedures widened this set, and it is worth being precise about how much. The worker now
// reads and writes `procedure` records, and reads artifacts; it previously did neither. What is
// still ABSENT is the part that mattered: it cannot query `message`, `llm_call` or `llm_result`,
// so a code runner still has no way to read the conversation. `procedure: query` lets it learn
// which names to claim and whose conversation each belongs to; `artifact: read_one` lets it fetch
// the source it saved, and it only ever fetches the id named by a procedure record it just looked
// up. It never fetches an id the model supplied. And note who CANNOT write a procedure: the user
// session (below) has no such grant, so a saved procedure is always code this worker stored on the
// assistant's behalf, not a record the model wrote directly.
const EXEC_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] },
  { kind: "artifact", operations: ["put", "read_one"] },
  // `query` as well as `put`: it must know every tool name ANY worker advertises, to refuse a
  // saved procedure that would shadow one (see `capabilityNames` in workers/exec.ts).
  { kind: "capability", operations: ["put", "query"] },
  { kind: "progress", operations: ["put"] },
  { kind: "procedure", operations: ["put", "query"] },
  // The verdict on a run, written from what actually happened. Only this worker may put one: the
  // session has `query` and nothing more, so "the code did what was claimed" is never a record the
  // model authored about itself.
  { kind: "check", operations: ["put"] },
  // Reads a manifest to materialise it. `query`, not `put`: this worker never authors a tree, it
  // only serves one, so a bug here cannot invent a workspace.
  { kind: "workspace", operations: ["query"] },
];

// plain user (the REPL): may drive its own conversations and read its own results, nothing more.
// Note what's ABSENT: no /ops/* (space_stats/doctor/events/lineage/reclaim/declassify), and
// query is granted only per-kind. `space_query {kind: grant}` or {kind: agent_run} is denied.
//
// The grants are PATTERN-SCOPED, and what they bind to is a choice (`RADIA_CHAT_SCOPE`):
//
//   identity (default): `{owner: agent:chat-user}`. The session stamps `owner` on what it writes
//     and workers copy it onto the results and artifacts they produce for it, so this covers
//     everything this identity produced across ALL its conversations. Scoping by AUTHOR instead
//     would not work: the results, chunks and artifacts are written by WORKERS under their own
//     principals, so `createdBy: self` would hide the session's own tool output and the chat would
//     hang waiting for results it could no longer read.
//   conversation: `{conversationId}`. Strict, and the only posture that separates two people
//     sharing a space, since both would be `agent:chat-user`; the cost is that a session cannot
//     see its own earlier threads.
//
// Either way it is the RUNTIME enforcing it: a grant pattern is ANDed into reads and matched
// against write bodies, so a session cannot read outside its scope and cannot write outside it
// either: it cannot stamp another identity's `owner`, because that write would fail the pattern.
// Kind-scoping alone enforced nothing of the sort: it let any session read every message in the
// space, and one reconstructed two days of unrelated conversations from a ten-minute session.
//
// Growth is bounded by distinct scopes, not sessions: the pattern is part of a grant's identity,
// so re-running under the same scope re-mints the same content key and writes nothing.
export function userGrants(scope?: Record<string, unknown>): Grant[] {
  const scoped = scope ? { pattern: scope } : {};
  return [
    { kind: "message", operations: ["put", "query"], ...scoped },
    { kind: "llm_call", operations: ["put"], ...scoped },
    { kind: "tool_call", operations: ["put"], ...scoped },
    // Keyed by `callId`, so these carry the scope field purely so a grant can bind them: a session
    // that learned a callId from elsewhere could otherwise read another session's streamed tokens,
    // model output, or tool results.
    { kind: "llm_chunk", operations: ["query"], ...scoped },
    { kind: "llm_result", operations: ["read_one"], ...scoped },
    { kind: "tool_result", operations: ["read_one"], ...scoped },
    { kind: "capability", operations: ["query"] }, // a registry: the fleet's tools, not session data
    // READ-ONLY on purpose: the session builds its tool list from the procedures its conversation
    // saved, but cannot write one. Only the exec-worker can, and only as the result of a
    // `save_procedure` call it actually ran. So "the assistant saved a procedure" always means code
    // that went through the sandbox's own path.
    { kind: "procedure", operations: ["query"], ...scoped },
    // ASK for authority, never take it. The session may write a grant_request and read its own; it
    // has no grant on `grant` itself, so the escalation path ends at a human. This is the whole
    // point of the split: least privilege by default, with a visible, auditable way to ask.
    { kind: "grant_request", operations: ["put", "query"], ...scoped },
    { kind: "progress", operations: ["query"], ...scoped }, // read-only: the session reports no progress of its own
    // READ-ONLY, and that is the whole value of the kind. A `check` says whether a run did what was
    // claimed of it; if the session could write one, it would be the model grading its own work,
    // which is the thing prose already does. Only the exec-worker puts these, from a real run.
    { kind: "check", operations: ["query"], ...scoped },
    // Scoped like the rest: `Space.putArtifact` takes application fields, the chat's writers stamp
    // them, and the kind is redeclared to index them. This one grant covers `share_artifact` too: a
    // download capability is authorized at MINT time against exactly this read, so the session can
    // only produce a link for an artifact it could already fetch. No separate "may share" grant,
    // and deliberately not: two permissions that must agree eventually disagree.
    //
    // `query` as well as `read_one`, because "which artifacts do I have?" is a question the session
    // could not answer at all: it could fetch an id it already knew and could not discover one. The
    // assistant correctly diagnosed the gap and then had to ask a human to widen a grant to see its
    // OWN files. The pattern is what makes this safe: the same scope that limits `read_one` limits
    // the listing, so it enumerates this identity's artifacts and nobody else's.
    { kind: "artifact", operations: ["read_one", "query"], ...scoped },
    // A tree the session owns. Scoped like the rest, so a session sees its own workspaces and no
    // one else's, and the runtime enforces the stamp on the way in as well as the way out.
    { kind: "workspace", operations: ["query"], ...scoped },
  ];
}

/**
 * Operator action: assign this app's session grants to whoever logged in.
 *
 * The login path splits what `bootstrap` does in one step: the credential already exists (the
 * person minted it with `radia login`), so only the grants are missing. It stays here, beside
 * `userGrants`, so the set a session gets does not depend on how it authenticated.
 *
 * Grants are ASSIGNED, never self-declared, and this is the operator doing the assigning. A session
 * that brought its own token still cannot widen itself.
 */
export async function assignUserGrants(
  admin: RadiaClient,
  principal: string,
  scope?: Record<string, unknown>,
): Promise<void> {
  for (const g of userGrants(scope)) await admin.grant(principal, g.kind, g.operations, g.pattern);
}

/**
 * Operator action: mint a scoped session credential for `principal`.
 *
 * The chat no longer calls this: a person brings their own token (`radia login`), and the operator
 * only assigns the grants (`assignUserGrants`). It stays for the suites, which need a scoped
 * credential without a human to mint one, and it is the same two steps `radia login` performs.
 */
export function mintSession(
  admin: RadiaClient,
  principal: string,
  scope?: Record<string, unknown>,
): Promise<string> {
  return mint(admin, principal, userGrants(scope));
}

/** Operator action: define an agent with its grants and mint a short-lived run token. */
async function mint(admin: RadiaClient, agent: string, grants: Grant[]): Promise<string> {
  const { definitionToken } = await admin.createAgentDefinition(
    agent,
    grants.map((g) => ({ principal: agent, kind: g.kind, operations: g.operations, ...(g.pattern ? { pattern: g.pattern } : {}) })),
  );
  const { runToken } = await admin.createRun(definitionToken);
  return runToken;
}

export interface Bootstrapped {
  inferenceToken: string;
  routerToken: string;
  toolsToken: string;
  imagesToken: string;
  execToken: string;
}

/**
 * Bootstrap the run tokens for this session (called by chat.ts as the operator).
 *
 * `scope` is the pattern the session's grants bind to: `{owner}` or `{conversationId}`, decided by
 * the caller (see `RADIA_CHAT_SCOPE`). It is a parameter rather than something read later because a
 * grant is minted with the run token, so whatever it binds to has to exist first: that is why the
 * REPL resolves the conversation as operator before calling this.
 *
 * It mints WORKER tokens only. The session's credential comes from the person running the chat
 * (`RADIA_CHAT_TOKEN`), which is why there is no role parameter: the chat cannot choose to be
 * privileged, the space decides that from the credential presented.
 */
export async function bootstrap(
  admin: RadiaClient,
  scope?: Record<string, unknown>,
): Promise<Bootstrapped> {
  const inferenceToken = await mint(admin, "agent:chat-inference", INFERENCE_GRANTS);
  const routerToken = await mint(admin, "agent:chat-router", ROUTER_GRANTS);
  const toolsToken = await mint(admin, "agent:chat-tools", TOOLS_GRANTS);
  const imagesToken = await mint(admin, "agent:chat-images", IMAGE_GRANTS);
  const execToken = await mint(admin, "agent:chat-exec", EXEC_GRANTS);
  return { inferenceToken, routerToken, toolsToken, imagesToken, execToken };
}
