// Artifact bytes: the blob port, and what encryption costs.
//
// The pair of rows that matters is `file` vs `file+aes-gcm` at the same payload size — that
// difference is the price of confidentiality at rest, and it is the number to quote when someone
// asks whether to turn the KEK on.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";
import { FileBlobStore, MemoryBlobStore } from "../../src/storage/blobs.ts";
import { BlobCipher } from "../../src/storage/crypto.ts";

const payload = (bytes: number) => {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = i & 0xff;
  return b;
};

async function drain(s: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!s) return 0;
  let n = 0;
  for await (const c of s) n += c.byteLength;
  return n;
}

export const blobBenches: Bench[] = [
  {
    name: "blobs",
    note: "put hashes (sha256 over plaintext) then writes; get streams. Encrypted rows add AES-GCM plus a wrapped-key sidecar, and cannot stream — the tag is verified over the whole ciphertext.",
    run: async (ctx) => {
      const out: Measurement[] = [];
      const cipher = await BlobCipher.fromKey(new Uint8Array(32).fill(11));
      const dir = () => Deno.makeTempDirSync({ prefix: "radia-bench-" });
      const stores = [
        ["memory", new MemoryBlobStore()],
        ["file", new FileBlobStore(dir())],
        ["file+aes-gcm", new FileBlobStore(dir(), cipher)],
      ] as const;
      for (const [name, store] of stores) {
        for (const size of [4 * 1024, 256 * 1024]) {
          const label = `${size >= 1024 * 1024 ? `${size / 1024 / 1024}MB` : `${size / 1024}KB`}`;
          const reps = Math.max(5, Math.round(20 * ctx.scale / (size > 100_000 ? 4 : 1)));
          // Distinct bytes per iteration: identical payloads dedup to one object and would
          // measure the skip-the-write path instead of the write.
          out.push(await measure(`${name} put ${label}`, reps, (i) => {
            const b = payload(size);
            b[0] = i & 0xff;
            b[1] = (i >> 8) & 0xff;
            return store.put(b);
          }));
          const ref = await store.put(payload(size));
          out.push(await measure(`${name} get ${label}`, reps, async () => await drain(await store.get(ref.digest))));
        }
      }
      return out;
    },
  },
];
