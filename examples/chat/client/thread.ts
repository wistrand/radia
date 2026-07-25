// The conversation, which lives on the space rather than in this process.
//
// A `conversation` record anchors an append-only thread of `message` records. The chat appends
// (assigning the index); the inference-worker reconstructs the context by querying the thread. So
// history is stored once — linear, not quadratic, with no re-embedding — the whole conversation is
// reconstructible from the space, and every message is a record you can watch in the Feed.
//
// The one piece of client-held state is `nextIndex`, and it is a single-writer assumption: two
// REPLs on one conversationId would collide on `index`. Making it space-authoritative needs a
// claim-and-append protocol, which would obscure the thing this example exists to show.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { Role } from "../space/roles.ts";

export interface OutgoingMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export class Thread {
  private nextIndex = 0;

  private constructor(private readonly client: RadiaClient, readonly id: string) {}

  static async open(client: RadiaClient, role: Role): Promise<Thread> {
    const { id } = await client.put({ kind: "conversation", body: {} });
    const thread = new Thread(client, id);
    // The assistant is told its OWN id, not how to use it. Identity is data an agent needs to act
    // on its own behalf — the same category as handing a worker a run token — while the mechanism
    // (which kind, which match, which order) stays in the tool descriptions. Without it the
    // "retrieve rather than recall" disposition is unusable: the reconstructed thread carries no
    // conversationId, the `conversation` record has an empty body and no indexed path, and
    // role=user cannot enumerate conversations at all.
    await thread.append({ role: "system", content: `${systemPrompt(role)}\nThis conversation's id is ${id}.` });
    return thread;
  }

  /** The index the next `llm_call` should read up to. */
  get upToIndex(): number {
    return this.nextIndex - 1;
  }

  async append(msg: OutgoingMessage, parentIds: string[] = []): Promise<void> {
    await this.client.put({
      kind: "message",
      body: { conversationId: this.id, index: this.nextIndex++, ...msg },
      parentIds: [this.id, ...parentIds],
    });
  }
}

// Generic role framing only — NO substrate specifics (kind names, matching patterns, tool usage).
// The assistant discovers kinds with space_kinds and learns each tool from its own description.
// Baking that knowledge here is the anti-pattern the design principle warns against. What a prompt
// MAY carry is a disposition (when to reach for a tool at all) and the agent's own identity.
function systemPrompt(role: Role): string {
  return "You are a concise assistant on Radia, a content-routed coordination runtime. Your tools are " +
    "provided to you (discovered from the space, so the set may change between turns); each tool's " +
    "description says what it does and how to use it — rely on those, not on assumptions, and do " +
    "not confuse tools with record kinds. Everything in Radia is a record, including this " +
    "conversation and your own reasoning, so your space_* tools can inspect and even operate on the " +
    "space itself (use space_kinds to see what record kinds exist). Use state-changing tools " +
    "deliberately, and prefer to inspect before acting. If you are unsure what happened earlier in " +
    "this session, retrieve it rather than recall it: your own history is inspectable, and a checked " +
    "answer is worth a tool call where a remembered one is a guess. Do not spend a call on something " +
    "you can already see.\n" +
    (role === "admin"
      ? "This session runs as the OPERATOR: your space_* tools have full access to the space's control plane."
      : "This session runs as a SCOPED USER (agent:chat-user). Use any tool you are given normally — the " +
        "file, compute, and conversation tools all work. Some space_* tools touch the control plane and the " +
        "space may refuse them for this principal. ALWAYS call the tool the task needs; never refuse or skip " +
        "a tool without calling it. Only if a call returns a forbidden/403 error, tell the user plainly that " +
        "you lack the grant for that operation.");
}
