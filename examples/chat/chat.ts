// CLI chatbot: pure record I/O. It makes NO external calls; it only reads and writes records.
// Thinking (`llm_call` → `llm_result`, streamed as `llm_chunk`), acting (`tool_call` →
// `tool_result`), drawing, code execution and saved files all flow through the space, served by
// workers this launches as scoped subprocesses. Watch the whole loop in the console's Feed tab.
//
//   OPENROUTER_API_KEY=... deno task chat
//
// The map. Five areas, each answering one question:
//
//   chat.ts       this file: bootstrap, launch, banner, the REPL loop
//   util.ts       worker argument parsing and artifact media helpers
//
//   client/       what the REPL itself does
//     config.ts     everything read from the environment (setup, never per-turn behaviour)
//     fleet.ts      launching the workers, and the permission set each one gets
//     thread.ts     the conversation as `message` records on the space
//     turn.ts       one user turn: llm_call → tools → answer, plus tool discovery
//     waiting.ts    watch-driven wakeups, progress rendering, stall diagnosis
//     terminal.ts   everything drawn to the screen
//
//   workers/      the five agent processes, each with its own identity and grants
//     inference.ts · router.ts · tools.ts · images.ts · exec.ts
//
//   tools/        what those workers actually do
//     files.ts (sandboxed file + compute) · space.ts (inspect + remediate)
//     save.ts (store content); the sandbox itself is extensions/ts/sandbox.ts
//     workers/exec.ts also serves save_procedure/read_procedure: named, reusable programs
//
//   space/        how this app uses Radia
//     kinds.ts (record kinds, incl. `procedure`) · roles.ts (grants + run tokens)
//     capability.ts (advertising a tool) · progress.ts (turn progress as records)
//
//   provider/     the outside world
//     openrouter.ts (chat completions) · imagegen.ts (image generation)
//     vision.ts (reading an image or a PDF)
//     context.ts (thread records → provider payload; pure, and where the context bugs live)

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assignUserGrants, bootstrap, setSessionOwner } from "./space/roles.ts";
import { apiKey, EXEC_TIMEOUT_MS, execRoots, loginToken, operatorToken, resume, scopeMode, spaceDb, TIERS, toolRoots, url } from "./client/config.ts";
import { FLEET_PROVIDERS, launchFleet, spawnSpace } from "./client/fleet.ts";
import { retireProviderCapabilities } from "./space/capability.ts";
import { denoSandbox } from "../../extensions/ts/sandbox.ts";
import { declareSandbox } from "../../extensions/ts/sandbox-registry.ts";
import { ToolSet } from "./client/turn.ts";
import { Thread } from "./client/thread.ts";
import { cancelTurn, runTurn, TurnCancelled } from "./client/turn.ts";
import { watchWakeups } from "./client/waiting.ts";
import { dim, endStatus, lineReader, showStatus, watchCancel, write } from "./client/terminal.ts";
import { reviewGrantRequests } from "./client/grants.ts";
import { sleep } from "./util.ts";

if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys).");
  Deno.exit(1);
}
if (toolRoots.length === 0) {
  console.error("No readable sandbox directories (RADIA_CHAT_DIRS).");
  Deno.exit(1);
}
// Both credentials are REQUIRED. Neither falls back to the space's open-mode no-header shortcut,
// which answers as the operator and would silently give a session the whole control plane.
if (!loginToken) {
  console.error("Set RADIA_CHAT_TOKEN (or --token) to your session token.");
  console.error("  Mint one:  radia login human:<you>");
  console.error("  There is no default identity: the chat will not run as an unnamed principal.");
  Deno.exit(1);
}

const procs: Deno.ChildProcess[] = [];
const shutdown = new AbortController();

function cleanup() {
  shutdown.abort();
  for (const p of procs) {
    try {
      p.kill();
    } catch { /* already gone */ }
  }
}

// Liveness only, and the one call that legitimately carries no credential: `/v0/health` is public
// so a client can tell "no space here" apart from "not allowed", even under `--auth required`.
const probe = new RadiaClient(url);
async function healthy(): Promise<boolean> {
  try {
    await probe.health();
    return true;
  } catch {
    return false;
  }
}

// Connect to a running space, or bring one up.
const usingRunning = await healthy();
if (!usingRunning) {
  procs.push(spawnSpace());
  for (let i = 0; i < 75 && !await healthy(); i++) await sleep(200);
  if (!await healthy()) {
    console.error("space did not start");
    cleanup();
    Deno.exit(1);
  }
}

// Two clients, two credentials, and they are NOT the same principal. `admin` bootstraps (register
// kinds, assign grants, mint the worker run tokens), all of which is privileged. `session` is the
// person at the keyboard, holding only what was granted to them.
//
// Resolved here rather than at import: a space this process just spawned writes its credential file
// during startup, so reading earlier always misses.
const opToken = operatorToken();
if (!opToken) {
  console.error(`No operator credential for ${url}.`);
  console.error("  `radia dev` provisions one automatically; set RADIA_TOKEN to override.");
  console.error("  The chat bootstraps the fleet, which is privileged, and will not do it unauthenticated.");
  cleanup();
  Deno.exit(1);
}
const admin = new RadiaClient(url, { token: opToken });

// Bootstrap as operator, then hand each worker its own least-privilege run token.
await registerChatKinds(admin);
// Which conversation this session is for, decided BEFORE its credential exists: the session's
// grants are scoped to it, and a grant is minted with the run token. Resolved (and created) with
// the OPERATOR client on purpose: enumerating conversations would otherwise need a
// `conversation: query` grant on the scoped session, which would let a user session list every
// conversation on the space. That is a real widening to save a keystroke.
async function resolveConversation(): Promise<{ id: string; resumed: boolean }> {
  if (resume && resume !== "last") return { id: resume, resumed: true };
  if (resume === "last") {
    // Newest first. That is the keyset direction, which is the only way to ask for the most recent.
    const recent = await admin.query({ kind: "conversation" }, 1, { dir: "desc" });
    if (recent.length > 0) return { id: recent[0].id, resumed: true };
    write("no conversation to resume; starting a new one\n");
  }
  return { id: (await admin.put({ kind: "conversation", body: {} })).id, resumed: false };
}
const conversation = await resolveConversation();

// Who is at the keyboard, resolved from the SPACE rather than taken on trust: the token names a
// run, and its subject is the person. Nothing the caller says is consulted, so a forged body field
// cannot claim someone else's identity.
const session = new RadiaClient(url, { token: loginToken });
const who = (await session.health()).principal;
const perms = await admin.permissions(who) as { subject: string; privileged: boolean };
const owner = perms.subject;
const privileged = perms.privileged;
setSessionOwner(owner);

// What the session's grants bind to. `owner` is this identity across all its conversations;
// `conversationId` is this thread only. See RADIA_CHAT_SCOPE.
const scope = scopeMode === "conversation"
  ? { conversationId: conversation.id }
  : { owner };
// The session brought its own credential, so the bootstrap mints only the WORKER tokens. The
// operator still assigns this person's grants: a session chooses its credential, never its
// authority.
const tokens = await bootstrap(admin, scope);
await assignUserGrants(admin, owner, scope);
// The OPERATOR declares the jail it is about to launch a worker into. Not the worker: a manifest
// claim is descriptive by definition, and an execution guarantee must not be. This process
// configured the flags, so it is the one that can honestly say what they are.
await declareSandbox(admin, denoSandbox({
  name: "deno",
  readRoots: execRoots,
  timeoutMs: Number(EXEC_TIMEOUT_MS),
}));
procs.push(...launchFleet(tokens, loginToken));

const tools = new ToolSet(session);
tools.watch(shutdown.signal); // background: keep the tool set live from capability records
watchWakeups(session, shutdown.signal); // background: let the runtime push instead of polling
// background: keep the session's credential alive. Run tokens last 15 minutes, so without this a
// conversation simply died mid-sentence, and the crash came out of whichever write happened to be
// next. Renewal is at half-life; an expired token cannot renew itself.
let sessionLost: string | null = null;
session.keepAlive(shutdown.signal, (reason) => {
  sessionLost = reason;
});

Deno.addSignalListener("SIGINT", () => {
  cleanup();
  Deno.exit(0);
});

// The banner is FACTS, aligned, one line each. It used to be nine lines of prose, several of them
// two sentences long, which on an 80-column terminal was about fifteen physical rows of wrapped
// text before the first prompt. What a reader needs at that moment is where the space is, who they
// are, and which directories are exposed. The design positions it also carried (routing is
// automatic, languages are discovered rather than configured, the guarantees differ per jail and
// live in `sandbox` records) are all true and none of them are what you need in the first second;
// they are in examples/chat/README.md, and the assistant can answer the jail question from the
// records themselves, which is the whole point of it being a record.
const field = (k: string, v: string) => write(`  ${dim(k.padEnd(9))}${v}\n`);
write(`\nradia chat  ${dim("·")}  ${owner}${privileged ? dim("  (operator)") : ""}\n`);
field("space", `${url}${usingRunning ? dim(" existing") : dim(` spawned, ${spaceDb}`)}`);
field("tiers", Object.entries(TIERS).map(([t, m]) => `${t}=${m}`).join("  "));
field("files", toolRoots.join(", "));
field("exec", execRoots.length ? execRoots.join(", ") : dim("no filesystem (RADIA_CHAT_EXEC_DIRS)"));
if (!privileged) field("auth", dim("scoped: space_* tools that touch /ops will 403"));

let thread: Thread;
try {
  thread = conversation.resumed
    ? await Thread.resume(session, conversation.id, { principal: owner, privileged })
    : await Thread.open(session, { principal: owner, privileged }, conversation.id);
} catch (e) {
  console.error(`could not resume: ${e}`);
  cleanup();
  Deno.exit(1);
}
field(
  "thread",
  thread.resumedFrom > 0
    ? `${thread.id}${dim(` resumed, ${thread.resumedFrom} earlier messages in context`)}`
    : `${thread.id}${dim("  --conversation last to resume it")}`,
);
// Procedures belong to a conversation, so the tool set can only be complete once there is one.
await tools.scopeTo(thread.id);

// Wait for the workers to publish their capabilities (the watch fills the set). Up to ten seconds
// of it, and it used to print nothing at all, so the first thing a new user saw was a hang.
const bootStart = Date.now();
for (let i = 0; i < 50 && tools.all().length === 0; i++) {
  showStatus("  ", `starting workers · ${Math.round((Date.now() - bootStart) / 1000)}s`);
  await sleep(200);
}
endStatus("");
field("tools", tools.all().length > 0 ? `${tools.all().length} discovered` : dim("none advertised yet"));
write(dim("\n  Ctrl-D to quit, Escape to cancel a turn.\n"));

const nextLine = lineReader();
while (true) {
  write("\nyou> ");
  const line = await nextLine();
  if (line === null) break; // EOF / Ctrl-D
  if (!line.trim()) continue;
  // A session that cannot be renewed (stopped, or past its maximum lifetime) is over. Say so and
  // stop rather than letting the next write throw: an uncaught `token_expired` killed the REPL and
  // took the conversation's context with it, and the stack trace named the SDK rather than the
  // credential.
  if (sessionLost) {
    write(`\nsession ended: ${sessionLost}\n`);
    write(`Mint a new one with \`radia login ${owner}\` and restart with --conversation ${conversation.id}.\n`);
    break;
  }
  try {
    await thread.append({ role: "user", content: line });
  } catch (e) {
    // Anything else that fails on the FIRST write of a turn is reported and skipped, never fatal.
    // Losing a REPL to one bad request costs the whole conversation.
    write(`\ncould not record that message: ${(e as Error).message}\n`);
    continue;
  }
  let stopWatching: (() => void) | null = null;
  try {
    // The hook is what collapses the escalation loop into ONE turn: while a `request_grant` is in
    // flight the person is asked here, the decision is written back as a record, and the tool call
    // returns with it, so the assistant can retry inside its remaining rounds. Throttled, because
    // this runs on every poll of the wait loop and each pass is a query.
    let lastReview = 0;
    // Escape trips the turn; the watcher is stopped in `finally` so raw mode never outlives it and
    // Ctrl-C keeps working at the prompt.
    stopWatching = watchCancel(cancelTurn);
    await runTurn(session, thread, tools, async (tool) => {
      if (tool !== "request_grant" || Date.now() - lastReview < 1000) return;
      lastReview = Date.now();
      try {
        await reviewGrantRequests(session, admin, owner, thread.id, nextLine);
        await tools.scopeTo(thread.id); // a new grant may have changed what is reachable
      } catch (e) {
        write(`\n[grant review failed] ${e}\n`);
      }
    });
  } catch (e) {
    // Cancelling is a thing the user did, not a fault: say what it did and, more importantly, what
    // it did NOT do. The worker keeps its claim, so the answer or the tool result still lands in the
    // space — visible on the Feed and in the thread — and pretending the work was undone would be
    // the one wrong thing to say about an at-least-once substrate.
    if (e instanceof TurnCancelled) {
      write(dim("\n[cancelled] the workers keep their claims, so results still land in the space\n"));
    } else {
      write(`\n[error] ${e}\n`);
    }
  } finally {
    stopWatching?.();
    stopWatching = null;
  }
  // Between turns as well, as the backstop: a request written by a worker rather than asked for
  // through the blocking tool (or one whose turn died) would otherwise sit pending forever.
  // `admin` is the operator credential this process bootstrapped with. The session itself cannot
  // write a grant, which is the point.
  try {
    await reviewGrantRequests(session, admin, owner, thread.id, nextLine);
    await tools.scopeTo(thread.id); // a new grant may have changed what is reachable
  } catch (e) {
    write(`\n[grant review failed] ${e}\n`);
  }
}

cleanup();
// Withdraw the fleet's advertisements on the way out, so the next session's tool list is what is
// actually being served rather than the union of every fleet that ever ran here. Awaited, which is
// why it is here and not in `cleanup()`: that one is called from paths that exit immediately, and a
// withdrawal nobody waits for is a withdrawal that usually does not land.
try {
  await retireProviderCapabilities(admin, FLEET_PROVIDERS);
} catch { /* the space may already be gone; shutting down regardless */ }
await sleep(100);
Deno.exit(0);
