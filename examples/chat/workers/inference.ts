// Inference-worker. Claims `llm_call` records, streams a completion from OpenRouter, emits
// `llm_chunk` records on a coarse cadence, and acks the final `llm_result` (message +
// usage). This is the ONLY process holding OPENROUTER_API_KEY; it has no file-read access.
// Launched by chat.ts with --allow-net --allow-env.

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { assembleContext, selectWindow, type ThreadRow, toMessage } from "../provider/context.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { progress } from "../space/progress.ts";
import { arg, onStop } from "../util.ts";
import { publishCapability } from "../space/capability.ts";
import { publishModel, retireModel } from "../space/model.ts";
import { type ChatMessage, streamChat, type ToolCall, type ToolDef } from "../provider/openrouter.ts";

const ME = "agent:chat-inference";


const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-inference run token (scoped grants)
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
// This worker serves one tier (fast/balanced/deep) with one model; it claims only its tier's
// llm_calls. `--model` is the concrete OpenRouter model; a call may still override via body.model.
const tier = arg("--tier"); // omit → serve ALL tiers (single-worker back-compat)
const model = arg("--model") ?? Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
const rank = Number(arg("--rank") ?? "0"); // capability rank (cheap→capable); escalation goes up
// How many of the newest thread messages to send. 0 = the whole thread (pre-windowing behavior).
// The omitted ones stay retrievable — the assistant knows its own conversation id and can query
// them — so this bounds per-turn cost without making history unreachable.
const WINDOW = Number(arg("--window") ?? Deno.env.get("RADIA_CHAT_WINDOW") ?? "40");
const WINDOW_CAP = 400; // ceiling on the current-turn expansion below, so one runaway turn is bounded
const client = new RadiaClient(url, token ? { token } : {});

/** A `message` record body as stored by the chat. */


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

if (tier) {
  const ad = { tier, model, rank };
  await publishModel(client, ad);
  await publishCapability(client, ESCALATE);
  // A stopped worker must stop being routed to: the router reads `model` records as a latest-wins
  // registry, so a retirement takes the tier out of rotation and the next start revives it.
  onStop(() => retireModel(client, ad));
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
      messages?: ChatMessage[]; // raw-prompt override (a one-off call with its own prompt)
      stream?: boolean; // false → don't emit llm_chunk records (one-off calls)
      temperature?: number; // caller-pinned sampling (the router's classifier sends 0)
      indexOffset?: number; // chunk watermark handed over on escalation (see below)
    };
    // The router re-dispatches under a new id but sets `replyTo` to the ORIGINAL call the chat
    // awaits — key the streamed chunks + result to that, so the chat never sees the indirection.
    const resultKey = body.replyTo ?? callId;
    // Chunk indices are a single monotonic stream per AWAITED call, not per attempt: an escalating
    // worker hands its watermark to the next one, so the chat can ask for `index > lastSeen` and
    // never re-scan or replay. Attempt boundaries are marked in-band (the `reset` chunk below).
    let index = body.indexOffset ?? 0;
    // Which model is actually about to run — the piece the chat can't know, since the tier was
    // chosen by the router. Keyed to resultKey so it lands on the call the chat awaits.
    const reportModel = body.model ?? model;
    await progress(c, {
      conversationId: body.conversationId,
      callId: resultKey,
      stage: "generating",
      by: ME,
      note: `${tier ?? "any"} · ${reportModel}`,
    }, [callId]);
    try {
      // A raw-prompt call (e.g. the router's tier classifier) supplies `messages` directly. A
      // conversation turn reconstructs them from the space — the thread lives in `message`
      // records, not in the call body. History is stored once; we read it (not re-embed it).
      let messages: ChatMessage[];
      let hidden = 0;
      if (body.messages) {
        messages = body.messages;
      } else if (WINDOW <= 0) {
        const rows = await c.query(
          { kind: "message", match: { conversationId: body.conversationId }, orderBy: [{ path: "index" }] },
          2000,
        );
        messages = rows.map((r) => toMessage(r.body as ThreadRow)).filter((_, i) => (rows[i].body as ThreadRow).index <= body.upToIndex);
      } else {
        // Windowed reconstruction: read the NEWEST `WINDOW` messages as a descending keyset scan
        // over the sortable `index`, instead of pulling the thread and slicing. Per-turn cost is
        // bounded by the window, not by conversation length — which is what makes "history is
        // stored once, read incrementally" true of the CONTEXT and not only of storage.
        //
        // Dropping old turns is normally lossy and one-way. Here it isn't: the omitted messages are
        // still records the assistant can retrieve by this conversation's id, which is why the
        // notice below can be a pointer rather than a summary.
        // The window must never evict the CURRENT turn. One tool-heavy turn is a dozen messages on
        // its own (an assistant tool_calls message plus a reply per call), so a fixed count can cut
        // away the very question being answered and leave the model summarizing tool output it can
        // no longer attribute. Expand until the most recent `user` message is inside the window —
        // that message begins the current turn, so including it includes everything after it.
        const tail = await selectWindow(
          async (limit) =>
            (await c.query({
              kind: "message",
              match: { conversationId: body.conversationId, index: { $lte: body.upToIndex } },
              orderBy: [{ path: "index", dir: "desc" }],
            }, limit)).map((r) => r.body as ThreadRow),
          { window: WINDOW, cap: WINDOW_CAP },
        );
        // The standing instructions are the NEWEST system message, not index 0 — that is what lets a
        // RESUMED conversation run under a current disposition instead of whatever was written when
        // it started. One indexed query, because `role` is a declared indexed path.
        const newestSystem = (await c.query({
          kind: "message",
          match: { conversationId: body.conversationId, role: "system", index: { $lte: body.upToIndex } },
          orderBy: [{ path: "index", dir: "desc" }],
        }, 1)).map((r) => r.body as ThreadRow)[0];
        const built = assembleContext(newestSystem, tail);
        messages = built.messages;
        hidden = built.hidden;
      }

      // Can this turn escalate? Find the next-higher-rank tier from the `model` records (the
      // ordering is discovered, not hard-coded). Offer `escalate` only if a stronger tier exists;
      // otherwise strip it so the top model just answers (and can't emit an unhandled escalate).
      // Same filter as the router: an image tier is in the fleet but is not somewhere a text turn
      // can escalate TO. Absent `modalities` means text (workers that predate the field).
      const fleet = (await c.query({ kind: "model" }, 100))
        .map((m) => m.body as { tier: string; rank: number; modalities?: string[] })
        .filter((m) => !m.modalities || m.modalities.includes("text"));
      const higher = fleet.filter((m) => (m.rank ?? 0) > rank).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0];
      const tools = higher ? body.tools : (body.tools ?? []).filter((t) => t.function.name !== "escalate");

      const { message, finishReason, usage } = await streamChat(
        { apiKey, model: body.model ?? model, messages, tools, temperature: body.temperature },
        body.stream === false
          ? () => Promise.resolve() // raw-prompt one-off calls don't emit chunk records
          : async (delta) => {
            await c.put({ kind: "llm_chunk", body: { callId: resultKey, index: index++, delta }, parentIds: [callId] });
          },
      );
      // Self-escalation: the model asked for a stronger model and one exists → re-dispatch the turn
      // to that tier (result stays keyed to the original call). The stronger worker re-decides, so
      // the cascade terminates at the top tier.
      if (higher && message.tool_calls?.some((tc) => tc.function.name === "escalate")) {
        // A model may emit text BEFORE calling escalate, and those chunks are already on the user's
        // screen — this attempt's work is being discarded, so say so IN the stream: an empty-delta
        // `reset` chunk marks the boundary, and `indexOffset` carries the watermark so the next
        // worker continues one monotonic sequence instead of replaying indices from zero.
        if (body.stream !== false) {
          await c.put({ kind: "llm_chunk", body: { callId: resultKey, index: index++, delta: "", reset: true }, parentIds: [callId] });
        }
        await progress(c, {
          conversationId: body.conversationId,
          callId: resultKey,
          stage: "escalating",
          by: ME,
          note: `${tier} → ${higher.tier}`,
        }, [callId]);
        return {
          kind: "llm_call",
          body: {
            conversationId: body.conversationId,
            upToIndex: body.upToIndex,
            tools: body.tools,
            tier: higher.tier,
            replyTo: resultKey,
            escalatedFrom: tier,
            indexOffset: index,
          },
        };
      }
      // `context` makes the window observable: what was sent, what was left behind. Measurable
      // without instrumentation — it is a record, so `space_query {kind: llm_result}` answers
      // "did windowing change how often the assistant reaches for its own history?".
      return {
        kind: "llm_result",
        body: { callId: resultKey, message, finishReason, usage, tier, context: { sent: messages.length, hidden } },
      };
    } catch (e) {
      // Don't nack (that retries and double-spends); surface the error as the result.
      return {
        kind: "llm_result",
        body: { callId: resultKey, message: { role: "assistant", content: `[inference error: ${e}]` }, finishReason: "error", tier },
      };
    }
  },
});
