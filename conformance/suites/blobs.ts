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
