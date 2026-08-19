// The conversation, which lives on the space rather than in this process.
//
// A `conversation` record anchors an append-only thread of `message` records. The chat appends
// (assigning the index); the inference-worker reconstructs the context by querying the thread. So
// history is stored once (linear, not quadratic, with no re-embedding), the whole conversation is
// reconstructible from the space, and every message is a record you can watch in the Feed.
//
// The one piece of client-held state is `nextIndex`, and it is no longer a single-writer
// assumption: `append` CLAIMS its slot with an idempotency key, so a second client (a tab, the
// terminal) loses the race rather than writing on top of the winner. See `append` for what that
// fixes and what it does not.

import { type RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { type ConversationKey, sealBody } from "../../../extensions/ts/encrypted.ts";
import { sessionOwner } from "../space/roles.ts";

export interface OutgoingMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export class Thread {
  private nextIndex = 0;
  private startedAt = 0;

  private constructor(
    private readonly client: RadiaClient,
    readonly id: string,
    /** This conversation's DEK, when it is an encrypted one (plan-encryption.md phase 3). Absent for
     *  a plaintext thread, which is the default and stays byte-for-byte what it always was. */
    private readonly key?: ConversationKey,
  ) {}

  /**
   * Attach to a conversation record that ALREADY EXISTS.
   *
   * The record is created by the operator before the session token is minted, because the session's
   * grants are scoped to this conversation and a grant is minted with the token. That also means a
   * user-role session no longer needs `conversation: put` at all.
   */
  static async open(client: RadiaClient, who: Identity, id: string, key?: ConversationKey): Promise<Thread> {
    const thread = new Thread(client, id, key);
    // The assistant is told its OWN id, not how to use it. Identity is data an agent needs to act
    // on its own behalf (the same category as handing a worker a run token), while the mechanism
    // (which kind, which match, which order) stays in the tool descriptions. Without it the
    // "retrieve rather than recall" disposition is unusable: the reconstructed thread carries no
    // conversationId, the `conversation` record has an empty body and no indexed path, and
    // a scoped session cannot enumerate conversations at all.
    await thread.append({ role: "system", content: `${systemPrompt(who)}\nThis conversation's id is ${id}.` });
    return thread;
  }

  /**
   * Attach to an existing conversation WITHOUT writing to it.
   *
   * `nextIndex` is the only state this class holds, so attaching is entirely a matter of recovering
   * it. The transcript itself was never in the process. The highest existing index gives it in one
   * query, which is exactly what `index` being a declared SORTABLE path is for.
   *
   * Writing nothing is the whole difference between joining a thread and taking it over: a viewer
   * (a second tab, a read-only window) must leave no trace, and appending is a write. `resume` is
   * this plus that append, so the two cannot drift.
   */
  static async attach(client: RadiaClient, id: string, key?: ConversationKey): Promise<Thread> {
    const last = await client.query(
      { kind: "message", match: { conversationId: id }, orderBy: [{ path: "index", dir: "desc" }] },
      1,
    );
    if (last.length === 0) throw new Error(`no conversation ${id} on this space (or no grant to read it)`);
    const thread = new Thread(client, id, key);
    thread.nextIndex = Number((last[0].body as { index?: number }).index ?? 0) + 1;
    thread.startedAt = thread.nextIndex;
    return thread;
  }

  /**
   * Reattach and take the thread up: `attach`, then a fresh system message.
   *
   * The prompt is appended rather than inherited. It is a record written at creation and the
   * inference-worker always sends it, never windowing it out, so a resumed conversation would
   * otherwise keep running under whatever disposition was current months ago. Two system messages in
   * the thread is the lesser problem: the model reads the later one as the standing instructions,
   * and the earlier is honest history.
   */
  static async resume(client: RadiaClient, id: string, who: Identity, key?: ConversationKey): Promise<Thread> {
    const thread = await Thread.attach(client, id, key);
    await thread.append({
      role: "system",
      content: `${systemPrompt(who)}\nThis conversation's id is ${id}.\n` +
        `This conversation was resumed; everything above happened in an earlier session.`,
    });
    return thread;
  }

  /** This conversation's DEK, or undefined for a plaintext thread. The turn's render loop needs it
   *  to open what the workers wrote, and it comes from here so one thread has exactly one key. */
  get dek(): ConversationKey | undefined {
    return this.key;
  }

  /** How many messages precede this session; 0 for a fresh conversation. */
  get resumedFrom(): number {
    return this.startedAt;
  }

  /** The index the next `llm_call` should read up to, and therefore the turn's own `turnAt`. Unique
   *  per turn because `append` claims its slot: that is what stops two concurrent turns sharing an
   *  identity, which is the collision that mattered. */
  get upToIndex(): number {
    return this.nextIndex - 1;
  }

  /** Advance the cursor past a message some WORKER wrote (the assistant message arrives as the
   *  inference worker's ack, at an index derived from the call; this client never writes it).
   *  `max` and not `index + 1` blindly: an escalated call answers the same slot once. */
  noteExternal(index: number): void {
    this.nextIndex = Math.max(this.nextIndex, index + 1);
  }

  /** The message this client appended most recently. A turn hangs off it, so the waterfall for a
   *  turn starts where the person asked rather than at the conversation. */
  get lastAppended(): string | undefined {
    return this.lastId;
  }
  private lastId: string | undefined;

  /**
   * Append at the next slot, CLAIMING it rather than assuming it.
   *
   * `nextIndex` is one client's idea of where the transcript ends, and a second client (a tab, the
   * terminal, a phone) holds its own. Two of them appending at once used to write two messages at
   * one index, and the damage was not the display order: `turnAt` is the index the turn started at,
   * so two turns shared an identity and the workers addressing `{turnAt, round, role}` could answer
   * with each other's records.
   *
   * The claim is the idempotency key. A key reused with a DIFFERENT request is refused
   * (`idempotency_conflict`), and the runtime makes exactly one writer win even on pooled
   * connections, so the loser learns the slot is taken, re-reads the end of the transcript, and
   * takes the next one. That is compare-and-append, out of a primitive that is already there.
   *
   * TWO LIMITS, both stated because they bound what this fixes. The key is scoped to the DURABLE
   * IDENTITY behind the caller (`Space.idem`), so it serializes one person's clients and not two
   * people's — which is the case that exists, since a conversation's grants scope to its owner. And
   * an identical message racing for one slot is DEDUPED rather than refused (same key, same
   * request), so both clients get the one record: sending the same words twice at the same position
   * yields one message.
   */
  async append(msg: OutgoingMessage, parentIds: string[] = []): Promise<string> {
    // Bounded: each attempt moves one slot forward against a live writer, and a loop that cannot
    // find a free slot in this many tries is not racing, it is broken.
    for (let attempt = 0;; attempt++) {
      const index = this.nextIndex;
      const key = `msg:${this.id}:${index}`;
      const body = { conversationId: this.id, owner: sessionOwner(), index, ...msg };
      try {
        const { id } = await this.client.put({
          kind: "message",
          // `owner` is the identity binding a grant can scope on, and it is stamped even when the
          // session is scoped by conversation instead: a record that carries both can be read under
          // either posture, so switching RADIA_CHAT_SCOPE does not blind a session to its own
          // history. The runtime enforces it rather than trusting it: under identity scoping the
          // write pattern is `{owner}`, so a session physically cannot stamp another identity here.
          //
          // Sealed HERE rather than by the caller: every message this session writes goes through
          // this one method, so a new call site cannot forget. Keyed by the slot claim, so the
          // ciphertext of a REPLAYED write is identical and replays instead of reading as a
          // different request (plan-encryption.md).
          body: this.key ? await sealBody(body, "message", this.key, key) : body,
          parentIds: [this.id, ...parentIds],
        }, key);
        this.nextIndex = index + 1;
        this.lastId = id;
        return id;
      } catch (e) {
        const taken = e instanceof RadiaClientError && e.code === "idempotency_conflict";
        if (!taken || attempt >= 20) throw e;
        // Somebody else is writing here. Re-read where the transcript actually ends rather than
        // incrementing blindly: several messages may have landed while this one was being composed.
        await this.resync();
        if (this.nextIndex <= index) this.nextIndex = index + 1;
      }
    }
  }

  /** Re-read the end of the transcript. The cursor is the only state this class holds, so this is
   *  the whole of catching up with what other clients wrote. */
  private async resync(): Promise<void> {
    const last = await this.client.query(
      { kind: "message", match: { conversationId: this.id }, orderBy: [{ path: "index", dir: "desc" }] },
      1,
    );
    const highest = Number((last[0]?.body as { index?: number })?.index ?? -1);
    this.nextIndex = Math.max(this.nextIndex, highest + 1);
  }
}

// Generic role framing only, with NO space specifics (kind names, matching patterns, tool usage).
// The assistant discovers kinds with space_kinds and learns each tool from its own description.
// Baking that knowledge here is the anti-pattern the design principle warns against. What a prompt
// MAY carry is a disposition (when to reach for a tool at all) and the agent's own identity.
/**
 * Who this session IS. Not a role name: the principal the session's credential resolves to, and
 * whether the space treats it as privileged.
 *
 * It used to be a role name from the launcher's config, which described how the process was started
 * rather than who was using it. The prompt told the assistant it was `agent:chat-user` while it ran
 * as a named person, so "whoami" answered with a constant from this file.
 */
export interface Identity {
  principal: string;
  privileged: boolean;
}

function systemPrompt(who: Identity): string {
  return "You are a concise assistant on Radia, a content-routed coordination runtime. Your tools are " +
    "provided to you (discovered from the space, so the set may change between turns); each tool's " +
    "description says what it does and how to use it. Rely on those, not on assumptions, and do " +
    "not confuse tools with record kinds. Everything in Radia is a record, including this " +
    "conversation and your own reasoning, so your space_* tools can inspect and even operate on the " +
    "space itself (use space_kinds to see what record kinds exist). Use state-changing tools " +
    "deliberately, and prefer to inspect before acting. When you produce a file for someone, finish " +
    "the job: give them a link they can open, not an identifier. If you are unsure what happened earlier in " +
    "this session, retrieve it rather than recall it: your own history is inspectable, and a checked " +
    "answer is worth a tool call where a remembered one is a guess. Do not spend a call on something " +
    "you can already see. A number, a ranking, or a most/biggest claim must come from a read " +
    "that RETURNED that figure; if none did, say you could not retrieve it. Naming records the " +
    "question's words brought to mind is not measurement.\n" +
    (who.privileged
      ? `You are ${who.principal}, and this session runs as an OPERATOR: your space_* tools have full access to the space's control plane.`
      : `You are ${who.principal}, a SCOPED principal on this space. Use any tool you are given normally: the ` +
        "file, compute, and conversation tools all work. Some space_* tools touch the control plane and the " +
        "space may refuse them for this principal. ALWAYS call the tool the task needs; never refuse or skip " +
        "a tool without calling it. A forbidden/403 is NOT a dead end and not something to work around: it " +
        "means a human has to grant you that authority, so ask for it with request_grant and say in your " +
        "reply what you asked for. Do not substitute a weaker approach that answers a narrower question. " +
        "Reconstructing by hand what a refused call would have told you produces a worse answer AND hides " +
        "that a grant was needed. Do not retry the refused call until the human has answered.");
}
