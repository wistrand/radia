# A local S3 endpoint for artifact bytes

This Compose configuration runs an S3-compatible object store for a local Radia space, so
`--blobs` points at a bucket instead of a directory (`src/storage/s3.ts`,
[design-storage.md](../../agent_docs/design-storage.md) "Scaling and multi-instance operation").
Local development only: one node, no TLS, a throwaway credential in `s3-config.json`.

```sh
# 1. the endpoint (Ctrl-C stops it; `down -v` also discards the bytes)
docker compose up

# 2. a space that keeps its artifacts there
export RADIA_S3_ACCESS_KEY_ID=radialocal RADIA_S3_SECRET_ACCESS_KEY=radialocal
deno task dev --db --blobs 's3://radia/blobs?endpoint=http://127.0.0.1:9000'

# 3. moving a space that already has artifacts: writes go to the bucket, reads fall through
deno task dev --db --blobs 's3://radia/blobs?endpoint=http://127.0.0.1:9000,.radia/blobs'
```

A space starts without probing the endpoint. If the container is down, the first artifact write or
read answers `503 blob_store_unavailable` naming the host, and the space logs
`blob store unreachable`; with SSO on, that first write is the profile artifact a sign-in creates,
so a failing "Sign in with SSO" is the usual symptom. Records and the event chain are unaffected.

`--blob-kek` works exactly as it does over a directory: the payload is sealed under a per-blob DEK
wrapped by the space KEK, and only the wrapped DEK moves (into the object's `x-amz-meta-radia-key`
metadata rather than a `.key` sidecar). The KEK file stays on local disk and never enters the
bucket, which is the point: the bucket holds ciphertext, and losing the key file makes it
unreadable.

**One prefix per space, and one KEK across its instances.** A sweep deletes every 64-hex object
under the prefix its own keep set does not name, so two spaces sharing a prefix delete each other's
blobs. With encryption the names are `HMAC(KEK, digest)`, so an instance holding a different key
also computes different keep-names: it cannot read its peer's objects and sweeps them away.
`--blob-kek <file>` generates a key on first use, which is per machine, so it belongs to a
single-node space. Several instances over one bucket need `RADIA_BLOB_KEK` set to the same base64
key everywhere.

The bucket is NOT created by the space, deliberately: a running space that invents the bucket it
was pointed at turns a typo into a second, empty store instead of an error. Create it once with any
S3 client, or let the conformance harness do it (`scripts/s3-conformance.sh`, which calls
`S3BlobStore.ensureBucket`).

## Why SeaweedFS and not MinIO

MinIO was the default answer and is no longer one. Its community edition lost the admin console in
May 2025, stopped publishing public binaries and images in October 2025, went to maintenance mode
that December, and the repository was archived in April 2026; development moved to the commercial
AIStor. Old images still pull today, which is exactly what makes it a quiet dependency to inherit:
nothing fails until it does.

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) is Apache-2.0, actively developed, and one
container serves master, volume, filer and the S3 gateway. Alternatives considered:
[Garage](https://garagehq.deuxfleurs.fr/) (AGPL, aimed at multi-site clusters, needs a layout
assigned before it serves) and [RustFS](https://github.com/rustfs/rustfs) (Apache-2.0, a MinIO
drop-in, still pre-1.0 as of early 2026). Neither is wrong; both cost more setup or more risk than
this needs.

## What was verified against it

The store is the contract, not the vendor, so the check is what `S3BlobStore` actually calls
(run against this image before it was adopted):

| Behaviour | Why it matters |
|---|---|
| CreateBucket, and again with no error | `ensureBucket` runs from deployment and from the harness |
| PUT/GET/HEAD/DELETE, plaintext and sealed | the port's round-trip, with the wrapped DEK in `x-amz-meta-radia-key` |
| `stat` reporting the PLAINTEXT size of a sealed object | a sealed object is 16 bytes longer; the metadata carries the real number |
| a deduped put moving `LastModified` (self-copy, `x-amz-metadata-directive: REPLACE`) | the grace window is what stops GC eating a racing put's bytes ([plan-gc.md](../../agent_docs/plan-gc.md) phase 4) |
| ListObjectsV2 past one page (1001 objects) | a sweep that silently stops at 1000 leaves orphans forever |

The self-copy is the one worth re-checking against any other implementation: an object store has no
`utimes`, so it is the only way to refresh a blob's clock, and a backend that treats a
metadata-only self-copy as a no-op would leave the grace window inert without failing anything.
