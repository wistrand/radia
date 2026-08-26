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
  fileMtimeMs,
  fileSize,
  listDirNames,
  mkdirp,
  readBinaryFile,
  readBinaryStream,
  readTextFile,
  removeFile,
  renameFile,
  touchFile,
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

/** What one `retainOnly` pass did. `scanned` counts stored payloads examined; `bytes` is the
 *  stored size reclaimed (ciphertext size on an encrypted store). */
import type { BlobGcResult } from "../../sdk/ts/wire.ts";
export type { BlobGcResult };

/** What one `rewrap` pass did. `already` counts payloads found under the CURRENT key, which is the
 *  number that must equal `scanned` before a retired key can be destroyed. */
export interface RewrapResult {
  scanned: number;
  rewrapped: number;
  already: number;
  /** Sealed under a key this space does not hold, so it could not be opened, let alone re-sealed.
   *  Non-zero means the rotation is not finishable with the keys currently supplied. */
  foreign: number;
  /** Referenced digests with no stored payload at all. Not an error here: erasure and GC both
   *  produce it, and a rewrap is not the verb that decides what a missing blob means. */
  missing: number;
  bytes: number;
}

export interface BlobStore {
  readonly name: string;
  /** Whether every copy this store can hold is stored ENCRYPTED. `shredArtifact` reports
   *  crypto-shred versus delete from this, and the two differ against someone holding a backup,
   *  so a store that can also serve plaintext (a migration layer that is not sealed) answers
   *  false. Never inferred from `name`: a bucket called `aes-corp` would answer yes. */
  readonly sealed: boolean;
  /** Store bytes; returns the content address. Storing the same bytes twice is a no-op for the
   *  CONTENT and must still refresh the blob's clock (see `retainOnly`'s grace window). */
  put(bytes: Uint8Array): Promise<BlobRef>;
  /** The blob's bytes as a stream, or null if unknown. Downloads never buffer the whole object. */
  get(digest: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Size lookup without reading, or null if unknown. */
  stat(digest: string): Promise<BlobRef | null>;
  /** Remove a blob. Missing is not an error. Crypto-shredding's half; GC uses `retainOnly`. */
  delete(digest: string): Promise<void>;
  /**
   * Reference-aware GC (plan-gc.md phase 4): delete every stored blob whose digest is NOT in
   * `liveDigests` and whose last write is older than `graceMs`.
   *
   * The keep set travels as DIGESTS and the store maps them to its own storage names, never the
   * reverse: an encrypted store's filenames are deliberately unmappable back to digests (they
   * are HMAC(KEK, digest), so a stolen listing cannot answer "do you hold this file"), which is
   * why no `list()` of digests can exist on this port.
   *
   * The GRACE window is load-bearing, not politeness. `putArtifact` writes bytes FIRST and
   * commits the record after; a concurrent put that deduped into an existing blob has, for that
   * gap, bytes that look unreferenced. `put` refreshes the blob's clock, so anything younger
   * than the grace is treated as live whatever the record store says. That bound also covers a
   * SECOND process over the same blob directory, which no in-process latch could. Ages are
   * host-clock (mtimes are host-clock data); `nowMs` exists for tests, never to pass a DB time.
   */
  retainOnly(liveDigests: ReadonlySet<string>, opts: { graceMs: number; dryRun?: boolean; nowMs?: number }): Promise<BlobGcResult>;
  /**
   * Re-seal every referenced payload under the CURRENT key, so a retired one can be destroyed.
   *
   * OPTIONAL, like the adapter's `prepareKind`, and its PRESENCE is the signal: a store with no
   * cipher does not offer the method at all, rather than answering with a row of zeroes that reads
   * as "the rotation is finished". Callers check (`Space.rewrapBlobs` returns undefined, and the
   * ops route answers 400) instead of interpreting an empty result. It takes the live digest set for the same reason
   * `retainOnly` does, and a sharper one: a sealed payload can only be opened with its plaintext
   * digest (the AAD), and the store cannot derive that from its own listing by construction. So a
   * rewrap covers what records still reference; unreferenced bytes are GC's business.
   *
   * DIGEST-DRIVEN, therefore BLIND to payloads it cannot name. A blob sealed under a key this
   * space does not hold sits at HMAC(that key, digest), a name nothing here can compute, so it
   * counts as `missing` rather than `foreign`. `retainOnly` is the pass that meets those, walking
   * names rather than digests, and it keeps them. The two halves are what make a rotation
   * survivable: one moves what it can reach, the other refuses to delete what it cannot.
   *
   * ORDER IS WRITE-THEN-DELETE, and an interrupted pass is safe rather than atomic: both copies
   * exist for a moment, reads prefer the current key's name, and re-running finishes the job.
   * The reverse order would leave a referenced artifact with no payload.
   */
  rewrap?(liveDigests: ReadonlySet<string>, opts?: { dryRun?: boolean }): Promise<RewrapResult>;
}

/** An empty pass, so every implementation starts from the same shape. */
export function emptyRewrap(): RewrapResult {
  return { scanned: 0, rewrapped: 0, already: 0, foreign: 0, missing: 0, bytes: 0 };
}

/** In-memory blobs: the default for an ephemeral space (`radia dev` with no `--db`), where a
 *  filesystem home would outlive the data that references it. */
export class MemoryBlobStore implements BlobStore {
  readonly name: string;
  readonly sealed: boolean;
  /** Stored form: ciphertext when a cipher is set, plaintext otherwise. `size` is always the
   *  PLAINTEXT length, which is the port's contract and 16 bytes less than sealed bytes.
   *  `touchedAt` is the grace-window clock `retainOnly` reads; a deduped put refreshes it. */
  private readonly blobs = new Map<string, { stored: Uint8Array; size: number; key?: SealedKey; touchedAt: number }>();

  /** Present only on an ENCRYPTED store. A plaintext one has nothing to re-seal, and answering with
   *  a row of zeroes would read as "the rotation is finished" to anyone asking. */
  readonly rewrap?: (liveDigests: ReadonlySet<string>, opts?: { dryRun?: boolean }) => Promise<RewrapResult>;

  constructor(private readonly cipher?: BlobCipher) {
    this.name = cipher ? "memory+aes-gcm" : "memory";
    this.sealed = cipher !== undefined;
    if (cipher) this.rewrap = (live, opts) => this.#rewrap(live, opts ?? {});
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    const existing = this.blobs.get(digest);
    if (existing) {
      existing.touchedAt = Date.now(); // the dedupe still means "these bytes are wanted NOW"
    } else if (this.cipher) {
      const { ciphertext, key } = await this.cipher.seal(digest, bytes);
      this.blobs.set(digest, { stored: ciphertext, size: bytes.byteLength, key, touchedAt: Date.now() });
    } else {
      this.blobs.set(digest, { stored: bytes, size: bytes.byteLength, touchedAt: Date.now() });
    }
    return { digest, size: bytes.byteLength };
  }

  retainOnly(liveDigests: ReadonlySet<string>, opts: { graceMs: number; dryRun?: boolean; nowMs?: number }): Promise<BlobGcResult> {
    const now = opts.nowMs ?? Date.now();
    const out: BlobGcResult = { scanned: 0, deleted: 0, bytes: 0 };
    for (const [digest, entry] of this.blobs) {
      out.scanned++;
      if (liveDigests.has(digest)) continue;
      if (now - entry.touchedAt < opts.graceMs) continue; // young: a racing put may own it
      // Sealed under a key we do not hold: keep it and say so. See `BlobGcResult.foreign`.
      if (entry.key && this.cipher && !this.cipher.knows(entry.key.kid)) {
        out.foreign = (out.foreign ?? 0) + 1;
        continue;
      }
      out.deleted++;
      out.bytes += entry.stored.byteLength;
      if (!opts.dryRun) this.blobs.delete(digest);
    }
    return Promise.resolve(out);
  }

  async #rewrap(liveDigests: ReadonlySet<string>, opts: { dryRun?: boolean }): Promise<RewrapResult> {
    const out = emptyRewrap();
    if (!this.cipher) return out;
    for (const digest of liveDigests) {
      const entry = this.blobs.get(digest);
      if (!entry) {
        out.missing++;
        continue;
      }
      out.scanned++;
      if (entry.key?.kid === this.cipher.kid) {
        out.already++;
        continue;
      }
      if (entry.key && !this.cipher.knows(entry.key.kid)) {
        out.foreign++;
        continue;
      }
      const plaintext = entry.key ? await this.cipher.open(digest, entry.stored, entry.key) : entry.stored;
      out.rewrapped++;
      out.bytes += plaintext.byteLength;
      if (opts.dryRun) continue;
      const { ciphertext, key } = await this.cipher.seal(digest, plaintext);
      this.blobs.set(digest, { stored: ciphertext, size: plaintext.byteLength, key, touchedAt: entry.touchedAt });
    }
    return out;
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
  readonly sealed: boolean;

  /** Present only on an ENCRYPTED store; see `MemoryBlobStore.rewrap`. */
  readonly rewrap?: (liveDigests: ReadonlySet<string>, opts?: { dryRun?: boolean }) => Promise<RewrapResult>;

  constructor(private readonly root: string, private readonly cipher?: BlobCipher) {
    this.name = cipher ? "file+aes-gcm" : "file";
    this.sealed = cipher !== undefined;
    if (cipher) this.rewrap = (live, opts) => this.#rewrap(live, opts ?? {});
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

  /** Where an EXISTING blob actually is: every name it could carry, newest key first, then the
   *  plaintext-digest name. Two regimes have to coexist for reads, and for the same reason both
   *  times. Turning encryption ON must not orphan blobs written before it, and ROTATING the key
   *  must not orphan blobs written under the old one, since a name is HMAC(KEK, digest) and a new
   *  key renames everything. Writes always use the current name, so a re-put migrates a blob. */
  private async findPath(digest: string): Promise<{ path: string; key?: SealedKey; sealed: boolean } | null> {
    if (this.cipher) {
      for (const name of await this.cipher.storageNames(digest)) {
        const sealedPath = this.path(name);
        if (fileSize(sealedPath) !== undefined) return { path: sealedPath, key: this.readKey(sealedPath), sealed: true };
      }
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
    if (stored) {
      // The dedupe still means "these bytes are wanted NOW": the mtime is the grace-window
      // clock `retainOnly` reads, and without this bump a re-put of an old blob races GC —
      // the caller's record commits after the bytes, and in that gap the blob looks orphaned.
      touchFile(path);
    }
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
    // Remove EVERY possible home: "gone" must not depend on which regime or which key wrote it, and
    // an erasure that reached the current name while a retired-key copy survived is not an erasure.
    // The key goes first, because a sealed payload whose DEK is destroyed is already unrecoverable,
    // so an interrupted delete leaves shredded bytes rather than readable ones.
    for (const name of [...(this.cipher ? await this.cipher.storageNames(digest) : []), digest]) {
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

  /**
   * Re-seal referenced payloads under the current key. See the port for the contract; what is
   * specific here is the ORDER: key sidecar, then payload, then the old pair, so no window leaves a
   * payload whose DEK is missing and none leaves the artifact with nothing to read.
   */
  async #rewrap(liveDigests: ReadonlySet<string>, opts: { dryRun?: boolean }): Promise<RewrapResult> {
    const out = emptyRewrap();
    if (!this.cipher) return out;
    const currentName = async (d: string) => this.path(await this.cipher!.storageName(d));
    for (const digest of liveDigests) {
      const found = await this.findPath(digest);
      if (!found) {
        out.missing++;
        continue;
      }
      out.scanned++;
      const target = await currentName(digest);
      if (found.path === target && found.key) {
        out.already++;
        continue;
      }
      // A payload at a sealed name with no readable sidecar is damage `get` already refuses; a
      // rewrap must not turn that into a re-sealed copy of ciphertext.
      if (found.sealed && !found.key) {
        out.foreign++;
        continue;
      }
      if (found.key && !this.cipher.knows(found.key.kid)) {
        out.foreign++;
        continue;
      }
      const stored = await readBinaryFile(found.path);
      if (!stored) {
        out.missing++;
        continue;
      }
      const plaintext = found.key ? await this.cipher.open(digest, stored, found.key) : stored;
      // The address is what everything else trusts. Re-hashing costs one pass over bytes already
      // in memory and turns a silently corrupt payload into a reported one instead of a re-sealed
      // lie at a content address it does not match.
      if (await sha256Hex(plaintext) !== digest) {
        out.foreign++; // not ours to fix, and not ours to overwrite
        continue;
      }
      out.rewrapped++;
      out.bytes += plaintext.byteLength;
      if (opts.dryRun) continue;
      const { ciphertext, key } = await this.cipher.seal(digest, plaintext);
      mkdirp(target.slice(0, target.lastIndexOf("/")));
      writeTextFile(`${target}.key`, JSON.stringify(key));
      await this.writeAtomic(target, ciphertext);
      if (found.path !== target) {
        removeFile(`${found.path}.key`);
        removeFile(found.path);
      }
    }
    return out;
  }

  async retainOnly(liveDigests: ReadonlySet<string>, opts: { graceMs: number; dryRun?: boolean; nowMs?: number }): Promise<BlobGcResult> {
    const now = opts.nowMs ?? Date.now();
    // The keep set as STORAGE NAMES. A live digest may occupy either home (the plaintext-digest
    // name from before encryption was enabled, the HMAC name after), so an encrypted store keeps
    // both; the reverse mapping (name -> digest) deliberately does not exist.
    const keep = new Set<string>();
    for (const d of liveDigests) {
      keep.add(d);
      if (this.cipher) for (const name of await this.cipher.storageNames(d)) keep.add(name);
    }
    const out: BlobGcResult = { scanned: 0, deleted: 0, bytes: 0 };
    for (const shard of listDirNames(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue; // never walk anything this store did not lay out
      const dir = `${this.root}/${shard}`;
      const names = listDirNames(dir);
      const present = new Set(names);
      for (const name of names) {
        const path = `${dir}/${name}`;
        // writeAtomic leftovers from a crash: past the grace they belong to no write in flight.
        if (name.endsWith(".tmp")) {
          const age = now - (fileMtimeMs(path) ?? now);
          if (age >= opts.graceMs && !opts.dryRun) removeFile(path);
          continue;
        }
        // A sidecar rides its payload's fate; an ORPHAN key (crash between key and payload, the
        // documented honest-miss state) is deletable on its own once old enough.
        if (name.endsWith(".key")) {
          if (!present.has(name.slice(0, -4))) {
            const age = now - (fileMtimeMs(path) ?? now);
            if (age >= opts.graceMs && !opts.dryRun) removeFile(path);
          }
          continue;
        }
        if (!/^[0-9a-f]{64}$/.test(name)) continue; // not a payload this store wrote
        out.scanned++;
        if (keep.has(name)) continue;
        const age = now - (fileMtimeMs(path) ?? now);
        if (age < opts.graceMs) continue; // young: a racing put (this process or another) may own it
        // A payload whose sidecar names a KEK we do not hold is not an orphan: it is a blob from
        // before a rotation whose retired key was not supplied, or another space's object sharing
        // this directory. Deleting it is the one irreversible way to be wrong, so keep and report.
        const sealedBy = this.readKey(path);
        if (sealedBy && this.cipher && !this.cipher.knows(sealedBy.kid)) {
          out.foreign = (out.foreign ?? 0) + 1;
          continue;
        }
        out.deleted++;
        out.bytes += fileSize(path) ?? 0;
        if (!opts.dryRun) {
          // Key first, like `delete`: a sealed payload whose DEK is gone is already unrecoverable,
          // so an interrupted pass leaves shredded bytes rather than readable ones.
          removeFile(`${path}.key`);
          removeFile(path);
        }
      }
    }
    return out;
  }
}

/**
 * One store to write, several to read: how a space changes blob backend without rewriting a
 * record.
 *
 * A record names bytes by content address, so switching from a local directory to an object store
 * would otherwise dangle every artifact written before the switch. Reads fall through the layers
 * in order, writes go to the FIRST, and a cold blob keeps reading from wherever it already is.
 * `FileBlobStore.findPath` does the same thing for its two naming regimes; this is that move one
 * level up, over whole stores.
 *
 * Two operations fan out to EVERY layer, both for correctness rather than tidiness: `delete`,
 * since an erasure that reached one copy is not an erasure, and `retainOnly`, whose keep set comes
 * from the shared record store and is therefore authoritative for all of them.
 *
 * A read never copies into the primary. Read-through migration would turn a GET into a write,
 * resurrect bytes a sweep just reclaimed, and hide how much is left to move. Re-putting the
 * payloads is the explicit way to finish.
 */
export class MigratingBlobStore implements BlobStore {
  readonly name: string;
  readonly sealed: boolean;
  private readonly layers: BlobStore[];

  /** Present when ANY layer can rewrap: a stack whose primary seals and whose origin does not still
   *  has payloads to re-seal, and `sealed` (which is "every layer") would refuse that case. */
  readonly rewrap?: (liveDigests: ReadonlySet<string>, opts?: { dryRun?: boolean }) => Promise<RewrapResult>;

  constructor(primary: BlobStore, ...origins: BlobStore[]) {
    this.layers = [primary, ...origins];
    if (this.layers.some((l) => l.rewrap)) this.rewrap = (live, opts) => this.#rewrap(live, opts ?? {});
    this.name = `migrating(${this.layers.map((l) => l.name).join(" <- ")})`;
    // EVERY layer, because the answer decides whether a shred is reported as crypto-shred, and a
    // plaintext origin's copy was merely deleted however well the primary seals.
    this.sealed = this.layers.every((l) => l.sealed);
  }

  put(bytes: Uint8Array): Promise<BlobRef> {
    return this.layers[0].put(bytes);
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    for (const layer of this.layers) {
      const stream = await layer.get(digest);
      if (stream) return stream;
    }
    return null;
  }

  async stat(digest: string): Promise<BlobRef | null> {
    for (const layer of this.layers) {
      const ref = await layer.stat(digest);
      if (ref) return ref;
    }
    return null;
  }

  async delete(digest: string): Promise<void> {
    for (const layer of this.layers) await layer.delete(digest);
  }

  /** Every layer rewraps its own copies. A blob living in two layers is re-sealed in both, which is
   *  what "the retired key can be destroyed" has to mean when more than one store holds bytes. */
  async #rewrap(liveDigests: ReadonlySet<string>, opts: { dryRun?: boolean }): Promise<RewrapResult> {
    const out = emptyRewrap();
    for (const layer of this.layers) {
      if (!layer.rewrap) continue;
      const r = await layer.rewrap(liveDigests, opts);
      out.scanned += r.scanned;
      out.rewrapped += r.rewrapped;
      out.already += r.already;
      out.foreign += r.foreign;
      out.bytes += r.bytes;
      // `missing` counts a digest no layer holds, so it is the MINIMUM across layers rather than
      // the sum: absent from one store and present in the next is not missing.
      out.missing = out.missing === 0 ? r.missing : Math.min(out.missing, r.missing);
    }
    return out;
  }

  async retainOnly(liveDigests: ReadonlySet<string>, opts: { graceMs: number; dryRun?: boolean; nowMs?: number }): Promise<BlobGcResult> {
    const out: BlobGcResult = { scanned: 0, deleted: 0, bytes: 0 };
    for (const layer of this.layers) {
      const r = await layer.retainOnly(liveDigests, opts);
      out.scanned += r.scanned;
      out.deleted += r.deleted;
      out.bytes += r.bytes;
      if (r.foreign) out.foreign = (out.foreign ?? 0) + r.foreign;
    }
    return out;
  }
}

/** A digest is 64 lowercase hex chars, the only shape allowed to become a path component. */
export function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
