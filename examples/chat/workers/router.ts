// Router-worker: model selection delegated to the substrate. The chat puts an UNTIERED `llm_call`
// (no routing logic in the client); this worker claims those (`{tier: {$exists:false}}`), classifies
// the turn, and re-dispatches a TIERED `llm_call` that the matching inference-worker serves. The
// result stays keyed to the ORIGINAL call the chat awaits (`replyTo`), so the chat is oblivious to
// the indirection.
//
// Classification is itself an `llm_call`: the router puts a cheap, model-overridden call
// (`--classify-model`) that an inference-worker serves, then reads the tier word back. The API
// key therefore stays isolated in the inference fleet, and routing is expressed through the
// substrate rather than a direct model call here.
//
// WHY A CLASSIFIER, given that escalation exists. This was removed once, on the argument that
// dispatching to the cheapest tier and letting a worker escalate when out of depth pays for routing
// only on the turns that were misrouted. That argument assumes the cheap model can RECOGNIZE it is
// out of depth. Measured on real traffic it does not: across a tool-heavy analytical session the
// cheap tier escalated on nothing and answered from invented numbers instead. Self-assessment is
// the weakest available judge, so the judgment is made by a different model, at a cost of ~0.5-1.2s
// added before the first token. Escalation stays as the catch for what the classifier under-routes; two
// mechanisms for one decision is a deliberate trade here, not an oversight.
//
// Tier NAMES never appear in this file. Live tiers come from `model` records ordered by `rank`, and
// routing tries four things in order:
//
//   1. what the USER asked for   a tier named in the message ("retry deep") wins outright
//   2. what the turn INHERITS    a bare "continue" keeps the previous turn's tier
//   3. what the classifier says  a cheap model judging the question
//   4. POSITION in the list      cheapest / middle / second-most capable, when 3 could not answer
//
// Adding a tier-worker changes all four with no code change here. The TOP tier is reachable only by
// being asked for, inherited, or chosen: nothing positional selects it, because the fallback is the
// weakest judge and that tier is the priciest.

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { liveModels } from "../../../extensions/ts/model.ts";
import { progress } from "../../../extensions/ts/progress.ts";
import { arg, sleep } from "../util.ts";
import type { ChatMessage } from "../provider/openrouter.ts";

const ME = "agent:chat-router";

const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-router run token
const classifyModel = arg("--classify-model") ?? Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";
const client = new RadiaClient(url, token ? { definitionToken: token } : {});

/** The live tiers, cheapest → most capable, discovered from what the fleet advertises. Only tiers
 *  that serve TEXT are routing candidates: the fleet also advertises image models (`modalities:
 *  ["image"]`), and a conversation turn dispatched to one would never come back. A record with no
 *  `modalities` is text, so this stays backward compatible with workers that predate the field. */
async function liveTiers(c: RadiaClient): Promise<string[]> {
  // `liveModels` (space/model.ts) is the projection: latest-wins, minus retirements, text only,
  // weakest first. Shared with the escalation ladder so the two cannot disagree about which tiers
  // exist — they did, and escalating to a gracefully stopped tier hung until the deadline.
  return [...new Set((await liveModels(c)).map((m) => m.tier))];
}

/**
 * An explicit request for a tier, honoured ahead of any judgment.
 *
 * "retry deep" is an instruction, not a routing question, and the classifier answered `fast` to it
 * on every round of a live turn. The client cannot own this — a `/tier` command is the anti-pattern
 * the design principle names — so it is decided here, from the LIVE tier list, which is why this
 * file still hardcodes no tier name.
 *
 * A CUE word is required alongside the tier word, or "explain deep learning" routes itself. The
 * LAST tier mentioned wins, so "switch from fast to deep" means deep.
 */
export function explicitTier(text: string, tiers: string[]): string | null {
  // Cues are deliberately VERBS. `with`, `on` and `in` were in this list and are ordinary
  // prepositions: "a deep dive in the code" would have routed itself to the second-priciest model.
  if (!/\b(use|using|retry|redo|re-?run|rerun|switch|try|again)\b/i.test(text)) return null;
  let best: { tier: string; at: number } | null = null;
  for (const tier of tiers) {
    const m = new RegExp(`\\b${tier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi").exec(text);
    if (m && (!best || m.index > best.at)) best = { tier, at: m.index };
  }
  return best?.tier ?? null;
}

/**
 * Is this message only an instruction to CARRY ON?
 *
 * The whole message must be one, punctuation aside. "continue the analysis of X" carries its own
 * content and is classified normally; bare "continue" carries none, and that is the point — its
 * difficulty belongs to the turn before it.
 */
export function isContinuation(text: string): boolean {
  return /^\s*(continue|carry on|go on|keep going|keep at it|proceed|resume|retry|try again|again|redo|re-?run|more|next|finish( it)?|fix (it|that))\b[\s.!]*$/i
    .test(text);
}

/**
 * The tier the PREVIOUS turn ran on, which a bare continuation inherits.
 *
 * Classifying "continue" on its own text drops a hard turn to the cheapest model mid-flight: eight
 * characters read as small talk however difficult the work is. Reported from live use — with a
 * capable model on the middle tier, "continue" and "retry" worked, because nothing had to
 * understand them; the routing was simply never the part that did.
 *
 * Only LIVE tiers are returned, so a continuation cannot inherit a tier whose worker has gone.
 */
export async function previousTurnTier(
  c: RadiaClient,
  body: { conversationId?: string; turnAt?: number },
  tiers: string[],
): Promise<string | null> {
  if (!body.conversationId) return null;
  const rows = await c.query(
    { kind: "llm_call", match: { conversationId: body.conversationId, tier: { $exists: true } } },
    30,
    { dir: "desc" },
  );
  for (const r of rows) {
    const b = r.body as { tier?: string; turnAt?: number };
    // STRICTLY EARLIER, not merely "not this turn". Skipping only the current turn also accepts a
    // LATER one, which no live call can produce but which made "the first turn inherits nothing"
    // return a tier — so the rule was looser than its name and nothing but the test said so.
    if (body.turnAt !== undefined && !(typeof b.turnAt === "number" && b.turnAt < body.turnAt)) continue;
    if (b.tier && tiers.includes(b.tier)) return b.tier;
  }
  return null;
}

/** Fallback for a classifier error/timeout: choose by POSITION in the discovered list, so a renamed
 *  or added tier still routes. Hard/analytical → second-most capable, small talk → cheapest, else
 *  middle. An UNKNOWN question is never scored as small talk: a zero-length string used to look
 *  like "hi" and route the hardest round of a turn to the cheapest model. */
export function heuristicIndex(text: string, n: number, toolCalls: number): number {
  // The hard band aims at the SECOND-most capable tier, never the top one. This runs only when the
  // classifier failed, and a keyword regex is the weakest judge in the system: the most expensive
  // model should be chosen deliberately, not by a fallback that fires on a backtick. Under-routing
  // here is recoverable — a worker out of its depth calls `escalate` — and over-routing is not.
  const hard = Math.max(0, n - 2);
  const t = text.toLowerCase();
  if (!text.trim()) return toolCalls > 0 ? hard : Math.floor((n - 1) / 2);
  if (
    /```|traceback|stack trace|refactor|architect|analy[sz]|prove|derive|debug|optimi|percent|aggregate|how many|design (a|the)/.test(t) ||
    text.length > 400 ||
    toolCalls >= 3 // a synthesis round after this much tool work is not the turn the question looked like
  ) return hard;
  // Ranking words keep a SHORT question out of the small-talk band: "which call used most tokens"
  // is 27 characters and reads as a lookup, but answering it means composing ranked queries, which
  // the cheapest tier reliably fabricates instead of doing.
  if (text.length <= 40 && !/\b(code|explain|compare|design|plan|why|count|list|most|fewest|biggest|largest|total|average|rank|top)\b/.test(t)) return 0;
  return Math.floor((n - 1) / 2);
}

/** The turn being routed: the newest `user` message, and how much tool work has happened since it.
 *  Expands the read until that message is in view. A tool-heavy round pushes it far back, and a
 *  fixed peek at the newest messages silently classifies an EMPTY question. Every round of a turn
 *  is a separate llm_call and is classified independently, so this runs per round. */
async function currentTurn(
  c: RadiaClient,
  conversationId: string | undefined,
  upToIndex: number,
): Promise<{ text: string; toolCalls: number }> {
  let limit = 8;
  for (;;) {
    const rows = (await c.query(
      {
        kind: "message",
        match: { conversationId, index: { $lte: upToIndex } },
        orderBy: [{ path: "index", dir: "desc" }],
      },
      limit,
    )).map((r) => r.body as { index: number; role: string; content?: string | null });
    const at = rows.findIndex((m) => m.role === "user"); // rows are newest-first
    if (at >= 0) {
      return { text: rows[at].content ?? "", toolCalls: rows.slice(0, at).filter((m) => m.role === "tool").length };
    }
    const atThreadStart = rows.length === 0 || rows[rows.length - 1].index <= 1;
    if (atThreadStart || limit >= 200) {
      return { text: "", toolCalls: rows.filter((m) => m.role === "tool").length };
    }
    limit = Math.min(limit * 4, 200);
  }
}

/** Ask a cheap model which tier this turn needs. Returns a LIVE tier, or null on timeout/parse
 *  failure so the caller falls back. The call is `stream:false` (no chunk records for a routing
 *  decision) and carries `model`, which overrides whichever tier-worker picks it up. */
async function classifyLLM(text: string, toolCalls: number, tiers: string[], c: RadiaClient): Promise<string | null> {
  if (!text.trim() || tiers.length === 0) return null;
  const live = new Set(tiers);
  // The bands are POSITIONAL, so this scales with however many tiers the fleet advertises and still
  // names none of them. It has to: with a fourth tier added, a three-band guide left "the most
  // capable" describing work the second-most capable already handles, which routes the expensive
  // one by default rather than by need.
  const system = `You are a routing classifier for an LLM chat. Choose the CHEAPEST capability tier ` +
    `that can handle the user's latest message well. Tiers, cheapest first: ${tiers.join(", ")}. ` +
    `Cost rises steeply along that list and the top tier is the most expensive by a wide margin, so ` +
    `it has to EARN the choice; when two tiers would both do, pick the cheaper. ` +
    `Reply with EXACTLY one tier word, nothing else. Guide: the cheapest tier for greetings, small ` +
    `talk, lookups, and straightforward edits; a middle tier for ordinary explanation, planning, most ` +
    `code, and anything that RANKS, COUNTS or AGGREGATES stored records (a "which X was biggest" ` +
    `question needs queries composed correctly, which is not a lookup); the SECOND-MOST capable tier ` +
    `for genuinely hard reasoning, subtle debugging, proofs, ` +
    `or design with real trade-offs; the most capable tier ONLY when a turn is harder still — the ` +
    `rare problem where a strong model would plausibly get it wrong.`;
  // Reading tool results is NORMAL work, so this says what happened and not that it was hard.
  // Measured: with the old wording ("must now interpret the results. Weigh that, not just the
  // wording") the tier went 14% deep on a turn's first round and 72% on every round after it, since
  // the user's text is identical each round and the tool count was the only thing changing.
  const context = toolCalls > 0
    ? `\n\n(Context: ${toolCalls} tool result${toolCalls === 1 ? " is" : "s are"} already available to ` +
      `read. Judge the QUESTION; having tool output to summarise does not by itself make a turn hard.)`
    : "";
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: text + context }];
  // temperature 0: the same question must not land on different tiers across rounds of one turn.
  const { id } = await c.put({
    kind: "llm_call",
    body: { tier: tiers[0], model: classifyModel, messages, tools: [], stream: false, temperature: 0 },
  });
  for (let i = 0; i < 60; i++) { // ~6s budget, then the heuristic
    const result = await c.readOne({ kind: "llm_result", match: { callId: id } });
    if (result) {
      const content = ((result.body as { message?: { content?: string } }).message?.content) ?? "";
      for (const w of content.toLowerCase().match(/[a-z]+/g) ?? []) if (live.has(w)) return w;
      return null; // answered but unparseable → heuristic
    }
    await sleep(100);
  }
  return null; // timed out
}

/**
 * A later round may climb ONE step above where the turn started, and no further.
 *
 * Routing per round is deliberate: a round that synthesises a dozen tool results can be harder than
 * the question looked. But the question's text is IDENTICAL on every round, so the tool count is the
 * only input that changes, and any prompt that treats tool work as difficulty becomes a ratchet.
 * Measured before this bound: 14% of first rounds went to the top tier and 72% of every round after,
 * with most of a turn's calls being later rounds.
 *
 * The bound is on the TURN's opening choice, read from the round-0 call the client seeded, so a hard
 * question still starts high and a simple one cannot drift to the top by making tool calls.
 */
async function capToTurn(
  c: RadiaClient,
  body: { conversationId?: string; turnAt?: number; round?: number },
  tiers: string[],
  chosen: string,
): Promise<string> {
  if (!body.conversationId || !body.round || body.turnAt === undefined) return chosen; // round 0 sets the bar
  const rows = await c.query(
    { kind: "llm_call", match: { conversationId: body.conversationId, turnAt: body.turnAt } },
    50,
  );
  const opening = rows.map((r) => (r.body as { round?: number; tier?: string }))
    .filter((b) => b.tier && (b.round ?? 0) === 0)[0]?.tier;
  if (!opening) return chosen;
  const ceiling = Math.min(tiers.indexOf(opening) + 1, tiers.length - 1);
  const want = tiers.indexOf(chosen);
  return want > ceiling ? tiers[ceiling] : chosen;
}

// Guarded so the pure helpers above can be imported and asserted. Spawning this file still runs
// the loop: the fleet launches it as the entry module.
if (import.meta.main) {
await agentLoop(client, {
  name: "router",
  patterns: [{ kind: "llm_call", match: { tier: { $exists: false } } }],
  // EVERY untiered call passes through here, and classifying one is a model round trip this
  // worker only waits on, so at 1 the router serializes the whole fleet before a tier ever sees
  // the work (agent_docs/plan-scaling.md). A flag, resolved by the launcher: see WORKER_CONCURRENCY.
  concurrency: Number(arg("--concurrency") ?? "4"),
  handle: async (rec, c) => {
    const body = rec.body as { conversationId?: string; owner?: string; upToIndex?: number; turnAt?: number; round?: number };
    // Report the claim before the classifier round-trip. It is the first sign of life the chat
    // gets, and with a classifier in the path there is now a visible gap to explain.
    //
    // `owner` IS REQUIRED, not decoration. The default session scope is by identity, so a grant
    // pattern of `{owner}` narrows away every progress record that omits it — silently, since a
    // narrowed answer is not an error. Without it the chat never saw the router at all: no routing
    // label, no liveness signal to hold off its deadline, and a timeout that blamed a missing fleet
    // for a call the router had already claimed and re-dispatched.
    await progress(c, { conversationId: body.conversationId, owner: body.owner, callId: rec.id, stage: "routing", by: ME }, [rec.id]);
    const tiers = await liveTiers(c);
    if (tiers.length === 0) throw new Error("no `model` record advertised yet");
    const { text, toolCalls } = await currentTurn(c, body.conversationId, body.upToIndex ?? 0);
    // ASKED FOR, then INHERITED, then judged, then guessed. The first two skip the classifier
    // round-trip as well, so the two cases it got wrong are now also the fastest.
    const chosen = explicitTier(text, tiers) ??
      (isContinuation(text) ? await previousTurnTier(c, { conversationId: body.conversationId, turnAt: body.turnAt }, tiers) : null) ??
      (await classifyLLM(text, toolCalls, tiers, c)) ??
      tiers[heuristicIndex(text, tiers.length, toolCalls)];
    const tier = await capToTurn(c, body, tiers, chosen);
    await progress(c, { conversationId: body.conversationId, owner: body.owner, callId: rec.id, stage: "routed", by: ME, note: `→ ${tier}` }, [rec.id]);
    return { kind: "llm_call", body: { ...body, tier, replyTo: rec.id } };
  },
});
}
