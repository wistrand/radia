// Inference-worker: this app's binding of an LLM to Radia.
//
// The worker SHAPE is `extensions/ts/inference.ts` (claim, context window, chunk stream, escalation
// ladder, the two ack shapes). What lives here is the part that knows a vendor: the OpenRouter call
// and the tier advertisement. This is the ONLY process holding OPENROUTER_API_KEY, and it has no
// file access. Launched by chat.ts with --allow-net --allow-env.

import { RadiaClient } from "../../../sdk/ts/client.ts";
import { ESCALATE, runInferenceWorker } from "../../../extensions/ts/inference.ts";
import { publishCapability } from "../../../extensions/ts/capability.ts";
import { publishModel, retireModel } from "../../../extensions/ts/model.ts";
import { streamChat } from "../provider/openrouter.ts";
import { arg, onStop } from "../util.ts";

const ME = "agent:chat-inference";
const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-inference definition token (scoped grants)
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
// One tier (fast/balanced/deep) with one model; it claims only its tier's calls. `--model` is the
// concrete OpenRouter model, and a call may still override it.
const tier = arg("--tier"); // omit → serve ALL tiers (single-worker back-compat)
const model = arg("--model") ?? Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
const rank = Number(arg("--rank") ?? "0"); // cheap→capable; escalation goes up
const window = Number(arg("--window") ?? Deno.env.get("RADIA_CHAT_WINDOW") ?? "40");

const client = new RadiaClient(url, token ? { definitionToken: token } : {});

if (tier) {
  const ad = { tier, model, rank };
  await publishModel(client, ad);
  await publishCapability(client, ESCALATE, ME);
  // A stopped worker must stop being routed to: `model` is a latest-wins registry, so a retirement
  // takes the tier out of rotation and the next start revives it.
  onStop(() => retireModel(client, ad));
}

await runInferenceWorker(client, {
  provider: ME,
  model,
  tier,
  rank,
  window,
  // The one function that speaks to a vendor. Everything else about this worker is Radia work.
  complete: (req, onDelta) => streamChat({ apiKey, ...req }, onDelta),
});
