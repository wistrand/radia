// Entry point for `deno task conformance`. Registers all suites against all adapters.
// Add each phase's suite to the array as it lands.

import { blobConformance, blobCryptoConformance, conformance } from "./harness.ts";
import { adapters } from "./adapters.ts";
import { smokeSuites } from "./suites/smoke.ts";
import { recordSuites } from "./suites/records.ts";
import { kindSuites } from "./suites/kinds.ts";
import { matchingSuites } from "./suites/matching.ts";
import { pushdownSuites } from "./suites/pushdown.ts";
import { graphSuites } from "./suites/graph.ts";
import { claimFairnessSuites, leaseSuites } from "./suites/leases.ts";
import { idempotencySuites } from "./suites/idempotency.ts";
import { eventSuites } from "./suites/events.ts";
import { faultSuites } from "./suites/faults.ts";
import { watchSuites } from "./suites/watches.ts";
import { adminSuites, remediateSuites } from "./suites/admin.ts";
import { authSuites } from "./suites/auth.ts";
import { taintSuites } from "./suites/taint.ts";
import { blobCryptoSuites, blobSuites } from "./suites/blobs.ts";
import { FileBlobStore, MemoryBlobStore } from "../src/storage/blobs.ts";
import { BlobCipher } from "../src/storage/crypto.ts";

conformance(adapters, [
  ...smokeSuites,
  ...recordSuites,
  ...kindSuites,
  ...matchingSuites,
  ...pushdownSuites,
  ...graphSuites,
  ...leaseSuites,
  ...claimFairnessSuites,
  ...idempotencySuites,
  ...eventSuites,
  ...faultSuites,
  ...watchSuites,
  ...adminSuites,
  ...remediateSuites,
  ...authSuites,
  ...taintSuites,
]);

// The blob port (artifact bytes) runs the same drift guard: every implementation, same suite —
// and ENCRYPTED stores are implementations, not a variant that gets its own weaker contract. If
// sealing a payload changed any observable behaviour, these four columns would disagree.
const kekBytes = new Uint8Array(32).fill(7); // fixed key: conformance must be deterministic
const cipher = await BlobCipher.fromKey(kekBytes);
blobConformance([
  { name: "memory", create: () => new MemoryBlobStore() },
  { name: "file", create: () => new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-" })) },
  { name: "memory+enc", create: () => new MemoryBlobStore(cipher) },
  { name: "file+enc", create: () => new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-enc-" }), cipher) },
], blobSuites);

// Properties that only exist once a store encrypts.
blobCryptoConformance(cipher, kekBytes, blobCryptoSuites);
