// The turn worker: the conversation's loop, as matching (agent_docs/plan-chat-turn.md step 3).
//
// The chat's `for (round…)` lived in the REPL, which is why killing the terminal killed the turn
// and why `radia flows` could not mine the flagship flow: the control flow sat in a process the
// substrate cannot see. It is not moved here. It is DELETED, and four reactions to existing facts
// replace it. There is no turn record and no phase, because "what happens next" is derivable from
// the newest message: an assistant message asking for tools needs its first tool run, a tool reply
// needs either the next tool or another round, and an assistant message asking for nothing ends it.
//
// KEYED, NOT CLAIMED. Messages are facts (`claimable:false`), so this WATCHES rather than takes,
// exactly like `examples/pipeline/aggregator.ts`. Exactly-once comes from an idempotency key
// derived from the TRIGGER (`turn:<messageId>`), which is why audit Package U had to land first:
// keys were scoped to a `run:*` principal, so a restart re-minted and the key deduped nothing.
// A restarted worker, or a second one, now emits the same record once instead of twice.
//
// THE CLIENT SEEDS A CHAIN, deliberately. The first `llm_call` carries the session's tool list, and
// that list is session state (a scoped view, plus conversation-scoped procedures), so no worker can
// invent it. Later rounds copy it from the conversation's newest `llm_call`: one bounded read of an
// indexed path, never `getRecord`, which is ops-plane and no scoped worker holds.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { arg } from "../util.ts";

const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token");
/** The bound that used to be a loop counter in a process that could die still holding it. */
const MAX_ROUNDS = Number(arg("--max-rounds") ?? "8");
/** How far back a sweep looks. A bound, not a population: `seen` means only new messages are acted
 *  on, and only the head of each conversation is a candidate anyway. */
const SWEEP = 50;
/**
 * How long the DB clock is cached between reactions. The comparison below must use the space's
 * clock, not this process's, and re-asking on every message would be a round trip per message.
 */
const CLOCK_MS = 5000;

const client = new RadiaClient(url, token ? { definitionToken: token } : {});

interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** A `message` body, in the fields this worker routes on. */
interface Msg {
  conversationId?: string;
  owner?: string;
  index?: number;
  role?: string;
  tool_calls?: ToolCall[];
  /** Slot bookkeeping a tool reply carries forward, stamped by whoever emitted the call. */
  i?: number;
  of?: number;
  round?: number;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  } catch {
    // A model can emit unparseable arguments, and the tool worker refuses far more usefully than a
    // crash here would: pass it on, and the refusal reaches the transcript as an ordinary reply.
    return { _unparsed: raw };
  }
}

/**
 * The conversation's current call: the tool list to carry forward, and the DEADLINE that says
 * whether the turn is still worth advancing.
 *
 * WHY A DEADLINE AND NOT AN AGE. Reconciling on boot is what lets an interrupted turn finish, and it
 * is also how a worker resumes a conversation from months ago: on a real space it dispatched 47
 * stale tool calls into two dead threads and starved the live turn. An age cutoff was the first fix
 * and it is a guess in both directions, because a clock cannot tell an abandoned turn from a slow
 * one: a `request_grant` waits five minutes on a person by design. `deadline_at` is the substrate's
 * field for exactly this, client-submitted because the one WAITING is the one who knows how long the
 * work stays worth doing. So a turn is live while its call's deadline is in the future, and a call
 * with NO deadline is never resumed, which is every record written before this existed.
 */
async function currentCall(conversationId: string): Promise<{ tools: unknown[]; deadlineAt?: string; turnAt?: number }> {
  // UNTIERED only: those are the calls the turn's owner writes (the client's seed, and the rounds
  // this worker emits), and they are the ones carrying the deadline. The router re-dispatches a
  // TIERED copy by spreading the body, and `deadlineAt` is a record field rather than a body one,
  // so the copy drops it. Reading the original means no derivative re-emitter has to remember.
  const rows = await client.query(
    { kind: "llm_call", match: { conversationId, tier: { $exists: false } } },
    1,
    { dir: "desc" },
  );
  const body = rows[0]?.body as { tools?: unknown[]; turnAt?: number } | undefined;
  return { tools: body?.tools ?? [], turnAt: body?.turnAt, deadlineAt: rows[0]?.deadlineAt };
}

let clockAt = 0, clock = "";
async function dbNow(): Promise<string> {
  if (Date.now() - clockAt > CLOCK_MS) {
    clock = (await client.health()).now;
    clockAt = Date.now();
  }
  return clock;
}

/** Emit the call for `calls[i]`, naming the slot its reply lands in. */
async function dispatch(m: Msg, assistantId: string, calls: ToolCall[], i: number, replyIndex: number, round: number, key: string) {
  const call = calls[i];
  await client.put({
    kind: "tool_call",
    body: {
      tool: call.function.name,
      args: parseArgs(call.function.arguments),
      conversationId: m.conversationId,
      owner: m.owner,
      // The turn slot (2b): a call carrying it is answered with the tool `message` itself, written
      // inside the tool worker's ack fence.
      tool_call_id: call.id,
      replyIndex,
      // The chain's bookkeeping, carried so the next reaction needs no scan.
      i,
      of: calls.length,
      round,
    },
    parentIds: [assistantId],
  }, key);
}

/**
 * One reaction, a pure function of the message and what the message carries.
 *
 * Every write is keyed on the TRIGGER's id, so reacting twice to one message (a restart, a
 * re-swept record, a second worker) replays the write instead of doubling it.
 */
async function advance(id: string, m: Msg): Promise<void> {
  if (!m.conversationId) return; // an inline call's answer belongs to no conversation
  const key = `turn:${id}`;
  const round = m.round ?? 0;
  const done = async (why: string) =>
    await client.put({
      kind: "turn_complete",
      // WHICH turn ended, not just which conversation: the client waits on this to know its own
      // turn is over, and a conversation holds one per turn.
      body: { conversationId: m.conversationId, owner: m.owner, upToIndex: m.index, turnAt: (await currentCall(m.conversationId!)).turnAt, why },
      parentIds: [m.conversationId!],
    }, key);

  if (m.role === "assistant") {
    const calls = m.tool_calls ?? [];
    if (calls.length === 0) return void await done("answered");
    if (round >= MAX_ROUNDS) return void await done("round_cap");
    // Replies occupy one slot each, immediately after the assistant message, so every slot in the
    // round is known here and no writer has to coordinate on a counter.
    return await dispatch(m, id, calls, 0, (m.index ?? 0) + 1, round, key);
  }

  if (m.role === "tool") {
    const i = m.i ?? 0, of = m.of ?? 1;
    if (i + 1 < of) {
      // The assistant message sits one slot before the round's first reply, and this reply is the
      // i-th of them: the arithmetic is sound because `dispatch` assigned those slots.
      const assistant = await client.readOne({
        kind: "message",
        match: { conversationId: m.conversationId, index: (m.index ?? 0) - 1 - i },
      });
      const calls = (assistant?.body as Msg | undefined)?.tool_calls ?? [];
      // Unreadable or disagreeing: stop rather than guess. The turn stalls visibly instead of
      // dispatching a call the assistant never asked for.
      if (calls.length <= i + 1) return;
      return await dispatch(m, assistant!.id, calls, i + 1, (m.index ?? 0) + 1, round, key);
    }
    if (round + 1 >= MAX_ROUNDS) return void await done("round_cap");
    // The round's last reply: back to the model, one round deeper.
    const call = await currentCall(m.conversationId);
    return void await client.put({
      kind: "llm_call",
      body: {
        conversationId: m.conversationId,
        owner: m.owner,
        upToIndex: m.index,
        round: round + 1,
        turnAt: call.turnAt,
        tools: call.tools,
      },
      // The turn's deadline travels with it: the round the worker emits is the same turn, still
      // worth exactly as long as the client said when it seeded.
      ...(call.deadlineAt ? { deadlineAt: call.deadlineAt } : {}),
      parentIds: [m.conversationId],
    }, key);
  }
}

/**
 * Sweep the newest messages and react to the ones not yet handled.
 *
 * `seen` is a CACHE, not the correctness argument: the idempotency key is. Without it a sweep would
 * replay every write on every wakeup, which is correct and wasteful; with it a wakeup costs one
 * query. It is deliberately in-process, so a restart re-reacts and the keys absorb it.
 */
const seen = new Set<string>();
async function sweep(): Promise<void> {
  const rows = await client.query({ kind: "message" }, SWEEP, { dir: "desc" });
  // NEWEST FIRST, and only the newest message of each conversation is acted on. Anything older has
  // already been answered, by this worker or by whoever ran that turn, and a turn is live only at
  // its head. Learned the hard way on a real space: the boot reconcile walked 50 messages oldest
  // first and REANIMATED DEAD TURNS, dispatching 33 stale tool calls into one old conversation and
  // 14 into another. The live turn then queued behind them and timed out. A fresh test space cannot
  // show this, because it has no history to resurrect.
  const now = await dbNow();
  const head = new Set<string>();
  for (const rec of rows) {
    const conv = (rec.body as Msg).conversationId;
    if (!conv || head.has(conv)) continue;
    head.add(conv);
    // NOBODY IS WAITING, for either of the two reasons there are. The deadline has passed (or never
    // existed, which is every conversation written before turns carried one), or the person pressed
    // Escape and said so in a record. Both are the same question asked at the same gate, and both
    // mark the head seen so a later sweep does not reconsider it.
    const { deadlineAt, turnAt } = await currentCall(conv);
    if (!deadlineAt || deadlineAt <= now) {
      seen.add(rec.id);
      continue;
    }
    // Per TURN. A conversation-wide cancel would silence every turn after the first, the same trap
    // the terminus fell into.
    if (turnAt !== undefined && await client.readOne({ kind: "cancel", match: { conversationId: conv, turnAt } })) {
      seen.add(rec.id);
      continue;
    }
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    try {
      await advance(rec.id, rec.body as Msg);
    } catch (e) {
      // Never fatal: one malformed turn must not stop the worker for every other conversation.
      console.error(`[turn] ${rec.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

console.error(`[turn] watching messages on ${url} (max ${MAX_ROUNDS} rounds)`);
// Reconcile BEFORE watching. A message that landed while this worker was down would otherwise wait
// for the next one, and "kill it mid-turn and the turn still finishes" is the whole claim.
await sweep();
const stop = new AbortController();
for await (const _ of client.watch({ kind: "message" }, stop.signal)) await sweep();
