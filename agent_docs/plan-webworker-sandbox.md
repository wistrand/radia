# Plan: a Web Worker sandbox backend

**Status: PLANNED, nothing built.** Analysis 2026-08-18. A code-execution backend for the browser
space (agent_docs/plan-browser-space.md limitation 1), so jailed model-written code can run in a
tab. Not a new isolation idea: a `sandbox` RECORD declaring properties, a broker binding for the
channel, and a boot probe that PROVES the guarantee before advertising it, exactly as
[design-execution.md](design-execution.md), [plan-jail-confinement.md](plan-jail-confinement.md)
and `extensions/ts/broker.ts` already prescribe. All extensions-tier + playground wiring; nothing
in `src/`.

## The trap, which is plan-jail-confinement.md in browser clothing

A bare `new Worker(blobUrl)` LOOKS like a jail (own thread, no DOM, message-passing only) and
leaves the two axes that matter wide open. The parallel to the Deno flags is exact: the boundary
that looks like the permission model does not bound the axis that matters, and a second mechanism
underneath is the whole fix.

- **Network is open.** Workers have `fetch`, `XHR`, `WebSocket`. A `no-cors` request is still
  SENT, so it is a working exfiltration channel even without a readable response.
- **Origin storage is open, and this is the worse one HERE.** A blob-URL worker inherits the
  page's origin, so it can `indexedDB.open("idb://radia-playground")` — the SPACE'S OWN DATABASE.
  That is not "reads some files"; it is the jail reading and corrupting the whole space beneath
  the authorization layer it is supposed to be subject to.

## The construction: three layers, each one axis

- **Opaque origin closes storage.** Spawn the worker from inside a sandboxed iframe
  (`sandbox="allow-scripts"`, deliberately WITHOUT `allow-same-origin`). The iframe gets an opaque
  origin; a worker created there inherits it; IndexedDB, Cache API and OPFS all refuse an opaque
  origin. The space's database is unreachable by IDENTITY, not by policy.
- **CSP closes network.** The iframe's `srcdoc` carries `default-src 'none'; script-src blob:;
  connect-src 'none'` (meta CSP), and per spec a blob-URL worker INHERITS the creator's CSP, so
  `fetch`/`WebSocket` throw inside the jail. The usual non-`connect-src` leaks are absent in a
  worker: no `RTCPeerConnection`, no `sendBeacon` on `WorkerNavigator`, no DOM to smuggle through.
  The clock remains, the same bounded-purity caveat the Deno jail documents.
- **`terminate()` closes runaway CPU.** A hard kill, no zombie, cleaner than SIGKILL. What NOTHING
  closes is MEMORY: no browser has a per-worker heap cap, so the sandbox record says
  `memory: unbounded` rather than omit it.

## The channel is a broker binding, and stronger than the FIFO pair

The normative surface is the frame schema (`BrokerCall`/`BrokerReply`/`{op:"result"}`), not the
transport. A web backend speaks the same JSON frames over a `MessagePort` transferred
page -> iframe -> worker. Two upgrades fall out:

- A MessagePort is an UNFORGEABLE object capability: no path to guess, nothing else can write to
  it — the property the FIFO design bought by keeping pipes off stdout, here for free.
- One frame per `postMessage` deletes the newline-framing rules entirely.

Everything host-side ports unchanged: `perform()` under the agent's token, the forced claimed
record + input parents, ordinal idempotency keys, `labelsForJail`, `recordingPerformer` for dry
runs, timeout -> `terminate()`. BYTES still never travel in a frame (the rule that outlived the
transport): a run's output is captured the workspace way, not messaged back.

## The probe is where browser variance dies

CSP inheritance for blob workers, opaque-origin storage refusal, `data:`/`blob:` worker support
differ by browser and cannot be verified from this repo (no browser launches, standing rule). The
probe-before-advertise doctrine absorbs exactly this. At page boot, spawn the jail and ATTEMPT
the escapes — a `fetch`, an `indexedDB.open`, an `importScripts` of a remote URL — and publish
`run_javascript` only if every attempt fails (throws or is blocked). A browser where the
guarantee does not hold never advertises the capability, the same posture as bubblewrap on hosted
CI ("verdict, never fatal"). EVERY BACKEND NEEDS ITS OWN PROBE: the Deno probe proves nothing
about this one, and a passing web probe proves nothing about another browser.

## Code delivery: clean v1, known-nuance v2

- **v1 = the snippet contract.** A script whose answer returns as the result frame; no module
  resolution needed, matching the chat's throwaway-snippet entry contract (plan-executors.md).
- **v2 = workspace trees**, which need module resolution with no filesystem. Once the
  SharedWorker/Service-Worker step lands (plan-browser-space.md step 3), the SW serves a
  materialised tree at virtual paths (`/jail/<digest>/…`) and the jail's CSP relaxes to
  `script-src 'self' blob:`. NUANCE to probe: that lets the jail `import` any same-origin URL;
  mitigated by strict MIME checking on module loads (a `/v0` JSON body will not execute as a
  module), but it earns its own probe case rather than an assumption.
- **Python** arrives the doctrinal way: Pyodide is another shim speaking the same frames, the host
  never learning the language. Cost is a large vendored asset (gitignored build output, like
  PGlite), so it is a later decision.

## The record

```
{ language: "javascript", isolation: "web-worker",
  network: false, filesystem: false, storage: false,
  memory: "unbounded", clock: true }
```

Registered in the existing sandbox registry, matched by `sandboxPattern` like any backend, the
grant binding the PROPERTY and never the name (design-execution.md). `memory: unbounded` and
`clock: true` are stated, not omitted, because an omitted axis reads as "safe" and neither is.

## CI, split the bubblewrap way

The frame schema, host logic and shim are testable under Deno (Deno has Web Workers, so the
channel binding runs headless in `extensions/conformance/`). The GUARANTEES (opaque origin, CSP
inheritance) are provable only in a real browser, so the in-page boot probe is the enforcement
and CI covers the logic. Precedented by bubblewrap's split, not new doctrine.

## Order

1. Shim + `MessagePort` channel binding, speaking the existing frames. Testable under Deno.
2. Iframe/CSP jail construction + the boot escape probe (fetch, indexedDB.open, importScripts).
3. `sandbox` record + `run_javascript` capability publication GATED on the probe.
4. The playground "run code" beat: which also rewrites plan-browser-space.md limitation 1 from
   "no code execution" to the narrower TRUE statement — no processes, no Python yet, memory
   unbounded — since JS-in-a-jail now runs.
