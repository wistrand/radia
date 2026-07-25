// Router-worker — model selection delegated to the substrate. The chat puts an UNTIERED
// `llm_call` (no routing logic in the client); this worker claims those (`{tier: $exists:false}`),
// classifies the latest user turn, and re-dispatches a TIERED `llm_call` that the matching
// inference-worker then serves. The result stays keyed to the ORIGINAL call the chat awaits
// (`replyTo`), so the chat is oblivious to the indirection.
//
// Classification is itself an `llm_call`: the router puts a cheap, model-overridden call
// (`--classify-model`, e.g. gemini-2.5-flash-lite) that an inference-worker serves, then reads the
// tier word back — so the API key stays isolated in the inference fleet and routing is expressed
// through the substrate, not a direct model call here. A regex heuristic is the fallback when the
// classifier errors or times out.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";
import type { ChatMessage } from "./openrouter.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-router run token
const classifyModel = arg("--classify-model") ?? Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";
const client = new RadiaClient(url, token ? { token } : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Which tiers have a live inference-worker, cheapest→capable by rank (discovered from `model`
// records) — so we only route to live tiers, order them for the classifier prompt, and a new tier
// becomes routable the moment its worker advertises itself.
let tierList: string[] = [];
let tiers = new Set<string>();
async function refreshTiers(): Promise<void> {
  const models = (await client.query({ kind: "model" }, 100)).map((m) => m.body as { tier: string; rank?: number });
  tierList = [...new Set(models.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((m) => m.tier))];
  tiers = new Set(tierList);
}
await refreshTiers();

/** Heuristic classifier (fallback): cheap for small talk, deep for hard/analytical/coding turns. */
function classify(text: string): "fast" | "balanced" | "deep" {
  const t = text.toLowerCase();
  if (/```|traceback|stack trace|refactor|architect|analy[sz]|prove|derive|debug|optimi|design (a|the)/.test(t) || text.length > 400) {
    return "deep";
  }
  if (text.length <= 40 && !/\b(code|explain|compare|design|plan|why)\b/.test(t)) return "fast";
  return "balanced";
}

/** LLM classifier: put a cheap model-overridden `llm_call` (served by the inference fleet) asking
 *  for the tier, and read the word back. Returns a live tier, or null on timeout/parse failure. */
async function classifyLLM(text: string, c: RadiaClient): Promise<string | null> {
  if (!text.trim() || tierList.length === 0) return null;
  const carrier = tiers.has("fast") ? "fast" : tierList[0]; // any live worker; body.model overrides it
  const system = `You are a routing classifier for an LLM chat. Choose the CHEAPEST capability tier ` +
    `that can handle the user's latest message well. Tiers, cheapest first: ${tierList.join(", ")}. ` +
    `Reply with EXACTLY one tier word, nothing else. Guide: cheapest tier for greetings/small talk/` +
    `simple lookups; a middle tier for moderate explanation or planning; the most capable tier for ` +
    `hard reasoning, analysis, math/proofs, or non-trivial code.`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: text }];
  const { id } = await c.put({ kind: "llm_call", body: { tier: carrier, model: classifyModel, messages, tools: [], stream: false } });
  for (let i = 0; i < 40; i++) { // ~8s budget, then fall back to the heuristic
    const result = await c.readOne({ kind: "llm_result", match: { callId: id } });
    if (result) {
      const content = ((result.body as { message?: { content?: string } }).message?.content) ?? "";
      for (const w of content.toLowerCase().match(/[a-z]+/g) ?? []) if (tiers.has(w)) return w;
      return null; // answered but unparseable → heuristic
    }
    await sleep(200);
  }
  return null; // timed out
}

/** The chosen tier if a worker serves it, else the nearest available (prefer balanced). */
function pick(want: string): string {
  if (tiers.has(want)) return want;
  for (const t of ["balanced", "deep", "fast"]) if (tiers.has(t)) return t;
  return want;
}

await agentLoop(client, {
  name: "router",
  templates: [{ kind: "llm_call", match: { tier: { $exists: false } } }],
  handle: async (rec, c) => {
    const body = rec.body as { conversationId: string; upToIndex: number; tools?: unknown };
    // classify on the latest user message (reconstructed from the thread, like inference does)
    const rows = await c.query(
      { kind: "message", match: { conversationId: body.conversationId }, orderBy: [{ path: "index" }] },
      2000,
    );
    const lastUser = [...rows].reverse().find((r) => (r.body as { role: string }).role === "user");
    const text = ((lastUser?.body as { content?: string })?.content) ?? "";
    await refreshTiers(); // cheap; keeps up as tier-workers come and go
    const tier = pick((await classifyLLM(text, c)) ?? classify(text)); // LLM first, heuristic fallback
    // Re-dispatch as a tiered call; `replyTo` keeps the result correlated to the original callId.
    return { kind: "llm_call", body: { ...body, tier, replyTo: rec.id } };
  },
});
