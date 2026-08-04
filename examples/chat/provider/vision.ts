// Reading an image or a document, over the SAME OpenAI-compatible chat-completions endpoint that
// serves text. What makes a call multimodal is the shape of `content`: an array of parts, one of
// them carrying a `data:` URL. There is no separate vision API.
//
// A PDF is NOT an image part, and that is the one non-obvious thing here. Pictures travel as
// `image_url`; documents travel as `{type:"file", file:{filename, file_data}}`, and the filename is
// load-bearing, since it is what tells the provider which parser to run. Sending a PDF as an
// `image_url` is accepted by the type system and refused by the provider.
//
// Not streamed, and not routed through `streamChat`: that path types `content` as a string, and
// widening it to carry parts would put a media-shaped union in front of every text turn. One POST,
// one JSON response, same as `imagegen.ts`.
//
// The bytes arrive here from the blob store and leave as base64 inside the request. That is the one
// place base64 is legitimate: it is the provider's wire format, and nothing keeps it afterwards.

import { API_BASE } from "./openrouter.ts";

export interface DescribeOpts {
  apiKey: string;
  model: string;
  /** What to answer about the image or document. */
  prompt: string;
  bytes: Uint8Array;
  mediaType: string;
  /** Names the document for the provider's parser. Ignored for images. */
  filename?: string;
  signal?: AbortSignal;
}

/** Ask a multimodal model about one image or document and return its answer as text. */
export async function describeMedia(opts: DescribeOpts): Promise<{ text: string; usage?: unknown }> {
  const dataUrl = `data:${opts.mediaType};base64,${toBase64(opts.bytes)}`;
  const media = opts.mediaType === "application/pdf"
    ? { type: "file", file: { filename: opts.filename ?? "document.pdf", file_data: dataUrl } }
    : { type: "image_url", image_url: { url: dataUrl } };
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
      messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }, media] }],
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${errorMessage(await res.text())}`);
  const json = await res.json() as {
    choices?: { message?: { content?: unknown } }[];
    usage?: unknown;
  };
  const text = flatten(json.choices?.[0]?.message?.content);
  if (!text) throw new Error("the model returned no text for this file");
  return { text, usage: json.usage };
}

/** A multimodal model may answer with a plain string or with content parts, depending on the provider. */
function flatten(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("")
      .trim();
  }
  return "";
}

/** Chunked, because `String.fromCharCode(...bytes)` blows the argument limit on anything above a
 *  megabyte or so, which is most photographs. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** OpenRouter nests the provider's real error at `error.metadata.raw`, as a JSON *string*. Same
 *  two-parse unwrap as `imagegen.ts`; a bare `vision 400` says nothing a caller can act on. */
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
