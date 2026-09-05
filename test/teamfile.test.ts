// `team.json` (src/surfaces/teamfile.ts): what `radia team up` accepts, refused by name where a
// field that narrows would otherwise widen silently, and how a harness template is filled.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { BUILTIN_HARNESSES, FRAME, framePrompt, harnessTemplates, loadTeamFile, parseTeamFile, RESUME_FRAME, substitute } from "../src/surfaces/teamfile.ts";
import { UsageError } from "../src/platform.ts";

Deno.test("teamfile: a minimal file parses, names are normalised, defaults are left to the verb", () => {
  const t = parseTeamFile(JSON.stringify({ members: [{ name: "agent:claude-alpha", harness: "claude", model: "opus" }] }));
  assertEquals(t.members.length, 1);
  assertEquals(t.members[0].name, "claude-alpha");
  assertEquals(t.members[0].patterns, undefined);
  assertEquals(t.url, undefined);
});

Deno.test("teamfile: unknown and mistyped fields are refused by name", () => {
  const bad = (file: unknown, re: RegExp) => {
    const e = assertThrows(() => parseTeamFile(JSON.stringify(file), "x.json"), UsageError);
    assert(re.test(e.message), e.message);
  };
  bad({ members: [{ name: "a", harness: "claude", timeoutSecond: 5 }], }, /unknown field 'timeoutSecond'/);
  bad({ members: [{ name: "a", harness: "claude", patterns: [{ match: {} }] }] }, /names a kind/);
  bad({ members: [{ name: "a", harness: "gemini" }] }, /not built in/);
  bad({ members: [{ name: "a", harness: "claude" }, { name: "agent:a", harness: "codex" }] }, /listed twice/);
  bad({ members: [{ name: "a", harness: "claude", concurrency: 0 }] }, /positive number/);
  bad({ member: [] }, /unknown field 'member'/);
  bad({ members: [] }, /non-empty/);
  bad("[]", /expected an object/);
});

Deno.test("teamfile: a file may bring its own harness template, or a member its own command", () => {
  const t = parseTeamFile(JSON.stringify({
    harnesses: { mine: { command: ["run-it", "{{prompt}}"] } },
    members: [{ name: "a", harness: "mine" }, { name: "b", harness: "whatever", command: ["true"] }],
  }));
  assertEquals(t.harnesses?.mine.command, ["run-it", "{{prompt}}"]);
  assertEquals(t.members[1].command, ["true"]);
});

Deno.test("teamfile: substitution fills every placeholder but the prompt, and drops the model flag with no model", () => {
  const values = { model: "", config: "/tmp/m.json", url: "http://x", binary: "radia", mcpArgs: "[]", token: "t", codexTools: "{}", session: "s", credentials: "/c.json", radiaDir: "/r" };
  const claude = substitute(BUILTIN_HARNESSES.claude, values);
  assert(!claude.includes("--model"), claude.join(" "));
  assert(!claude.includes("{{model}}"));
  assert(claude.includes("/tmp/m.json"));
  const withModel = substitute(BUILTIN_HARNESSES.claude, { ...values, model: "opus" });
  assertEquals(withModel.slice(withModel.indexOf("--model"), withModel.indexOf("--model") + 2), ["--model", "opus"]);
  const codex = substitute(BUILTIN_HARNESSES.codex, { ...values, model: "gpt" });
  assert(codex.some((s) => s === 'mcp_servers.radia.env={ RADIA_DEFINITION_TOKEN = "t", RADIA_CREDENTIALS = "/c.json", RADIA_DIR = "/r" }'), codex.join(" "));
  assertEquals(substitute(["x", "{{prompt}}"], values), ["x", "{{prompt}}"], "the prompt is filled per claim, not here");
  for (const f of [FRAME, RESUME_FRAME]) assert(f.includes("{{claimId}}") && f.includes("{{body}}") && f.includes("{{recordId}}") && f.includes("{{job}}"), f);
});

Deno.test("teamfile: a team is a directory, with the label, the seed and prompts beside the file", () => {
  const files: Record<string, string> = {
    "t/team.json": JSON.stringify({
      team: "game",
      members: [{ name: "a", harness: "claude", promptFile: "prompts/a.md" }],
      seed: [{ kind: "task", body: { title: "go", tags: ["a"] } }],
    }),
    "t/prompts/a.md": "you are {{agent}}",
  };
  const t = loadTeamFile("t", (p) => files[p]);
  assertEquals(t.dir, "t");
  assertEquals(t.team, "game");
  assertEquals(t.members[0].prompt, "you are {{agent}}");
  assertEquals(t.seed?.length, 1);
  assertEquals(loadTeamFile("t/team.json", (p) => files[p]).members[0].prompt, "you are {{agent}}", "a file path works too");
  const e = assertThrows(() => loadTeamFile("missing", (p) => files[p]), UsageError);
  assert(/missing\/team.json: not found/.test(e.message), e.message);
  const bad = assertThrows(() => loadTeamFile("t", (p) => (p === "t/prompts/a.md" ? undefined : files[p])), UsageError);
  assert(/promptFile prompts\/a.md, which is not beside it/.test(bad.message), bad.message);
  assertThrows(() => parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude" }], seed: [{ kind: "task" }] })), UsageError, "must be {kind, body}");
  assertThrows(() => parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude" }], seed: [{ kind: "task", body: {}, tags: [] }] })), UsageError, "unknown field 'tags'");
  assertEquals(parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude" }], done: { kind: "note", match: { topic: "final" } } })).done, { kind: "note", match: { topic: "final" } });
  assertThrows(() => parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude" }], done: { match: {} } })), UsageError, "'done' must be a pattern naming a kind");
});

Deno.test("teamfile: the shipped example teams parse, name a harness each, and their prompts exist", () => {
  for (const name of ["twenty-questions", "story-relay", "go-fish"]) {
    const t = loadTeamFile(`examples/teams/${name}`, (p) => {
      try {
        return Deno.readTextFileSync(p);
      } catch {
        return undefined;
      }
    });
    assertEquals(t.team, name);
    assert(t.members.length >= 2 && t.members.every((m) => m.service ? !!m.command : (m.harness in BUILTIN_HARNESSES && m.prompt)), name);
    assert(t.seed && t.seed.length >= 1 && t.seed.every((r) => r.kind === "task"), `${name} seeds a task`);
    assertEquals(t.done, { kind: "note", match: { topic: "final" } }, `${name} ends on a final note`);
    assert(t.members.filter((m) => !m.service).every((m) => m.resume === true && m.resumePrompt), `${name} runs warm sessions with a resume prompt`);
    // The game's prompts carry NO mechanics: the frame does, so a prompt says only the rules.
    // go-fish is the stated exception: drawing from the pile (a take) and keeping a hand (a note
    // query) are moves the frame does not have, so its prompt names those two tools and no other.
    for (const m of t.members) for (const text of m.service ? [] : [m.prompt!, m.resumePrompt!]) {
      assert(!/claimId|space_lineage|parentIds/.test(text), `${name}/${m.name}: mechanics in the prompt: ${text.slice(0, 80)}`);
      if (name !== "go-fish") assert(!/space_ack|space_take|space_query|space_put/.test(text), `${name}/${m.name}: a tool named in the prompt`);
      else assert(!/space_ack|space_take|space_put/.test(text), `${name}/${m.name}: a settle or claim tool named in the prompt`);
    }
    if (name === "go-fish") {
      // The dealer is a SERVICE running the workspace-agent host beside the file, the only member
      // granted the table; an author model writes the program; four players; the team declares the
      // sandbox kind (a fresh space has none, and a member may not declare kinds) and the table.
      assertEquals(t.members.map((m) => m.name), ["dealer", "author", "ada", "ben", "cy", "dee"]);
      const dealer = t.members[0];
      assert(dealer.service && dealer.command && dealer.command.some((s) => s.includes("go-fish/dealer-host.ts")), "the dealer is a service running the host beside the file");
      assertEquals(dealer.grants, ["table:put,query,read_one"]);
      assert(dealer.unscopedGrants?.includes("sandbox:put,query,read_one"), "the jail declaration is unscoped");
      assertEquals(t.kinds?.map((k) => k.kind), ["sandbox", "table"]);
      assert((t.kinds![1].sortablePaths as string[] | undefined)?.includes("seq"), "the newest table is the highest seq");
      assertEquals(t.seed!.length, 1);
      assertEquals(t.seed![0].body.phase, "write");
      assertEquals(t.seed![0].body.tags, ["author"]);
      // The author's prompt names the workspace, the entrypoint and the sandbox record whose `api`
      // is the contract; a player's prompt touches none of it.
      const author = t.members[1];
      // It reads the table, because a model repairing the program has to see what the program sees.
      assertEquals(author.grants, ["table:query,read_one"]);
      assert(/dealer\.js/.test(author.prompt!) && /go-fish-dealer/.test(author.prompt!) && /kind: "sandbox"/.test(author.prompt!));
      assert(/fix/.test(author.resumePrompt!), "the resumed author is fixing its program");
      for (const pl of t.members.slice(2)) {
        assert(!t.members.slice(2).some((m) => m.grants?.length), "a player holds no extra grant");
        assert(!/dealer\.js|kind: "sandbox"|kind: "table"|space_save_workspace|space_edit_workspace|space_read_workspace/.test(pl.prompt!), `${pl.name} touches the table`);
      }
    }
  }
});

Deno.test("teamfile: resume picks the first-run and resume templates, leaves the harness session for the worker, and reads the resume prompt", () => {
  const cold = harnessTemplates("claude", false);
  assertEquals(cold.first, BUILTIN_HARNESSES.claude);
  assertEquals(cold.resume, undefined);
  const warm = harnessTemplates("claude", true);
  assert(warm.first.includes("--session-id") && warm.first.includes("{{harnessSession}}"), warm.first.join(" "));
  assert(warm.resume!.includes("--resume"), warm.resume!.join(" "));
  const codex = harnessTemplates("codex", true);
  assertEquals(codex.first, BUILTIN_HARNESSES.codex, "codex's first run is the plain exec; its id is learned from the output");
  assertEquals(codex.resume!.slice(0, 4), ["codex", "exec", "resume", "{{harnessSession}}"]);
  assert(!codex.resume!.includes("-s"), "exec resume takes no -s; the sandbox is a config key there");
  assert(codex.resume!.includes('sandbox_mode="workspace-write"'), codex.resume!.join(" "));
  assertEquals(harnessTemplates("mine", true, { mine: { command: ["x"] } }), { first: ["x"], resume: undefined }, "a custom harness without a resume template runs fresh");
  const values = { model: "opus", config: "/c", url: "u", binary: "b", mcpArgs: "[]", token: "t", codexTools: "{}", session: "s", credentials: "/f", radiaDir: "/r" };
  assert(substitute(warm.resume!, values).includes("{{harnessSession}}"), "the id is the worker's to fill, per launch");
  const files: Record<string, string> = {
    "t/team.json": JSON.stringify({ members: [{ name: "a", harness: "claude", resume: true, promptFile: "p.md", resumePromptFile: "r.md" }] }),
    "t/p.md": "cold",
    "t/r.md": "warm",
  };
  const t = loadTeamFile("t", (p) => files[p]);
  assertEquals([t.members[0].prompt, t.members[0].resumePrompt, t.members[0].resume], ["cold", "warm", true]);
  assertThrows(() => parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude", resume: "yes" }] })), UsageError, "resume must be true or false");
});

Deno.test("teamfile: the frame wraps a job, the resume frame is the short one, and frame:false hands the prompt over as it is", () => {
  const cold = framePrompt("Guess the animal.", true, false);
  assert(cold.startsWith("You are {{agent}}") && cold.includes("YOUR JOB.\nGuess the animal.") && cold.includes("space_ack {claimId"), cold);
  const warm = framePrompt("Guess the animal.", true, true);
  assert(warm.startsWith("Next move, same game") && warm.endsWith("Guess the animal.") && warm.length < cold.length, warm);
  assertEquals(framePrompt("mine", false, false), "mine");
  assert(framePrompt(undefined, true, false).includes("Do what the record asks"));
  assertThrows(() => parseTeamFile(JSON.stringify({ members: [{ name: "a", harness: "claude", frame: "no" }] })), UsageError, "frame must be true or false");
});

Deno.test("teamfile: kinds, per-member grants and service members are typed and refused by name", () => {
  const t = parseTeamFile(JSON.stringify({
    kinds: [{ kind: "thing", indexedPaths: [] }],
    members: [
      { name: "svc", service: true, command: ["run", "{{repo}}/x.ts"], grants: ["thing:take"], unscopedGrants: ["sandbox:query"] },
      { name: "a", harness: "claude", grants: ["thing:put,query"] },
    ],
  }));
  assertEquals(t.kinds?.[0].kind, "thing");
  assertEquals(t.members[0].harness, "service", "a service needs no harness; it is named for it");
  assertEquals(t.members[0].grants, ["thing:take"]);
  assertEquals(t.members[1].grants, ["thing:put,query"]);
  const bad = (file: unknown, re: RegExp) => {
    const e = assertThrows(() => parseTeamFile(JSON.stringify(file), "x.json"), UsageError);
    assert(re.test(e.message), e.message);
  };
  bad({ members: [{ name: "svc", service: true }] }, /a service member needs its own command/);
  bad({ members: [{ name: "a", harness: "claude", grants: ["thing"] }] }, /<kind>:<op,op>/);
  bad({ members: [{ name: "a", harness: "claude" }], kinds: [{ indexedPaths: [] }] }, /kind_def bodies/);
  bad({ members: [{ name: "a", harness: "claude", service: "yes" }] }, /service must be true or false/);
});
