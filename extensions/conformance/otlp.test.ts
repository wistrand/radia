// The OTLP projection's contract.
//
//   deno task extensions
//
// Pure functions only, no running space: what is pinned here is the MAPPING — deterministic ids
// (re-export dedupes in the collector instead of double-counting), the tree-with-links rule
// (first parent nests, every other parent is a Link, because provenance is a DAG and a trace is
// a tree), attempt spans as take→settle intervals with status from the settle verb, and the
// honesty attributes. The CLI verb's plumbing (membership walk, event scan, follow loop) is
// ordinary client code over reads other suites already cover.

import { assert, assertEquals } from "@std/assert";
import { agentOf, buildThreadSpans, recordSpans, spanIdOf, traceIdOf } from "../ts/otlp.ts";
import type { RadiaRecord } from "../../sdk/ts/client.ts";
import type { SpaceEvent } from "../../sdk/ts/wire.ts";

function rec(
  id: string,
  kind: string,
  opts: { by?: string; parents?: string[]; taint?: string[]; at?: string; chain?: string[] } = {},
): RadiaRecord {
  return {
    id,
    kind,
    body: {},
    runtimeMeta: {
      createdBy: opts.by ?? "run:agent:planner:01J0000000000000000000000A",
      parentIds: opts.parents ?? [],
      taint: opts.taint ?? [],
      schemaVersion: 1,
      createdAt: opts.at ?? "2026-08-06T10:00:00.000Z",
      ...(opts.chain ? { delegationContext: { chain: opts.chain, origin: "01X" } } : {}),
    },
  } as unknown as RadiaRecord;
}
function ev(recordId: string, operation: string, ts: string, extra: Record<string, unknown> = {}): SpaceEvent {
  return {
    seq: 1,
    id: "e",
    ts,
    runId: (extra.runId as string) ?? "run:agent:worker:01J0000000000000000000000B",
    operation,
    recordId,
    ...extra,
  } as unknown as SpaceEvent;
}

Deno.test("[otlp] ids are deterministic and hex-sized, and the payload is OTLP JSON", async () => {
  const job = rec("01JOB", "job");
  const task = rec("01TASK", "task", { parents: ["01JOB"], taint: ["net"] });
  const events = [ev("01TASK", "take", "2026-08-06T10:00:01.000Z"), ev("01TASK", "ack", "2026-08-06T10:00:03.000Z")];
  const a = await buildThreadSpans([job, task], events, "01JOB");
  const b = await buildThreadSpans([job, task], events, "01JOB");
  assertEquals(JSON.stringify(a), JSON.stringify(b), "same history, same bytes: the export is idempotent");
  assert(a.length >= 2, "record spans and attempt spans group under their own services");
  for (const rs of a) {
    assert(rs.resource.attributes.some((x) => x.key === "service.name"));
    for (const s of rs.scopeSpans[0].spans) {
      assertEquals(s.traceId.length, 32);
      assertEquals(s.spanId.length, 16);
      assert(/^[0-9a-f]+$/.test(s.traceId) && /^[0-9a-f]+$/.test(s.spanId), "OTLP JSON carries trace/span ids as HEX");
      assert(/^\d+$/.test(s.startTimeUnixNano) && /^\d+$/.test(s.endTimeUnixNano), "nanos are uint64 STRINGS");
      assertEquals(s.traceId, await traceIdOf("01JOB"), "one thread, one trace");
    }
  }
  const taskSpan = a.flatMap((r) => r.scopeSpans[0].spans)
    .find((s) => s.attributes.some((x) => x.key === "radia.record.id" && x.value.stringValue === "01TASK"))!;
  assertEquals(
    taskSpan.attributes.find((x) => x.key === "radia.taint")!.value.arrayValue!.values.map((v) => v.stringValue),
    ["net"],
    "taint travels as LABELS",
  );
});

Deno.test("[otlp] a trace is a tree with links: the first parent nests, every other parent links", async () => {
  const a = rec("01A", "job"), b = rec("01B", "fact"), c = rec("01C", "task", { parents: ["01A", "01B"] });
  const spans = (await buildThreadSpans([a, b, c], [], "01A")).flatMap((r) => r.scopeSpans[0].spans);
  const cSpan = spans.find((s) => s.attributes.some((x) => x.key === "radia.record.id" && x.value.stringValue === "01C"))!;
  assertEquals(cSpan.parentSpanId, await spanIdOf("01A"));
  assertEquals(cSpan.links, [{ traceId: await traceIdOf("01A"), spanId: await spanIdOf("01B") }]);
  const rootSpan = spans.find((s) => s.attributes.some((x) => x.key === "radia.record.id" && x.value.stringValue === "01A"))!;
  assertEquals(rootSpan.parentSpanId, undefined, "the root has no parent");
});

Deno.test("[otlp] attempts are the spans: take→settle under the record span, status from the verb", async () => {
  const t = rec("01T", "task");
  const events = [
    ev("01T", "take", "2026-08-06T10:00:01.000Z"),
    ev("01T", "nack", "2026-08-06T10:00:02.000Z", { state: "available" }),
    ev("01T", "take", "2026-08-06T10:00:05.000Z", { runId: "run:agent:other:01J0000000000000000000000C" }),
    ev("01T", "ack", "2026-08-06T10:00:09.000Z"),
  ];
  const spans = await recordSpans(t, events, "01T");
  const attempts = spans.filter((s) => s.span.name.includes("attempt"));
  assertEquals(attempts.length, 2);
  assertEquals(attempts[0].span.status?.code, 2, "a nack is a failed attempt");
  assertEquals(attempts[1].span.status?.code, 1, "an ack succeeds");
  assertEquals(attempts[0].span.parentSpanId, await spanIdOf("01T"), "attempts nest under their record");
  assertEquals(attempts[0].service, "agent:worker");
  assertEquals(attempts[1].service, "agent:other", "the service is the CLAIMING agent, per attempt");
  const recSpan = spans.find((s) => s.span.name === "task")!.span;
  assertEquals(recSpan.endTimeUnixNano, String(Date.parse("2026-08-06T10:00:09.000Z")) + "000000", "the record span closes at its terminal ack");
  assert(!recSpan.attributes.some((x) => x.key === "radia.open"));
});

Deno.test("[otlp] honesty: unsettled claimable work is OPEN; reference data never is", async () => {
  const open = (await recordSpans(rec("01O", "task"), [], "01O"))[0].span;
  assert(open.attributes.some((x) => x.key === "radia.open"), "claimable and unsettled says so");
  assertEquals(open.startTimeUnixNano, open.endTimeUnixNano, "no invented end: zero duration");
  const ref = (await recordSpans(rec("01R", "fact"), [], "01R", { claimable: false }))[0].span;
  assert(!ref.attributes.some((x) => x.key === "radia.open"), "reference data sits available by design");
});

Deno.test("[otlp] agentOf strips the run instance and keeps the agent", () => {
  assertEquals(agentOf("run:agent:tools:01J0000000000000000000000D"), "agent:tools");
  assertEquals(agentOf("human:local"), "human:local");
  assertEquals(agentOf("agent:x"), "agent:x");
});
