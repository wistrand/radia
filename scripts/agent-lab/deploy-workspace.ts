#!/usr/bin/env -S deno run -A
// The OPERATOR step of the workspace scenario: take the tree a model just authored, promote its
// digest, bind it to the agent that will run it, and submit one request.
//
// WHY THIS IS NOT THE MODEL'S JOB, and must never become it. `bind` is the escalation root and
// `promote` writes grants: together they decide which code runs as which principal. A model that
// could do both could run anything as anyone, which is the whole property
// `agent_docs/architecture-workspace-agents.md` exists to establish. So the split is deliberate:
// the model AUTHORS, an operator DEPLOYS, and a host RUNS. This script is the middle one.
//
// It shells out to the binary rather than holding a token: a foreground lab agent gets no
// `RADIA_DEFINITION_TOKEN`, so the CLI resolves the run's operator from `RADIA_CREDENTIALS` on its
// own. That is also why it is a separate process rather than a step inside the runner: a scenario
// says what it deploys, and the runner stays a thing that starts processes.

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const binary = flag("--binary") ?? "./radia";
const url = flag("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const wanted = flag("--workspace");
const agent = flag("--agent") ?? "agent:runner";
const tier = flag("--tier") ?? "prod";
const team = flag("--team") ?? "lab";
const waitSeconds = Number(flag("--wait") ?? 120);

async function radia(args: string[]): Promise<string> {
  const out = await new Deno.Command(binary, { args: [...args, "--url", url], stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (!out.success) throw new Error(`radia ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  return text;
}

// ---- 1. the tree the model wrote ------------------------------------------------

const listed = JSON.parse(await radia(["workspaces", "--json"])) as {
  workspaces: { name: string; id: string; treeDigest: string; paths: string[]; forked: boolean }[];
  complete: boolean;
};
if (!listed.complete) console.error("deploy: the workspace listing was INCOMPLETE; deploying from a partial view");
const ws = wanted ? listed.workspaces.find((w) => w.name === wanted) : listed.workspaces[0];
if (!ws) {
  console.error(
    `deploy: no workspace${wanted ? ` named '${wanted}'` : ""} exists. The authoring step wrote none, ` +
      `which is the finding: it is what the run was for.`,
  );
  Deno.exit(1);
}
// A FORK IS NOT DEPLOYABLE without saying which head, and picking one silently is how the wrong
// code reaches prod. Reported and continued, because the head chosen is the newest either way.
if (ws.forked) console.error(`deploy: '${ws.name}' is FORKED; deploying the newest head (${ws.id})`);

const manifest = JSON.parse(await radia(["get", ws.id, "--json"])) as { body: { entrypoint?: string } };
const entrypoint = manifest.body.entrypoint;
if (!entrypoint) {
  console.error(
    `deploy: '${ws.name}' declares no entrypoint, so nothing can run it. Its files are: ${ws.paths.join(", ")}`,
  );
  Deno.exit(1);
}
console.error(`deploy: ${ws.name} @ ${ws.treeDigest.slice(0, 12)} entrypoint=${entrypoint}`);

// ---- 2. the two locks -----------------------------------------------------------

// The request kind, declared by the operator like every other kind here: a member holds
// `kind_def: query` and never `put`.
await radia([
  "put",
  "kind_def",
  JSON.stringify({
    kind: "exec_request",
    indexedPaths: [{ path: "workspace", type: "keyword" }, { path: "tier", type: "keyword" }],
  }),
]);

// LOCK ONE: which requests this agent may claim, and who may submit them, both pinned to the
// digest. Neither side can name an unpromoted tree.
await radia(["promote", ws.treeDigest, "--tier", tier, "--pin", `${agent}:take`, "--pin", "local:dev:put"]);
// LOCK TWO: which code the agent runs. A binding disagreeing with the pin is refused by the host
// rather than run, which is the pairing that makes either lock worth having.
// `--output-meta team`: the compartment label is copied from the claimed request onto
// everything the run emits, so the code never has to know which team it is running for.
// `--brokered`, because these scenarios' programs READ the space; without it the entrypoint takes
// `(record)` and can reach nothing, which is the default for good reason and is what a deployment
// has to ask its way out of.
await radia([
  "bind",
  agent,
  "--digest",
  ws.treeDigest,
  "--entrypoint",
  entrypoint,
  "--output-meta",
  "team",
  "--brokered",
]);
console.error(`deploy: promoted to ${tier} and bound to ${agent}`);

// ---- 3. one request, and wait for what it produced -------------------------------

const before = Date.now();
const req = JSON.parse(
  await radia(["put", "exec_request", JSON.stringify({ workspace: ws.treeDigest, tier, team }), "--json"]),
) as { id: string };
console.error(`deploy: submitted ${req.id}; waiting up to ${waitSeconds}s for the host to run it`);

// Polled rather than watched, because this script's whole job is to hold the run open until the
// host has finished: a scenario that exits here would be killed before the code it deployed ran.
for (let i = 0; i < waitSeconds; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  // `children --json` answers with the ARRAY, not a wrapper: the verb prints what `getChildren`
  // returns.
  const kids = JSON.parse(await radia(["children", req.id, "--json"])) as { id: string; kind: string; body: unknown }[];
  if (kids.length > 0) {
    console.log(JSON.stringify({ ok: true, workspace: ws.name, digest: ws.treeDigest, ms: Date.now() - before, results: kids }, null, 2));
    Deno.exit(0);
  }
}
// A TIMEOUT IS A FINDING, not an error to swallow: the tree was deployed and nothing ran it, and
// the reasons are worth telling apart (no host, a digest mismatch between the two locks, or code
// that threw). `radia doctor` and the host's own stderr answer which.
console.error(`deploy: nothing answered ${req.id} within ${waitSeconds}s. Check the host's stderr and radia doctor.`);
Deno.exit(1);
