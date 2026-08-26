// `radia team`: putting several agent harnesses on one space, and the property the whole verb
// exists for.
//
// THE PROPERTY IS ATTRIBUTION THAT OUTLIVES A SESSION. `created_by` names a RUN, and a run dies at
// the 12h ceiling, so a harness configured with one is a harness whose past work attributes to a
// principal nothing can resolve. A member holds a DEFINITION instead: every run it ever mints
// resolves back to the same `agent:` name. The test below restarts a client from the stored
// durable half and checks the name is the same one, which is the whole claim.
//
// A real socket, because the thing under test includes the client's own definition-for-run
// exchange, and a stubbed fetch would test a mock's idea of a mint.

import { assert, assertEquals } from "@std/assert";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { RadiaClient } from "../sdk/ts/client.ts";
import { addMember, DEFAULT_TEAM, declareTeamKinds, definitionState, NOTE, TASK, TEAM_FIELD, teamRoster } from "../extensions/ts/team.ts";
import { configLocation, mcpInvocation, renderMcpConfig, renderMcpInstall } from "../src/surfaces/mcp/config.ts";
import { newestByKey } from "../sdk/ts/registry.ts";

async function newSpace() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  const handler = makeHandler(space, "<html>console</html>", true);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler);
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  // The operator credential `radia dev` provisions, which is what `radia team` runs under. An
  // operator holds no DEFINITION by design (one would be a permanent way to mint privileged runs),
  // so this is a bare token with no durable half behind it.
  const admin = new RadiaClient(base, { token: await space.mintOperatorToken() });
  return {
    space,
    base,
    admin,
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

Deno.test("[team] a member's attribution survives its run", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const claude = await addMember(s.admin, "agent:claude");
    const codex = await addMember(s.admin, "agent:codex");

    // Each harness holds only the DURABLE half, which is what a config file gets. It cannot read
    // or write anything itself; the client exchanges it for a run per process.
    const asClaude = new RadiaClient(s.base, { definitionToken: claude.definitionToken });
    const { id } = await asClaude.put({ kind: TASK, body: { [TEAM_FIELD]: DEFAULT_TEAM, title: "review", tags: ["review"] } });

    const asCodex = new RadiaClient(s.base, { definitionToken: codex.definitionToken });
    const claimed = await asCodex.take({ pattern: { kind: TASK, match: { tags: { $any: "review" } } } }, { leaseSeconds: 60 });
    assert(claimed, "codex could not claim the task claude offered");
    await asCodex.ack(claimed.lease, { kind: NOTE, body: { [TEAM_FIELD]: DEFAULT_TEAM, to: "agent:claude", topic: "handoff", text: "done" } });

    // A SECOND PROCESS from the same stored token: this is the restart the whole design is for.
    const restarted = new RadiaClient(s.base, { definitionToken: claude.definitionToken });
    const { id: later } = await restarted.put({ kind: NOTE, body: { [TEAM_FIELD]: DEFAULT_TEAM, topic: "after-restart", text: "still me" } });

    const runs = newestByKey<{ run?: string; agent?: string }>(
      await s.admin.queryAll({ kind: "agent_run" }),
      (b) => b.run,
    );
    const author = async (recordId: string) => {
      const rec = await s.admin.getRecord(recordId);
      const run = rec!.runtimeMeta.createdBy;
      return [...runs.values()].find((r) => r.body.run === run)?.body.agent;
    };
    assertEquals(await author(id), "agent:claude");
    assertEquals(await author(later), "agent:claude", "a restart must land on the same principal, not a new one");
    // Two runs, one principal: the run is the session, the agent is the identity.
    const claudeRuns = [...runs.values()].filter((r) => r.body.agent === "agent:claude");
    assert(claudeRuns.length >= 2, `expected a run per process, got ${claudeRuns.length}`);
  } finally {
    await s.close();
  }
});

Deno.test("[team] a second definition is not a rotation, so `add` has to refuse one", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    assertEquals(await definitionState(s.admin, "agent:claude"), "none");
    const first = await addMember(s.admin, "agent:claude");
    assertEquals(await definitionState(s.admin, "agent:claude"), "active");

    // THE HAZARD THE CLI REFUSAL EXISTS FOR, stated as a test rather than as a comment: creating a
    // second definition leaves BOTH tokens minting, while `revoke` reaches only the newest. A
    // caller that treated `add` as idempotent would hand out a credential it could not later stop.
    const second = await addMember(s.admin, "agent:claude");
    assert(first.definitionToken !== second.definitionToken);
    await s.admin.revokeDefinition("agent:claude");
    const stillMints = await new RadiaClient(s.base, { definitionToken: first.definitionToken })
      .put({ kind: NOTE, body: { [TEAM_FIELD]: DEFAULT_TEAM, topic: "t", text: "x" } })
      .then(() => true, () => false);
    assert(stillMints, "the shadowed definition stopped minting; the refusal in `radia team add` can be dropped");

    // Rotating properly is revoke-then-create, which is what the verb does.
    assertEquals(await definitionState(s.admin, "agent:claude"), "revoked");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the roster reads from enforcement, not from what was assigned", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:claude", { observe: true });
    await addMember(s.admin, "agent:codex", { observe: false });
    const roster = await teamRoster(s.admin);
    const claude = roster.find((m) => m.agent === "agent:claude")!;
    const codex = roster.find((m) => m.agent === "agent:codex")!;
    assert(claude.opsPowers.includes("observe"));
    assert(!codex.opsPowers.includes("observe"), "--no-observe must actually withhold the power");
    // `kind_def` is the DISCOVERY grant and is deliberately unscoped; the rest carry the team.
    assertEquals(claude.kinds.map((k) => k.kind).sort(), ["artifact", "kind_def", "note", "task"]);
    assertEquals(claude.teams, [DEFAULT_TEAM]);
    assert(claude.active);
  } finally {
    await s.close();
  }
});

Deno.test("[team] the printed harness config is one a harness can actually run", () => {
  const target = { url: "http://127.0.0.1:7788", definitionToken: "abc123", name: "radia" };

  // ABSOLUTE, never a bare `radia`: whether the harness's PATH has it is the one thing a generated
  // config cannot check, and the failure is a server that reports "failed" with no reason.
  const inv = mcpInvocation(target.url);
  const { command, args } = inv;
  assert(command.startsWith("/") || /^[A-Za-z]:/.test(command), `command must be absolute, got ${command}`);
  assert(args.includes("mcp") && args.includes(target.url));

  // THE BINARY THAT WROTE THE CONFIG, never one found on PATH: a stale install shadowing a fresh
  // build speaks an older wire contract, and the harness would start it without complaint. The
  // suite runs under deno, so this is the source case, and it must SAY so rather than pass a
  // checkout-pinned command off as a durable one.
  assertEquals(inv.fromSource, true, "running under deno must report the source fallback");
  assert(args[0] === "run" && args.includes("-A") && args.some((a) => a.endsWith("/src/main.ts")));

  const claude = JSON.parse(renderMcpConfig("claude", target)) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  assertEquals(claude.mcpServers.radia.env.RADIA_DEFINITION_TOKEN, "abc123");
  assertEquals(claude.mcpServers.radia.command, command);

  // Codex spells it `mcp_servers`, in TOML. Wrong table name and the server simply never appears.
  const codex = renderMcpConfig("codex", target);
  assert(codex.includes("[mcp_servers.radia]"), codex);
  assert(codex.includes(`RADIA_DEFINITION_TOKEN = "abc123"`), codex);

  const install = renderMcpInstall("claude", target)!;
  // `--scope local` keys the config to the DIRECTORY, which is what gives each project its own
  // member. The `user` scope writes one config for every project, collapsing two agents into one
  // principal, so leaving the scope to a default is not a style choice here.
  assert(install.startsWith("claude mcp add radia --scope local "), install);
  assert(install.includes("RADIA_DEFINITION_TOKEN=abc123"), install);
  assertEquals(renderMcpInstall("codex", target), undefined, "codex has no add command; it gets the block");

  // A token with shell metacharacters must not break out of the one-liner.
  const odd = renderMcpInstall("claude", { ...target, definitionToken: "a'b c" })!;
  assert(odd.includes(`'a'\\''b c'`), odd);

  assert(configLocation("codex").includes(".codex"));
});

Deno.test("[team] two teams do not see each other's work, and there is no unlabelled lane", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const alpha = await addMember(s.admin, "agent:alpha", { teams: ["alpha"] });
    const beta = await addMember(s.admin, "agent:beta", { teams: ["beta"] });
    const a = new RadiaClient(s.base, { definitionToken: alpha.definitionToken });
    const b = new RadiaClient(s.base, { definitionToken: beta.definitionToken });

    await a.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "a1", tags: ["x"] } });
    await b.put({ kind: TASK, body: { [TEAM_FIELD]: "beta", title: "b1", tags: ["x"] } });

    // WRITES. `bodyMatchesGrant` refuses both ways out: another team's label, and NO label. The
    // second is what makes the isolation total rather than merely conventional — without it a
    // member could park work in a lane the pattern does not cover and any team could read it.
    const refused = async (f: () => Promise<unknown>) => await f().then(() => null, (e) => (e as Error).message);
    assert(
      (await refused(() => a.put({ kind: TASK, body: { [TEAM_FIELD]: "beta", title: "forged" } })))?.includes("pattern scope"),
      "alpha forged a record into beta's team",
    );
    assert(
      (await refused(() => a.put({ kind: TASK, body: { title: "unlabelled" } })))?.includes("pattern scope"),
      "an unlabelled write was accepted, so there IS a lane outside every team",
    );

    // READS are `grant ∧ request`, so an unscoped ask is answered scoped and says nothing about
    // what it did not return. Asking explicitly for the other team is the same answer.
    const titles = (rs: { body: unknown }[]) => rs.map((r) => (r.body as { title: string }).title).sort();
    assertEquals(titles(await a.queryNewest({ kind: TASK }, 50)), ["a1"]);
    assertEquals(titles(await b.queryNewest({ kind: TASK }, 50)), ["b1"]);
    assertEquals(titles(await a.queryNewest({ kind: TASK, match: { [TEAM_FIELD]: "beta" } }, 50)), []);

    // CLAIMS. A lease is the one that would silently hand over another team's work.
    const claimed = await b.take({ pattern: { kind: TASK } }, { leaseSeconds: 30 });
    assertEquals((claimed?.record.body as { title: string }).title, "b1");

    // A CROSSER holds both, which is how work moves between teams, and the roster names it.
    const relay = await addMember(s.admin, "agent:relay", { teams: ["alpha", "beta"] });
    const r = new RadiaClient(s.base, { definitionToken: relay.definitionToken });
    assertEquals(titles(await r.queryNewest({ kind: TASK }, 50)), ["a1", "b1"]);
    const roster = await teamRoster(s.admin);
    assertEquals(roster.find((m) => m.agent === "agent:relay")!.teams, ["alpha", "beta"]);
    assertEquals(roster.find((m) => m.agent === "agent:alpha")!.teams, ["alpha"]);
  } finally {
    await s.close();
  }
});

Deno.test("[team] `observe` reads every team, which is why it is opt-in", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const alpha = await addMember(s.admin, "agent:alpha", { teams: ["alpha"] });
    const nosy = await addMember(s.admin, "agent:nosy", { teams: ["nosy"], observe: true });
    const a = new RadiaClient(s.base, { definitionToken: alpha.definitionToken });
    const n = new RadiaClient(s.base, { definitionToken: nosy.definitionToken });
    const { id } = await a.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "secret" } });

    // Its COORDINATION reads are correctly bounded...
    assertEquals((await n.queryNewest({ kind: TASK }, 50)).length, 0);
    // ...and the ops plane hands it another team's record anyway, by id. `observe` is unscoped by
    // definition, so it is the one thing that still crosses a team boundary. That is why it is
    // opt-in rather than the default `addMember` once had.
    const seen = await n.getRecord(id);
    assertEquals((seen!.body as { title: string }).title, "secret", "observe no longer crosses teams; the opt-in default can be revisited");

    // And WITHOUT it a member still reaches the ops plane for its OWN team, which is the whole
    // point of the pattern tier: the alternative was handing every member the power above.
    assertEquals(((await a.getRecord(id))!.body as { title: string }).title, "secret");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the adapter fills a scope only after the space says it is required", async () => {
  const { ScopeFiller } = await import("../src/surfaces/mcp/scope.ts");
  // A stand-in for the client: it answers `permissions` with the patterns a member's grants carry,
  // and counts what was asked, because "how many round trips" is half of what is being tested.
  const fake = (patterns: Record<string, unknown>[]) => {
    const calls = { permissions: 0 };
    return {
      calls,
      client: {
        health: () => Promise.resolve({ principal: "run:x" }),
        permissions: () => {
          calls.permissions++;
          return Promise.resolve({ kinds: [{ kind: "task", patterns }] });
        },
        // deno-lint-ignore no-explicit-any
      } as any,
    };
  };

  // 1. A WRITE THAT WOULD SUCCEED IS NEVER TOUCHED. This is the whole reason the fill is driven by
  // a refusal rather than by reading your own grants up front: `patterns` unions every grant on a
  // kind whatever operation it permits, so pre-stamping would add a label to a record written
  // under an UNSCOPED put grant, narrowing who can read it afterwards.
  {
    const { client, calls } = fake([{ team: "alpha" }]);
    const seen: Record<string, unknown>[] = [];
    const f = new ScopeFiller(client);
    await f.fill("task", (extra) => {
      seen.push(extra);
      return Promise.resolve("ok");
    });
    assertEquals(seen, [{}], "a successful write was modified");
    assertEquals(calls.permissions, 0, "a successful write cost a permissions read");
  }

  // 2. A scope refusal is answered by discovering the scope, retrying ONCE, and remembering it, so
  // the second write of a session costs no extra round trip.
  {
    const { client, calls } = fake([{ team: "alpha" }]);
    const f = new ScopeFiller(client);
    const attempts: Record<string, unknown>[] = [];
    const write = (extra: Record<string, unknown>) => {
      attempts.push(extra);
      if (!("team" in extra)) return Promise.reject(new Error("forbidden: record body is outside the pattern scope of your put grant for 'task'"));
      return Promise.resolve("ok");
    };
    assertEquals(await f.fill("task", write), "ok");
    assertEquals(attempts, [{}, { team: "alpha" }], "the retry did not carry the discovered scope");
    assertEquals(await f.fill("task", write), "ok");
    assertEquals(attempts.length, 3, "the scope was rediscovered instead of remembered");
    assertEquals(attempts[2], { team: "alpha" });
    assertEquals(calls.permissions, 1, "the scope was looked up more than once");
  }

  // 3. AMBIGUITY IS ASKED ABOUT, NEVER GUESSED. A crosser holds two teams and nothing here knows
  // which one a write belongs to; picking either would file the work in the wrong team, which is
  // the exact thing the scoping exists to prevent.
  {
    const { client } = fake([{ team: "alpha" }, { team: "beta" }]);
    const f = new ScopeFiller(client);
    const e = await f.fill("task", () => Promise.reject(new Error("forbidden: body is outside the pattern scope")))
      .then(() => null, (err) => (err as Error).message);
    assert(e?.includes("alpha") && e?.includes("beta"), `both teams must be named, got: ${e}`);
  }

  // 4. Any OTHER failure is the caller's own and is not retried: a fill that swallowed an
  // unrelated error would turn one clear message into two attempts and a confusing one.
  {
    const { client, calls } = fake([{ team: "alpha" }]);
    const f = new ScopeFiller(client);
    let n = 0;
    const e = await f.fill("task", () => {
      n++;
      return Promise.reject(new Error("idempotency_conflict"));
    }).then(() => null, (err) => (err as Error).message);
    assertEquals(e, "idempotency_conflict");
    assertEquals(n, 1, "an unrelated error was retried");
    assertEquals(calls.permissions, 0);
  }
});

Deno.test("[team] a teammate's record is readable on the ops plane, another team's is not", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    // NO `observe` anywhere here. That is the point: before the pattern tier, these five reads
    // worked only for an operator or for a member holding a power that reads every team.
    const a1 = await addMember(s.admin, "agent:a1", { teams: ["alpha"] });
    const a2 = await addMember(s.admin, "agent:a2", { teams: ["alpha"] });
    const b1 = await addMember(s.admin, "agent:b1", { teams: ["beta"] });
    const A1 = new RadiaClient(s.base, { definitionToken: a1.definitionToken });
    const A2 = new RadiaClient(s.base, { definitionToken: a2.definitionToken });
    const B1 = new RadiaClient(s.base, { definitionToken: b1.definitionToken });

    const { id: task } = await A1.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "a1's task" } });
    const { id: note } = await A1.put({ kind: NOTE, body: { [TEAM_FIELD]: "alpha", topic: "t", text: "x" }, parentIds: [task] });
    const { id: theirs } = await B1.put({ kind: TASK, body: { [TEAM_FIELD]: "beta", title: "b1's task" } });

    // THE FIX. a2 did not write this record; `createdBy: "self"` fails for it, and that failure is
    // the whole reason `observe` was being handed out.
    assertEquals((await A2.getRecord(task))!.body, { [TEAM_FIELD]: "alpha", title: "a1's task" });
    assertEquals((await A2.getLineage(note)).length, 2, "a teammate must be able to walk lineage");
    assertEquals((await A2.getChildren(task)).map((c) => c.id), [note]);
    assert((await A2.graph(task)).nodes.length >= 2, "a teammate must be able to walk the graph");

    // ANOTHER TEAM IS STILL A 404, never a 403: a 403 confirms the id exists, which is exactly the
    // probe a per-record endpoint invites.
    const denied = await B1.getRecord(task).then((r) => r, (e) => (e as Error).message);
    assert(denied === null || typeof denied === "string", `beta read alpha's record: ${JSON.stringify(denied)}`);
    assertEquals(await A2.getRecord(theirs).then((r) => r, () => null), null, "alpha read beta's record");

    // The lineage WALL holds across teams: naming a foreign id as your own record's parent must not
    // hand back its upstream. `put` never checks that a parent is readable, so this is the guard.
    const { id: bait } = await B1.put({ kind: TASK, body: { [TEAM_FIELD]: "beta", title: "bait" }, parentIds: [task] });
    const walked: string[] = await B1.getLineage(bait).then((l) => l.map((n) => n.record.id), () => []);
    assert(!walked.includes(task), "a foreign parent leaked its record through lineage");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the aggregates say what they do NOT cover rather than reporting zero", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:a1", { teams: ["alpha"] });
    const c = new RadiaClient(s.base, { definitionToken: m.definitionToken });
    await c.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "one" } });

    // Counting a pattern-scoped kind exactly would need the ORACLE, not the SQL pre-filter, which
    // is a sound over-approximation by contract and would therefore over-report. So the kind is
    // left out of the counts and NAMED, because a silent zero reads as "the space is empty" —
    // the exact failure `describeScope` exists to prevent.
    const r = await c.getStatsReport();
    assert(r.scope, "a scoped caller must be told it was scoped");
    assertEquals(r.scope!.kinds, [], "a pattern-scoped kind must not be counted; the count would over-report");
    assertEquals(r.scope!.patternScoped, ["artifact", "note", "task"]);
    assert(/grant PATTERN/.test(r.scope!.note), r.scope!.note);
  } finally {
    await s.close();
  }
});

Deno.test("[team] the roster shows the TEAM, and names a member that reads every team", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:scoped", { teams: ["alpha"] });
    // A member created BEFORE teams existed: grants on the team kinds with no pattern. It reads
    // every team, and adding teams around it changes nothing until it is rotated, so the roster has
    // to say so rather than showing a dash that reads as "no team".
    await s.admin.createAgentDefinition("agent:legacy", [
      { principal: "agent:legacy", kind: TASK, operations: ["put", "query"] },
      { principal: "agent:legacy", kind: NOTE, operations: ["put", "query"] },
    ]);
    // Something that is NOT on the team: an app's worker. A real space has dozens, and listing them
    // buried the team under them.
    await s.admin.createAgentDefinition("agent:someone-elses-worker", [
      { principal: "agent:someone-elses-worker", kind: "llm_call", operations: ["take"] },
    ]);

    const roster = await teamRoster(s.admin);
    const by = (n: string) => roster.find((m) => m.agent === n)!;
    assertEquals(by("agent:scoped").member, true);
    assertEquals(by("agent:scoped").unscoped, false);
    assertEquals(by("agent:scoped").teams, ["alpha"]);
    assertEquals(by("agent:legacy").member, true, "a grant on task/note is what makes a member");
    assertEquals(by("agent:legacy").unscoped, true, "an unpatterned team grant reads EVERY team");
    assertEquals(by("agent:legacy").teams, []);
    assertEquals(by("agent:someone-elses-worker").member, false, "an unrelated worker is not on the team");
    assertEquals(roster.filter((m) => m.member).length, 2);
  } finally {
    await s.close();
  }
});

Deno.test("[team] a member can DISCOVER kinds, and that grant is not team-scoped", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:m", { teams: ["alpha"] });
    const c = new RadiaClient(s.base, { definitionToken: m.definitionToken });

    // `space_kinds` is the FIRST call an agent makes: it discovers its vocabulary rather than being
    // taught it. Without `kind_def: query` a member's opening move is a 403, which is how this was
    // found — on a real harness, against a real space.
    const kinds = (await c.listKinds()).map((k) => k.kind).sort();
    assertEquals(kinds, ["artifact", "note", "task"]);

    // AND IT MUST NOT CARRY THE TEAM PATTERN. A `kind_def` body has no `team` field, so a scoped
    // grant here matches nothing and refuses every declaration: the same 403, arrived at from the
    // opposite direction. The team pattern belongs on kinds that carry data, not on the ones that
    // describe them.
    const perms = await s.admin.permissions("agent:m");
    const kd = perms.kinds.find((k) => k.kind === "kind_def");
    assert(kd, "a member holds no kind_def grant");
    assertEquals(kd!.patterns, [], "the discovery grant is team-scoped, so it matches nothing");

    // Discovery being unscoped must not widen the DATA scope.
    const b = await addMember(s.admin, "agent:b", { teams: ["beta"] });
    const bc = new RadiaClient(s.base, { definitionToken: b.definitionToken });
    await c.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "mine" } });
    assertEquals((await bc.queryNewest({ kind: TASK }, 20)).length, 0, "discovery leaked the data scope");
  } finally {
    await s.close();
  }
});
