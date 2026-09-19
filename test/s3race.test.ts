// A deduped put must never pair one writer's ciphertext with another writer's key.
//
// `S3BlobStore.put` dedupes by HEAD, then refreshes the object's clock with a copy onto itself that
// re-sends the key header the HEAD read. Two writers of the same bytes seal them under different
// data keys, so if one replaced the object between the other's HEAD and copy, the copy stamped the
// OLD key onto the NEW ciphertext: undecryptable for good. An idempotent retry through a second
// instance is exactly two such writers, and a partition made it happen (plan-cluster-bench.md,
// phase 3). The copy is now conditional on the HEAD's ETag.
//
// The interleaving is forced rather than raced: write, HEAD, replace, then the dedupe's copy with
// the stale HEAD. Skipped unless RADIA_S3_URL names a live endpoint (scripts/s3-conformance.sh).

import { assert, assertEquals } from "@std/assert";
import { parseS3Spec, S3BlobStore } from "../src/storage/s3.ts";
import { BlobCipher } from "../src/storage/crypto.ts";

const S3_URL = Deno.env.get("RADIA_S3_URL");

// The private steps of `put`, named so the test reads as the interleaving it forces.
interface Internals {
  head(name: string): Promise<{ keyHeader?: string; etag?: string } | null>;
  touch(name: string, keyHeader?: string, etag?: string): Promise<boolean>;
  putObject(name: string, body: Uint8Array, headers: Record<string, string>): Promise<void>;
}

async function text(s: ReadableStream<Uint8Array> | null): Promise<string> {
  assert(s, "the blob is missing");
  return await new Response(s).text();
}

Deno.test({
  name: "[blobs:s3 race] a dedupe's copy after another writer replaced the object is refused, and the blob still reads",
  ignore: !S3_URL,
  fn: async () => {
    const url = new URL(S3_URL!);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/race-${Date.now().toString(36)}`;
    const cipher = await BlobCipher.fromKey(crypto.getRandomValues(new Uint8Array(32)));
    const store = new S3BlobStore(parseS3Spec(url.toString(), (k: string) => Deno.env.get(k)), cipher);
    await store.ensureBucket();
    const s = store as unknown as Internals;

    const bytes = new TextEncoder().encode("the same payload, twice");
    const { digest } = await store.put(bytes);
    const name = await cipher.storageName(digest);

    // Writer 1 reads the object it is about to refresh.
    const seen = await s.head(name);
    assert(seen?.etag, "HEAD reported no ETag, so the copy has nothing to be conditional on");

    // Writer 2 replaces it: the same plaintext, sealed under a fresh data key.
    const { ciphertext, key } = await cipher.seal(digest, bytes);
    const header = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(key))));
    await s.putObject(name, ciphertext, { "x-amz-meta-radia-key": header });

    // Writer 1's dedupe copy, with what it read before the replacement.
    assertEquals(await s.touch(name, seen.keyHeader, seen.etag), false, "the stale copy must be refused");
    assertEquals(await text(await store.get(digest)), "the same payload, twice", "writer 2's object must still decrypt");

    // The whole put, racing nothing, still dedupes and still reads.
    await store.put(bytes);
    assertEquals(await text(await store.get(digest)), "the same payload, twice");
  },
});
