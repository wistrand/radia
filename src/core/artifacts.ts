// Artifacts: bytes that live beside the record rather than inside it, plus the short-lived
// capabilities that let a browser read them.
//
// An artifact is a RECORD whose body describes bytes held in the blob store. Everything that makes
// records useful (grants, taint, lineage, the event log, retention) therefore applies to it with no
// new machinery, and only the payload sits outside. The reference clients hold is the record id:
// stable, immutable, and never a signed URL, which would expire inside a record that cannot be
// rewritten. See agent_docs/design-data-model.md §2.4, and the erasure invariant in CLAUDE.md for
// why this is also the one place data can be destroyed.
//
// Extracted from `space.ts` unchanged, reaching the space through the narrow `ArtifactHost` port
// rather than through `Space`: writing an artifact is `put` plus a blob, and a module that could
// reach the whole service would not stay that way.

import type { Page, RadiaRecord, StatsScope } from "../storage/adapter.ts";
import type { BlobStore } from "../storage/blobs.ts";
import { isDigest } from "../storage/blobs.ts";
import { ARTIFACT, type ArtifactDef, SHRED, validateArtifactDef, validateArtifactFields } from "./kinds.ts";
import type { Pattern } from "./matching.ts";
import type { PutRequest } from "./record.ts";
import { RadiaError } from "./errors.ts";
import { readRegistry } from "./registry.ts";

/** Everything the artifact verbs need from a space, and nothing else. */
export interface ArtifactHost {
  readonly blobs: BlobStore;
  readonly maxArtifactBytes: number;
  getRecord(recordId: string): Promise<RadiaRecord | null>;
  /** The DATABASE clock, never the process one (the timing invariant in CLAUDE.md). */
  now(): Promise<string>;
  put(req: PutRequest, idempotencyKey?: string, principal?: string): Promise<{ id: string }>;
  /** The unauthorized write path, for the runtime's own bookkeeping records. */
  putRaw(
    req: PutRequest,
    idempotencyKey?: string,
    opts?: { taint?: string[]; principal?: string },
  ): Promise<{ id: string }>;
  query(pattern: Pattern, limit?: number, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]>;
}

/** What a caller may say about an artifact. Everything authoritative (digest, size) is
 *  computed by the runtime, never taken from here. */
export interface ArtifactMeta {
    mediaType: string;
    filename?: string;
    parentIds?: string[];
    retentionUntil?: string;
    taint?: string[];
    /**
     * APPLICATION fields merged into the artifact's record body.
     *
     * The body is otherwise entirely runtime-built, which would leave artifacts as the one kind
     * an application cannot scope: a grant pattern matches the body, so with nothing of the
     * app's in there, "artifacts belonging to this conversation" is inexpressible and any
     * holder of an artifact id can read it. These are client CLAIMS like any other body
     * content (the runtime routes on them, never trusts them), and the authoritative fields
     * below always win, so nothing here can forge a digest, size or media type.
     */
    appFields?: Record<string, unknown>;
}

/** Store bytes and commit the `artifact` record that references them. The digest and size are
 *  computed here, never taken from the client. They are runtime-authoritative like any other
 *  server-assigned field. */
export async function putArtifact(
  h: ArtifactHost,
  bytes: Uint8Array,
  meta: ArtifactMeta,
  idempotencyKey?: string,
  principal?: string,
): Promise<{ id: string; digest: string; size: number }> {
  if (bytes.byteLength > h.maxArtifactBytes) {
    throw new RadiaError("artifact_too_large", `artifact exceeds the ${h.maxArtifactBytes}-byte limit`);
  }
  validateArtifactDef({ digest: "", mediaType: meta.mediaType, size: 0, filename: meta.filename });
  validateArtifactFields(meta.appFields);

  const ref = await h.blobs.put(bytes);
  // Authoritative fields LAST: an app field can never shadow the digest, size or media type the
  // runtime computed, whatever the caller sent.
  const body: ArtifactDef = { ...meta.appFields, digest: ref.digest, mediaType: meta.mediaType, size: ref.size };
  if (meta.filename) body.filename = meta.filename;
  const { id } = await h.put(
    {
      kind: ARTIFACT,
      body,
      parentIds: meta.parentIds,
      retentionUntil: meta.retentionUntil,
      taint: meta.taint,
    },
    idempotencyKey,
    principal,
  );
  return { id, digest: ref.digest, size: ref.size };
}

/** The artifact record plus a byte stream, or null if the id is not an artifact / the blob is
 *  gone. Callers authorize FIRST: this is the read itself, not the check. */
export async function readArtifact(h: ArtifactHost, recordId: string): Promise<{ record: RadiaRecord; def: ArtifactDef; stream: ReadableStream<Uint8Array> } | null> {
  const record = await h.getRecord(recordId);
  if (!record || record.kind !== ARTIFACT) return null;
  const def = record.body as ArtifactDef;
  if (!def || !isDigest(def.digest)) return null;
  const stream = await h.blobs.get(def.digest);
  return stream ? { record, def, stream } : null;
}

/**
 * Destroy an artifact's bytes and record that it happened.
 *
 * NOT irreversible, and the doc used to say it was. This destroys the runtime's COPY; the content
 * address stays valid, so anyone holding the payload can store it again and every record that
 * referenced it reads once more. `Space.erasures` reports a shred in that state rather than
 * pretending otherwise; see the erasure invariant in CLAUDE.md for why neither refusing the write
 * nor refusing the read is the fix.
 *
 * Immutability is the substrate's core property and erasure is a real requirement (a subject
 * exercising a right, a secret written by accident, a retention deadline), so this is a carve-out
 * with a stated shape rather than a hole. What is destroyed is the PAYLOAD; the record, its id,
 * its lineage and the event chain all survive, and the content address stays valid because the
 * digest is over plaintext. So the space still says "an artifact with this digest was here, and
 * was erased", which is what an auditor needs and what a plain delete would take away.
 *
 * Under encryption this is crypto-shredding: `BlobStore.delete` destroys the per-blob key before
 * the ciphertext, so an interrupted erase leaves unreadable bytes rather than readable ones.
 * Without a KEK it is a plain delete, and the caller should be told which they got.
 *
 * The marker is written AFTER the bytes are gone, deliberately. A crash between the two leaves
 * data erased and reported as merely missing, which is a cosmetic failure; the other order leaves
 * data alive and reported as erased, which is a lie about a security property.
 *
 * SHARED BYTES. The store is content-addressed, so identical payloads are ONE blob that several
 * artifact records reference. Erasing by content erases it for all of them. That is the right
 * semantics (there is one payload) and a sharp edge (two people who uploaded the same file), so
 * a shared blob refuses unless the caller says it means it.
 */
export async function shredArtifact(
  h: ArtifactHost,
  recordId: string,
  opts: { principal?: string; reason?: string; acknowledgeShared?: boolean } = {},
): Promise<{ digest: string; references: number; encrypted: boolean; alreadyGone: boolean }> {
  const record = await h.getRecord(recordId);
  if (!record || record.kind !== ARTIFACT) throw new RadiaError("not_found", `no artifact ${recordId}`);
  const def = record.body as ArtifactDef;
  if (!def || !isDigest(def.digest)) throw new RadiaError("not_found", `artifact ${recordId} has no digest`);

  // Every artifact record pointing at these bytes. Read to exhaustion: a bounded count that
  // undercounts would let a shared blob past the guard below, which is the failure that turns a
  // targeted erasure into somebody else's data loss.
  const refs = await readRegistry(
    (limit, after) => h.query({ kind: ARTIFACT, match: { digest: def.digest } }, limit, { dir: "desc", after }),
    (_b, r) => r.id,
  );
  const references = refs.entries.size;
  if (!refs.complete) {
    throw new RadiaError("registry_incomplete", `could not count every reference to ${def.digest}; refusing to erase`);
  }
  if (references > 1 && !opts.acknowledgeShared) {
    throw new RadiaError(
      "shared_payload",
      `${references} artifact records reference this content, and erasing is by CONTENT: all of ` +
        `them lose it. Pass acknowledgeShared to proceed.`,
    );
  }

  const alreadyGone = (await h.blobs.stat(def.digest)) === null;
  await h.blobs.delete(def.digest);
  const at = await h.now();
  await h.putRaw({
    kind: SHRED,
    body: {
      digest: def.digest,
      artifactId: recordId,
      references,
      reason: opts.reason ?? "",
      at,
      // Whether the bytes were destroyed or the KEY was: only the second is unrecoverable against
      // someone holding a copy of the storage, and a caller deciding whether an erasure is
      // sufficient needs to know which one it got.
      method: h.blobs.name.includes("aes") ? "crypto-shred" : "delete",
    },
    parentIds: [recordId],
  }, undefined, { principal: opts.principal });
  return { digest: def.digest, references, encrypted: h.blobs.name.includes("aes"), alreadyGone };
}

/** Was this content erased on purpose? Distinguishes a 410 from a 404, which is the difference
 *  between "destroyed" and "never here" and the only thing a reader can still learn. */
export async function shredOf(h: ArtifactHost, digest: string): Promise<Record<string, unknown> | null> {
  const rows = await h.query({ kind: SHRED, match: { digest } }, 1, { dir: "desc" });
  return rows.length > 0 ? rows[0].body as Record<string, unknown> : null;
}

/**
 * Live download capabilities: short-lived, unguessable grants to read ONE artifact, or a SET of
 * them addressed by path.
 *
 * IN MEMORY on purpose, and the limitation is accepted rather than unnoticed: they are
 * process-local, lost on restart, and invisible to a second instance. Persisting them would put
 * high-churn, security-critical state into records, which is the one shape CLAUDE.md's stopping
 * rule names as a bad fit. A capability is a short-lived view, not durable state; what makes a TREE
 * durable is the records themselves, or `radia workspace-git`.
 *
 * A class rather than functions, because the Map IS the feature: it was the only state in `Space`
 * that nothing else touched, which is what made this the cheapest thing to lift out of it.
 */
export class CapabilityStore {
  /** `index` is present when the capability opens a SET of artifacts by path rather than one record. */
  private readonly live = new Map<string, { recordId?: string; index?: Map<string, string>; expiresAt: number }>();

  constructor(private readonly ttlSeconds: number) {}

  /** How many are outstanding. Diagnostics only; a capability is not addressable from outside. */
  get size(): number {
    return this.live.size;
  }

  /** Mint a short-lived capability to download ONE artifact. The caller must already be authorized
   *  to read it; this delegates that read to a context that cannot send an Authorization header
   *  (an `<img src>` in the console), which is why the design specifies capabilities rather than
   *  putting a bearer token in a URL. */
  /**
   * Mint a capability over a SET of artifacts, addressed by path.
   *
   * The runtime learns "a capability may name artifacts by path" and nothing else — not what a
   * workspace is, not what a manifest is, not that these paths are a website. The caller supplies
   * the index; an extension builds it from a tree, and any other application wanting to serve a set
   * of named blobs gets the same primitive. That is the same generalisation the erasure carve-out
   * made ("too large for a body" became "erasable, whatever its size") rather than teaching `src/`
   * a domain concept.
   *
   * PATH TRAVERSAL IS STRUCTURALLY ABSENT here, which is worth stating because "serve a directory
   * over HTTP" is normally where it lives. The path is looked up in this fixed index; there is no
   * filesystem to escape, no normalisation to get wrong, and `..` simply misses. The index IS the
   * allowlist.
   *
   * Authorization happens at MINT, over every entry, exactly as the single-artifact form does — so
   * the served path carries no credential and needs no grant read per request.
   */
  mintPathCapability(entries: { path: string; artifactId: string }[]): { capability: string; expiresAt: string } {
    const { capability, expiresAt, at } = this.mint();
    this.live.set(capability, { index: new Map(entries.map((e) => [e.path, e.artifactId])), expiresAt: at });
    this.sweep();
    return { capability, expiresAt };
  }

  /** Which artifact does this capability serve at this path? `null` for an unknown capability, an
   *  expired one, or a path the index does not contain — the caller cannot tell those apart, which
   *  is deliberate: a probe learns nothing about the shape of the tree. */
  resolveCapabilityPath(capability: string, path: string): string | null {
    const cap = this.live.get(capability);
    if (!cap?.index) return null;
    if (cap.expiresAt <= Date.now()) {
      this.live.delete(capability);
      return null;
    }
    return cap.index.get(path) ?? null;
  }

  private mint(): { capability: string; expiresAt: string; at: number } {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const capability = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const at = Date.now() + this.ttlSeconds * 1000;
    return { capability, expiresAt: new Date(at).toISOString(), at };
  }

  mintDownloadCapability(recordId: string): { capability: string; expiresAt: string } {
    // 16 random bytes as base64url: 22 characters instead of the 64 hex ones this used to emit.
    // These travel in a URL a person is shown, pastes and sometimes reads aloud, and length is the
    // property that decides whether that is bearable. 128 bits is not a compromise here: the token
    // opens ONE artifact for a few minutes and is not an identity, so the exposure a guess would
    // buy is bounded in both directions. Guessing 2^128 inside that window is not a thing.
    const { capability, expiresAt, at } = this.mint();
    this.live.set(capability, { recordId, expiresAt: at });
    this.sweep();
    return { capability, expiresAt };
  }

  /**
   * Which artifact does this capability open, if any? The capability already NAMES one record, so a
   * URL carrying it needs nothing else: that is what lets the short form (`/a/<capability>`) drop
   * both the 26-character id and the query string.
   */
  resolveDownloadCapability(capability: string): string | null {
    const cap = this.live.get(capability);
    if (!cap) return null;
    if (cap.expiresAt <= Date.now()) {
      this.live.delete(capability);
      return null;
    }
    return cap.recordId ?? null;
  }

  /** Does this capability open this artifact, right now? Scoped to one record on purpose: a
   *  leaked capability is one object for a few minutes, not an identity. */
  checkDownloadCapability(capability: string, recordId: string): boolean {
    const cap = this.live.get(capability);
    if (!cap) return false;
    if (cap.expiresAt <= Date.now()) {
      this.live.delete(capability);
      return false;
    }
    return cap.recordId === recordId;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, cap] of this.live) if (cap.expiresAt <= now) this.live.delete(token);
  }
}
