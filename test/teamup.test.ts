// `radia team up` end to end (src/surfaces/cli.ts -> extensions/ts/harness-worker.ts): a space, a
// member `team add` minted and stored, a team.json whose harness is a script with no model, one
// task, one claim, one launch, one settlement. The driver's own contract is in
// extensions/conformance/harness-worker.test.ts; this is the VERB: the file read, the member's
// stored token found, the session shared, the config written, the summary printed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RadiaClient } from "../sdk/ts/client.ts";
import { resolveToken } from "../src/credentials.ts";

const PORT = 7879;
const url = `http://127.0.0.1:${PORT}`;

async function cli(args: string[], env: Record<string, string>, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", main, ...args], env, cwd, stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

Deno.test("team up: runs a team.json member as a worker that launches its harness per claim", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-teamup-" });
  const creds = `${dir}/credentials.json`;
  const env = { RADIA_CREDENTIALS: creds, RADIA_DIR: `${dir}/radia`, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" };
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    env,
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    const probe = new RadiaClient(url);
    for (let i = 0; i < 400; i++) {
      try {
        await probe.health();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    Deno.env.set("RADIA_CREDENTIALS", creds);
    const admin = new RadiaClient(url, { token: resolveToken(url)! });

    // Setup, the privileged step: the member is minted and its token stored where `up` reads it.
    const add = await cli(["team", "add", "fake", "--team", "t", "--harness", "json", "--url", url], env);
    assertEquals(add.code, 0, add.err);
    const stored = JSON.parse(await Deno.readTextFile(creds)) as Record<string, unknown>;
    assert(Object.keys(stored).some((k) => k.endsWith("#member:agent:fake")), Object.keys(stored).join(","));

    const fixture = new URL("../extensions/conformance/fake-harness.ts", import.meta.url).pathname;
    const file = `${dir}/team.json`;
    await Deno.writeTextFile(file, JSON.stringify({
      members: [{ name: "fake", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], env: { FAKE_MODE: "exit0" }, timeoutSeconds: 20 }],
    }));
    const { id } = await admin.put({ kind: "task", body: { team: "t", title: "one job", tags: ["fake"] } });

    const up = await cli(["team", "up", file, "--once", "--url", url], env);
    assertEquals(up.code, 0, up.err);
    assertStringIncludes(up.err, "[agent:fake] up: script");
    assertStringIncludes(up.err, `fake harness got`);
    assertStringIncludes(up.err, `record ${id}`);
    // A directory per member beside the credentials file, never under the project: Claude Code
    // applies a project's `disabledMcpServers` by name to a server passed with --mcp-config.
    assertStringIncludes(up.err, `cwd ${dir}/team/fake`);
    assertStringIncludes(up.out, "1 run: 0 settled, 1 ok");
    assertEquals((await admin.getEnvelope(id))!.state, "consumed");
    // The config the harness would read names the adapter with the member's session and token.
    const config = JSON.parse(await Deno.readTextFile(`${dir}/team/fake.mcp.json`)) as { mcpServers: { radia: { args: string[]; env: Record<string, string> } } };
    assert(config.mcpServers.radia.args.includes("--session") && config.mcpServers.radia.args.includes("fake"));
    assert(config.mcpServers.radia.env.RADIA_DEFINITION_TOKEN.length > 10);
    // It carries the definition token, so it is the owner's alone, like the credentials file.
    assertEquals((await Deno.stat(`${dir}/team/fake.mcp.json`)).mode! & 0o777, 0o600, "the MCP config is owner-only");
    // A harness passes its MCP server only this env, so the session store must travel with it, or
    // the adapter lands on a run of its own and cannot settle the loop's claim.
    assertEquals(config.mcpServers.radia.env.RADIA_CREDENTIALS, creds);
    assertEquals(config.mcpServers.radia.env.RADIA_DIR, `${dir}/radia`);

    // A TEAM DIRECTORY, bootstrapped by the verb itself: --init mints the member the file names
    // under its team label and stores the token, --seed writes the opening record with the label,
    // and the prompt comes from a file beside team.json.
    const tdir = `${dir}/game`;
    await Deno.mkdir(`${tdir}/prompts`, { recursive: true });
    await Deno.writeTextFile(`${tdir}/prompts/p.md`, "play: {{recordId}} {{claimId}}");
    await Deno.writeTextFile(`${tdir}/team.json`, JSON.stringify({
      team: "game",
      members: [{ name: "player", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], promptFile: "prompts/p.md", env: { FAKE_MODE: "exit0" }, patterns: [{ kind: "task", match: { tags: { $any: "player" } } }] }],
      seed: [{ kind: "task", body: { title: "opening move", tags: ["player"] } }],
    }));
    const game = await cli(["team", "up", tdir, "--init", "--seed", "--once", "--url", url], env);
    assertEquals(game.code, 0, game.err);
    assertStringIncludes(game.err, "[agent:player] minted for team game, token stored");
    assertStringIncludes(game.err, "[seed] task ");
    assertStringIncludes(game.err, "fake harness got");
    assertStringIncludes(game.out, "1 run: 0 settled, 1 ok");
    const seeded = await admin.queryNewest<{ team?: string; title?: string }>({ kind: "task", match: { team: "game" } }, 5);
    assertEquals(seeded.length, 1);
    assertEquals(seeded[0].body.title, "opening move", "the seed carries the team label the file names");
    assertEquals((await admin.getEnvelope(seeded[0].id))!.state, "consumed");
    // Running it again mints nothing (the token is stored); the seed is what gives --once a claim.
    // This run uses a RELATIVE runtime directory from the team's own folder, the way a person runs
    // it: every path the harness is handed must still be absolute, since it runs elsewhere.
    const again = await cli(["team", "up", ".", "--init", "--seed", "--once", "--url", url], { ...env, RADIA_DIR: ".radia" }, tdir);
    assertEquals(again.code, 0, again.err);
    assert(!again.err.includes("minted"), again.err);
    assertStringIncludes(again.out, "1 run: 0 settled, 1 ok");
    const upLine = again.err.split("\n").find((l) => l.includes("[agent:player] up:"))!;
    assert(/config \/\S+\/team\/player\.mcp\.json, cwd \/\S+\/team\/player/.test(upLine), upLine);
    const relConfig = JSON.parse(await Deno.readTextFile(`${dir}/team/player.mcp.json`)) as { mcpServers: { radia: { env: Record<string, string> } } };
    assert(relConfig.mcpServers.radia.env.RADIA_DIR.startsWith("/") && relConfig.mcpServers.radia.env.RADIA_CREDENTIALS.startsWith("/"), JSON.stringify(relConfig));

    // DONE: a team whose file names what the final answer looks like ends itself, no --once. The
    // fake harness settles with a note carrying topic "final"; the verb prints it and exits 0.
    const ddir = `${dir}/done`;
    await Deno.mkdir(ddir, { recursive: true });
    await Deno.writeTextFile(`${ddir}/team.json`, JSON.stringify({
      team: "quiz",
      members: [{ name: "solver", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], env: { FAKE_MODE: "settle", FAKE_TOPIC: "final", FAKE_TEAM: "quiz", FAKE_SESSION: "solver" }, prompt: "solve {{claimId}}", patterns: [{ kind: "task", match: { tags: { $any: "solver" } } }] }],
      seed: [{ kind: "task", body: { title: "the question", tags: ["solver"] } }],
      done: { kind: "note", match: { topic: "final" } },
    }));
    const done = await cli(["team", "up", ddir, "--init", "--seed", "--url", url], env);
    assertEquals(done.code, 0, done.err);
    assertStringIncludes(done.err, "[done] note ");
    assertStringIncludes(done.out, "1 run: 1 settled");
    assertStringIncludes(done.out, "done: note ");
    assertStringIncludes(done.out, '"answer": 42');

    // LEFTOVERS: a seed on top of an open task from an earlier run is counted and named, and
    // --fresh dead-letters the leftovers first so a new game does not interleave with the last.
    const { id: leftover } = await admin.put({ kind: "task", body: { team: "quiz", title: "from an earlier run", tags: ["nobody"] } });
    const warned = await cli(["team", "up", ddir, "--seed", "--once", "--url", url], env);
    assertEquals(warned.code, 0, warned.err);
    assertStringIncludes(warned.err, `[warn] 1 open task from earlier runs will be claimed too (${leftover.slice(-6)}); --fresh retires them first`);
    assertEquals((await admin.getEnvelope(leftover))!.state, "available", "a warning retires nothing");
    const fresh = await cli(["team", "up", ddir, "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(fresh.code, 0, fresh.err);
    assertStringIncludes(fresh.err, "[fresh] 1 open task from earlier runs dead-lettered");
    assertEquals((await admin.getEnvelope(leftover))!.state, "dead_letter");

    // A member nobody minted here is refused by name, with the fix.
    await Deno.writeTextFile(file, JSON.stringify({ members: [{ name: "ghost", harness: "script", command: ["true"] }] }));
    const ghost = await cli(["team", "up", file, "--once", "--url", url], env);
    assertEquals(ghost.code, 1);
    assertStringIncludes(ghost.err, "agent:ghost: no definition token on this machine. Add --init");
  } finally {
    try {
      space.kill("SIGTERM");
    } catch { /* gone */ }
    await space.status;
  }
});
