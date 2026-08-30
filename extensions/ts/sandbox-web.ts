// A Web Worker sandbox: running jailed code inside a browser tab (agent_docs/plan-webworker-sandbox.md).
//
// THE TRAP THIS EXISTS TO CLOSE, and it is architecture-jail-confinement.md in browser clothing. A bare
// `new Worker(blobUrl)` looks like a jail — its own thread, no DOM, message passing only — and
// leaves the two axes that matter wide open:
//
//   NETWORK: a worker has `fetch`, `XHR` and `WebSocket`. A `no-cors` request is still SENT, so it
//   exfiltrates even though nothing can read the response.
//   ORIGIN STORAGE, which is the worse one here: a blob-URL worker inherits its creator's origin,
//   so code in a page-created worker can `indexedDB.open("idb://radia-playground")` — THE SPACE'S
//   OWN DATABASE. That is not "the jail reads some files"; it is the jail reading and rewriting
//   the space underneath the authorization layer it is supposed to be subject to.
//
// So the jail is three layers, each closing exactly one axis, and none of them is the Worker
// boundary itself:
//
//   OPAQUE ORIGIN closes storage. The worker is created inside a sandboxed iframe that
//     deliberately omits `allow-same-origin`, so its origin is opaque and IndexedDB, Cache and
//     OPFS all refuse it. Unreachable by IDENTITY rather than by policy.
//   CSP closes network. The iframe carries `connect-src 'none'`, and a blob-URL worker inherits
//     its creator's CSP, so `fetch` and `WebSocket` throw inside the jail.
//   terminate() closes runaway CPU. A hard kill with no zombie.
//
// What NOTHING closes is MEMORY: no browser exposes a per-worker heap cap. The record says
// `memoryMb: 0` (unbounded) rather than omitting the axis, because an omitted axis reads as safe.
// The clock remains too, so purity is bounded rather than total, exactly as the Deno jail says.
//
// AND NONE OF THAT IS BELIEVED. `probeWebWorker` attempts each escape at boot and the caller
// advertises the capability only if every attempt fails — the same rule every other backend
// follows, and the only honest answer to browser variance this repo cannot test (no browser is
// ever launched here). A browser where the guarantee does not hold simply never advertises.
//
// The CHANNEL is a broker binding, not a new protocol: the same `BrokerCall`/`BrokerReply`/result
// frames as the FIFO transport, over `postMessage`. Two things get better for free — a MessagePort
// is an unforgeable object capability (no path to guess, nothing else can write to it), and one
// frame per message deletes the newline framing rules entirely. Everything host-side is shared
// with the Deno backend rather than reimplemented: `brokerPerformer` applies the stamp, the forced
// parents, the labels and the ordinal idempotency key, so the security half cannot fork.

import type { RadiaRecord } from "../../sdk/ts/client.ts";
import type { BrokerOptions, BrokerReply } from "./broker.ts";
import { brokerPerformer } from "./broker.ts";
import type { InvokeContext } from "./host.ts";
import type { ProbeResult, SandboxSpec } from "./sandbox.ts";

/** The transport `serveFrames` speaks, narrowed to what both a `MessagePort` and a `Worker`
 *  satisfy. Narrow on purpose: the host side must not learn which one it holds, which is what lets
 *  the same code serve a browser's transferred port and a Deno worker's implicit one. */
export interface FramePort {
  postMessage(data: unknown, transfer?: unknown[]): void;
  addEventListener(type: "message", handler: (ev: { data: unknown }) => void): void;
  removeEventListener?(type: "message", handler: (ev: { data: unknown }) => void): void;
  /** A `MessagePort` delivers nothing until started; a `Worker` has no such method. */
  start?(): void;
}

/** One jailed run, from the host's side. The three fields beyond the port are what the FIFO
 *  transport got from a child process (kill, exit status, stderr) and a worker gets from its own
 *  events, so the failure paths stay as informative here as there. */
export interface JailedRun {
  port: FramePort;
  /** Kill the jail. Called on timeout, on a malformed frame, and once a result has arrived. */
  kill: () => void;
  /** Resolves with a diagnostic when the jail dies on its own (a worker `error` event). Makes a
   *  crash immediate instead of a timeout, which is the whole reason it is a promise. */
  died?: Promise<string>;
}

/** Frames the host will accept from one run before giving up. Untrusted code can post in a loop,
 *  and the queue is the one place it still costs the host memory. */
const MAX_FRAMES = 10_000;

/**
 * The JAIL'S half of the protocol, as a program.
 *
 * Concatenated with the caller's code at blob-build time rather than `eval`ed, which is what lets
 * the jail's CSP stay `script-src blob:` with NO `unsafe-eval`: the code is already inside the
 * script the worker was constructed from. A shim that evaluated a string would have to weaken the
 * one directive doing the most work here.
 *
 * The entry contract is the chat's SNIPPET shape (plan-executors.md): the code is a function body
 * with `record` and `space` in scope, and whatever it returns is the result. Workspace trees are
 * the v2 question and need module resolution the browser has no filesystem for; the plan says how
 * (a Service Worker serving a materialised tree at virtual paths) and it is deliberately not here.
 */
export function webWorkerBoot(code: string, record: RadiaRecord): string {
  return `
// ---- radia web-worker shim: the NORMATIVE broker frames over postMessage ----
let __port = self;          // until a real MessagePort is transferred in
let __seq = 0;
const __pending = new Map();

function __onReply(ev) {
  const d = ev.data;
  if (!d || typeof d.id !== "number") return;      // control frames are handled below
  const waiting = __pending.get(d.id);
  if (!waiting) return;
  __pending.delete(d.id);
  if (d.ok) waiting.resolve(d.result);
  else waiting.reject(new Error(d.error || "broker refused"));
}

function __call(op, args) {
  const id = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(id, { resolve, reject });
    __port.postMessage({ id, op, args });
  });
}

const space = {
  put: (r) => __call("put", r),
  query: (pattern, limit) => __call("query", { pattern, limit }),
  readOne: (pattern) => __call("read_one", { pattern }),
};

const record = ${JSON.stringify(record)};

async function __main() {
${code}
}

async function __run() {
  // A throw inside the jail is an ANSWER, not a lost run: the host cannot see a stack trace across
  // this boundary, so the shim reports it as the terminal frame with the message attached.
  try {
    const value = await __main();
    __port.postMessage({ op: "result", value: value === undefined ? null : value });
  } catch (e) {
    __port.postMessage({ op: "result", value: null, error: String((e && e.message) || e) });
  }
}

self.onmessage = (ev) => {
  const d = ev.data;
  if (d && d.__radia === "start") {
    // A transferred port becomes the channel; without one the worker's own implicit port is it.
    // Both are unforgeable, and the host side cannot tell which it got.
    if (ev.ports && ev.ports[0]) {
      __port = ev.ports[0];
      __port.onmessage = __onReply;
      if (__port.start) __port.start();
    }
    __run();
    return;
  }
  __onReply(ev);
};
`;
}

/**
 * The HOST'S half: read frames, perform them as the agent, answer, and collect the result.
 *
 * Transport-agnostic by construction, so a browser's transferred `MessagePort` and a Deno worker's
 * implicit one run the same code — which is what makes the protocol testable with no browser.
 * `perform` defaults to the shared broker performer, so the stamp, the forced parents, the labels
 * and the ordinal idempotency key are the same ones the FIFO backend applies. A dry run swaps in
 * `recordingPerformer` here exactly as it does there.
 */
export async function serveFrames(
  run: JailedRun,
  ctx: InvokeContext,
  opts: BrokerOptions = {},
): Promise<{ kind: string; body: unknown }> {
  const perform = opts.perform ?? brokerPerformer;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let ordinal = 0;
  let frames = 0;

  const { promise, resolve, reject } = Promise.withResolvers<{ kind: string; body: unknown }>();
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    run.port.removeEventListener?.("message", onMessage);
    clearTimeout(timer);
    run.kill();
    fn();
  };

  const timer = setTimeout(
    () => finish(() => reject(new Error(`entrypoint timed out after ${timeoutMs}ms`))),
    timeoutMs,
  );

  // A crash is reported the moment it happens rather than at the timeout: the worker's `error`
  // event is this transport's stderr, and the FIFO backend's whole argument for keeping stderr was
  // that the cause is worth more than the exit code.
  run.died?.then((why) => finish(() => reject(new Error(`entrypoint failed: ${why}`)))).catch(() => {});

  function onMessage(ev: { data: unknown }) {
    const frame = ev.data as Record<string, unknown> | null;
    if (!frame || typeof frame !== "object") return; // not ours; a transport may carry its own chatter
    if (++frames > MAX_FRAMES) {
      finish(() => reject(new Error(`the entrypoint sent more than ${MAX_FRAMES} frames`)));
      return;
    }
    if (frame.op === "result") {
      const err = typeof frame.error === "string" ? frame.error : undefined;
      const value = frame.value as { kind: string; body: unknown } | null;
      if (err) {
        finish(() => reject(new Error(`entrypoint failed: ${err}`)));
      } else if (!value || typeof value.kind !== "string") {
        finish(() => reject(new Error("entrypoint produced no result")));
      } else {
        finish(() => resolve(value));
      }
      return;
    }
    if (typeof frame.id !== "number" || typeof frame.op !== "string") return; // malformed: ignore
    // Performed as the AGENT, on the host side, where the code cannot reach: a refusal comes back
    // as data so the run continues and a 403 reads as a 403 rather than as a crash.
    perform(
      { id: frame.id as number, op: frame.op as "put" | "query" | "read_one", args: (frame.args ?? {}) as Record<string, unknown> },
      ctx,
      opts,
      () => ++ordinal,
    )
      .then((reply: BrokerReply) => {
        if (!settled) run.port.postMessage(reply);
      })
      .catch((e) => {
        if (!settled) run.port.postMessage({ id: frame.id, ok: false, error: String(e).slice(0, 300) });
      });
  }

  run.port.addEventListener("message", onMessage);
  run.port.start?.();
  run.port.postMessage({ __radia: "start" });
  return await promise;
}

// ---- the browser construction: an opaque origin, a CSP, and a worker inside both ----------------

/**
 * The iframe's CSP, which is the jail's network wall.
 * `connect-src 'none'` is the load-bearing directive: a blob-URL worker inherits its creator's
 * policy, so `fetch` and `WebSocket` throw inside the worker. The usual ways around `connect-src`
 * do not exist in a worker: no `RTCPeerConnection`, no `sendBeacon` on `WorkerNavigator`, and no
 * DOM to smuggle a request through as an image or a stylesheet.
 * `script-src blob:` and nothing else, and NO `unsafe-eval`: the code runs because it was
 * concatenated into the worker's own script, never because a string was evaluated.
 *
 * The jail's policy, per spawn, carrying a fresh NONCE for the one script allowed to run.
 * The nonce is the fix for a real failure: the bootstrap is an inline `<script>` in a `srcdoc`, so
 * a bare `script-src blob:` blocks the very program that builds the jail. The frame then listens
 * for nothing, the spawn message is dropped, and the probe reports a timeout naming no cause — a
 * browser reported exactly that, and suggested a hash or a nonce. A nonce is chosen over a hash
 * because it is generated synchronously (`crypto.getRandomValues`), where a hash would have to be
 * computed before the document exists and would make spawning async for no security gain. It is
 * also strictly tighter than `'unsafe-inline'`, which would admit any inline script.
 * `connect-src 'none'` is the directive doing the real work, and `blob:` in `script-src` is what
 * lets the WORKER's own script load, since a worker inherits its creator's policy. `'unsafe-eval'`
 * is deliberately absent, so no string ever becomes code.
 */
export function jailCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}' blob:; connect-src 'none'; style-src 'none'; img-src 'none'`;
}

/** The iframe's whole program: receive code and a port, build the worker, hand the port over.
 *  It is the ORIGIN DONOR and nothing else — it holds no credential, performs no frame, and the
 *  page and the worker talk directly once the port is transferred. */
function iframeBootstrap(nonce: string): string {
  return `
<meta http-equiv="Content-Security-Policy" content="${jailCsp(nonce)}">
<script nonce="${nonce}">
window.onmessage = (ev) => {
  const d = ev.data || {};
  if (d.__radia !== "spawn") return;
  try {
    const url = URL.createObjectURL(new Blob([d.source], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    // The page's port goes straight through to the worker: after this the iframe is not in the
    // path at all, which is why it never sees a frame.
    w.postMessage({ __radia: "start" }, ev.ports);
    w.onerror = (e) => parent.postMessage({ __radia: "error", message: String(e.message || e) }, "*");
    // A browser that refuses a worker in an opaque origin fails HERE, and says so, rather than
    // leaving the host to infer it from a timeout.
  } catch (e) {
    parent.postMessage({ __radia: "error", message: "could not build the jailed worker: " + String((e && e.message) || e) }, "*");
  }
};
// READY IS ANNOUNCED, never assumed. A srcdoc frame parses asynchronously, so a spawn message
// sent on the page's next tick arrives before this listener exists and is dropped with no error
// anywhere — a timeout whose cause is invisible. The page waits for this line.
parent.postMessage({ __radia: "ready" }, "*");
<\/script>
`;
}

/** Minimal shapes of the browser globals this file needs, so the module type-checks under Deno,
 *  where `document` does not exist. Browser-only code paths touch them only inside functions. */
interface DomLike {
  createElement(tag: string): {
    style: { display: string };
    setAttribute(name: string, value: string): void;
    srcdoc: string;
    contentWindow: { postMessage(data: unknown, target: string, transfer?: unknown[]): void; __radiaKill?: () => void } | null;
    remove(): void;
  };
  body: { appendChild(el: unknown): void };
}

/**
 * Spawn a jailed worker in a browser, and hand back the host's end of the channel.
 *
 * The iframe is what makes this a jail rather than a thread: `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` gives it an opaque origin, and the worker created inside inherits it. Adding
 * `allow-same-origin` here would silently hand the jail the page's IndexedDB, so the attribute
 * list is written out in full rather than composed, and the probe checks the result anyway.
 */
export function spawnWebWorkerJail(source: string, doc?: unknown): JailedRun {
  const d = (doc ?? (globalThis as { document?: unknown }).document) as DomLike | undefined;
  if (!d) throw new Error("spawnWebWorkerJail needs a browser document");
  // One nonce per jail, from the CSPRNG: it authorises exactly this document's bootstrap and
  // nothing a later document could replay.
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

  const frame = d.createElement("iframe");
  // No `allow-same-origin`: that omission IS the storage boundary.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.display = "none";
  frame.srcdoc = iframeBootstrap(nonce);
  d.body.appendChild(frame);

  const channel = new MessageChannel();
  const died = Promise.withResolvers<string>();
  const ready = Promise.withResolvers<void>();
  const onWindowMessage = (ev: { source?: unknown; data?: { __radia?: string; message?: string } }) => {
    // Identity, not origin: this frame's origin is the string "null" like every other opaque one,
    // so comparing windows is the check that actually distinguishes ours.
    if (ev.source !== frame.contentWindow) return;
    if (ev.data?.__radia === "ready") ready.resolve();
    if (ev.data?.__radia === "error") {
      ready.resolve(); // stop waiting to send into a frame that already failed
      died.resolve(ev.data.message ?? "worker error");
    }
  };
  const listeners = globalThis as unknown as {
    addEventListener(t: string, f: unknown): void;
    removeEventListener(t: string, f: unknown): void;
  };
  listeners.addEventListener("message", onWindowMessage);

  // WAIT FOR READY, never a tick. A srcdoc frame parses asynchronously, so a spawn message sent on
  // the next tick arrives before the frame's listener exists and is dropped in silence — the
  // failure looks like a jail that never answered. The bounded wait names itself instead.
  const readyTimeout = setTimeout(
    () => died.resolve("the jail's iframe never became ready (its bootstrap did not run: check the frame's CSP)"),
    5000,
  );
  ready.promise.then(() => {
    clearTimeout(readyTimeout);
    frame.contentWindow?.postMessage({ __radia: "spawn", source }, "*", [channel.port2]);
  });

  return {
    port: channel.port1 as unknown as FramePort,
    died: died.promise,
    // Removing the frame terminates every worker inside it, which is why the kill needs no
    // reach into `contentWindow`: an opaque origin refuses that property access anyway.
    kill: () => {
      clearTimeout(readyTimeout);
      frame.remove();
      listeners.removeEventListener("message", onWindowMessage);
    },
  };
}

// ---- the probe: the claims, attempted rather than believed ---------------------------------------

/**
 * The escape attempts, as the program that makes them.
 *
 * Each is inverted the way `probeSandbox` inverts its own: the claim HOLDS when the operation
 * FAILS. `importScripts` is absent from module workers, which counts as held for the same reason a
 * missing capability is a bounded one; it is still attempted rather than assumed, because the
 * failure mode this whole file exists for is a boundary that looked present and was not.
 */
export function webWorkerProbeSource(networkTarget?: string): string {
  return `
const out = [];
const held = (claim, ok, detail) => out.push({ claim, held: ok, detail });

${
    networkTarget
      ? `
try {
  // A REACHABLE target, for the reason \`probeSandbox\` states about its own: dialling
  // something that does not resolve cannot tell a jail from an offline machine, and would
  // report a wide-open network as closed the day the CSP silently stopped applying.
  const res = await fetch(${JSON.stringify(networkTarget)}, { mode: "no-cors", cache: "no-store" });
  held("network: false", false, "fetch reached a live target (status " + res.status + ")");
} catch (e) {
  held("network: false", true, String((e && e.name) || e).slice(0, 80));
}`
      : `
// Nothing to dial: UNVERIFIED, which is reported as not-held rather than passed. A claim nobody
// tested must never reach an advertiser looking like one that did.
held("network: false", false, "unverified: no reachable target was given to the probe");`
  }

try {
  if (typeof indexedDB === "undefined") held("storage: false", true, "no indexedDB in this worker");
  else {
    // OPENING is the attempt: an opaque origin refuses here, synchronously in most engines and via
    // the error event otherwise, so both shapes are treated as held.
    const req = indexedDB.open("radia-probe");
    const verdict = await new Promise((resolve) => {
      req.onsuccess = () => resolve({ held: false, detail: "opened a database" });
      req.onerror = () => resolve({ held: true, detail: "open refused" });
      req.onblocked = () => resolve({ held: true, detail: "open blocked" });
      setTimeout(() => resolve({ held: true, detail: "open never resolved" }), 1500);
    });
    held("storage: false", verdict.held, verdict.detail);
  }
} catch (e) {
  held("storage: false", true, String((e && e.name) || e).slice(0, 80));
}

try {
  if (typeof importScripts === "undefined") held("no remote code", true, "importScripts absent (module worker)");
  else {
    importScripts("https://example.invalid/probe.js");
    held("no remote code", false, "importScripts fetched a remote script");
  }
} catch (e) {
  held("no remote code", true, String((e && e.name) || e).slice(0, 80));
}

return { kind: "probe", body: { results: out } };
`;
}

/**
 * Run the probe and report per claim, so a caller can advertise only what held.
 *
 * `spawn` is injected rather than assumed so the same probe runs against a Deno worker (headless,
 * in `extensions/conformance/`) and against the real iframe jail in a page. The claims a browser
 * gets right and a Deno worker gets right for different reasons still both count: what is being
 * tested is the RESULT, which is the only thing a policy can rest on.
 */
export async function probeWebWorker(
  spawn: (source: string) => JailedRun,
  opts: {
    timeoutMs?: number;
    /** A URL this process can already reach, used to test the `network: false` claim. In a page
     *  the natural one is the space's own health endpoint: same origin, certainly live, and
     *  blocked by `connect-src 'none'` exactly when the jail is intact. Without it the claim is
     *  reported UNVERIFIED rather than passing. */
    networkTarget?: string;
  } = {},
): Promise<ProbeResult[]> {
  const ctx = {
    binding: { agent: "probe", workspaceDigest: "", entrypoint: "probe" },
    record: { id: "probe", kind: "probe", body: {} } as unknown as RadiaRecord,
    // A probe holds NO credential: anything reaching for one fails loudly here rather than
    // borrowing the caller's, the same rule `dryRunEntrypoint` follows.
    client: new Proxy({}, {
      get(_t, prop) {
        throw new Error(`the sandbox probe has no space access (tried client.${String(prop)})`);
      },
    }),
  } as unknown as InvokeContext;
  try {
    // SPAWNING IS PART OF THE PROBE. Outside the try it would throw past the caller, so a jail that
    // cannot even be built would crash the boot instead of reporting a claim that did not hold —
    // and "could not run" must never reach an advertiser as silence.
    const run = spawn(webWorkerBoot(webWorkerProbeSource(opts.networkTarget), { id: "probe", kind: "probe", body: {} } as unknown as RadiaRecord));
    const result = await serveFrames(run, ctx, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      // A probe that reached the space would be proving the wrong thing. The id is ECHOED: a reply
      // the shim cannot correlate is never delivered, so a refusal with the wrong id hangs the jail
      // until its timeout instead of failing it in a millisecond.
      perform: (call) => Promise.resolve({ id: call.id, ok: false, error: "a probe may not use the broker" }),
    });
    const body = result.body as { results?: ProbeResult[] };
    return body.results ?? [{ claim: "probe returned no claims", held: false }];
  } catch (e) {
    // A probe that could not run proves nothing, and "proves nothing" must never read as "held".
    return [{ claim: "the sandbox probe could not run", held: false, detail: String(e).slice(0, 200) }];
  }
}

/**
 * The record this backend advertises, and every field is a claim the probe checks.
 *
 * `memoryMb: 0` states the unbounded heap rather than omitting it; `storage: false` is the axis
 * no other backend has, and it is here because a browser jail that could open the space's own
 * IndexedDB would be the most dangerous jail in the project.
 */
export function webWorkerSandbox(name = "web-worker"): SandboxSpec {
  return {
    name,
    language: "javascript",
    isolation: "web-worker",
    network: false,
    readonlyPaths: [],
    writablePaths: [],
    // No filesystem exists to confine: the axis is closed by the platform, not by a policy.
    importsConfined: true,
    storage: false,
    processes: false,
    env: false,
    memoryMb: 0,
    timeoutMsMax: 30_000,
    runtime: "web-worker",
  };
}
