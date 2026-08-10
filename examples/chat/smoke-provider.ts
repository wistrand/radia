// What the provider client reports while a model is still writing:
//
//   deno run -A examples/chat/smoke-provider.ts
//
// No API key: an SSE stub stands in for OpenRouter. The case that matters is a TOOL-CALLING round.
// Its arguments stream exactly like prose does, but nothing renders them, so a caller told only
// about content sees a silent minute and cannot tell a model writing a long argument list from a
// stalled one. That was the live complaint: "the only progress is time".

import { streamChat } from "./provider/openrouter.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const sse = (frames: unknown[]) =>
  [...frames.map((f) => `data: ${JSON.stringify(f)}`), "data: [DONE]", ""].join("\n");

/** A stub that streams whatever frames it is handed. */
function serve(frames: unknown[]) {
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(sse(frames), { headers: { "content-type": "text/event-stream" } }),
  );
}

const delta = (d: unknown) => ({ choices: [{ delta: d }] });
const argChunk = (args: string) => delta({ tool_calls: [{ index: 0, function: { arguments: args } }] });

// ── a tool call's arguments are REPORTED, in pieces, as they arrive ──────────────────────────────
{
  const server = serve([
    delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "save_workspace", arguments: "" } }] }),
    argChunk('{"name":"tree",'),
    argChunk('"files":{"a.js":"'),
    argChunk('console.log(1)"}}'),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 4210, cost: 0.0031 } },
  ]);
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1`;
  Deno.env.set("RADIA_CHAT_API_BASE", base);
  // Imported fresh so the module reads the stub's address: API_BASE is resolved at load.
  const { streamChat: stream } = await import(`./provider/openrouter.ts?stub=${(server.addr as Deno.NetAddr).port}`);

  const seen: { text: string; part?: string }[] = [];
  const res = await stream(
    { apiKey: "unused", model: "stub/model", messages: [{ role: "user", content: "go" }], tools: [] },
    (text: string, part?: string) => {
      seen.push({ text, part });
      return Promise.resolve();
    },
  );

  const tool = seen.filter((s) => s.part === "tool");
  check("a tool call's arguments reach the caller at all", tool.length > 0, `${seen.length} callbacks, ${tool.length} tool`);
  check("…labelled as tool, never as prose", tool.every((s) => s.part === "tool"));
  check("…in more than one piece, so a counter MOVES during the wait", tool.length >= 3, `${tool.length} pieces`);
  const streamed = tool.map((s) => s.text).join("");
  check("…and they carry real characters to count", streamed.length > 20, `${streamed.length} chars`);
  check("no prose was reported for a tool-only round", seen.every((s) => s.part === "tool"), JSON.stringify(seen.map((s) => s.part)));

  // The assembled call must still be correct: reporting the pieces must not consume them.
  const call = res.message.tool_calls?.[0];
  check("the call is still assembled whole", call?.function.name === "save_workspace", JSON.stringify(call?.function.name));
  check("…with its arguments intact", call?.function.arguments === '{"name":"tree","files":{"a.js":"console.log(1)"}}', String(call?.function.arguments));
  check("…and parseable, which is the point of assembling it", (() => {
    try {
      JSON.parse(call?.function.arguments ?? "");
      return true;
    } catch {
      return false;
    }
  })());

  // The numbers the chat keeps on the record and prints after the answer.
  check("the provider's usage is passed through", res.usage?.total_tokens === 4210, JSON.stringify(res.usage));
  check("…including cost when the provider prices the call", res.usage?.cost === 0.0031, String(res.usage?.cost));
  await server.shutdown();
}

// ── prose is unlabelled, so an existing caller is unaffected ─────────────────────────────────────
{
  const server = serve([
    delta({ content: "hello " }),
    delta({ content: "world" }),
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 12 } },
  ]);
  Deno.env.set("RADIA_CHAT_API_BASE", `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1`);
  const { streamChat: stream } = await import(`./provider/openrouter.ts?stub2=${(server.addr as Deno.NetAddr).port}`);

  const seen: { text: string; part?: string }[] = [];
  const res = await stream(
    { apiKey: "unused", model: "stub/model", messages: [{ role: "user", content: "hi" }] },
    (text: string, part?: string) => {
      seen.push({ text, part });
      return Promise.resolve();
    },
  );
  check("prose arrives with no part, as it always did", seen.length > 0 && seen.every((s) => s.part === undefined), JSON.stringify(seen.map((s) => s.part)));
  check("…and says what the model said", res.message.content === "hello world", String(res.message.content));
  check("a call with no cost reports none, rather than zero", res.usage?.cost === undefined, JSON.stringify(res.usage));
  await server.shutdown();
}

// `streamChat` is imported at the top purely so a rename breaks this file rather than silently
// skipping it: the cases above import per-stub to pick up each server's address.
check("the module under test is the one the fleet uses", typeof streamChat === "function");

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
