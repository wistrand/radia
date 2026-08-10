// An LLM worker: claim an `llm_call`, build its context from the space, stream the answer back as
// records, and ack the transcript entry.
//
// THE PROVIDER IS INJECTED and that is the whole seam. Everything here is Radia work — the claim
// pattern, the chunk stream and its watermark, the context window, the escalation ladder, the two
// ack shapes — and `complete` is the one function that knows an HTTP API. An app binds it to
// whatever it uses; nothing in this file does, which is what keeps the layer dependency-free.
//
// CHUNK INDICES ARE ONE MONOTONIC STREAM PER AWAITED CALL, not per attempt. A worker that escalates
// hands its watermark on, so a reader asks for `index > lastSeen` and never re-scans or replays.
// Attempt boundaries are marked in-band by a `reset` chunk, because text already on a screen cannot
// be unsent.

import { agentLoop } from "../../sdk/ts/loop.ts";
import type { RadiaClient } from "../../sdk/ts/client.ts";
import { type ChatMessage, assembleContext, selectWindow, type ThreadRow, toMessage } from "./context.ts";
import { type ToolDef } from "./capability.ts";
import { liveModels } from "./model.ts";
import { progress } from "./progress.ts";

/** What a provider returns. `usage` is passed through untouched: it is the provider's shape. */
export interface Completion {
  message: ChatMessage;
  finishReason: string;
  usage?: unknown;
}

/**
 * The one function that speaks to a model. `onDelta` is called as text arrives; a caller that does
 * not stream simply never calls it.
 *
 * `part` distinguishes prose from a tool call's arguments. Only prose becomes an `llm_chunk` — a
 * half-built argument list is not something to render — but BOTH count as output, and a provider
 * that reports neither leaves a tool-calling round looking identical to a stalled one. Optional, so
 * a provider that only streams prose keeps calling `onDelta(text)`.
 */
export type Complete = (
  req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; temperature?: number },
  onDelta: (delta: string, part?: "content" | "tool") => Promise<void>,
) => Promise<Completion>;

/** The escalation tool. A model DISCOVERS it like any capability and calls it when out of depth;
 *  this worker intercepts the call and re-dispatches, so it never reaches a client. */
export const ESCALATE: ToolDef = {
  type: "function",
  function: {
    name: "escalate",
    description: "Escalate this turn to a more capable model. Call this ONLY when the request needs " +
      "deeper reasoning/analysis or harder code than you can confidently handle; it re-runs the turn " +
      "on a stronger model and discards your partial work. Do not use it for ordinary turns.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
};

export interface InferenceOptions {
  /** This worker's principal, reported on progress records. */
  provider: string;
  complete: Complete;
  /** The model this worker runs. A call may override it per request. */
  model: string;
  /** The tier it serves; omit to claim every `llm_call`. */
  tier?: string;
  /** Where it sits on the ladder. Escalation goes UP, to the next live tier above this rank. */
  rank?: number;
  /** Newest messages to send. 0 means the whole thread. */
  window?: number;
  /** Ceiling on the current-turn expansion, so one runaway turn stays bounded. */
  windowCap?: number;
  leaseSeconds?: number;
  /** How often to report that a still-running completion is alive. See the heartbeat below. */
  heartbeatMs?: number;
  signal?: AbortSignal;
}

/** The body of an `llm_call`, in the fields this worker reads. */
interface CallBody {
  conversationId?: string;
  owner?: string;
  upToIndex?: number;
  model?: string;
  tools?: ToolDef[];
  replyTo?: string;
  /** A raw-prompt override: a one-off call carrying its own messages, with no conversation. */
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  /** Chunk watermark handed over on escalation. */
  indexOffset?: number;
  round?: number;
  turnAt?: number;
}

/**
 * The ack, and it is TWO SHAPES because an `llm_call` has two uses.
 *
 * A CONVERSATION call (it names a `conversationId` and a slot after `upToIndex`) acks the assistant
 * `message` itself: the transcript entry IS the work result, written inside the ack's fence, so a
 * reclaimed worker's message is never written and there is exactly one per call. An INLINE call (a
 * classifier carrying its own prompt) is an RPC, its answer belongs in no transcript, and it keeps
 * `llm_result`.
 *
 * `round` and `turnAt` ride along because the chain reads them off this record: without `round` a
 * turn's counter resets every round and its cap can never trip.
 */
function finished(
  body: CallBody,
  callId: string,
  tier: string | undefined,
  message: ChatMessage,
  finishReason: string,
  extra: Record<string, unknown>,
): { kind: string; body: Record<string, unknown> } {
  const shared = { callId, conversationId: body.conversationId, owner: body.owner, tier, finishReason, ...extra };
  if (body.conversationId === undefined) return { kind: "llm_result", body: { ...shared, message } };
  return {
    kind: "message",
    body: {
      ...shared,
      index: (body.upToIndex ?? -1) + 1,
      ...(typeof body.round === "number" ? { round: body.round } : {}),
      ...(typeof body.turnAt === "number" ? { turnAt: body.turnAt } : {}),
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    },
  };
}

/** Rebuild what the model should see, from `message` records rather than from the call body. */
async function contextFor(
  c: RadiaClient,
  body: CallBody,
  window: number,
  cap: number,
): Promise<{ messages: ChatMessage[]; hidden: number }> {
  if (body.messages) return { messages: body.messages, hidden: 0 };
  const upTo = body.upToIndex ?? 0;
  if (window <= 0) {
    const rows = await c.query(
      { kind: "message", match: { conversationId: body.conversationId }, orderBy: [{ path: "index" }] },
      2000,
    );
    return {
      messages: rows.map((r) => toMessage(r.body as ThreadRow)).filter((_, i) => (rows[i].body as ThreadRow).index <= upTo),
      hidden: 0,
    };
  }
  // A descending keyset scan over the sortable `index`, so per-turn cost is bounded by the window
  // rather than by conversation length. Dropping old turns is not lossy here: the omitted messages
  // are still records the agent can retrieve by conversation id, which is why the notice
  // `assembleContext` folds in can be a pointer rather than a summary.
  const tail = await selectWindow(
    async (limit) =>
      (await c.query({
        kind: "message",
        match: { conversationId: body.conversationId, owner: body.owner, index: { $lte: upTo } },
        orderBy: [{ path: "index", dir: "desc" }],
      }, limit)).map((r) => r.body as ThreadRow),
    { window, cap },
  );
  // The standing instructions are the NEWEST system message, not index 0: that is what lets a
  // RESUMED conversation run under a current disposition rather than whatever was written when it
  // started. One indexed query, because `role` is a declared path.
  const newestSystem = (await c.query({
    kind: "message",
    match: { conversationId: body.conversationId, owner: body.owner, role: "system", index: { $lte: upTo } },
    orderBy: [{ path: "index", dir: "desc" }],
  }, 1)).map((r) => r.body as ThreadRow)[0];
  return assembleContext(newestSystem, tail);
}

/** Claim and serve this tier's `llm_call`s until aborted. */
export async function runInferenceWorker(client: RadiaClient, opts: InferenceOptions): Promise<void> {
  const { provider, complete, model, tier } = opts;
  const rank = opts.rank ?? 0;
  const window = opts.window ?? 40;
  const cap = opts.windowCap ?? 400;

  await agentLoop(client, {
    name: `inference:${tier ?? "all"}`,
    patterns: [tier ? { kind: "llm_call", match: { tier } } : { kind: "llm_call" }],
    leaseSeconds: opts.leaseSeconds ?? 60, // inference is slow; the heartbeat keeps the lease alive
    ...(opts.signal ? { signal: opts.signal } : {}),
    handle: async (rec, c) => {
      const callId = rec.id;
      const body = rec.body as CallBody;
      // A router re-dispatches under a new id but sets `replyTo` to the ORIGINAL call the caller
      // awaits. Key the chunks and the result to that, so the caller never sees the indirection.
      const resultKey = body.replyTo ?? callId;
      let index = body.indexOffset ?? 0;
      const reportModel = body.model ?? model;
      await progress(c, {
        conversationId: body.conversationId,
        owner: body.owner,
        callId: resultKey,
        stage: "generating",
        by: provider,
        note: `${tier ?? "any"} · ${reportModel}`,
      }, [callId]);

      const chunk = async (delta: string, reset = false) => {
        if (body.stream === false) return; // a one-off call emits no chunk records
        await c.put({
          kind: "llm_chunk",
          body: { callId: resultKey, conversationId: body.conversationId, owner: body.owner, index: index++, delta, ...(reset ? { reset: true } : {}) },
          parentIds: [callId],
        });
      };

      try {
        const { messages, hidden } = await contextFor(c, body, window, cap);
        // Can this turn escalate? The next live tier above this rank, from the SAME projection a
        // router routes by, so the ladder cannot offer a tier the router considers gone. Offer
        // `escalate` only when a stronger tier exists; otherwise strip it, so the top model answers
        // instead of emitting a call nobody handles.
        const higher = (await liveModels(c)).find((m) => (m.rank ?? 0) > rank);
        const tools = higher ? body.tools : (body.tools ?? []).filter((t) => t.function.name !== "escalate");

        // A HEARTBEAT while the provider thinks. A top-tier model can spend minutes before its
        // first token, and until one arrives there is no chunk and no progress record, so a caller
        // watching for life sees a stopped worker and abandons a turn that is running normally.
        // Cheap: one record per beat, on a kind that declares its own retention.
        //
        // The beat also carries HOW MUCH has been generated, because on a tool-calling round the
        // elapsed second is otherwise the only thing moving: nothing is rendered, so a minute of
        // real work and a hung provider look the same. Characters are what a stream actually
        // yields, so the token figure is `~` and derived (÷4) rather than claimed.
        let outChars = 0;
        const beat = setInterval(() => {
          const tokens = Math.round(outChars / 4);
          progress(c, {
            conversationId: body.conversationId,
            owner: body.owner,
            callId: resultKey,
            stage: "generating",
            by: provider,
            note: `${tier ?? "any"} · ${reportModel}${tokens > 0 ? ` · ~${tokens} tok` : ""}`,
          }, [callId]).catch(() => {});
        }, opts.heartbeatMs ?? 15_000);
        let completion: Completion;
        try {
          completion = await complete(
            { model: body.model ?? model, messages, tools, temperature: body.temperature },
            (delta, part) => {
              outChars += delta.length;
              // A tool call's arguments count as output but are never rendered.
              return part === "tool" ? Promise.resolve() : chunk(delta);
            },
          );
        } finally {
          clearInterval(beat);
        }
        const { message, finishReason, usage } = completion;

        if (higher && message.tool_calls?.some((tc) => tc.function.name === "escalate")) {
          // A model may emit text BEFORE escalating, and it is already on a screen. This attempt is
          // being discarded, so mark the boundary IN the stream and hand the watermark on.
          await chunk("", true);
          await progress(c, {
            conversationId: body.conversationId,
            owner: body.owner,
            callId: resultKey,
            stage: "escalating",
            by: provider,
            note: `${tier} → ${higher.tier}`,
          }, [callId]);
          return {
            kind: "llm_call",
            body: {
              conversationId: body.conversationId,
              owner: body.owner,
              upToIndex: body.upToIndex,
              tools: body.tools,
              tier: higher.tier,
              replyTo: resultKey,
              escalatedFrom: tier,
              indexOffset: index,
              ...(typeof body.round === "number" ? { round: body.round } : {}),
              ...(typeof body.turnAt === "number" ? { turnAt: body.turnAt } : {}),
            },
          };
        }
        // `context` makes the window observable: what was sent, what was left behind, on the record.
        return finished(body, resultKey, tier, message, finishReason, { usage, context: { sent: messages.length, hidden } });
      } catch (e) {
        // Never nack: a retry re-runs the model and spends again. The error IS the answer.
        return finished(body, resultKey, tier, { role: "assistant", content: `[inference error: ${e}]` }, "error", {});
      }
    },
  });
}
