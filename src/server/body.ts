// Request bodies, read with a ceiling.
//
// `req.json()` buffers whatever arrives before anyone looks at it, and the record size limit is
// decided AFTER that, on the parsed value: nine handlers accepted an arbitrary body into memory
// first (package Z, 2026-09-04). The artifact upload always had a capped reader; it lives here now
// and the JSON routes read through the same one. Content-Length is a hint, never trusted: the
// stream is counted as it arrives and cancelled the moment it passes the ceiling.

import { RadiaError } from "../core/errors.ts";

/**
 * The most JSON any route accepts. A TRANSPORT ceiling on buffering, not the record limit: the
 * record cap (`maxRecordBytes`, 1 MiB by default) still decides what may be stored, and this only
 * bounds what is read to find out. Generous, so a space configured for larger records is not
 * refused here first; anyone raising the record cap past this meets `body_too_large` and its message
 * names this constant.
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/** Read the request body with a hard ceiling, without trusting Content-Length. */
export async function readCapped(req: Request, limit: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return "too_large";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // `Request.body` is the stream to count as it arrives, and Deno always has it. Firefox does not
  // implement the getter (MDN lists it as limited availability), and the browser space
  // (`src/browser.ts`) hands a constructed Request to this same handler, so there the body is
  // buffered whole and checked after. A refused body is refused either way; only the moment differs.
  const reader = req.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await req.arrayBuffer());
    return whole.byteLength > limit ? "too_large" : whole;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The body as parsed JSON, or `undefined` when it is not JSON. THROWS `body_too_large` (413 on the
 * wire) past the ceiling, so a caller's own `try { … } catch { return null }` around a parse does not
 * turn a refused body into "invalid body": the two are different answers.
 */
export async function parseJsonBody(req: Request, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const bytes = await readCapped(req, limit);
  if (bytes === "too_large") {
    throw new RadiaError("body_too_large", `request body exceeds ${limit} bytes (MAX_JSON_BODY_BYTES); a payload that size belongs in an artifact`);
  }
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
