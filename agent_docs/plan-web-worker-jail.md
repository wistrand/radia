# Plan: a Web Worker jail (the browser execution backend)

**Status: PLANNED, nothing built.** Analysis 2026-08-18. Lifts the browser playground's
"no code execution" limitation (plan-browser-space.md limitation 1) by adding a browser BACKEND
to the existing sandbox design: a sandbox is a record declaring properties, jailed code
participates through the broker's frame schema, and every backend ships its own escape probe
(design-execution.md, plan-jail-confinement.md, `extensions/ts/broker.ts`). Nothing here touches
`src/`: an extensions-tier backend plus playground wiring, where the sandbox registry says
backends live.

## The naive Worker fails the way Deno's flags did

A bare `new Worker(blobUrl)` looks like a jail (own thread, no DOM, message-passing) and leaves
both dangerous axes open:

- **Network.** Workers hold `fetch`, XHR and `WebSocket`, and a `no-cors` POST is SENT: a
  working exfiltration channel with no CORS consent needed.
- **Origin storage, the worse one here.** A blob-URL worker inherits the page's origin, so it
  can `indexedDB.open` the space's own database (`idb://radia-playground`) and read or corrupt
  everything UNDER the authorization layer it is supposed to be subject to.

This is plan-jail-confinement's finding in browser clothing: the boundary that looks like the
permission model does not bound the axis that matters, and a second mechanism underneath is the
whole fix.

## The construction: three layers, one job each

1. **Opaque origin closes storage.** Spawn the worker from inside a sandboxed iframe
   (`sandbox="allow-scripts"`, deliberately WITHOUT `allow-same-origin`). The iframe's origin is
   opaque; the worker inherits it; IndexedDB, Cache API and OPFS all refuse opaque origins. The
   space's database becomes unreachable by IDENTITY, not by policy.
2. **CSP closes network.** The iframe's `srcdoc` carries
   `Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'` (meta
   tag); blob-URL workers inherit the creator's CSP per spec, so `fetch`/`WebSocket` throw
   inside the jail. The known non-`connect-src` leaks do not exist in workers: no
   `RTCPeerConnection`, no `sendBeacon` on `WorkerNavigator`, no DOM. What remains is the clock,
   the same bounded-purity caveat the Deno jail documents.
3. **`terminate()` closes runaway CPU.** A hard kill, no zombie. What nothing closes is MEMORY:
   no browser caps a worker's heap, and the sandbox record must say `memory: unbounded` rather
   than omit it.

## The channel: a broker binding, stronger than the FIFO pair

The NORMATIVE surface is the frame schema (`BrokerCall`/`BrokerReply`/`result`), not the
transport. The web backend speaks the same JSON frames over a `MessagePort` transferred
page -> iframe -> worker. Two upgrades fall out: a MessagePort is an UNFORGEABLE object
capability (nothing else can write to it; the property the FIFO design bought by keeping pipes
off stdout, free), and one-frame-per-message deletes the newline framing rules. Host-side,
everything ports unchanged: `perform()` under the agent's token, forced parents, ordinal
idempotency keys, `labelsForJail`, the recording performer for dry runs, timeout ->
`terminate()`.

## The probe is where browser variance goes to die

CSP inheritance for blob workers, opaque-origin storage refusal, `data:`-worker support: these
