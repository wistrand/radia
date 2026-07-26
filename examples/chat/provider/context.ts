// Turning a stored thread into a provider payload.
//
// Separated from the worker because it is PURE and because it is where the context bugs live: a
// window that evicted the very question being answered, and a `system` message in a position no
// provider accepts. Both were found in a live session, not in review, so this half is kept
// importable and directly testable (`smoke-context.ts`) rather than reachable only by running a
// worker with an API key.

import type { ChatMessage, ToolCall } from "./openrouter.ts";

/** One `message` record's body, as stored on the space. */
export interface ThreadRow {
  index: number;
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Assemble the provider payload from a window of thread rows. PURE, and exported, because this is
 * where the two context bugs so far have lived: a window that evicted the very question being
 * answered, and a `system` message in a position no provider accepts.
 *
 * Two rules it enforces, both learned from a 400:
 *
 *   EXACTLY ONE system message, FIRST. Providers reject a `system` role anywhere else ("system
 *   must follow a user or assistant message"). That broke two ways: a resumed conversation appends
 *   a fresh system message mid-thread, and the windowing notice used to be its own system message
 *   right after the head. Both are folded into the single leading message here.
 *
 *   NO ORPHANED tool replies. A `tool` message must answer a preceding `tool_calls`, so a reply
 *   whose call fell outside the window is trimmed rather than dragging its call back in.
 */
export function assembleContext(
  system: ThreadRow | undefined,
  window: ThreadRow[],
): { messages: ChatMessage[]; hidden: number } {
  const tail = [...window];
  while (tail.length > 0 && tail[0].role === "tool") tail.shift();
  // Older system messages are history, not instructions: they must not reach the body.
  const body = tail.filter((m) => m.role !== "system");
  const hidden = body.length > 0 ? Math.max(0, body[0].index - 1) : 0;
  const note = hidden === 0
    ? ""
    : hidden === 1
    ? "\n\n[1 earlier message in this conversation is not included here. It is not lost — retrieve it if you need it.]"
    : `\n\n[${hidden} earlier messages in this conversation are not included here. ` +
      `They are not lost — retrieve them if you need them.]`;
  const head: ChatMessage[] = system ? [{ role: "system", content: `${system.content ?? ""}${note}` }] : [];
  return { messages: [...head, ...body.map(toMessage)], hidden };
}

export function toMessage(m: ThreadRow): ChatMessage {
  const cm: ChatMessage = { role: m.role };
  if (m.content !== undefined) cm.content = m.content;
  if (m.tool_calls) cm.tool_calls = m.tool_calls;
  if (m.tool_call_id) cm.tool_call_id = m.tool_call_id;
  return cm;
}

/**
 * Choose the window of thread rows to send, expanding until the CURRENT TURN is inside it.
 *
 * `read(limit)` returns the newest `limit` rows at or below the caller's high-water index, newest
 * first — i.e. one `query` with `orderBy index desc`. Injected rather than called directly so this
 * is testable against a synthetic thread as well as a real space.
 *
 * The expansion is the whole point. One tool-heavy turn is a dozen messages on its own (an
 * assistant `tool_calls` message plus a reply per call), so a fixed count can cut away the very
 * question being answered and leave the model summarizing tool output it can no longer attribute.
 * Expanding until the most recent `user` message is in view includes that message and everything
 * after it. `cap` bounds one runaway turn.
 */
export async function selectWindow(
  read: (limit: number) => Promise<ThreadRow[]>,
  opts: { window: number; cap: number },
): Promise<ThreadRow[]> {
  let limit = opts.window;
  let tail: ThreadRow[] = [];
  for (;;) {
    tail = [...await read(limit)].reverse();
    const hasCurrentTurn = tail.some((m) => m.role === "user");
    const atThreadStart = tail.length === 0 || tail[0].index <= 1;
    if (hasCurrentTurn || atThreadStart || limit >= opts.cap) break;
    limit = Math.min(limit * 4, opts.cap);
  }
  return tail;
}
