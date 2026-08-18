// N chat sessions against ONE space: the measurement plan-scaling.md kept calling for and nobody
// had taken. Every user-count in that document is arithmetic over single-op costs; this is the
// first thing that observes a limit rather than deriving one.
//
// WHAT A SESSION IS HERE. Five parked SSE streams, the set a real REPL holds (`llm_chunk`,
// `message`, `tool_result` as wakeups; `capability`, `procedure` as registries — client/waiting.ts
// and client/turn.ts), each running the SSE handler's own loop body (getEvents -> matchesEvent ->
// re-park) rather than an approximation of it. The three wakeup streams carry a conversation
// predicate, because `Space.scopeWatch` ANDs a session's grant pattern into every watch, and a
// predicate is what makes a wakeup FETCH the record.
//
// WHAT A TURN IS HERE. The record traffic of one, with the model removed and nothing else:
//
//   session   put message{role:user}      the person types
//   session   put llm_call                the client seeds the turn
//   worker    take llm_call               one shared inference worker claims it
//   worker    put llm_chunk × CHUNKS      the answer streams
//   worker    ack message{role:assistant} the reply IS the ack (plan-chat-turn.md)
//   session   wakes on its own predicate, and the turn is over
//
// So the timed span is a real round trip through the space: a claim, a burst of writes, a
// fenced ack, and the fan-out every parked stream pays for each of those writes. No provider, no
// subprocesses, no HTTP — this is the floor, and the README's framing applies: in-process numbers
// are a floor for latency and a ceiling for throughput.
//
// WHAT IT REPORTS. p50/p95/p99 turn latency and turns/s as N grows, plus DATABASE QUERIES PER TURN,
// which is the number that decides whether this scales. Latency on one machine conflates the
// runtime with the harness's own concurrency; queries per turn does not, and it is what a second
// instance would divide.

import { Space } from "../../src/core/space.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import type { Bench, Measurement } from "../harness.ts";
import { percentile } from "../harness.ts";

/** Chunks a streamed answer emits. The doc's figure is ~7/s for a few seconds; 20 is a short one,
 *  and it is the term that dominates a turn's write count. */
const CHUNKS = 20;

/** Turns each session takes per size. Enough for a p99 to mean something without the sweep running
 *  long: N=40 at 8 turns is 320 timed turns. */
const TURNS_PER_SESSION = 8;

/** The five streams a session holds. The first three carry a predicate (a scoped session's watches
 *  always do); the two registries do not, which is exactly how the chat watches them. */
const WAKE_KINDS = ["llm_chunk", "message", "tool_result"];
const REGISTRY_KINDS = ["capability", "procedure"];

/** Count every storage call, so "queries per turn" is measured rather than reasoned about. */
function counting(adapter: StorageAdapter): {
  proxy: StorageAdapter;
  total: () => number;
  byMethod: () => Record<string, number>;
  reset: () => void;
} {
  let n = 0;
  let per: Record<string, number> = {};
  const proxy = new Proxy(adapter, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      const name = String(prop);
      return (...args: unknown[]) => {
        n++;
        per[name] = (per[name] ?? 0) + 1;
        // deno-lint-ignore no-explicit-any
        return (v as any).apply(target, args);
      };
    },
  }) as StorageAdapter;
  return {
    proxy,
    total: () => n,
    byMethod: () => per,
    reset: () => {
      n = 0;
      per = {};
    },
  };
}

export const chatLoadBenches: Bench[] = [
  {
    name: "chatload",
    note:
      "N sessions, five parked streams each, taking turns against one space. `q/turn` is the load-bearing column: it should stay FLAT as N grows, because the shared log read makes a write cost two queries however many streams are parked. A q/turn that tracks N means the coalescing regressed. Latency here is a floor (in-process, no HTTP) and rises with N mostly because one process is driving every session.",
    run: async (ctx) => {
      const out: Measurement[] = [];
      // DEDUPED: at a fractional scale two entries round to the same N, and running a size twice
      // is not just wasted — the second run shares the first's namespace and reads its records.
      const sizes = [...new Set([1, 5, 20, 40].map((n) => Math.max(1, Math.round(n * Math.min(ctx.scale, 2)))))];

      for (const N of sizes) {
        // Sizes share the harness ADAPTER (a fresh Space, the same database), so every id is
        // namespaced by size. Without this a later size's `readOne` by callId found the EARLIER
        // size's assistant message and every turn "completed" before the worker touched it —
        // 400 turns/s with no take and no ack in the counters, which is what caught it.
        const tag = `n${N}`;
        const { proxy, total, byMethod, reset } = counting(ctx.adapter);
        // One space, one notifier, one coalescer: the point of the measurement is that the
        // sessions SHARE them. The watch cap is lifted because it bounds a principal, not the
        // mechanism, and here one principal stands in for N people.
        // deno-lint-ignore no-explicit-any
        const space = new Space(proxy, { maxWatchesPerPrincipal: 1_000_000 } as any);
        for (const kind of [...WAKE_KINDS, ...REGISTRY_KINDS, "llm_call"]) {
          space.registerKind({
            kind,
            indexedPaths: [
              { path: "conv", type: "keyword" },
              { path: "callId", type: "keyword" },
              // Indexed so a turn can await its ASSISTANT reply by call, which is what the real
              // client does: a `message` watch fires on the session's OWN user message too, and
              // resolving on the wakeup alone measured a turn that had not happened yet.
              { path: "role", type: "keyword" },
            ],
            // `llm_call` is the only claimable one, which is what makes a turn a real claim.
            claimable: kind === "llm_call",
          });
        }

        // SCOPED PRINCIPALS, not the privileged default, and this is the difference between a
        // measurement and a demo. A privileged principal short-circuits `authorize` before any
        // grant is read, so running the sessions as one would delete the per-request authorization
        // work that a real deployment pays on every verb — the "~3 round trips precede every
        // request's real work" term in plan-scaling.md. Each session is its own agent with a
        // conversation-scoped grant set, exactly as `assignUserGrants` builds one.
        const sessionRun: string[] = [];
        for (let s = 0; s < N; s++) {
          const conv = `c${s}-${tag}`;
          const pattern = { conv };
          const who = `human:s${s}-${tag}`;
          const { definitionToken } = await space.createAgentDefinition(who, [
            { principal: who, kind: "message", operations: ["put", "query", "read_one"], pattern },
            { principal: who, kind: "llm_call", operations: ["put", "query"], pattern },
            { principal: who, kind: "llm_chunk", operations: ["query"], pattern },
            { principal: who, kind: "tool_result", operations: ["read_one"], pattern },
            { principal: who, kind: "capability", operations: ["query"] },
            { principal: who, kind: "procedure", operations: ["query"] },
          ]);
          sessionRun.push((await space.mintRun(definitionToken)).run);
        }
        const { definitionToken: workerDef } = await space.createAgentDefinition(`agent:bench-inference-${tag}`, [
          { principal: `agent:bench-inference-${tag}`, kind: "llm_call", operations: ["take"] },
          { principal: `agent:bench-inference-${tag}`, kind: "llm_chunk", operations: ["put"] },
          { principal: `agent:bench-inference-${tag}`, kind: "message", operations: ["put"] },
        ]);
        const workerRun = (await space.mintRun(workerDef)).run;

        /** A put through the SERVER's own sequence. `Space.put` does not authorize — the handler
         *  does (`handlers/records.ts`) — so calling it directly would skip the grant read and the
         *  write-side pattern check that every real put pays. */
        const authorizedPut = async (principal: string, kind: string, body: Record<string, unknown>) => {
          const constraint = await space.authorize(principal, "put", kind);
          if (constraint && !space.bodyMatchesGrant(kind, body, constraint)) throw new Error(`refused: ${kind}`);
          return await space.put({ kind, body }, undefined, principal);
        };

        // --- park 5N streams, each running the SSE loop body -------------------------------
        const stop = { done: false };
        const loops: Promise<void>[] = [];
        /**
         * The turn a session is waiting on, and how it finds out the answer landed.
         *
         * A `message` wakeup is NOT the answer: the stream carries the session's own user message
         * too, and the watch payload is record existence rather than a body. So the session does
         * what the real client does and awaits BY CALL (`{kind: message, match: {callId}}`,
         * client/turn.ts) — one read_one per wakeup, which is a cost the real path pays too.
         */
        const pending = new Map<string, { callId: string; resolve: () => void }>();

        for (let s = 0; s < N; s++) {
          const conv = `c${s}-${tag}`;
          const P = sessionRun[s];
          for (const kind of [...WAKE_KINDS, ...REGISTRY_KINDS]) {
            // A session's own watch carries its conversation; `scopeWatch` would AND the grant
            // pattern in anyway, which is why a chat wakeup always fetches the record.
            const scoped = WAKE_KINDS.includes(kind);
            const { watchId } = await space.createWatch(scoped ? { kind, match: { conv } } : { kind }, P);
            const watch = await space.revalidateWatch(watchId, P);
            loops.push((async () => {
              let cursor = "";
              for (;;) { // catch up to head before anything is timed
                const evs = await space.getEvents(cursor, 200);
                for (const e of evs) {
                  cursor = e.cursor;
                  await space.matchesEvent(watch, e);
                }
                if (evs.length < 200) break;
              }
              while (!stop.done) {
                await space.waitForEvents(3_600_000, kind);
                if (stop.done) break;
                const evs = await space.getEvents(cursor, 200);
                for (const e of evs) {
                  cursor = e.cursor;
                  const hit = await space.matchesEvent(watch, e);
                  if (!hit || kind !== "message") continue;
                  const waiting = pending.get(conv);
                  if (!waiting) continue;
                  const reply = await space.readOne({
                    kind: "message",
                    match: { callId: waiting.callId, role: "assistant" },
                  });
                  if (reply) {
                    pending.delete(conv);
                    waiting.resolve();
                  }
                }
              }
            })());
          }
        }
        await new Promise((r) => setTimeout(r, 50)); // everyone parked and caught up

        // --- one shared inference worker, the shape the fleet actually has ------------------
        //
        // It CLAIMS rather than polls, so the turn includes a real take and a fenced ack. One
        // worker for every session is the whole point: this is the shared-fleet deployment.
        const workerStop = { done: false };
        const worker = (async () => {
          while (!workerStop.done) {
            // `readAccess` before the claim, the way `handlers/leases.ts` does: a take pays a grant
            // read too, and leaving it out would flatter the worker side of every turn.
            await space.readAccess(workerRun, "take", "llm_call");
            const claim = await space.take({ pattern: { kind: "llm_call" } }, { leaseSeconds: 30 }, workerRun);
            if (!claim) {
              await space.waitForEvents(200, "llm_call");
              continue;
            }
            const b = claim.record.body as { conv: string; callId: string };
            for (let i = 0; i < CHUNKS; i++) {
              await authorizedPut(workerRun, "llm_chunk", { conv: b.conv, callId: b.callId, i, text: "tok " });
            }
            // The assistant message IS the worker's ack (plan-chat-turn.md), so the turn's last
            // write is a settle rather than a put. `ack` authorizes the lease owner itself.
            await space.ack(claim.lease, {
              kind: "message",
              body: { conv: b.conv, callId: b.callId, role: "assistant", content: "done" },
            }, undefined, workerRun);
          }
        })();

        // --- warm up, then time TURNS_PER_SESSION turns from every session concurrently ------
        const turn = async (s: number, n: number): Promise<number> => {
          const conv = `c${s}-${tag}`;
          const callId = `${conv}-${n}`;
          const done = new Promise<void>((r) => pending.set(conv, { callId, resolve: r }));
          const t0 = performance.now();
          await authorizedPut(sessionRun[s], "message", { conv, callId, role: "user", content: "hi" });
          await authorizedPut(sessionRun[s], "llm_call", { conv, callId });
          await done;
          return performance.now() - t0;
        };

        for (let s = 0; s < N; s++) await turn(s, -1); // warm: compile patterns, prime the planner

        reset();
        const started = performance.now();
        const samples = (await Promise.all(
          Array.from({ length: N }, async (_, s) => {
            const mine: number[] = [];
            // Sequential PER SESSION, concurrent ACROSS sessions: a person waits for their answer
            // before typing again, and N of them do not wait for each other.
            for (let n = 0; n < TURNS_PER_SESSION; n++) mine.push(await turn(s, n));
            return mine;
          }),
        )).flat();
        const elapsedMs = performance.now() - started;
        const queries = total();

        if (Deno.env.get("CHATLOAD_DEBUG")) console.log("        calls:", JSON.stringify(byMethod()));

        workerStop.done = true;
        stop.done = true;
        // A parked loop only wakes for its OWN kind under kind-aware notify, so teardown writes one
        // record of each: a single write would leave four fifths of the streams parked forever.
        for (const kind of [...WAKE_KINDS, ...REGISTRY_KINDS, "llm_call"]) {
          await space.put({ kind, body: { conv: "teardown", callId: "teardown" } }); // as the space itself
        }
        await Promise.allSettled([...loops, worker]);

        const sorted = [...samples].sort((a, b) => a - b);
        const turns = samples.length;
        out.push({ label: `${N} sessions (${N * 5} streams)`, samples, ops: turns, elapsedMs });
        // Reported as its own row rather than folded into the note, because it is the column that
        // answers the scaling question and a table of latencies alone would hide it.
        console.log(
          `      ${String(N).padStart(3)} sessions  ${String(N * 5).padStart(4)} streams  ` +
            `${(turns / (elapsedMs / 1000)).toFixed(1).padStart(6)} turns/s  ` +
            `${(queries / turns).toFixed(1).padStart(6)} q/turn  ` +
            `p50 ${percentile(sorted, 50).toFixed(1)}ms  p99 ${percentile(sorted, 99).toFixed(1)}ms`,
        );
      }
      return out;
    },
  },
];
