// The Web Worker sandbox backend (agent_docs/plan-webworker-sandbox.md).
//
//   deno task test:extensions
//
// SPLIT THE BUBBLEWRAP WAY, and the split is the point. What is testable here is the LOGIC: the
// frame protocol, the shim, the failure paths and the probe's verdicts, all against a real Deno
// worker with `permissions: "none"` — a genuine jail, headless, no browser. What is NOT testable
// here is the browser's half of the GUARANTEE (an opaque origin refusing IndexedDB, a blob worker
// inheriting its creator's CSP), because nothing in this repo launches a browser. That half is
// enforced at page boot by the same probe run against the iframe jail, and a browser where it does
// not hold never advertises the capability. A test that pretended otherwise would be the exact
// failure this backend exists to prevent: a boundary that looks proved and is not.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { RadiaRecord } from "../../sdk/ts/client.ts";
import type { InvokeContext } from "../ts/host.ts";
import {
  type FramePort,
  type JailedRun,
  jailCsp,
  webWorkerProbeSource,
  probeWebWorker,
  serveFrames,
  webWorkerBoot,
  webWorkerSandbox,
} from "../ts/sandbox-web.ts";
import { brokeredInvoker } from "../ts/broker.ts";
import { declareSandbox } from "../ts/sandbox-registry.ts";
import { bootSpace, uniq } from "./space.ts";

/** A jailed run backed by a real Deno worker holding NO permissions. Deno's worker is not the
 *  browser's jail and does not pretend to be; what it shares is the transport, which is what these
 *  cases test. */
function denoJail(source: string): JailedRun {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module", deno: { permissions: "none" } });
  const died = Promise.withResolvers<string>();
  worker.onerror = (e) => {
    e.preventDefault?.();
    died.resolve(String((e as ErrorEvent).message ?? e));
  };
  return {
    port: worker as unknown as FramePort,
    died: died.promise,
    kill: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

const RECORD = { id: "01TESTRECORD", kind: "exec_request", body: { job: "seven" } } as unknown as RadiaRecord;

/** A context with a client that must never be reached: these cases test the transport, and the
 *  performer is stubbed, so any client access is a bug rather than a fixture gap. */
const ctx = () =>
  ({
    binding: { agent: "agent:test", workspaceDigest: "", entrypoint: "main.js" },
    record: RECORD,
    client: new Proxy({}, {
      get(_t, prop) {
        throw new Error(`this case must not reach the space (client.${String(prop)})`);
      },
    }),
  }) as unknown as InvokeContext;

Deno.test("[sandbox-web] the shim speaks the broker frames: a call is performed and answered", async () => {
  // The whole contract in one run: the jail asks, the host performs under ITS rules, the answer
  // comes back as data, and the entrypoint's return value is the result. Same frames as the FIFO
  // transport, which is why the host half is shared rather than reimplemented.
  const calls: { op: string; args: unknown }[] = [];
  const run = denoJail(webWorkerBoot(
    `
    const a = await space.query({ kind: "note" }, 5);
    const b = await space.put({ kind: "note", body: { seen: a.length, job: record.body.job } });
    return { kind: "exec_result", body: { id: b.id, seen: a.length } };
    `,
    RECORD,
  ));
  const result = await serveFrames(run, ctx(), {
    perform: (call) => {
      calls.push({ op: call.op, args: call.args });
      if (call.op === "query") return Promise.resolve({ id: call.id, ok: true, result: [{ id: "x" }, { id: "y" }] });
      return Promise.resolve({ id: call.id, ok: true, result: { id: "01WRITTEN" } });
    },
  });

  assertEquals(calls.map((c) => c.op), ["query", "put"], "both calls crossed the channel, in order");
  assertEquals(result.kind, "exec_result");
  assertEquals((result.body as { id: string; seen: number }), { id: "01WRITTEN", seen: 2 });
  // The record reached the jail: the shim interpolates it, so the code reads it without asking.
  assertEquals((calls[1].args as { body: { job: string } }).body.job, "seven");
});

Deno.test("[sandbox-web] a refusal is DATA: the run continues and can answer", async () => {
  // A 403 must read as a 403 inside the jail rather than as a crash, exactly as the FIFO backend
  // promises. The code catches it and still returns, which is the behaviour a tool worker needs.
  const run = denoJail(webWorkerBoot(
    `
    let refused = "none";
    try { await space.put({ kind: "secret", body: {} }); } catch (e) { refused = e.message; }
    return { kind: "exec_result", body: { refused } };
    `,
    RECORD,
  ));
  const result = await serveFrames(run, ctx(), {
    perform: (call) => Promise.resolve({ id: call.id, ok: false, error: "forbidden: no grant for kind 'secret'" }),
  });
  assertStringIncludes((result.body as { refused: string }).refused, "no grant for kind 'secret'");
});

Deno.test("[sandbox-web] a throw inside the jail is an ANSWER, not a timeout", async () => {
  // There is no stack trace across this boundary, so a shim that let an exception escape would
  // cost the caller its whole deadline and report nothing. The message rides the terminal frame.
  const run = denoJail(webWorkerBoot(`throw new Error("the analysis failed on row 3");`, RECORD));
  const failed = await serveFrames(run, ctx(), { timeoutMs: 8000 }).then(
    () => null,
    (e) => String(e),
  );
  assert(failed, "a throwing entrypoint must not resolve");
  assertStringIncludes(failed, "the analysis failed on row 3");
});

Deno.test("[sandbox-web] a jail that never answers is killed at the timeout", async () => {
  const run = denoJail(webWorkerBoot(`await new Promise(() => {}); return { kind: "never", body: {} };`, RECORD));
  const started = performance.now();
  const failed = await serveFrames(run, ctx(), { timeoutMs: 400 }).then(() => null, (e) => String(e));
  assert(failed, "a hung entrypoint must reject");
  assertStringIncludes(failed, "timed out after 400ms");
  assert(performance.now() - started < 4000, "the timeout fires on time rather than waiting on the worker");
});

Deno.test("[sandbox-web] the probe attempts every escape and reports per claim", async () => {
  // The probe is the whole reason this backend can be advertised at all, so it is run rather than
  // assumed. Under a permissionless Deno worker every claim holds — for Deno's reasons, not the
  // browser's, which is exactly what the page-boot run re-establishes on the real jail.
  //
  // The network target is a LIVE space, for the reason `probeSandbox` gives about its own: dialling
  // a name that does not resolve cannot tell a jail from an offline machine, so a jail whose wall
  // had silently stopped applying would still report the claim as held.
  const PORT = 7843;
  await bootSpace(PORT);
  const results = await probeWebWorker(denoJail, {
    timeoutMs: 8000,
    networkTarget: `http://127.0.0.1:${PORT}/v0/health`,
  });
  const byClaim = new Map(results.map((r) => [r.claim, r]));
  assert(results.length >= 3, `expected three claims, got ${JSON.stringify(results)}`);
  for (const claim of ["network: false", "storage: false", "no remote code"]) {
    const r = byClaim.get(claim);
    assert(r, `the probe made no verdict for '${claim}': ${JSON.stringify(results)}`);
    assertEquals(r.held, true, `'${claim}' did not hold: ${r.detail}`);
  }
  // And the target really was reachable, or the case above proved nothing: the parent process can
  // fetch what the jail could not.
  assertEquals((await fetch(`http://127.0.0.1:${PORT}/v0/health`)).status, 200);
});

Deno.test("[sandbox-web] with nothing to dial, the network claim is UNVERIFIED rather than passed", async () => {
  // The failure this prevents is the quiet one: a probe with no reachable target reports every
  // network claim as held, and a browser whose CSP stopped applying would advertise a jail with an
  // open socket. Not-held is the honest answer, and it stops the advertisement.
  const results = await probeWebWorker(denoJail, { timeoutMs: 8000 });
  const net = results.find((r) => r.claim === "network: false");
  assert(net, JSON.stringify(results));
  assertEquals(net.held, false, "an untested claim must not pass");
  assertStringIncludes(net.detail ?? "", "unverified");
});

Deno.test("[sandbox-web] a probe that cannot run reports FAILED, never held", async () => {
  // "Proves nothing" must not read as "safe": a jail that cannot even be spawned is the case where
  // a silent pass would advertise a boundary nobody established.
  const results = await probeWebWorker(() => {
    throw new Error("no worker here");
  }, { timeoutMs: 500 });
  assertEquals(results.every((r) => !r.held), true, JSON.stringify(results));
  assertStringIncludes(results[0].claim + (results[0].detail ?? ""), "could not run");
});

Deno.test("[sandbox-web] the probe holds no credential", async () => {
  // Same rule as `dryRunEntrypoint`: a probe that could reach the space would be proving something
  // other than isolation, and a fixture that let it would hide a real escape.
  const run = denoJail(webWorkerBoot(
    `
    let reached = "refused";
    try { await space.put({ kind: "note", body: {} }); reached = "WROTE"; } catch (e) { reached = e.message; }
    return { kind: "probe", body: { results: [{ claim: "broker refused", held: reached !== "WROTE", detail: reached }] } };
    `,
    RECORD,
  ));
  const result = await serveFrames(run, ctx(), {
    timeoutMs: 8000,
    perform: (call) => Promise.resolve({ id: call.id, ok: false, error: "a probe may not use the broker" }),
  });
  const [claim] = (result.body as { results: { held: boolean; detail: string }[] }).results;
  assertEquals(claim.held, true);
  assertStringIncludes(claim.detail, "may not use the broker");
});

Deno.test("[sandbox-web] the record states the axes it cannot close", async () => {
  // An omitted axis reads as safe, so the two this backend genuinely cannot bound are written
  // down: no browser exposes a per-worker heap cap, and the clock is always reachable.
  const spec = webWorkerSandbox();
  assertEquals(spec.isolation, "web-worker");
  assertEquals(spec.network, false);
  assertEquals(spec.storage, false, "the axis a browser jail must close, stated explicitly");
  assertEquals(spec.memoryMb, 0, "0 is UNBOUNDED here, and saying so is the point");
  assertEquals(spec.processes, false);
  assertEquals([spec.readonlyPaths, spec.writablePaths], [[], []]);

  // It is an ordinary sandbox record: the registry stores it like any other, so a binding selects
  // it by PROPERTY (`sandboxPattern`) and never by name.
  const PORT = 7841;
  const operator = await bootSpace(PORT);
  const named = webWorkerSandbox(uniq("web"));
  const { id } = await declareSandbox(operator, named);
  assert(id, "the web backend registers through the same path as every other");
});

Deno.test("[sandbox-web] a web-worker spec is REFUSED by the process host, not downgraded", async () => {
  // The dangerous shape: this host builds a Deno or bwrap process, so serving a browser spec would
  // run the code with the WRONG guarantees while the record still claimed the browser's. Same
  // reading as `digest_mismatch` — two halves that disagree are a refusal, never a best effort.
  const PORT = 7842;
  const operator = await bootSpace(PORT);
  await declareSandbox(operator, webWorkerSandbox("web-worker-refused"));
  const invoke = brokeredInvoker(operator);
  const failed = await invoke({
    binding: {
      agent: "agent:x",
      workspaceDigest: "t1:0000",
      entrypoint: "main.ts",
      sandboxPattern: { isolation: "web-worker" },
    },
    record: RECORD,
    client: operator,
  } as unknown as Parameters<typeof invoke>[0]).then(() => null, (e) => String(e));
  assert(failed, "the process host must refuse a browser jail");
  assertStringIncludes(failed, "cannot run on this host");
  assertStringIncludes(failed, "sandbox-web.ts");
});

Deno.test("[sandbox-web] effectively-once is per (record, code), which is what a varying host needs", async () => {
  // The failure this exists for, hit in the playground: a brokered write is keyed on the record it
  // ran for, which assumes ONE CODE PER RECORD — true when a binding pins a digest, false for a
  // textarea. Re-running edited code against the same trigger then sends a different body under
  // the same key, and the space refuses it. Correctly: the key promised the same work. So a host
  // that varies the code contributes the code's identity, and the three cases below are the whole
  // contract.
  const PORT = 7844;
  const operator = await bootSpace(PORT);
  const kind = uniq("keyed");
  await operator.registerKind({ kind, indexedPaths: [{ path: "marker", type: "keyword" }], claimable: false });
  // A real record to descend from: the host forces it as a parent, and parents must exist.
  const anchor = await operator.put({ kind, body: { marker: "anchor" } });
  const record = { id: anchor.id, kind, body: {} } as unknown as RadiaRecord;

  const run = (scope: string, marker: string) => {
    const code = `await space.put({ kind: ${JSON.stringify(kind)}, body: { marker: ${JSON.stringify(marker)} } });
      return { kind: "done", body: {} };`;
    return serveFrames(denoJail(webWorkerBoot(code, record)), { record, client: operator } as unknown as InvokeContext, {
      timeoutMs: 8000,
      keyScope: scope,
    });
  };
  const written = async () => (await operator.query({ kind }, 50)).length;

  await run("codeA", "one");
  const afterFirst = await written();
  assertEquals(afterFirst, 2, "the anchor plus what the jail wrote");

  // 1. SAME code, same record: the retry the key exists for. One record, not two.
  await run("codeA", "one");
  assertEquals(await written(), afterFirst, "identical work under one key writes once");

  // 2. SAME key, DIFFERENT body: refused, and the refusal is the contract working. This is the
  //    409 a host sees when it varies the code and forgets to say so.
  const conflict = await run("codeA", "two").then(() => null, (e) => String(e));
  assert(conflict, "a changed body under a reused key must not succeed");
  assertStringIncludes(conflict, "idempotency");
  assertEquals(await written(), afterFirst, "and nothing was written by the refused run");

  // 3. DIFFERENT code, same record: a different key, so it writes rather than colliding.
  await run("codeB", "two");
  assertEquals(await written(), afterFirst + 1, "edited code is different work and gets its own key");
});

Deno.test("[sandbox-web] the jail's policy blocks the network and still admits its own bootstrap", () => {
  // Both halves are load-bearing, and the second was learned the hard way: a bare `script-src
  // blob:` blocks the iframe's inline bootstrap, so the frame listens for nothing, the spawn
  // message is dropped, and the probe reports a timeout naming no cause. A browser caught it. The
  // nonce admits exactly that one script, where `'unsafe-inline'` would admit any.
  const nonce = "abc123";
  const csp = jailCsp(nonce);
  assertStringIncludes(csp, "connect-src 'none'", "the directive that closes the network");
  assertStringIncludes(csp, `script-src 'nonce-${nonce}' blob:`, "the bootstrap by nonce, the worker by blob:");
  assertEquals(csp.includes("unsafe-eval"), false, "no string may become code");
  assertEquals(csp.includes("unsafe-inline"), false, "a nonce is tighter, and it is the whole reason it is used");
  assertStringIncludes(csp, "default-src 'none'");
});

Deno.test("[sandbox-web] the shim is concatenated, never evaluated", () => {
  // The CSP that closes the network is `script-src blob:` with NO `unsafe-eval`, and it can stay
  // that way only because the code is inside the worker's own script rather than a string the shim
  // evaluates. A shim reaching for eval would quietly require weakening the directive doing the
  // most work.
  const boot = webWorkerBoot(`return { kind: "x", body: {} };`, RECORD);
  assertEquals(/\beval\s*\(|new Function\s*\(/.test(boot), false, "the shim must not evaluate code");
  assertStringIncludes(boot, `return { kind: "x", body: {} };`);
  assertStringIncludes(boot, "01TESTRECORD");
  // And the probe is ordinary jailed code: it goes through the same shim as anything else.
  assertStringIncludes(webWorkerProbeSource(), "indexedDB");
});
