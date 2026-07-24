// Phase 0 smoke suite: every adapter boots, exposes a DB clock, and closes cleanly.
// Later phases add put/readOne, take/lease, idempotency, and event-log suites here.

import { assert } from "@std/assert";
import type { Suite } from "../harness.ts";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

export const smokeSuites: Suite[] = [
  {
    name: "now() returns a UTC ISO timestamp from the DB clock",
    run: (a) =>
      a.now().then((t) => {
        assert(typeof t === "string" && t.length > 0, "now() returned empty");
        assert(ISO_UTC.test(t), `now() not ISO UTC: ${t}`);
      }),
  },
];
