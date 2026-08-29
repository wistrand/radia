// Entry point for `deno task test:runtime`. Registers all suites against all adapters.
// Add each phase's suite to the array as it lands.

import { blobConformance, blobCryptoConformance, conformance } from "./harness.ts";
import { adapters } from "./adapters.ts";
import { smokeSuites } from "./suites/smoke.ts";
import { recordSuites } from "./suites/records.ts";
import { kindSuites } from "./suites/kinds.ts";
import { matchingSuites } from "./suites/matching.ts";
import { pushdownSuites } from "./suites/pushdown.ts";
import { graphSuites } from "./suites/graph.ts";
import { keysetSuites } from "./suites/keyset.ts";
import { retireSuites } from "./suites/retire.ts";
import { selfScopeSuites } from "./suites/selfscope.ts";
import { authHistorySuites } from "./suites/authhistory.ts";
import { claimFairnessSuites, deferredSuites, leaseSuites } from "./suites/leases.ts";
import { idempotencySuites } from "./suites/idempotency.ts";
import { eventSuites } from "./suites/events.ts";
import { integritySuites } from "./suites/integrity.ts";
import { starvationSuites } from "./suites/starvation.ts";
import { limitSuites } from "./suites/limits.ts";
import { faultSuites } from "./suites/faults.ts";
import { failoverSuites } from "./suites/failover.ts";
import { watchSuites } from "./suites/watches.ts";
import { adminSuites, remediateSuites } from "./suites/admin.ts";
import { gcSuites } from "./suites/gc.ts";
import { authSuites } from "./suites/auth.ts";
import { compartmentSuites } from "./suites/compartment.ts";
import { taintSuites } from "./suites/taint.ts";
import { blobCryptoSuites, blobSuites } from "./suites/blobs.ts";
import { FileBlobStore, MemoryBlobStore, MigratingBlobStore } from "../../src/storage/blobs.ts";
import { BlobCipher } from "../../src/storage/crypto.ts";
import { parseS3Spec, S3BlobStore } from "../../src/storage/s3.ts";

conformance(adapters, [
  ...smokeSuites,
  ...recordSuites,
  ...kindSuites,
  ...matchingSuites,
  ...pushdownSuites,
  ...graphSuites,
  ...keysetSuites,
  ...retireSuites,
  ...selfScopeSuites,
  ...authHistorySuites,
  ...leaseSuites,
  ...deferredSuites,
  ...claimFairnessSuites,
  ...idempotencySuites,
  ...eventSuites,
  ...integritySuites,
  ...starvationSuites,
  ...limitSuites,
  ...faultSuites,
  ...failoverSuites,
  ...watchSuites,
  ...adminSuites,
  ...gcSuites,
  ...remediateSuites,
  ...authSuites,
  ...compartmentSuites,
  ...taintSuites,
]);

// The blob port (artifact bytes) runs the same drift guard: every implementation, same suite.
// ENCRYPTED stores are implementations, not a variant that gets its own weaker contract. If
// sealing a payload changed any observable behaviour, these four columns would disagree.
const kekBytes = new Uint8Array(32).fill(7); // fixed key: conformance must be deterministic
const cipher = await BlobCipher.fromKey(kekBytes);
blobConformance([
  { name: "memory", create: () => new MemoryBlobStore() },
  { name: "file", create: () => new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-" })) },
  { name: "memory+enc", create: () => new MemoryBlobStore(cipher) },
  { name: "file+enc", create: () => new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-enc-" }), cipher) },
  // A migration layer is an implementation of the port, not a wrapper with its own weaker rules:
  // it runs the same suite with an EMPTY origin, which is what a fresh migration looks like.
  // The fall-through and fan-out properties are `blobmigration.test.ts`.
  {
    name: "migrating",
    create: () => new MigratingBlobStore(new MemoryBlobStore(), new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-from-" }))),
  },
], blobSuites);

// Properties that only exist once a store encrypts.
blobCryptoConformance(cipher, kekBytes, blobCryptoSuites);

// The object store joins the same matrix when a bucket is reachable, exactly as the postgres
// adapter joins on RADIA_PG_URL: a backend nobody runs the suite against is a backend that drifts,
// and this one cannot be exercised without a server (`scripts/s3-conformance.sh` starts the `docker/s3/` endpoint).
//
//   RADIA_S3_URL=s3://radia-conformance?endpoint=http://127.0.0.1:9000
//   RADIA_S3_ACCESS_KEY_ID=… RADIA_S3_SECRET_ACCESS_KEY=…
const s3Url = Deno.env.get("RADIA_S3_URL");
if (s3Url) {
  // The bucket is created ONCE here rather than by the store: a running space must never invent
  // the bucket it was pointed at. Each factory then gets its own prefix, so tests cannot see each
  // other's objects and a `retainOnly` sweep cannot reach another test's blobs.
  await new S3BlobStore(parseS3Spec(s3Url, (k: string) => Deno.env.get(k))).ensureBucket();
  let n = 0;
  const scoped = (c?: BlobCipher) => () => {
    const url = new URL(s3Url);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/t${Date.now().toString(36)}-${n++}`;
    return new S3BlobStore(parseS3Spec(url.toString(), (k: string) => Deno.env.get(k)), c);
  };
  blobConformance([
    { name: "s3", create: scoped() },
    { name: "s3+enc", create: scoped(cipher) },
  ], blobSuites);
}
