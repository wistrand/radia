// Router-worker — model selection delegated to the substrate. The chat puts an UNTIERED
// `llm_call` (no routing logic in the client); this worker claims those (`{tier: $exists:false}`),
// classifies the latest user turn, and re-dispatches a TIERED `llm_call` that the matching
// inference-worker then serves. The result stays keyed to the ORIGINAL call the chat awaits
// (`replyTo`), so the chat is oblivious to the indirection. Swap the heuristic below for a
// classifier model without touching the chat — routing lives here, in the substrate.

import { agentLoop } from "../../sdk/ts/loop.ts";
import { RadiaClient } from "../../sdk/ts/client.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-router run token
const client = new RadiaClient(url, token ? { token } : {});

// Which tiers actually have an inference-worker (discovered from `model` records) — so we only
// route to live tiers, and a new tier becomes routable the moment its worker advertises itself.
let tiers = new Set<string>();
async function refreshTiers(): Promise<void> {
  const models = await client.query({ kind: "model" }, 100);
  tiers = new Set(models.map((m) => (m.body as { tier: string }).tier));
}
await refreshTiers();

/** Heuristic classifier: cheap for small talk, deep for hard/analytical/coding turns. */
function classify(text: string): "fast" | "balanced" | "deep" {
  const t = text.toLowerCase();
  if (/```|traceback|stack trace|refactor|architect|analy[sz]|prove|derive|debug|optimi|design (a|the)/.test(t) || text.length > 400) {
    return "deep";
  }
  if (text.length <= 40 && !/\b(code|explain|compare|design|plan|why)\b/.test(t)) return "fast";
  return "balanced";
}
/** The classified tier if a worker serves it, else the nearest available (prefer balanced). */
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
    const tier = pick(classify(text));
    // Re-dispatch as a tiered call; `replyTo` keeps the result correlated to the original callId.
    return { kind: "llm_call", body: { ...body, tier, replyTo: rec.id } };
  },
});
