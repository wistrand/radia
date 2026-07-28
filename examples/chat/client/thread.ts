// The conversation, which lives on the space rather than in this process.
//
// A `conversation` record anchors an append-only thread of `message` records. The chat appends
// (assigning the index); the inference-worker reconstructs the context by querying the thread. So
// history is stored once (linear, not quadratic, with no re-embedding), the whole conversation is
// reconstructible from the space, and every message is a record you can watch in the Feed.
//
// The one piece of client-held state is `nextIndex`, and it is a single-writer assumption: two
// REPLs on one conversationId would collide on `index`. Making it space-authoritative needs a
// claim-and-append protocol, which would obscure the thing this example exists to show.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { CHAT_USER as OWNER, type Role } from "../space/roles.ts";

export interface OutgoingMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export class Thread {
  private nextIndex = 0;
  private startedAt = 0;

  private constructor(private readonly client: RadiaClient, readonly id: string) {}

  /**
   * Attach to a conversation record that ALREADY EXISTS.
   *
   * The record is created by the operator before the session token is minted, because the session's
   * grants are scoped to this conversation and a grant is minted with the token. That also means a
   * user-role session no longer needs `conversation: put` at all.
   */
  static async open(client: RadiaClient, role: Role, id: string): Promise<Thread> {
    const thread = new Thread(client, id);
    // The assistant is told its OWN id, not how to use it. Identity is data an agent needs to act
    // on its own behalf (the same category as handing a worker a run token), while the mechanism
    // (which kind, which match, which order) stays in the tool descriptions. Without it the
    // "retrieve rather than recall" disposition is unusable: the reconstructed thread carries no
    // conversationId, the `conversation` record has an empty body and no indexed path, and
    // role=user cannot enumerate conversations at all.
    await thread.append({ role: "system", content: `${systemPrompt(role)}\nThis conversation's id is ${id}.` });
    return thread;
  }

  /**
   * Reattach to an existing conversation.
   *
   * `nextIndex` is the only state this class holds, so resuming is entirely a matter of recovering
   * it. The transcript itself was never in the process. The highest existing index gives it in one
   * query, which is exactly what `index` being a declared SORTABLE path is for.
   *
   * A fresh system message is appended rather than inheriting the old one. The prompt is a record
   * written at creation and the inference-worker always sends it, never windowing it out, so a
   * resumed conversation would otherwise keep running under whatever disposition was current
   * months ago. Two system messages in the thread is the lesser problem: the model reads the later
   * one as the standing instructions, and the earlier is honest history.
   */
  static async resume(client: RadiaClient, id: string, role: Role): Promise<Thread> {
    const last = await client.query(
      { kind: "message", match: { conversationId: id }, orderBy: [{ path: "index", dir: "desc" }] },
      1,
    );
    if (last.length === 0) throw new Error(`no conversation ${id} on this space (or no grant to read it)`);
    const thread = new Thread(client, id);
    thread.nextIndex = Number((last[0].body as { index?: number }).index ?? 0) + 1;
    thread.startedAt = thread.nextIndex;
    await thread.append({
      role: "system",
      content: `${systemPrompt(role)}\nThis conversation's id is ${id}.\n` +
        `This conversation was resumed; everything above happened in an earlier session.`,
    });
    return thread;
  }

  /** How many messages precede this session; 0 for a fresh conversation. */
  get resumedFrom(): number {
    return this.startedAt;
  }

  /** The index the next `llm_call` should read up to. */
  get upToIndex(): number {
    return this.nextIndex - 1;
  }

  async append(msg: OutgoingMessage, parentIds: string[] = []): Promise<void> {
    await this.client.put({
      kind: "message",
      // `owner` is the identity binding a grant can scope on, and it is stamped even when the
      // session is scoped by conversation instead: a record that carries both can be read under
      // either posture, so switching RADIA_CHAT_SCOPE does not blind a session to its own history.
      // The runtime enforces it rather than trusting it: under identity scoping the write pattern
      // is `{owner}`, so a session physically cannot stamp another identity here.
      body: { conversationId: this.id, owner: OWNER, index: this.nextIndex++, ...msg },
      parentIds: [this.id, ...parentIds],
    });
  }
}

// Generic role framing only, with NO substrate specifics (kind names, matching patterns, tool usage).
// The assistant discovers kinds with space_kinds and learns each tool from its own description.
// Baking that knowledge here is the anti-pattern the design principle warns against. What a prompt
// MAY carry is a disposition (when to reach for a tool at all) and the agent's own identity.
function systemPrompt(role: Role): string {
  return "You are a concise assistant on Radia, a content-routed coordination runtime. Your tools are " +
    "provided to you (discovered from the space, so the set may change between turns); each tool's " +
    "description says what it does and how to use it. Rely on those, not on assumptions, and do " +
    "not confuse tools with record kinds. Everything in Radia is a record, including this " +
    "conversation and your own reasoning, so your space_* tools can inspect and even operate on the " +
    "space itself (use space_kinds to see what record kinds exist). Use state-changing tools " +
    "deliberately, and prefer to inspect before acting. If you are unsure what happened earlier in " +
    "this session, retrieve it rather than recall it: your own history is inspectable, and a checked " +
    "answer is worth a tool call where a remembered one is a guess. Do not spend a call on something " +
    "you can already see.\n" +
    (role === "admin"
      ? "This session runs as the OPERATOR: your space_* tools have full access to the space's control plane."
      : "This session runs as a SCOPED USER (agent:chat-user). Use any tool you are given normally: the " +
        "file, compute, and conversation tools all work. Some space_* tools touch the control plane and the " +
        "space may refuse them for this principal. ALWAYS call the tool the task needs; never refuse or skip " +
        "a tool without calling it. A forbidden/403 is NOT a dead end and not something to work around: it " +
        "means a human has to grant you that authority, so ask for it with request_grant and say in your " +
        "reply what you asked for. Do not substitute a weaker approach that answers a narrower question. " +
        "Reconstructing by hand what a refused call would have told you produces a worse answer AND hides " +
        "that a grant was needed. Do not retry the refused call until the human has answered.");
}
