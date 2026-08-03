// Image-generation worker. Claims `tool_call{tool:"generate_image"}`, calls an image model, stores
// the bytes as an ARTIFACT, and acks a `tool_result` carrying the artifact's id, never the bytes.
//
// It is its own process for the same reason the inference-worker is: it holds OPENROUTER_API_KEY
// and needs outbound network. The tool-worker deliberately has neither (`--allow-read=<sandbox>`,
// `--allow-net=127.0.0.1:<port>`, no `--allow-env`), and putting an API key and egress into the
// process that can read files would collapse that containment.
//
// The payload NEVER travels inside a record: a base64 image in a `tool_result` would land in the
// message thread, be re-sent on every turn, and swamp the Feed. The record carries a reference; the
// bytes live in the blob store (design-data-model §2.4).

import { agentLoop } from "../../../sdk/ts/loop.ts";
import { RadiaClient } from "../../../sdk/ts/client.ts";
import { generateImage } from "../provider/imagegen.ts";
import { progress } from "../space/progress.ts";
import { arg, onStop } from "../util.ts";
import { publishCapability } from "../space/capability.ts";
import { publishModel, retireModel } from "../space/model.ts";
import type { ToolDef } from "../provider/openrouter.ts";

const ME = "agent:chat-images";


const url = arg("--url") ?? "http://127.0.0.1:7788";
const token = arg("--token"); // agent:chat-images run token
const model = arg("--model") ?? Deno.env.get("RADIA_CHAT_IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";
const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
// Provider-specific moderation passthrough, e.g. "HARM_CATEGORY_DANGEROUS_CONTENT:BLOCK_ONLY_HIGH".
const safetySettings = (Deno.env.get("RADIA_CHAT_IMAGE_SAFETY") ?? "")
  .split(",")
  .map((pair) => pair.split(":"))
  .filter((p) => p.length === 2)
  .map(([category, threshold]) => ({ category: category.trim(), threshold: threshold.trim() }));
const client = new RadiaClient(url, token ? { token } : {});

const GENERATE_IMAGE: ToolDef = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate an image from a text description. Describe the subject, composition and " +
      "style in the prompt. The image model sees ONLY this prompt, not the conversation, so make it " +
      "self-contained. Returns a reference {artifactId, mediaType, size}, not image data: the picture " +
      "is stored in the space and the user is shown it automatically. Refer to the result in words " +
      "('the image above'). Never invent a link, path or URL to it, and do not ask for or expect " +
      "base64. Takes 5-20s.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained description of the image to draw." },
      },
      required: ["prompt"],
    },
  },
};


// Advertise the tool (discovery, like any capability) and the model (fleet inventory). `modalities`
// is what keeps this out of TEXT routing: the router and the escalation ladder select tiers that
// serve text, and this one does not. It is the same array the request sends as `modalities: ["image"]`.
await publishCapability(client, GENERATE_IMAGE);
const AD = { tier: "image", model, rank: 0, modalities: ["image"] };
await publishModel(client, AD);
// Withdraw the advertisement on a graceful stop, so the tier leaves rotation instead of sitting
// there as an offer nobody serves. A crash still leaves it (see space/model.ts).
onStop(() => retireModel(client, AD));

await agentLoop(client, {
  name: "images",
  patterns: [{ kind: "tool_call", match: { tool: "generate_image" } }],
  leaseSeconds: 120, // image generation is slow; the heartbeat keeps the lease alive
  handle: async (rec, c) => {
    const callId = rec.id;
    const b = rec.body as { args?: { prompt?: string }; conversationId?: string; owner?: string };
    const prompt = String(b.args?.prompt ?? "").trim();
    // Nothing streams for the next 5-20s, so this record is the only sign of life the chat has.
    await progress(c, { conversationId: b.conversationId, owner: b.owner, callId, stage: "drawing", by: ME, note: model }, [callId]);
    if (!prompt) return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: "generate_image needs a prompt" } };
    try {
      const { bytes, mediaType } = await generateImage({ apiKey, model, prompt, safetySettings });
      // Tainted on purpose. The bytes come from a provider (and in two of the response formats,
      // from a URL the MODEL chose), and an image is a prompt-injection vector the moment anything
      // reads it back: instructions render as pixels. A sensitive consumer can refuse it with
      // `requireUntainted`; clearing it needs a privileged declassify.
      const artifact = await c.putArtifact(bytes, {
        mediaType,
        filename: "generated.png",
        parentIds: [callId], // lineage: conversation -> tool_call -> artifact
        // Fetched from an image API: the bytes crossed a network.
        taint: ["net"],
        // Lineage records where it CAME from; this is what a grant can bind. Patterns match the
        // body, and parent_ids is not body, so without this field an artifact is readable by any
        // session that learns its id, whatever the conversation scoping says.
        meta: { conversationId: b.conversationId ?? "", owner: b.owner ?? "" },
      });
      return {
        kind: "tool_result",
        body: {
          callId,
          conversationId: b.conversationId, owner: b.owner,
          ok: true,
          output: { artifactId: artifact.id, mediaType, size: artifact.size, model, prompt },
        },
      };
    } catch (e) {
      // Don't nack: a refused or failed generation is an ANSWER (the model should see why and can
      // rephrase), not a transient fault to retry at cost.
      return { kind: "tool_result", body: { callId, conversationId: b.conversationId, owner: b.owner, ok: false, output: String(e) } };
    }
  },
});
