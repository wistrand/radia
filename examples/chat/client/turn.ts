// One user turn: put an `llm_call`, render what comes back, run any tools it asks for, repeat
// until the model answers in text.
//
// Notice what this file does NOT contain: no model name, no tier choice, no tool list, no routing.
// It writes an UNTIERED call and reads a result; a router-worker picks the tier, an
// inference-worker serves it, and whichever worker claims `tool_call{tool}` runs the tool. Every
// per-turn decision belongs to a worker, which is what makes this loop short enough to read.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { activeByKey, awaitResult } from "../../../sdk/ts/client.ts";
import type { ChatMessage, ToolDef } from "../provider/openrouter.ts";
import type { Thread } from "./thread.ts";
import { sessionOwner } from "../space/roles.ts";
import { collapseByTool, liveAdvertisements, liveCapabilities } from "../../../extensions/ts/capability.ts";
import { livePresence } from "../../../extensions/ts/presence.ts";
import { FLEET_PRESENCE } from "../space/kinds.ts";
import { assertReadable, type ConversationKey, openBody } from "../../../extensions/ts/encrypted.ts";
import { answerStream, columns, dim, endStatus, ensureLine, holdLine, notice, showArtifact, statusLineOn, trunc, write } from "./ui.ts";
import { Waiter, waitWake } from "./waiting.ts";


/**
 * The user pressed Escape. A distinct type so the REPL can say "cancelled" rather than "[error]".
 *
 * WHAT CANCELLING DOES AND DOES NOT DO, because the difference is not cosmetic. It stops this
 * process WAITING. It does not stop the worker: an `llm_call` already claimed is still being served,
 * and a `tool_call` already claimed still runs to completion and still writes its result. Those
 * records land whether or not anyone is watching, which is what an at-least-once runtime means and
 * is why the message says so instead of implying the work was undone.
 */
export class TurnCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "TurnCancelled";
  }
}

/** Set for the duration of a turn; `cancelTurn()` trips it. */
let cancel: AbortController | null = null;

/** Trip the in-flight turn, if any. Safe to call when nothing is running. */
export function cancelTurn(): void {
  cancel?.abort();
}

/**
 * How long inference may go UNOBSERVED, not how long it may take.
 *
 * An absolute deadline cannot tell a slow answer from a stopped worker, and the expensive models are
 * the slow ones: a top-tier turn over a big page was abandoned here at two minutes while the worker
 * was still generating, so the answer landed for nobody. The clock restarts on any evidence of life
 * (a streamed chunk, or a worker's progress record), so a five-minute answer is fine and genuine
 * silence still fails in two.
 */
const INFERENCE_DEADLINE_MS = 120_000;
/**
 * How long a whole turn stays worth finishing, stamped on the seed as the record's `deadlineAt`.
 *
 * The turn worker resumes a turn only while this is in the future, so it is what separates "the
 * REPL died thirty seconds ago, finish the work" from "this conversation ended in March". Declared
 * HERE because the client is the one waiting: eight rounds of inference plus their tools, with a
 * `request_grant` able to sit five minutes on a person, so the bound is generous on purpose.
 */
const TURN_BUDGET_MS = 15 * 60_000;

/** 11006 -> "11.0k". A turn's rounds each print one of these, so width matters more than precision. */
function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Provider cost in dollars. Sub-cent calls are the common case, so the small end keeps its digits
 *  rather than rounding every ordinary round to "$0.00". */
function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
}
const TOOL_DEADLINE_MS = 30_000;
/** How long a streamed answer must be silent before the status row returns beneath it. Long enough
 *  that ordinary token-to-token gaps never flicker it in, short enough that "composing a large tool
 *  call" is visibly alive rather than a dead screen. */
const STREAM_QUIET_MS = 2_500;
/** `request_grant` waits on a PERSON, so it gets a human deadline rather than a worker one, and a
 *  longer one than the tool's own wait, or the REPL would give up on a decision still being made. */
const HUMAN_DEADLINE_MS = 300_000;

/**
 * Called repeatedly while a tool call is outstanding, with the tool's name.
 *
 * This exists for exactly one thing: a `request_grant` in flight is waiting for the person at this
 * terminal, and the REPL is the only part of the system that can ask them. Reviewing pending
 * requests only BETWEEN turns cost two turns and two human inputs per grant (ask, end the turn,
 * approve, type "retry"), and the loop usually broke before it converged.
 */
export type ToolWaitHook = (tool: string) => Promise<void>;

export async function runTurn(
  client: RadiaClient,
  thread: Thread,
  tools: ToolSet,
  onToolWait?: ToolWaitHook,
  /** Follow a turn ALREADY IN FLIGHT instead of seeding one (`findOpenTurn`). The turn lives in the
   *  space, so the client that started it is not the client that has to finish watching it: a closed
   *  tab, a reload or a second window all resume here. Everything after the seed is identical, which
   *  is why this is a parameter rather than a second loop. */
  resumeFrom?: OpenTurn,
): Promise<void> {
  cancel = new AbortController();
  // OUTSIDE the try, because the catch needs it: by then the cursor has advanced past everything
  // rendered, and a cancel naming that index would name a turn that never started. A resumed turn
  // takes it from the CALL, so a cancel still names the turn that is actually running.
  const turnAt = resumeFrom ? resumeFrom.turnAt : thread.upToIndex;
  // Also outside, and for the same reason: `callId` advances a round at a time, but a cancel belongs
  // to the TURN, so it parents to the seed rather than to whichever round was in flight.
  let seedId: string | null = null;
  // Per TURN, not per round: a tool-heavy turn is a dozen provider calls, and the number worth
  // knowing is what the whole question cost. Outside the try so a cancelled turn still reports it.
  let turnTokens = 0, turnCost = 0, turnRounds = 0;
  // The turn owns the line from here until the `finally` below, so anything a background watcher
  // produces waits rather than splicing itself into the answer.
  holdLine(true);
  try {
    // THE SEED, and the only record this client writes in a turn unless it is cancelled. The tool list is session state (a
    // scoped view of what is advertised, plus conversation-scoped procedures), so no worker can
    // invent it. Everything after this is a worker reacting to a record: the model call, the tool
    // calls, the next round and the terminus all belong to `workers/turn.ts`. What is left here is
    // a RENDER loop, which decides nothing and only waits for records and prints them.
    let callId: string | null = resumeFrom ? resumeFrom.callId : (await client.put({
      kind: "llm_call",
      // `owner` rides along so a worker can copy it onto the result and chunks. That is what lets
      // a grant bind records the SESSION did not write but that were produced for it.
      // `turnAt` names which turn this is, so the worker can scope a tool's retry chain to it.
      // `round: 0` EXPLICITLY. Addressing is by identity now, so the worker finds a round's assistant
      // message with `{turnAt, round, role}` — and a match on `round: 0` does not match a record
      // whose `round` is absent. Leaving it off made every turn's FIRST round unaddressable.
      body: { conversationId: thread.id, owner: sessionOwner(), upToIndex: turnAt, turnAt, round: 0, tools: tools.all() },
      // A CLIENT-SUBMITTED claim, which is what `deadline_at` is for: how long the caller will care
      // about this turn. The worker compares it against the DB clock, never against this one.
      deadlineAt: new Date(Date.now() + TURN_BUDGET_MS).toISOString(),
      // THE TURN'S ROOT is the message that asked for it, not the conversation. Everything the
      // workers write descends from this call, so `graph?direction=down` on the user's message is
      // one turn and nothing else — the conversation is a hub every turn would otherwise fan from.
      parentIds: [thread.lastAppended ?? thread.id],
    })).id;
    seedId = callId;

    for (let round = resumeFrom ? 1 : 0;; round++) {
      // One blank line to open the TURN, none between its rounds. A tool-heavy turn was spending
      // three blank lines per round on separation nobody needed: each round already begins with its
      // own `assistant>`.
      if (round === 0) write("\n");
      else ensureLine();
      write("assistant> ");
      const { message, finishReason, streamed, tier, context, usage, announced, heldLabel, index } = await streamResult(client, callId, thread.dek);
      turnTokens += usage?.total_tokens ?? 0;
      turnCost += usage?.cost ?? 0;
      if (usage?.total_tokens) turnRounds++;

      // The round's numbers: the context window only when it dropped something, and the PROVIDER's
      // own token and cost figures off the record — never recomputed, and each part appears only
      // when it has a number behind it (`cost` is absent on providers that do not price a call).
      const parts = [
        context && context.hidden > 0 ? `${context.sent}/${context.sent + context.hidden} msgs` : "",
        usage?.total_tokens ? `${fmtTokens(usage.total_tokens)} tok` : "",
        usage?.cost ? fmtCost(usage.cost) : "",
      ].filter(Boolean);
      const win = parts.length ? ` · ${parts.join(" · ")}` : "";
      // One tail per round: the routing label when it is still unspent (a tool round streams
      // nothing, so the label was never flushed), else the tier when no label was ever visible
      // (the session may lack a grant to read progress), else just the numbers.
      const tail = heldLabel !== undefined
        ? `[${heldLabel}${win}]`
        : (!announced && tier)
        ? `[${tier}${win}]`
        : win
        ? `[${win.slice(3)}]`
        : "";
      if (tail) {
        // NOTHING STREAMED means the cursor is still sitting after `assistant> `, so the tail
        // completes that line. Forcing a new line there left the prompt dangling above a lone
        // `[fast]`, which is two lines saying what one says.
        if (streamed) {
          ensureLine();
          write(`  ${dim(tail)}\n`);
        } else {
          write(`${dim(tail)}\n`);
        }
      }
      // The assistant message is ALREADY in the space: it arrived as the inference worker's ack, at
      // the index the worker derived from the call. The thread only advances its cursor past it.
      thread.noteExternal(index);

      if (message.tool_calls?.length) {
        ensureLine();
        // The calls are DISPATCHED by the turn worker, one after the other. Each reply is found by
        // the provider call id it answers, which this client already holds: no slot is predicted, so
        // there is no arithmetic for two writers to disagree about.
        for (const call of message.tool_calls) {
          await showToolReply(client, thread, call, tools, onToolWait);
        }
        // The next round's call is the WORKER's to write. Waiting for it, rather than writing one,
        // is the whole difference: kill this process here and the turn still finishes.
        callId = await nextCall(client, thread.id, callId!, turnAt);
        if (callId) continue;
        // No further call: the worker ended the turn instead (the round cap).
        write(dim("\n[the turn reached its round limit]\n"));
        return;
      }

      // Final answer. If nothing streamed (an inference error, or a non-streamed reply), print the
      // message content, or errors would be invisible. Through the same renderer, so a one-shot reply
      // is not the only markdown in the session that arrives raw.
      if (!streamed) {
        const answer = answerStream();
        answer.push(message.content || `(no content; finish_reason=${finishReason})`);
        answer.end();
      }
      // `ensureLine`, not a blank line: the turn's closing numbers follow immediately, and the REPL
      // opens the next prompt with its own separation.
      ensureLine();
      return;
    }
  } catch (e) {
    // ESCAPE BECOMES A RECORD. Killing this process stops nothing now: the chain is in the space, so
    // the intent has to be too, or the workers keep answering a question nobody is waiting for. Best
    // effort and keyed to the turn: failing to write it costs a few more rounds, never correctness,
    // and a conversation-scoped one would silence every turn after this.
    if (e instanceof TurnCancelled) {
      await client.put({
        kind: "cancel",
        body: { conversationId: thread.id, owner: sessionOwner(), turnAt },
        parentIds: [seedId ?? thread.id], // inside the turn it stopped, not beside it
      }, `cancel:${thread.id}:${turnAt}`).catch(() => {});
    }
    throw e;
  } finally {
    // The whole question's cost, once it took more than one provider call. A single round already
    // printed its own line, and repeating it as a "total" would read as a second charge. Reported
    // from the FINALLY so a cancelled turn still says what it spent before stopping.
    if (turnRounds > 1) {
      ensureLine();
      write(dim(`  [turn total: ${fmtTokens(turnTokens)} tok${turnCost > 0 ? ` · ${fmtCost(turnCost)}` : ""} over ${turnRounds} calls]\n`));
    }
    // Cleared whether the turn ended, threw or was cancelled, so a stale controller cannot make the
    // NEXT turn abort before it starts.
    cancel = null;
    holdLine(false); // and whatever queued while the turn ran gets printed now
  }
}

/**
 * Wait for the round the turn worker emits after the last tool reply, or learn that it ended one.
 *
 * Returns the id whose CHUNKS to follow, which is the untiered call: the router re-dispatches under
 * a new id but sets `replyTo` to the original, and the inference worker keys everything it streams
 * to that. `null` means the worker wrote a `turn_complete` instead, which is the round cap.
 */
async function nextCall(client: RadiaClient, conversationId: string, afterId: string, turnAt: number): Promise<string | null> {
  const deadline = Date.now() + INFERENCE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (cancel?.signal.aborted) throw new TurnCancelled();
    const rows = await client.queryNewest({ kind: "llm_call", match: { conversationId, tier: { $exists: false } } }, 1);
    if (rows[0] && rows[0].id > afterId) return rows[0].id;
    // MATCHED ON `turnAt`, because a conversation accumulates one terminus per turn: unscoped, this
    // found the PREVIOUS turn's and reported "round limit" after a single tool call, on every turn
    // but the first.
    if (await client.readOne({ kind: "turn_complete", match: { conversationId, turnAt } })) return null;
    await waitWake(400);
  }
  throw new Error("timed out waiting for the next round. Is the turn worker running?");
}

/** A turn already running, for a client that did not start it. */
export interface OpenTurn {
  /** The UNTIERED call, which is the one everything is keyed to: the router re-dispatches under a
   *  new id but the inference worker streams against the original. */
  callId: string;
  turnAt: number;
}

/**
 * The turn this conversation is in the middle of, if it is in one.
 *
 * The turn lives in the space, so the client that asked the question is not the client that has to
 * be watching when it is answered: a closed tab, a reload, or a second window all pick it up from
 * here. Four ways a turn is NOT open, and each has to be checked, because following a finished turn
 * means sitting on `INFERENCE_DEADLINE_MS` of silence and then reporting a timeout that never was:
 * no call at all, a `turn_complete` (the round cap), a `cancel` (the person stopped it), or an
 * answer with no tool calls, which is a final answer and the end of the turn.
 */
export async function findOpenTurn(client: RadiaClient, conversationId: string): Promise<OpenTurn | null> {
  const rows = await client.queryNewest<{ turnAt?: number }>({ kind: "llm_call", match: { conversationId, tier: { $exists: false } } }, 1);
  const call = rows[0];
  if (!call) return null;
  const turnAt = call.body.turnAt;
  if (typeof turnAt !== "number") return null;
  // Nobody is coming for a turn whose deadline passed: the worker resumes one only while it is in
  // the future, so this is the same test it applies, against the same field.
  if (call.deadlineAt && Date.parse(call.deadlineAt) <= Date.now()) return null;
  if (await client.readOne({ kind: "turn_complete", match: { conversationId, turnAt } })) return null;
  if (await client.readOne({ kind: "cancel", match: { conversationId, turnAt } })) return null;
  const answer = await client.readOne<{ tool_calls?: unknown[] }>({ kind: "message", match: { callId: call.id } });
  if (!answer) return { callId: call.id, turnAt }; // still generating
  const calls = answer.body.tool_calls;
  // Answered WITH tool calls means the turn is still moving (a tool is running, a round is coming);
  // answered without means that was the final answer.
  return Array.isArray(calls) && calls.length > 0 ? { callId: call.id, turnAt } : null;
}

/**
 * A tool call's arguments as `k=v`, which is how they are written everywhere else a person reads
 * them. `{"expr":"17+156223"}` costs four characters of punctuation out of a 60-character budget,
 * and a single-argument call (most of them) does not need its name at all.
 */
export function showArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  // ONE LINE, whatever the value is. A truncated preview of source code carries the newlines inside
  // it, so a single `run_javascript(code=…)` printed across three lines and read as three separate
  // calls with two of them hanging. The width cap alone does not make a line: it caps characters.
  const val = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  if (keys.length === 1) return val(args[keys[0]]);
  return keys.map((k) => `${k}=${val(args[k])}`).join(" ");
}

/**
 * A tool result as the thing it actually says.
 *
 * Never raw JSON cut at a fixed width: anything structured (an artifact, a workspace, a run) then
 * shows its braces and loses its content. A scalar prints as itself; an object leads with the field
 * that carries the answer, when there is an obvious one.
 */
const PRIMARY = ["answer", "output", "text", "content", "result", "error", "artifactId", "name", "path"];
export function showOutput(out: unknown): string {
  if (out === null || out === undefined) return "(nothing)";
  if (typeof out !== "object") return String(out);
  const o = out as Record<string, unknown>;
  const lead = PRIMARY.find((k) => o[k] !== undefined && o[k] !== null && o[k] !== "");
  if (!lead) return JSON.stringify(out);
  const value = typeof o[lead] === "object" ? JSON.stringify(o[lead]) : String(o[lead]);
  // The rest is not dropped, only demoted: a caller who needs the whole object has the record, and
  // the count says how much is not on screen.
  const others = Object.keys(o).filter((k) => k !== lead).length;
  return others > 0 ? `${value}${dim(` +${others}`)}` : value;
}

/**
 * Follow ONE tool call the turn worker dispatched: print what was asked, wait for the reply at the
 * slot it will land in, print what came back.
 *
 * It writes nothing. The call was put by `workers/turn.ts` and the reply is the tool worker's own
 * ack (plan-chat-turn.md 2b), so a cancelled or crashed REPL leaves both intact and the chain runs
 * on. Do NOT reintroduce a synthetic reply on the failure paths: an assistant `tool_calls` message
 * with an unanswered id makes every LATER turn unsendable, which is why one was written here once,
 * but the real reply arrives whether anyone is watching now, and `assembleContext` covers a worker
 * that never answers at all.
 */
async function showToolReply(
  client: RadiaClient,
  thread: Thread,
  call: { id: string; function: { name: string; arguments: string } },
  tools: ToolSet,
  onToolWait?: ToolWaitHook,
): Promise<void> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch { /* a malformed argument object is the model's problem to see in the result */ }

  const prefix = `  · ${call.function.name}(${trunc(showArgs(args), 60)}) `;
  write(prefix);
  const reply = await awaitToolReply(client, thread.id, call.id, prefix, call.function.name, tools, onToolWait, thread.dek);
  // From the record, not from a prediction: it says where it landed.
  thread.noteExternal(reply.index);
  // Capped as well as fitted: on a wide terminal "fits the window" is 200 characters of JSON, which
  // is a wall rather than a summary. The record has the whole thing.
  write(`${reply.ok ? "→" : "✗"} ${trunc(showOutput(reply.output), Math.max(24, Math.min(120, columns() - prefix.length - 4)))}\n`);
  await showArtifact(client, reply.output);
}

interface StreamedResult {
  message: ChatMessage;
  finishReason: string;
  streamed: boolean;
  announced: boolean; // a routing label was seen (printed, or still held in `heldLabel`)
  /** The routing label, when nothing streamed and it is still unprinted. The caller finishes the
   *  line with the round's numbers, so a tool round costs ONE line instead of three. */
  heldLabel?: string;
  index: number; // the transcript slot the worker wrote the assistant message into
  tier?: string; // the tier that answered, stamped by the inference-worker
  context?: { sent: number; hidden: number }; // what the worker's context window sent vs. omitted
  /** The PROVIDER's own numbers, passed through untouched onto the message record. Shown rather
   *  than recomputed: an estimate beside an authoritative figure is just a second number to doubt. */
  usage?: { total_tokens?: number; cost?: number };
}

/** Follow one call: print `llm_chunk` deltas as they land, return when the assistant `message`
 *  arrives. The message IS the inference worker's ack (plan-chat-turn.md), so this client never
 *  appends the assistant's side of the conversation: it observes the record the worker wrote. */
async function streamResult(client: RadiaClient, callId: string, key?: ConversationKey): Promise<StreamedResult> {
  const stall = "no worker claimed this call. Is the router/inference fleet running?";
  let lastIndex = -1; // watermark over ONE monotonic stream: an escalation hands it on, never resets
  let printed = false; // any visible text on the line yet
  let lastChunkAt = Date.now(); // when the stream last said anything visible
  let statusResumed = false; // the status row is back on screen below a paused answer
  let announced = false; // the routing label is on screen
  // The answer is markdown, and it arrives in pieces, so the renderer is stateful and lives as long
  // as the answer does. Off a terminal this is the model's bytes, unaltered.
  let answer = answerStream();

  // The tier is known the moment the ROUTER decides it, which is before the tiered call exists and
  // so before any token can stream. Reading it from the router's progress record puts the label
  // ahead of the text it describes; taking it from the final message (as this once did) can only
  // ever print it after the last token, describing an answer the user has already read.
  //
  // HELD, not printed on arrival. A tool-calling round renders no text, so a label printed the
  // moment it is known occupies a line of its own and the round's cost occupies another. Held, the
  // two become `[→ fast · 13.4k tok · $0.002]`: same facts, one line. It is flushed the instant a
  // token is about to be printed, so on a STREAMED answer it still precedes the text it describes,
  // which is the property it exists for.
  let pending: string | null = null;
  const label = (text: string) => {
    pending = text;
    announced = true;
  };
  /**
   * Emit the held label, optionally with the round's numbers folded in.
   *
   * The prefix is spent HERE, not when the label arrives. `endStatus` redraws the line as
   * `\r\x1b[2K` + prefix, so clearing it early made the deferred flush erase the `assistant> ` it
   * was supposed to complete: the round printed a bare `[→ fast · …]` with no prompt in front of it.
   */
  const flushLabel = (extra = "") => {
    if (pending === null) return;
    endStatus(waiter.prefix);
    write(`${dim(`[${pending}${extra}]`)}\n`);
    waiter.prefix = ""; // the prompt is on screen and finished; later status lines must not reprint it
    pending = null;
  };
  const waiter = new Waiter(client, "assistant> ", (p) => {
    if (!p.note) return;
    // `routed` carries "→ tier"; `escalating` carries "from → to" when a worker gives up mid-answer
    // and hands the turn to a stronger model. Both are routing decisions, both belong in the
    // stream at the point they happen.
    // `routed` carries "→ deep", which reads as "[→ deep]" once the arrow is already there.
    if (p.stage === "routed") label(p.note);
    else if (p.stage === "escalating") label(`escalated ${p.note}`);
  });

  const printNew = async () => {
    // Incremental read: ask for what is past the watermark instead of re-scanning the stream every
    // tick. `index` is an indexed integer, so this is a range scan; the batch size caps a burst,
    // not the answer.
    const chunks = await client.queryOrdered<{ index: number; delta: string; reset?: boolean }>({ kind: "llm_chunk", match: { callId, index: { $gt: lastIndex } }, orderBy: [{ path: "index" }] }, 500);
    for (const chunk of chunks) {
      const raw = chunk.body;
      // A delta goes straight to the terminal, so it is the one prose read with no later checkpoint.
      // Opened first, then asserted: `openBody` strips the marker it could read, so what reaches the
      // assert is either plaintext or something no key here opens.
      const b = key ? await openBody(raw, "llm_chunk", key) : raw;
      assertReadable(b, "streamResult(llm_chunk)");
      if (b.index <= lastIndex) continue;
      lastIndex = b.index;
      lastChunkAt = Date.now();
      if (statusResumed) {
        // The stream is talking again: take the status row back off the screen and let the text
        // continue where it paused.
        endStatus("");
        statusResumed = false;
      }
      if (b.reset) {
        // A worker escalated mid-stream: what is on screen came from the attempt it just threw
        // away. Say so, rather than letting the stronger model's answer append to it. WHICH tiers
        // are involved is named by the `escalating` progress record (see the label in
        // streamResult); this line's job is only to mark where the discarded text ends, and it has
        // to stand on its own because a session without a grant to read progress sees only this.
        //
        // The renderer is replaced, not reset: the discarded attempt may have left a fence open or a
        // table half collected, and the stronger model's answer starts from nothing.
        if (printed) {
          answer.end();
          write(`\n${dim("↩ discarding the partial answer above")}\n`);
        }
        answer = answerStream();
        printed = false;
        continue;
      }
      if (!b.delta) continue;
      if (!printed) {
        // LAST CHANCE for the routing label to precede the text it describes. The progress poll runs
        // only while nothing has been printed, and `beforeRead` runs before it, so a `routed` record
        // written inside the last poll interval was never read: the label then appeared after the
        // whole answer, describing something the user had already finished reading.
        if (!announced) await waiter.pump(callId, stall, true);
        flushLabel(); // before the first token, which is the whole reason it is read early
        endStatus(waiter.prefix); // first token: drop the status, keep the prompt
      }
      answer.push(b.delta);
      printed = true;
    }
  };

  // The deadline loop, the read, the wake and the cancel check are `awaitResult` in the SDK: the
  // same shape as the tool wait below, which is why it moved. What stays here is the part that is
  // about a TERMINAL — flushing streamed tokens before each read, and holding the status line only
  // until real output takes it.
  const outcome = await awaitResult<
    {
      content?: string | null;
      tool_calls?: ChatMessage["tool_calls"];
      finishReason: string;
      index: number;
      tier?: string;
      context?: { sent: number; hidden: number };
      usage?: { total_tokens?: number; cost?: number };
    }
  >(
    client,
    { kind: "message", match: { callId } },
    {
      timeoutMs: INFERENCE_DEADLINE_MS,
      // Tokens arriving, or the worker still reporting: either means it is alive.
      alive: () => `${lastIndex}:${waiter.beats}`,
      wake: waitWake,
      beforeRead: printNew,
      onWait: () => {
        if (!printed) return waiter.pump(callId, stall);
        // The model streamed text and went QUIET: it is composing tool arguments, which are never
        // rendered. This gate used to stop for good at the first token, so a deep model writing
        // 20KB of code showed a dead screen for minutes — read live as a hang — and froze the
        // deadline's liveness signal under a worker that was heartbeating normally. After a short
        // pause the status returns on its own row, carrying the worker's note (tier, model, ~tok).
        if (Date.now() - lastChunkAt < STREAM_QUIET_MS) return;
        // Only where a status line can actually draw. The redraw calls are no-ops when it cannot,
        // but the `ensureLine` below is a REAL newline, and piped output must stay byte-identical
        // to a run with no status at all (terminal.ts, first rule).
        if (!statusLineOn()) return;
        if (!statusResumed) {
          statusResumed = true;
          ensureLine();
          waiter.prefix = ""; // its own row: there is no prompt to re-print in front of it
        }
        return waiter.pump(callId, stall);
      },
      signal: cancel?.signal,
    },
  );
  if (outcome.status === "aborted") {
    // `end()` on every exit, including this one: the renderer may be holding a partial line and an
    // open style, and a cancelled turn that left the terminal bold would stay bold.
    answer.end();
    endStatus(waiter.prefix);
    throw new TurnCancelled();
  }
  if (outcome.status === "timeout") {
    answer.end();
    throw waiter.timeout(stall, "timed out waiting for inference. Is OPENROUTER_API_KEY valid and the model available?");
  }
  await printNew(); // flush any stragglers
  answer.end(); // and anything the renderer was holding back for the next character
  if (!printed) endStatus(waiter.prefix); // nothing streamed (tool-call turn, or an error)
  const b = key ? await openBody(outcome.body, "message", key) : outcome.body;
  // The record this client renders and feeds back into the next turn's context.
  assertReadable(b, "streamResult");
  return {
    message: { role: "assistant", content: b.content ?? null, ...(b.tool_calls?.length ? { tool_calls: b.tool_calls } : {}) },
    finishReason: b.finishReason,
    index: b.index,
    tier: b.tier,
    context: b.context,
    usage: b.usage,
    streamed: printed,
    announced,
    ...(pending !== null ? { heldLabel: pending } : {}),
  };
}

async function awaitToolReply(
  client: RadiaClient,
  conversationId: string,
  toolCallId: string,
  prefix: string,
  tool: string,
  tools: ToolSet,
  onToolWait?: ToolWaitHook,
  key?: ConversationKey,
): Promise<{ ok: boolean; output: unknown; index: number }> {
  const waiter = new Waiter(client, prefix);
  // WHAT THIS CAN ACTUALLY KNOW, which is less than it used to claim. The old hint read "no worker
  // serves 'x'" after 2.5 seconds without a `progress` record, and that is not what the absence of a
  // progress record means: most tools emit none at all, so any tool slower than 2.5s accused a
  // worker that was about to answer. The line then vanished under the reply, which is why it read as
  // a flicker rather than as a bug.
  //
  // The strong claim IS available, but from the capability set rather than from a timer: a client
  // knows what is advertised, because that set is what it handed the model. LIVENESS is not
  // available — a `capability` record is an advertisement, and a stopped worker's record lingers —
  // and a scoped session cannot read the envelope to see whether the call was ever claimed. So the
  // advertised case says only what it can support, and the timeout names both possibilities rather
  // than picking the alarming one.
  const advertised = tools.all().some((t) => t.function.name === tool);
  const stall = tool === "request_grant"
    ? "waiting for you to approve or refuse"
    : advertised
    ? `no result yet from '${tool}'`
    : `nothing advertises '${tool}'`;
  const outcome = await awaitResult<{ ok: boolean; content: string; index: number }>(
    client,
    // BY THE PROVIDER'S CALL ID, which the model minted and the reply carries. Addressing by a
    // predicted `index` instead meant a mismatch returned the WRONG RECORD rather than nothing: a
    // round whose position field went missing put assistant messages in the slots this was waiting
    // on, and the model's prose was rendered as a tool's output.
    { kind: "message", match: { conversationId, tool_call_id: toolCallId } },
    {
      timeoutMs: tool === "request_grant" ? HUMAN_DEADLINE_MS : TOOL_DEADLINE_MS,
      // Same rule for a tool: a long code run that keeps reporting is working, not stuck.
      alive: () => waiter.beats,
      wake: waitWake,
      onWait: async () => {
        // Whatever this turn needs from the human, ask for it now rather than after the turn ends.
        if (onToolWait) await onToolWait(tool);
        await waiter.pump({ conversationId }, stall);
      },
      signal: cancel?.signal,
    },
  );
  if (outcome.status === "aborted") {
    endStatus(prefix);
    throw new TurnCancelled();
  }
  if (outcome.status === "timeout") {
    throw waiter.timeout(
      stall,
      `timed out waiting for '${tool}'` +
        (advertised ? " — its worker may have stopped, or the call may just be slow" : ""),
    );
  }
  endStatus(prefix);
  const replyBody = key ? await openBody(outcome.body, "message", key) : outcome.body;
  assertReadable(replyBody, "toolReply");
  // The reply is a tool MESSAGE now: `content` is the same JSON string this client used to write,
  // so the structured output for rendering comes back out of it.
  const parsed = ((): unknown => {
    try {
      return JSON.parse(replyBody.content);
    } catch {
      return replyBody.content;
    }
  })();
  return outcome.body.ok
    ? { ok: true, output: parsed, index: outcome.body.index }
    : { ok: false, output: (parsed as { error?: unknown })?.error ?? parsed, index: outcome.body.index };
}

// ---- the tool set is discovered, never hard-coded ----
//
// Each worker publishes what it serves as a `capability` record. The chat keeps a live set by
// WATCHING those records: a new worker's capability streams in and the tool is available on the
// next turn, with no code change here and no per-turn re-query. The chat never learns that `calc` or
// `run_javascript` exist; it learns that whatever is advertised exists, and dispatches by content.

interface ProcedureBody {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  retired?: boolean;
}

/**
 * The tool list, discovered rather than declared, from two sources with different lifetimes.
 *
 * `capability` records are what the WORKERS serve: global, and the same for every conversation.
 * `procedure` records are code this conversation's assistant wrote and named; they are offered
 * only back to that conversation, which is why the set has to be scoped before it is complete.
 * Neither is a list in this file. Adding a worker or saving a procedure changes what the model
 * can do with no edit here.
 */
export class ToolSet {
  private tools: ToolDef[] = [];
  private conversationId?: string;
  /** Conflicts already reported, tool -> the providers it was reported for, so a standing
   *  disagreement is mentioned once and a NEW one still gets through. */
  private readonly warned = new Map<string, string>();

  /**
   * Tools this PROCESS serves for itself, which are therefore not advertised and cannot be
   * discovered (client/session-tools.ts).
   *
   * The exception to "discovered, never hard-coded", and a narrow one: what a session serves is a
   * fact about this process, not knowledge about the space. Advertising them instead would put
   * one `capability` record per session per tool into a shared registry, visible to every other
   * session and claimable by none of them.
   */
  constructor(private readonly client: RadiaClient, private readonly local: ToolDef[] = []) {}

  /** What to offer the model this turn. */
  all(): ToolDef[] {
    return this.tools;
  }

  /** Bind the set to a conversation, so its saved procedures join the list. */
  async scopeTo(conversationId: string): Promise<void> {
    this.conversationId = conversationId;
    await this.refresh();
  }

  /** Keep the set current until aborted. Seeds once, then refreshes on every wakeup. */
  async watch(signal: AbortSignal): Promise<void> {
    await this.refresh();
    for (const kind of ["capability", "procedure"]) {
      (async () => {
        try {
          for await (const _ of this.client.watch({ kind }, signal)) await this.refresh();
        } catch { /* aborted on shutdown, or no grant to watch this kind */ }
      })();
    }
  }

  /** Latest record per tool name wins: a redefined tool is a successor record, the same
   *  latest-wins rule as `kind_def`, so a restart with a changed description is not a duplicate.
   *  A procedure may not shadow a worker's tool: the built-in is the one that has a worker behind
   *  it, and a saved name that collided would silently change what a call does. */
  private async refresh(): Promise<void> {
    // Capabilities first: what the workers serve, one per tool name.
    //
    // PAGED TO EXHAUSTION, because a bounded read of a registry is the bug this project keeps
    // rediscovering. The first version read an ascending page of 500 and lost the NEWEST tool on a
    // space with 505 records; `dir: "desc"` fixed the direction and left the boundedness, which just
    // moves which tools vanish — from the newest to the least recently republished. Measured on a
    // real space mid-session: 737 capability records for 33 tools, so the page was within 1.5x of
    // silently dropping tools again, and the failure is invisible (the model simply never mentions
    // a capability it was given).
    //
    // CLAUDE.md says registry state is read as a registry, never as a hand-rolled
    // `query(kind, N)`. This was the hand-rolled one.
    // Keyed by (provider, tool) SERVER-SIDE, from what the kind declares, so two workers
    // advertising one name are two entries rather than one silently overwriting the other, and the
    // key is not restated here to drift from the one `radia gc` compacts by. `collapseByTool` folds
    // them back into the single name a model can call, and says when the fold hid a disagreement.
    const view = await liveCapabilities(this.client);
    // A partial read means the tool list is a guess. Say so once rather than running a turn that
    // silently lacks something: "the assistant does not have that tool" is indistinguishable from
    // "the assistant did not think to use it", and the second is what everyone assumes.
    // `notice`, not `write`: this runs from a `capability` watch wakeup, so it can land at any
    // point, including the middle of a streaming answer. It did.
    if (!view.complete) {
      notice(dim(`[tool list may be incomplete: stopped after ${view.scanned} advertisements]`));
    }
    // Advertisements whose provider claimed presence and has stopped beating are dropped BEFORE the
    // collapse, so a dead fleet neither offers tools nobody serves nor argues with a live fleet
    // about what a name means. Only a provider that opted in can be dropped, so a worker outside
    // the convention is unaffected.
    //
    // UNDEFINED, never an empty set, when the read fails. A session whose principal predates the
    // `chat_presence` grant gets a 403 here, and an empty set would tell the filter that every
    // tracked provider is dead: the whole fleet's tools would vanish from a working space, with one
    // dim line to explain it.
    let live: Set<string> | undefined;
    try {
      const beats = await livePresence(this.client, FLEET_PRESENCE);
      // A PREFIX is not an answer either. `livePresence` reports `complete: false` when its scan
      // ceiling stopped the walk or a grant narrowed the read, and the providers it did not reach
      // are missing from the set — which this filter would read as "dead", dropping the tools of a
      // running worker and announcing that it stopped.
      if (beats.complete) live = new Set(beats.live.keys());
    } catch { /* no grant to read presence, or an older space: police nothing */ }
    const { entries, unserved } = liveAdvertisements(view.entries, live);
    for (const [tool, providers] of unserved) {
      // A tool that vanishes with no explanation reads as a tool that never existed.
      const seen = `unserved:${providers.join(",")}`;
      if (this.warned.get(tool) === seen) continue;
      this.warned.set(tool, seen);
      notice(dim(`[tool '${tool}' is advertised by ${providers.join(", ")}, which stopped running; hiding it]`));
    }
    // A capability whose `def` is not a tool definition is skipped rather than passed on (inside
    // `collapseByTool`). One malformed record would otherwise break EVERY turn, since the whole
    // list goes to the model, and publishing is only as trustworthy as the workers holding a
    // `capability: put` grant.
    const caps = collapseByTool(entries);
    // Replicas of one worker are silent; two DIFFERENT tools under one name are not, and such a
    // name is WITHHELD rather than resolved to the newest. Either provider may claim the call, so
    // offering one description means the model can be told one thing and get another.
    // ONCE per distinct conflict, not once per refresh. The set is rebuilt on every turn and on
    // every `capability` wakeup, so a standing disagreement printed on every one of them, which
    // buried the conversation it was warning about.
    for (const tool of caps.tools.keys()) this.warned.delete(tool);
    for (const [tool, e] of caps.conflicts) {
      const seen = `conflict:${e.providers.join(",")}`;
      if (this.warned.get(tool) === seen) continue;
      this.warned.set(tool, seen);
      notice(dim(`[tool '${tool}' means different things to ${e.providers.join(" and ")}; withholding it until they agree]`));
    }
    const tools = [...caps.tools.values()].map((e) => e.def);
    // What this process serves for itself. An advertised tool of the same name WINS, so a fleet
    // that starts serving one of these takes it over without a change here. A CONTESTED name is not
    // a fallback either, though nothing is offering it: these are served through `serveTools`, so
    // they are CLAIMED like any other call, and offering the session's definition for a name two
    // workers are still listening on races them for it. A contested name is offered by nobody.
    for (const def of this.local) {
      const name = def.function.name;
      if (!caps.tools.has(name) && !caps.conflicts.has(name)) tools.push(def);
    }

    if (this.conversationId) {
      // `activeByKey`, not `newestByKey`: retirement is dropped by the shared projection, so this
      // loop never has to remember to check the flag.
      const procs = activeByKey<ProcedureBody>(
        // EXHAUSTIVE: the history is per conversation and every save appends, so a page drops
        // whole procedures rather than stale versions of them. Same defect the lookup path carried
        // twice; the brand on `activeByKey` is what finally made all three visible at once.
        await this.client.queryAll({ kind: "procedure", match: { conversationId: this.conversationId } }),
        (b) => b.name,
      );
      for (const [name, rec] of procs) {
        const body = rec.body;
        // A procedure never shadows a BUILT-IN, whether a worker advertises it or this process
        // serves it: the built-in is the one with something behind it, and a saved name that
        // collided would silently change what a call does.
        // A CONTESTED name blocks a procedure too, though nothing offers it: withholding changes
        // what the model is told, never who may claim a `tool_call`, so those workers are still
        // listening on that name and a procedure taking it would be claimed by one of them.
        if (caps.tools.has(name) || caps.conflicts.has(name) || this.local.some((d) => d.function.name === name)) {
          continue;
        }
        tools.push({
          type: "function",
          function: {
            name,
            // The description the assistant wrote for itself, marked so it can tell its own saved
            // code apart from a tool a worker provides.
            description: `(saved procedure) ${body.description}`,
            parameters: body.parameters ?? { type: "object", properties: {} },
          },
        });
      }
    }
    this.tools = tools;
  }
}
