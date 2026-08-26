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
import { newer, newestByKey } from "../sdk/ts/registry.ts";
import { kindDefKey } from "../sdk/ts/wire.ts";

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

Deno.test("[team] space_watch can wait for the NEXT record, not be handed the same one", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:m", { teams: ["t"] });
    const c = new RadiaClient(s.base, { definitionToken: m.definitionToken });
    await c.put({ kind: NOTE, body: { [TEAM_FIELD]: "t", to: "all", message: "old" } });

    // The default RECONCILES FIRST, which is right for claimable work (taking it removes it from
    // the next answer) and wrong for a mailbox: nothing consumes a fact, so `readOne` returns the
    // same record for ever however the match is narrowed. An agent asked to watch for new messages
    // was handed a two-minute-old broadcast, twice.
    const first = await c.readOne<{ message: string }>({ kind: NOTE });
    const again = await c.readOne<{ message: string }>({ kind: NOTE });
    assertEquals(first!.id, again!.id, "the read that backs a default watch is pinned to one record");

    // `newOnly` needs a BASELINE rather than a filter, because "new" is relative to when the call
    // started, and the baseline is compared by `created_at` (the database clock) rather than by id:
    // a ULID carries the WRITING process's clock, so two agents' ids can order backwards.
    const baseline = await c.readNewest({ kind: NOTE });
    await c.put({ kind: NOTE, body: { [TEAM_FIELD]: "t", to: "all", message: "new" } });
    const latest = await c.readNewest<{ message: string }>({ kind: NOTE });
    assert(newer(baseline!, latest!), "the newer arrival must sort after the baseline");
    assertEquals(latest!.body.message, "new");
  } finally {
    await s.close();
  }
});


Deno.test("[team] an artifact a model cannot inline is handed a URL, not a credential", async () => {
  const sp = await newSpace();
  try {
    await declareTeamKinds(sp.admin);
    const a = await addMember(sp.admin, "agent:sender", { teams: ["t"] });
    const b = await addMember(sp.admin, "agent:receiver", { teams: ["t"] });
    const A = new RadiaClient(sp.base, { definitionToken: a.definitionToken });
    const B = new RadiaClient(sp.base, { definitionToken: b.definitionToken });

    const bytes = new Uint8Array(200_000).fill(7);
    const { id } = await A.putArtifact(bytes, { mediaType: "image/jpeg", meta: { [TEAM_FIELD]: "t" } });

    // THE FAILURE THIS EXISTS FOR. A refusal with no supported next step is not a boundary, it is
    // a detour sign: an agent handed a 101 KB image was told to "use a client that can download
    // it" while it WAS the client, so it read the definition token out of its harness's config
    // file and started running curl.
    const cap = await B.artifactCapability(id);
    assert(cap.url.length > 0);
    assert(cap.expiresAt > new Date().toISOString(), "a capability that is already expired is no path at all");

    // IT CARRIES ITS OWN AUTHORIZATION, so the bytes come back with NO Authorization header. That
    // is what makes it safe to put in a context window where a credential would not be: it opens
    // ONE artifact, and it expires.
    const url = /^https?:\/\//.test(cap.url) ? cap.url : `${sp.base}${cap.url}`;
    const res = await fetch(url);
    assertEquals(res.status, 200);
    assertEquals(new Uint8Array(await res.arrayBuffer()).length, bytes.length);

    // And it is NOT a credential: it reaches that artifact and nothing else on the plane.
    const other = await fetch(`${sp.base}/v0/ops/stats`, { headers: { "Authorization": `Bearer ${cap.capability}` } });
    assert(other.status === 401 || other.status === 403, `a capability authenticated the ops plane: ${other.status}`);
  } finally {
    await sp.close();
  }
});

Deno.test("[team] a kind carries its own usage, and the line can be changed", async () => {
  const sp = await newSpace();
  try {
    const paths = [{ path: "to", type: "keyword" as const }];

    // A key minted BEFORE `usage` existed must stay byte-identical, or every declaration in every
    // space re-writes on the next startup.
    assertEquals(kindDefKey({ kind: "note", indexedPaths: paths, claimable: false }), "kind_def:note:to:keyword::ref");

    // USAGE PARTICIPATES IN THE KEY, against the instinct that prose carries no contract. Leaving
    // it out was tried and is unusable: adding a line to an existing kind then re-puts the SAME
    // key with a different body, which is `idempotency_conflict`, so the field could never be set
    // on a kind that already existed anywhere.
    await sp.admin.registerKind({ kind: "note", indexedPaths: paths, claimable: false });
    await sp.admin.registerKind({ kind: "note", indexedPaths: paths, claimable: false, usage: "first" });
    const read = async () => (await sp.admin.listKinds()).find((k) => k.kind === "note")?.usage;
    assertEquals(await read(), "first", "usage could not be added to an existing declaration");
    await sp.admin.registerKind({ kind: "note", indexedPaths: paths, claimable: false, usage: "second" });
    assertEquals(await read(), "second", "a re-worded usage did not win");

    // ...and an identical re-put still absorbs, so history grows only on a real change.
    const before = (await sp.admin.queryAll({ kind: "kind_def" })).length;
    await sp.admin.registerKind({ kind: "note", indexedPaths: paths, claimable: false, usage: "second" });
    assertEquals((await sp.admin.queryAll({ kind: "kind_def" })).length, before, "an identical re-put appended");

    // BOUNDED: a usage line is read on every kind load, so it is a sentence and not a document.
    const tooLong = await sp.admin.registerKind({ kind: "note", indexedPaths: paths, usage: "x".repeat(601) })
      .then(() => null, (e) => (e as Error).message);
    assert(tooLong?.includes("601"), `expected the length in the refusal, got: ${tooLong}`);
  } finally {
    await sp.close();
  }
});

Deno.test("[team] the shared kinds teach the conventions two agents otherwise invent", async () => {
  const sp = await newSpace();
  try {
    await declareTeamKinds(sp.admin);
    const byKind = new Map((await sp.admin.listKinds()).map((k) => [k.kind, k.usage ?? ""]));

    // The failures these lines exist to prevent, each seen on a real space: one agent wrote
    // `{to, text}` and another `{to, message}`; and a broadcast went to `to: "all"` while every
    // documented mailbox watched an exact principal, so it was missed in silence.
    assert(byKind.get("note")!.includes("all"), "the broadcast recipient is not documented");
    assert(byKind.get("note")!.includes("$in"), "the mailbox pattern that SEES a broadcast is not documented");
    assert(byKind.get("note")!.includes("message"), "the prose field is not pinned");
    assert(byKind.get("task")!.includes("$any"), "tag matching does not distribute; that has to be said");
    assert(byKind.get("task")!.includes("space_ack"), "how a task is answered is not documented");
  } finally {
    await sp.close();
  }
});

Deno.test("[mcp] the adapter answers both protocol eras, and names what it speaks", async () => {
  const src = await Deno.readTextFile(new URL("../src/surfaces/mcp/server.ts", import.meta.url));

  // MCP 2026-07-28 made the protocol stateless: no handshake, per-request `_meta`. A server MUST
  // implement `server/discover`, which is also the probe a dual-era client uses on stdio to decide
  // whether we are modern before falling back.
  assert(src.includes('case "server/discover"'), "the modern era has no discovery method");
  // ...and `initialize` STAYS. The SDK's own client defaults to the 2025 handshake "byte for byte"
  // and no deprecation date exists on either side, so dropping it would break every harness in use
  // to satisfy nobody. The compatibility matrix calls a server that answers both dual-era.
  assert(src.includes('case "initialize"'), "the legacy handshake was dropped; today's clients use it");

  // A version we do not speak is refused BY NAME, so a client can retry with a mutually supported
  // one rather than failing blind.
  assert(src.includes("-32022"), "an unknown protocol version is not refused with UnsupportedProtocolVersionError");
  assert(src.includes('"2026-07-28"'), "the modern revision is not in the supported set");

  // `resultType` is REQUIRED on every result in the modern era and defaults to "complete" when
  // absent, so stamping it is safe for every older client too.
  assert(/resultType: "complete"/.test(src), "results carry no resultType");
});

Deno.test("[mcp] a claim outlives the process that made it, but only for a named session", async () => {
  const src = await Deno.readTextFile(new URL("../src/surfaces/mcp/server.ts", import.meta.url));

  // THE STATELESSNESS REQUIREMENT, applied to the one piece of per-connection state that mattered:
  // a claimId only the minting process could settle. The spec says a stdio process "is not a
  // conversation or session" and a server "SHOULD NOT require that a client reuse the same
  // connection or process". Nothing is stored to fix it: the claimId embeds the record id and the
  // envelope already carries every field of a Lease, so the lease is REDERIVED.
  assert(src.includes("async function recoverClaim"), "a claim cannot be recovered by a later process");
  assert(src.includes("getEnvelope"), "recovery does not read the lease back from the space");

  // It is gated on the RUN matching, and that is not a formality: a settle is owner-bound
  // (`warnOwnerMismatch` answers `lease_lost` to anyone else), so only a process that came back as
  // the same run can settle. `--session` is what keeps a run across restarts, which makes the flag
  // load-bearing for conformance rather than only for attribution.
  assert(src.includes("env.leaseOwner !== me"), "recovery does not check the lease is ours");

  // And the release-on-exit is now conditional for the same reason. Releasing an anonymous
  // session's claims is right (nothing later can settle them); releasing a NAMED session's claims
  // hands a teammate work that is already half done.
  assert(/if \(!session\) await client\.release/.test(src), "a named session's claims are still released on exit");
});

Deno.test("[mcp] an artifact moves in and out by reference, never through the context", async () => {
  const src = await Deno.readTextFile(new URL("../src/surfaces/mcp/server.ts", import.meta.url));
  const tools = await Deno.readTextFile(new URL("../src/surfaces/mcp/tools.ts", import.meta.url));

  // BOTH DIRECTIONS, and each was a dead end that sent an agent after the credential in its own
  // harness config. Reading: a refusal that said "use a client that can download it" while the
  // model WAS the client. Writing: `text` or `base64` only, so an 85 KB file became 113 KB of
  // base64, which an agent correctly judged too big and then tried to curl the upload endpoint.
  assert(src.includes("a.link === true"), "no way to receive an artifact by reference");
  assert(/const path = typeof a\.path === "string"/.test(src), "no way to send an artifact by reference");

  // Exactly one input, named. Silently preferring one over another moves different bytes than the
  // caller asked for.
  assert(src.includes("pass exactly one of `path`, `text` or `base64`"), "several inputs are not refused");

  // The media type comes from the EXTENSION for a path, because the receiving side picks its
  // reader from it and `application/octet-stream` on a JPEG is refused as un-inlineable.
  assert(src.includes("mediaTypeForPath"), "a path upload does not derive its media type");
  assert(tools.includes("path"), "the path input is not advertised to the model");
});

Deno.test("[artifacts] an upload capability is as bounded as a download one", async () => {
  const sp = await newSpace();
  try {
    await declareTeamKinds(sp.admin);
    const m = await addMember(sp.admin, "agent:alpha", { teams: ["alpha"] });
    const c = new RadiaClient(sp.base, { definitionToken: m.definitionToken });

    // EVERYTHING BUT THE BYTES IS FIXED AT MINT, and authorized there: the same check the direct
    // upload makes, over everything knowable before a payload exists. That is what keeps a WRITE
    // capability as bounded as a read one, and it is checked from the failing side first.
    const refused = await c.uploadCapability({ mediaType: "image/png", meta: { [TEAM_FIELD]: "beta" } })
      .then(() => null, (e) => (e as Error).message);
    assert(refused?.includes("pattern scope"), `another team's artifact should be refused at mint: ${refused}`);
    const unlabelled = await c.uploadCapability({ mediaType: "image/png" }).then(() => null, (e) => (e as Error).message);
    assert(unlabelled?.includes("pattern scope"), "an unlabelled artifact should be refused at mint too");

    const cap = await c.uploadCapability({ mediaType: "image/png", filename: "x.png", meta: { [TEAM_FIELD]: "alpha" } });
    assert(cap.url.length > 0 && cap.expiresAt > new Date().toISOString());
    // ABSOLUTE when the space runs a separate artifact origin (the default), a path when it does
    // not, which is this harness. Same rule the download capability has.
    const url = /^https?:\/\//.test(cap.url) ? cap.url : `${sp.base}${cap.url}`;

    // THE HOLDER ADDS ONLY BYTES, with NO credential. That is the whole point: a sender that
    // cannot attach an Authorization header (a remote agent, a browser, a container) could receive
    // bytes through a download capability and had no way to send them.
    const bytes = new Uint8Array(4096).fill(9);
    const res = await fetch(url, { method: "PUT", body: bytes });
    assertEquals(res.status, 201);
    const { id } = await res.json() as { id: string };

    // The record is authored by the MINTER, never by whoever presented the capability, and carries
    // exactly what was described.
    const rec = await sp.admin.getRecord<{ team: string; mediaType: string; filename: string }>(id);
    assertEquals(rec!.body.team, "alpha");
    assertEquals(rec!.body.mediaType, "image/png");
    assertEquals(rec!.body.filename, "x.png");
    const runs = await sp.admin.queryAll<{ run?: string; agent?: string }>({ kind: "agent_run" });
    const author = [...runs].find((r) => r.body.run === rec!.runtimeMeta.createdBy)?.body.agent;
    assertEquals(author, "agent:alpha", "the record must name who decided it should exist");

    // SINGLE USE, unlike a download. A download opens something that already exists and may be
    // fetched until it expires; an upload that replayed would be an unbounded write channel.
    assertEquals((await fetch(url, { method: "PUT", body: bytes })).status, 404);
  } finally {
    await sp.close();
  }
});
