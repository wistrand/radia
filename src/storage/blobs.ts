// The blob port: artifact BYTES, kept out of records and out of the record store.
//
// Records stay small, JSON, matchable and immutable; a payload too large for a body (an image,
// an audio clip, a PDF) lives here and is referenced by an `artifact` record (see
// core/kinds.ts ARTIFACT and design-data-model §2.4). This is a second port beside
// `StorageAdapter`, not a second plane: the same conformance discipline applies to every
// implementation, or the embedded and hosted paths drift (CLAUDE.md invariant).
//
// Blobs are CONTENT-ADDRESSED by sha256 of the plaintext: identical bytes are one object, an
// object is VERIFIABLE, and a re-upload is free. Verifiable, not verified: a plaintext `get`
// streams without re-hashing, because hashing on every read costs a full pass and forces the whole
// object into memory, which is exactly what streaming exists to avoid. A sealed read does verify,
// for free, because GCM authenticates the ciphertext against the digest. What closes the gap for
// plaintext is that damage cannot be WRITTEN: `writeAtomic` below means a crash leaves no file
// rather than a short one, and `put` compares length before it dedups, so bytes the caller is
// holding always repair the address. Identity as seen by clients is still the
// artifact RECORD id, never the digest and never a signed URL (design-data-model §2.4: stable
// internal ids, because a URL would expire inside an immutable record).
//
// ENCRYPTION is optional and lives here, not above: pass a `BlobCipher` (src/storage/crypto.ts)
// and payloads are sealed under a per-blob DEK wrapped by the space KEK. Both invariants hold
// either way: the digest is over PLAINTEXT (integrity and the event chain survive
// crypto-shredding), and the wrapped DEK lives in destroyable state beside the blob, never in the
// immutable artifact record. A store with no cipher stores plaintext, which is the default.

import {
  fileSize,
  mkdirp,
  readBinaryFile,
  readBinaryStream,
  readTextFile,
  removeFile,
  renameFile,
  writeBinaryFile,
  writeTextFile,
} from "../platform.ts";
import { sha256Hex } from "../core/ids.ts";
import { type BlobCipher, GCM_TAG_BYTES, type SealedKey } from "./crypto.ts";

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

/** In-memory blobs: the default for an ephemeral space (`radia dev` with no `--db`), where a
 *  filesystem home would outlive the data that references it. */
export class MemoryBlobStore implements BlobStore {
  readonly name: string;
  /** Stored form: ciphertext when a cipher is set, plaintext otherwise. `size` is always the
   *  PLAINTEXT length, which is the port's contract and 16 bytes less than sealed bytes. */
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
 *  sizes sane; content addressing makes the store idempotent on re-upload and lets any holder of
 *  the bytes repair an address (see the header on what is verified and what is merely verifiable). */
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
   *  cannot answer "do you hold this exact file?". A content-addressed encrypted store whose
   *  filenames are plaintext hashes still leaks that. */
  private async writePath(digest: string): Promise<string> {
    return this.path(this.cipher ? await this.cipher.storageName(digest) : digest);
  }

  /** Where an EXISTING blob actually is. Encrypted name first, then the plaintext-digest name.
   *  Turning encryption on must not orphan blobs written before it, so a store can hold both and
   *  reads keep working while new writes are sealed. */
  private async findPath(digest: string): Promise<{ path: string; key?: SealedKey; sealed: boolean } | null> {
    if (this.cipher) {
      const sealedPath = this.path(await this.cipher.storageName(digest));
      if (fileSize(sealedPath) !== undefined) return { path: sealedPath, key: this.readKey(sealedPath), sealed: true };
    }
    const plain = this.path(digest);
    return fileSize(plain) === undefined ? null : { path: plain, key: this.readKey(plain), sealed: false };
  }

  /**
   * Write so `path` is either absent or COMPLETE, never half of one.
   *
   * A content-addressed store makes a partial write permanent rather than transient: the damaged
   * file sits at the address its correct bytes would hash to, so every later `put` of those bytes
   * finds something there and skips the write. Ordinary "the next write fixes it" does not apply,
   * because there is no next write. Rename is the whole fix; the temp name carries a random suffix
   * so two concurrent puts of the same payload cannot land on each other's partial file.
   */
  private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeBinaryFile(tmp, bytes);
    try {
      renameFile(tmp, path);
    } catch (e) {
      removeFile(tmp);
      throw e;
    }
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    const path = await this.writePath(digest);
    const dir = path.slice(0, path.lastIndexOf("/"));
    // Same bytes, same address: an existing object is already correct, so skip the write. Under
    // encryption this is also what keeps DEDUP working: a second put reuses the stored ciphertext
    // and its DEK rather than sealing the same payload under a second key.
    //
    // "Already stored" means both parts exist AND THE PAYLOAD IS THE RIGHT LENGTH. Existence alone
    // is what made damage permanent: a re-put of the correct bytes saw a truncated file, skipped,
    // and the store could never heal even though the caller was holding exactly what was missing.
    // Length is checked rather than the digest because the expected value is already known here
    // (`bytes`), so it costs a `stat` instead of re-hashing the payload on every put. It catches
    // truncation, which is what a partial write and a partial delete both produce; it does not
    // claim to catch same-length corruption, and `writeAtomic` above is what makes that unreachable
    // from a crash.
    const stored = fileSize(path) === this.expectedSize(bytes.byteLength) &&
      (!this.cipher || this.readKey(path) !== undefined);
    if (!stored) {
      mkdirp(dir);
      if (this.cipher) {
        const { ciphertext, key } = await this.cipher.seal(digest, bytes);
        // KEY FIRST, then the payload. The reverse order has a crash window that corrupts
        // silently: ciphertext with no sidecar reads as a plaintext blob, so the raw ciphertext
        // would be served as if it were the artifact. This way an interrupted write leaves a key
        // with no payload, which is an honest miss and self-healing on the next put.
        // The wrapped DEK sits beside the payload, NOT in the artifact record: shredding a blob
        // means deleting this file, and records are immutable.
        writeTextFile(`${path}.key`, JSON.stringify(key));
        await this.writeAtomic(path, ciphertext);
      } else {
        await this.writeAtomic(path, bytes);
      }
    }
    return { digest, size: bytes.byteLength };
  }

  /** On-disk length for a payload of `plaintextSize`. Sealing appends a 16-byte GCM tag. */
  private expectedSize(plaintextSize: number): number {
    return this.cipher ? plaintextSize + GCM_TAG_BYTES : plaintextSize;
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!isDigest(digest)) return null; // never let a caller-supplied name reach the filesystem
    const found = await this.findPath(digest);
    if (!found) return null;
    // A blob at the ENCRYPTED name with no sidecar is damage, not legacy: serving it would hand
    // back raw ciphertext as if it were the payload. Only a blob at the plaintext-digest name may
    // be read as plaintext (written before encryption was enabled, or by a store with no cipher).
    if (!found.key && found.sealed) return null;
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
    if (!found.key && found.sealed) return null; // half-written: `get` cannot serve it either
    // Report the PLAINTEXT length: the sidecar records it, because ciphertext carries a 16-byte tag.
    return { digest, size: found.key ? found.key.size : (fileSize(found.path) ?? 0) };
  }

  async delete(digest: string): Promise<void> {
    if (!isDigest(digest)) return;
    // Remove both possible homes: "gone" must not depend on which regime wrote it. The key goes
    // first, because a sealed payload whose DEK is destroyed is already unrecoverable, so an
    // interrupted delete leaves shredded bytes rather than readable ones.
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

/** A digest is 64 lowercase hex chars, the only shape allowed to become a path component. */
export function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
