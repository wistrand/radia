// CLI chatbot — pure record I/O. It makes NO external calls; it only reads and writes
// records. Thinking (llm_call -> llm_result, streamed via llm_chunk) and acting (tool_call
// -> tool_result) both flow through the space, served by the inference-worker and
// tool-worker this launches as scoped subprocesses. Watch the whole loop in the dev
// console Feed tab.
//
//   OPENROUTER_API_KEY=... deno task chat

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./kinds.ts";
import { bootstrap, type Role } from "./roles.ts";
import type { ChatMessage, ToolDef } from "./openrouter.ts";

// Tools are DISCOVERED from the space, not hard-coded: each tool-worker publishes its tools
// as `capability` records. The chatbot keeps a live tool set by WATCHING those records — a new
// capability record appears in the stream and the tool is available on the next turn, no code
// change and no per-turn re-query. `discoverTools()` returns the watched cache.
let toolCache: ToolDef[] = [];
async function refreshTools(): Promise<void> {
  // Latest capability record per tool wins (a changed tool def is a successor record — same
  // successor-latest pattern as kind_def declarations), so a redefined tool isn't a duplicate.
  const caps = await client.query({ kind: "capability" }, 500);
  const latest = new Map<string, { id: string; def: ToolDef }>();
  for (const c of caps) {
    const b = c.body as { tool: string; def: ToolDef };
    const prev = latest.get(b.tool);
    if (!prev || prev.id < c.id) latest.set(b.tool, { id: c.id, def: b.def });
  }
  toolCache = [...latest.values()].map((v) => v.def);
}
function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
function discoverTools(): ToolDef[] {
  return toolCache;
}
/** Maintain toolCache from the capability record stream until aborted. */
async function watchCapabilities(signal: AbortSignal): Promise<void> {
  await refreshTools(); // seed
  try {
    for await (const _ of client.watch({ kind: "capability" }, signal)) await refreshTools();
  } catch { /* aborted on shutdown */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(enc.encode(s));

// ---- live turn status, rendered from `progress` records ----
// The workers publish what they are doing (progress.ts); the chat redraws the current line as
// `<prefix><dim status>` and wipes the status once real output starts. Only on a TTY — piped
// output stays byte-identical to the no-status version.
const tty = Deno.stdout.isTerminal();
const showStatus = (prefix: string, s: string) => tty && write(`\r\x1b[2K${prefix}\x1b[2m${trunc(s, 100)}\x1b[0m`);
const endStatus = (prefix: string) => tty && write(`\r\x1b[2K${prefix}`);

// ---- watch-driven wakeups ----
// The wait loops below are woken by the runtime, not by a fixed poll interval: a background watch
// per streaming kind turns "a matching record became available" into a signal. The fallback tick
// keeps a turn moving if a watch is dropped or forbidden, so this is an optimization, never a
// dependency. Wakeups carry only {seq, recordId, kind} — the loops still read what they need.
const WAKE_FALLBACK_MS = 250;
const WAKE_KINDS = ["llm_chunk", "llm_result", "tool_result"];
const waiters = new Set<() => void>();

function doWake(): void {
  const pending = [...waiters];
  waiters.clear();
  for (const w of pending) w();
}

function waitWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const fire = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(fire);
      resolve();
    }, ms);
    waiters.add(fire);
  });
}

/** Background: one watch per streaming kind, each wakeup releasing whatever turn is waiting. */
function watchWakeups(signal: AbortSignal): void {
  for (const kind of WAKE_KINDS) {
    (async () => {
      try {
        for await (const _ of client.watch({ kind }, signal)) doWake();
      } catch { /* aborted, or no grant to watch this kind: the fallback tick covers it */ }
    })();
  }
}

// ---- waiting on a call: render worker progress, and name the failure when nothing claims it ----
// Everything the REPL loop below reaches at runtime must be initialized ABOVE it: the loop runs
// to EOF, so a `const` declared after it stays in the temporal dead zone forever.

// No progress record by now means no worker has CLAIMED the call: the record is sitting
// available with nobody serving its template. That's a configuration failure, not slowness, so
// the chat says which one instead of burning its whole timeout in silence.
const STALL_MS = 2500;
const PROGRESS_POLL_MS = 400; // slower than the chunk poll; progress changes a few times per call

interface ProgressBody {
  stage: string;
  by: string;
  note?: string;
}

interface Waiter {
  prefix: string; // line prefix to redraw the status after
  seen: Set<string>; // progress record ids already rendered
  last?: ProgressBody;
  started: number;
  nextPoll: number;
}

function newWaiter(prefix: string): Waiter {
  return { prefix, seen: new Set(), started: Date.now(), nextPoll: 0 };
}

/** Poll this call's `progress` records and redraw the status line. No progress at all past
 *  STALL_MS is what turns a silent hang into a diagnosis. */
async function pumpStatus(w: Waiter, callId: string, stallHint: string): Promise<void> {
  const now = Date.now();
  if (now < w.nextPoll) return;
  w.nextPoll = now + PROGRESS_POLL_MS;
  try {
    const rows = await client.query({ kind: "progress", match: { callId } }, 20);
    for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (w.seen.has(r.id)) continue;
      w.seen.add(r.id);
      w.last = r.body as ProgressBody; // ULID order = emission order, so the last one wins
    }
  } catch { /* no grant to read progress: fall through to the elapsed-only status */ }
  const secs = Math.round((Date.now() - w.started) / 1000);
  if (w.last) showStatus(w.prefix, `${w.last.stage}${w.last.note ? ` ${w.last.note}` : ""} (${w.last.by}) · ${secs}s`);
  else if (Date.now() - w.started > STALL_MS) showStatus(w.prefix, `${stallHint} · ${secs}s`);
  else showStatus(w.prefix, `waiting · ${secs}s`);
}

// Default to the same port as `deno task dev` (7788) so, if you have the web console open,
// the chat's records show up there. Spawns its own space only if none is running.
const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const port = new URL(url).port || "7788";

// Three capability/cost tiers, each served by its own inference-worker (model selection is
// content-routing). The chat does NOT choose a tier: it puts UNTIERED llm_calls; a router-worker
// classifies each turn and picks the tier, and a worker that still finds itself out of depth
// escalates.
const TIERS: Record<string, string> = {
  fast: Deno.env.get("RADIA_CHAT_MODEL_FAST") ?? "openai/gpt-4o-mini",
  balanced: Deno.env.get("RADIA_CHAT_MODEL_BALANCED") ?? "anthropic/claude-sonnet-5",
  deep: Deno.env.get("RADIA_CHAT_MODEL_DEEP") ?? "anthropic/claude-opus-5",
};
// The router classifies each turn with this cheap, fast model (a model-overridden llm_call served
// by the inference fleet — the router never holds the API key). Setup config, like TIERS.
const CLASSIFY_MODEL = Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";
const apiKey = Deno.env.get("OPENROUTER_API_KEY");
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys).");
  Deno.exit(1);
}

// Resolve the sandbox roots to real paths; these bound the file tools' --allow-read.
const dirsRaw = Deno.env.get("RADIA_CHAT_DIRS") ?? "examples/chat/sandbox";
const roots: string[] = [];
for (const d of dirsRaw.split(/[:,]/).filter(Boolean)) {
  try {
    roots.push(await Deno.realPath(d));
  } catch {
    console.error(`sandbox dir not found: ${d}`);
  }
}
if (roots.length === 0) {
  console.error("No readable sandbox directories.");
  Deno.exit(1);
}

// `admin` is the OPERATOR client used to bootstrap (register kinds, assign grants, mint run
// tokens). `client` is the SESSION client the REPL uses — operator for role=admin, or a scoped
// agent:chat-user run token for role=user (assigned after bootstrap, below).
const role: Role = (arg("--role") ?? Deno.env.get("RADIA_CHAT_ROLE")) === "user" ? "user" : "admin";
const admin = new RadiaClient(url);
let client: RadiaClient = admin;
const procs: Deno.ChildProcess[] = [];
let spawnedSpace = false;

async function healthy(): Promise<boolean> {
  try {
    await admin.health();
    return true;
  } catch {
    return false;
  }
}

// Connect to a running space, or spawn one.
if (!await healthy()) {
  procs.push(
    new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "src/main.ts", "dev", "--port", port, "--storage", "sqlite"],
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn(),
  );
  spawnedSpace = true;
  for (let i = 0; i < 75 && !await healthy(); i++) await sleep(200);
  if (!await healthy()) {
    console.error("space did not start");
    cleanup();
    Deno.exit(1);
  }
}

// Bootstrap as operator: register kinds, then mint least-privilege run tokens for the workers
// and (for role=user) the scoped session. The REPL then switches to the session client.
await registerChatKinds(admin);
const { inferenceToken, routerToken, toolsToken, sessionToken } = await bootstrap(admin, role);
client = new RadiaClient(url, sessionToken ? { token: sessionToken } : {});

// Tokens are passed to the subprocess workers as args (a local demo; a real deployment would
// use a secret channel, since argv is visible via `ps`).
// One inference-worker per tier (all agent:chat-inference): each claims only `{llm_call, tier}` and
// serves its model. Add a tier here → a new model is live, no orchestrator change (content-routing).
let rank = 0; // TIERS is cheap→capable in insertion order; rank drives escalation direction
for (const [t, m] of Object.entries(TIERS)) {
  procs.push(
    new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-env", "examples/chat/inference.ts", "--url", url, "--token", inferenceToken, "--tier", t, "--model", m, "--rank", String(rank++)],
      stdout: "null",
      stderr: "inherit",
      stdin: "null",
    }).spawn(),
  );
}
// Router-worker (agent:chat-router): claims UNTIERED llm_calls, classifies each turn and picks the
// tier, so the chat holds no routing logic. Model selection is delegated to the substrate.
procs.push(
  new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-env", "examples/chat/router.ts", "--url", url, "--token", routerToken, "--classify-model", CLASSIFY_MODEL],
    stdout: "null",
    stderr: "inherit",
    stdin: "null",
  }).spawn(),
);
// Tool-worker (agent:chat-tools): reads only the sandbox dirs, reaches only the local space, no
// env. Its space_* inspection/remediation tools act as the SESSION principal (--session-token):
// operator for admin (so they work), the scoped user for role=user (so /ops/* calls 403).
procs.push(
  new Deno.Command("deno", {
    args: [
      "run",
      `--allow-net=127.0.0.1:${port}`,
      `--allow-read=${roots.join(",")}`,
      "examples/chat/toolworker.ts",
      "--url",
      `http://127.0.0.1:${port}`,
      "--token",
      toolsToken,
      ...(sessionToken ? ["--session-token", sessionToken] : []),
      ...roots.flatMap((r) => ["--dir", r]),
    ],
    stdout: "null",
    stderr: "inherit",
    stdin: "null",
  }).spawn(),
);

const capWatch = new AbortController();
watchCapabilities(capWatch.signal); // background: keep the tool set live from capability records
watchWakeups(capWatch.signal); // background: let the runtime push, instead of polling on a timer

function cleanup() {
  capWatch.abort();
  for (const p of procs) {
    try {
      p.kill();
    } catch { /* already gone */ }
  }
}
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
console.log(`sandbox: ${roots.join(", ")}`);
console.log(`space ${url}${spawnedSpace ? " (spawned)" : " (existing)"} — open it and watch the Feed tab. Ctrl-D to quit.`);

// Generic role framing only — NO substrate specifics (kind names, matching patterns, tool usage).
// The assistant discovers kinds with space_kinds and learns each tool from its own description
// (published as a capability record). Baking that knowledge here is the anti-pattern the design
// principle warns against (CLAUDE.md "discover, don't hardcode").
const SYSTEM_PROMPT =
  "You are a concise assistant on Radia, a content-routed coordination runtime. Your tools are " +
  "provided to you (discovered from the space, so the set may change between turns); each tool's " +
  "description says what it does and how to use it — rely on those, not on assumptions, and do " +
  "not confuse tools with record kinds. Everything in Radia is a record, including this " +
  "conversation and your own reasoning, so your space_* tools can inspect and even operate on the " +
  "space itself (use space_kinds to see what record kinds exist). Use state-changing tools " +
  "deliberately, and prefer to inspect before acting. If you are unsure what happened earlier in " +
  "this session, retrieve it rather than recall it: your own history is inspectable, and a checked " +
  "answer is worth a tool call where a remembered one is a guess. Do not spend a call on something " +
  "you can already see.\n" +
  (role === "admin"
    ? "This session runs as the OPERATOR: your space_* tools have full access to the space's control plane."
    : "This session runs as a SCOPED USER (agent:chat-user). Use any tool you are given normally — the " +
      "file, compute, and conversation tools all work. Some space_* tools touch the control plane and the " +
      "space may refuse them for this principal. ALWAYS call the tool the task needs; never refuse or skip " +
      "a tool without calling it. Only if a call returns a forbidden/403 error, tell the user plainly that " +
      "you lack the grant for that operation.");

// The conversation is an append-only thread of `message` records on the space, not a
// client-held array. The chatbot appends messages (assigning indices) and reads results;
// the inference-worker reconstructs the context from the thread. So history is stored once
// (linear, not quadratic), the whole conversation is reconstructible, and every message is
// a record in the Feed.
const conversation = await client.put({ kind: "conversation", body: {} });
const conversationId = conversation.id;
let nextIndex = 0;

async function appendMessage(
  msg: { role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string },
  parentIds: string[] = [],
): Promise<void> {
  await client.put({
    kind: "message",
    body: { conversationId, index: nextIndex++, ...msg },
    parentIds: [conversationId, ...parentIds],
  });
}

// The assistant is told its OWN id, not how to use it. Identity is data the agent needs to act on
// its own behalf — the same category as handing a worker a run token — while the mechanism (which
// kind, which match, which order) stays in the tool descriptions where it belongs. Without this the
// disposition above is unusable: the reconstructed thread carries no `conversationId`, the
// `conversation` record has an empty body and no indexed path, and `role=user` cannot enumerate
// conversations at all — so the model could not name the thread it is in.
await appendMessage({ role: "system", content: `${SYSTEM_PROMPT}\nThis conversation's id is ${conversationId}.` });

// Wait for the tool-workers to publish their capabilities (the watch fills the cache).
for (let i = 0; i < 50 && discoverTools().length === 0; i++) await sleep(200);

// Read stdin line by line (works for an interactive TTY and for piped input, unlike prompt()).
const stdin = Deno.stdin.readable.getReader();
const decoder = new TextDecoder();
let inbuf = "";
async function nextLine(): Promise<string | null> {
  while (true) {
    const nl = inbuf.indexOf("\n");
    if (nl >= 0) {
      const line = inbuf.slice(0, nl);
      inbuf = inbuf.slice(nl + 1);
      return line;
    }
    const { value, done } = await stdin.read();
    if (done) {
      if (inbuf) {
        const rest = inbuf;
        inbuf = "";
        return rest;
      }
      return null;
    }
    inbuf += decoder.decode(value, { stream: true });
  }
}

while (true) {
  write("\nyou> ");
  const line = await nextLine();
  if (line === null) break; // EOF / Ctrl-D
  if (!line.trim()) continue;
  await appendMessage({ role: "user", content: line });
  try {
    await turn();
  } catch (e) {
    write(`\n[error] ${e}\n`);
  }
}

cleanup();
await sleep(100);
Deno.exit(0);

// ---- one user turn: loop llm_call / tool_call until a text answer ----

async function turn(): Promise<void> {
  for (let round = 0; round < 8; round++) {
    write("\nassistant> ");
    // An UNTIERED call: the router-worker classifies the turn and re-dispatches it to a tier. The
    // chat picks no model — it just references the thread by (conversationId, upToIndex).
    const upToIndex = nextIndex - 1;
    const { id: callId } = await client.put({
      kind: "llm_call",
      body: { conversationId, upToIndex, tools: discoverTools() },
      parentIds: [conversationId],
    });
    const { message: msg, finishReason, streamed, tier, context } = await streamResult(callId);
    // Show the window only when it actually dropped something — otherwise it is noise.
    const win = context && context.hidden > 0 ? ` · ${context.sent} msgs, ${context.hidden} older not sent` : "";
    if (tier) write(`  \x1b[2m[routed → ${tier}${win}]\x1b[0m\n`);
    await appendMessage({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls }, [callId]);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      write("\n");
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch { /* leave empty */ }
        const prefix = `  · ${tc.function.name}(${trunc(JSON.stringify(args), 60)}) `;
        write(prefix);
        // `conversationId` in the body (not just parentIds) so the tool-worker can key its
        // progress records to this turn — provenance is causality, not a lookup path.
        const { id: toolCallId } = await client.put({
          kind: "tool_call",
          body: { tool: tc.function.name, args, conversationId },
          parentIds: [conversationId],
        });
        const result = await pollResult(toolCallId, prefix, tc.function.name);
        write(`-> ${trunc(JSON.stringify(result.output), 80)}\n`);
        await appendMessage(
          { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result.ok ? result.output : { error: result.output }) },
          [toolCallId],
        );
      }
      continue; // the model reads the tool results from the thread on the next call
    }

    // Final answer. If nothing streamed (an inference error, or a non-streamed reply),
    // print the message content — otherwise errors would be invisible.
    if (!streamed) {
      if (msg.content) write(msg.content);
      else write(`(no content; finish_reason=${finishReason})`);
    }
    write("\n");
    return;
  }
  write("\n[stopped: too many tool rounds]\n");
}

interface StreamedResult {
  message: ChatMessage;
  finishReason: string;
  streamed: boolean;
  tier?: string; // the tier the router chose, stamped by the inference-worker
  context?: { sent: number; hidden: number }; // what the worker's context window sent vs. omitted
}

// Poll llm_chunk + llm_result for a call, printing deltas as they arrive.
async function streamResult(callId: string): Promise<StreamedResult> {
  const w = newWaiter("assistant> ");
  const stall = "no worker claimed this call — is the router/inference fleet running?";
  let lastIndex = -1; // watermark over ONE monotonic stream: an escalation hands it on, never resets
  let printed = false; // any visible text on the line yet
  const printNew = async () => {
    // Incremental read: ask for what's past the watermark instead of re-scanning the whole stream
    // every tick. `index` is an indexed integer on `llm_chunk`, so this is a range scan, and the
    // batch size is a ceiling on a burst, not on the answer.
    const chunks = await client.query(
      { kind: "llm_chunk", match: { callId, index: { $gt: lastIndex } }, orderBy: [{ path: "index" }] },
      500,
    );
    for (const ch of chunks) {
      const b = ch.body as { index: number; delta: string; reset?: boolean };
      if (b.index <= lastIndex) continue;
      lastIndex = b.index;
      if (b.reset) {
        // A worker escalated mid-stream: everything printed so far came from the attempt it just
        // threw away. Say so rather than letting the stronger model's answer append to it.
        if (printed) write(`\n\x1b[2m↩ escalated — restarting on a stronger model\x1b[0m\n`);
        printed = false;
        continue;
      }
      if (!b.delta) continue;
      if (!printed) endStatus(w.prefix); // first token: drop the status, keep the prompt
      write(b.delta);
      printed = true;
    }
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await printNew();
    const result = await client.readOne({ kind: "llm_result", match: { callId } });
    if (result) {
      await printNew(); // flush any stragglers
      if (!printed) endStatus(w.prefix); // nothing streamed (tool-call turn / error)
      const body = result.body as {
        message: ChatMessage;
        finishReason: string;
        tier?: string;
        context?: { sent: number; hidden: number };
      };
      return { message: body.message, finishReason: body.finishReason, streamed: printed, tier: body.tier, context: body.context };
    }
    if (!printed) await pumpStatus(w, callId, stall); // status only until output takes the line
    await waitWake(WAKE_FALLBACK_MS);
  }
  endStatus(w.prefix);
  throw new Error(
    w.last
      ? `timed out waiting for inference after '${w.last.stage}' (${w.last.by}) — is OPENROUTER_API_KEY valid and the model available?`
      : `timed out: ${stall}`,
  );
}

async function pollResult(callId: string, prefix: string, tool: string): Promise<{ ok: boolean; output: unknown }> {
  const w = newWaiter(prefix);
  const stall = `no worker serves '${tool}'`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await client.readOne({ kind: "tool_result", match: { callId } });
    if (r) {
      endStatus(prefix);
      return r.body as { ok: boolean; output: unknown };
    }
    await pumpStatus(w, callId, stall);
    await waitWake(WAKE_FALLBACK_MS);
  }
  endStatus(prefix);
  throw new Error(w.last ? `timed out waiting for tool_result from ${w.last.by}` : `timed out: ${stall}`);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
