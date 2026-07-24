// CLI chatbot — pure record I/O. It makes NO external calls; it only reads and writes
// records. Thinking (llm_call -> llm_result, streamed via llm_chunk) and acting (tool_call
// -> tool_result) both flow through the space, served by the inference-worker and
// tool-worker this launches as scoped subprocesses. Watch the whole loop in the dev
// console Feed tab.
//
//   OPENROUTER_API_KEY=... deno task chat

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./kinds.ts";
import type { ChatMessage, ToolDef } from "./openrouter.ts";

// Tools are DISCOVERED from the space, not hard-coded: each tool-worker publishes its tools
// as `capability` records. The chatbot keeps a live tool set by WATCHING those records — a new
// capability record appears in the stream and the tool is available on the next turn, no code
// change and no per-turn re-query. `discoverTools()` returns the watched cache.
let toolCache: ToolDef[] = [];
async function refreshTools(): Promise<void> {
  const caps = await client.query({ kind: "capability" }, 200);
  toolCache = caps.map((c) => (c.body as { def: ToolDef }).def);
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
const model = Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
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

const client = new RadiaClient(url);
const procs: Deno.ChildProcess[] = [];
let spawnedSpace = false;

async function healthy(): Promise<boolean> {
  try {
    await client.health();
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

await registerChatKinds(client);

// Inference-worker: has the API key, no file access.
procs.push(
  new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-env", "examples/chat/inference.ts", "--url", url],
    stdout: "null",
    stderr: "inherit",
    stdin: "null",
  }).spawn(),
);
// Tool-worker: can read only the sandbox dirs, can reach only the local space, no env.
procs.push(
  new Deno.Command("deno", {
    args: [
      "run",
      `--allow-net=127.0.0.1:${port}`,
      `--allow-read=${roots.join(",")}`,
      "examples/chat/toolworker.ts",
      "--url",
      `http://127.0.0.1:${port}`,
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

console.log(`radia chat — model ${model}`);
console.log(`sandbox: ${roots.join(", ")}`);
console.log(`space ${url}${spawnedSpace ? " (spawned)" : " (existing)"} — open it and watch the Feed tab. Ctrl-D to quit.`);

const SYSTEM_PROMPT =
  "You are a concise assistant on Radia, a content-routed coordination runtime. Your " +
  "available tools are the functions provided to you; they are discovered from the space, so " +
  "the set may change between turns. Do not confuse your tools with record kinds. Everything " +
  "in Radia is a record — including this conversation (kind 'message', matched by your " +
  "conversationId) and your own reasoning (llm_call/llm_result) — so your space_* tools can " +
  "inspect and even remediate the space itself. Use state-changing tools deliberately, and " +
  "prefer to inspect before acting.";

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
    // The call references the thread by (conversationId, upToIndex) — no embedded history.
    const upToIndex = nextIndex - 1;
    const { id: callId } = await client.put({
      kind: "llm_call",
      body: { conversationId, upToIndex, model, tools: discoverTools() },
      parentIds: [conversationId],
    });
    const { message: msg, finishReason, streamed } = await streamResult(callId);
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
      const body = result.body as { message: ChatMessage; finishReason: string };
      return { message: body.message, finishReason: body.finishReason, streamed: lastIndex >= 0 };
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
