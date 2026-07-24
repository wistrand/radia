// Entry point for `deno task conformance`. Registers all suites against all adapters.
// Add each phase's suite to the array as it lands.

import { conformance } from "./harness.ts";
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
]);
