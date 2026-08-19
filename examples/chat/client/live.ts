// What somebody ELSE said, while you were here.
//
// A conversation is records, so nothing about it belongs to the client that wrote them: a second
// tab, a phone and the terminal are all looking at the same thread. Until this file, none of them
// could see each other — `runTurn` follows the call IT seeded and nothing watches for messages this
// client did not write (agent_docs/plan-chat-web-ui.md phase 3).
//
// SUPERVISION IS `reactorLoop`'s (sdk/ts/loop.ts), never hand-rolled here: the failures it owns are
// the invisible ones (a watch that reconnects without telling the caller, a `credential_invalid`
// that kills the process), and its tick is the correctness spine. `patterns` is a WAKEUP HINT and
// callers pass what their host can afford: the terminal parks a watch, a browser passes none and
// lives on the tick, because six connections per origin is the whole budget a page has.
//
// WHAT IT MUST NOT DO is render a record the local client is already rendering. The rule is one
// line and it is `accountedFor`: everything at or below the thread's own cursor was rendered by
// whoever advanced it.

import type { Pattern, RadiaRecord } from "../../../sdk/ts/wire.ts";
import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { reactorLoop } from "../../../sdk/ts/loop.ts";
import { answerStream, dim, notice, trunc, write } from "./ui.ts";

/** The fields of a `message` this file reads. The rest is the provider's business. */
export interface LiveMessage {
  role?: string;
  content?: string | null;
  index?: number;
  owner?: string;
  tool_calls?: { function?: { name?: string } }[];
}

export interface LiveOptions {
  client: RadiaClient;
  conversationId: string;
  /** The highest index the local client has already rendered (`thread.upToIndex`). Read on every
   *  pass, not captured: it advances while a turn runs. */
  accountedFor: () => number;
  /** True while this client is rendering its own turn. Foreign records WAIT rather than interleave,
   *  which is the same rule `holdLine` states for a terminal, applied to a whole turn. */
  busy: () => boolean;
  /** Wakeup hints. `[]` is a legitimate answer and means "the tick is the only signal". */
  patterns?: Pattern[];
  pollMs?: number;
  /** How to draw one. `full` renders it like the transcript it belongs to; `notice` states that it
   *  happened in one line, for a host whose cursor belongs to something else (a REPL prompt). */
  render?: "full" | "notice";
  hooks?: RenderHooks;
  signal: AbortSignal;
}

/**
 * Render a list of messages through the installed surface.
 *
 * Shared with the page's history rendering on purpose: what arrives live and what was already there
 * are the same records, so they must not be able to look different.
 */
export interface RenderHooks {
  /** How to draw somebody's question. A host with more than text available (a page has bubbles)
   *  takes it; without one, a plain line, which is all a terminal wanted anyway. */
  onUser?: (m: LiveMessage) => void;
}

export function renderMessages(messages: LiveMessage[], mode: "full" | "notice" = "full", hooks: RenderHooks = {}): void {
  for (const m of messages) {
    if (m.role === "system") continue; // the standing instructions, not conversation
    if (mode === "notice") {
      const who = m.role === "user" ? (m.owner ?? "someone") : (m.role ?? "?");
      const text = (m.content ?? "").replace(/\s+/g, " ").trim() ||
        (m.tool_calls?.length ? `[${m.tool_calls.length} tool call${m.tool_calls.length === 1 ? "" : "s"}]` : "");
      if (text) notice(dim(`[${who}] ${trunc(text, 100)}`));
      continue;
    }
    if (m.role === "user") {
      if (hooks.onUser) hooks.onUser(m);
      else write(`\n${dim(`${m.owner ?? "them"}>`)} ${m.content ?? ""}\n`);
    } else if (m.role === "assistant") {
      if (m.content) {
        const a = answerStream();
        a.push(String(m.content));
        a.end();
      }
      for (const c of m.tool_calls ?? []) write(dim(`  [tool ${c.function?.name ?? "?"}]\n`));
    } else if (m.role === "tool") {
      write(dim("  [tool result]\n"));
    }
  }
}

/**
 * Follow a conversation for messages this client did not write, until aborted.
 *
 * Returns when the signal aborts or the credential ends, which is `reactorLoop`'s contract: a caller
 * that must re-authenticate awaits this and does it.
 */
export function liveView(o: LiveOptions): Promise<void> {
  // Everything already on screen when this starts. Ids as well as the watermark, because an index
  // is not unique while the transcript is numbered by clients (phase 7 is what fixes that), and a
  // duplicate would otherwise render twice.
  const seen = new Set<string>();
  let watermark = o.accountedFor();

  const reconcile = async (): Promise<void> => {
    // A local turn owns the surface, and it advances `accountedFor` as it goes. Skipping the pass
    // (rather than rendering into it) leaves the records for the next tick, in order.
    if (o.busy()) return;
    const from = Math.max(watermark, o.accountedFor());
    const rows: RadiaRecord[] = await o.client.query(
      { kind: "message", match: { conversationId: o.conversationId, index: { $gt: from } }, orderBy: [{ path: "index" }] },
      50,
    );
    const fresh: LiveMessage[] = [];
    for (const rec of rows) {
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      const body = rec.body as LiveMessage;
      if (typeof body.index === "number") watermark = Math.max(watermark, body.index);
      fresh.push(body);
    }
    if (fresh.length > 0) renderMessages(fresh, o.render ?? "full", o.hooks ?? {});
  };

  return reactorLoop(o.client, {
    name: "live",
    patterns: o.patterns ?? [],
    // Short by the standards of a reactor, because this one is a person waiting for a sentence
    // rather than a sweep. 1s is the floor `reactorLoop` enforces.
    pollMs: o.pollMs ?? 1000,
    reconcile,
    signal: o.signal,
    log: () => {}, // a dropped watch is not this app's news; the tick covers it
  });
}
