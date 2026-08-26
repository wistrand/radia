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
import { assertReadable, type ConversationKey, openBody, sealBody } from "./encrypted.ts";
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
  /**
   * Calls this worker serves AT ONCE. Default 1, the sequential behaviour.
   *
   * This is the fleet's throughput knob, and the reason it exists (agent_docs/plan-scaling.md):
   * serving a call is 5-60s of awaiting a socket, so a worker at 1 makes the whole tier serve one
   * answer at a time no matter what the space could take. Overlapping costs nothing but
   * sockets, since each claim already carries its own fenced lease and heartbeat. The provider's
   * own rate limit is the thing to size it against, not the space.
   */
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * This worker's way to a conversation's DEK (plan-encryption.md phase 3), or absent for a fleet
   * that serves plaintext conversations only.
   *
   * A PORT rather than a key, for the reason `complete` is one: how a key is fetched and who is
   * allowed to is app policy, and this layer stays dependency-free. `owner` is passed so the
   * implementation can bound the lookup by the CALLER rather than trust the id it was named with.
   */
  keys?: (conversationId: string, owner?: string) => Promise<ConversationKey | undefined>;
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
  /** A one-off prompt BY REFERENCE: `system` plus the one message named here, which this worker
   *  reads itself. The router's classifier uses it so the user's text is not duplicated into a
   *  second record (plan-encryption.md phase 0). */
  system?: string;
  classifyOf?: { conversationId?: string; owner?: string; index?: number; context?: string };
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

/**
 * Seal an ack's body, when the ack is a transcript entry and the conversation has a key.
 *
 * Only the `message` shape: an INLINE call's `llm_result` belongs to no conversation and has no key
 * to seal under. `sealBody` is a no-op for a kind carrying no encrypted fields, so this reads as
 * one rule rather than a branch per shape.
 */
async function sealAck(
  ack: { kind: string; body: Record<string, unknown> },
  key: ConversationKey | undefined,
): Promise<{ kind: string; body: Record<string, unknown> }> {
  return key ? { ...ack, body: await sealBody(ack.body, ack.kind, key) } : ack;
}

/** Rebuild what the model should see, from `message` records rather than from the call body. */
/** `contextFor` under test. Exported for `extensions/conformance/inference.test.ts`, which pins
 *  WHOSE conversation a call may load: the check lives in this function's query, so a test that
 *  drove the whole worker would be asserting it three layers away from where it is made. */
export function contextForTest(
  c: RadiaClient,
  body: CallBody,
  window: number,
  cap: number,
  key?: ConversationKey,
): Promise<{ messages: ChatMessage[]; hidden: number }> {
  return contextFor(c, body, window, cap, key);
}

async function contextFor(
  c: RadiaClient,
  body: CallBody,
  window: number,
  cap: number,
  key?: ConversationKey,
): Promise<{ messages: ChatMessage[]; hidden: number }> {
  // Every row this function returns passes through here. Without a key it is the identity function
  // and a marked row reaches `assertReadable` downstream, which is the phase-1 wall; with one the
  // marker is REMOVED, so the same wall stops objecting exactly where a key was applied.
  const open = (b: ThreadRow): Promise<ThreadRow> => key ? openBody(b as never, "message", key) : Promise.resolve(b);
  // The call body carries prose in two shapes (inline `messages`, and `system` beside a reference),
  // so it is a reader's input like any record body and gets the same refusal.
  assertReadable(body, "contextFor(llm_call)");
  if (body.messages) return { messages: body.messages, hidden: 0 };
  // A one-off prompt named rather than carried. The read is an ordinary pattern query over declared
  // indexed paths, and it carries the CALLER's `owner` for the same reason every read below does:
  // the reference is a body field, so it is a claim, and this worker's `message` grant is unscoped
  // (package V). A reference that resolves to nothing yields no prompt rather than an empty one, so
  // a caller cannot use a miss to make the classifier answer about nothing.
  if (body.classifyOf) {
    const { conversationId, owner, index, context } = body.classifyOf;
    const rows = await c.queryOldest<ThreadRow>({ kind: "message", match: { conversationId, owner, index } }, 1);
    const referenced = rows[0] ? await open(rows[0].body) : undefined;
    if (referenced) assertReadable(referenced, "contextFor(classifyOf)");
    const text = referenced?.content ?? "";
    if (!text) return { messages: [], hidden: 0 };
    return {
      messages: [
        ...(body.system ? [{ role: "system", content: body.system } as ChatMessage] : []),
        { role: "user", content: text + (context ?? "") },
      ],
      hidden: 0,
    };
  }
  const upTo = body.upToIndex ?? 0;
  /**
   * WHOSE thread this call may load, built ONCE so no branch can forget half of it.
   *
   * `conversationId` and `owner` both come from the call BODY, which is a claim rather than an
   * authorization: `bodyMatchesGrant` bounds what a caller may WRITE and says nothing about what
   * this worker can then be induced to read on their behalf. This worker's `message` grant is
   * unscoped, so the conjunction IS the check — it reduces the read to records the caller could
   * have read themselves, because their own put grant is what forced `owner` to be them.
   *
   * It used to be applied in the windowed branch and omitted in the `window <= 0` one, which made
   * `RADIA_CHAT_WINDOW=0` (reading like "no limit") load another person's whole conversation into
   * the model and stream it back stamped for the caller. See package V in
   * plan-audit-remediation.md; the fix is one match rather than two so the branches cannot drift
   * apart again.
   */
  const mine = { conversationId: body.conversationId, owner: body.owner };
  if (window <= 0) {
    const rows = await c.queryOrdered<ThreadRow>({ kind: "message", match: mine, orderBy: [{ path: "index" }] }, 2000);
    const opened = await Promise.all(rows.map((r) => open(r.body)));
    return {
      messages: opened.filter((m) => m.index <= upTo).map(toMessage),
      hidden: 0,
    };
  }
  // A descending keyset scan over the sortable `index`, so per-turn cost is bounded by the window
  // rather than by conversation length. Dropping old turns is not lossy here: the omitted messages
  // are still records the agent can retrieve by conversation id, which is why the notice
  // `assembleContext` folds in can be a pointer rather than a summary.
  const tail = await selectWindow(
    async (limit) =>
      (await c.queryOrdered<ThreadRow>({
        kind: "message",
        match: { ...mine, index: { $lte: upTo } },
        orderBy: [{ path: "index", dir: "desc" }],
      }, limit)).map((r) => r.body),
    { window, cap },
  );
  const opened = await Promise.all(tail.map(open));
  // The standing instructions are the NEWEST system message, not index 0: that is what lets a
  // RESUMED conversation run under a current disposition rather than whatever was written when it
  // started. One indexed query, because `role` is a declared path.
  const newestSystem = (await c.queryOrdered<ThreadRow>({
    kind: "message",
    match: { ...mine, role: "system", index: { $lte: upTo } },
    orderBy: [{ path: "index", dir: "desc" }],
  }, 1))
    .map((r) => r.body)[0];
  return assembleContext(newestSystem ? await open(newestSystem) : undefined, opened);
}

/** Claim and serve this tier's `llm_call`s until aborted. */
export async function runInferenceWorker(client: RadiaClient, opts: InferenceOptions): Promise<void> {
  const { provider, complete, model, tier } = opts;
  const rank = opts.rank ?? 0;
  const window = opts.window ?? 40;
  const cap = opts.windowCap ?? 400;

  await agentLoop<CallBody>(client, {
    name: `inference:${tier ?? "all"}`,
    patterns: [tier ? { kind: "llm_call", match: { tier } } : { kind: "llm_call" }],
    leaseSeconds: opts.leaseSeconds ?? 60, // inference is slow; the heartbeat keeps the lease alive
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    handle: async (rec, c) => {
      const callId = rec.id;
      const body = rec.body;
      // A router re-dispatches under a new id but sets `replyTo` to the ORIGINAL call the caller
      // awaits. Key the chunks and the result to that, so the caller never sees the indirection.
      const resultKey = body.replyTo ?? callId;
      let index = body.indexOffset ?? 0;
      const reportModel = body.model ?? model;
      // Once per claim, before the first read OR write of prose. A conversation with no key is
      // plaintext and every seal below is a no-op; a conversation WITH one that this worker cannot
      // open never gets here, because `contextFor` refuses its rows (phase 1).
      //
      // A CLASSIFY call names its conversation only inside `classifyOf`: the record itself is
      // deliberately unscoped (phase 0), so without this second source an encrypted conversation
      // would be unclassifiable — the referenced message would come back sealed and be refused.
      // The owner travels with the id so the lookup is bounded by the CALLER either way.
      const keyOf = body.conversationId
        ? { id: body.conversationId, owner: body.owner }
        : body.classifyOf?.conversationId
        ? { id: body.classifyOf.conversationId, owner: body.classifyOf.owner }
        : undefined;
      const key = keyOf && opts.keys ? await opts.keys(keyOf.id, keyOf.owner) : undefined;
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
        const chunkBody = { callId: resultKey, conversationId: body.conversationId, owner: body.owner, index: index++, delta, ...(reset ? { reset: true } : {}) };
        await c.put({
          kind: "llm_chunk",
          body: key ? await sealBody(chunkBody, "llm_chunk", key) : chunkBody,
          parentIds: [callId],
        });
      };

      try {
        const { messages, hidden } = await contextFor(c, body, window, cap, key);
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
        return sealAck(finished(body, resultKey, tier, message, finishReason, { usage, context: { sent: messages.length, hidden } }), key);
      } catch (e) {
        // Never nack: a retry re-runs the model and spends again. The error IS the answer.
        return sealAck(finished(body, resultKey, tier, { role: "assistant", content: `[inference error: ${e}]` }, "error", {}), key);
      }
    },
  });
}
