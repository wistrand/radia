# Plan: a Web Worker sandbox backend

**Status: BUILT, all four steps, 2026-08-18** (`extensions/ts/sandbox-web.ts` + the
`extensions/ts/browser.ts` bundle entry, 11 cases in `extensions/conformance/sandbox-web.test.ts`,
two of them proven able to FAIL by planting: an open-network jail and a removed refusal). The
playground beat runs jailed code in the tab, gated on the probe, and plan-browser-space.md's
limitation 1 is rewritten from "no code execution" to the narrower true statement. Analysis 2026-08-18. A code-execution backend for the browser
space (agent_docs/plan-browser-space.md limitation 1), so jailed model-written code can run in a
tab. Not a new isolation idea: a `sandbox` RECORD declaring properties, a broker binding for the
channel, and a boot probe that PROVES the guarantee before advertising it, exactly as
[design-execution.md](design-execution.md), [architecture-jail-confinement.md](architecture-jail-confinement.md)
and `extensions/ts/broker.ts` already prescribe. All extensions-tier + playground wiring; nothing
in `src/`.

## The trap, which is architecture-jail-confinement.md in browser clothing

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

## What building it changed, and what the tests caught

Three findings, each a bug the suite found rather than a plan item:

- **The probe needed a REACHABLE target**, the same requirement `probeSandbox` states for its own
  (`networkTarget`). The first version dialled `example.invalid`, which fails on DNS whether or
  not the CSP applies — so a browser whose jail had silently stopped applying would report
  `network: false` as HELD. Proven by planting a net-permitted worker: with the unreachable host
  the plant passed; against a live space it reports `fetch reached a live target (status 200)`.
  With no target the claim is UNVERIFIED, reported as not-held, which stops the advertisement.
- **A refusing performer must ECHO the frame id.** A reply the shim cannot correlate is never
  delivered, so a `{id: 0}` refusal hung the jail until its timeout instead of failing it in a
  millisecond. The probe's own no-broker performer had this bug.
- **Two defects only a browser could show, both found on the first real run** (the Deno path has
  no iframe and no CSP, so neither was reachable headless). First, the frame's own bootstrap is an
  inline `<script>` in a `srcdoc`, which `script-src blob:` BLOCKS — so the frame listened for
  nothing, the spawn message was dropped, and the probe reported a timeout naming no cause. The
  browser's console named it and suggested a hash or a nonce; a NONCE is used, generated
  synchronously per spawn, which is tighter than `'unsafe-inline'` and needs no async hashing.
  Second, the spawn message was sent on the next tick, which races a `srcdoc` frame's asynchronous
  parse: the frame now ANNOUNCES readiness and the page waits for it, with a bounded wait that
  names itself ("its bootstrap did not run: check the frame's CSP") rather than expiring as a
  generic timeout. Guard: `jailCsp` is asserted to carry `connect-src 'none'` and the nonce, and
  to carry neither `unsafe-eval` nor `unsafe-inline`.
- **Spawning is part of the probe.** With the spawn outside the try, a jail that could not be
  built threw past the caller instead of reporting a claim that did not hold; "could not run"
  must reach an advertiser as a failure, never as silence.

**One rule the playground forced into the broker**: a brokered write is keyed on the record it ran
for, which assumes ONE CODE PER RECORD. True for `WorkspaceHost` (a binding pins the digest), false
for any host that varies the code — a textarea, or a future host that reruns a fixed record against
candidate implementations. There the second run sends a different body under the same key and the
space refuses it, correctly. `BrokerOptions.keyScope` lets such a host contribute the code's
identity, making effectively-once per (record, code), which is what it always meant; omitting it
leaves every existing key byte-identical. Guards, both proven able to fail: the key's SHAPE in
`broker.test.ts`'s dry run, and the BEHAVIOUR in `sandbox-web.test.ts` — same code replays, a
changed body under a reused key is refused and writes nothing, edited code gets its own key.

Two adjacent improvements fell out. `brokeredInvoker` now resolves the SANDBOX BEFORE
materialising the tree, so a refusable pairing costs one registry read rather than a manifest
plus an artifact fetch per file. And the refusal itself is one guard (`assertHostCanRun`) called
from both the invoker and `runBrokered`, because the dry run reaches only the second.

`deno task test:extensions` gained `--unstable-worker-options`: a worker with `permissions: "none"` is
what makes the headless probe deterministic and offline-safe (the network claim is refused by the
permission system rather than by DNS).

## Order

1. Shim + `MessagePort` channel binding, speaking the existing frames. Testable under Deno. BUILT.
2. Iframe/CSP jail construction + the boot escape probe (fetch, indexedDB.open, importScripts).
   BUILT: `spawnWebWorkerJail` (sandboxed iframe, no `allow-same-origin`, `JAIL_CSP`) and
   `probeWebWorker`. The iframe half is browser-only and therefore unexercised here by
   construction; the probe is what establishes it, in the page, at boot.
3. `sandbox` record + `run_javascript` capability publication GATED on the probe. BUILT as
   `webWorkerSandbox()` plus the probe; the gating CALL belongs to the page and lands with 4.
4. The playground "run code" beat. BUILT: the page probes at boot, shows each claim's verdict,
   and offers the button ONLY if all held; a browser where one fails is told which and offered
   nothing. On success the sandbox becomes a RECORD (`declareSandbox`), so "what can this space
   execute, and under what guarantees" is a query rather than a property of the page. The jailed
   run goes through the real `brokerPerformer`: verified end to end against the BUILT bundles
   under Deno — the code's `space.put` lands as a `summary` carrying a host-stamped field it never
   wrote and the document as a forced parent.

   Two things the wiring needed. The page reaches the extension tier through its own bundle
   (`extensions/ts/browser.ts` -> `docs/playground/radia-jail.js`, ~10KB), because `src/` may not
   import an extension; the tree-shake drops the FIFO transport, and `build-browser.sh` FAILS the
   build if a `Deno.` reference survives into a browser bundle. And `brokerPerformer` plus
   `declareSandbox` need only `put`/`query`/`readOne`, so the page passes a three-method adapter
   over its own wire rather than bundling the SDK client.
