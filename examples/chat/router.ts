// Router-worker — model selection delegated to the substrate. The chat puts an UNTIERED `llm_call`
// (no routing logic in the client); this worker claims those (`{tier: {$exists:false}}`), classifies
// the turn, and re-dispatches a TIERED `llm_call` that the matching inference-worker serves. The
// result stays keyed to the ORIGINAL call the chat awaits (`replyTo`), so the chat is oblivious to
// the indirection.
//
// Classification is itself an `llm_call`: the router puts a cheap, model-overridden call
// (`--classify-model`) that an inference-worker serves, then reads the tier word back — so the API
// key stays isolated in the inference fleet and routing is expressed through the substrate, not a
// direct model call here.
//
// WHY A CLASSIFIER, given that escalation exists. This was removed once, on the argument that
// dispatching to the cheapest tier and letting a worker escalate when out of depth pays for routing
// only on the turns that were misrouted. That argument assumes the cheap model can RECOGNIZE it is
// out of depth. Measured on real traffic it does not: across a tool-heavy analytical session the
// cheap tier escalated on nothing and answered from invented numbers instead. Self-assessment is
// the weakest available judge, so the judgment is made by a different model — at ~0.5-1.2s added
// before the first token. Escalation stays as the catch for what the classifier under-routes; two
// mechanisms for one decision is a deliberate trade here, not an oversight.
//
// Tier NAMES never appear in this file. Live tiers come from `model` records ordered by `rank`, the
// classifier is asked to answer with one of those words, and the fallback picks by POSITION in that
// list (cheapest / middle / most capable). Adding a tier-worker changes routing on both paths with
// no code change here.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { progress } from "./progress.ts";
import type { ChatMessage } from "./openrouter.ts";

const ME = "agent:chat-router";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-router run token
const classifyModel = arg("--classify-model") ?? Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";
const client = new RadiaClient(url, token ? { token } : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live tiers, cheapest → most capable, discovered from what the fleet advertises. */
async function liveTiers(c: RadiaClient): Promise<string[]> {
  const models = (await c.query({ kind: "model" }, 100)).map((m) => m.body as { tier: string; rank?: number });
  return [...new Set(models.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((m) => m.tier))];
}

/** Fallback for a classifier error/timeout: choose by POSITION in the discovered list, so a renamed
 *  or added tier still routes. Hard/analytical → most capable, small talk → cheapest, else middle. */
function heuristicIndex(text: string, n: number): number {
  const t = text.toLowerCase();
  if (
    /```|traceback|stack trace|refactor|architect|analy[sz]|prove|derive|debug|optimi|percent|aggregate|how many|design (a|the)/.test(t) ||
    text.length > 400
  ) return n - 1;
  if (text.length <= 40 && !/\b(code|explain|compare|design|plan|why|count|list)\b/.test(t)) return 0;
  return Math.floor((n - 1) / 2);
}

/** Ask a cheap model which tier this turn needs. Returns a LIVE tier, or null on timeout/parse
 *  failure so the caller falls back. The call is `stream:false` — no chunk records for a routing
 *  decision — and carries `model`, which overrides whichever tier-worker picks it up. */
async function classifyLLM(text: string, tiers: string[], c: RadiaClient): Promise<string | null> {
  if (!text.trim() || tiers.length === 0) return null;
  const live = new Set(tiers);
  const system = `You are a routing classifier for an LLM chat. Choose the CHEAPEST capability tier ` +
    `that can handle the user's latest message well. Tiers, cheapest first: ${tiers.join(", ")}. ` +
    `Reply with EXACTLY one tier word, nothing else. Guide: cheapest tier for greetings/small talk/` +
    `simple lookups; a middle tier for moderate explanation or planning; the most capable tier for ` +
    `hard reasoning, analysis, math/proofs, multi-step tool work, or non-trivial code.`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: text }];
  const { id } = await c.put({ kind: "llm_call", body: { tier: tiers[0], model: classifyModel, messages, tools: [], stream: false } });
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
  templates: [{ kind: "llm_call", match: { tier: { $exists: false } } }],
  handle: async (rec, c) => {
    const body = rec.body as { conversationId?: string; upToIndex?: number };
    // Report the claim before the classifier round-trip — it is the first sign of life the chat
    // gets, and with a classifier in the path there is now a visible gap to explain.
    await progress(c, { conversationId: body.conversationId, callId: rec.id, stage: "routing", by: ME }, [rec.id]);
    const tiers = await liveTiers(c);
    if (tiers.length === 0) throw new Error("no `model` record advertised yet");
    // The turn to classify is the newest user message. Read it as a bounded descending scan, not by
    // pulling the thread: the router needs one message, not the conversation.
    const recent = (await c.query(
      {
        kind: "message",
        match: { conversationId: body.conversationId, index: { $lte: body.upToIndex ?? 0 } },
        orderBy: [{ path: "index", dir: "desc" }],
      },
      8,
    )).map((r) => r.body as { role: string; content?: string | null });
    const text = recent.find((m) => m.role === "user")?.content ?? "";
    const tier = (await classifyLLM(text, tiers, c)) ?? tiers[heuristicIndex(text, tiers.length)];
    await progress(c, { conversationId: body.conversationId, callId: rec.id, stage: "routed", by: ME, note: `→ ${tier}` }, [rec.id]);
    return { kind: "llm_call", body: { ...body, tier, replyTo: rec.id } };
  },
});
