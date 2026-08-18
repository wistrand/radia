// The watch fan-out: what ONE write costs when N streams are parked, idle or not.
//
// This is the measurement agent_docs (the scaling analysis) called for and nobody had taken. The
// claim it makes concrete: `Notifier.notify()` is KIND-BLIND — a mutation anywhere wakes every
// parked waiter — and each woken stream then reads the log (`getEvents`) and, for a predicate
// watch, fetches the record (`matchesEvent` -> `getRecord`). So the cost of a single write scales
// with the number of open streams, whether or not they care about that write. That is the O(U)
// term behind the chat's quadratic (a conversation of U users writes ~7 chunks/s, each waking all
// ~5U streams). Measured here as QUERIES PER WRITE, which is deterministic, plus the wall time,
// which today's `idx_events_xid_seq` made cheap PER read without changing the COUNT.
//
// Faithful to the real consumer: `src/server/handlers/watches.ts` (getEvents(cursor,200) -> per
// event matchesEvent -> waitForEvents). No HTTP; the loop is the runtime work the SSE handler
// wraps. Two write shapes isolate the two terms:
//   - SAME KIND, another conversation: the chat shape. A message in conversation c0 wakes every
//     watcher of kind `feed`, each getEvents AND getRecord (kind matches its predicate), and only
//     c0's predicate actually matches. N getEvents + N getRecord, 1 useful.
//   - OTHER KIND: a write nobody watches still wakes everyone (kind-blind), but matchesEvent
//     short-circuits on the kind mismatch before fetching. N getEvents + 0 getRecord, 0 useful.
// The gap between "N" and "1 useful" is exactly what a kind-aware wakeup (the analysis's P0-2)
// would delete.

import { Space } from "../../src/core/space.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";

/** Wrap an adapter so the two fan-out reads are counted, everything else delegated untouched. */
function counting(adapter: StorageAdapter): { proxy: StorageAdapter; counts: { getEvents: number; getRecord: number } } {
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

export const fanoutBenches: Bench[] = [
  {
    name: "fanout",
    note:
      "queries a single write triggers as N streams park. Both fixes should hold here: kind-aware notify keeps other-kind at 0 wakeups, and read coalescing keeps same-kind at 1 getEvents + 1 getRecord however large N gets. A count that tracks N again means one of them regressed (the history: 250 streams once cost 250+250 and 127ms).",
    run: async (ctx) => {
      const P = "local:dev"; // the default ctx principal, privileged, so createWatch authorizes
      const out: Measurement[] = [];
      const sizes = [1, 25, 100, 250].map((n) => Math.max(1, Math.round(n * Math.min(ctx.scale, 2))));

      for (const N of sizes) {
        // Fresh Space per size over a COUNTING proxy of the harness's adapter: the watchers and
        // the measured put share one Space so its Notifier is what the put wakes, and a new one
        // per size means no watch leaks between sizes. The per-principal watch cap is lifted —
        // this measures the AGGREGATE fan-out (N streams is ~5 per user across N/5 users, each
        // well under the real 64 ceiling); the cap bounds a single principal, not the mechanism.
        const { proxy, counts } = counting(ctx.adapter);
        // deno-lint-ignore no-explicit-any
        const space = new Space(proxy, { maxWatchesPerPrincipal: 1_000_000 } as any);
        space.registerKind({ kind: "feed", indexedPaths: [{ path: "conv", type: "keyword" }], claimable: false });
        space.registerKind({ kind: "other", indexedPaths: [], claimable: false });
        // Park N predicate watchers, each on its OWN conversation (the chat's conversation-scoped
        // shape). Each runs the SSE loop's body and re-parks; a shared latch counts completed laps.
        const watchers: { cursor: string; watch: Awaited<ReturnType<Space["revalidateWatch"]>> }[] = [];
        for (let i = 0; i < N; i++) {
          const { watchId } = await space.createWatch({ kind: "feed", match: { conv: `c${i}` } }, P);
          watchers.push({ cursor: "", watch: await space.revalidateWatch(watchId, P) });
        }

        let cycles = 0;
        let release!: () => void;
        let laps = new Promise<void>((r) => (release = r));
        let target = 0;
        const stop = { done: false };

        // One faithful consumer loop per watcher: getEvents -> matchesEvent per event -> re-park.
        const loops = watchers.map((w) =>
          (async () => {
            // Catch up to head so the first MEASURED write is a clean single-event wakeup.
            for (;;) {
              const evs = await space.getEvents(w.cursor, 200);
              for (const e of evs) {
                w.cursor = e.cursor;
                await space.matchesEvent(w.watch, e);
              }
              if (evs.length < 200) break;
            }
            while (!stop.done) {
              // Pass the watch's KIND, exactly as the SSE handler does — so kind-aware notify can
              // decide whether this stream should wake at all. This is what makes the bench
              // measure the real mechanism rather than the old kind-blind path.
              await space.waitForEvents(3_600_000, "feed");
              if (stop.done) break;
              const evs = await space.getEvents(w.cursor, 200);
              for (const e of evs) {
                w.cursor = e.cursor;
                await space.matchesEvent(w.watch, e);
              }
              if (++cycles >= target) release();
            }
          })()
        );

        // All N parked and caught up before the first measurement.
        await new Promise((r) => setTimeout(r, 50));

        // Measure one write. `expectWakers` is how many streams SHOULD wake: N for a same-kind
        // write (all watch `feed`), 0 for an other-kind write once notify is kind-aware. When
        // wakers are expected we wait for exactly that many laps; when none are, we yield briefly
        // and confirm the counters stayed at zero — that zero IS the fix.
        const oneWrite = async (kind: string, body: Record<string, unknown>, expectWakers: number) => {
          counts.getEvents = 0;
          counts.getRecord = 0;
          cycles = 0;
          target = expectWakers;
          laps = new Promise<void>((r) => (release = r));
          await space.put({ kind, body });
          if (expectWakers > 0) await laps;
          else await new Promise((r) => setTimeout(r, 15)); // any (unexpected) wake would land here
        };

        // SAME KIND (chat: a message in conversation c0) — all N watch `feed`, so all N wake and
        // each getRecords to check its conversation predicate; only c0 matches. Kind-aware wakeup
        // does NOT reduce this: it discriminates across kinds, not within one.
        const same = await measure(`same-kind write @ ${N} watchers`, 20, () => oneWrite("feed", { conv: "c0" }, N), 2);
        const sameEv = counts.getEvents, sameRec = counts.getRecord;
        // OTHER KIND (a write of a kind nobody here watches) — the cross-kind case. Kind-blind
        // notify woke all N; kind-aware wakes 0. This row going N -> 0 is the measured fix.
        const other = await measure(`other-kind write @ ${N} watchers`, 20, () => oneWrite("other", {}, 0), 2);
        const otherEv = counts.getEvents, otherRec = counts.getRecord;

        stop.done = true;
        // Wake the parked loops so they observe stop.done and exit. They park on kind `feed`, so
        // the teardown write must be `feed` to reach them under kind-aware notify.
        await space.put({ kind: "feed", body: { teardown: true, conv: "none" } });
        await Promise.allSettled(loops);
        // Stale watch records left in the Space registry are harmless: only a LIVE loop parks on
        // the notifier, and all of this size's loops have now exited.

        out.push({ ...same, label: `same-kind @ ${N}w  (${sameEv} getEvents + ${sameRec} getRecord, 1 useful)` });
        out.push({ ...other, label: `other-kind @ ${N}w  (${otherEv} getEvents + ${otherRec} getRecord, 0 useful)` });
      }
      return out;
    },
  },
];
