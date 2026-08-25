// An LLM turn as a chain of records, so the loop is not a `for` in somebody's process.
//
// A conversation already IS a chain: a user message asks, a model answers, an answer may ask for
// tools, tool replies feed the next round. The loop is nobody performing two of those links. This
// worker performs them, and killing the client kills nothing — the turn finishes, `radia flows` can
// mine its shape, and two clients can watch one conversation. Design: agent_docs/plan-chat-turn.md.
//
// WATCHED, NOT CLAIMED. Transcript records are facts (`claimable:false`), so this reacts to them
// rather than taking them, like `examples/pipeline/aggregator.ts`. Exactly-once comes from an
// idempotency key derived from the TRIGGER (`turn:<messageId>`), which works across restarts
// because keys scope to the agent behind a run (audit Package U), not to the run.
//
// THE CLIENT SEEDS, deliberately. The first `llm_call` carries the session's tool list, which is
// session state (a scoped view of what is advertised, plus whatever that conversation saved), so no
// worker can invent it. Later rounds copy it from the conversation's newest seed-shaped call.
//
// EVERY HOP CARRIES WHAT THE NEXT ONE NEEDS (`i`, `of`, `round`, `turnAt`) and records are addressed
// by IDENTITY, never by a predicted position. Both are load-bearing: a dropped field turns a round
// of eight calls into eight rounds, and a predicted slot that misses returns the WRONG record
// instead of nothing.

import type { KindDef, RadiaClient } from "../../sdk/ts/client.ts";

/** The turn's own kinds. The conversation vocabulary (`message`, `llm_call`, `tool_call`) is the
 *  app's and is passed in; these two exist only because the chain needs them. */
export const TURN_COMPLETE = "turn_complete";
export const CANCEL = "cancel";

/** The terminus, so a client has something to wait for and a mined flow has a visible end. Carries
 *  `turnAt` because a conversation holds one per turn: read per-conversation, the previous turn's
 *  marker ends every later one immediately. */
export const TURN_COMPLETE_KIND: KindDef = {
  kind: TURN_COMPLETE,
  indexedPaths: [
    { path: "conversationId", type: "keyword" },
    { path: "owner", type: "keyword" },
    { path: "turnAt", type: "integer" },
  ],
  claimable: false,
  defaultRetentionSeconds: 7 * 24 * 3600,
};

/** A person's Escape, as a fact the worker can read. Keyed to a TURN for the same reason. */
export const CANCEL_KIND: KindDef = {
  kind: CANCEL,
  indexedPaths: [
    { path: "conversationId", type: "keyword" },
    { path: "owner", type: "keyword" },
    { path: "turnAt", type: "integer" },
  ],
  claimable: false,
  defaultRetentionSeconds: 7 * 24 * 3600,
};

/** The app's conversation vocabulary. Defaults are the conventional names. */
export interface TurnKinds {
  message: string;
  llmCall: string;
  toolCall: string;
}

const DEFAULT_KINDS: TurnKinds = { message: "message", llmCall: "llm_call", toolCall: "tool_call" };

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** A transcript record, in the fields the chain routes on. */
export interface TurnMessage {
  conversationId?: string;
  owner?: string;
  index?: number;
  role?: string;
  tool_calls?: ToolCall[];
  /** The encryption marker, READ but never opened here: it says the tool arguments below are
   *  ciphertext to be copied onward, which is what lets this worker route an encrypted conversation
   *  without a key (plan-encryption.md). */
  enc?: string;
  /** Which call of which round, carried so the next reaction addresses by identity. */
  i?: number;
  of?: number;
  round?: number;
  turnAt?: number;
}

export interface TurnOptions {
  /** Rounds before the turn is stopped. The bound travels with the work rather than living in a
   *  client that can die still holding it. */
  maxRounds?: number;
  /** How many of the newest messages a sweep looks at. A bound, not a population: only the head of
   *  each conversation is a candidate. */
  sweep?: number;
  kinds?: Partial<TurnKinds>;
  /** Emit each `tool_call` under a run DELEGATED for the conversation's owner, so the worker that
   *  claims it can resolve who it is acting for. Needs a space whose tool workers hold delegable
   *  grants; without them the extra mint buys nothing. See agent_docs/plan-delegation.md. */
  delegate?: boolean;
  /** Where a per-conversation failure is reported. One bad turn must not stop the worker. */
  log?: (message: string) => void;
}

/**
 * Escape control characters that appear raw INSIDE a string literal.
 *
 * The lexical error long tool arguments actually make: a model escapes newlines correctly for
 * thousands of characters, then emits them raw, which JSON forbids (RFC 8259 §7). Seen on a live
 * 16 KB `edit_workspace` call that switched at offset 6995 and cost the turn its round budget.
 * Unambiguous to repair: a raw control character is never valid inside a string, and outside one it
 * is only whitespace, so it is left alone.
 */
function escapeRawControls(raw: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString && ch === "\\") { // an escape pair is copied whole, so `\"` cannot end the string
      out += ch + (raw[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (!inString || code >= 0x20) {
      out += ch;
      continue;
    }
    out += code === 0x0a ? "\\n" : code === 0x09 ? "\\t" : code === 0x0d ? "\\r" : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/**
 * A model's `arguments` string as an object, repaired where the repair is unambiguous.
 *
 * When it cannot parse, the REASON travels with the raw text. Without it every tool reports whatever
 * required field it misses first, so a call whose 16 KB body was malformed was refused with
 * "needs a `workspace`" for a workspace it did send, and the model retried the same doomed payload.
 * `serveTools` (./tool-worker.ts) turns `_parseError` into the refusal.
 */
export function parseArgs(raw: string): Record<string, unknown> {
  const attempt = (text: string) => {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  };
  try {
    return attempt(raw);
  } catch (e) {
    try {
      return attempt(escapeRawControls(raw));
    } catch {
      return { _unparsed: raw, _parseError: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * The tool half of the chain: turn a worker's `tool_result` into the transcript reply when the call
 * carried a TURN SLOT, and leave it alone when it did not.
 *
 * A call carrying `tool_call_id` + `replyIndex` is a conversation link, so its answer belongs in the
 * transcript and is written as the worker's ack — inside the fence, so a reclaimed worker's reply is
 * never written twice. A BARE call (a harness, an RPC) has no slot and keeps `tool_result`.
 *
 * Wrap a worker's `handle` with this rather than branching at each result site: the shape is a
 * property of the CALL, not of the result.
 */
// deno-lint-ignore no-explicit-any
export function asTurnReply(rec: { body: unknown }, result: any, kinds: Partial<TurnKinds> = {}) {
  const k = { ...DEFAULT_KINDS, ...kinds };
  const slot = rec.body as {
    tool_call_id?: string;
    replyIndex?: number;
    i?: number;
    of?: number;
    round?: number;
    turnAt?: number;
  };
  if (result?.kind !== "tool_result") return result;
  if (typeof slot.tool_call_id !== "string" || typeof slot.replyIndex !== "number") return result;
  const b = result.body as { callId?: string; conversationId?: string; owner?: string; ok?: boolean; output?: unknown };
  return {
    ...result,
    kind: k.message,
    body: {
      conversationId: b.conversationId,
      owner: b.owner,
      index: slot.replyIndex,
      role: "tool",
      tool_call_id: slot.tool_call_id,
      ...(typeof slot.i === "number" ? { i: slot.i } : {}),
      ...(typeof slot.of === "number" ? { of: slot.of } : {}),
      ...(typeof slot.round === "number" ? { round: slot.round } : {}),
      ...(typeof slot.turnAt === "number" ? { turnAt: slot.turnAt } : {}),
      callId: b.callId,
      ok: b.ok,
      // Exactly the string a client would have appended, so the provider sees the transcript it
      // always did. `?? "null"` because JSON.stringify(undefined) is not a string.
      content: JSON.stringify(b.ok ? b.output : { error: b.output }) ?? "null",
    },
  };
}

/**
 * Watch a space's transcript and advance every live turn on it. Runs until `signal` aborts.
 *
 * Reconciles BEFORE watching: a message that landed while this was down would otherwise wait for the
 * next one, and "kill it mid-turn and the turn still finishes" is the whole claim.
 */
export async function runTurnWorker(
  client: RadiaClient,
  opts: TurnOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const k = { ...DEFAULT_KINDS, ...opts.kinds };
  const maxRounds = opts.maxRounds ?? 8;
  const sweepSize = opts.sweep ?? 50;
  const log = opts.log ?? ((m: string) => console.error(m));
  const CLOCK_MS = 5000; // the DB clock, cached: the comparison below must not use this process's

  let clockAt = 0, clock = "";
  const dbNow = async (): Promise<string> => {
    if (Date.now() - clockAt > CLOCK_MS) {
      clock = (await client.health()).now;
      clockAt = Date.now();
    }
    return clock;
  };

  /**
   * The conversation's current call: the tool list to carry forward, and the DEADLINE that says
   * whether the turn is still worth advancing.
   *
   * A deadline and not an age. Reconciling on boot is what lets an interrupted turn finish and is
   * also how a worker resumes a conversation from months ago; an age cutoff guesses in both
   * directions, because a clock cannot tell an abandoned turn from a slow one (a grant request
   * legitimately waits minutes on a person). `deadline_at` is the runtime's field for it,
   * client-submitted because the one WAITING knows how long the work stays worth doing. A call with
   * NO deadline is never resumed, which is every record written before turns carried one.
   *
   * Reads the SEED-shaped calls only (no `tier`): those are the ones the turn's owner writes and the
   * ones carrying the deadline. A router re-dispatching by spreading the body drops it, since
   * `deadlineAt` is a record field rather than a body one.
   */
  const currentCall = async (conversationId: string) => {
    const rows = await client.queryNewest({ kind: k.llmCall, match: { conversationId, tier: { $exists: false } } }, 1);
    const body = rows[0]?.body as { tools?: unknown[]; turnAt?: number } | undefined;
    return { tools: body?.tools ?? [], turnAt: body?.turnAt, deadlineAt: rows[0]?.deadlineAt, seedId: rows[0]?.id };
  };

  /**
   * The client to emit a `tool_call` with: a DELEGATED run bounded by the person whose turn this
   * is, so the worker that claims the call can resolve them (agent_docs/plan-delegation.md).
   *
   * Minted from the SEED call, which the session itself wrote. That is the one record in a
   * conversation whose author IS the person: an assistant message is authored by the inference
   * worker (it acks it under its own lease and no other credential can), and `body.owner` is a
   * value this worker could have made up. Off unless `delegate` is set, because a space whose
   * workers hold no delegable grants gains nothing from the extra mint.
   *
   * Cached per conversation until an expiry it does not renew: a delegated credential is scoped to
   * a piece of work, and one that renewed itself indefinitely would outlive the turn.
   */
  const delegated = new Map<string, { client: RadiaClient; until: number }>();
  const callerClient = async (conversationId: string, seedId: string | undefined): Promise<RadiaClient> => {
    if (!opts.delegate || !seedId) return client;
    const hit = delegated.get(conversationId);
    if (hit && hit.until > Date.now() + 60_000) return hit.client;
    try {
      const d = await client.delegatedClient(seedId);
      delegated.set(conversationId, { client: d.client, until: Date.parse(d.expiresAt) });
      return d.client;
    } catch (e) {
      // SAID OUT LOUD, then carry on as this worker. Throwing here kills the whole turn, and a
      // conversation that stops advancing is a worse failure than a later tool call answering
      // `forbidden`: the claimant of an undelegated `tool_call` resolves the caller to THIS AGENT
      // and fails closed, which is safe and legible. A seed written by an operator hits this by
      // design, since a privileged caller has no grant set to narrow to.
      log(`turn: no delegated run for ${conversationId} (${e}); tool calls will carry this worker's reach`);
      return client;
    }
  };

  /** Emit the call for `calls[i]`, naming the slot its reply lands in.
   *
   *  `askedBy` is the assistant message that requested the call, and it is the PARENT rather than
   *  the conversation. Parenting a round to the conversation makes every round a stub hanging off
   *  one hub, so a turn has no subtree to open and nothing to mine: measured at 83 of 185 records
   *  in one live conversation naming the conversation directly. */
  const dispatch = async (
    m: TurnMessage,
    askedBy: string,
    turnAt: number | undefined,
    calls: ToolCall[],
    i: number,
    replyIndex: number,
    round: number,
    key: string,
  ) => {
    const call = calls[i];
    // Emitted under the caller's delegated run, so the record the tool worker claims names a
    // resolvable person rather than this worker.
    const as = await callerClient(m.conversationId!, (await currentCall(m.conversationId!)).seedId);
    // ENCRYPTED ARGUMENTS TRAVEL OPAQUE, and this is what keeps the turn worker key-free — the
    // property the whole design rests on (plan-encryption.md). The inference worker sealed
    // `function.arguments` when it wrote the assistant message; this copies the blob verbatim,
    // carries the marker across so the tool worker knows to open it, and parses nothing. Reading
    // the arguments here would mean the component that PERFORMS a conversation could also read it.
    const sealed = m.enc;
    await as.put({
      kind: k.toolCall,
      body: {
        tool: call.function.name,
        args: sealed ? call.function.arguments : parseArgs(call.function.arguments),
        ...(sealed ? { enc: sealed } : {}),
        conversationId: m.conversationId,
        owner: m.owner,
        tool_call_id: call.id, // the slot: this call's answer IS the transcript reply
        replyIndex,
        i,
        of: calls.length,
        round,
        turnAt,
      },
      parentIds: [askedBy],
    }, key);
  };

  /** One reaction, keyed on the TRIGGER so reacting twice replays instead of doubling. */
  const advance = async (id: string, m: TurnMessage): Promise<void> => {
    if (!m.conversationId) return; // an inline call's answer belongs to no conversation
    const key = `turn:${id}`;
    const round = m.round ?? 0;
    // Every link below parents to the record that CAUSED it (`id`), never to the conversation, so
    // the turn is one subtree and `?direction=down` from its head is exactly this turn.
    const done = async (why: string) =>
      await client.put({
        kind: TURN_COMPLETE,
        body: {
          conversationId: m.conversationId,
          owner: m.owner,
          upToIndex: m.index,
          turnAt: (await currentCall(m.conversationId!)).turnAt,
          why,
        },
        parentIds: [id],
      }, key);

    if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      if (calls.length === 0) return void await done("answered");
      if (round >= maxRounds) return void await done("round_cap");
      // Replies occupy one slot each after the assistant message, so every slot in the round is
      // known here and no writer coordinates on a counter.
      return await dispatch(m, id, m.turnAt, calls, 0, (m.index ?? 0) + 1, round, key);
    }

    if (m.role === "tool") {
      const i = m.i ?? 0, of = m.of ?? 1;
      if (i + 1 < of) {
        // The assistant message this reply belongs to, BY IDENTITY: which turn, which round.
        const assistant = await client.readOne({
          kind: k.message,
          match: { conversationId: m.conversationId, turnAt: m.turnAt, round, role: "assistant" },
        });
        const calls = (assistant?.body as TurnMessage | undefined)?.tool_calls ?? [];
        // Unreadable or disagreeing: stall visibly rather than dispatch a call nobody asked for.
        if (calls.length <= i + 1) return;
        // Parented to the assistant message, not to the sibling reply that woke this: a round reads
        // as one fan of calls, which is what was asked for, rather than a staircase.
        return await dispatch(m, assistant!.id, m.turnAt, calls, i + 1, (m.index ?? 0) + 1, round, key);
      }
      if (round + 1 >= maxRounds) return void await done("round_cap");
      const call = await currentCall(m.conversationId);
      return void await client.put({
        kind: k.llmCall,
        body: {
          conversationId: m.conversationId,
          owner: m.owner,
          upToIndex: m.index,
          round: round + 1,
          turnAt: call.turnAt,
          tools: call.tools,
        },
        // The turn's deadline travels with it: the same turn, worth what the client said it was.
        ...(call.deadlineAt ? { deadlineAt: call.deadlineAt } : {}),
        parentIds: [id],
      }, key);
    }
  };

  // A CACHE, not the correctness argument: the idempotency key is. Without it a sweep replays every
  // write on every wakeup, which is correct and wasteful. In-process, so a restart re-reacts.
  const seen = new Set<string>();

  const sweep = async (): Promise<void> => {
    const rows = await client.queryNewest({ kind: k.message }, sweepSize);
    const now = await dbNow();
    // ONLY THE HEAD of each conversation. Anything older has been answered already, and a turn is
    // live only at its head. Without this a boot reconcile walks history and re-dispatches dead
    // turns' tool calls, starving the live one.
    const head = new Set<string>();
    for (const rec of rows) {
      const conv = (rec.body as TurnMessage).conversationId;
      if (!conv || head.has(conv)) continue;
      head.add(conv);
      // NOBODY IS WAITING, for either of the two reasons there are: the deadline passed (or never
      // existed), or the person cancelled. Both mark the head seen so a later sweep skips it.
      const { deadlineAt, turnAt } = await currentCall(conv);
      if (!deadlineAt || deadlineAt <= now) {
        seen.add(rec.id);
        continue;
      }
      if (turnAt !== undefined && await client.readOne({ kind: CANCEL, match: { conversationId: conv, turnAt } })) {
        seen.add(rec.id);
        continue;
      }
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      try {
        await advance(rec.id, rec.body as TurnMessage);
      } catch (e) {
        log(`[turn] ${rec.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  await sweep();
  const stop = opts.signal ?? new AbortController().signal;
  // SUPERVISED, because a watch does not last as long as a worker does. It is revoked when the run
  // behind it ends (a run lasts fifteen minutes; the SDK mints another for ordinary calls, but the
  // stream opened under the old one dies), and this loop is the whole worker: an unhandled throw
  // here stopped every conversation on the space, with one stack trace as the only sign. A sweep
  // runs on the way round, so a re-established watch never strands a message that landed in the gap.
  while (!stop.aborted) {
    try {
      for await (const _ of client.watch({ kind: k.message }, stop)) await sweep();
      return; // the generator ended: the signal aborted, which is a clean stop
    } catch (e) {
      if (stop.aborted) return;
      log(`[turn] watch dropped (${e instanceof Error ? e.message : e}); re-watching`);
      await new Promise((r) => setTimeout(r, 1000));
      await sweep();
    }
  }
}
