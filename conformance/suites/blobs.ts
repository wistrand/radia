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
  {
    // Reference-aware GC (plan-gc.md phase 4): the keep set travels as DIGESTS, the store maps
    // them to its own names (an encrypted store's filenames are deliberately not digests, so the
    // reverse mapping cannot exist on this port). This suite runs against all four impls, which
    // is what proves the encrypted stores keep the right files.
    name: "retainOnly deletes only what is unreferenced AND past the grace window",
    run: async (store: BlobStore) => {
      const keep = await store.put(bytes("referenced"));
      const drop = await store.put(bytes("orphaned"));
      // Young blobs are safe whatever the keep set says: the grace is the race bound with a
      // concurrent put whose record has not committed yet.
      const young = await store.retainOnly(new Set(), { graceMs: 60_000 });
      assertEquals(young.deleted, 0, "nothing young is ever deleted");
      assertEquals(young.scanned, 2);
      // From a future vantage both are old; only the unreferenced one goes.
      const later = Date.now() + 120_000;
      const dry = await store.retainOnly(new Set([keep.digest]), { graceMs: 60_000, dryRun: true, nowMs: later });
      assertEquals(dry.deleted, 1, "a dry run counts");
      assertEquals(await drain(await store.get(drop.digest)), bytes("orphaned"), "…and deletes nothing");
      const live = await store.retainOnly(new Set([keep.digest]), { graceMs: 60_000, nowMs: later });
      assertEquals(live.deleted, 1);
      assertEquals(live.bytes > 0, true, "the reclaim reports stored bytes");
      assertEquals(await store.get(drop.digest), null);
      assertEquals(await store.stat(drop.digest), null);
      assertEquals(await drain(await store.get(keep.digest)), bytes("referenced"), "the referenced blob is untouched");
      // The address is not poisoned: the same bytes store again and read again.
      await store.put(bytes("orphaned"));
      assertEquals(await drain(await store.get(drop.digest)), bytes("orphaned"));
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
    name: "a half-written encrypted blob is a miss, never raw ciphertext, and heals on re-put",
    run: async ({ cipher, tempDir }) => {
      const parts = (dir: string) => {
        let key = "", blob = "";
        for (const sh of Deno.readDirSync(dir)) {
          for (const f of Deno.readDirSync(`${dir}/${sh.name}`)) {
            const p = `${dir}/${sh.name}/${f.name}`;
            if (f.name.endsWith(".key")) key = p;
            else blob = p;
          }
        }
        return { key, blob };
      };
      // Writing the payload and its key is two operations; a crash between them must not leave
      // something that reads as a DIFFERENT valid object. Ciphertext with no sidecar previously
      // took the plaintext path and was served as the artifact.
      for (const drop of ["key", "blob"] as const) {
        const dir = tempDir();
        const store = new FileBlobStore(dir, cipher);
        const ref = await store.put(SECRET);
        Deno.removeSync(parts(dir)[drop]);
        assertEquals(await store.get(ref.digest), null, `dropping the ${drop} must yield a miss`);
        assertEquals(await store.stat(ref.digest), null, "stat must agree with get");
        // …and a re-put repairs it, rather than seeing a file and skipping the write.
        await store.put(SECRET);
        assertEquals(await drain(await store.get(ref.digest)), SECRET, `re-put must heal a dropped ${drop}`);
      }
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
    name: "a truncated payload heals on re-put: a file existing is not proof its bytes are there",
    run: async ({ cipher, tempDir }) => {
      // `put` skipped the write whenever ANYTHING existed at the content address, which made a
      // partial write permanent. A content-addressed store has no "the next write fixes it": the
      // only party who could repair the object is the caller holding those exact bytes, and that
      // caller was the one being told to skip. Both regimes, because the plaintext one failed
      // SILENTLY: `get` streamed the truncated prefix as if it were the artifact.
      for (const c of [undefined, cipher]) {
        const label = c ? "sealed" : "plaintext";
        const dir = tempDir();
        const store = new FileBlobStore(dir, c);
        const ref = await store.put(SECRET);
        Deno.truncateSync(fileIn(dir).path, 3); // what a crash mid-write leaves behind
        await store.put(SECRET);
        assertEquals(await drain(await store.get(ref.digest)), SECRET, `re-put must heal a truncated ${label} blob`);
        assertEquals((await store.stat(ref.digest))?.size, SECRET.byteLength, `stat must agree after healing (${label})`);
      }
    },
  },
  {
    // The touch is the grace window's other half (plan-gc.md phase 4): a deduped re-put means
    // "these bytes are wanted NOW", and without the refresh a re-put of an OLD blob races GC in
    // the gap between writing bytes and committing the record — including from a second process
    // over the same directory, which no in-process latch can see.
    name: "retainOnly's grace window: a deduped re-put refreshes an old blob's clock",
    run: async ({ cipher, tempDir }) => {
      for (const c of [undefined, cipher]) {
        const label = c ? "sealed" : "plaintext";
        const dir = tempDir();
        const store = new FileBlobStore(dir, c);
        const ref = await store.put(SECRET);
        // Age the payload far past any grace: what a blob from a long-swept record looks like.
        const old = new Date(Date.now() - 86_400_000);
        Deno.utimeSync(fileIn(dir).path, old, old);
        // The re-put dedupes — and MUST bump the clock, or the next line deletes bytes whose
        // record is still being committed.
        await store.put(SECRET);
        const kept = await store.retainOnly(new Set(), { graceMs: 60_000 });
        assertEquals(kept.deleted, 0, `a just-re-put ${label} blob is young again, whatever the record store says`);
        assertEquals(await drain(await store.get(ref.digest)), SECRET);
        // Backdated again with NO re-put, the same call takes it — proving the grace, not luck.
        Deno.utimeSync(fileIn(dir).path, old, old);
        const gone = await store.retainOnly(new Set(), { graceMs: 60_000 });
        assertEquals(gone.deleted, 1, `an old unreferenced ${label} blob is reclaimed`);
        assertEquals(await store.get(ref.digest), null);
        if (c) {
          // The sidecar rides its payload's fate: a wrapped DEK for deleted ciphertext is litter
          // that stat/get would misread as damage.
          for (const shard of Deno.readDirSync(dir)) {
            if (!shard.isDirectory) continue;
            for (const f of Deno.readDirSync(`${dir}/${shard.name}`)) {
              assertEquals(f.name.endsWith(".key"), false, `orphan sidecar survived: ${f.name}`);
            }
          }
        }
      }
    },
  },
  {
    // ROTATION, which without a key id is indistinguishable from corruption and from another
    // space's object. A blob's name is HMAC(KEK, digest), so a new key renames every payload: the
    // old ones have to stay readable, stay swept-around, and be erasable by the same `delete`.
    name: "a rotated KEK still reads, still sweeps around, and still erases what the old key sealed",
    run: async ({ cipher, kek, tempDir }) => {
      const dir = tempDir();
      const old = new FileBlobStore(dir, cipher); // the pre-rotation store
      const ref = await old.put(SECRET);

      const next = new Uint8Array(32).fill(42);
      const rotated = new FileBlobStore(dir, await BlobCipher.fromKey(next, [kek]));
      assertEquals(await drain(await rotated.get(ref.digest)), SECRET, "a blob sealed under the retired key must still read");
      assertEquals((await rotated.stat(ref.digest))?.size, SECRET.byteLength);

      // The sweep keeps EVERY key's name for a live digest, or rotation would delete the estate.
      const kept = await rotated.retainOnly(new Set([ref.digest]), { graceMs: 0 });
      assertEquals(kept.deleted, 0, "a live digest sealed under a retired key was deleted");

      // A store that does NOT hold the retiring key must not delete what it cannot open, and must
      // say so rather than skipping in silence.
      const blind = new FileBlobStore(dir, await BlobCipher.fromKey(next));
      const swept = await blind.retainOnly(new Set(), { graceMs: 0 });
      assertEquals(swept.deleted, 0, "a payload sealed under an unknown key was deleted");
      assertEquals(swept.foreign, 1, "…and the skip was not reported");
      assertEquals(await drain(await rotated.get(ref.digest)), SECRET, "the bytes survived the blind sweep");

      // Erasure still reaches it: an old-key copy left behind is a readable payload after a shred.
      await rotated.delete(ref.digest);
      assertEquals(await rotated.get(ref.digest), null);
    },
  },
  {
    // The pass that FINISHES a rotation: without it, the retired key is load-bearing forever and
    // destroying it destroys data, which is the whole reason rotation existed to be wanted.
    name: "rewrap re-seals under the current key, and then the retired key can be destroyed",
    run: async ({ cipher, kek, tempDir }) => {
      const dir = tempDir();
      const old = new FileBlobStore(dir, cipher);
      const ref = await old.put(SECRET);

      const next = new Uint8Array(32).fill(77);
      const rotated = new FileBlobStore(dir, await BlobCipher.fromKey(next, [kek]));
      const live = new Set([ref.digest]);

      const preview = await rotated.rewrap!(live, { dryRun: true });
      assertEquals(preview.rewrapped, 1, "a dry run must report the work");
      assertEquals(preview.already, 0);

      const done = await rotated.rewrap!(live);
      assertEquals(done.rewrapped, 1);
      assertEquals(done.foreign, 0);
      assertEquals(await drain(await rotated.get(ref.digest)), SECRET, "re-sealed bytes must still read");

      // Idempotent: a second pass finds everything current and says so, which is the signal an
      // operator acts on before dropping the old key.
      const again = await rotated.rewrap!(live);
      assertEquals(again.rewrapped, 0);
      assertEquals(again.already, again.scanned);

      // THE POINT: a store holding only the new key reads it, and the old copy is gone.
      const alone = new FileBlobStore(dir, await BlobCipher.fromKey(next));
      assertEquals(await drain(await alone.get(ref.digest)), SECRET, "the retired key is still needed after a rewrap");
      const swept = await alone.retainOnly(live, { graceMs: 0 });
      assertEquals(swept.foreign ?? 0, 0, "an old-key copy was left behind");
    },
  },
  {
    // The two passes see different things, and the split is the point. A rewrap is DIGEST-driven,
    // so a payload sealed under a key it does not hold is not merely unopenable, it is unnameable:
    // the name is HMAC(that key, digest). Keeping such bytes is `retainOnly`'s job, which walks
    // names; the rewrap can only report that the digest has nothing it can reach.
    name: "rewrap cannot see what it cannot name, and never re-seals what it cannot verify",
    run: async ({ cipher, tempDir }) => {
      const dir = tempDir();
      const stranger = await BlobCipher.fromKey(new Uint8Array(32).fill(13));
      const ref = await new FileBlobStore(dir, stranger).put(SECRET);

      const store = new FileBlobStore(dir, cipher); // never held the sealing key
      const r = await store.rewrap!(new Set([ref.digest]));
      assertEquals(r.scanned, 0, "a payload under an unknown key is invisible to a digest-driven pass");
      assertEquals(r.missing, 1);
      assertEquals(r.rewrapped, 0);
      // And the pass that DOES see it keeps it, which is the half that prevents data loss.
      const swept = await store.retainOnly(new Set(), { graceMs: 0 });
      assertEquals(swept.foreign, 1);
      assertEquals(await drain(await new FileBlobStore(dir, stranger).get(ref.digest)), SECRET, "the payload was destroyed");

      // A digest nothing stored at all is `missing` too: erasure and GC both produce that state,
      // and a rewrap is not the verb that decides what a missing blob means.
      const empty = await store.rewrap!(new Set(["0".repeat(64)]));
      assertEquals(empty.missing, 1);
      assertEquals(empty.scanned, 0);

      // A payload at a name this store CAN compute, with its sidecar gone, is damage: `get`
      // refuses it, and a rewrap must not turn it into a re-sealed copy of raw ciphertext.
      const mine = await store.put(bytes("sealed by this store"));
      const shard = `${dir}/${(await cipher.storageName(mine.digest)).slice(0, 2)}`;
      for (const f of Deno.readDirSync(shard)) if (f.name.endsWith(".key")) Deno.removeSync(`${shard}/${f.name}`);
      const damaged = await store.rewrap!(new Set([mine.digest]));
      assertEquals(damaged.foreign, 1, "a sealed payload with no readable key was treated as rewrappable");
      assertEquals(damaged.rewrapped, 0);

      // And the case the address check is for. A PLAINTEXT blob (written before encryption) has no
      // GCM tag to catch damage, so a corrupted one would otherwise be sealed under the current key
      // at a content address its bytes do not match: damage promoted to authenticated damage.
      const legacy = tempDir();
      const before = new FileBlobStore(legacy); // no cipher
      const old = await before.put(bytes("written before the KEK arrived"));
      const dir2 = `${legacy}/${old.digest.slice(0, 2)}`;
      Deno.writeFileSync(`${dir2}/${old.digest}`, bytes("not what this address says"));
      const after = new FileBlobStore(legacy, cipher);
      const corrupt = await after.rewrap!(new Set([old.digest]));
      assertEquals(corrupt.foreign, 1, "bytes that do not hash to their address were re-sealed");
      assertEquals(corrupt.rewrapped, 0);
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
