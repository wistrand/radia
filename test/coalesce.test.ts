// Single-flight read coalescing (`src/core/coalesce.ts`), and the property that makes it safe.
//
// A unit test for the primitive plus an end-to-end one through a Space, because the win is only
// real if it survives the path the SSE streams actually take (Space.getEvents and the record
// fetch inside matchesEvent). The fan-out this removes is measured in bench/suites/fanout.ts:
// 250 parked streams once cost 250 log reads and 250 record fetches for ONE write.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Coalescer } from "../src/core/coalesce.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import type { StorageAdapter } from "../src/storage/adapter.ts";

Deno.test("coalesce: concurrent identical reads become one; sequential ones do not", async () => {
  const c = new Coalescer();
  let loads = 0;
  let release!: (v: string) => void;
  const gate = new Promise<string>((r) => (release = r));
  const load = () => {
    loads++;
    return gate;
  };

  const a = c.run("k", load);
  const b = c.run("k", load);
  const d = c.run("k", load);
  assertEquals(loads, 1, "three concurrent callers, one read");
  assertEquals(c.inflight, 1);
  release("answer");
  assertEquals(await a, "answer");
  assertEquals(await b, "answer");
  assertEquals(await d, "answer");
  assertEquals(c.inflight, 0, "the entry is gone the moment it settles: this is not a cache");

  // SEQUENTIAL callers always hit storage again. That is what makes this safe without a TTL or
  // any invalidation: nothing is ever served from a completed read.
  await c.run("k", () => Promise.resolve("second"));
  assertEquals(loads, 1);
  assertEquals(await c.run("k", () => Promise.resolve("third")), "third");
});

Deno.test("coalesce: different keys never share, and a failure is not remembered", async () => {
  const c = new Coalescer();
  const [x, y] = await Promise.all([c.run("a", () => Promise.resolve(1)), c.run("b", () => Promise.resolve(2))]);
  assertEquals([x, y], [1, 2], "distinct questions get distinct answers");

  // A rejected read clears its entry too, so the next caller retries rather than inheriting the
  // failure forever. Both concurrent callers see the error (and neither leaks an unhandled one).
  let attempts = 0;
  const boom = () => {
    attempts++;
    return Promise.reject(new Error("db down"));
  };
  const p1 = c.run("k", boom);
  const p2 = c.run("k", boom);
  await assertRejects(() => p1, Error, "db down");
  await assertRejects(() => p2, Error, "db down");
  assertEquals(attempts, 1, "the failure was shared, not repeated");
  assertEquals(c.inflight, 0, "…and not retained");
  assertEquals(await c.run("k", () => Promise.resolve("recovered")), "recovered");
});

/** Count what actually reaches storage, the way the fan-out bench does. */
function counting(adapter: StorageAdapter) {
  const counts = { getEvents: 0, getRecord: 0 };
  const proxy = new Proxy(adapter, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      if (prop === "getEvents" || prop === "getRecord") {
        return (...args: unknown[]) => {
          counts[prop as "getEvents" | "getRecord"]++;
          // deno-lint-ignore no-explicit-any
          return (v as any).apply(target, args);
        };
      }
      return v.bind(target);
    },
  }) as StorageAdapter;
  return { proxy, counts };
}

Deno.test("coalesce: a wakeup burst costs ONE log read and ONE record fetch, whatever N is", async () => {
  // The end-to-end property, on the two calls the SSE loop makes per lap. Without coalescing this
  // is 2N; the fan-out bench measured 250 streams at 250 + 250 and 127ms for a single write.
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const { proxy, counts } = counting(adapter);
  try {
    const space = new Space(proxy);
    space.registerKind({ kind: "feed", indexedPaths: [{ path: "conv", type: "keyword" }], claimable: false });
    const { id } = await space.put({ kind: "feed", body: { conv: "c1" } });
    const cursor = ""; // from the start, so the event is in range for every reader

    // N watches with PREDICATES, so each would fetch the record for itself (matchesEvent only
    // skips the fetch for an unscoped kind-only watch).
    const N = 50;
    const watches = [];
    for (let i = 0; i < N; i++) {
      const { watchId } = await space.createWatch({ kind: "feed", match: { conv: `c${i}` } }, "local:dev");
      watches.push(await space.revalidateWatch(watchId, "local:dev"));
    }

    counts.getEvents = 0;
    counts.getRecord = 0;
    // The burst: every stream reads the log and evaluates the event, all in the same tick, which
    // is exactly what one notify() produces.
    const results = await Promise.all(watches.map(async (w) => {
      const events = await space.getEvents(cursor, 200);
      const target = events.find((e) => e.recordId === id)!;
      return await space.matchesEvent(w, target);
    }));

    assertEquals(counts.getEvents, 1, `${N} concurrent streams, one log read`);
    assertEquals(counts.getRecord, 1, `${N} concurrent predicate evaluations, one record fetch`);
    // …and sharing the fetch did not blur the answers: each watch still ran its OWN predicate
    // against the shared record. The record is conv "c1", so watch index 1 matches and no other.
    assertEquals(results.filter(Boolean).length, 1, "exactly one watch matched");
    assert(results[1] === true, "the watch on c1 matched");
    assert(results[0] === false && results[2] === false, "watches on other conversations did not");
  } finally {
    await adapter.close();
  }
});
