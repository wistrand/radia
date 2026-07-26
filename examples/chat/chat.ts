// CLI chatbot — pure record I/O. It makes NO external calls; it only reads and writes records.
// Thinking (`llm_call` → `llm_result`, streamed as `llm_chunk`), acting (`tool_call` →
// `tool_result`), drawing, code execution and saved files all flow through the space, served by
// workers this launches as scoped subprocesses. Watch the whole loop in the console's Feed tab.
//
//   OPENROUTER_API_KEY=... deno task chat
//
// The map. Five areas, each answering one question:
//
//   chat.ts       this file — bootstrap, launch, banner, the REPL loop
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
//     save.ts (store content) · exec-sandbox.ts (permissionless code execution)
//     workers/exec.ts also serves save_procedure/read_procedure: named, reusable programs
//
//   space/        how this app uses Radia
//     kinds.ts (record kinds, incl. `procedure`) · roles.ts (grants + run tokens)
//     capability.ts (advertising a tool) · progress.ts (turn progress as records)
//
//   provider/     the outside world
//     openrouter.ts (chat completions) · imagegen.ts (image generation)
//     context.ts (thread records → provider payload; pure, and where the context bugs live)

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, CHAT_USER } from "./space/roles.ts";
import { apiKey, execRoots, resume, role, spaceDb, TIERS, toolRoots, url } from "./client/config.ts";
import { launchFleet, spawnSpace } from "./client/fleet.ts";
import { ToolSet } from "./client/turn.ts";
import { Thread } from "./client/thread.ts";
import { runTurn } from "./client/turn.ts";
import { watchWakeups } from "./client/waiting.ts";
import { lineReader, write } from "./client/terminal.ts";
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

// `admin` is the OPERATOR client used to bootstrap (register kinds, assign grants, mint run
// tokens). `session` is what the REPL uses: the operator for role=admin, or a scoped
// agent:chat-user run token for role=user.
const admin = new RadiaClient(url);
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

async function healthy(): Promise<boolean> {
  try {
    await admin.health();
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

// Bootstrap as operator, then hand each worker its own least-privilege run token.
await registerChatKinds(admin);
const tokens = await bootstrap(admin, role);
const session = new RadiaClient(url, tokens.sessionToken ? { token: tokens.sessionToken } : {});
procs.push(...launchFleet(tokens));

const tools = new ToolSet(session);
tools.watch(shutdown.signal); // background: keep the tool set live from capability records
watchWakeups(session, shutdown.signal); // background: let the runtime push instead of polling

Deno.addSignalListener("SIGINT", () => {
  cleanup();
  Deno.exit(0);
});

console.log(`radia chat — role ${role}`);
console.log(`tiers: ${Object.entries(TIERS).map(([t, m]) => `${t}=${m}`).join("  ")}`);
console.log("routing: automatic — a router-worker classifies each turn and picks the tier; workers escalate when out of depth (no /commands).");
console.log(
  role === "admin"
    ? "auth: session runs as the OPERATOR — space_* inspect/remediate tools have full /ops access."
    : "auth: session runs as scoped agent:chat-user — it can converse, but space_* /ops tools will 403 (try 'is the space healthy?').",
);
console.log(`sandbox: ${toolRoots.join(", ")}`);
console.log(
  execRoots.length
    ? `code execution: readable roots ${execRoots.join(", ")} (still no network, no write, no env)`
    : "code execution: no filesystem (set RADIA_CHAT_EXEC_DIRS to grant read-only roots)",
);
console.log(
  `space ${url}${usingRunning ? " (existing)" : ` (spawned, persisted at ${spaceDb})`} — open it and watch the Feed tab. Ctrl-D to quit.`,
);

// Resume, or start fresh. `last` is resolved with the OPERATOR client on purpose: enumerating
// conversations would otherwise need a `conversation: query` grant on the scoped session, which
// would let a user session list every conversation on the space — a real widening to save a
// keystroke. The REPL already holds the operator credential it bootstrapped with.
async function openThread(): Promise<Thread> {
  if (!resume) return await Thread.open(session, role);
  let id = resume;
  if (resume === "last") {
    // Newest first — the keyset direction, which is the only way to ask for the most recent.
    const recent = await admin.query({ kind: "conversation" }, 1, { dir: "desc" });
    if (recent.length === 0) {
      write("no conversation to resume; starting a new one\n");
      return await Thread.open(session, role);
    }
    id = recent[0].id;
  }
  return await Thread.resume(session, id, role);
}

let thread: Thread;
try {
  thread = await openThread();
} catch (e) {
  console.error(`could not resume: ${e}`);
  cleanup();
  Deno.exit(1);
}
if (thread.resumedFrom > 0) {
  console.log(`resumed conversation ${thread.id} — ${thread.resumedFrom} earlier messages are in context`);
} else {
  console.log(`conversation ${thread.id} — resume it later with --conversation ${thread.id} (or --conversation last)`);
}
// Procedures belong to a conversation, so the tool set can only be complete once there is one.
await tools.scopeTo(thread.id);

// Wait for the workers to publish their capabilities (the watch fills the set).
for (let i = 0; i < 50 && tools.all().length === 0; i++) await sleep(200);

const nextLine = lineReader();
while (true) {
  write("\nyou> ");
  const line = await nextLine();
  if (line === null) break; // EOF / Ctrl-D
  if (!line.trim()) continue;
  await thread.append({ role: "user", content: line });
  try {
    await runTurn(session, thread, tools);
  } catch (e) {
    write(`\n[error] ${e}\n`);
  }
  // Between turns, so it owns the terminal: if the assistant hit a `forbidden` and asked for
  // authority, the person in the conversation decides now. `admin` is the operator credential this
  // process bootstrapped with — the session itself cannot write a grant, which is the point.
  try {
    await reviewGrantRequests(session, admin, CHAT_USER, thread.id, nextLine);
    await tools.scopeTo(thread.id); // a new grant may have changed what is reachable
  } catch (e) {
    write(`\n[grant review failed] ${e}\n`);
  }
}

cleanup();
await sleep(100);
Deno.exit(0);
