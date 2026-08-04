// The SDK worker loop's response to losing a lease (audit package H).
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

/** A space behind a real port, plus a run credential holding the grants a worker needs. */
async function newWorkerSpace() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    makeHandler(space, "<html>console</html>", true),
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
