// What a fleet restart costs the AUTHORIZATION SURFACE.
//
//   deno run -A examples/chat/smoke-restart.ts
//
// No model, no API key. `bootstrap` mints a definition per worker, and a definition token is shown
// once and stored as a hash, so a restarting fleet cannot recover the one it had and must create
// another. What it must not do is leave the old one MINTING. Measured before this was fixed:
// 25 `agent_definition` records for each of six workers, 150 standing and every one of them still
// able to mint a run, because `agent_definition` is in `NEVER_COMPACT` and nothing revoked them
// (plan-startup-ergonomics.md item 8).
//
// The record COUNT still grows, and that is not the bug: a revocation is a successor, so rotating
// writes more records than not rotating. What is bounded is how many credentials can act.
//
// This is a script, not a `*.test.ts`: `deno task test:runtime` is for PORT contracts, not examples.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, mintSession } from "./space/roles.ts";

const PORT = 7813;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(admin);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

/** Can this token still mint? The only question that matters: a revoked definition's RECORD stays,
 *  and asking the record's status would be asking a different question than the enforcement path. */
async function mints(token: string): Promise<boolean> {
  try {
    await new RadiaClient(url, { token: "" }).createRun(token);
    return true;
  } catch {
    return false;
  }
}

const WORKERS = ["agent:chat-inference", "agent:chat-router", "agent:chat-tools", "agent:chat-images", "agent:chat-exec", "agent:chat-turn"];
const defsFor = async (agent: string) => (await admin.queryAll({ kind: "agent_definition", match: { agent } })).length;

try {
  // One process boots once. A second call in the SAME process must not rotate: it would revoke the
  // tokens the first call already handed to running workers, and they would fail to mint. That is
  // not hypothetical, it is what the turn-link suite failed with before the memo went in.
  const first = await bootstrap(admin);
  const again = await bootstrap(admin);
  check("bootstrap twice in one process returns the SAME tokens", first.turnToken === again.turnToken);
  check("…so the first call's tokens still mint", await mints(first.inferenceToken));

  // A RESTART is a different process, which is a fresh module and therefore a fresh memo. Simulated
  // by minting the same definitions the way a second `--serve` would.
  const before = await defsFor("agent:chat-turn");
  const tokens: string[] = [first.turnToken];
  for (let i = 0; i < 3; i++) {
    const mod = await import(`./space/roles.ts?restart=${i}`) as typeof import("./space/roles.ts");
    tokens.push((await mod.bootstrap(admin)).turnToken);
  }
  const live: boolean[] = [];
  for (const t of tokens) live.push(await mints(t));
  const stillMinting = live.filter(Boolean).length;
  check("after three restarts exactly ONE definition token still mints", stillMinting === 1, `${stillMinting} of ${tokens.length}`);
  check("…and it is the newest one", live[live.length - 1] === true);
  const after = await defsFor("agent:chat-turn");
  check("the record count grows (a revocation is a successor, not a delete)", after > before, `${before} -> ${after}`);

  // A SESSION is not a fleet and must never rotate: several sessions for one person are legitimately
  // live at once, and revoking on each mint would kill every one before the newest.
  const s1 = await mintSession(admin, "human:restart");
  const s2 = await mintSession(admin, "human:restart");
  const c1 = new RadiaClient(url, { token: s1 });
  const c2 = new RadiaClient(url, { token: s2 });
  const both = (await c1.health()).principal !== undefined && (await c2.health()).principal !== undefined;
  check("two sessions for one person are both live", both);

  // Every worker, not just the one the counting used.
  let allOne = true;
  for (const w of WORKERS) {
    const rows = await admin.queryAll({ kind: "agent_definition", match: { agent: w } });
    const newest = rows[rows.length - 1];
    if (!newest || (newest.body as { status?: string }).status === "revoked") allOne = false;
  }
  check("every worker ends with an active newest definition", allOne);
} finally {
  space.kill();
  await space.status;
}

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
