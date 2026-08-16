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
import { INSPECT_SCHEMAS, REMEDIATE_SCHEMAS } from "../../../extensions/ts/agent-tools.ts";

/** The tools the SESSION serves in its own process (client/session-tools.ts), derived from the
 *  same schemas that file serves so the grant and the server cannot disagree about the list. */
const SESSION_SERVED = [...INSPECT_SCHEMAS, ...REMEDIATE_SCHEMAS].map((s) => s.function.name);

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
  // The assistant message IS this worker's ack for a conversation call (plan-chat-turn.md);
  // `llm_result` remains the reply shape for INLINE calls only (the router's classifier).
  { kind: "message", operations: ["put"] },
  { kind: "llm_result", operations: ["put"] },
  { kind: "llm_chunk", operations: ["put"] },
  { kind: "model", operations: ["put", "query"] },
  { kind: "capability", operations: ["put"] },
  { kind: "message", operations: ["query"] },
  { kind: "progress", operations: ["put"] }, // reports which tier/model is generating
  // A conversation's wrapped DEK: inference is the reader that must decrypt, since it calls the
  // provider (plan-encryption.md phase 2). Unscoped because the fleet serves everyone, so the
  // read is conjoined with the CALLER's owner at the call site rather than trusted from the body
  // it was named in (package V). The record NAMES the wraps; they live in an artifact so that
  // destroying them is possible at all (phase 5), which is why the read below comes with it.
  { kind: "conversation_key", operations: ["read_one"] },
  { kind: "artifact", operations: ["read_one"] },
];

// router-worker: claims UNTIERED llm_calls, classifies the turn with a cheap model, and
// re-dispatches a tiered one. Model selection is delegated here (a substrate worker), not decided
// in the chat client. It reads the newest messages (to classify) and its own classifier call's
// result; it never holds the API key: the classification is itself an llm_call served by the fleet.
const ROUTER_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  // `query` too: the per-turn ceiling reads the round-0 call to see where this turn started, so a
  // later round cannot drift to the top tier by making tool calls.
  { kind: "llm_call", operations: ["take", "put", "query"] },
  { kind: "llm_result", operations: ["read_one"] }, // reads its classifier call's result
  { kind: "message", operations: ["query"] },
  { kind: "model", operations: ["query"] },
  { kind: "progress", operations: ["put"] }, // reports classifying + the tier it picked
];

// image-worker: claims `tool_call{generate_image}` and `{analyze_image}`, calls an image model or a
// vision model, and acks a reference or an answer. Holds the API key (its own process, no file
// access), so it needs egress. On the space, though, it can only do these five things.
const IMAGE_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] }, // bare (un-slotted) calls only, since 2b
  { kind: "message", operations: ["put"] }, // a slotted call's reply IS the tool message (workers/reply.ts)
  // `put` for the bytes it draws; `read_one` for the ones it reads back. The read arrived with
  // `analyze_image` and is in this list as part of that change, not after it: a worker shipped with
  // a capability whose grant was missing twice already (read_workspace, and the exec worker's
  // `workspace: put`), and both times the contract suite stayed green while every real call 403'd.
  { kind: "artifact", operations: ["put", "read_one"] },
  { kind: "capability", operations: ["put"] },
  { kind: "model", operations: ["put"] }, // advertises itself as modalities:["image"]
  { kind: "progress", operations: ["put"] },
  // A conversation's wrapped DEK: this worker reads the arguments it acts on and seals its answer
  // under the same key (plan-encryption.md phase 4). Unscoped because the fleet serves everyone, so
  // the read is bounded by the CALLER at the call site rather than trusted from the body it was
  // named in (package V).
  { kind: "conversation_key", operations: ["read_one"] },
];

// tool-worker: claims tool_call, emits tool_result, and publishes its capability records.
const TOOLS_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what this worker listens for
  { kind: "tool_call", operations: ["take"] },
  { kind: "tool_result", operations: ["put"] }, // bare (un-slotted) calls only, since 2b
  { kind: "message", operations: ["put"] }, // a slotted call's reply IS the tool message (workers/reply.ts)
  // `put` for save_content, `read_one` for read_workspace and edit_workspace. The comment here used
  // to read "WRITE only, it never reads one back" and was true when written — until a reader was
  // added to this worker and the grant list did not follow, so every read_workspace in a real chat
  // answered `forbidden` while the contract suite stayed green. Same shape as the exec worker's
  // missing `workspace: put`. When a worker gains a capability, its grants are part of the change.
  { kind: "artifact", operations: ["put", "read_one"] },
  { kind: "capability", operations: ["put"] },
  { kind: "progress", operations: ["put"] }, // reports which tool it is running
  { kind: "workspace", operations: ["put", "query"] }, // save_workspace: authors a tree for a session
  // A conversation's wrapped DEK: this worker reads the arguments it acts on and seals its answer
  // under the same key (plan-encryption.md phase 4). Unscoped because the fleet serves everyone, so
  // the read is bounded by the CALLER at the call site rather than trusted from the body it was
  // named in (package V).
  { kind: "conversation_key", operations: ["read_one"] },
];

// exec-worker: claims `tool_call{run_javascript}` (and `{run_python}` where the jail probes clean)
// and runs the model's program in a permissionless
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
  // Both of these are written through `ack`, under the LEASE, so they cannot be delegated: an ack
  // is performed by the lease owner and no other credential can make it. They stay ambient, and
  // that is a real remaining reach on the write side, stated rather than hidden.
  { kind: "tool_result", operations: ["put"] }, // bare (un-slotted) calls only, since 2b
  { kind: "message", operations: ["put"] }, // a slotted call's reply IS the tool message (workers/reply.ts)
  // `query` as well as `put`: it must know every tool name ANY worker advertises, to refuse a
  // saved procedure that would shadow one (see `capabilityNames` in workers/exec.ts).
  { kind: "capability", operations: ["put", "query"] },
  { kind: "progress", operations: ["put"] },
  // The verdict on a run, written from what actually happened. Only this worker may put one: the
  // session has `query` and nothing more, so "the code did what was claimed" is never a record the
  // model authored about itself. Deliberately NOT delegable, for the same reason.
  { kind: "check", operations: ["put"] },
  // The WRITE half of the three kinds below stays here, and the reason is the mechanism rather
  // than caution: a delegated run's authority is `worker INTERSECT caller`, so it can never exceed
  // the CALLER, and the session deliberately holds no `workspace: put` or `procedure: put` (only
  // this worker may author a tree or store a procedure, which is what makes "the assistant saved
  // this" mean it went through the sandbox). Delegating those would intersect to nothing.
  // What that leaves ambient is authoring INTO another session's scope, an integrity reach rather
  // than a confidentiality one, and the read half below is where the cross-user exposure was.
  { kind: "artifact", operations: ["put"] },
  { kind: "workspace", operations: ["put"] },
  { kind: "procedure", operations: ["put"] },
  // Reads the operator's declaration, and declares the backends whose AVAILABILITY only it can
  // determine: whether bubblewrap exists on this host is not something the launcher knows, and a
  // jail is only declared here after its probe passed. The declare-versus-verify split still holds
  // where it matters — nothing is advertised on the strength of a claim, only on a passed probe —
  // but the earlier comment overstated it: `query` alone could not express a backend the operator
  // cannot see.
  { kind: "sandbox", operations: ["query", "put"] },
  // A conversation's wrapped DEK: this worker reads the arguments it acts on and seals its answer
  // under the same key (plan-encryption.md phase 4). Unscoped because the fleet serves everyone, so
  // the read is bounded by the CALLER at the call site rather than trusted from the body it was
  // named in (package V).
  { kind: "conversation_key", operations: ["read_one"] },
];

/**
 * READING session data, moved off the worker's own identity (agent_docs/plan-delegation.md phase
 * 4). These were unscoped grants here, so ONE shared exec process could read every person's
 * workspaces, procedures and artifacts, and delegation would have been decoration while they
 * stayed.
 *
 * They live under `delegable:agent:chat-exec`, a principal nothing can authenticate as, so this
 * worker's own token cannot touch them and the only path is a delegated run bounded by whoever
 * asked. Narrowing them instead would have emptied the intersection, since that is a SUBSET of
 * what the worker holds: under the delegated run `readWorkspace` gets the SESSION's pattern, which
 * is what makes one worker safe for many people.
 */
const EXEC_DELEGABLE: Grant[] = [
  { kind: "artifact", operations: ["read_one"] },
  { kind: "workspace", operations: ["query"] },
  { kind: "procedure", operations: ["query"] },
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
/** The turn worker: it WATCHES messages and emits the next link. No `take` anywhere, because facts
 *  are not claimed (plan-chat-turn.md); exactly-once is the idempotency key. */
const TURN_GRANTS: Grant[] = [
  { kind: "message", operations: ["query", "read_one"] },
  { kind: "llm_call", operations: ["put", "query"] },
  { kind: "tool_call", operations: ["put"] },
  { kind: "turn_complete", operations: ["put"] },
  { kind: "cancel", operations: ["read_one"] }, // checked before every emission
];

export function userGrants(scope?: Record<string, unknown>): Grant[] {
  const scoped = scope ? { pattern: scope } : {};
  return [
    // `read_one` because the assistant reply is awaited BY CALL (`{kind: message, match: {callId}}`):
    // the assistant message IS the inference worker's ack (plan-chat-turn.md).
    { kind: "message", operations: ["put", "query", "read_one"], ...scoped },
    // `query` as well as `put` since step 4: the client no longer WRITES each round's call, so it
    // finds the one the turn worker emitted (`nextCall`) to know which stream to follow.
    { kind: "llm_call", operations: ["put", "query"], ...scoped },
    { kind: "tool_call", operations: ["put"], ...scoped },
    // TAKE, but only for the tools the session SERVES ITSELF (client/session-tools.ts). The
    // inspection tools moved into the REPL process because a delegated run can never carry the ops
    // plane, and serving means claiming: an unclaimed claimable record would otherwise sit in the
    // queue forever, since nothing else answers these names.
    //
    // Scoped to the NAMES, not just to the session, and that is the whole safety of it. With a bare
    // `tool_call: take` a session could claim its own `run_javascript` call and write the result,
    // and a `tool_result` would stop meaning "a worker produced this" — the same property that
    // keeps `check: put` off this list. `$in` over an indexed path, ANDed with the session's own
    // scope, so it can claim these and nothing else.
    { kind: "tool_call", operations: ["take"], pattern: { ...(scope ?? {}), tool: { $in: SESSION_SERVED } } },
    // A claimant declares what it listens for, and `agentLoop` treats a refused publish as "no
    // grant" and skips the remaining patterns SILENTLY: without this the session claims nothing and
    // says nothing. Unscoped, like the fleet's, because an interest is about a kind rather than
    // about anyone's records; the per-principal ceiling bounds it.
    { kind: "interest", operations: ["put", "query"] },
    // Keyed by `callId`, so these carry the scope field purely so a grant can bind them: a session
    // that learned a callId from elsewhere could otherwise read another session's streamed tokens,
    // model output, or tool results.
    { kind: "llm_chunk", operations: ["query"], ...scoped },
    // Historical only since the fold (2a): workers answer conversations with `message` now, so this
    // covers records written before, not anything new.
    { kind: "llm_result", operations: ["read_one"], ...scoped },
    // The turn's terminus, which the REPL waits on to know a round-capped turn ended.
    { kind: "turn_complete", operations: ["read_one", "query"], ...scoped },
    // Escape: the person's intent, which only they can declare.
    { kind: "cancel", operations: ["put", "query"], ...scoped },
    // `put` as well as `read_one` since the inspection tools moved in-process: a BARE call is
    // answered with a `tool_result`, while a slotted one replies as a `message` (granted above).
    // `asTurnReply` picks by `tool_call_id`, so a session that serves tools needs both shapes.
    { kind: "tool_result", operations: ["put", "read_one"], ...scoped },
    // PUT ONLY, and the asymmetry is the point. A session in join mode has no operator to create
    // its thread, so it creates its own; `query` stays withheld because enumerating conversations
    // would list every one on the space. Starting a thread of your own reveals nothing about
    // anyone else's. Unscoped because a `conversation` record has no field a pattern could bind.
    { kind: "conversation", operations: ["put"] },
    // Its key material, which DOES carry fields a pattern binds (plan-encryption.md phase 2). Both
    // scope modes work here, unlike on the anchor: the record names its conversation and its owner.
    { kind: "conversation_key", operations: ["put", "read_one"], ...scoped },
    { kind: "capability", operations: ["query"] }, // a registry: the fleet's tools, not session data
    // The fleet's PUBLIC wrapping key. Unscoped and unremarkable: a public key is public, and a
    // session that cannot read it cannot start an encrypted conversation at all.
    { kind: "fleet_key", operations: ["query"] },
    // Same category, and the grant `space_kinds` runs on: what kinds EXIST is reference data,
    // and the model is told to discover kinds rather than be taught them (CLAUDE.md, the
    // corollary). Missing, every fresh identity 403'd on its own discovery tool while
    // long-lived ones worked from one-off manual grants — the drift that hid this for weeks.
    { kind: "kind_def", operations: ["query"] },
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
    //
    // `put` is what lets a person ATTACH a file (Ctrl-V at the prompt). It is a real widening and
    // worth stating as one: the session can write bytes into the space under its own name. Three
    // things bound it. The pattern is matched against the BODY on the way in, so an attachment that
    // is not stamped with this scope is refused rather than misfiled; bytes live outside the record,
    // so unlike anything else here they can be destroyed if the wrong file is pasted; and the
    // alternative was worse, since the only process that can read the person's filesystem is this
    // one, and routing the bytes through a worker would mean handing a worker arbitrary paths.
    { kind: "artifact", operations: ["put", "read_one", "query"], ...scoped },
    // A tree the session owns. Scoped like the rest, so a session sees its own workspaces and no
    // one else's, and the runtime enforces the stamp on the way in as well as the way out.
    { kind: "workspace", operations: ["query"], ...scoped },
    // UNSCOPED, and that is the point rather than an oversight. A `sandbox` record is written by the
    // exec-worker, so a scope binding it to this session's own records would match nothing, and the
    // session could not answer "what can you run, and under what isolation" about the very jails its
    // code runs in. Nothing here is a secret: the record states guarantees, which is what makes the
    // difference between two jails inspectable instead of a sentence in a banner. `query` only, so a
    // session can read what a jail claims and can never declare one.
    { kind: "sandbox", operations: ["query"] },
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
export async function mintSession(
  admin: RadiaClient,
  principal: string,
  scope?: Record<string, unknown>,
): Promise<string> {
  return (await mint(admin, principal, userGrants(scope))).runToken;
}

/** Operator action: define an agent with its grants and mint a short-lived run token. */
async function mint(
  admin: RadiaClient,
  agent: string,
  grants: Grant[],
): Promise<{ definitionToken: string; runToken: string }> {
  const { definitionToken } = await admin.createAgentDefinition(
    agent,
    grants.map((g) => ({ principal: agent, kind: g.kind, operations: g.operations, ...(g.pattern ? { pattern: g.pattern } : {}) })),
  );
  const { runToken } = await admin.createRun(definitionToken);
  return { definitionToken, runToken };
}

/**
 * The DURABLE half per worker, not a run token.
 *
 * A run lives fifteen minutes and renews to a twelve-hour ceiling, after which a worker holding
 * only that half is finished: it cannot re-authenticate, so it spins on `token_expired` forever.
 * Seen exactly that way when a dev space restarted under a running fleet. A definition token has no
 * expiry and is MINT-ONLY (it cannot read, write or claim), which is what makes it safe to hand
 * over, and `RadiaClient({definitionToken})` exchanges it for a fresh run whenever the short half
 * stops working (conformance/exchange.test.ts). The mechanism was built and the fleet did not use it.
 */
export interface Bootstrapped {
  inferenceToken: string;
  routerToken: string;
  toolsToken: string;
  imagesToken: string;
  execToken: string;
  turnToken: string;
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
  const inferenceToken = (await mint(admin, "agent:chat-inference", INFERENCE_GRANTS)).definitionToken;
  const routerToken = (await mint(admin, "agent:chat-router", ROUTER_GRANTS)).definitionToken;
  const toolsToken = (await mint(admin, "agent:chat-tools", TOOLS_GRANTS)).definitionToken;
  const imagesToken = (await mint(admin, "agent:chat-images", IMAGE_GRANTS)).definitionToken;
  const execToken = (await mint(admin, "agent:chat-exec", EXEC_GRANTS)).definitionToken;
  const turnToken = (await mint(admin, "agent:chat-turn", TURN_GRANTS)).definitionToken;
  // Assigned to a principal, not to a definition: `delegable:agent:chat-exec` has no definition and
  // never will, which is exactly why the worker cannot authenticate as it. Written directly, the
  // way any grant is.
  for (const g of EXEC_DELEGABLE) {
    await admin.put({
      kind: "grant",
      body: { principal: "delegable:agent:chat-exec", kind: g.kind, operations: g.operations },
    }, `chat-delegable:exec:${g.kind}`);
  }
  return { inferenceToken, routerToken, toolsToken, imagesToken, execToken, turnToken };
}
