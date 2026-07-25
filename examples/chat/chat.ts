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

// Default to the same port as `deno task dev` (7788) so, if you have the web console open,
// the chat's records show up there. Spawns its own space only if none is running.
const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const port = new URL(url).port || "7788";

// TODO: use google/gemini-2.5-flash-lite for auto-tier selection

// Three capability/cost tiers, each served by its own inference-worker (model selection is
// content-routing). Two models across three tiers: fast/balanced use the cheap model, deep the
// capable one — point `balanced` at a mid-tier model via the env var. The chat does NOT choose a
// tier: it puts UNTIERED llm_calls; the router-worker classifies each turn and picks the tier.
const TIERS: Record<string, string> = {
  fast: Deno.env.get("RADIA_CHAT_MODEL_FAST") ?? "openai/gpt-4o-mini",
  balanced: Deno.env.get("RADIA_CHAT_MODEL_BALANCED") ?? "anthropic/claude-sonnet-5",
  deep: Deno.env.get("RADIA_CHAT_MODEL_DEEP") ?? "anthropic/claude-opus-5",
};
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
// Router-worker (agent:chat-router): claims UNTIERED llm_calls and picks the tier per turn, so
// the chat holds no routing logic. Model selection is delegated to the substrate.
procs.push(
  new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-env", "examples/chat/router.ts", "--url", url, "--token", routerToken],
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
console.log("routing: automatic — a router-worker classifies each turn and picks the tier (no /commands).");
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
  "deliberately, and prefer to inspect before acting.\n" +
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

await appendMessage({ role: "system", content: SYSTEM_PROMPT });

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
    const { message: msg, finishReason, streamed, tier } = await streamResult(callId);
    if (tier) write(`  \x1b[2m[routed → ${tier}]\x1b[0m\n`);
    await appendMessage({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls }, [callId]);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      write("\n");
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch { /* leave empty */ }
        write(`  · ${tc.function.name}(${trunc(JSON.stringify(args), 60)}) `);
        const { id: toolCallId } = await client.put({ kind: "tool_call", body: { tool: tc.function.name, args }, parentIds: [conversationId] });
        const result = await pollResult(toolCallId);
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
}

// Poll llm_chunk + llm_result for a call, printing deltas as they arrive.
async function streamResult(callId: string): Promise<StreamedResult> {
  let lastIndex = -1;
  const printNew = async () => {
    const chunks = await client.query({ kind: "llm_chunk", match: { callId }, orderBy: [{ path: "index" }] }, 1000);
    for (const ch of chunks) {
      const b = ch.body as { index: number; delta: string };
      if (b.index > lastIndex) {
        write(b.delta);
        lastIndex = b.index;
      }
    }
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await printNew();
    const result = await client.readOne({ kind: "llm_result", match: { callId } });
    if (result) {
      await printNew(); // flush any stragglers
      const body = result.body as { message: ChatMessage; finishReason: string; tier?: string };
      return { message: body.message, finishReason: body.finishReason, streamed: lastIndex >= 0, tier: body.tier };
    }
    await sleep(120);
  }
  throw new Error("timed out waiting for inference (is OPENROUTER_API_KEY valid and the model available?)");
}

async function pollResult(callId: string): Promise<{ ok: boolean; output: unknown }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await client.readOne({ kind: "tool_result", match: { callId } });
    if (r) return r.body as { ok: boolean; output: unknown };
    await sleep(120);
  }
  throw new Error("timed out waiting for tool_result");
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
