// Blob encryption at rest: envelope encryption behind the `BlobStore` port.
//
// Per-blob random DEK (AES-GCM-256) sealing the payload; the DEK wrapped under a space KEK
// (AES-KW) that comes from the environment or a key file. This is confidentiality layer 2 of
// design-observability: it covers the leak vectors disk encryption does not (backups, snapshots,
// a copied data directory) and it is what makes deletion-by-key-destruction possible.
//
// What it does NOT defend against, stated plainly so nobody mistakes the guarantee: a compromised
// runtime, or anyone who has the KEK. The runtime decrypts for any principal holding a read grant,
// so the key necessarily lives where the runtime can reach it.
//
// Four decisions worth keeping:
//
//   - The DEK is per BLOB, not per artifact record. The store is content-addressed by the
//     PLAINTEXT digest, so identical bytes are one blob that several artifact records reference;
//     they share its key. Dedup survives encryption, and shredding a blob shreds it for every
//     record referencing it. That is correct, since there is one payload.
//   - The plaintext digest is the AAD. Ciphertext moved to a different address fails to open, so
//     the content address is authenticated rather than merely conventional.
//   - Storage paths are HMAC(KEK, digest), not the digest. A content-addressed encrypted store
//     whose filenames are plaintext hashes still answers "do you hold this exact file?" to anyone
//     who steals the disk. That is a confirmation attack that costs nothing to close.
//   - The wrapped DEK lives in a sidecar beside the blob, never in the artifact record. Records
//     are immutable and crypto-shredding means DELETING the key.

import { readTextFile, restrictToOwner, UsageError, writeTextFile } from "../platform.ts";

/** AES-GCM's authentication tag, appended to the ciphertext by Web Crypto. Named because the blob
 *  store derives a sealed payload's expected on-disk length from it. */
export const GCM_TAG_BYTES = 16;

/** The per-blob key material stored alongside the ciphertext. */
export interface SealedKey {
  /** DEK wrapped under the space KEK (AES-KW). */
  wrapped: string; // base64
  /** AES-GCM nonce for the payload. */
  nonce: string; // base64
  /** Plaintext byte length. The ciphertext is 16 bytes longer (the GCM tag). */
  size: number;
}

/** Deno's lib types declare `BufferSource` as `ArrayBufferView<ArrayBuffer>`, which a plain
 *  `Uint8Array` does not satisfy. Runtime-identical; the cast keeps every crypto call readable. */
const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

/** Base64 for key material and for anything that has to survive a header or a JSON field.
 *  Exported so the S3 store can carry a `SealedKey` in object metadata without a second copy. */
export const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  },
};

export class BlobCipher {
  private constructor(
    private readonly kek: CryptoKey, // AES-KW: wraps and unwraps DEKs, never touches payloads
    private readonly namer: CryptoKey, // HMAC: turns a plaintext digest into a storage path
  ) {}

  /** Build a cipher from 32 raw key bytes. */
  static async fromKey(raw: Uint8Array): Promise<BlobCipher> {
    if (raw.byteLength !== 32) throw new UsageError(`blob KEK must be 32 bytes, got ${raw.byteLength}`);
    const kek = await crypto.subtle.importKey("raw", buf(raw), "AES-KW", false, ["wrapKey", "unwrapKey"]);
    // A separate purpose gets a separate key: derive the naming key rather than reusing the KEK
    // for a second algorithm.
    const nameBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(concat(raw, new TextEncoder().encode("radia/blob-name")))));
    const namer = await crypto.subtle.importKey("raw", buf(nameBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new BlobCipher(kek, namer);
  }

  /** The storage name for a plaintext digest. Reveals nothing about the content it addresses. */
  async storageName(digest: string): Promise<string> {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.namer, buf(new TextEncoder().encode(digest))));
    return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Encrypt a payload under a fresh DEK, binding it to its content address. */
  async seal(digest: string, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; key: SealedKey }> {
    const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: buf(nonce), additionalData: buf(new TextEncoder().encode(digest)) },
        dek,
        buf(plaintext),
      ),
    );
    const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, this.kek, "AES-KW"));
    return {
      ciphertext,
      key: { wrapped: b64.encode(wrapped), nonce: b64.encode(nonce), size: plaintext.byteLength },
    };
  }

  /** Decrypt. Throws if the key is wrong, the ciphertext was tampered with, or it was moved to a
   *  different address (the digest is authenticated as AAD). */
  async open(digest: string, ciphertext: Uint8Array, key: SealedKey): Promise<Uint8Array> {
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      buf(b64.decode(key.wrapped)),
      this.kek,
      "AES-KW",
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(b64.decode(key.nonce)), additionalData: buf(new TextEncoder().encode(digest)) },
        dek,
        buf(ciphertext),
      ),
    );
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Resolve the space KEK: `RADIA_BLOB_KEK` (base64, 32 bytes) wins, else a key file, which is
 * generated on first use. Returns undefined when neither is configured. Blobs then stay
 * plaintext, which is the default and is logged as such rather than being silently assumed.
 */
export function loadKek(opts: { env?: string; file?: string }): { key: Uint8Array; source: string } | undefined {
  if (opts.env) {
    const key = b64.decode(opts.env.trim());
    if (key.byteLength !== 32) {
      throw new UsageError(
        `RADIA_BLOB_KEK must decode to 32 bytes (got ${key.byteLength}). Generate one with: ` +
          `deno eval 'console.log(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))'`,
      );
    }
    return { key, source: "env" };
  }
  if (!opts.file) return undefined;
  const existing = readTextFile(opts.file);
  if (existing) {
    const parsed = JSON.parse(existing) as { kek?: string };
    const key = b64.decode((parsed.kek ?? "").trim());
    if (key.byteLength !== 32) throw new UsageError(`${opts.file} does not contain a 32-byte "kek"`);
    return { key, source: opts.file };
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  writeTextFile(opts.file, JSON.stringify({ kek: b64.encode(key), createdAt: new Date().toISOString() }, null, 2));
  restrictToOwner(opts.file);
  return { key, source: `${opts.file} (generated)` };
}
