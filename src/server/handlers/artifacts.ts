// Artifact endpoints — the one place bytes cross the wire instead of JSON.
//
//   POST /v0/artifacts                     raw body -> blob + `artifact` record (201 {id,digest,size})
//   GET  /v0/artifacts/{id}                the bytes (Bearer, or ?capability=)
//   POST /v0/artifacts/{id}/capability     mint a short-lived download capability for one artifact
//
// Authorization is the ordinary record authorization: `put`/`read_one` grants on the reserved
// `artifact` kind. The capability exists for exactly one reason — a browser cannot attach an
// Authorization header to `<img src>` — so it is scoped to a single artifact, expires in minutes,
// and is minted only for a caller who could already read that artifact. That is the "short-lived
// download capability" of design-data-model §2.4; the record id in the URL stays stable forever.

import type { Space } from "../../core/space.ts";
import { ARTIFACT, type ArtifactDef, validateArtifactDef } from "../../core/kinds.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem, statusFor } from "../problem.ts";

/** Media types safe to hand a browser for inline display. Raster images, audio and video only:
 *  NOT `image/svg+xml` (scriptable), not `application/pdf` (scriptable in some viewers), not
 *  text/* (renders as markup). Everything outside this list is served as a download. */
const RENDERABLE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

function renderable(mediaType: string): boolean {
  return RENDERABLE.test(mediaType);
}

/** Read the request body with a hard ceiling, without trusting Content-Length. */
async function readCapped(req: Request, limit: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return "too_large";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
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

export async function handlePutArtifact(space: Space, req: Request, principal: string): Promise<Response> {
  const mediaType = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  const filename = req.headers.get("x-radia-filename") ?? undefined;
  try {
    // Header validation FIRST: a bad media type or filename is knowable before a single byte is
    // read, and buffering 32MB only to reject the headers is a free denial-of-service.
    validateArtifactDef({ digest: "", size: 0, mediaType, filename });
    // A template-scoped artifact grant matches on the record body, which is metadata — so the
    // scope can say "this principal may only write image/png artifacts", checked before any bytes
    // are stored.
    const constraint = await space.authorize(principal, "put", ARTIFACT);
    if (constraint && !space.bodyMatchesGrant(ARTIFACT, { mediaType }, constraint)) {
      return problem(403, "forbidden", `artifact mediaType '${mediaType}' is outside the template scope of your put grant`);
    }
    const bytes = await readCapped(req, space.maxArtifactBytes);
    if (bytes === "too_large") {
      return problem(413, "artifact_too_large", `artifact exceeds the ${space.maxArtifactBytes}-byte limit`);
    }
    if (bytes.byteLength === 0) return problem(400, "invalid_body", "artifact body is empty");
    const parentIds = (req.headers.get("x-radia-parent-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // Application fields for the record body, as JSON in a header. A header is a ByteString, so
    // non-ASCII is rejected rather than silently mangled — the same rule that made idempotency keys
    // hashes rather than content (see gotchas.md). Bytes belong in the body; this is metadata.
    const metaHeader = req.headers.get("x-radia-meta");
    let appFields: Record<string, unknown> | undefined;
    if (metaHeader) {
      // deno-lint-ignore no-control-regex
      if (/[^\x00-\x7f]/.test(metaHeader)) {
        return problem(400, "invalid_artifact", "x-radia-meta must be ASCII JSON (a header cannot carry non-Latin1 text)");
      }
      try {
        const parsed = JSON.parse(metaHeader);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        appFields = parsed as Record<string, unknown>;
      } catch {
        return problem(400, "invalid_artifact", "x-radia-meta must be a JSON object of field → scalar");
      }
    }
    const out = await space.putArtifact(
      bytes,
      {
        mediaType,
        filename,
        appFields,
        parentIds: parentIds.length ? parentIds : undefined,
        taint: req.headers.get("x-radia-taint") === "true" ? true : undefined,
      },
      req.headers.get("Idempotency-Key") ?? undefined,
      principal,
    );
    return new Response(JSON.stringify(out), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 422), e.code, e.message);
    throw e;
  }
}

/** Bytes. `principal` is null when the caller presented a capability instead of a token. */
export async function handleGetArtifact(
  space: Space,
  recordId: string,
  principal: string | null,
): Promise<Response> {
  try {
    if (principal !== null) {
      const { constraint, createdBy } = await space.readAccess(principal, "read_one", ARTIFACT);
      const rec = await space.getRecord(recordId);
      if (!rec || rec.kind !== ARTIFACT) return problem(404, "not_found", `no artifact ${recordId}`);
      // A self scope restricts artifact BYTES too. 404 rather than 403 for a foreign artifact: the
      // caller is not entitled to learn that the id exists.
      if (!space.authorAllows(createdBy, rec)) return problem(404, "not_found", `no artifact ${recordId}`);
      if (constraint && !space.bodyMatchesGrant(ARTIFACT, rec.body, constraint)) {
        return problem(403, "forbidden", "this artifact is outside the template scope of your read grant");
      }
    }
    const found = await space.readArtifact(recordId);
    if (!found) return problem(404, "not_found", `no artifact ${recordId}`);
    const def = found.def as ArtifactDef;
    const headers: Record<string, string> = {
      "content-type": def.mediaType,
      "content-length": String(def.size),
      // Content-addressed bytes never change, so the id is a perfect validator — but the record
      // may be private, so the cache must not be shared.
      "cache-control": "private, max-age=31536000, immutable",
      "etag": `"${def.digest}"`,
      // Only media a browser can safely PAINT renders inline; everything else downloads. An
      // artifact is attacker-supplied bytes served from the SPACE'S OWN ORIGIN — the origin whose
      // console page carries an operator token — so anything scriptable rendered here (text/html,
      // and image/svg+xml, which is why the allowlist names raster formats instead of `image/`)
      // would be a same-origin XSS reachable by anyone holding an `artifact: put` grant.
      "content-disposition": `${renderable(def.mediaType) ? "inline" : "attachment"}${def.filename ? `; filename="${def.filename}"` : ""}`,
      "x-content-type-options": "nosniff",
      // Defence in depth: even if a future allowlist entry turns out to be scriptable, nothing
      // here may load, execute or phone home.
      "content-security-policy": "default-src 'none'; sandbox",
    };
    return new Response(found.stream, { status: 200, headers });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 403), e.code, e.message);
    throw e;
  }
}

export async function handleMintCapability(space: Space, recordId: string, principal: string): Promise<Response> {
  try {
    const { constraint, createdBy } = await space.readAccess(principal, "read_one", ARTIFACT);
    const rec = await space.getRecord(recordId);
    if (!rec || rec.kind !== ARTIFACT) return problem(404, "not_found", `no artifact ${recordId}`);
    // A capability is a bearer URL that outlives this check, so the scope has to be applied BEFORE
    // one is minted — otherwise a self-scoped principal converts a foreign artifact into a link
    // that needs no token at all.
    if (!space.authorAllows(createdBy, rec)) return problem(404, "not_found", `no artifact ${recordId}`);
    if (constraint && !space.bodyMatchesGrant(ARTIFACT, rec.body, constraint)) {
      return problem(403, "forbidden", "this artifact is outside the template scope of your read grant");
    }
    const { capability, expiresAt } = space.mintDownloadCapability(recordId);
    return new Response(
      JSON.stringify({
        capability,
        expiresAt,
        url: `/v0/artifacts/${encodeURIComponent(recordId)}?capability=${capability}`,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 403), e.code, e.message);
    throw e;
  }
}
