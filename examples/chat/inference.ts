// Inference-worker. Claims `llm_call` records, streams a completion from OpenRouter, emits
// `llm_chunk` records on a coarse cadence, and acks the final `llm_result` (message +
// usage). This is the ONLY process holding OPENROUTER_API_KEY; it has no file-read access.
// Launched by chat.ts with --allow-net --allow-env.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { type ChatMessage, streamChat, type ToolCall, type ToolDef } from "./openrouter.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-inference run token (scoped grants)
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
// This worker serves one tier (fast/balanced/deep) with one model; it claims only its tier's
// llm_calls. `--model` is the concrete OpenRouter model; a call may still override via body.model.
const tier = arg("--tier"); // omit → serve ALL tiers (single-worker back-compat)
const model = arg("--model") ?? Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
const rank = Number(arg("--rank") ?? "0"); // capability rank (cheap→capable); escalation goes up
const client = new RadiaClient(url, token ? { token } : {});

// The `escalate` tool: the model DISCOVERS it (like any capability) and calls it when it's out of
// depth; this worker INTERCEPTS the call and re-dispatches the turn to a stronger tier (never
// surfaced to the chat). Guidance lives in the description, not the chat's prompt.
const ESCALATE: ToolDef = {
  type: "function",
  function: {
    name: "escalate",
    description: "Escalate this turn to a more capable model. Call this ONLY when the request needs " +
      "deeper reasoning/analysis or harder code than you can confidently handle; it re-runs the turn " +
      "on a stronger model and discards your partial work. Do not use it for ordinary turns.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
};
// Content-key (hashed → header-safe) so a changed def is a successor, not a 409.
async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (tier) {
  await client.put({ kind: "model", body: { tier, model, rank } }, `model:${tier}:${model}:${rank}`);
  await client.put({ kind: "capability", body: { tool: "escalate", def: ESCALATE } }, `capability:escalate:${await defHash(ESCALATE)}`);
}

await agentLoop(client, {
  name: `inference:${tier ?? "all"}`,
  templates: [tier ? { kind: "llm_call", match: { tier } } : { kind: "llm_call" }],
  leaseSeconds: 60, // inference can be slow; the heartbeat keeps the lease alive
  handle: async (rec, c) => {
    const callId = rec.id;
    const body = rec.body as {
      conversationId: string;
      upToIndex: number;
      model?: string;
      tools?: ToolDef[];
      replyTo?: string;
      messages?: ChatMessage[]; // raw-prompt override (e.g. the router's tier classifier)
      stream?: boolean; // false → don't emit llm_chunk records (one-off calls)
    };
    // The router re-dispatches under a new id but sets `replyTo` to the ORIGINAL call the chat
    // awaits — key the streamed chunks + result to that, so the chat never sees the indirection.
    const resultKey = body.replyTo ?? callId;
    let index = 0;
    try {
      // A raw-prompt call (e.g. the router's tier classifier) supplies `messages` directly. A
      // conversation turn reconstructs them from the space — the thread lives in `message`
      // records, not in the call body. History is stored once; we read it (not re-embed it).
      let messages: ChatMessage[];
      if (body.messages) {
        messages = body.messages;
      } else {
        const rows = await c.query(
          { kind: "message", match: { conversationId: body.conversationId }, orderBy: [{ path: "index" }] },
          2000,
        );
        messages = rows
          .map((r) => r.body as { index: number; role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string })
          .filter((m) => m.index <= body.upToIndex)
          .map((m) => {
            const cm: ChatMessage = { role: m.role };
            if (m.content !== undefined) cm.content = m.content;
            if (m.tool_calls) cm.tool_calls = m.tool_calls;
            if (m.tool_call_id) cm.tool_call_id = m.tool_call_id;
            return cm;
          });
      }

      // Can this turn escalate? Find the next-higher-rank tier from the `model` records (the
      // ordering is discovered, not hard-coded). Offer `escalate` only if a stronger tier exists;
      // otherwise strip it so the top model just answers (and can't emit an unhandled escalate).
      const fleet = (await c.query({ kind: "model" }, 100)).map((m) => m.body as { tier: string; rank: number });
      const higher = fleet.filter((m) => (m.rank ?? 0) > rank).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0];
      const tools = higher ? body.tools : (body.tools ?? []).filter((t) => t.function.name !== "escalate");

      const { message, finishReason, usage } = await streamChat(
        { apiKey, model: body.model ?? model, messages, tools },
        body.stream === false
          ? () => Promise.resolve() // raw-prompt/classify calls don't emit chunk records
          : async (delta) => {
            await c.put({ kind: "llm_chunk", body: { callId: resultKey, index: index++, delta }, parentIds: [callId] });
          },
      );
      // Self-escalation: the model asked for a stronger model and one exists → re-dispatch the turn
      // to that tier (result stays keyed to the original call). A tool-call turn streams no text, so
      // nothing was shown. The stronger worker re-decides, so the cascade terminates at the top tier.
      if (higher && message.tool_calls?.some((tc) => tc.function.name === "escalate")) {
        return { kind: "llm_call", body: { conversationId: body.conversationId, upToIndex: body.upToIndex, tools: body.tools, tier: higher.tier, replyTo: resultKey, escalatedFrom: tier } };
      }
      return { kind: "llm_result", body: { callId: resultKey, message, finishReason, usage, tier } };
    } catch (e) {
      // Don't nack (that retries and double-spends); surface the error as the result.
      return {
        kind: "llm_result",
        body: { callId: resultKey, message: { role: "assistant", content: `[inference error: ${e}]` }, finishReason: "error", tier },
      };
    }
  },
});
