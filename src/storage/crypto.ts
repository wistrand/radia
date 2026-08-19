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
  /**
   * WHICH KEK wrapped this DEK, derived from the key rather than assigned, so two processes holding
   * the same key agree without being told (`BlobCipher.kid`).
   *
   * Absent on everything written before key ids existed, which `open` reads as "the current key":
   * that is exactly what it was. It exists so a rotation can say what it is. Without it, a payload
   * sealed under a retired key is indistinguishable from a corrupt one, and from another space's
   * object, which is the difference between keeping it and deleting it (see `retainOnly`).
   */
  kid?: string;
}

/** One KEK: what it wraps DEKs with, what it names blobs with, and how it is identified. */
interface KekEntry {
  kid: string;
  kek: CryptoKey; // AES-KW
  namer: CryptoKey; // HMAC, for storage names
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
  /**
   * ONE key writes, several may read. Rotation is otherwise not a configuration change but a
   * migration: storage names are HMAC(KEK, digest), so a new key renames every blob, and a sweep
   * that cannot recognise the old names deletes the payloads it cannot see.
   */
  private constructor(
    private readonly current: KekEntry,
    /** Keys kept for READS only, newest first. Nothing is ever written under one. */
    private readonly retired: KekEntry[],
  ) {}

  /** Build a cipher from 32 raw key bytes, plus any retired keys whose blobs must still read. */
  static async fromKey(raw: Uint8Array, retired: Uint8Array[] = []): Promise<BlobCipher> {
    return new BlobCipher(await kekEntry(raw), await Promise.all(retired.map(kekEntry)));
  }

  /** The key new blobs are sealed under. Stamped into every `SealedKey` this cipher writes. */
  get kid(): string {
    return this.current.kid;
  }

  /** Does this space hold the key a `SealedKey` names? `undefined` is the pre-kid regime, which is
   *  the current key by definition. */
  knows(kid: string | undefined): boolean {
    return kid === undefined || kid === this.current.kid || this.retired.some((e) => e.kid === kid);
  }

  /** The storage name for a plaintext digest. Reveals nothing about the content it addresses. */
  async storageName(digest: string): Promise<string> {
    return await nameUnder(this.current, digest);
  }

  /** Every name this digest could be stored under: the current key first, then each retired one.
   *  Reads walk it in order; a sweep keeps ALL of them, or rotation becomes deletion. */
  async storageNames(digest: string): Promise<string[]> {
    const names = [await nameUnder(this.current, digest)];
    for (const e of this.retired) names.push(await nameUnder(e, digest));
    return names;
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
    const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, this.current.kek, "AES-KW"));
    return {
      ciphertext,
      key: { wrapped: b64.encode(wrapped), nonce: b64.encode(nonce), size: plaintext.byteLength, kid: this.current.kid },
    };
  }

  /** Decrypt. Throws if the key is wrong, the ciphertext was tampered with, or it was moved to a
   *  different address (the digest is authenticated as AAD). */
  async open(digest: string, ciphertext: Uint8Array, key: SealedKey): Promise<Uint8Array> {
    const entry = key.kid === undefined || key.kid === this.current.kid
      ? this.current
      : this.retired.find((e) => e.kid === key.kid);
    // A key this space does not hold is a ROTATION, not damage, and the two want different fixes
    // while being indistinguishable from a raw decrypt failure. Say which one it is.
    if (!entry) {
      throw new UsageError(
        `this blob was sealed under KEK '${key.kid}', which this space does not hold; ` +
          `supply it as a retired key (RADIA_BLOB_KEK_RETIRED) to read blobs written before the rotation`,
      );
    }
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      buf(b64.decode(key.wrapped)),
      entry.kek,
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

/** Import one KEK: the wrapping key, the naming key, and the id both sides derive rather than agree
 *  on. Three purposes, three derivations, so no key does double duty. */
async function kekEntry(raw: Uint8Array): Promise<KekEntry> {
  if (raw.byteLength !== 32) throw new UsageError(`blob KEK must be 32 bytes, got ${raw.byteLength}`);
  const kek = await crypto.subtle.importKey("raw", buf(raw), "AES-KW", false, ["wrapKey", "unwrapKey"]);
  const nameBytes = await derive(raw, "radia/blob-name");
  const namer = await crypto.subtle.importKey("raw", buf(nameBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // 8 bytes: an identifier, not a fingerprint anyone should test candidate keys against. It is
  // derived under its own label so it reveals nothing about the naming key or the KEK itself.
  const kid = hex((await derive(raw, "radia/blob-kek-id")).slice(0, 8));
  return { kid, kek, namer };
}

async function derive(raw: Uint8Array, label: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(concat(raw, new TextEncoder().encode(label)))));
}

async function nameUnder(entry: KekEntry, digest: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", entry.namer, buf(new TextEncoder().encode(digest))));
  return hex(mac);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
export function loadKek(
  opts: { env?: string; file?: string; retiredEnv?: string },
): { key: Uint8Array; retired: Uint8Array[]; source: string } | undefined {
  // RETIRED keys read from the same places, and are READ-ONLY: nothing is ever sealed under one.
  // They exist so a rotation is a config change rather than a migration, since a blob's storage
  // name is derived from the key that sealed it.
  const retiredFrom = (raw: string | undefined, where: string): Uint8Array[] =>
    (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
      const key = b64.decode(t);
      if (key.byteLength !== 32) throw new UsageError(`${where} must be a comma-separated list of 32-byte base64 keys`);
      return key;
    });
  if (opts.env) {
    const key = b64.decode(opts.env.trim());
    if (key.byteLength !== 32) {
      throw new UsageError(
        `RADIA_BLOB_KEK must decode to 32 bytes (got ${key.byteLength}). Generate one with: ` +
          `deno eval 'console.log(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))'`,
      );
    }
    return { key, retired: retiredFrom(opts.retiredEnv, "RADIA_BLOB_KEK_RETIRED"), source: "env" };
  }
  if (!opts.file) return undefined;
  const existing = readTextFile(opts.file);
  if (existing) {
    const parsed = JSON.parse(existing) as { kek?: string; retired?: string[] };
    const key = b64.decode((parsed.kek ?? "").trim());
    if (key.byteLength !== 32) throw new UsageError(`${opts.file} does not contain a 32-byte "kek"`);
    return { key, retired: retiredFrom((parsed.retired ?? []).join(","), `${opts.file} "retired"`), source: opts.file };
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  writeTextFile(opts.file, JSON.stringify({ kek: b64.encode(key), createdAt: new Date().toISOString() }, null, 2));
  restrictToOwner(opts.file);
  return { key, retired: [], source: `${opts.file} (generated)` };
}
