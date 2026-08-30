#!/usr/bin/env -S deno run -A
// A code-execution agent for the lab: the third party in a two-agent scenario, and the one that
// costs nothing to run because it holds no model.
//
// SIXTY LINES, because the parts are shared: `serveTools` (extensions/ts/tool-worker.ts) is the
// worker (advertise, claim one pattern per tool NAME, answer through one envelope), and
// `execTools` (extensions/ts/exec-tool.ts) is the tool (pick a jail, verify it, run, taint,
// store oversized output). What is left here is deployment: which space, which principal, which
// jail, and what to say about it.
//
// WHY IT EARNS ITS PLACE IN THE LAB. Both harnesses query `capability` on every run and get
// nothing back, because nothing publishes. This is the first publisher, so "an agent discovers a
// tool from records and dispatches by content" stops being a claim about the design and becomes
// something a run either does or does not do.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { serveTools } from "../../extensions/ts/tool-worker.ts";
import { declareExecJail, execTools, selectJavascriptJail } from "../../extensions/ts/exec-tool.ts";

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const provider = flag("--provider") ?? "agent:lab-exec";
const team = flag("--team") ?? "lab";
const definitionToken = Deno.env.get("RADIA_DEFINITION_TOKEN");
if (!definitionToken) {
  console.error("exec-worker: RADIA_DEFINITION_TOKEN is required (the lab runner mints one per member)");
  Deno.exit(2);
}
const client = new RadiaClient(url, { definitionToken });

// THE JAIL IS PROBED, NOT ASSERTED. `selectJavascriptJail` tries a confined one first and falls
// back, reporting what failed; the space's own address is the network probe's target, because a
// probe with nothing to dial cannot tell an isolated jail from an offline machine.
const jail = await selectJavascriptJail({ networkTarget: new URL(url).host, timeoutMs: 5000 });
if (jail.refusedBecause.length > 0) {
  // The library reports; the launcher decides. Serving a jail that does not match its own
  // declaration would advertise a guarantee nothing checked.
  console.error(
    `exec-worker: refusing to serve. The jail does not match its declaration: ` +
      jail.refusedBecause.map((f) => `${f.claim} (${f.detail})`).join(", "),
  );
  Deno.exit(1);
}
console.error(
  jail.confine
    ? `exec-worker: JavaScript runs CONFINED (${jail.confine} over the Deno jail); module loading is bounded`
    : `exec-worker: JavaScript runs UNCONFINED (${
      jail.unconfinedBecause.map((f) => f.claim).join(", ")
    }). Module loading is not bounded by the read permission; see agent_docs/architecture-jail-confinement.md`,
);
await declareExecJail(client, jail);

const { tools, schemas } = execTools(client, {
  jail,
  timeoutMs: 5000,
  // The team label, so a stored artifact lands inside the same compartment as the work: an
  // unlabelled write is refused by `bodyMatchesGrant`, and there is deliberately no unlabelled lane
  // (agent_docs/architecture-teams.md).
  meta: () => ({ team }),
});

console.error(`exec-worker: serving ${Object.keys(tools).join(", ")} as ${provider} on ${url}`);
// `scope` labels the ADVERTISEMENT, not just what the tools write: a team space refuses an
// unlabelled `capability` record, and a worker that cannot advertise serves tools nothing can find.
try {
  await serveTools(client, { provider, tools, schemas, scope: { team }, stage: () => "executing" });
} catch (e) {
  // Advertising is not optional, so failing to is fatal rather than degraded: discovery is the only
  // way a caller learns this worker exists.
  console.error(`exec-worker: stopped: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}
