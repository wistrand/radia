// The SDK client and worker loop against a real server: losing a lease (audit package H) and
// keeping a watch stream alive across authentication and a server restart (package I).
//
// The contract in design-api.md is that physical execution may overlap after a lease lapses, and a
// fenced worker runs "until it observes `lease_lost`". Before this, the SDKs made that observation
// impossible: the heartbeat discarded every renew result, so a reclaimed or quarantined worker kept
// renewing a dead lease for the life of the process while its handler went on producing side
// effects, and the first observable sign was the final ack — after all the work was done.
//
// A real socket, unlike the rest of the HTTP tests, and deliberately: the thing under test is the
// SDK client (`agentLoop` over `RadiaClient`), including its background SSE watchers, and stubbing
// `fetch` would test a mock's idea of streaming and cancellation rather than the real one. The
// server is a `Deno.serve` on an ephemeral port, shut down at the end of each case.

import { assert, assertEquals } from "@std/assert";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { RadiaClient } from "../sdk/ts/client.ts";
import { agentLoop, reactorLoop } from "../sdk/ts/loop.ts";

/** A space behind a real port, plus a run credential holding the grants a worker needs.
 *  `intercept` sees every request first and may answer it, which is how the watch cases below
 *  simulate a server that has forgotten its (in-memory) watches. */
async function newWorkerSpace(intercept?: (req: Request) => Response | undefined) {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const handler = makeHandler(space, "<html>console</html>", true);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => intercept?.(req) ?? handler(req),
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

  const { definitionToken } = await space.createAgentDefinition("agent:w", [
    { principal: "agent:w", kind: "task", operations: ["take", "query", "read_one"] },
  ]);
  const { run, runToken } = await space.mintRun(definitionToken);
  return {
    space,
    run,
    client: new RadiaClient(base, runToken),
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

/** Run `agentLoop` with a handler that parks until its claim is cancelled, and report what it saw. */
function runLoop(client: RadiaClient, stop: AbortController) {
  let entered!: () => void;
  const claimed = new Promise<void>((r) => (entered = r));
  const observed = { cancelled: false, timedOut: false };
  const finished = agentLoop(client, {
    name: "w",
    patterns: [{ kind: "task" }],
    leaseSeconds: 3, // heartbeat every second: the fence is observed inside a test's patience
    pollMs: 200,
    signal: stop.signal,
    log: () => {},
    handle: (_record, _c, signal) => {
      entered();
      // Exactly what a handler with side effects would do between steps: watch the channel. The
      // failsafe is what fails the test if the channel never fires, rather than hanging the run.
      return new Promise<void>((resolve) => {
        const done = () => {
          observed.cancelled = signal.aborted;
          resolve();
        };
        if (signal.aborted) return done();
        signal.addEventListener("abort", done, { once: true });
        setTimeout(() => {
          observed.timedOut = true;
          done();
        }, 20_000);
      });
    },
  });
  return { claimed, observed, finished };
}

Deno.test("loop: a reclaimed lease cancels the handler instead of letting it finish unnoticed", async () => {
  const { space, client, close } = await newWorkerSpace();
  const stop = new AbortController();
  const { claimed, observed, finished } = runLoop(client, stop);
  try {
    const { id } = await space.put({ kind: "task", body: { tag: "x" } });
    await claimed;

    // The space takes the record back mid-handler: a force-transition bumps the epoch, so the
    // worker's next renew is answered `lease_lost`. Deterministic, and it needs no expiry.
    assert(await space.forceDeadLetter(id), "the operator forced the record out of the lease");

    await finished_or(finished, () => observed.cancelled || observed.timedOut);
    assertEquals(observed.timedOut, false, "the handler waited out its failsafe: it never saw the fence");
    assertEquals(observed.cancelled, true, "the handler's signal aborted when the lease was lost");

    // And the fenced work was not settled: the record is where the operator put it, not consumed.
    const dead = await space.queryEnvelopes({ state: "dead_letter" });
    assertEquals(dead.map((e) => e.record?.id), [id], "no ack landed on a lease we lost");
  } finally {
    stop.abort();
    await finished.catch(() => {});
    await close();
  }
});

Deno.test("loop: a quarantined run cancels the handler and stops the loop claiming", async () => {
  const { space, run, client, close } = await newWorkerSpace();
  const stop = new AbortController();
  const { claimed, observed, finished } = runLoop(client, stop);
  try {
    await space.put({ kind: "task", body: { tag: "x" } });
    await claimed;

    // Emergency revocation. The run's TOKEN dies first, so the heartbeat meets 401 rather than
    // `lease_lost` — which is why a renew that fails on the credential has to count as losing the
    // claim too. Left to `keepAlive` alone this is noticed at the token's half-life: minutes of a
    // handler running under a credential that is already dead.
    const stopped = await space.stopRun(run, { quarantine: true });
    assertEquals(stopped.applied, true);

    await finished_or(finished, () => observed.cancelled || observed.timedOut);
    assertEquals(observed.timedOut, false, "the handler waited out its failsafe: it never saw the fence");
    assertEquals(observed.cancelled, true, "a dead credential cancels the claim it can no longer settle");

    // The loop ends on its own: a stopped run will never resolve again, so continuing to claim
    // would be an endless series of 401s that looks, from outside, like a busy worker.
    await withTimeout(finished, 15_000, "the loop stopped claiming after the credential died");
  } finally {
    stop.abort();
    await finished.catch(() => {});
    await close();
  }
});

/** Read ONE wakeup off a watch, capturing any stream failure instead of letting it reject. */
function readOne(client: RadiaClient, signal: AbortSignal) {
  const wakeups: string[] = [];
  const failure: unknown[] = [];
  const reading = (async () => {
    try {
      for await (const w of client.watch({ kind: "task" }, signal)) {
        wakeups.push(String((w as { recordId?: string }).recordId ?? ""));
        return;
      }
    } catch (e) {
      failure.push(e);
    }
  })();
  return { wakeups, reading, failure };
}

Deno.test("watch: the SSE connect carries the credential, so an authenticated space still wakes", async () => {
  // The stream is a raw `fetch`, so it did not inherit the client's Authorization: every connect
  // 401'd under `--auth required` and `agentLoop` fell back to polling. Silent, and slow rather
  // than broken, which is why it survived. The space here REQUIRES auth, so a missing header
  // cannot pass.
  const { space, client, close } = await newWorkerSpace();
  const stop = new AbortController();
  try {
    // The stream's failure is CAPTURED, not left to reject: an escaping rejection is reported by the
    // runner as an uncaught error on the module, which names no test and reads like a harness fault.
    const { wakeups, reading, failure } = readOne(client, stop.signal);
    await sleep(300); // let the stream attach before writing
    const { id } = await space.put({ kind: "task", body: { tag: "x" } });
    await withTimeout(reading, 10_000, "the watch delivered a wakeup rather than 401ing in a loop");
    assertEquals(failure.at(0), undefined, `the watch stream failed: ${failure.at(0)}`);
    assertEquals(wakeups, [id]);
  } finally {
    stop.abort();
    await close();
  }
});

Deno.test("watch: a forgotten watch id is re-created, not retried forever", async () => {
  // Watches are in-memory, so a server restart 404s every existing id permanently — the one failure
  // that never heals by retrying. `served` flips the events route to 404 for the first attempt,
  // exactly as a restart would, and the client must come back with a NEW watch rather than
  // hammering the dead one.
  let refuse = true;
  const seen: string[] = [];
  const { space, client, close } = await newWorkerSpace((req) => {
    const path = new URL(req.url).pathname;
    if (!path.endsWith("/events")) return undefined;
    seen.push(path);
    if (!refuse) return undefined;
    refuse = false; // only the first attach is refused
    return new Response(JSON.stringify({ title: "not_found", detail: "no such watch" }), {
      status: 404,
      headers: { "content-type": "application/problem+json" },
    });
  });
  const stop = new AbortController();
  try {
    const { wakeups, reading, failure } = readOne(client, stop.signal);
    await sleep(500); // the refused attach, then the re-create
    const { id } = await space.put({ kind: "task", body: { tag: "x" } });
    await withTimeout(reading, 10_000, "the client re-created the watch and delivered the wakeup");
    assertEquals(failure.at(0), undefined, `the watch stream failed: ${failure.at(0)}`);
    assertEquals(wakeups, [id]);
    assert(seen.length >= 2, "it attached again after the 404");
    assert(seen[0] !== seen[1], "…under a NEW watch id, not the one the server no longer knows");
  } finally {
    stop.abort();
    await close();
  }
});

/** Wait until `ready()` holds (or the loop ends), polling rather than sleeping a fixed time. */
async function finished_or(finished: Promise<void>, ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 25_000;
  while (!ready() && performance.now() < deadline) {
    if (await Promise.race([finished.then(() => true).catch(() => true), sleep(50).then(() => false)])) return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(p: Promise<void>, ms: number, what: string): Promise<void> {
  const timer = sleep(ms).then(() => "timeout" as const);
  const got = await Promise.race([p.then(() => "done" as const).catch(() => "done" as const), timer]);
  assertEquals(got, "done", what);
}

Deno.test("loop: a handler that throws is never swallowed, even with no log configured", async () => {
  // THE DEFECT THIS PINS. `log` defaulted to a no-op and the nack path used it, so a handler that
  // threw retried invisibly: the record was claimed, nacked, reclaimed and nacked again while
  // nothing anywhere said why. Every caller saw the same thing, "the work never completed", which
  // is indistinguishable from a worker that is not running at all. Three defects in one afternoon
  // presented that way before the loop was made to speak.
  const s = await newWorkerSpace();
  const lines: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const stop = new AbortController();
  try {
    await s.space.put({ kind: "task", body: { tag: "boom" } });
    const finished = agentLoop(s.client, {
      name: "w",
      patterns: [{ kind: "task" }],
      leaseSeconds: 3,
      signal: stop.signal,
      // NO `log`: that is the whole point. A library may be quiet about success and must not be
      // quiet about an exception.
      handle: () => {
        throw new Error("deliberate handler failure");
      },
    });
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await finished;
  } finally {
    console.error = err;
    await s.close();
  }
  assert(lines.length > 0, "a handler exception reached nobody");
  assert(
    lines.some((l) => l.includes("deliberate handler failure") && l.includes("nack")),
    `the report must name the cause and say it nacked: ${JSON.stringify(lines.slice(0, 3))}`,
  );
});

Deno.test("loop: a configured log still receives the failure, and stderr stays clean", async () => {
  // The other half: passing a `log` ROUTES the failure, it does not duplicate it. A worker that
  // ships its own logging must not also spray stderr.
  const s = await newWorkerSpace();
  const mine: string[] = [];
  const lines: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const stop = new AbortController();
  try {
    await s.space.put({ kind: "task", body: { tag: "boom" } });
    const finished = agentLoop(s.client, {
      name: "w",
      patterns: [{ kind: "task" }],
      leaseSeconds: 3,
      signal: stop.signal,
      log: (m) => mine.push(m),
      handle: () => {
        throw new Error("deliberate handler failure");
      },
    });
    for (let i = 0; i < 100 && mine.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await finished;
  } finally {
    console.error = err;
    await s.close();
  }
  assert(mine.some((l) => l.includes("deliberate handler failure")), JSON.stringify(mine.slice(0, 3)));
  assertEquals(lines, [], "a caller that gave a log must not also get stderr");
});

Deno.test("loop: a space outage is ONE line and a backoff, not a line per tick", async () => {
  // Eight workers at the 1s fallback printed the same "fetch failed" ~500 times a minute while a
  // space was down, burying anything else stderr had to say. The loop now reports the first
  // failure of a streak, counts repeats silently (a once-a-minute reminder), backs off while the
  // space is unreachable, and says when it recovered — which is also what proves the streak logic
  // never suppressed a RECOVERY.
  const port = 7867; // fixed, so the space can come up at the address the loop is already retrying
  const dead = new RadiaClient(`http://127.0.0.1:${port}`);
  const lines: string[] = [];
  const stop = new AbortController();
  const finished = agentLoop(dead, {
    name: "w",
    patterns: [{ kind: "task" }],
    pollMs: 200, // floored to 1s by the loop
    signal: stop.signal,
    log: (m) => lines.push(m),
    handle: () => Promise.resolve(),
  });

  // ~3.5s of outage: the old loop reports ~3 take errors here, the new one exactly 1.
  await new Promise((r) => setTimeout(r, 3_500));
  const errors = lines.filter((l) => l.includes("claiming paused")); // the take streak, not the watch drop
  assertEquals(errors.length, 1, `one line per streak, not per tick: ${JSON.stringify(lines)}`);
  // And it says WHERE. Deno's own text for every transport failure is "fetch failed" — the same
  // five words for down, DNS and TLS — so the line must carry the address (and the cause when the
  // runtime supplies one), or eight workers name neither.
  assert(errors[0].includes(`http://127.0.0.1:${port}`), errors[0]);
  assert(!errors[0].includes("fetch failed") || errors[0].includes("cannot reach"), errors[0]);
  // The watchers reconnect through the same outage, and their retry line floods identically for
  // any caller that wires a log (the fleet was spared only because workers pass none).
  const drops = lines.filter((l) => l.includes("dropped"));
  assert(drops.length <= 2, `watch drops are a streak too: ${JSON.stringify(drops)}`);

  // The space comes up at the same address; the backed-off loop must notice within its 15s cap.
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [] });
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space, "<html/>", false));
  try {
    for (let i = 0; i < 200 && !lines.some((l) => l.includes("recovered")); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const recovered = lines.filter((l) => l.includes("recovered"));
    assertEquals(recovered.length, 1, `recovery is announced once: ${JSON.stringify(lines)}`);
    assert(/recovered after \d+ failed attempts? over \d+s/.test(recovered[0] ?? ""), recovered[0]);
  } finally {
    stop.abort();
    await finished;
    await server.shutdown();
    await adapter.close();
  }
});

Deno.test("loop: concurrency holds K claims at once, and 1 (the default) still serializes", async () => {
  // The first ceiling the chat hits is not the runtime, it is this loop: one worker held one
  // `llm_call` for the whole model response because the harness ran claims one at a time
  // (agent_docs/plan-scaling.md). The runtime never required that — leases are independently
  // fenced and there is no max-leases-per-principal — so concurrency is a harness option, and the
  // DEFAULT must stay sequential or every existing worker's behaviour changes under it.
  const run = async (concurrency: number | undefined, records: number) => {
    const s = await newWorkerSpace();
    try {
      for (let i = 0; i < records; i++) await s.space.put({ kind: "task", body: { tag: "x", i } });
      let inFlight = 0;
      let peak = 0;
      let done = 0;
      const all = Promise.withResolvers<void>();
      const stop = new AbortController();
      const loop = agentLoop(s.client, {
        name: "w",
        patterns: [{ kind: "task", match: { tag: "x" } }],
        signal: stop.signal,
        ...(concurrency === undefined ? {} : { concurrency }),
        handle: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          // Long enough that a sequential loop cannot fake overlap by being fast.
          await new Promise((r) => setTimeout(r, 120));
          inFlight--;
          if (++done === records) all.resolve();
        },
      });
      const started = performance.now();
      await all.promise;
      const elapsed = performance.now() - started;
      stop.abort();
      await loop;
      return { peak, elapsed };
    } finally {
      await s.close();
    }
  };

  // DEFAULT: one at a time, whatever is waiting. 4 records x 120ms cannot finish under ~480ms.
  const seq = await run(undefined, 4);
  assertEquals(seq.peak, 1, "the default must stay strictly sequential");
  assert(seq.elapsed >= 400, `sequential took ${seq.elapsed.toFixed(0)}ms, expected ~480+`);

  // K=4: all four overlap, so the wall clock is one handler plus claim overhead, not four.
  const par = await run(4, 4);
  assertEquals(par.peak, 4, "four slots should all be filled from one burst of claimable work");
  assert(par.elapsed < seq.elapsed, `concurrent (${par.elapsed.toFixed(0)}ms) should beat sequential (${seq.elapsed.toFixed(0)}ms)`);
});

Deno.test("loop: a concurrent worker settles every claim, and drains them on shutdown", async () => {
  // Each in-flight claim owns a fenced lease, so the loop must not return while any is unsettled:
  // `retireInterests` would race the settles, and a record left leased is one nobody reclaims
  // until its lease lapses.
  const s = await newWorkerSpace();
  try {
    const N = 6;
    for (let i = 0; i < N; i++) await s.space.put({ kind: "task", body: { tag: "x", i } });
    let started = 0;
    const first = Promise.withResolvers<void>();
    const stop = new AbortController();
    const loop = agentLoop(s.client, {
      name: "w",
      patterns: [{ kind: "task", match: { tag: "x" } }],
      signal: stop.signal,
      concurrency: 3,
      handle: async () => {
        if (++started === 3) first.resolve(); // three slots busy
        await new Promise((r) => setTimeout(r, 60));
      },
    });
    await first.promise;
    stop.abort(); // shut down mid-flight
    await loop; // must not resolve until the in-flight claims have settled

    // Nothing is left leased: every record the worker held was acked or nacked before it returned.
    const leased = await s.space.queryEnvelopes({ state: "leased", limit: 50 });
    assertEquals(leased.length, 0, "the loop returned while claims were still leased");
  } finally {
    await s.close();
  }
});

Deno.test("watch: an abort ends the stream even when no socket can break it", async () => {
  // The transport a BROWSER space uses: `makeHandler` called directly, no listener anywhere
  // (agent_docs/plan-browser-space.md). Over a socket an abort errors the response body and the
  // read below rejects; here nothing does, and the server ends its SSE stream from the reader's
  // `cancel()` and nothing else. So a watch that did not cancel on abort parked forever, its
  // stream stayed open, and `reactorLoop`'s shutdown never returned — found as a rehearsal that
  // ran to completion and then hung, and invisible to every socket-backed case in this file.
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [] });
  const handler = makeHandler(space, "", false);
  const base = "http://radia.test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(base)) return handler(input instanceof Request ? input : new Request(url, init));
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  try {
    const client = new RadiaClient(base);
    const stop = new AbortController();
    const drained = (async () => {
      for await (const _ of client.watch({ kind: "task" }, stop.signal)) { /* wait for the abort */ }
    })();
    // Let the stream open before aborting, or the case proves only that a never-started watch ends.
    await space.put({ kind: "task", body: {} });
    await new Promise((r) => setTimeout(r, 300));

    stop.abort();
    const verdict = await Promise.race([
      drained.then(() => "returned"),
      new Promise((r) => setTimeout(() => r("still parked"), 3000)),
    ]);
    assertEquals(verdict, "returned", "an aborted watch must end its stream, not park on a read nobody will answer");
  } finally {
    globalThis.fetch = realFetch;
    await adapter.close();
  }
});

// ── reactorLoop: the fact-side twin's contract (agent_docs/plan-reactor-loop.md) ─────────────────
//
// A supervision guard nobody has seen fail is one nobody has tested, so each case PLANTS one of
// the three failure classes: a run revoked under a live watch, a gap no wakeup ever announces,
// and a watch the space refuses outright.

/** Poll a condition into truth, or fail naming it. The reactor's effects are asynchronous by
 *  design, so every assertion here is "eventually", bounded. */
async function eventually(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let i = 0; i < ms / 50; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(cond(), `not eventually: ${what}`);
}

Deno.test("reactor: a credential_invalid revocation re-watches under a fresh run", async () => {
  // The run ceiling in miniature: the run behind the watch ends while the process lives. The bare
  // `for await` this replaces threw here and took the process with it (the analysis planner and
  // host, before the conversion). The contract: log it, mint a fresh run, watch again, reconcile.
  const s = await newWorkerSpace();
  const lines: string[] = [];
  let seen = 0;
  const stop = new AbortController();
  try {
    const { definitionToken } = await s.space.createAgentDefinition("agent:r", [
      { principal: "agent:r", kind: "task", operations: ["query"] },
    ]);
    const { run, runToken } = await s.space.mintRun(definitionToken);
    // BOTH halves: the short token dies with the run, and the durable half is what "re-watch
    // under a fresh run" mints from.
    const client = new RadiaClient(s.client.base, { token: runToken, definitionToken });
    await s.space.put({ kind: "task", body: { tag: "a" } });
    const loop = reactorLoop(client, {
      name: "r",
      patterns: [{ kind: "task" }],
      pollMs: 60_000, // the tick must never be the explanation for anything below
      signal: stop.signal,
      log: (m) => lines.push(m),
      reconcile: async () => {
        seen = (await client.query({ kind: "task" }, 50)).length;
      },
    });
    await eventually(() => seen === 1, "the boot reconcile ran");

    await s.space.stopRun(run);
    // The stream notices the dead run when it next carries something, so give it something.
    await s.space.put({ kind: "task", body: { tag: "b" } });
    await eventually(() => lines.some((l) => l.includes("outlived its run")), "the revocation was told apart from a refusal");
    await eventually(() => seen === 2, "the on-the-way-round reconcile saw the write");

    // The loop is ALIVE under the fresh run: a new write's wakeup reconciles, and with a 60s tick
    // only the re-established watch can explain it.
    await s.space.put({ kind: "task", body: { tag: "c" } });
    await eventually(() => seen === 3, "the fresh run's watch delivers wakeups");
    assertEquals(lines.filter((l) => l.includes("FORBIDDEN")).length, 0, "a run turnover is not a missing grant");
    stop.abort();
    await loop;
  } finally {
    stop.abort();
    await s.close();
  }
});

Deno.test("reactor: a record no wakeup ever announces is healed by the tick", async () => {
  // The invisible failure: the SDK's watch re-creates itself after a server restart and events in
  // the gap are missed BY CONSTRUCTION, with no signal to the caller (client.ts). Simulated at the
  // transport by ending every SSE stream immediately, so no wakeup is ever delivered and the
  // reconcile tick is the only mechanism left. This is the case that makes the tick the
  // correctness spine rather than a fallback.
  const s = await newWorkerSpace((req) => {
    if (req.method === "GET" && new URL(req.url).pathname.endsWith("/events")) {
      return new Response("", { status: 200 });
    }
    return undefined;
  });
  let seen = 0;
  let passes = 0;
  const stop = new AbortController();
  try {
    const loop = reactorLoop(s.client, {
      name: "r",
      patterns: [{ kind: "task" }],
      pollMs: 1000,
      signal: stop.signal,
      log: () => {},
      reconcile: async () => {
        seen = (await s.client.query({ kind: "task" }, 50)).length;
        passes++;
      },
    });
    // The write lands strictly AFTER the boot pass, or the boot pass explains the heal and the
    // tick is never actually tested (found by planting a disabled tick and watching this stay
    // green).
    await eventually(() => passes >= 1, "the boot reconcile ran");
    assertEquals(seen, 0, "nothing to see before the write");
    await s.space.put({ kind: "task", body: { tag: "gap" } });
    await eventually(() => seen === 1, "the tick reconciled a record nothing announced");
    stop.abort();
    await loop;
  } finally {
    stop.abort();
    await s.close();
  }
});

Deno.test("reactor: a refused watch is reported ONCE and the tick keeps the reactor correct", async () => {
  // A real 403 is permanent: retrying it turns a revocation into a silent stall that reads as an
  // idle space, and re-reporting it every second is a flood that says nothing the first line did
  // not. The contract: one loud line, no retry, and the reconcile still runs on the tick.
  const s = await newWorkerSpace();
  await s.space.registerKind({ kind: "secret", indexedPaths: [] });
  const lines: string[] = [];
  let seen = 0;
  const stop = new AbortController();
  try {
    const loop = reactorLoop(s.client, {
      name: "r",
      patterns: [{ kind: "secret" }], // agent:w holds no grant on it
      pollMs: 1000,
      signal: stop.signal,
      log: (m) => lines.push(m),
      reconcile: async () => {
        seen = (await s.client.query({ kind: "task" }, 50)).length;
      },
    });
    await eventually(() => lines.some((l) => l.includes("FORBIDDEN")), "the refusal is loud");
    await s.space.put({ kind: "task", body: { tag: "t" } });
    await eventually(() => seen === 1, "the tick keeps reconciling without wakeups");
    // Long enough for a retry storm to show itself if one existed.
    await new Promise((r) => setTimeout(r, 1500));
    assertEquals(lines.filter((l) => l.includes("FORBIDDEN")).length, 1, "reported once, never retried");
    stop.abort();
    await loop;
  } finally {
    stop.abort();
    await s.close();
  }
});
