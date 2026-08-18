// Bring the whole thing up in ONE command: the space, its kinds, the stage agents (their code
// published as workspaces, pinned by promotion, run by one host), the planner, and the app.
//
//   deno task analysis                          # spawns a space if none is running
//   deno task analysis -- --grant human:you     # …and lets somebody in
//   deno task analysis -- --url http://…        # …or attach to a space already running
//
// SPAWNING THE SPACE IS WHAT MAKES THE OIDC FLAGS GO AWAY. `--oidc-issuer` and `--oidc-audience`
// are space-level configuration, so a deployment that starts its own space can pass them itself
// rather than asking anyone to remember them. Same move as the chat's solo mode.
//
// Attaching to a space somebody else started is still supported and is the honest limit of it:
// this cannot reconfigure a running space, so if that one advertises no issuer, sign-in is
// impossible and this says so rather than serving a page whose button cannot work.
//
// Needs an OPERATOR credential (`radia dev` writes one, including the space this spawns) because
// registering kinds and minting worker identities is privileged. Nothing it launches holds that
// credential: each worker gets its own least-privilege definition token, and the app gets none.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerAnalysisKinds, STAGES } from "./kinds.ts";
import { publishStageWorkspaces } from "./stages.ts";
import { bootstrap, deployStages, grantObserve, grantUser } from "./roles.ts";
import { enrolledPrincipals, watchEnrolments } from "../../extensions/ts/enrolment.ts";

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};
const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const port = arg("--port") ?? "8081";
const spacePort = new URL(url).port || "7788";
// The bundled Keycloak (docker/keycloak). Overridable, and only USED when this process starts the
// space: a space somebody else started already has whatever configuration it has.
const issuer = arg("--oidc-issuer") ?? Deno.env.get("RADIA_OIDC_ISSUER") ?? "http://127.0.0.1:8080/realms/radia";
const audience = arg("--oidc-audience") ?? Deno.env.get("RADIA_OIDC_AUDIENCE") ?? "radia-console";
const db = arg("--db") ?? `${Deno.env.get("RADIA_DIR") ?? ".radia"}/analysis.db`;

const procs: Deno.ChildProcess[] = [];
const spawn = (args: string[], quiet = false) => {
  const p = new Deno.Command("deno", {
    args: ["run", "-A", ...args],
    stdout: quiet ? "null" : "inherit",
    stderr: quiet ? "null" : "inherit",
  }).spawn();
  procs.push(p);
  return p;
};

const probe = new RadiaClient(url);
let health = await probe.health().catch(() => null) as { oidc?: { issuer: string; clientId: string } } | null;
let spawnedSpace = false;
if (!health) {
  // `--db` is what makes this resumable: without it the space is in-memory and every dataset,
  // result and artifact dies with the process.
  console.error(`no space at ${url}; starting one (${db})`);
  spawn([
    "src/main.ts",
    "dev",
    "--port",
    spacePort,
    "--storage",
    "sqlite",
    "--db",
    db,
    "--oidc-issuer",
    issuer,
    "--oidc-audience",
    audience,
  ], true);
  spawnedSpace = true;
  for (let i = 0; i < 100 && !health; i++) {
    await new Promise((r) => setTimeout(r, 200));
    health = await probe.health().catch(() => null) as typeof health;
  }
  if (!health) {
    console.error(`the space did not start. Is ${url} already taken by something else?`);
    Deno.exit(1);
  }
}

const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerAnalysisKinds(admin);
// The stage code, as workspaces: idempotent (an identical tree is a no-op), and an edited stage
// becomes the next version, whose new digest is what makes its work re-run.
const digests = await publishStageWorkspaces(admin);
for (const [stage, digest] of Object.entries(digests)) console.error(`[setup] stage-${stage} at ${digest.slice(0, 16)}…`);
const { agentTokens, readerToken, plannerToken } = await bootstrap(admin);
// The two locks per stage: promotion pins (take the request, put the result) and the binding the
// host runs. Re-running with an edited stage rotates its pins to the new digest.
await deployStages(admin, digests);

// `--observe`: also let them open the console's Graph and Feed views, which are the ops plane.
// A real widening (`observe` opens every read, unscoped) and therefore separate from being able to
// use the pipeline at all. Right for a single-user or demo space; wrong for a shared one.
const observe = Deno.args.includes("--observe");
const admit = async (a: typeof admin, principal: string) => {
  await grantUser(a, principal);
  if (observe) await grantObserve(a, principal);
};

// `--grant human:alice`: let somebody in by name. Repeatable.
//
// An SSO identity arrives with ZERO grants under a principal DERIVED from (issuer, subject) —
// `human:oidc-<32 hex>` — which nobody can know before that person's first sign-in. So granting by
// name works for a principal you already have, and `--auto-grant` is for the case you do not.
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--grant") {
    await admit(admin, Deno.args[i + 1]);
    console.error(`granted ${Deno.args[i + 1]}${observe ? " (+observe)" : ""}`);
  }
}

// `--auto-grant`: everyone the IdP vouches for may use this. A policy decision, which is why it is
// a flag — the runtime refuses to make it for you. With it, signing in as the bundled `demo` user
// is enough; without it a fresh identity signs in successfully and then sees nothing, because
// authenticated is not authorized.
// EVERY enrolled identity, not just the ones the sweep would admit. The sweep deliberately skips
// anyone already holding grants, so a GRANT added on a LATER run would never reach the people
// already using the app: `userGrants` grew `binding` and `stage_def` in an upgrade, and a person
// admitted before it kept the old set — the page then fails with "no 'query' grant for kind
// 'stage_def'" while the flag says everyone may use the app. Under auto-grant, admission is
// policy, so the whole CURRENT grant set is re-applied to everyone enrolled. Idempotent (grants
// are content-keyed), so this costs nothing on a restart. Without auto-grant the same upgrade
// needs `--grant` re-run per person, which is that policy working as declared.
for (const p of Deno.args.includes("--auto-grant") ? await enrolledPrincipals(admin).catch(() => []) : []) {
  await admit(admin, p);
}
if (observe && !Deno.args.includes("--auto-grant")) {
  // Observe alone still reaches everyone enrolled (the console power is meant for whoever is
  // already using the app), without widening anyone's pipeline grants.
  for (const p of await enrolledPrincipals(admin).catch(() => [])) {
    await grantObserve(admin, p);
  }
}

const stopGrants = new AbortController();
if (Deno.args.includes("--auto-grant")) {
  watchEnrolments(admin, stopGrants.signal, admit, console.error,
    (p) => `auto-grant: ${p} may now use the pipeline${observe ? " and inspect it in the console" : ""}`);
}

spawn([
  "examples/analysis/host.ts",
  "--url",
  url,
  "--reader-token",
  readerToken,
  ...STAGES.flatMap((stage) => ["--agent", `${stage}=${agentTokens[stage]}`]),
]);
spawn(["examples/analysis/planner.ts", "--url", url, "--token", plannerToken]);
spawn(["examples/analysis/serve.ts", "--url", url, "--port", port]);

const stop = () => {
  stopGrants.abort();
  for (const p of procs) {
    try {
      p.kill();
    } catch { /* already gone */ }
  }
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      stop();
      Deno.exit(0);
    });
  } catch { /* not on this platform */ }
}

await new Promise((r) => setTimeout(r, 400));
console.error(`\nanalysis pipeline: http://127.0.0.1:${port}`);
console.error(`  console:  ${url}/`);
if (health.oidc) {
  console.error(`  sign-in: ${health.oidc.issuer}`);
  // The exact string the browser will send, printed because Keycloak's refusal ("Invalid
  // parameter: redirect_uri") names neither the value it rejected nor the list it checked. It is
  // ORIGIN-sensitive: opening the app on localhost sends a different one than 127.0.0.1, and an
  // issuer that allows one does not thereby allow the other.
  console.error(`  redirect:  http://127.0.0.1:${port}/  (must be a Valid redirect URI on client ${health.oidc.clientId})`);
  if (!Deno.args.includes("--auto-grant")) {
    console.error(`  NOTE: a new SSO identity arrives with no grants and will see nothing.`);
    console.error(`        Restart with --auto-grant to admit everyone the IdP vouches for.`);
  }
} else if (spawnedSpace) {
  // Spawned by us WITH the flags, so an absent issuer here means the space rejected them.
  console.error(`\n  WARNING: the space started but advertises no issuer; check --oidc-issuer.`);
} else {
  console.error(`\n  WARNING: the space at ${url} advertises no OIDC issuer, so nobody can sign in.`);
  console.error(`  This process did not start it and cannot reconfigure it. Either restart that space`);
  console.error(`  with --oidc-issuer/--oidc-audience, or let this one start its own (drop --url).`);
}
console.error(`\nCtrl-C to stop.\n`);
await new Promise<void>(() => {});
