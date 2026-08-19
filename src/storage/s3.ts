// S3-compatible artifact bytes: the `BlobStore` port over an object store (AWS S3, Cloudflare R2,
// SeaweedFS, anything else that speaks the same four verbs and SigV4).
//
// This is what makes the horizontal deployment real. N runtime instances share one Postgres but a
// local `FileBlobStore` is shared with nobody, so an artifact written on one instance 404s on
// every other and a shred reaches one copy (design-storage.md, "Scaling and multi-instance
// operation"). A bucket is the same store from every instance.
//
// NO SDK, on purpose: SigV4 is an HMAC-SHA256 chain over a canonical request, Web Crypto already
// has the primitive, and the alternative is a dependency tree larger than this runtime (the
// minimal-dependency invariant in CLAUDE.md). What that costs is written down rather than hidden:
// credentials come from the environment only (no provider chain, no instance metadata, no STS),
// retries are three fixed attempts, and there is no multipart upload (`maxArtifactBytes` is 32MB
// by default and the single-PUT limit is 5GB).
//
// Four things differ from the filesystem store, each because the object store is better at it:
//
//   - A PUT is ATOMIC. An interrupted upload never becomes an object, so there is no temp-name
//     rename dance and no half-written blob to heal (`FileBlobStore.writeAtomic` exists for
//     exactly that hazard).
//   - The wrapped DEK rides in OBJECT METADATA rather than a sidecar. One object, one write, so
//     the window where ciphertext exists without its key is not narrow but absent; the file
//     store's key-first ordering rule is what covers that window on a filesystem. It stays
//     destroyable, which is the invariant: deleting the object deletes the key with it.
//   - Reads STREAM. A plaintext `get` hands back the response body, so a download never buffers.
//     A sealed read still buffers, because GCM verifies its tag over the whole ciphertext.
//   - `retainOnly` is one paged LIST, not a directory walk, and `LastModified` is the grace clock.
//
// TWO CAVEATS, because both weaken a guarantee without failing anything:
//
//   - BUCKET VERSIONING, object lock and cross-region replication all keep copies a DELETE does
//     not reach. Against such a bucket a shred destroys the current version only, the erasure does
//     not hold, and the space cannot see it. Point a space at a bucket with none of them, or
//     accept that erasure there means "the live object".
//   - Credentials come from the ENVIRONMENT, never the URL. A blob spec is printed at boot and
//     lands in logs and process listings, so `s3://key:secret@bucket/…` is refused, not honoured.
//
// ONE PREFIX PER SPACE, AND ONE KEK ACROSS ITS INSTANCES. `retainOnly` deletes every 64-hex object
// under the prefix that its own keep set does not name, so a prefix shared by two spaces has each
// one's GC deleting the other's blobs. Encryption sharpens it: names are HMAC(KEK, digest), so an
// instance holding a DIFFERENT key computes different keep-names, cannot read what its peer wrote,
// and sweeps it away. `--blob-kek <file>` GENERATES a key on first use, which is per machine;
// several instances over one bucket need `RADIA_BLOB_KEK` (the same base64 key in every process).

import { httpRequest } from "../platform.ts";
import { sha256Hex } from "../core/ids.ts";
import { b64, type BlobCipher, type SealedKey } from "./crypto.ts";
import type { BlobGcResult, BlobRef, BlobStore } from "./blobs.ts";
import { isDigest } from "./blobs.ts";

/** sha256 of the empty payload: the `x-amz-content-sha256` of every request that sends no body. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The metadata header carrying a `SealedKey` (base64 JSON). S3 returns metadata on GET as well
 *  as HEAD, so a sealed read costs one request rather than two. */
const KEY_HEADER = "x-amz-meta-radia-key";

export interface S3Config {
  bucket: string;
  /** Key prefix: empty, or ending in `/`. */
  prefix: string;
  region: string;
  /** Base URL of a non-AWS endpoint (SeaweedFS, R2). Absent means AWS. */
  endpoint?: string;
  /** `<host>/<bucket>/<key>` rather than a bucket-hosted virtual host. Forced with an endpoint. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface HeadResult {
  /** The PLAINTEXT length, which is the port's contract: a sealed object is 16 bytes longer and
   *  its metadata carries the authoritative number. */
  plaintextSize: number;
  key?: SealedKey;
  /** The metadata header verbatim, so a copy can carry it forward without re-encoding. */
  keyHeader?: string;
}

export class S3BlobStore implements BlobStore {
  readonly name: string;
  readonly sealed: boolean;

  constructor(private readonly cfg: S3Config, private readonly cipher?: BlobCipher) {
    this.name = cipher ? "s3+aes-gcm" : "s3";
    this.sealed = cipher !== undefined;
  }

  /** Create the bucket if it does not exist. NOT called by the store: a running space must never
   *  invent the bucket it was pointed at, because a typo would then start quietly accumulating a
   *  second space's worth of artifacts instead of failing. Deployment and the conformance harness
   *  call it deliberately. */
  async ensureBucket(): Promise<void> {
    const res = await this.send("PUT", this.bucketUrl(), {});
    await drain(res);
    if (res.ok || res.status === 409) return; // 409: already exists and is ours
    throw new Error(`s3 create bucket ${this.cfg.bucket}: ${res.status} ${res.statusText}`);
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const digest = await sha256Hex(bytes);
    const name = this.cipher ? await this.cipher.storageName(digest) : digest;
    const found = await this.head(name);
    // Same bytes, same address: an object of the right length is already correct. Length rather
    // than a re-hash, exactly as the file store argues, and for a sealed object the length that
    // counts is the plaintext one its metadata records.
    const complete = found !== null && found.plaintextSize === bytes.byteLength && (!this.cipher || found.key !== undefined);
    if (complete) {
      // The dedupe still means "these bytes are wanted NOW": `retainOnly` reads the object's
      // clock, and without this a re-put of an old blob races the sweep.
      await this.touch(name, found.keyHeader);
      return { digest, size: bytes.byteLength };
    }
    if (this.cipher) {
      const { ciphertext, key } = await this.cipher.seal(digest, bytes);
      const header = b64.encode(new TextEncoder().encode(JSON.stringify(key)));
      await this.putObject(name, ciphertext, { [KEY_HEADER]: header });
    } else {
      await this.putObject(name, bytes, {});
    }
    return { digest, size: bytes.byteLength };
  }

  async get(digest: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!isDigest(digest)) return null; // never let a caller-supplied name become a key
    if (this.cipher) {
      const res = await this.send("GET", this.objectUrl(await this.cipher.storageName(digest)), {});
      if (res.ok) {
        const key = readKey(res.headers.get(KEY_HEADER));
        // An object at the sealed name with no key is damage, not legacy: serving it would hand
        // back raw ciphertext as the payload. The file store refuses a missing sidecar the same way.
        if (!key) {
          await drain(res);
          return null;
        }
        const ciphertext = new Uint8Array(await res.arrayBuffer());
        return oneChunk(await this.cipher.open(digest, ciphertext, key));
      }
      await drain(res);
      if (res.status !== 404) throw new Error(`s3 get ${digest}: ${res.status} ${res.statusText}`);
    }
    // The plaintext-digest home: written before encryption was turned on, or by a store with none.
    const res = await this.send("GET", this.objectUrl(digest), {});
    if (res.status === 404) {
      await drain(res);
      return null;
    }
    if (!res.ok) {
      await drain(res);
      throw new Error(`s3 get ${digest}: ${res.status} ${res.statusText}`);
    }
    return res.body; // streamed: a download never buffers the object
  }

  async stat(digest: string): Promise<BlobRef | null> {
    if (!isDigest(digest)) return null;
    if (this.cipher) {
      const found = await this.head(await this.cipher.storageName(digest));
      if (found?.key) return { digest, size: found.plaintextSize };
      if (found) return null; // sealed name, no key: `get` cannot serve it either
    }
    const plain = await this.head(digest);
    return plain ? { digest, size: plain.plaintextSize } : null;
  }

  async delete(digest: string): Promise<void> {
    if (!isDigest(digest)) return;
    // Both homes, so "gone" never depends on which regime wrote it. The key dies with the object,
    // so unlike the file store there is no ordering to get right.
    for (const name of [this.cipher ? await this.cipher.storageName(digest) : null, digest]) {
      if (!name) continue;
      await this.deleteObject(name);
    }
  }

  async retainOnly(liveDigests: ReadonlySet<string>, opts: { graceMs: number; dryRun?: boolean; nowMs?: number }): Promise<BlobGcResult> {
    const now = opts.nowMs ?? Date.now();
    // The keep set as STORAGE NAMES. The reverse mapping deliberately does not exist: an encrypted
    // store's names are HMAC(KEK, digest) so that a listing cannot answer "do you hold this file".
    const keep = new Set<string>();
    for (const d of liveDigests) {
      keep.add(d);
      if (this.cipher) keep.add(await this.cipher.storageName(d));
    }
    const out: BlobGcResult = { scanned: 0, deleted: 0, bytes: 0 };
    for await (const obj of this.list()) {
      const name = obj.key.slice(this.cfg.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(name)) continue; // not an object this store wrote
      out.scanned++;
      if (keep.has(name)) continue;
      if (now - obj.modifiedMs < opts.graceMs) continue; // young: a racing put may own it
      out.deleted++;
      out.bytes += obj.size;
      if (!opts.dryRun) await this.deleteObject(name);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Object plumbing
  // -------------------------------------------------------------------------

  private async head(name: string): Promise<HeadResult | null> {
    const res = await this.send("HEAD", this.objectUrl(name), {});
    await drain(res);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${name}: ${res.status} ${res.statusText}`);
    const keyHeader = res.headers.get(KEY_HEADER) ?? undefined;
    const key = readKey(keyHeader ?? null);
    return { plaintextSize: key ? key.size : Number(res.headers.get("content-length") ?? "0"), key, keyHeader };
  }

  private async putObject(name: string, body: Uint8Array, headers: Record<string, string>): Promise<void> {
    const res = await this.send("PUT", this.objectUrl(name), headers, body);
    await drain(res);
    if (!res.ok) throw new Error(`s3 put ${name}: ${res.status} ${res.statusText}`);
  }

  private async deleteObject(name: string): Promise<void> {
    const res = await this.send("DELETE", this.objectUrl(name), {});
    await drain(res);
    if (!res.ok && res.status !== 404) throw new Error(`s3 delete ${name}: ${res.status} ${res.statusText}`);
  }

  /** Refresh an object's clock, which is what a deduped put owes `retainOnly`'s grace window. An
   *  object store has no `utimes`, so the equivalent is a server-side copy onto itself with the
   *  metadata replaced: one request, and no bytes through this process. */
  private async touch(name: string, keyHeader?: string): Promise<void> {
    const res = await this.send("PUT", this.objectUrl(name), {
      "x-amz-copy-source": `/${this.cfg.bucket}/${encodeKey(`${this.cfg.prefix}${name}`)}`,
      "x-amz-metadata-directive": "REPLACE",
      ...(keyHeader ? { [KEY_HEADER]: keyHeader } : {}),
    });
    await drain(res);
    if (!res.ok) throw new Error(`s3 touch ${name}: ${res.status} ${res.statusText}`);
  }

  /** Every object under the prefix, paged. The caller streams, so a bucket larger than memory is a
   *  slow sweep rather than a failed one. */
  private async *list(): AsyncGenerator<{ key: string; size: number; modifiedMs: number }> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
      if (this.cfg.prefix) query.prefix = this.cfg.prefix;
      if (token) query["continuation-token"] = token;
      const res = await this.send("GET", this.bucketUrl(query), {});
      if (!res.ok) {
        await drain(res);
        throw new Error(`s3 list ${this.cfg.bucket}: ${res.status} ${res.statusText}`);
      }
      const xml = await res.text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(entry, "Key");
        const modified = Date.parse(tag(entry, "LastModified") ?? "");
        if (!key || Number.isNaN(modified)) continue;
        yield { key, size: Number(tag(entry, "Size") ?? "0"), modifiedMs: modified };
      }
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    } while (token);
  }

  private bucketUrl(query: Record<string, string> = {}): string {
    const base = this.cfg.endpoint
      ? `${this.cfg.endpoint}/${this.cfg.bucket}`
      : this.cfg.pathStyle
      ? `https://s3.${this.cfg.region}.amazonaws.com/${this.cfg.bucket}`
      : `https://${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
    return qs ? `${base}?${qs}` : base;
  }

  private objectUrl(name: string): string {
    return `${this.bucketUrl()}/${encodeKey(`${this.cfg.prefix}${name}`)}`;
  }

  /**
   * Sign and send. Three fixed attempts on a 5xx or 429, which is the smallest thing that survives
   * an S3 503 SlowDown; anything past that (jitter, budgets, per-operation policy) is a library and
   * this is not one. A retried PUT is safe because the store is content-addressed: the same bytes
   * land at the same key with the same result.
   */
  private async send(method: string, url: string, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (last) {
        await drain(last);
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
      const signed = await this.sign(method, url, headers, body);
      last = await httpRequest(url, { method, headers: signed, body: body as unknown as BodyInit | undefined });
      if (last.status < 500 && last.status !== 429) return last;
    }
    return last!;
  }

  /** SigV4. The canonical request pins the method, the path, the query, the headers named in
   *  `SignedHeaders` and a hash of the payload; anything the host adds on top travels unsigned. */
  private async sign(method: string, url: string, headers: Record<string, string>, body?: Uint8Array): Promise<Record<string, string>> {
    const u = new URL(url);
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = stamp.slice(0, 8);
    const signed: Record<string, string> = { host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp };
    for (const [k, v] of Object.entries(headers)) signed[k.toLowerCase()] = v;
    if (this.cfg.sessionToken) signed["x-amz-security-token"] = this.cfg.sessionToken;
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((k) => `${k}:${signed[k].trim()}\n`).join("");
    const canonicalQuery = [...u.searchParams.keys()].sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(u.searchParams.get(k) ?? "")}`).join("&");
    const canonicalRequest = [method, u.pathname || "/", canonicalQuery, canonicalHeaders, names.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join("\n");
    const signature = hex(await hmac(await this.signingKey(date), toSign));
    return {
      ...signed,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(";")}, Signature=${signature}`,
    };
  }

  private async signingKey(date: string): Promise<Uint8Array> {
    let key: Uint8Array = new TextEncoder().encode(`AWS4${this.cfg.secretAccessKey}`);
    for (const part of [date, this.cfg.region, "s3", "aws4_request"]) key = await hmac(key, part);
    return key;
  }
}

/**
 * Parse `s3://bucket/prefix?endpoint=…&region=…&path-style=true`.
 *
 * Credentials come from the environment and NEVER from the URL: a blob spec is printed at boot,
 * so a secret in it is a secret in the logs. `env` is a parameter rather than an import so the
 * caller stays explicit about where it read them.
 */
export function parseS3Spec(spec: string, env: (name: string) => string | undefined): S3Config {
  const u = new URL(spec);
  if (u.username || u.password) {
    throw new Error(
      "s3 credentials belong in the environment, not the URL: set RADIA_S3_ACCESS_KEY_ID and RADIA_S3_SECRET_ACCESS_KEY",
    );
  }
  const bucket = u.hostname;
  if (!bucket) throw new Error(`no bucket in blob spec '${spec}' (expected s3://bucket/prefix)`);
  const endpoint = (u.searchParams.get("endpoint") ?? env("RADIA_S3_ENDPOINT"))?.replace(/\/+$/, "") || undefined;
  const pathStyleFlag = u.searchParams.get("path-style");
  // A custom endpoint is path-style ONLY: virtual-host addressing needs DNS per bucket, which a
  // local gateway has not. Saying so beats a signature that verifies against a host nothing resolves.
  if (endpoint && pathStyleFlag === "false") throw new Error("path-style=false needs AWS: a custom endpoint is addressed as <endpoint>/<bucket>");
  const accessKeyId = env("RADIA_S3_ACCESS_KEY_ID") ?? env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("RADIA_S3_SECRET_ACCESS_KEY") ?? env("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("s3 blob storage needs RADIA_S3_ACCESS_KEY_ID and RADIA_S3_SECRET_ACCESS_KEY (AWS_* are read too)");
  }
  const rawPrefix = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  return {
    bucket,
    prefix: rawPrefix && !rawPrefix.endsWith("/") ? `${rawPrefix}/` : rawPrefix,
    region: u.searchParams.get("region") ?? env("RADIA_S3_REGION") ?? env("AWS_REGION") ?? "us-east-1",
    endpoint,
    pathStyle: endpoint !== undefined || pathStyleFlag === "true",
    accessKeyId,
    secretAccessKey,
    sessionToken: env("RADIA_S3_SESSION_TOKEN") ?? env("AWS_SESSION_TOKEN"),
  };
}

function readKey(header: string | null): SealedKey | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(b64.decode(header))) as SealedKey;
  } catch {
    return undefined;
  }
}

/** One tag's text, from a document small enough that a parser would be the heavier answer. Only
 *  names matching the digest shape are ever acted on, so an escaped key is skipped, not mis-read. */
function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
}

/** Encode a key for a URL path, keeping `/` as a separator. The signature canonicalizes the same
 *  string, so both halves have to agree on the encoding. */
function encodeKey(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

/** RFC 3986, which is what SigV4 canonicalizes with: `encodeURIComponent` leaves `!*'()` alone. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data) as unknown as BufferSource);
  return new Uint8Array(sig as ArrayBuffer);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/** Read and discard a body. An unread response body holds its connection open, and this store
 *  makes four requests where the filesystem made one syscall. */
async function drain(res: Response): Promise<void> {
  if (!res.bodyUsed) await res.body?.cancel();
}
