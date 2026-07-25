// Entry point for `deno task conformance`. Registers all suites against all adapters.
// Add each phase's suite to the array as it lands.

import { blobConformance, conformance } from "./harness.ts";
import { adapters } from "./adapters.ts";
import { smokeSuites } from "./suites/smoke.ts";
import { recordSuites } from "./suites/records.ts";
import { kindSuites } from "./suites/kinds.ts";
import { matchingSuites } from "./suites/matching.ts";
import { leaseSuites } from "./suites/leases.ts";
import { idempotencySuites } from "./suites/idempotency.ts";
import { eventSuites } from "./suites/events.ts";
import { faultSuites } from "./suites/faults.ts";
import { watchSuites } from "./suites/watches.ts";
import { adminSuites } from "./suites/admin.ts";
import { authSuites } from "./suites/auth.ts";
import { taintSuites } from "./suites/taint.ts";
import { blobSuites } from "./suites/blobs.ts";
import { FileBlobStore, MemoryBlobStore } from "../src/storage/blobs.ts";

conformance(adapters, [
  ...smokeSuites,
  ...recordSuites,
  ...kindSuites,
  ...matchingSuites,
  ...leaseSuites,
  ...idempotencySuites,
  ...eventSuites,
  ...faultSuites,
  ...watchSuites,
  ...adminSuites,
  ...authSuites,
  ...taintSuites,
]);

// The blob port (artifact bytes) runs the same drift guard: every implementation, same suite.
blobConformance([
  { name: "memory", create: () => new MemoryBlobStore() },
  { name: "file", create: () => new FileBlobStore(Deno.makeTempDirSync({ prefix: "radia-blobs-" })) },
], blobSuites);
