// One user turn: put an `llm_call`, render what comes back, run any tools it asks for, repeat
// until the model answers in text.
//
// Notice what this file does NOT contain: no model name, no tier choice, no tool list, no routing.
// It writes an UNTIERED call and reads a result; a router-worker picks the tier, an
// inference-worker serves it, and whichever worker claims `tool_call{tool}` runs the tool. Every
// per-turn decision belongs to a worker, which is what makes this loop short enough to read.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { activeByKey, newestByKey } from "../../../sdk/ts/client.ts";
import type { ChatMessage, ToolDef } from "../provider/openrouter.ts";
import type { Thread } from "./thread.ts";
import { dim, endStatus, showArtifact, trunc, write } from "./terminal.ts";
import { Waiter, waitWake } from "./waiting.ts";

const MAX_ROUNDS = 8;
const INFERENCE_DEADLINE_MS = 120_000;
const TOOL_DEADLINE_MS = 30_000;

export async function runTurn(client: RadiaClient, thread: Thread, tools: ToolSet): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    write("\nassistant> ");
    // The chat picks no model — it references the thread by (conversationId, upToIndex) and lets
    // the substrate decide who serves it.
    const { id: callId } = await client.put({
      kind: "llm_call",
      body: { conversationId: thread.id, upToIndex: thread.upToIndex, tools: tools.all() },
      parentIds: [thread.id],
    });
    const { message, finishReason, streamed, tier, context, announced } = await streamResult(client, callId);

    // Show the context window only when it actually dropped something — otherwise it is noise.
    // It is reported by the inference-worker, so unlike the tier it cannot be known up front.
    const win = context && context.hidden > 0 ? ` · ${context.sent} msgs, ${context.hidden} older not sent` : "";
    // The label normally went up before the first token (see streamResult). This is the fallback
    // for when it could not: no progress record was visible — the session may lack a grant to read
    // them — so the tier is only knowable from the result.
    if (!announced && tier) write(`  ${dim(`[routed → ${tier}${win}]`)}\n`);
    else if (win) write(`${dim(`[context${win}]`)}\n`);
    await thread.append({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }, [callId]);

    if (message.tool_calls?.length) {
      write("\n");
      for (const call of message.tool_calls) {
        await runToolCall(client, thread, call);
      }
      continue; // the model reads the tool results from the thread on the next call
    }

    // Final answer. If nothing streamed (an inference error, or a non-streamed reply), print the
    // message content — otherwise errors would be invisible.
    if (!streamed) write(message.content || `(no content; finish_reason=${finishReason})`);
    write("\n");
    return;
  }
  write(`\n[stopped: ${MAX_ROUNDS} tool rounds without an answer]\n`);
}

async function runToolCall(
  client: RadiaClient,
  thread: Thread,
  call: { id: string; function: { name: string; arguments: string } },
): Promise<void> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch { /* a malformed argument object is the model's problem to see in the result */ }

  const prefix = `  · ${call.function.name}(${trunc(JSON.stringify(args), 60)}) `;
  write(prefix);
  // `conversationId` travels in the BODY, not just parentIds, so a worker can key its progress
  // records to this turn: provenance is causality, not a lookup path.
  const { id: toolCallId } = await client.put({
    kind: "tool_call",
    body: { tool: call.function.name, args, conversationId: thread.id },
    parentIds: [thread.id],
  });
  const result = await awaitToolResult(client, toolCallId, prefix, call.function.name);
  write(`-> ${trunc(JSON.stringify(result.output), 80)}\n`);
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
  const stall = "no worker claimed this call — is the router/inference fleet running?";
  let lastIndex = -1; // watermark over ONE monotonic stream: an escalation hands it on, never resets
  let printed = false; // any visible text on the line yet
  let announced = false; // the routing label is on screen

  // The tier is known the moment the ROUTER decides it, which is before the tiered call exists and
  // so before any token can stream. Reading it from the router's progress record puts the label
  // ahead of the text it describes; taking it from the `llm_result` (as this once did) can only
  // ever print it after the last token, describing an answer the user has already read.
  const label = (text: string) => {
    endStatus(waiter.prefix);
    write(`${dim(`[${text}]`)}\n`);
    waiter.prefix = ""; // the prompt is spent — later status lines must not reprint it
    announced = true;
  };
  const waiter = new Waiter(client, "assistant> ", (p) => {
    if (!p.note) return;
    // `routed` carries "→ tier"; `escalating` carries "from → to" when a worker gives up mid-answer
    // and hands the turn to a stronger model. Both are routing decisions, both belong in the
    // stream at the point they happen.
    if (p.stage === "routed") label(`routed ${p.note}`);
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
        if (printed) write(`\n${dim("↩ discarding the partial answer above")}\n`);
        printed = false;
        continue;
      }
      if (!b.delta) continue;
      if (!printed) endStatus(waiter.prefix); // first token: drop the status, keep the prompt
      write(b.delta);
      printed = true;
    }
  };

  const deadline = Date.now() + INFERENCE_DEADLINE_MS;
  while (Date.now() < deadline) {
    await printNew();
    const result = await client.readOne({ kind: "llm_result", match: { callId } });
    if (result) {
      await printNew(); // flush any stragglers
      if (!printed) endStatus(waiter.prefix); // nothing streamed (tool-call turn, or an error)
      const body = result.body as Omit<StreamedResult, "streamed" | "announced">;
      return { ...body, streamed: printed, announced };
    }
    if (!printed) await waiter.pump(callId, stall); // status only until output takes the line
    await waitWake();
  }
  throw waiter.timeout(stall, "timed out waiting for inference — is OPENROUTER_API_KEY valid and the model available?");
}

async function awaitToolResult(
  client: RadiaClient,
  callId: string,
  prefix: string,
  tool: string,
): Promise<{ ok: boolean; output: unknown }> {
  const waiter = new Waiter(client, prefix);
  const stall = `no worker serves '${tool}'`;
  const deadline = Date.now() + TOOL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const result = await client.readOne({ kind: "tool_result", match: { callId } });
    if (result) {
      endStatus(prefix);
      return result.body as { ok: boolean; output: unknown };
    }
    await waiter.pump(callId, stall);
    await waitWake();
  }
  throw waiter.timeout(stall, `timed out waiting for '${tool}'`);
}

// ---- the tool set is discovered, never hard-coded ----
//
// Each worker publishes what it serves as a `capability` record. The chat keeps a live set by
// WATCHING those records: a new worker's capability streams in and the tool is available on the
// next turn — no code change here, no per-turn re-query. The chat never learns that `calc` or
// `run_code` exist; it learns that whatever is advertised exists, and dispatches by content.

interface ProcedureBody {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  retired?: boolean;
}

/**
 * The tool list, discovered rather than declared — from two sources with different lifetimes.
 *
 * `capability` records are what the WORKERS serve: global, and the same for every conversation.
 * `procedure` records are code this conversation's assistant wrote and named; they are offered
 * only back to that conversation, which is why the set has to be scoped before it is complete.
 * Neither is a list in this file — adding a worker or saving a procedure changes what the model
 * can do with no edit here.
 */
export class ToolSet {
  private tools: ToolDef[] = [];
  private conversationId?: string;

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

  /** Latest record per tool name wins — a redefined tool is a successor record, the same
   *  latest-wins rule as `kind_def`, so a restart with a changed description is not a duplicate.
   *  A procedure may not shadow a worker's tool: the built-in is the one that has a worker behind
   *  it, and a saved name that collided would silently change what a call does. */
  private async refresh(): Promise<void> {
    // Capabilities first: what the workers serve, one per tool name.
    // `dir: "desc"` is load-bearing, not a flourish. A limited query returns the OLDEST matches,
    // and a busy space accumulates capability records faster than it has tools — so an ascending
    // page of 500 on a space with 505 records showed every tool EXCEPT the one published most
    // recently. The chat then ran without a tool it had been given, and the model correctly
    // reported it did not have it.
    const caps = activeByKey<{ tool: string; def: ToolDef }>(
      await this.client.query({ kind: "capability" }, 500, { dir: "desc" }),
      (b) => b.tool,
    );
    // A capability whose `def` is not a tool definition is skipped rather than passed on. One
    // malformed record would otherwise break EVERY turn — the whole list goes to the model — and
    // publishing is only as trustworthy as the workers holding a `capability: put` grant.
    const tools = [...caps.values()]
      .map((r) => (r.body as { def?: ToolDef }).def)
      .filter((d): d is ToolDef => typeof d?.function?.name === "string");

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
