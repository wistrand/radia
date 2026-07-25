// Image generation over the SAME OpenAI-compatible chat-completions endpoint — there is no
// separate images API. What turns a chat model into an image generator is `modalities: ["image"]`
// on the request; the picture comes back inside the message.
//
// The response shape is not one shape. Seven variants are in the wild across OpenRouter, Gemini
// and DALL-E, and a client that handles only the documented one breaks on a model swap. The
// normalizer below is ported from a known-good implementation rather than guessed
// (melker/src/ai/image-extract.ts); five of the branches are provider quirks nobody would predict.
//
// Unlike the text path this is NOT streamed — one POST, one JSON response — so a caller has
// nothing to show for 5-20s. That is what `progress` records are for (see workers/images.ts).

import { API_BASE } from "./openrouter.ts";

export interface ImageBytes {
  bytes: Uint8Array;
  mediaType: string;
}

export interface GenerateOpts {
  apiKey: string;
  model: string;
  prompt: string;
  /** Gemini-style passthrough: [{category, threshold}] — provider-specific, sent only if present. */
  safetySettings?: { category: string; threshold: string }[];
  signal?: AbortSignal;
}

/** Ask for an image and return decoded bytes. Never returns a data URL: the payload goes straight
 *  to the blob store, so base64 should not survive past this function. */
export async function generateImage(opts: GenerateOpts): Promise<ImageBytes> {
  // Two prompt conventions that matter in practice: tell the model not to answer in prose (some
  // will happily describe the image instead of drawing it), and vary a seed so a repeated prompt
  // is a new image rather than a cache hit. In Radia the second one has a visible consequence —
  // identical bytes dedup to one blob, so two artifact records would share a digest.
  const seeded = `Do not respond with text. Only output an image. ` +
    `(seed: ${Math.floor(Math.random() * 2147483647)})\n\n${opts.prompt}`;
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/radia",
      "X-Title": "Radia chat",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content: seeded }],
      modalities: ["image"],
      max_tokens: 2048,
      ...(opts.safetySettings?.length ? { safetySettings: opts.safetySettings } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`image ${res.status}: ${errorMessage(await res.text())}`);
  return await toBytes(extractImage(await res.json()), opts.signal);
}

/** OpenRouter nests the provider's real error at `error.metadata.raw` — as a JSON *string*, so it
 *  takes two parses to get a message worth showing. */
function errorMessage(text: string): string {
  try {
    const err = JSON.parse(text) as { error?: { message?: string; metadata?: { raw?: string } } };
    const raw = err?.error?.metadata?.raw;
    if (raw) {
      try {
        return (JSON.parse(raw) as { error?: { message?: string } })?.error?.message ?? raw.slice(0, 200);
      } catch {
        return raw.slice(0, 200);
      }
    }
    return err?.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/**
 * Find the image in an OpenAI-compatible response. Returns a `data:` URL, or an https URL that the
 * caller must fetch. Known formats:
 *   - choices[].message.content[] with image_url.url      (OpenRouter)
 *   - choices[].message.content[] with inline_data        (Gemini)
 *   - choices[].message.images[]                          (OpenRouter alt: nested, flat, or string)
 *   - choices[].message.content as a data: URL string
 *   - choices[].message.content with a markdown image URL (remote)
 *   - data[].b64_json                                     (DALL-E)
 *   - data[].url                                          (DALL-E, remote)
 */
function extractImage(json: unknown): string {
  const obj = json as Record<string, unknown>;
  const message = (obj.choices as Record<string, unknown>[] | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;

  if (Array.isArray(message?.content)) {
    for (const part of message.content as Record<string, unknown>[]) {
      if (part.type === "image_url") {
        const url = (part.image_url as Record<string, unknown> | undefined)?.url;
        if (typeof url === "string" && url) return url;
      }
      if (part.type === "inline_data" && typeof part.data === "string") {
        return `data:${(part.mime_type as string) || "image/png"};base64,${part.data}`;
      }
    }
  }

  const images = message?.images;
  if (Array.isArray(images) && images.length > 0) {
    const img = images[0];
    if (typeof img === "string") return img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
    if (img && typeof img === "object") {
      const o = img as Record<string, unknown>;
      const nested = (o.image_url as Record<string, unknown> | undefined)?.url;
      if (typeof nested === "string" && nested) return nested;
      const raw = (o.url ?? o.data ?? o.b64_json) as string | undefined;
      if (typeof raw === "string" && raw) {
        if (raw.startsWith("data:") || raw.startsWith("http")) return raw;
        return `data:${(o.mime_type ?? o.content_type ?? "image/png") as string};base64,${raw}`;
      }
    }
  }

  if (typeof message?.content === "string") {
    const content = message.content.trim();
    if (content.startsWith("data:image/")) return content;
    const md = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    if (md) return md[1];
  }

  const data = obj.data as Record<string, unknown>[] | undefined;
  if (Array.isArray(data) && data.length > 0) {
    const d = data[0];
    if (typeof d.b64_json === "string") return `data:image/png;base64,${d.b64_json}`;
    if (typeof d.url === "string") return d.url;
  }

  throw new Error("no image in response (the model may have answered with text)");
}

/** Decode a data: URL, or fetch a remote one. */
async function toBytes(url: string, signal?: AbortSignal): Promise<ImageBytes> {
  const asData = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (asData) {
    const binary = atob(asData[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mediaType: asData[1] };
  }
  // Two of the seven formats hand back a URL the MODEL chose, so this is an outbound fetch to a
  // host the provider picked: https only, and the stored artifact is tainted (workers/images.ts).
  if (!url.startsWith("https://")) throw new Error(`refusing to fetch a non-https image URL: ${url.slice(0, 60)}`);
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mediaType: (res.headers.get("content-type") ?? "image/png").split(";")[0].trim(),
  };
}
