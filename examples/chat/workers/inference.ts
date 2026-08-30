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
import { conversationKeys, fleetKeyPair } from "../space/keys.ts";
import { arg, argOn, onStop } from "../util.ts";

const ME = "agent:chat-inference";

/** Set by the launcher that beats for this provider (`spawn` in client/fleet.ts), so these
 *  advertisements may be judged stale once it stops. Absent when a worker is started by hand. */
const PRESENCE = { presence: argOn("--presence") };
const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-inference definition token (scoped grants)
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
// One tier (fast/balanced/deep) with one model; it claims only its tier's calls. `--model` is the
// concrete OpenRouter model, and a call may still override it.
const tier = arg("--tier"); // omit → serve ALL tiers (single-worker back-compat)
const model = arg("--model") ?? Deno.env.get("RADIA_CHAT_MODEL") ?? "openai/gpt-4o-mini";
const rank = Number(arg("--rank") ?? "0"); // cheap→capable; escalation goes up
const window = Number(arg("--window") ?? Deno.env.get("RADIA_CHAT_WINDOW") ?? "40");
// Calls served at once. Serving one is 5-60s of awaiting a socket, so at 1 this tier answers one
// person at a time however much the space could take (agent_docs/plan-scaling.md). The launcher
// passes the flag (see PROVIDER_CONCURRENCY, which explains why this one is deliberately low);
// the env fallback is for running this worker standalone.
const concurrency = Number(arg("--concurrency") ?? Deno.env.get("RADIA_CHAT_CONCURRENCY") ?? "4");

const client = new RadiaClient(url, token ? { definitionToken: token } : {});
// Never CREATED here: `--serve` generates and publishes it, and a worker that minted its own would
// hold a private half whose public half nobody sealed to.
const fleet = await fleetKeyPair();

if (tier) {
  const ad = { tier, model, rank };
  await publishModel(client, ad);
  await publishCapability(client, ESCALATE, ME, undefined, PRESENCE);
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
  concurrency,
  // The one function that speaks to a vendor. Everything else about this worker is Radia work.
  complete: (req, onDelta) => streamChat({ apiKey, ...req }, onDelta),
  // The fleet's private half, which is why THIS process can answer an encrypted conversation and a
  // session holding only a public key cannot (plan-encryption.md phase 2). Absent when no fleet key
  // was ever generated, in which case an encrypted call fails closed at the context read rather
  // than answering about ciphertext.
  ...(fleet ? { keys: conversationKeys(client, { kind: "fleet", privateKey: fleet.privateKey, keyId: fleet.keyId }) } : {}),
});
