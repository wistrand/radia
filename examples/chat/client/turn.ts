// One user turn: put an `llm_call`, render what comes back, run any tools it asks for, repeat
// until the model answers in text.
//
// Notice what this file does NOT contain: no model name, no tier choice, no tool list, no routing.
// It writes an UNTIERED call and reads a result; a router-worker picks the tier, an
// inference-worker serves it, and whichever worker claims `tool_call{tool}` runs the tool. Every
// per-turn decision belongs to a worker, which is what makes this loop short enough to read.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
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
    const { message, finishReason, streamed, tier, context } = await streamResult(client, callId);

    // Show the context window only when it actually dropped something — otherwise it is noise.
    const win = context && context.hidden > 0 ? ` · ${context.sent} msgs, ${context.hidden} older not sent` : "";
    if (tier) write(`  ${dim(`[routed → ${tier}${win}]`)}\n`);
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
  tier?: string; // the tier that answered, stamped by the inference-worker
  context?: { sent: number; hidden: number }; // what the worker's context window sent vs. omitted
}

/** Follow one call: print `llm_chunk` deltas as they land, return when the `llm_result` arrives. */
async function streamResult(client: RadiaClient, callId: string): Promise<StreamedResult> {
  const waiter = new Waiter(client, "assistant> ");
  const stall = "no worker claimed this call — is the router/inference fleet running?";
  let lastIndex = -1; // watermark over ONE monotonic stream: an escalation hands it on, never resets
  let printed = false; // any visible text on the line yet

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
        // away. Say so, rather than letting the stronger model's answer append to it.
        if (printed) write(`\n${dim("↩ escalated — restarting on a stronger model")}\n`);
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
      const body = result.body as Omit<StreamedResult, "streamed">;
      return { ...body, streamed: printed };
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

export class ToolSet {
  private tools: ToolDef[] = [];

  constructor(private readonly client: RadiaClient) {}

  /** What to offer the model this turn. */
  all(): ToolDef[] {
    return this.tools;
  }

  /** Keep the set current until aborted. Seeds once, then refreshes on every wakeup. */
  async watch(signal: AbortSignal): Promise<void> {
    await this.refresh();
    try {
      for await (const _ of this.client.watch({ kind: "capability" }, signal)) await this.refresh();
    } catch { /* aborted on shutdown */ }
  }

  /** Latest capability record per tool wins — a redefined tool is a successor record, the same
   *  latest-wins rule as `kind_def`, so a restart with a changed description is not a duplicate. */
  private async refresh(): Promise<void> {
    const caps = await this.client.query({ kind: "capability" }, 500);
    const latest = new Map<string, { id: string; def: ToolDef }>();
    for (const c of caps) {
      const b = c.body as { tool: string; def: ToolDef };
      const prev = latest.get(b.tool);
      if (!prev || prev.id < c.id) latest.set(b.tool, { id: c.id, def: b.def });
    }
    this.tools = [...latest.values()].map((v) => v.def);
  }
}
