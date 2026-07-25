// The blob port — artifact BYTES, kept out of records and out of the record store.
//
// Records stay small, JSON, matchable and immutable; a payload too large for a body (an image,
// an audio clip, a PDF) lives here and is referenced by an `artifact` record (see
// core/kinds.ts ARTIFACT and design-data-model §2.4). This is a second port beside
// `StorageAdapter`, not a second plane: the same conformance discipline applies to every
// implementation, or the embedded and hosted paths drift (CLAUDE.md invariant).
//
// Blobs are CONTENT-ADDRESSED by sha256 of the plaintext: identical bytes are one object, an
// object verifies itself, and a re-upload is free. Identity as seen by clients is still the
// artifact RECORD id — never the digest, never a signed URL (design-data-model §2.4: stable
// internal ids, because a URL would expire inside an immutable record).
//
// NOT ENCRYPTED in v1, deliberately, and the shape here is what makes adding it a local change:
// a per-artifact random DEK with AES-GCM, the DEK wrapped by a space KEK from env or keyring,
// slots into `put`/`get` below. Two things that must NOT move when it lands: the digest stays
// over PLAINTEXT (integrity and the event chain survive crypto-shredding — design-observability),
// and the wrapped DEK must live in destroyable state (a sidecar here, or a key table), never in
// the immutable artifact record, because shredding requires deleting it.

import { fileSize, mkdirp, readBinaryStream, removeFile, writeBinaryFile } from "../platform.ts";
import { sha256Hex } from "../core/ids.ts";

/** What a stored blob is: its plaintext digest and byte length. */
export interface BlobRef {
  digest: string; // sha256 hex of the plaintext bytes
  size: number;
}

export interface BlobStore {
  readonly name: string;
  /** Store bytes; returns the content address. Storing the same bytes twice is a no-op. */
  put(bytes: Uint8Array): Promise<BlobRef>;
  /** The blob's bytes as a stream, or null if unknown. Downloads never buffer the whole object. */
  get(digest: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Size lookup without reading, or null if unknown. */
  stat(digest: string): Promise<BlobRef | null>;
  /** Remove a blob. Missing is not an error. Unreferenced-blob GC is not implemented (v1). */
  delete(digest: string): Promise<void>;
}

/** In-memory blobs — the default for an ephemeral space (`radia dev` with no `--db`), where a
 *  filesystem home would outlive the data that references it. */
export class MemoryBlobStore implements BlobStore {
  readonly name = "memory";
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    if (!this.blobs.has(digest)) this.blobs.set(digest, bytes);
    return { digest, size: bytes.byteLength };
  }

  get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = this.blobs.get(digest);
    if (!bytes) return Promise.resolve(null);
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    );
  }

  stat(digest: string): Promise<BlobRef | null> {
    const bytes = this.blobs.get(digest);
    return Promise.resolve(bytes ? { digest, size: bytes.byteLength } : null);
  }

  delete(digest: string): Promise<void> {
    this.blobs.delete(digest);
    return Promise.resolve();
  }
}

/** Filesystem blobs: `<root>/<first two hex chars>/<digest>`. The fan-out keeps directory sizes
 *  sane; the digest name makes the store self-verifying and idempotent on re-upload. */
export class FileBlobStore implements BlobStore {
  readonly name = "file";

  constructor(private readonly root: string) {
    mkdirp(root);
  }

  private path(digest: string): string {
    return `${this.root}/${digest.slice(0, 2)}/${digest}`;
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    const path = this.path(digest);
    // Same bytes, same address: an existing object is already correct, so skip the write.
    if (fileSize(path) === undefined) {
      mkdirp(`${this.root}/${digest.slice(0, 2)}`);
      await writeBinaryFile(path, bytes);
    }
    return { digest, size: bytes.byteLength };
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!isDigest(digest)) return null; // never let a caller-supplied name reach the filesystem
    return (await readBinaryStream(this.path(digest))) ?? null;
  }

  stat(digest: string): Promise<BlobRef | null> {
    if (!isDigest(digest)) return Promise.resolve(null);
    const size = fileSize(this.path(digest));
    return Promise.resolve(size === undefined ? null : { digest, size });
  }

  delete(digest: string): Promise<void> {
    if (isDigest(digest)) removeFile(this.path(digest));
    return Promise.resolve();
  }
}

/** A digest is 64 lowercase hex chars — the only shape allowed to become a path component. */
export function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
