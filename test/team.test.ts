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
import { addMember, DEFAULT_TEAM, declareTeamKinds, definitionState, mergeKind, NOTE, readDefinition, removeMember, TASK, TEAM_FIELD, teamRoster } from "../extensions/ts/team.ts";
import { configLocation, mcpInvocation, renderMcpConfig, renderMcpInstall } from "../src/surfaces/mcp/config.ts";
import { ScopeFiller } from "../src/surfaces/mcp/scope.ts";
import { newer, newestByKey } from "../sdk/ts/registry.ts";
import { kindDefKey } from "../sdk/ts/wire.ts";
import { extensionFor, mediaTypeForPath } from "../src/surfaces/media.ts";

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
    assertEquals(claude.kinds.map((k) => k.kind).sort(), ["artifact", "capability", "kind_def", "note", "task"]);
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
    assertEquals(r.scope!.patternScoped, ["artifact", "capability", "note", "task"]);
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
    assertEquals(kinds, ["artifact", "capability", "note", "task"]);

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
    // And two more, both from watching real harnesses: settled tasks were reported as available
    // off a plain query (the body carries no claim state), and an answer was written as a separate
    // put before the ack, which is the one shape that is NOT fenced.
    assert(byKind.get("task")!.includes("space_children"), "nothing says how to tell a settled task from an open one");
    assert(/fenced/i.test(byKind.get("task")!), "nothing says why the answer rides on the ack");
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

Deno.test("[cli] the media-type table is ONE table, and round-trips", () => {
  // Two surfaces move artifact bytes and both need this mapping: the MCP adapter on the way in (a
  // path upload typed `application/octet-stream` is refused as un-inlineable by the receiver) and
  // the CLI on the way out (a downloaded file with no extension is one nothing opens). Two copies
  // of a mapping is the "one fact stated twice" shape, so it lives in one module.
  assertEquals(mediaTypeForPath("/tmp/seal.JPG"), "image/jpeg");
  assertEquals(mediaTypeForPath("a/b/notes.md"), "text/markdown");
  assertEquals(mediaTypeForPath("archive.tar.gz"), undefined, "unknown answers undefined, never a guess");
  assertEquals(mediaTypeForPath("noextension"), undefined);

  // The way back strips parameters, because a stored mediaType routinely carries a charset.
  assertEquals(extensionFor("text/plain; charset=utf-8"), "txt");
  assertEquals(extensionFor("image/jpeg"), "jpg", "the first spelling listed wins, so jpeg -> jpg");
  assertEquals(extensionFor("application/x-tar"), undefined);
  assertEquals(extensionFor(undefined), undefined);

  // Every type the forward table names is reachable backwards, or a file arrives with no
  // extension for a type we claim to know.
  for (const type of ["image/png", "application/pdf", "text/csv", "application/json"]) {
    assert(extensionFor(type), `${type} has no extension on the way back`);
  }
});

Deno.test("[cli] artifact put/get is a verb, closing the one-directional gap", async () => {
  const src = await Deno.readTextFile(new URL("../src/surfaces/cli.ts", import.meta.url));
  // "If the CLI can do it, so can any client" held in one direction only for payloads: artifacts
  // were reachable from an SDK and from MCP, and from a shell only by hand-rolling curl with a
  // token on the command line, which an agent tried and its harness's classifier refused.
  assert(/case "artifact": \{/.test(src), "no artifact verb");
  assert(src.includes("putArtifact"), "artifact put does not upload");
  assert(src.includes("getArtifact"), "artifact get does not download");

  // STDOUT IS OPT-IN. A terminal is not a file, and a megabyte of JPEG written to one is a wedged
  // session, so the default writes the name the sender chose.
  assert(src.includes('dest === "-"'), "there is no explicit stdout form");
  assert(src.includes("writeStdoutBytes"), "bytes to stdout would go through the text encoder");
  assert(src.includes("ensureParent"), "a --out path into a missing directory would fail on the write");
});

Deno.test("[team] observe can be TAKEN BACK, which the printed remediation promised and did not do", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:claude", { observe: true });
    assert((await s.admin.permissions("agent:claude")).opsPowers?.includes("observe"));

    // The advertised take-back: re-declare without it. Rotation revokes the DEFINITION, but an
    // `ops_grant` is keyed to the PRINCIPAL, which rotation does not change, so nothing here
    // removed the power and `team list` re-printed the same advice forever.
    await s.admin.revokeDefinition("agent:claude");
    const back = await addMember(s.admin, "agent:claude", {});
    assertEquals(back.observe, "retired", "rotating without --observe must take the power back");
    assert(
      !(await s.admin.permissions("agent:claude")).opsPowers?.includes("observe"),
      "the power survived the rotation that claims to remove it",
    );
  } finally {
    await s.close();
  }
});

Deno.test("[team] observe survives being taken back TWICE, so the retire key cannot be constant", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const held = async () => (await s.admin.permissions("agent:m")).opsPowers?.includes("observe") ?? false;

    await addMember(s.admin, "agent:m", { observe: true });
    assert(await held(), "first grant");
    await s.admin.revokeDefinition("agent:m");
    assertEquals((await addMember(s.admin, "agent:m", {})).observe, "retired");
    assert(!await held(), "first retirement");

    // The revive, which needs its own anchor: a plain re-put under the content key replays the
    // record the tombstone already superseded, so the power would never come back.
    await s.admin.revokeDefinition("agent:m");
    assertEquals((await addMember(s.admin, "agent:m", { observe: true })).observe, "granted");
    assert(await held(), "a power taken back must be grantable again");

    // And the SECOND retirement, which a constant key would make an idempotent replay of the
    // first, leaving the power live while reporting success.
    await s.admin.revokeDefinition("agent:m");
    assertEquals((await addMember(s.admin, "agent:m", {})).observe, "retired");
    assert(!await held(), "a power can be taken back only once if the retire key is constant");
  } finally {
    await s.close();
  }
});

Deno.test("[team] an already-correct observe state writes nothing: a re-put outranks a tombstone", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:m", { observe: true });
    await s.admin.revokeDefinition("agent:m");
    // Asking for what is already true must be a NO-OP rather than a re-assertion. `ops_grant` never
    // compacts and a plain re-put outranks a `retired: true` tombstone, so a setup script run on a
    // schedule would otherwise silently undo an operator's withdrawal.
    assertEquals((await addMember(s.admin, "agent:m", { observe: true })).observe, "unchanged");
    const rows = await s.admin.queryAll({ kind: "ops_grant", match: { principal: "agent:m" } });
    assertEquals(rows.length, 1, "re-asserting a held power appended a record");
  } finally {
    await s.close();
  }
});

Deno.test("[team] a wider ops_grant is refused rather than silently narrowed", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:m", {});
    // An operator's own combined power. Taking `observe` back from this would drop `remediate` as
    // a side effect, so the verb refuses and names it instead.
    await s.admin.put({ kind: "ops_grant", body: { principal: "agent:m", operations: ["observe", "remediate"] } });
    await s.admin.revokeDefinition("agent:m");
    let threw = "";
    try {
      await addMember(s.admin, "agent:m", {});
    } catch (e) {
      threw = String(e);
    }
    assert(threw.includes("wider power"), `expected a refusal naming the wider power, got: ${threw}`);
    assert(
      (await s.admin.permissions("agent:m")).opsPowers?.includes("remediate"),
      "the refusal must leave the wider power intact",
    );
  } finally {
    await s.close();
  }
});

Deno.test("[team] removal closes every door membership opened, not just the definition", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:gone", { teams: ["alpha"], observe: true });
    const before = await s.admin.permissions("agent:gone");
    assert(before.kinds.length > 0 && before.opsPowers?.includes("observe"));

    const r = await removeMember(s.admin, "agent:gone");
    assert(r.revoked, "the definition must be revoked");
    assert(r.grantsRetired > 0, "grants were left standing");
    assertEquals(r.opsPowersRetired, ["observe"]);

    // ENFORCEMENT, not the return value: `mintDelegatedRun` intersects with the caller's LIVE
    // grants and never consults whether their definition still mints, so a grant left standing is
    // authority a worker can still act under on their behalf.
    const after = await s.admin.permissions("agent:gone");
    assertEquals(after.kinds.length, 0, "a removed member still holds grants");
    assertEquals(after.opsPowers ?? [], [], "a removed member still holds ops powers");
    assertEquals(await definitionState(s.admin, "agent:gone"), "revoked");
  } finally {
    await s.close();
  }
});

Deno.test("[team] removal stops BOTH run classes, not only the member's own sessions", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:gone", { teams: ["alpha"] });
    // Their own session.
    const own = await s.space.mintRun(m.definitionToken);

    // A run a WORKER holds on their behalf. Written directly, because what offboarding has to find
    // is an `agent_run` carrying `actingFor`, however it got there: `radia runs --for` covers this
    // class because it once shipped covering only it, and this verb shipped covering only the other.
    const worker = await addMember(s.admin, "agent:worker", { teams: ["alpha"] });
    const wr = await s.space.mintRun(worker.definitionToken);
    await s.space.put({
      kind: "agent_run",
      body: {
        run: wr.run,
        agent: "agent:worker",
        tokenHash: "f".repeat(64),
        status: "active",
        expiresAt: new Date(Date.parse(await s.space.now()) + 3_600_000).toISOString(),
        actingFor: "agent:gone",
      },
    });

    const r = await removeMember(s.admin, "agent:gone");
    assertEquals(r.stoppedOwn, [own.run], "the member's own live session was not stopped");
    assertEquals(r.stoppedDelegated, [wr.run], "a run held on their behalf was left live");
  } finally {
    await s.close();
  }
});

Deno.test("[team] offboarding reads the DATABASE clock, so a fast local clock cannot skip a live run", async () => {
  const s = await newSpace();
  // The WHOLE Date, not `Date.now`: the filter this guards was written `new Date().toISOString()`,
  // and a no-arg construction reads the system clock without going through `Date.now`, so patching
  // that alone left the defect untouched and this test green against it.
  const RealDate = Date;
  const SKEW = 3_600_000; // a run token lives 15 minutes, so an hour fast reads every one as expired
  class FastDate extends RealDate {
    // deno-lint-ignore no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) super(RealDate.now() + SKEW);
      else super(...(args as []));
    }
    static override now() {
      return RealDate.now() + SKEW;
    }
  }
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:gone", { teams: ["alpha"] });
    const own = await s.space.mintRun(m.definitionToken);

    // Skipping the stop is not a delay: the run then RENEWS itself to the 12h ceiling, because
    // `renewRun` checks the run's own status and never the definition behind it.
    globalThis.Date = FastDate as DateConstructor;
    let r;
    try {
      r = await removeMember(s.admin, "agent:gone");
    } finally {
      globalThis.Date = RealDate;
    }
    assertEquals(r.stoppedOwn, [own.run], "a live run was skipped because this process's clock ran fast");
  } finally {
    globalThis.Date = RealDate;
    await s.close();
  }
});

Deno.test("[team] declaring the team's kinds does not clobber another app's artifact paths", async () => {
  const s = await newSpace();
  try {
    // The chat's own declaration. `artifact` is RESERVED and three apps extend it; the runtime
    // guards only its own paths, so it cannot tell one app's addition from another's.
    await s.admin.registerKind({
      kind: "artifact",
      indexedPaths: [
        { path: "digest", type: "keyword" },
        { path: "mediaType", type: "keyword" },
        { path: "conversationId", type: "keyword" },
        { path: "owner", type: "keyword" },
      ],
      claimable: false,
    });
    await s.admin.put({
      kind: "grant",
      body: { principal: "human:alice", kind: "artifact", operations: ["query"], pattern: { conversationId: "c1" } },
    });

    // `radia team add` runs on the same space. Flat, this left artifact on [digest, mediaType,
    // team] and every chat query and new chat grant naming `conversationId` was refused.
    await declareTeamKinds(s.admin);

    const paths = new Set(
      (await s.admin.queryNewest<{ indexedPaths: { path: string }[] }>({ kind: "kind_def", match: { kind: "artifact" } }, 1))[0]
        .body.indexedPaths.map((p) => p.path),
    );
    for (const p of ["digest", "mediaType", "conversationId", "owner", TEAM_FIELD]) {
      assert(paths.has(p), `'${p}' was dropped from artifact; declared: ${[...paths].join(",")}`);
    }

    // ENFORCEMENT, not the declaration: the other app's scoping still compiles and still binds.
    await s.admin.queryNewest({ kind: "artifact", match: { conversationId: "c1" } }, 1);
    await s.admin.put({
      kind: "grant",
      body: { principal: "human:bob", kind: "artifact", operations: ["query"], pattern: { conversationId: "c2" } },
    });
  } finally {
    await s.close();
  }
});

Deno.test("[team] mergeKind is additive on paths and states everything else", () => {
  // Paths are a SET, so a union is the one merge that is always safe. `claimable` and `usage` are
  // single-valued and are this build's opinion: merging them means picking a winner with no basis.
  const merged = mergeKind(
    { kind: "artifact", indexedPaths: [{ path: "digest", type: "keyword" }, { path: "owner", type: "keyword" }], claimable: false },
    { kind: "artifact", indexedPaths: [{ path: "digest", type: "keyword" }, { path: TEAM_FIELD, type: "keyword" }], claimable: false },
  );
  assertEquals(merged.indexedPaths.map((p) => p.path), ["digest", TEAM_FIELD, "owner"], "a foreign path was dropped");
  assertEquals(merged.indexedPaths.filter((p) => p.path === "digest").length, 1, "a shared path was duplicated");
  // Nothing declared yet is the common case and must not synthesise anything.
  assertEquals(mergeKind(undefined, { kind: "task", indexedPaths: [{ path: "a", type: "keyword" }] }).indexedPaths.length, 1);
});

Deno.test("[team] removal takes back DELEGABLE grants and EVERY ops power, not only what it granted", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:gone", { teams: ["alpha"] });
    // Authority usable only through a delegated run, held under a separate principal, and a power
    // this verb never granted. Both are unreachable while the definition is revoked; the failure is
    // that a later `team add` of the same name RESTORES them, granted by nobody.
    await s.admin.put({ kind: "grant", body: { principal: "delegable:agent:gone", kind: TASK, operations: ["query"] } });
    await s.admin.put({ kind: "ops_grant", body: { principal: "agent:gone", operations: ["remediate"] } });

    const r = await removeMember(s.admin, "agent:gone");
    assertEquals(r.opsPowersRetired, ["remediate"], "a power this verb did not grant was left standing");
    assertEquals(
      (await s.admin.permissions("delegable:agent:gone")).kinds,
      [],
      "delegable authority survived removal and would come back with the name",
    );
    assertEquals((await s.admin.permissions("agent:gone")).opsPowers ?? [], []);

    // The resurrection this guards: re-adding the name must not restore anything.
    await addMember(s.admin, "agent:gone", { teams: ["alpha"] });
    assertEquals((await s.admin.permissions("agent:gone")).opsPowers ?? [], [], "re-adding the name restored a power");
    assertEquals((await s.admin.permissions("delegable:agent:gone")).kinds, [], "re-adding restored delegable authority");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the scope filler learns from the runtime's REAL refusal, not a hand-written one", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:m", { teams: ["alpha"] });
    const member = new RadiaClient(s.base, { definitionToken: m.definitionToken });

    // `ScopeFiller` recognises a scope refusal by MATCHING THE RUNTIME'S WORDING
    // (/outside the pattern scope/). Every case in the unit test above rejects with a string this
    // file wrote, so a reword in `src/server/handlers/records.ts` would leave them green while the
    // fill silently turned off in production: the model would get a raw refusal it cannot act on.
    // This one takes the refusal from the server.
    const filler = new ScopeFiller(member);
    const wrote = await filler.fill(TASK, (extra) => member.put({ kind: TASK, body: { title: "unlabelled", ...extra } }));
    assert(wrote.id, "the fill did not recover a write the runtime refused for scope");

    // And the label it learned is the one enforcement requires, read back off the record.
    const [rec] = await member.queryNewest<{ team?: string }>({ kind: TASK, match: { [TEAM_FIELD]: "alpha" } }, 1);
    assertEquals(rec.body.team, "alpha");
    assertEquals(filler.known(TASK), { [TEAM_FIELD]: "alpha" });
  } finally {
    await s.close();
  }
});

Deno.test("[team] two concurrent adds cannot leave one agent two live definitions", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const prior = await readDefinition(s.admin, "agent:raced");
    assertEquals(prior.state, "none");

    // Both racers DECIDE on the same state, exactly as two `radia team add` in two terminals do.
    // Unconditional, both writes land and the agent ends with two tokens minting, while
    // `revokeDefinition` reaches only the newest: a credential nobody can later stop.
    const both = await Promise.allSettled([
      addMember(s.admin, "agent:raced", { teams: ["alpha"], supersedes: prior.id }),
      addMember(s.admin, "agent:raced", { teams: ["alpha"], supersedes: prior.id }),
    ]);
    const won = both.filter((r) => r.status === "fulfilled");
    const lost = both.filter((r) => r.status === "rejected");
    assertEquals(won.length, 1, "both creates landed: the agent has two live definitions");
    assertEquals(lost.length, 1);
    assert(
      String((lost[0] as PromiseRejectedResult).reason).includes("concurrently"),
      `the loser must say why: ${(lost[0] as PromiseRejectedResult).reason}`,
    );

    // ENFORCEMENT: exactly one definition record, so revoking reaches the only token there is.
    const defs = await s.admin.queryAll({ kind: "agent_definition", match: { agent: "agent:raced" } });
    assertEquals(defs.length, 1, "a second definition record was written");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the unconditional create still works, because a fleet re-mints on every start", async () => {
  const s = await newSpace();
  try {
    // `supersedes` is OPT-IN. The chat fleet creates its workers' definitions on every `--serve`
    // (plan-startup-ergonomics item 8), so a blanket refusal would break that rather than fix it.
    const a = await s.admin.createAgentDefinition("agent:fleet", []);
    const b = await s.admin.createAgentDefinition("agent:fleet", []);
    assert(a.definitionToken !== b.definitionToken, "the unconditional path must keep re-minting");
  } finally {
    await s.close();
  }
});

Deno.test("[team] a revoked principal still holding ops powers is REPORTED, not filtered out", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    await addMember(s.admin, "agent:ghost", { teams: ["alpha"], observe: true });
    // `radia revoke` stops MINTING and nothing else, deliberately. The power outlives it, keyed to
    // the PRINCIPAL, and every warning list filtered on `active`, so it was invisible.
    await s.admin.revokeDefinition("agent:ghost");

    const roster = await teamRoster(s.admin);
    const ghost = roster.find((m) => m.agent === "agent:ghost")!;
    assertEquals(ghost.active, false);
    assertEquals(ghost.opsPowers, ["observe"], "the roster must still report a revoked principal's powers");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the roster bounds its in-flight reads, and reports every definition", async () => {
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    for (let i = 0; i < 20; i++) await addMember(s.admin, `agent:m${i}`, { teams: ["alpha"] });
    const roster = await teamRoster(s.admin);
    assertEquals(roster.length, 20, "concurrency must not drop or duplicate a member");
    // Order is preserved through the parallel map, so the sort below is the only thing deciding it.
    assertEquals(roster.map((m) => m.agent), [...roster.map((m) => m.agent)].sort((a, b) => a.localeCompare(b)));
    assert(roster.every((m) => m.member && m.teams.length === 1), "a parallel read returned a wrong row");
  } finally {
    await s.close();
  }
});

Deno.test("[team] the MCP match description names every operator the compiler takes, and no other", async () => {
  // A model reaching this surface has no second source: the description IS the documentation. It
  // named `$ne` and `$nin`, both DEFERRED, so following it bought a guaranteed refusal, and it left
  // out `$exists`, which is how unassigned work is claimed. Read from source rather than from the
  // imported constant, since the failure being guarded is a hand-written list drifting from the
  // compiler beside it.
  const matching = await Deno.readTextFile(new URL("../src/core/matching.ts", import.meta.url));
  const set = (name: string) =>
    [...(matching.match(new RegExp(`const ${name} = new Set\\(\\[(.*?)\\]`, "s"))?.[1] ?? "").matchAll(/"(\$[a-z]+)"/g)]
      .map((m) => m[1]);
  const unavailable = [...set("FORBIDDEN"), ...set("DEFERRED")];
  assert(unavailable.length >= 8, `failed to read the operator sets from matching.ts; found ${unavailable.length}`);

  const tools = await Deno.readTextFile(new URL("../src/surfaces/mcp/tools.ts", import.meta.url));
  const desc = tools.split("const MATCH = {")[1]?.split("};")[0] ?? "";
  assert(desc.includes("Pattern match on the record body"), "the MATCH description moved; this guard is now checking nothing");
  const promised = unavailable.filter((op) => desc.includes(`${op} `) || desc.includes(`${op}\\"`));
  assertEquals(promised, [], "the tool description promises operators the compiler refuses");
  // $eq is the implicit form and $in/$exists are the two a model has to be TOLD about: one for a
  // mailbox, one for unclaimed work.
  for (const op of ["$in", "$exists", "$any"]) {
    assert(desc.includes(op), `the MATCH description does not mention ${op}, so nothing teaches it`);
  }
});

Deno.test("[mcp] a narrowed read says so, on every tool that has a scope to report", async () => {
  // The runtime is careful here and the SURFACE was not. `space_stats` called the SDK method that
  // returns `r.stats` alone, so a pattern-scoped member asking for stats on a space holding eight
  // kinds got `[]` and read it as an empty space. Seen in a real agent-lab run, by a model, which
  // is the reader with no second source (agent_docs/plan-agent-lab.md).
  const src = await Deno.readTextFile(new URL("../src/surfaces/mcp/server.ts", import.meta.url));
  for (const dropping of ["client.getStats(", "client.getLineage(", "client.getChildren(", "client.queryOldest(", "client.queryOrdered("]) {
    assert(!src.includes(dropping), `the adapter calls ${dropping}…), which drops the scope the endpoint attached`);
  }

  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:a1", { teams: ["alpha"] });
    const c = new RadiaClient(s.base, { definitionToken: m.definitionToken });
    const task = await c.put({ kind: TASK, body: { [TEAM_FIELD]: "alpha", title: "one" } });
    await c.put({ kind: NOTE, body: { [TEAM_FIELD]: "alpha", to: "all", message: "done" }, parentIds: [task.id] });

    // Each of these is what a tool now calls, and each must carry what the endpoint attached.
    assert((await c.getStatsReport()).scope, "stats");
    assert((await c.queryPage({ kind: TASK }, 10)).scope, "query");
    assert((await c.getChildrenPage(task.id)).scope, "children");
    assert((await c.getLineageReport(task.id)).scope, "lineage");

    // …and the bare convenience methods still answer the old way, since apps depend on them.
    assert(Array.isArray(await c.getStats()));
    assert(Array.isArray(await c.getChildren(task.id)));
  } finally {
    await s.close();
  }
});

Deno.test("[team] health names the DURABLE agent, not only the run it resolved to", async () => {
  // A run is not what anything addresses. `note.to` is documented as `agent:name`, and this call
  // was the only place a model could ask who it is: it answered `run:01M13R…`, so two harnesses in
  // a lab run addressed their mail to run ids. It worked, because both were wrong the same way,
  // and it would have stopped at the 12h ceiling (agent_docs/plan-agent-lab.md).
  const s = await newSpace();
  try {
    await declareTeamKinds(s.admin);
    const m = await addMember(s.admin, "agent:a1", { teams: ["alpha"] });
    const c = new RadiaClient(s.base, { definitionToken: m.definitionToken });

    // The exchange first, as the adapter's `space_health` now does: `/v0/health` is PUBLIC, so an
    // unauthenticated call answers `anonymous` instead of 401ing into a mint, and a model whose
    // first question is "who am I" would be told "nobody".
    await c.ensureCredential();
    const h = await c.health();
    assert(h.principal.startsWith("run:"), `a member acts as a run, got ${h.principal}`);
    assertEquals(h.agent, "agent:a1", "the durable name a note can be addressed to");

    // The OPERATOR is already durable, so there is nothing to add and the field stays absent:
    // its presence is the statement "your principal is not the name to use".
    assertEquals((await s.admin.health()).agent, undefined);
  } finally {
    await s.close();
  }
});
