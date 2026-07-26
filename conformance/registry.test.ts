// Registry projections, driven by hand-made ids.
//
// A unit test, not an adapter suite: the thing under test is what `activeByKey` does with a SET of
// records, and the interesting sets are ones a single process will not produce on demand — a
// retirement and its revival in the same millisecond, records processed out of id order. Building
// the ids directly is the only way to pin those deterministically.
//
// One case is deliberately absent: two records for the same key from DIFFERENT instances in the
// same millisecond. Their order is genuinely undefined (ULID monotonicity is per process), and the
// fail-closed rule that would define it was implemented, measured against the suite, and reverted —
// it broke same-millisecond revival, which is common, to fix a cross-instance race, which is not.
// See `activeByKey`'s comment and gotchas.md.

import { assertEquals } from "@std/assert";
import { activeByKey, grantKey } from "../src/core/registry.ts";
import type { RadiaRecord } from "../src/storage/adapter.ts";

/** A record with a hand-made id. `ms` is the ULID's 10-character timestamp half; `low` stands in
 *  for the 16 random characters two instances would disagree about. */
function rec(ms: string, low: string, body: unknown): RadiaRecord {
  return {
    id: `${ms}${low.padEnd(16, "0")}`,
    kind: "grant",
    body,
    bodySha256: "",
    runtimeMeta: {
      createdBy: "human:local",
      createdAt: "2026-07-26T00:00:00.000Z",
      schemaVersion: 1,
      taint: false,
    },
  } as unknown as RadiaRecord;
}

const GRANT = { principal: "agent:w", kind: "task", operations: ["query"] };
const REVOKED = { ...GRANT, retired: true };
const MS_A = "01K0000000";
const MS_B = "01K0000001"; // one millisecond later

Deno.test("registry: a retirement and its revival in the same millisecond follow id order", () => {
  // Within one process ids are strictly increasing even inside a millisecond (monotonic ULIDs), so
  // this pair IS ordered and the revival must take. This is the case that makes "prefer the
  // retirement on a same-millisecond tie" the wrong rule.
  const revived = activeByKey([rec(MS_A, "AAA", REVOKED), rec(MS_A, "AAB", GRANT)], grantKey);
  assertEquals(revived.size, 1, "a higher id in the same millisecond is still newer");

  const revoked = activeByKey([rec(MS_A, "AAA", GRANT), rec(MS_A, "AAB", REVOKED)], grantKey);
  assertEquals(revoked.size, 0);
});

Deno.test("registry: a genuinely later re-declaration revives a retired key", () => {
  // The point of retirement-as-a-successor is that there is no un-retire path to call: you write
  // the thing again.
  const revived = activeByKey([rec(MS_A, "AAA", REVOKED), rec(MS_B, "AAA", GRANT)], grantKey);
  assertEquals(revived.size, 1);

  const seq = activeByKey(
    [rec("01K0000000", "A", GRANT), rec("01K0000001", "A", REVOKED), rec("01K0000002", "A", GRANT)],
    grantKey,
  );
  assertEquals(seq.size, 1, "grant, revoke, re-grant");
});

Deno.test("registry: retirement is per KEY, not across the registry", () => {
  const other = { principal: "agent:w", kind: "note", operations: ["query"] };
  // Revoking one grant must not take an unrelated one with it — the same mistake as keying a
  // grant on (principal, kind) instead of on its whole content.
  const view = activeByKey([rec(MS_A, "AAA", REVOKED), rec(MS_A, "ZZZ", other)], grantKey);
  assertEquals([...view.values()].length, 1);
  assertEquals((view.values().next().value!.body as { kind: string }).kind, "note");
});

Deno.test("registry: the newest record decides, whatever order the rows arrive in", () => {
  const forward = activeByKey([rec(MS_A, "A", GRANT), rec(MS_B, "A", REVOKED)], grantKey);
  assertEquals(forward.size, 0, "a later revocation wins");
  const shuffled = activeByKey([rec(MS_B, "A", REVOKED), rec(MS_A, "A", GRANT)], grantKey);
  assertEquals(shuffled.size, 0, "…and still wins when the older record is processed last");
});
