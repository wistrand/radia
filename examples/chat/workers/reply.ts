// The tool half of the fenced turn link (agent_docs/plan-chat-turn.md, step 2b).
//
// A `tool_call` has the same DUAL USE as an `llm_call`. One that carries a TURN SLOT
// (`tool_call_id` + `replyIndex`, stamped by whoever is running the turn) is a conversation link:
// its answer belongs in the transcript, so the worker acks the tool `message` itself and the reply
// is written inside the ack's fence — a reclaimed worker's reply is never written, and the record
// the client used to copy out of `tool_result` simply does not exist twice. A BARE call (the smoke
// harness, procedures, any RPC) has no slot, answers with `tool_result`, and touches no transcript.
//
// One wrapper at each worker's `handle`, not a branch at every result-construction site: exec.ts
// alone has ten of those, and the shape decision is the CALL's property, not the result's.

import type { RadiaRecord } from "../../../sdk/ts/client.ts";

interface ToolResultShape {
  kind: string;
  body: Record<string, unknown>;
  [extra: string]: unknown; // taint, parentIds: preserved untouched
}

// deno-lint-ignore no-explicit-any
export function asTurnReply(rec: RadiaRecord, result: any): ToolResultShape {
  const slot = rec.body as { tool_call_id?: string; replyIndex?: number; i?: number; of?: number; round?: number; turnAt?: number };
  if (result?.kind !== "tool_result") return result;
  if (typeof slot.tool_call_id !== "string" || typeof slot.replyIndex !== "number") return result;
  const b = result.body as { callId?: string; conversationId?: string; owner?: string; ok?: boolean; output?: unknown };
  return {
    ...result,
    kind: "message",
    body: {
      conversationId: b.conversationId,
      owner: b.owner,
      index: slot.replyIndex,
      role: "tool",
      tool_call_id: slot.tool_call_id,
      // WHICH call of the round this answers, carried from the call so the turn worker can ask for
      // the next one. Dropped here originally, and the whole multi-call round broke silently: every
      // reply looked like the only one (`of` defaulting to 1), so a round of eight calls became
      // eight ROUNDS, and the client, which correctly expects contiguous reply slots, read the
      // assistant messages that landed in them as if they were tool results.
      ...(typeof slot.i === "number" ? { i: slot.i } : {}),
      ...(typeof slot.of === "number" ? { of: slot.of } : {}),
      ...(typeof slot.round === "number" ? { round: slot.round } : {}),
      ...(typeof slot.turnAt === "number" ? { turnAt: slot.turnAt } : {}),
      callId: b.callId,
      ok: b.ok,
      // Exactly the string the CLIENT used to append, so the provider sees the same transcript it
      // always did; `?? "null"` because JSON.stringify(undefined) is not a string.
      content: JSON.stringify(b.ok ? b.output : { error: b.output }) ?? "null",
    },
  };
}
