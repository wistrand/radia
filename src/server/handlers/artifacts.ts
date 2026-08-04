// Artifact endpoints: the one place bytes cross the wire instead of JSON.
//
//   POST /v0/artifacts                     raw body -> blob + `artifact` record (201 {id,digest,size})
//   GET  /v0/artifacts/{id}                the bytes (Bearer, or ?capability=)
//   GET  /v0/a/{capability}                the same bytes by capability alone: the SHORT form, and
//                                          the one handed to a person. The capability names exactly
//                                          one record, so the id in the path was redundant.
//   POST /v0/artifacts/{id}/capability     mint a short-lived download capability for one artifact
//
// Authorization is the ordinary record authorization: `put`/`read_one` grants on the reserved
// `artifact` kind. The capability exists for exactly one reason (a browser cannot attach an
// Authorization header to `<img src>`), so it is scoped to a single artifact, expires in minutes,
// and is minted only for a caller who could already read that artifact. That is the "short-lived
// download capability" of design-data-model §2.4; the record id in the URL stays stable forever.

import type { Space } from "../../core/space.ts";
import { ARTIFACT, type ArtifactDef, clientTaint, validateArtifactDef } from "../../core/kinds.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem, statusFor } from "../problem.ts";
import { TREE_PREFIX } from "../http.ts";

/** Media types safe to hand a browser for inline display. Raster images, audio and video only:
 *  NOT `image/svg+xml` (scriptable), not `application/pdf` (scriptable in some viewers), not
 *  text/* (renders as markup). Everything outside this list is served as a download. */
const RENDERABLE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

function renderable(mediaType: string): boolean {
  return RENDERABLE.test(mediaType);
}

/**
 * Media types the ISOLATED artifact origin may render inline.
 *
 * Everything the main origin renders, plus the scriptable text formats. This list is only safe
 * because the caller reaches it on a different origin from the console, presents no credential to
 * get there (capability URLs only), and the response pins the document into an opaque origin with
 * no network access. Never widen this on the main origin.
 */
const RENDERABLE_ISOLATED =
  /^(?:text\/(?:html|plain|css|markdown|javascript)|image\/svg\+xml|application\/(?:xhtml\+xml|json|javascript))$/i;
// `text/javascript` was added with the tree route and changes less than it looks: Content-Disposition
// governs NAVIGATION, not subresource loading, so a page's `<script src>` ran under the old list too.
// What this changes is that opening a `.js` file directly shows it instead of downloading it, which
// is what already happened for `.css`. The security property comes from the origin and the CSP, never
// from this list.

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
    // Application fields for the record body, as JSON in a header. A header is a ByteString, so
    // non-ASCII is rejected rather than silently mangled, the same rule that made idempotency keys
    // hashes rather than content (see gotchas.md). Bytes belong in the body; this is metadata.
    //
    // Parsed BEFORE authorization, which is the whole fix: the grant check ran against `{mediaType}`
    // alone, so a pattern-scoped put grant on an app field (`{conversationId: "c1"}`, the shape the
    // chat uses) could never be satisfied and every write 403'd. Fail-closed, and a feature nobody
    // could use.
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
    // A pattern-scoped artifact grant matches on the record body, which is metadata. The scope can
    // therefore say "only image/png" or "only this conversation", checked before any bytes are
    // stored. Matched against everything KNOWABLE before the payload, in the order `putArtifact`
    // composes it (app fields first, the runtime's own last and unforgeable). A pattern naming
    // `digest` or `size` still cannot be satisfied here, and deliberately: those are not known
    // until the bytes are read, and buffering 32MB to answer an authorization question is a free
    // denial of service.
    const constraint = await space.authorize(principal, "put", ARTIFACT);
    const scopeBody = { ...appFields, mediaType, ...(filename ? { filename } : {}) };
    if (constraint && !space.bodyMatchesGrant(ARTIFACT, scopeBody, constraint)) {
      return problem(403, "forbidden", `this artifact is outside the pattern scope of your put grant`);
    }
    const bytes = await readCapped(req, space.maxArtifactBytes);
    if (bytes === "too_large") {
      return problem(413, "artifact_too_large", `artifact exceeds the ${space.maxArtifactBytes}-byte limit`);
    }
    if (bytes.byteLength === 0) return problem(400, "invalid_body", "artifact body is empty");
    const parentIds = (req.headers.get("x-radia-parent-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const out = await space.putArtifact(
      bytes,
      {
        mediaType,
        filename,
        appFields,
        parentIds: parentIds.length ? parentIds : undefined,
        taint: clientTaint(req.headers.get("x-radia-taint"), { reserved: true }), // a RAISE
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
  /** True when serving from the isolated artifact origin, where scriptable content is safe to
   *  render because it shares no origin with the console and can reach nothing. */
  isolated = false,
  /** The origin a TREE's subresources may be fetched from, or null for a single artifact.
   *
   *  The isolated policy was written for one SELF-CONTAINED file: `default-src 'none'` with
   *  `script-src 'unsafe-inline'` allows an inline `<script>` and denies `<script src>`, and
   *  `img-src data:` allows a data URI and denies an image file. That is exactly right for one
   *  artifact and makes a multi-file page impossible — a `<link href="style.css">` is blocked.
   *
   *  Widened by naming the artifact origin EXPLICITLY rather than with `'self'`. The document is
   *  sandboxed without `allow-same-origin`, so it lives in an OPAQUE origin and `'self'` matches
   *  nothing; a host source is compared against the URL and still works. So a tree may load its own
   *  files and gains nothing else: `connect-src` stays absent under `default-src 'none'`, so fetch,
   *  XHR and WebSocket are still denied, which was always the property doing the real work. */
  treeOrigin?: string | null,
  /** HEAD: the same authorization and the same headers, without reading a byte of the payload.
   *  What a caller needs to reference an artifact (its digest, media type and size) is metadata,
   *  and making that cost a download is what pushed callers onto the operator plane instead. */
  headOnly = false,
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
        return problem(403, "forbidden", "this artifact is outside the pattern scope of your read grant");
      }
    }
    const found = await space.readArtifact(recordId);
    if (!found) {
      // "Erased" and "never existed" must not be the same answer. A record whose bytes were
      // deliberately destroyed is 410 Gone with the reason, so an auditor reading this response
      // learns that something WAS here; 404 stays the answer for an id that never named anything.
      const rec = await space.getRecord(recordId);
      const digest = (rec?.body as { digest?: string } | undefined)?.digest;
      const shred = digest ? await space.shredOf(digest) : null;
      if (shred) {
        return problem(
          410,
          "erased",
          `this artifact's content was destroyed (${shred.method})${shred.reason ? `: ${shred.reason}` : ""}. ` +
            `The record and its lineage remain; the bytes do not.`,
        );
      }
      return problem(404, "not_found", `no artifact ${recordId}`);
    }
    const def = found.def as ArtifactDef;
    const headers: Record<string, string> = {
      "content-type": def.mediaType,
      "content-length": String(def.size),
      // Content-addressed bytes never change, so the id is a perfect validator. The record may
      // still be private, though, so the cache must not be shared.
      "cache-control": "private, max-age=31536000, immutable",
      "etag": `"${def.digest}"`,
      // On the MAIN origin only media a browser can safely PAINT renders inline; everything else
      // downloads. An artifact is attacker-supplied bytes, and on that origin they would share a
      // document origin with the console, so anything scriptable (text/html, and image/svg+xml,
      // which is why the allowlist names raster formats rather than `image/`) would be a
      // same-origin XSS reachable by anyone holding an `artifact: put` grant.
      //
      // The ISOLATED origin renders those types, because there the same bytes share no origin with
      // anything and the policy below denies them the network.
      "content-disposition": `${
        renderable(def.mediaType) || (isolated && RENDERABLE_ISOLATED.test(def.mediaType)) ? "inline" : "attachment"
      }${def.filename ? `; filename="${def.filename}"` : ""}`,
      "x-content-type-options": "nosniff",
      // `sandbox` without `allow-same-origin` pins the document into an OPAQUE origin, so it cannot
      // reach the console's storage even if it were served beside it. `default-src 'none'` is the
      // fallback for connect-src, so fetch, XHR and WebSocket are all denied: that, not the origin
      // split, is what stops a script calling the API with no header and being served as the
      // operator in open mode. On the isolated origin scripts and styles are allowed to run, since
      // rendering a page is the point and there is nothing left for them to reach.
      "content-security-policy": isolated
        ? treeOrigin
          // A TREE: its own files, and still no network.
          //
          // `allow-same-origin` is present here and absent for a single artifact, which is the one
          // difference and was not optional. Without it the document sits in an OPAQUE origin, and
          // an opaque origin makes every subresource fetch CROSS-origin: a classic `<script src>`
          // survives that, and `<script type="module">` does not — module fetches are CORS-mode, so
          // the browser demanded an `Access-Control-Allow-Origin` this server has no business
          // sending. A page split into a module and its stylesheet, which is exactly what a model
          // produces when asked to split one, failed to load at all.
          //
          // What it costs is bounded and worth naming: a tree's document now shares the ARTIFACT
          // origin with other trees, so it can read storage there. Nothing else writes any — this
          // origin serves capability-gated bytes and holds no credential, which is the whole reason
          // it exists — and reaching another tree still requires knowing its capability. What it
          // does NOT cost is network egress: `connect-src` remains unlisted under
          // `default-src 'none'`, so fetch, XHR and WebSocket are denied exactly as before, and that
          // was always the property doing the real work rather than the origin being opaque.
          ? `sandbox allow-scripts allow-same-origin; default-src 'none'; ` +
            `script-src 'self' 'unsafe-inline' ${treeOrigin}; style-src 'self' 'unsafe-inline' ${treeOrigin}; ` +
            `img-src 'self' data: ${treeOrigin}; font-src 'self' data: ${treeOrigin}; ` +
            `media-src 'self' data: ${treeOrigin}`
          : "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"
        : "default-src 'none'; sandbox",
    };
    if (headOnly) {
      // The stream was opened to learn the payload exists, which is the same check GET makes, so an
      // erased artifact still answers 410 above rather than reporting metadata for bytes that are
      // gone. Cancel it: nothing here reads a byte.
      await found.stream.cancel().catch(() => {});
      return new Response(null, { status: 200, headers });
    }
    return new Response(found.stream, { status: 200, headers });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 403), e.code, e.message);
    throw e;
  }
}

/** A body is optional here, and a malformed one must not be the reason an erasure fails. */
async function shredOptions(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? j as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** POST /v0/ops/artifacts/{id}/shred: destroy the bytes, keep the record. Operator-only via /ops. */
export async function handleShredArtifact(space: Space, req: Request, recordId: string, principal: string): Promise<Response> {
  const j = await shredOptions(req);
  try {
    const r = await space.shredArtifact(recordId, {
      principal,
      reason: typeof j.reason === "string" ? j.reason : undefined,
      acknowledgeShared: j.acknowledgeShared === true,
    });
    return Response.json({
      artifact: recordId,
      ...r,
      // Say which guarantee was actually obtained. Without a KEK this is a delete, and a caller who
      // needed unrecoverability against a copy of the storage has to know it did not get it.
      note: r.encrypted
        ? "crypto-shredded: the per-blob key is destroyed, so the ciphertext is unrecoverable"
        : "deleted: this space has no KEK, so recovery from a storage copy is not excluded",
    });
  } catch (e) {
    if (e instanceof RadiaError) {
      if (e.code === "not_found") return problem(404, e.code, e.message);
      if (e.code === "shared_payload") return problem(409, e.code, e.message);
      return problem(422, e.code, e.message);
    }
    throw e;
  }
}

/**
 * POST /v0/capabilities — mint one capability over a SET of artifacts, addressed by path.
 *
 * Generic on purpose. The runtime is told `{path, artifactId}` pairs and learns nothing about what
 * they are: an extension builds the index from a workspace manifest, and any other application that
 * wants to serve a set of named blobs uses the same endpoint. Teaching `src/` what a manifest is
 * would have put a convention inside the runtime; teaching it that a capability can carry an index
 * did not.
 *
 * EVERY entry is authorized against the caller's read grant, here, once. That is what keeps the
 * served path credential-free, and it is why this is a mint rather than a lookup: a caller cannot
 * assemble a capability over bytes it could not already read.
 */
export async function handleMintPathCapability(space: Space, req: Request, principal: string): Promise<Response> {
  let j: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return problem(400, "invalid_body", "expected a JSON object");
  }
  const raw = Array.isArray(j?.entries) ? j.entries as Record<string, unknown>[] : null;
  if (!raw || raw.length === 0) {
    return problem(400, "invalid_body", "expected {entries: [{path, artifactId}, …]} with at least one entry");
  }
  if (raw.length > 5_000) return problem(400, "invalid_body", `too many entries (${raw.length}); a capability indexes at most 5000`);
  const entries: { path: string; artifactId: string }[] = [];
  for (const e of raw) {
    const path = typeof e.path === "string" ? e.path : "";
    const artifactId = typeof e.artifactId === "string" ? e.artifactId : "";
    if (!path || !artifactId) return problem(400, "invalid_body", "each entry needs a non-empty path and artifactId");
    entries.push({ path, artifactId });
  }
  try {
    const { constraint, createdBy } = await space.readAccess(principal, "read_one", ARTIFACT);
    for (const entry of entries) {
      const rec = await space.getRecord(entry.artifactId);
      // 404 rather than 403 for a record outside the caller's scope, matching the per-record reads:
      // a mint must not become an existence oracle either.
      if (!rec || rec.kind !== ARTIFACT || !space.authorAllows(createdBy, rec)) {
        return problem(404, "not_found", `no artifact ${entry.artifactId} (for path ${JSON.stringify(entry.path)})`);
      }
      if (constraint && !space.bodyMatchesGrant(ARTIFACT, rec.body, constraint)) {
        return problem(403, "forbidden", `artifact ${entry.artifactId} (path ${JSON.stringify(entry.path)}) is outside the pattern scope of your read grant`);
      }
    }
    const { capability, expiresAt } = space.mintPathCapability(entries);
    return new Response(
      JSON.stringify({
        capability,
        expiresAt,
        entries: entries.length,
        // Absolute, like the single-artifact form: a relative URL is unopenable by anything that is
        // not the console, and the caller cannot know what to prepend.
        url: `${space.artifactOrigin}${TREE_PREFIX}${capability}/`,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
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
    // one is minted. Otherwise a self-scoped principal converts a foreign artifact into a link
    // that needs no token at all.
    if (!space.authorAllows(createdBy, rec)) return problem(404, "not_found", `no artifact ${recordId}`);
    if (constraint && !space.bodyMatchesGrant(ARTIFACT, rec.body, constraint)) {
      return problem(403, "forbidden", "this artifact is outside the pattern scope of your read grant");
    }
    const { capability, expiresAt } = space.mintDownloadCapability(recordId);
    return new Response(
      JSON.stringify({
        capability,
        expiresAt,
        // The SHORT form: the capability already names one record, so the id and the query string
        // were ~70 characters of nothing. Against the isolated origin when one is running, so
        // opening the URL renders the bytes somewhere that shares nothing with the console; falls
        // back to a main-origin relative URL, where scriptable types still download.
        url: `${space.artifactOrigin}/v0/a/${capability}`,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 403), e.code, e.message);
    throw e;
  }
}
