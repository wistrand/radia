// The one process the three stage agents run in: a WorkspaceHost over their bindings.
//
//   deno run -A examples/analysis/host.ts --url … --reader-token … --agent clean=… --agent features=… --agent report=…
//
// Replaces the three per-stage workers. What each agent runs is its BINDING's tree, materialised
// and jailed with no credential inside (the broker); what it may claim and answer is its promotion
// PINS ({workspace, tier} on both stage_request:take and stage_result:put). The stage-name routing
// and the in-handler "leaving this, I serve another digest" check both dissolved into
// authorization: an agent can only claim requests naming its pinned tree, so the wrong stage's
// work is simply never handed over.
//
// The host holds each agent's DEFINITION token (setup, like the chat launcher spawning its fleet)
// and claims under a run minted from it, so results are authored by the AGENTS. The reader is its
// own least-privilege identity: bindings, trees, file bytes, and the request watch.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { reactorLoop } from "../../sdk/ts/loop.ts";
import { sandboxInvoker, WorkspaceHost } from "../../extensions/ts/host.ts";
import { brokeredInvoker } from "../../extensions/ts/broker.ts";
import { stageAgent } from "./roles.ts";
import type { StageName } from "./kinds.ts";

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const url = arg("--url") ?? "http://127.0.0.1:7788";
const readerToken = arg("--reader-token");
if (!readerToken) {
  console.error("host: --reader-token is required (the least-privilege read identity)");
  Deno.exit(1);
}
const credentials: Record<string, string> = {};
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--agent") {
    const eq = Deno.args[i + 1].indexOf("=");
    const stage = Deno.args[i + 1].slice(0, eq) as StageName;
    credentials[stageAgent(stage)] = Deno.args[i + 1].slice(eq + 1);
  }
}
if (Object.keys(credentials).length === 0) {
  console.error("host: no --agent <stage>=<definition token> given; nothing to host");
  Deno.exit(1);
}

const reader = new RadiaClient(url, { definitionToken: readerToken });
const host = new WorkspaceHost({
  base: url,
  credentials,
  reader,
  requestKind: "stage_request",
  // PER BINDING, the same rule `radia host` follows. Every stage here is a pure function of its
  // claimed record and the input files the host fetched: none of them calls `space`, so none asks
  // to be brokered, and the pipeline stops paying for a channel (and a `mkfifo` permission) it
  // never used. A stage that later needs a read declares `brokered` on its own binding.
  invoke: (ctx) => (ctx.binding.brokered ? brokeredInvoker(reader) : sandboxInvoker(reader))(ctx),
  leaseSeconds: 60,
});

/** Tick until nothing makes progress. `digest_mismatch` does NOT count as progress: the claim is
 *  released, so draining on it would spin; it waits for an operator instead. */
const drain = async () => {
  for (;;) {
    const outcomes = await host.tick();
    for (const o of outcomes) {
      if (o.status === "acked") console.error(`[host] ${o.agent} acked ${o.recordId}${o.outputId ? `, output ${o.outputId}` : ""}`);
      else if (o.status === "failed") console.error(`[host] ${o.agent} FAILED ${o.recordId}: ${o.error}`);
      else if (o.status === "digest_mismatch") console.error(`[host] ${o.agent} digest mismatch on ${o.recordId}: wants ${o.wanted}, bound ${o.bound}`);
      else if (o.status === "refused") console.error(`[host] ${o.agent} refused: ${o.reason}`);
    }
    if (!outcomes.some((o) => o.status === "acked" || o.status === "failed")) return;
  }
};

const stop = new AbortController();
try {
  Deno.addSignalListener("SIGTERM", () => stop.abort());
} catch { /* not on this platform */ }

console.error(`[host] serving ${Object.keys(credentials).join(", ")}; watching stage_request`);
// A REACTOR (plan-reactor-loop.md): the drain runs at boot (work that arrived while the host was
// down waits for nobody), on every request wakeup, and on a tick that heals what the watch cannot
// see — a request written while the SDK's watch re-created itself after a space restart, and the
// death the bare `for await` had here when the reader's run hit its ceiling.
await reactorLoop(reader, {
  name: "host",
  patterns: [{ kind: "stage_request" }],
  pollMs: 15_000,
  signal: stop.signal,
  log: (m) => console.error(m),
  reconcile: drain,
});
