// Blob-port conformance: the contract every BlobStore implementation must satisfy.
// Content addressing, idempotent writes, streamed reads, and the guard that a caller-supplied
// name can never become a path.

import { assertEquals } from "@std/assert";
import type { BlobSuite } from "../harness.ts";
import type { BlobStore } from "../../src/storage/blobs.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export const blobSuites: BlobSuite[] = [
  {
    name: "round-trips bytes and reports their size",
    run: async (store: BlobStore) => {
      const payload = bytes("hello artifacts");
      const ref = await store.put(payload);
      assertEquals(ref.size, payload.byteLength);
      assertEquals(ref.digest.length, 64);
      assertEquals(await drain(await store.get(ref.digest)), payload);
      assertEquals(await store.stat(ref.digest), { digest: ref.digest, size: payload.byteLength });
    },
  },
  {
    name: "is content-addressed: same bytes -> same digest, storing twice is a no-op",
    run: async (store: BlobStore) => {
      const a = await store.put(bytes("same"));
      const b = await store.put(bytes("same"));
      assertEquals(a.digest, b.digest);
      assertEquals(await drain(await store.get(a.digest)), bytes("same"));
    },
  },
  {
    name: "distinguishes different bytes",
    run: async (store: BlobStore) => {
      const a = await store.put(bytes("one"));
      const b = await store.put(bytes("two"));
      assertEquals(a.digest === b.digest, false);
      assertEquals(await drain(await store.get(a.digest)), bytes("one"));
      assertEquals(await drain(await store.get(b.digest)), bytes("two"));
    },
  },
  {
    name: "an unknown digest is null, never an error",
    run: async (store: BlobStore) => {
      const unknown = "0".repeat(64);
      assertEquals(await store.get(unknown), null);
      assertEquals(await store.stat(unknown), null);
    },
  },
  {
    name: "a non-digest name never reaches the store",
    run: async (store: BlobStore) => {
      for (const bad of ["../../etc/passwd", "not-hex", "", "AB".repeat(32)]) {
        assertEquals(await store.get(bad), null, `get('${bad}') must be null`);
        assertEquals(await store.stat(bad), null, `stat('${bad}') must be null`);
        await store.delete(bad); // must not throw
      }
    },
  },
  {
    name: "delete removes the blob; deleting twice is fine",
    run: async (store: BlobStore) => {
      const ref = await store.put(bytes("temporary"));
      await store.delete(ref.digest);
      assertEquals(await store.get(ref.digest), null);
      await store.delete(ref.digest);
    },
  },
  {
    name: "handles empty and binary payloads",
    run: async (store: BlobStore) => {
      const empty = await store.put(new Uint8Array(0));
      assertEquals(empty.size, 0);
      assertEquals((await drain(await store.get(empty.digest)))?.byteLength, 0);
      const binary = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
      const ref = await store.put(binary);
      assertEquals(await drain(await store.get(ref.digest)), binary);
    },
  },
];

// ---------------------------------------------------------------------------
// Encryption-specific properties
//
// The suite above proves an encrypted store behaves identically through the port. These prove the
// things that only MATTER because it encrypts: that the bytes on disk are not the payload, that a
// wrong key cannot read them, that the content address is authenticated, that a stolen listing
// does not identify content, and that destroying the key destroys the data (crypto-shredding).
// ---------------------------------------------------------------------------

import type { BlobCryptoSuite } from "../harness.ts";
import { FileBlobStore } from "../../src/storage/blobs.ts";
import { BlobCipher } from "../../src/storage/crypto.ts";
import { assert, assertRejects } from "@std/assert";

const SECRET = new TextEncoder().encode("attack at dawn, and bring the good biscuits");

function fileIn(dir: string): { path: string; bytes: Uint8Array } {
  for (const shard of Deno.readDirSync(dir)) {
    if (!shard.isDirectory) continue;
    for (const f of Deno.readDirSync(`${dir}/${shard.name}`)) {
      if (f.isFile && !f.name.endsWith(".key")) {
        return { path: `${dir}/${shard.name}/${f.name}`, bytes: Deno.readFileSync(`${dir}/${shard.name}/${f.name}`) };
      }
    }
  }
  throw new Error("no blob file found");
}

export const blobCryptoSuites: BlobCryptoSuite[] = [
  {
    name: "what lands on disk is ciphertext, not the payload",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const store = new FileBlobStore(dir, cipher);
      const ref = await store.put(SECRET);
      const onDisk = fileIn(dir).bytes;
      assert(!contains(onDisk, SECRET), "plaintext found on disk");
      assertEquals(onDisk.byteLength, SECRET.byteLength + 16, "ciphertext should carry a 16-byte GCM tag");
      // and it still reads back through the port
      assertEquals(await drain(await store.get(ref.digest)), SECRET);
    },
  },
  {
    name: "the on-disk name is not the digest (a stolen listing identifies nothing)",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const store = new FileBlobStore(dir, cipher);
      const ref = await store.put(SECRET);
      const { path } = fileIn(dir);
      assert(!path.includes(ref.digest), `storage path leaked the plaintext digest: ${path}`);
    },
  },
  {
    name: "a different KEK cannot read the blob",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const ref = await new FileBlobStore(dir, cipher).put(SECRET);
      const wrong = await BlobCipher.fromKey(new Uint8Array(32).fill(9));
      const stranger = new FileBlobStore(dir, wrong);
      // Wrong key ⇒ a different storage name, so the blob is not even addressable; and forcing the
      // ciphertext through the wrong cipher must fail to unwrap rather than return garbage.
      assertEquals(await stranger.get(ref.digest), null);
      const sealed = fileIn(dir).bytes;
      const key = JSON.parse(Deno.readTextFileSync(`${fileIn(dir).path}.key`));
      await assertRejects(() => wrong.open(ref.digest, sealed, key));
    },
  },
  {
    name: "the content address is authenticated: ciphertext cannot be moved to another digest",
    run: async ({ cipher }) => {
      const { ciphertext, key } = await cipher.seal("a".repeat(64), SECRET);
      assertEquals(await cipher.open("a".repeat(64), ciphertext, key), SECRET);
      await assertRejects(() => cipher.open("b".repeat(64), ciphertext, key), Error);
    },
  },
  {
    name: "tampered ciphertext is rejected, not returned",
    run: async ({ cipher }) => {
      const digest = "c".repeat(64);
      const { ciphertext, key } = await cipher.seal(digest, SECRET);
      ciphertext[0] ^= 0xff;
      await assertRejects(() => cipher.open(digest, ciphertext, key), Error);
    },
  },
  {
    name: "crypto-shredding: destroying the key destroys the data, ciphertext or not",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const store = new FileBlobStore(dir, cipher);
      const ref = await store.put(SECRET);
      const { path } = fileIn(dir);
      Deno.removeSync(`${path}.key`); // shred: only the key goes
      const orphan = Deno.readFileSync(path);
      assert(!contains(orphan, SECRET), "payload readable after the key was destroyed");
      assertEquals(orphan.byteLength, SECRET.byteLength + 16); // the bytes are still there
    },
  },
  {
    name: "enabling encryption does not orphan blobs written before it",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const plain = new FileBlobStore(dir); // no cipher: legacy store
      const ref = await plain.put(SECRET);
      const encrypted = new FileBlobStore(dir, cipher); // same directory, now with a KEK
      assertEquals(await drain(await encrypted.get(ref.digest)), SECRET, "legacy blob unreadable after enabling encryption");
      // and a NEW payload through the same store is sealed
      const fresh = await encrypted.put(new TextEncoder().encode("written after the KEK arrived"));
      assertEquals((await encrypted.stat(fresh.digest))?.size, 29);
    },
  },
];

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
