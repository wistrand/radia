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
import { agentLoop } from "../sdk/ts/loop.ts";

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
