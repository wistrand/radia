// One user turn: put an `llm_call`, render what comes back, run any tools it asks for, repeat
// until the model answers in text.
//
// Notice what this file does NOT contain: no model name, no tier choice, no tool list, no routing.
// It writes an UNTIERED call and reads a result; a router-worker picks the tier, an
// inference-worker serves it, and whichever worker claims `tool_call{tool}` runs the tool. Every
// per-turn decision belongs to a worker, which is what makes this loop short enough to read.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { activeByKey, awaitResult, newestByKey, readRegistry } from "../../../sdk/ts/client.ts";
import type { ChatMessage, ToolDef } from "../provider/openrouter.ts";
import type { Thread } from "./thread.ts";
import { sessionOwner } from "../space/roles.ts";
import { type CapabilityBody, capabilityKey, collapseByTool } from "../space/capability.ts";
import { answerStream, columns, dim, endStatus, ensureLine, holdLine, notice, showArtifact, trunc, write } from "./terminal.ts";
import { Waiter, waitWake } from "./waiting.ts";

const MAX_ROUNDS = 8;

/**
 * The user pressed Escape. A distinct type so the REPL can say "cancelled" rather than "[error]".
 *
 * WHAT CANCELLING DOES AND DOES NOT DO, because the difference is not cosmetic. It stops this
 * process WAITING. It does not stop the worker: an `llm_call` already claimed is still being served,
 * and a `tool_call` already claimed still runs to completion and still writes its result. Those
 * records land whether or not anyone is watching, which is what an at-least-once substrate means and
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

const INFERENCE_DEADLINE_MS = 120_000;
const TOOL_DEADLINE_MS = 30_000;
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
): Promise<void> {
  // The last result each tool produced in THIS turn, so a second call to the same tool is recorded
  // as what it is: another attempt at the same thing. Code generation is an iterative loop (write,
  // run, read the error, fix, rerun) and every attempt used to parent to the conversation, which
  // made eight tries eight siblings with no ordering and no causality. Lineage from the final
  // attempt now walks back through the ones it replaced, so "how did this end up working" is a
  // query rather than a reconstruction from the transcript.
  const priorAttempt = new Map<string, { id: string; n: number }>();
  cancel = new AbortController();
  // The turn owns the line from here until the `finally` below, so anything a background watcher
  // produces waits rather than splicing itself into the answer.
  holdLine(true);
  try {

  for (let round = 0; round < MAX_ROUNDS; round++) {
    write("\nassistant> ");
    // The chat picks no model. It references the thread by (conversationId, upToIndex) and lets
    // the substrate decide who serves it.
    const { id: callId } = await client.put({
      kind: "llm_call",
      // `owner` rides along so a worker can copy it onto the result and chunks. That is what lets
      // a grant bind records the SESSION did not write but that were produced for it.
      body: { conversationId: thread.id, owner: sessionOwner(), upToIndex: thread.upToIndex, tools: tools.all() },
      parentIds: [thread.id],
    });
    const { message, finishReason, streamed, tier, context, announced } = await streamResult(client, callId);

    // Show the context window only when it actually dropped something; otherwise it is noise. It is
    // reported by the inference-worker, so unlike the tier it cannot be known up front. As a
    // fraction rather than a sentence: this line is printed on every turn of a long conversation,
    // and "38 msgs, 178 older not sent" spends eight words on two numbers.
    const win = context && context.hidden > 0 ? ` · ${context.sent}/${context.sent + context.hidden} msgs` : "";
    // The label normally went up before the first token (see streamResult). This is the fallback
    // for when it could not: no progress record was visible (the session may lack a grant to read
    // them), so the tier is only knowable from the result. `ensureLine` because it follows an
    // ANSWER, whose last character is the model's, not ours: without it the label was appended to
    // the final sentence, which is where it was noticed.
    if (!announced && tier) {
      ensureLine();
      write(`  ${dim(`[${tier}${win}]`)}\n`);
    } else if (win) {
      ensureLine();
      write(`${dim(`[${win.slice(3)}]`)}\n`);
    }
    await thread.append({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }, [callId]);

    if (message.tool_calls?.length) {
      write("\n");
      for (const call of message.tool_calls) {
        await runToolCall(client, thread, call, tools, onToolWait, priorAttempt);
      }
      continue; // the model reads the tool results from the thread on the next call
    }

    // Final answer. If nothing streamed (an inference error, or a non-streamed reply), print the
    // message content, or errors would be invisible. Through the same renderer, so a one-shot reply
    // is not the only markdown in the session that arrives raw.
    if (!streamed) {
      const answer = answerStream();
      answer.push(message.content || `(no content; finish_reason=${finishReason})`);
      answer.end();
    }
    write("\n");
    return;
  }
  write(`\n[stopped: ${MAX_ROUNDS} tool rounds without an answer]\n`);
  } finally {
    // Cleared whether the turn ended, threw or was cancelled, so a stale controller cannot make the
    // NEXT turn abort before it starts.
    cancel = null;
    holdLine(false); // and whatever queued while the turn ran gets printed now
  }
}

/**
 * A tool call's arguments as `k=v`, which is how they are written everywhere else a person reads
 * them. `{"expr":"17+156223"}` costs four characters of punctuation out of a 60-character budget,
 * and a single-argument call (most of them) does not need its name at all.
 */
export function showArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const val = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v);
  if (keys.length === 1) return val(args[keys[0]]);
  return keys.map((k) => `${k}=${val(args[k])}`).join(" ");
}

/**
 * A tool result as the thing it actually says.
 *
 * Both halves of this line used to be raw JSON cut at a fixed width, so anything structured (an
 * artifact, a workspace, a run) showed its braces and lost its content. A scalar prints as itself;
 * an object leads with the field that carries the answer, when there is an obvious one.
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

async function runToolCall(
  client: RadiaClient,
  thread: Thread,
  call: { id: string; function: { name: string; arguments: string } },
  tools: ToolSet,
  onToolWait?: ToolWaitHook,
  priorAttempt?: Map<string, { id: string; n: number }>,
): Promise<void> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch { /* a malformed argument object is the model's problem to see in the result */ }

  const prefix = `  · ${call.function.name}(${trunc(showArgs(args), 60)}) `;
  write(prefix);
  // `conversationId` travels in the BODY, not just parentIds, so a worker can key its progress
  // records to this turn: provenance is causality, not a lookup path.
  // The previous attempt at this tool is a DATA parent: the model wrote this call after reading
  // that result, so the new code is derived from the old failure. Taint rides parent_ids, which is
  // the right answer here rather than an accident: a fix written from tainted output is tainted.
  const previous = priorAttempt?.get(call.function.name);
  const attempt = (previous?.n ?? 0) + 1;
  const { id: toolCallId } = await client.put({
    kind: "tool_call",
    body: {
      tool: call.function.name,
      args,
      conversationId: thread.id,
      owner: sessionOwner(),
      // In the BODY as well as in the graph: `attempt` makes "how many tries did this take" a
      // count rather than a traversal, and `retryOf` names the one this replaces, so a chain is
      // readable from either direction.
      attempt,
      ...(previous ? { retryOf: previous.id } : {}),
    },
    parentIds: previous ? [thread.id, previous.id] : [thread.id],
  });
  // EVERY exit from here appends a reply, including the failures. The assistant's `tool_calls`
  // message is already on the thread by now, and a provider rejects the whole payload if any id it
  // names goes unanswered — so a throw between those two writes does not lose one turn, it makes
  // the CONVERSATION permanently unusable: every later turn reassembles the same broken history.
  // That is what a tool deadline used to do, since `awaitToolResult` throws.
  //
  // `assembleContext` repairs a thread that already holds one (it must: this cannot fix history).
  // This is the other half, and it is the better half — the model gets to SEE "timed out" and try
  // something else, where a repaired context just silently lacks the call.
  let result: { ok: boolean; output: unknown };
  try {
    result = await awaitToolResult(client, toolCallId, prefix, call.function.name, tools, onToolWait);
  } catch (e) {
    // A CANCELLED turn takes this path too, and that is the point of it being here rather than in a
    // narrower catch. The assistant's `tool_calls` message is already on the thread; leaving its
    // reply absent is what makes every later turn in the conversation unsendable, so Escape has to
    // answer the call it interrupted exactly as a timeout does. The wording differs because the
    // model should learn what happened: the user stopped waiting, and the worker did not stop.
    const output = e instanceof TurnCancelled
      ? {
        error: "the user cancelled this turn. The tool was already claimed and is still running, " +
          "so its result will land in the space; nothing here is a failure of the tool.",
      }
      : { error: e instanceof Error ? e.message : String(e) };
    await thread.append({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) }, [toolCallId]);
    throw e;
  }
  priorAttempt?.set(call.function.name, { id: toolCallId, n: attempt });
  // Capped as well as fitted: on a wide terminal "fits the window" is 200 characters of JSON, which
  // is a wall rather than a summary. The record has the whole thing.
  write(`${result.ok ? "→" : "✗"} ${trunc(showOutput(result.output), Math.max(24, Math.min(120, columns() - prefix.length - 4)))}\n`);
  await showArtifact(client, result.output);
  await thread.append(
    { role: "tool", tool_call_id: call.id, content: JSON.stringify(result.ok ? result.output : { error: result.output }) },
    [toolCallId],
  );
}

interface StreamedResult {
  message: ChatMessage;
  finishReason: string;
  streamed: boolean;
  announced: boolean; // the routing label was already printed from the router's progress record
  tier?: string; // the tier that answered, stamped by the inference-worker
  context?: { sent: number; hidden: number }; // what the worker's context window sent vs. omitted
}

/** Follow one call: print `llm_chunk` deltas as they land, return when the `llm_result` arrives. */
async function streamResult(client: RadiaClient, callId: string): Promise<StreamedResult> {
  const stall = "no worker claimed this call. Is the router/inference fleet running?";
  let lastIndex = -1; // watermark over ONE monotonic stream: an escalation hands it on, never resets
  let printed = false; // any visible text on the line yet
  let announced = false; // the routing label is on screen
  // The answer is markdown, and it arrives in pieces, so the renderer is stateful and lives as long
  // as the answer does. Off a terminal this is the model's bytes, unaltered.
  let answer = answerStream();

  // The tier is known the moment the ROUTER decides it, which is before the tiered call exists and
  // so before any token can stream. Reading it from the router's progress record puts the label
  // ahead of the text it describes; taking it from the `llm_result` (as this once did) can only
  // ever print it after the last token, describing an answer the user has already read.
  const label = (text: string) => {
    endStatus(waiter.prefix);
    write(`${dim(`[${text}]`)}\n`);
    waiter.prefix = ""; // the prompt is spent, so later status lines must not reprint it
    announced = true;
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
    const chunks = await client.query(
      { kind: "llm_chunk", match: { callId, index: { $gt: lastIndex } }, orderBy: [{ path: "index" }] },
      500,
    );
    for (const chunk of chunks) {
      const b = chunk.body as { index: number; delta: string; reset?: boolean };
      if (b.index <= lastIndex) continue;
      lastIndex = b.index;
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
  const outcome = await awaitResult<Omit<StreamedResult, "streamed" | "announced">>(
    client,
    { kind: "llm_result", match: { callId } },
    {
      timeoutMs: INFERENCE_DEADLINE_MS,
      wake: waitWake,
      beforeRead: printNew,
      onWait: () => (printed ? undefined : waiter.pump(callId, stall)),
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
  return { ...outcome.body, streamed: printed, announced };
}

async function awaitToolResult(
  client: RadiaClient,
  callId: string,
  prefix: string,
  tool: string,
  tools: ToolSet,
  onToolWait?: ToolWaitHook,
): Promise<{ ok: boolean; output: unknown }> {
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
  const outcome = await awaitResult<{ ok: boolean; output: unknown }>(
    client,
    { kind: "tool_result", match: { callId } },
    {
      timeoutMs: tool === "request_grant" ? HUMAN_DEADLINE_MS : TOOL_DEADLINE_MS,
      wake: waitWake,
      onWait: async () => {
        // Whatever this turn needs from the human, ask for it now rather than after the turn ends.
        if (onToolWait) await onToolWait(tool);
        await waiter.pump(callId, stall);
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
  return outcome.body;
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

  constructor(private readonly client: RadiaClient) {}

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
    // CLAUDE.md says registry state is read through `readRegistry`, never a hand-rolled
    // `query(kind, N)`. This was the hand-rolled one.
    // Keyed by (provider, tool), so two workers advertising one name are two entries rather than
    // one silently overwriting the other; `collapseByTool` folds them back into the single name a
    // model can call, and says when the fold hid a disagreement.
    const view = await readRegistry<CapabilityBody>(
      (limit, after) => this.client.query({ kind: "capability" }, limit, { dir: "desc", after }),
      capabilityKey,
    );
    // A partial read means the tool list is a guess. Say so once rather than running a turn that
    // silently lacks something: "the assistant does not have that tool" is indistinguishable from
    // "the assistant did not think to use it", and the second is what everyone assumes.
    // `notice`, not `write`: this runs from a `capability` watch wakeup, so it can land at any
    // point, including the middle of a streaming answer. It did.
    if (!view.complete) {
      notice(dim(`[tool list may be incomplete: stopped after ${view.entries.size} advertisements]`));
    }
    // A capability whose `def` is not a tool definition is skipped rather than passed on (inside
    // `collapseByTool`). One malformed record would otherwise break EVERY turn, since the whole
    // list goes to the model, and publishing is only as trustworthy as the workers holding a
    // `capability: put` grant.
    const caps = collapseByTool(view.entries);
    // Replicas of one worker are silent; two DIFFERENT tools under one name are not. The model is
    // handed one description and either worker may claim the call, so this is the case where what
    // it was told and what runs can differ.
    // ONCE per distinct conflict, not once per refresh. The set is rebuilt on every turn and on
    // every `capability` wakeup, so a standing disagreement printed on every one of them, which
    // buried the conversation it was warning about.
    for (const [tool, e] of caps) {
      if (!e.conflicted) {
        this.warned.delete(tool);
        continue;
      }
      const seen = `${tool}:${e.providers.join(",")}`;
      if (this.warned.get(tool) === seen) continue;
      this.warned.set(tool, seen);
      notice(dim(`[tool '${tool}' is advertised differently by ${e.providers.join(", ")}; using the newest]`));
    }
    const tools = [...caps.values()].map((e) => e.def);

    if (this.conversationId) {
      // `activeByKey`, not `newestByKey`: retirement is dropped by the shared projection, so this
      // loop never has to remember to check the flag.
      const procs = activeByKey<ProcedureBody>(
        await this.client.query({ kind: "procedure", match: { conversationId: this.conversationId } }, 200, { dir: "desc" }),
        (b) => b.name,
      );
      for (const [name, rec] of procs) {
        const body = rec.body as ProcedureBody;
        // A procedure never shadows a worker's tool: the built-in is the one with a worker behind
        // it, and a saved name that collided would silently change what a call does.
        if (caps.has(name)) continue;
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
