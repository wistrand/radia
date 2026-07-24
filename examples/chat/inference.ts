// Inference-worker. Claims `llm_call` records, streams a completion from OpenRouter, emits
// `llm_chunk` records on a coarse cadence, and acks the final `llm_result` (message +
// usage). This is the ONLY process holding OPENROUTER_API_KEY; it has no file-read access.
// Launched by chat.ts with --allow-net --allow-env.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { type ChatMessage, streamChat, type ToolDef } from "./openrouter.ts";

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
    const body = rec.body as { model?: string; messages: ChatMessage[]; tools?: ToolDef[] };
    let index = 0;
    try {
      const { message, finishReason, usage } = await streamChat(
        { apiKey, model: body.model ?? model, messages: body.messages, tools: body.tools },
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
