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
// ENCRYPTION is optional and lives here, not above: pass a `BlobCipher` (src/storage/crypto.ts)
// and payloads are sealed under a per-blob DEK wrapped by the space KEK. Both invariants hold
// either way — the digest is over PLAINTEXT (integrity and the event chain survive
// crypto-shredding), and the wrapped DEK lives in destroyable state beside the blob, never in the
// immutable artifact record. A store with no cipher stores plaintext, which is the default.

import { fileSize, mkdirp, readBinaryFile, readBinaryStream, readTextFile, removeFile, writeBinaryFile, writeTextFile } from "../platform.ts";
import { sha256Hex } from "../core/ids.ts";
import type { BlobCipher, SealedKey } from "./crypto.ts";

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
  readonly name: string;
  /** Stored form: ciphertext when a cipher is set, plaintext otherwise. `size` is always the
   *  PLAINTEXT length — the port's contract, and 16 bytes less than sealed bytes. */
  private readonly blobs = new Map<string, { stored: Uint8Array; size: number; key?: SealedKey }>();

  constructor(private readonly cipher?: BlobCipher) {
    this.name = cipher ? "memory+aes-gcm" : "memory";
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    if (!this.blobs.has(digest)) {
      if (this.cipher) {
        const { ciphertext, key } = await this.cipher.seal(digest, bytes);
        this.blobs.set(digest, { stored: ciphertext, size: bytes.byteLength, key });
      } else {
        this.blobs.set(digest, { stored: bytes, size: bytes.byteLength });
      }
    }
    return { digest, size: bytes.byteLength };
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    const entry = this.blobs.get(digest);
    if (!entry) return null;
    // A sealed blob verifies its tag over the WHOLE ciphertext, so an encrypted read cannot be
    // incremental: decrypt, then hand back one chunk. Bounded by the artifact size limit.
    const bytes = entry.key && this.cipher ? await this.cipher.open(digest, entry.stored, entry.key) : entry.stored;
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }

  stat(digest: string): Promise<BlobRef | null> {
    const entry = this.blobs.get(digest);
    return Promise.resolve(entry ? { digest, size: entry.size } : null);
  }

  delete(digest: string): Promise<void> {
    this.blobs.delete(digest); // key and ciphertext go together: crypto-shredding is implicit here
    return Promise.resolve();
  }
}

/** Filesystem blobs: `<root>/<first two chars>/<name>`, where `name` is the plaintext digest for
 *  an unencrypted store and HMAC(KEK, digest) for an encrypted one. The fan-out keeps directory
 *  sizes sane; content addressing makes the store self-verifying and idempotent on re-upload. */
export class FileBlobStore implements BlobStore {
  readonly name: string;

  constructor(private readonly root: string, private readonly cipher?: BlobCipher) {
    this.name = cipher ? "file+aes-gcm" : "file";
    mkdirp(root);
  }

  private path(name: string): string {
    return `${this.root}/${name.slice(0, 2)}/${name}`;
  }

  /** Where a NEW blob is written: HMAC(KEK, digest) when encrypting, so a stolen directory listing
   *  cannot answer "do you hold this exact file?" — a content-addressed encrypted store whose
   *  filenames are plaintext hashes still leaks that. */
  private async writePath(digest: string): Promise<string> {
    return this.path(this.cipher ? await this.cipher.storageName(digest) : digest);
  }

  /** Where an EXISTING blob actually is. Encrypted name first, then the plaintext-digest name —
   *  turning encryption on must not orphan blobs written before it, so a store can hold both and
   *  reads keep working while new writes are sealed. */
  private async findPath(digest: string): Promise<{ path: string; key?: SealedKey } | null> {
    if (this.cipher) {
      const sealed = this.path(await this.cipher.storageName(digest));
      if (fileSize(sealed) !== undefined) return { path: sealed, key: this.readKey(sealed) };
    }
    const plain = this.path(digest);
    return fileSize(plain) === undefined ? null : { path: plain, key: this.readKey(plain) };
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    const path = await this.writePath(digest);
    const dir = path.slice(0, path.lastIndexOf("/"));
    // Same bytes, same address: an existing object is already correct, so skip the write. Under
    // encryption this is also what keeps DEDUP working — a second put reuses the stored ciphertext
    // and its DEK rather than sealing the same payload under a second key.
    if (fileSize(path) === undefined) {
      mkdirp(dir);
      if (this.cipher) {
        const { ciphertext, key } = await this.cipher.seal(digest, bytes);
        await writeBinaryFile(path, ciphertext);
        // The wrapped DEK sits beside the payload, NOT in the artifact record: shredding a blob
        // means deleting this file, and records are immutable.
        writeTextFile(`${path}.key`, JSON.stringify(key));
      } else {
        await writeBinaryFile(path, bytes);
      }
    }
    return { digest, size: bytes.byteLength };
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!isDigest(digest)) return null; // never let a caller-supplied name reach the filesystem
    const found = await this.findPath(digest);
    if (!found) return null;
    // No sidecar means the blob is plaintext (written before encryption was enabled, or by a store
    // that never had a cipher): stream it as-is rather than failing to open it.
    if (!found.key || !this.cipher) return (await readBinaryStream(found.path)) ?? null;
    const ciphertext = await readBinaryFile(found.path);
    if (!ciphertext) return null;
    const plaintext = await this.cipher.open(digest, ciphertext, found.key);
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(plaintext);
        c.close();
      },
    });
  }

  async stat(digest: string): Promise<BlobRef | null> {
    if (!isDigest(digest)) return null;
    const found = await this.findPath(digest);
    if (!found) return null;
    // Report the PLAINTEXT length: the sidecar records it, because ciphertext carries a 16-byte tag.
    return { digest, size: found.key ? found.key.size : (fileSize(found.path) ?? 0) };
  }

  async delete(digest: string): Promise<void> {
    if (!isDigest(digest)) return;
    // Remove both possible homes: "gone" must not depend on which regime wrote it. The key goes
    // first — a sealed payload whose DEK is destroyed is already unrecoverable, so an interrupted
    // delete leaves shredded bytes rather than readable ones.
    for (const name of [this.cipher ? await this.cipher.storageName(digest) : null, digest]) {
      if (!name) continue;
      const path = this.path(name);
      removeFile(`${path}.key`);
      removeFile(path);
    }
  }

  private readKey(path: string): SealedKey | undefined {
    const text = readTextFile(`${path}.key`);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as SealedKey;
    } catch {
      return undefined;
    }
  }
}

/** A digest is 64 lowercase hex chars — the only shape allowed to become a path component. */
export function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
