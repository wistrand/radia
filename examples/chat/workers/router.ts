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
// Tier NAMES never appear in this file. Live tiers come from `model` records ordered by `rank`, the
// classifier is asked to answer with one of those words, and the fallback picks by POSITION in that
// list (cheapest / middle / most capable). Adding a tier-worker changes routing on both paths with
// no code change here.

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { liveModels } from "../space/model.ts";
import { progress } from "../space/progress.ts";
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

/** Fallback for a classifier error/timeout: choose by POSITION in the discovered list, so a renamed
 *  or added tier still routes. Hard/analytical → most capable, small talk → cheapest, else middle.
 *  An UNKNOWN question is never scored as small talk: a zero-length string used to look like "hi"
 *  and route the hardest round of a turn to the cheapest model. */
function heuristicIndex(text: string, n: number, toolCalls: number): number {
  const t = text.toLowerCase();
  if (!text.trim()) return toolCalls > 0 ? n - 1 : Math.floor((n - 1) / 2);
  if (
    /```|traceback|stack trace|refactor|architect|analy[sz]|prove|derive|debug|optimi|percent|aggregate|how many|design (a|the)/.test(t) ||
    text.length > 400 ||
    toolCalls >= 3 // a synthesis round after this much tool work is not the turn the question looked like
  ) return n - 1;
  if (text.length <= 40 && !/\b(code|explain|compare|design|plan|why|count|list)\b/.test(t)) return 0;
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
  const system = `You are a routing classifier for an LLM chat. Choose the CHEAPEST capability tier ` +
    `that can handle the user's latest message well. Tiers, cheapest first: ${tiers.join(", ")}. ` +
    `Reply with EXACTLY one tier word, nothing else. Guide: cheapest tier for greetings/small talk/` +
    `simple lookups; a middle tier for moderate explanation or planning; the most capable tier for ` +
    `hard reasoning, analysis, math/proofs, multi-step tool work, or non-trivial code.`;
  // The turn is routed per round, so a later round must be judged on the work done so far, not on
  // the bare question: the round that synthesizes a dozen tool results is the hard one, however
  // simple the question looked.
  const context = toolCalls > 0
    ? `\n\n(The assistant has already made ${toolCalls} tool call${toolCalls === 1 ? "" : "s"} on this turn ` +
      `and must now interpret the results. Weigh that, not just the wording.)`
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

await agentLoop(client, {
  name: "router",
  patterns: [{ kind: "llm_call", match: { tier: { $exists: false } } }],
  handle: async (rec, c) => {
    const body = rec.body as { conversationId?: string; upToIndex?: number };
    // Report the claim before the classifier round-trip. It is the first sign of life the chat
    // gets, and with a classifier in the path there is now a visible gap to explain.
    await progress(c, { conversationId: body.conversationId, callId: rec.id, stage: "routing", by: ME }, [rec.id]);
    const tiers = await liveTiers(c);
    if (tiers.length === 0) throw new Error("no `model` record advertised yet");
    const { text, toolCalls } = await currentTurn(c, body.conversationId, body.upToIndex ?? 0);
    const tier = (await classifyLLM(text, toolCalls, tiers, c)) ?? tiers[heuristicIndex(text, tiers.length, toolCalls)];
    await progress(c, { conversationId: body.conversationId, callId: rec.id, stage: "routed", by: ME, note: `→ ${tier}` }, [rec.id]);
    return { kind: "llm_call", body: { ...body, tier, replyTo: rec.id } };
  },
});
