// Inference-worker. Claims `llm_call` records, streams a completion from OpenRouter, emits
// `llm_chunk` records on a coarse cadence, and acks the final `llm_result` (message +
// usage). This is the ONLY process holding OPENROUTER_API_KEY; it has no file-read access.
// Launched by chat.ts with --allow-net --allow-env.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { type ChatMessage, streamChat, type ToolCall, type ToolDef } from "./openrouter.ts";

const argUrl = (() => {
  const i = Deno.args.indexOf("--url");
  return i >= 0 ? Deno.args[i + 1] : undefined;
})();

const url = argUrl ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const model = Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
const client = new RadiaClient(url);

await agentLoop(client, {
  name: "inference",
  templates: [{ kind: "llm_call" }],
  leaseSeconds: 60, // inference can be slow; the heartbeat keeps the lease alive
  handle: async (rec, c) => {
    const callId = rec.id;
    const body = rec.body as { conversationId: string; upToIndex: number; model?: string; tools?: ToolDef[] };
    let index = 0;
    try {
      // Reconstruct the context from the space — the thread lives in `message` records,
      // not in the call body. History is stored once; we read it (not re-embed it).
      const rows = await c.query(
        { kind: "message", match: { conversationId: body.conversationId }, orderBy: [{ path: "index" }] },
        2000,
      );
      const messages: ChatMessage[] = rows
        .map((r) => r.body as { index: number; role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string })
        .filter((m) => m.index <= body.upToIndex)
        .map((m) => {
          const cm: ChatMessage = { role: m.role };
          if (m.content !== undefined) cm.content = m.content;
          if (m.tool_calls) cm.tool_calls = m.tool_calls;
          if (m.tool_call_id) cm.tool_call_id = m.tool_call_id;
          return cm;
        });

      const { message, finishReason, usage } = await streamChat(
        { apiKey, model: body.model ?? model, messages, tools: body.tools },
        async (delta) => {
          await c.put({ kind: "llm_chunk", body: { callId, index: index++, delta }, parentIds: [callId] });
        },
      );
      return { kind: "llm_result", body: { callId, message, finishReason, usage } };
    } catch (e) {
      // Don't nack (that retries and double-spends); surface the error as the result.
      return {
        kind: "llm_result",
        body: { callId, message: { role: "assistant", content: `[inference error: ${e}]` }, finishReason: "error" },
      };
    }
  },
});
