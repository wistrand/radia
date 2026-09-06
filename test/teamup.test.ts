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
    // UNDER THE TEAM, because a member name is unique only within its own file: two shipped teams
    // both name a member `ada`, and a flat directory gave them one working directory, one config
    // and one warm session id between them.
    assertStringIncludes(up.err, `cwd ${dir}/team/default/fake`);
    assertStringIncludes(up.out, "1 run: 0 settled, 1 ok");
    assertEquals((await admin.getEnvelope(id))!.state, "consumed");
    // The config the harness would read names the adapter with the member's session and token.
    const config = JSON.parse(await Deno.readTextFile(`${dir}/team/default/fake.mcp.json`)) as { mcpServers: { radia: { args: string[]; env: Record<string, string> } } };
    assert(config.mcpServers.radia.args.includes("--session") && config.mcpServers.radia.args.includes("fake"));
    assert(config.mcpServers.radia.env.RADIA_DEFINITION_TOKEN.length > 10);
    // It carries the definition token, so it is the owner's alone, like the credentials file.
    assertEquals((await Deno.stat(`${dir}/team/default/fake.mcp.json`)).mode! & 0o777, 0o600, "the MCP config is owner-only");
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

    // --seed-body: what a team is FOR is usually one field of one seed record, and editing the file
    // to change it makes team.json a scratchpad. Merged over the file's body, never over the team
    // label, since a seed outside the label is one no member can read.
    const asked = await cli(["team", "up", tdir, "--seed", "--seed-body", '{"title":"a different question","team":"elsewhere"}', "--once", "--url", url], env);
    assertEquals(asked.code, 0, asked.err);
    assertStringIncludes(asked.err, "(title, team from --seed-body)");
    const overridden = await admin.queryNewest<{ team?: string; title?: string }>({ kind: "task", match: { team: "game" } }, 5);
    assertEquals(overridden[0].body.title, "a different question", "the caller's field wins over the file's");
    assertEquals(overridden[0].body.team, "game", "the team label is not overridable");
    // Refused by NAME rather than ignored, and non-zero: `runCli` turns every thrown error into
    // exit 1, so what is asserted is the message and that it did not quietly seed the file's body.
    const badJson = await cli(["team", "up", tdir, "--seed", "--seed-body", "not json", "--once", "--url", url], env);
    assertEquals(badJson.code, 1, badJson.err);
    assertStringIncludes(badJson.err, "--seed-body is not JSON");
    const notObject = await cli(["team", "up", tdir, "--seed", "--seed-body", '["a"]', "--once", "--url", url], env);
    assertStringIncludes(notObject.err, "--seed-body must be a JSON object");
    const noSeed = await cli(["team", "up", tdir, "--seed-body", '{"title":"x"}', "--once", "--url", url], env);
    assertStringIncludes(noSeed.err, "--seed-body only means something with --seed");
    assertEquals((await admin.getEnvelope(seeded[0].id))!.state, "consumed");
    // Running it again mints nothing (the token is stored); the seed is what gives --once a claim.
    // This run uses a RELATIVE runtime directory from the team's own folder, the way a person runs
    // it: every path the harness is handed must still be absolute, since it runs elsewhere.
    const again = await cli(["team", "up", ".", "--init", "--seed", "--once", "--url", url], { ...env, RADIA_DIR: ".radia" }, tdir);
    assertEquals(again.code, 0, again.err);
    assert(!again.err.includes("minted"), again.err);
    // A file that GAINS a grant re-mints the stored member rather than skipping it: what the
    // member holds is read from enforcement, and a shortfall is a rotation.
    const widened = JSON.parse(await Deno.readTextFile(`${tdir}/team.json`)) as { members: Record<string, unknown>[] };
    widened.members[0].grants = ["note:take"];
    widened.members[0].unscopedGrants = ["sandbox:query"];
    await Deno.writeTextFile(`${tdir}/team.json`, JSON.stringify(widened));
    const grown = await cli(["team", "up", tdir, "--init", "--seed", "--once", "--url", url], env);
    assertEquals(grown.code, 0, grown.err);
    assertStringIncludes(grown.err, "[agent:player] re-minting: it lacks note:take sandbox:query");
    assertStringIncludes(grown.err, "[agent:player] minted for team game, token stored, +note:take, unscoped sandbox:query");
    const held = await admin.permissions("agent:player");
    assert(held.kinds.some((k) => k.kind === "note" && k.operations.includes("take")), JSON.stringify(held.kinds));
    assert(held.kinds.some((k) => k.kind === "sandbox" && k.operations.includes("query") && k.patterns.length === 0), "the unscoped grant is unscoped");
    const settled = await cli(["team", "up", tdir, "--init", "--seed", "--once", "--url", url], env);
    assertEquals(settled.code, 0, settled.err);
    assert(!settled.err.includes("minting") && !settled.err.includes("minted"), settled.err);
    assertStringIncludes(again.out, "1 run: 0 settled, 1 ok");
    const upLine = again.err.split("\n").find((l) => l.includes("[agent:player] up:"))!;
    assert(/config \/\S+\/team\/game\/player\.mcp\.json, cwd \/\S+\/team\/game\/player/.test(upLine), upLine);
    const relConfig = JSON.parse(await Deno.readTextFile(`${dir}/team/game/player.mcp.json`)) as { mcpServers: { radia: { env: Record<string, string> } } };
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
    assertStringIncludes(warned.err, `[warn] 1 open record from earlier runs will be claimed too (1 task); --fresh retires them first`);
    assertEquals((await admin.getEnvelope(leftover))!.state, "available", "a warning retires nothing");
    const fresh = await cli(["team", "up", ddir, "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(fresh.code, 0, fresh.err);
    assertStringIncludes(fresh.err, "[fresh] 1 open record from earlier runs dead-lettered (1 task)");
    assertEquals((await admin.getEnvelope(leftover))!.state, "dead_letter");

    // A WARM SESSION IS A LEFTOVER TOO. A `resume` member's harness session id outlives the verb on
    // purpose, so without this the first move of NEW work opens in the session that finished the
    // last piece and the member is handed its resume prompt: measured on a real team, three members
    // answered a fresh job as if revising one that did not exist. `--fresh` means start cold, and
    // it must reach only THIS team's members, which is what the per-team directory is for.
    const wdir = `${dir}/warm`;
    await Deno.mkdir(wdir, { recursive: true });
    await Deno.writeTextFile(`${wdir}/team.json`, JSON.stringify({
      team: "warmteam",
      // A NAME OF ITS OWN, not `solver` again: a member name IS the principal, so reusing one
      // across two teams supersedes its definition and moves its grants to whichever team minted
      // last. That is the clash the per-team directory does not fix, and it hangs this test.
      members: [{ name: "warmer", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], env: { FAKE_MODE: "exit0" }, resume: true, prompt: "go {{claimId}}", patterns: [{ kind: "task", match: { tags: { $any: "warmer" } } }] }],
      seed: [{ kind: "task", body: { title: "warm job", tags: ["warmer"] } }],
    }));
    const warmFile = `${dir}/team/warmteam/warmer.harness-session`;
    const otherTeam = `${dir}/team/quiz/warmer.harness-session`;
    await Deno.mkdir(`${dir}/team/warmteam`, { recursive: true });
    await Deno.mkdir(`${dir}/team/quiz`, { recursive: true });
    await Deno.writeTextFile(warmFile, "session-from-the-last-song");
    await Deno.writeTextFile(otherTeam, "another-team-session");
    const cold = await cli(["team", "up", wdir, "--init", "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(cold.code, 0, cold.err);
    assertStringIncludes(cold.err, "[fresh] 1 warm harness session dropped (warmer); they start cold");
    assertEquals(await Deno.stat(warmFile).then(() => true, () => false), false, "the team's own warm session is gone");
    assertEquals(await Deno.readTextFile(otherTeam), "another-team-session", "another team's session is untouched");

    // LEFTOVERS ON THE TEAM'S OWN KINDS, not just `task`. A team that routes its own kinds swept
    // NOTHING here, so a previous run's records were claimed beside the new seed: measured live,
    // two songs written at once and both paid for. The sweep now covers what the members' patterns
    // claim and what any member holds a `take` grant on, which is what a service states.
    await admin.registerKind({ kind: "errand", indexedPaths: [{ path: "team", type: "keyword" }, { path: "tags", type: "array" }], claimable: true });
    const kdir = `${dir}/kinds`;
    await Deno.mkdir(kdir, { recursive: true });
    await Deno.writeTextFile(`${kdir}/team.json`, JSON.stringify({
      team: "errands",
      members: [
        { name: "runner", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], env: { FAKE_MODE: "exit0" }, prompt: "go {{claimId}}", patterns: [{ kind: "errand", match: { tags: { $any: "runner" } } }], grants: ["errand:take,query,read_one"] },
        // A SERVICE claims through its own loop and states only the grant, so the sweep has to read
        // grants as well as patterns or this kind is missed entirely.
        { name: "sweeperservice", service: true, command: [Deno.execPath(), "eval", "await new Promise(() => {})"], grants: ["chore:take,query,read_one"] },
      ],
      seed: [{ kind: "errand", body: { title: "the new errand", tags: ["runner"] } }],
    }));
    await admin.registerKind({ kind: "chore", indexedPaths: [{ path: "team", type: "keyword" }], claimable: true });
    const staleErrand = await admin.put({ kind: "errand", body: { team: "errands", title: "from an earlier run", tags: ["runner"] } });
    const staleChore = await admin.put({ kind: "chore", body: { team: "errands", title: "a service's leftover" } });
    const swept = await cli(["team", "up", kdir, "--init", "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(swept.code, 0, swept.err);
    assertStringIncludes(swept.err, "2 open records from earlier runs dead-lettered");
    assertStringIncludes(swept.err, "1 errand");
    assertStringIncludes(swept.err, "1 chore", "a kind only a SERVICE claims is swept too");
    assertEquals((await admin.getEnvelope(staleErrand.id))!.state, "dead_letter");
    assertEquals((await admin.getEnvelope(staleChore.id))!.state, "dead_letter", "the service's kind was swept");

    // A KILLED RUN'S RECORD IS LEASED, NOT AVAILABLE, and it is the leftover that actually bites: the
    // lease lapses lazily, on the next take, so a sweep of `available` alone reported a clean space
    // and handed a previous song's parts to two players seconds later. Twice, on a live team.
    const abandoned = await admin.put({ kind: "chore", body: { team: "errands", title: "held by a worker that died" } });
    const gone = await admin.take({ pattern: { kind: "chore", match: { team: "errands" } } }, { leaseSeconds: 1 });
    assertEquals(gone?.record.id, abandoned.id);
    assertEquals((await admin.getEnvelope(abandoned.id))!.state, "leased");
    await new Promise((r) => setTimeout(r, 1200)); // the lease lapses; nothing reclaims it on its own
    const afterKill = await cli(["team", "up", kdir, "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(afterKill.code, 0, afterKill.err);
    assertEquals((await admin.getEnvelope(abandoned.id))!.state, "dead_letter", "an expired lease is a leftover too");

    // A LIVE lease is left alone, because it may belong to a run that is still going.
    const live = await admin.put({ kind: "chore", body: { team: "errands", title: "someone is working on this" } });
    const holding = await admin.take({ pattern: { kind: "chore", match: { team: "errands" } } }, { leaseSeconds: 120 });
    assertEquals(holding?.record.id, live.id);
    const careful = await cli(["team", "up", kdir, "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(careful.code, 0, careful.err);
    assertStringIncludes(careful.err, "under a LIVE lease and cannot be retired");
    assertEquals((await admin.getEnvelope(live.id))!.state, "leased", "a live lease is never fenced by --fresh");

    // A SERVICE THAT TRAPS SIGTERM is killed anyway, and the verb exits. Without the escalation both
    // survived: measured on a live team, a producer from an interrupted run went on claiming for
    // hours and beat the current one to a song's parts, answering with the code it started with.
    // `await child.status` never resolved either, so the verb hung instead of stopping.
    const stubbornDir = `${dir}/stubborn`;
    await Deno.mkdir(stubbornDir, { recursive: true });
    const stubbornSvc = `${stubbornDir}/svc.ts`;
    await Deno.writeTextFile(
      stubbornSvc,
      `try { Deno.addSignalListener("SIGTERM", () => {}); Deno.addSignalListener("SIGINT", () => {}); } catch {}\n` +
        `console.error("svc up");\nwhile (true) await new Promise((r) => setTimeout(r, 200));\n`,
    );
    await Deno.writeTextFile(`${stubbornDir}/team.json`, JSON.stringify({
      team: "stubborn",
      members: [{ name: "svc", service: true, command: [Deno.execPath(), "run", "-A", stubbornSvc] }],
    }));
    const proc = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("../src/main.ts", import.meta.url).pathname, "team", "up", stubbornDir, "--init", "--url", url],
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const err: string[] = [];
    const drain = proc.stderr.pipeTo(new WritableStream({ write: (c) => void err.push(new TextDecoder().decode(c)) })).catch(() => {});
    for (let i = 0; i < 100 && !err.join("").includes("svc up"); i++) await new Promise((r) => setTimeout(r, 100));
    proc.kill("SIGINT");
    // The verb must EXIT, and within the grace period plus slack rather than never.
    const ended = await Promise.race([proc.status, new Promise((r) => setTimeout(() => r(null), 20_000))]);
    await drain;
    await proc.stdout.cancel();
    assert(ended !== null, `team up did not exit after SIGINT: ${err.join("")}`);
    assertStringIncludes(err.join(""), "did not stop on SIGTERM", "the escalation is what makes that true");

    // A FOREIGN CLAIMANT: a principal outside the team, holding an UNSCOPED take on a kind a member
    // claims, listening. It wins the race and answers outside the compartment (the chat's exec
    // worker took the go-fish dealer's tool_call), so the verb names it at start. One scoped to
    // ANOTHER team cannot claim these records and is not reported.
    const outsider = await admin.createAgentDefinition("agent:outsider", [
      { principal: "agent:outsider", kind: "task", operations: ["take"] },
      { principal: "agent:outsider", kind: "interest", operations: ["put"] },
    ]);
    await new RadiaClient(url, { definitionToken: outsider.definitionToken }).publishInterest({ kind: "task" });
    const elsewhere = await admin.createAgentDefinition("agent:other-team", [
      { principal: "agent:other-team", kind: "interest", operations: ["put"] },
    ]);
    await admin.grant("agent:other-team", "task", ["take"], { team: "elsewhere" });
    await new RadiaClient(url, { definitionToken: elsewhere.definitionToken }).publishInterest({ kind: "task", match: { team: "elsewhere" } });
    // Unscoped, but listening for a tag this team never uses: its interest cannot overlap the
    // solver's `tags: {$any: "solver"}`, the way the chat's image worker listens on `tool_call`
    // for its own tool name and can never take a `run_javascript` call.
    const tagger = await admin.createAgentDefinition("agent:tagger", [
      { principal: "agent:tagger", kind: "task", operations: ["take"] },
      { principal: "agent:tagger", kind: "interest", operations: ["put"] },
    ]);
    await new RadiaClient(url, { definitionToken: tagger.definitionToken }).publishInterest({ kind: "task", match: { tags: { $any: "tagger" } } });
    const foreign = await cli(["team", "up", ddir, "--seed", "--fresh", "--once", "--url", url], env);
    assertEquals(foreign.code, 0, foreign.err);
    assertStringIncludes(foreign.err, "[warn] agent:outsider listens on task as {} with an UNSCOPED take and is not a member of team quiz");
    assert(!foreign.err.includes("agent:other-team"), foreign.err);
    assert(!foreign.err.includes("agent:tagger"), foreign.err);

    // A SERVICE member: spawned once with its token in the environment, its output relayed, its
    // extra and unscoped grants written by --init, and the team's kinds declared. The service here
    // is a script that prints its principal (from the token it was handed) and waits.
    const sdir = `${dir}/svc`;
    await Deno.mkdir(sdir, { recursive: true });
    await Deno.writeTextFile(`${sdir}/svc.ts`, `
      import { RadiaClient } from "${new URL("../sdk/ts/client.ts", import.meta.url).href}";
      const c = new RadiaClient(Deno.env.get("RADIA_URL")!, { definitionToken: Deno.env.get("RADIA_DEFINITION_TOKEN")! });
      const h = await c.health();
      // Its OWN permissions: a member may read those and nobody else's, and the run's agent is
      // what the permissions are keyed by.
      const mine = await c.permissions(h.agent ?? "agent:helper");
      console.log("svc up as " + h.principal + " with " + mine.kinds.map((k) => k.kind + ":" + k.operations.join(",")).sort().join(" "));
      await new Promise((r) => setTimeout(r, 60_000));
    `);
    // The space already declares `widget` with MORE paths (another app's), so the team's narrower
    // declaration must merge over it rather than be refused as an incompatible redeclaration.
    await admin.registerKind({ kind: "widget", indexedPaths: [{ path: "team", type: "keyword" }, { path: "owner", type: "keyword" }], claimable: true });
    await Deno.writeTextFile(`${sdir}/team.json`, JSON.stringify({
      team: "svc",
      kinds: [{ kind: "widget", indexedPaths: [{ path: "team", type: "keyword" }] }],
      members: [
        { name: "helper", service: true, command: [Deno.execPath(), "run", "-A", `${sdir}/svc.ts`], grants: ["widget:take"], unscopedGrants: ["interest:query"] },
        { name: "asker", harness: "script", command: [Deno.execPath(), "run", "-A", fixture], env: { FAKE_MODE: "exit0" }, patterns: [{ kind: "task", match: { tags: { $any: "asker" } } }] },
      ],
      seed: [{ kind: "task", body: { title: "one", tags: ["asker"] } }],
    }));
    // The service claims `widget` through its own loop and the file states only the GRANT, so a
    // foreign unscoped claimant on that kind is found from the grant, not from a pattern.
    const grabber = await admin.createAgentDefinition("agent:grabber", [
      { principal: "agent:grabber", kind: "widget", operations: ["take"] },
      { principal: "agent:grabber", kind: "interest", operations: ["put"] },
    ]);
    await new RadiaClient(url, { definitionToken: grabber.definitionToken }).publishInterest({ kind: "widget" });
    const svc = await cli(["team", "up", sdir, "--init", "--seed", "--once", "--url", url], env);
    assertEquals(svc.code, 0, svc.err);
    assertStringIncludes(svc.err, "[warn] agent:grabber listens on widget as {} with an UNSCOPED take and is not a member of team svc");
    assertStringIncludes(svc.err, "[kinds] widget declared (merged over the live declaration)");
    const widget = (await admin.listKinds()).find((k) => k.kind === "widget")!;
    assert(widget.indexedPaths.some((p) => p.path === "owner"), "the merge kept the other app's path");
    assertStringIncludes(svc.err, "[agent:helper] minted for team svc, token stored, +widget:take, unscoped interest:query");
    assertStringIncludes(svc.err, "[agent:helper] up: service ");
    assert(/\[agent:helper\] \| svc up as \S+ with .*interest:put,query .*widget:take/.test(svc.err), svc.err);
    assertStringIncludes(svc.out, "1 run: 0 settled, 1 ok");

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
