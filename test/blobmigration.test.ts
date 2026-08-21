// The properties a migration layer adds on top of the blob port, which the shared suite cannot
// see: it runs `MigratingBlobStore` with an empty origin, so nothing there distinguishes it from
// its primary.
//
// Each case below is a way the layer could silently lose a guarantee the space depends on: bytes
// that stop resolving mid-migration, an erasure that reaches one copy, a sweep that only sees half
// the store, and a `crypto-shred` claim over a plaintext copy.

import { assert, assertEquals } from "@std/assert";
import { MemoryBlobStore, MigratingBlobStore } from "../src/storage/blobs.ts";
import { BlobCipher } from "../src/storage/crypto.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
}

Deno.test("[blobs:migrating] a read falls through to an origin, and never copies into the primary", async () => {
  const origin = new MemoryBlobStore();
  const primary = new MemoryBlobStore();
  const ref = await origin.put(bytes("written before the switch"));
  const store = new MigratingBlobStore(primary, origin);

  assertEquals(await drain(await store.get(ref.digest)), "written before the switch");
  assertEquals(await store.stat(ref.digest), { digest: ref.digest, size: ref.size });
  // Read-through would turn a download into a write and resurrect bytes a sweep just reclaimed.
  assertEquals(await primary.stat(ref.digest), null, "a read must not copy into the primary");

  // A write does move it: that is the migration, and it is explicit.
  await store.put(bytes("written before the switch"));
  assert(await primary.stat(ref.digest), "a put lands in the primary");
});

Deno.test("[blobs:migrating] delete reaches every layer, because an erasure that missed a copy is not one", async () => {
  const origin = new MemoryBlobStore();
  const primary = new MemoryBlobStore();
  const ref = await origin.put(bytes("erase me"));
  await primary.put(bytes("erase me"));
  const store = new MigratingBlobStore(primary, origin);

  await store.delete(ref.digest);
  assertEquals(await primary.stat(ref.digest), null);
  assertEquals(await origin.stat(ref.digest), null, "the origin's copy would still serve the bytes");
  assertEquals(await store.get(ref.digest), null);
});

Deno.test("[blobs:migrating] retainOnly sweeps every layer against one keep set", async () => {
  const origin = new MemoryBlobStore();
  const primary = new MemoryBlobStore();
  const kept = await primary.put(bytes("referenced"));
  const dropped = await origin.put(bytes("orphan in the old store"));
  const store = new MigratingBlobStore(primary, origin);

  // The keep set comes from the shared record store, so it is authoritative for both layers.
  const result = await store.retainOnly(new Set([kept.digest]), { graceMs: 0 });
  assertEquals(result.scanned, 2, "both layers are walked");
  assertEquals(result.deleted, 1);
  assert(result.bytes > 0, "the reclaim reports its bytes");
  assertEquals(await origin.stat(dropped.digest), null);
  assert(await primary.stat(kept.digest), "a live digest survives in every layer");
});

Deno.test("[blobs:migrating] sealed is false unless EVERY layer seals", async () => {
  const cipher = await BlobCipher.fromKey(new Uint8Array(32).fill(3));
  const sealed = () => new MemoryBlobStore(cipher);
  const plain = () => new MemoryBlobStore();

  // `shredArtifact` reports crypto-shred from this, and a plaintext origin's copy was merely
  // deleted, which is the weaker guarantee against anyone holding a backup.
  assertEquals(new MigratingBlobStore(sealed(), plain()).sealed, false);
  assertEquals(new MigratingBlobStore(plain(), sealed()).sealed, false);
  assertEquals(new MigratingBlobStore(sealed(), sealed()).sealed, true);
  assertEquals(new MigratingBlobStore(plain(), plain()).sealed, false);
});
