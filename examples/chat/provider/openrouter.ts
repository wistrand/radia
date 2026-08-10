import type { ToolDef } from "../../../extensions/ts/capability.ts";
import type { ChatMessage } from "../../../extensions/ts/context.ts";
// Thin OpenRouter client (OpenAI-compatible chat completions, streaming + tool calling).
// Only the inference-worker imports this; it is the sole holder of the API key.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// Owned by ./../../../extensions/ts/context.ts, for the reason `ToolDef` is owned by capability.ts:
// this client is one consumer of the shape, not its authority.
export type { ChatMessage };

// The shape a `capability` record carries, so it is owned there rather than here: this client is
// one consumer of it, not its authority. Re-exported because every tool definition in the app
// reaches for it through the provider.
export type { ToolDef };

export interface StreamOpts {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number; // set 0 for decisions that must not vary run to run (e.g. tier routing)
}

export interface StreamResult {
  message: ChatMessage;
  finishReason: string;
  usage?: Record<string, unknown>;
}

// `RADIA_CHAT_API_BASE` points the fleet at any OpenAI-compatible endpoint: a local stub for
// offline testing (escalation, streaming, image generation) or a self-hosted gateway.
export const API_BASE = Deno.env.get("RADIA_CHAT_API_BASE") ?? "https://openrouter.ai/api/v1";
const ENDPOINT = `${API_BASE}/chat/completions`;

/**
 * Stream a completion. `onChunk` is called with accumulated content text on a coarse
 * cadence (~150 ms) so callers can emit chunk records without flooding; content and any
 * tool calls are assembled from the SSE deltas and returned whole.
 */
export async function streamChat(opts: StreamOpts, onChunk: (text: string) => Promise<void>): Promise<StreamResult> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/wistrand/radia",
      "X-Title": "Radia chat",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      tool_choice: opts.tools ? "auto" : undefined,
      temperature: opts.temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "";
  let usage: Record<string, unknown> | undefined;
  let pending = "";
  let lastFlush = Date.now();

  const flush = async (force: boolean) => {
    if (pending && (force || Date.now() - lastFlush > 150)) {
      await onChunk(pending);
      pending = "";
      lastFlush = Date.now();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        content += delta.content;
        pending += delta.content;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          toolCalls[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      await flush(false);
    }
  }
  await flush(true);

  const message: ChatMessage = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
  };
  return { message, finishReason, usage };
}
