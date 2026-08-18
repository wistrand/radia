// The extension tier's browser entry: what a page can use, in one module to bundle.
//
// Mirrors `src/browser.ts` one tier up, and exists for the same reason: a bundler needs ONE entry,
// and a page should not reach into a directory of modules half of which spawn processes. What is
// re-exported here is exactly the browser-safe surface — the Web Worker jail, the frame transport
// it shares with every other backend, and the registry write that publishes a proved sandbox.
//
// The tree-shake is the check, not a promise: bundling this pulls `brokerPerformer` (the host-side
// rules) without pulling the FIFO transport that surrounds it, because the performer never touches
// a process. `scripts/build-browser.sh` asserts the built bundle contains no `Deno.` reference, so
// a future import that dragged one in fails the build rather than the tab.

export {
  type FramePort,
  jailCsp,
  type JailedRun,
  probeWebWorker,
  serveFrames,
  spawnWebWorkerJail,
  webWorkerBoot,
  webWorkerProbeSource,
  webWorkerSandbox,
} from "./sandbox-web.ts";

export { declareSandbox, listSandboxes, readSandbox, SANDBOX_KIND } from "./sandbox-registry.ts";
export type { ProbeResult, SandboxSpec } from "./sandbox.ts";

// The SDK, through the same door. A page IS a client, so it wants the client library and the
// fact-side harness; re-exporting them here keeps the page on ONE bundle instead of three, and
// costs nothing new — extensions already import the SDK, and every module below is Deno-free
// (the build asserts it). `reactorLoop` in particular exists so nobody hand-rolls a watch loop
// again (agent_docs/plan-reactor-loop.md), and a page is no exception to that.
export { RadiaClient } from "../../sdk/ts/client.ts";
export { reactorLoop } from "../../sdk/ts/loop.ts";
