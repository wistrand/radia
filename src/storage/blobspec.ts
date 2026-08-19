// Where a space keeps artifact bytes, as one string.
//
// `--blobs` used to be a directory and nothing else, which made "put the artifacts where every
// instance can reach them" a code change. A spec names a store instead:
//
//   /var/lib/radia/blobs            a directory (the old form, unchanged)
//   file:/var/lib/radia/blobs       the same, said explicitly
//   memory                          in-process, the ephemeral default
//   s3://bucket/prefix              an object store (src/storage/s3.ts; credentials from the env)
//
// A COMMA-SEPARATED list is a migration: the first entry takes every write, the rest are read-only
// origins searched in order (`MigratingBlobStore`). That is what makes changing backend possible at
// all, since a record names its bytes by content address and cannot be rewritten to point
// somewhere else:
//
//   --blobs s3://bucket/prefix,/var/lib/radia/blobs
//
// Reads fall through to the old directory while every new write lands in the bucket, and both are
// swept and shredded together. Nothing copies in the background; re-putting the payloads is the
// explicit way to finish and drop the second entry.

import { type BlobStore, FileBlobStore, MemoryBlobStore, MigratingBlobStore } from "./blobs.ts";
import type { BlobCipher } from "./crypto.ts";
import { parseS3Spec, S3BlobStore } from "./s3.ts";
import { env, UsageError } from "../platform.ts";

/** Build the store a spec names. `undefined` is in-memory, which is what an ephemeral space wants:
 *  a filesystem home would outlive the records that reference it. */
export function openBlobs(spec: string | undefined, cipher?: BlobCipher): BlobStore {
  if (spec === undefined || spec === "") return new MemoryBlobStore(cipher);
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return new MemoryBlobStore(cipher);
  const [primary, ...origins] = parts.map((p) => openOne(p, cipher));
  return origins.length === 0 ? primary : new MigratingBlobStore(primary, ...origins);
}

function openOne(spec: string, cipher?: BlobCipher): BlobStore {
  if (spec === "memory" || spec === "memory:") return new MemoryBlobStore(cipher);
  if (spec.startsWith("s3://")) {
    try {
      return new S3BlobStore(parseS3Spec(spec, env), cipher);
    } catch (e) {
      // A bad bucket URL or a missing key is CLI input, so it should read as one rather than as a
      // storage failure at the first artifact.
      throw new UsageError(`--blobs ${spec}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (spec.startsWith("file:")) return new FileBlobStore(spec.replace(/^file:(\/\/)?/, ""), cipher);
  // Anything else is a path, which is what `--blobs <dir>` always meant.
  if (/^[a-z][a-z0-9+.-]+:\/\//.test(spec)) throw new UsageError(`--blobs: unknown scheme in '${spec}' (expected a directory, file:, memory or s3://)`);
  return new FileBlobStore(spec, cipher);
}
