// Bring the world up in one command: the space, its kinds, the rooms, the narrator, and one
// process per NPC.
//
//   deno task mud                              # spawns a space if none is running
//   deno task mud -- --player alice            # …and mints somebody to play as
//   deno task mud -- --url http://…            # …or attach to a space already running
//
// Needs an OPERATOR credential (`radia dev` writes one, including for the space this spawns),
// because registering kinds and minting identities is privileged. Nothing it launches holds that
// credential: the narrator and each NPC get their own least-privilege definition token.
//
// No OIDC here, unlike examples/analysis. Phase 1 has no page, so there is nobody to sign in; a
// player is an ordinary minted principal. Phase 2 replaces `--player` with SSO and this file grows
// the same issuer flags the analysis launcher has.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerMudKinds, WORLD_ID } from "./kinds.ts";
import { NPCS, seedWorld } from "./world.ts";
import { bootstrap, playerGrants } from "./roles.ts";

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};
const args = (n: string) => Deno.args.flatMap((a, i) => a === n && Deno.args[i + 1] ? [Deno.args[i + 1]] : []);

const url = arg("--url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const spacePort = new URL(url).port || "7788";
const db = arg("--db") ?? `${Deno.env.get("RADIA_DIR") ?? ".radia"}/mud.db`;

const procs: Deno.ChildProcess[] = [];
const spawn = (a: string[], quiet = false) => {
  const p = new Deno.Command("deno", {
    args: ["run", "-A", ...a],
    stdout: quiet ? "null" : "inherit",
    stderr: quiet ? "null" : "inherit",
  }).spawn();
  procs.push(p);
  return p;
};

const probe = new RadiaClient(url);
let up = await probe.health().catch(() => null);
if (!up) {
  // `--db` is what makes a world resumable: without it the space is in-memory and everyone forgets
  // where they were standing the moment you stop it.
  console.error(`no space at ${url}; starting one (${db})`);
  spawn(["src/main.ts", "dev", "--port", spacePort, "--storage", "sqlite", "--db", db], true);
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    up = await probe.health().catch(() => null);
  }
  if (!up) {
    console.error(`the space did not start. Is ${url} already taken by something else?`);
    Deno.exit(1);
  }
}

const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerMudKinds(admin);
await seedWorld(admin);
const { narratorToken, npcTokens } = await bootstrap(admin);

// A player, as a minted principal. `--player alice` is repeatable; the definition token it prints
// is durable, so it is the thing to keep out of a shell history in anything that is not a demo.
const players: { principal: string; token: string }[] = [];
for (const name of args("--player")) {
  const principal = `agent:mud-${name}`;
  const def = await admin.createAgentDefinition(
    principal,
    playerGrants(principal).map((g) => ({ principal, kind: g.kind, operations: g.operations, ...(g.pattern ? { pattern: g.pattern } : {}) })),
  );
  // No separate `grantPlayer` call: the definition ASSIGNS the same grants, and re-assigning them
  // here would be a second write of records that are content-keyed to the same identity. That
  // function is for phase 2, where an SSO identity already exists and holds no definition.
  players.push({ principal, token: def.definitionToken });
}

spawn(["examples/mud/narrator.ts", "--url", url, "--token", narratorToken]);
for (const npc of NPCS) {
  spawn(["examples/mud/npc.ts", "--url", url, "--npc", npc.npc, "--name", npc.name, "--token", npcTokens[npc.npc]]);
}

const stop = () => {
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
console.error(`\nworld '${WORLD_ID}' is up: ${NPCS.length} NPCs, narrator running`);
console.error(`  console: ${url}/`);
if (players.length === 0) {
  console.error(`\n  Nobody can play yet. Restart with --player <name> to mint someone.`);
}
for (const p of players) {
  console.error(`\n  ${p.principal}:`);
  console.error(`    deno run -A examples/mud/play.ts --url ${url} --as ${p.principal} --token ${p.token}`);
}
console.error(`\nCtrl-C to stop.\n`);
await new Promise<void>(() => {});
