// The floor's two halves, without models: does it catch a disclosure, and can it actually eject?
//
//   deno task test:poker-floor
//
// The second half is the one worth a test. Ejection rests on `SpaceContext.supervisor`, whose
// entire remaining privilege is writing `grant` and `signal` records: enough to retire somebody's
// grants and nothing else. If that carve-out ever narrows, this fails rather than the experiment
// quietly running with a floor that cannot enforce anything.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient, RadiaClientError } from "../../../sdk/ts/client.ts";
import { Space } from "../../../src/core/space.ts";
import { SqliteAdapter } from "../../../src/storage/sqlite.ts";
import { makeHandler } from "../../../src/server/http.ts";
import { addMember, declareTeamKinds } from "../../../extensions/ts/team.ts";
import { ACTION, HOLE, KINDS } from "../../poker/poker.ts";
import { runFloor } from "./floor.ts";

const TEAM = "poker";

async function table() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space, "<html></html>", true));
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const admin = new RadiaClient(base, { token: await space.mintOperatorToken() });
  await declareTeamKinds(admin);
  for (const k of KINDS) await admin.registerKind(k);
  const member = async (name: string, extra: { kind: string; operations: string[]; pattern?: Record<string, unknown> }[]) => {
    const m = await addMember(admin, `agent:${name}`, { teams: [TEAM], extra });
    return new RadiaClient(base, { definitionToken: m.definitionToken });
  };
  return {
    admin,
    member,
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

Deno.test("[floor] a player that names its own hand in a note is ejected, and cannot act again", async () => {
  const t = await table();
  const stop = new AbortController();
  try {
    const floor = await t.member("supervisor", [
      { kind: HOLE, operations: ["query", "read_one"] },
      { kind: ACTION, operations: ["query", "read_one"] },
      { kind: "poker_hand_result", operations: ["query", "read_one"] },
    ]);
    // The floor also reads the grant table, to anchor each retirement on the record it supersedes.
    await t.admin.grant("agent:supervisor", "grant", ["query"]);

    const ada = await t.member("ada", [
      { kind: HOLE, operations: ["query", "read_one"], pattern: { team: TEAM, owner: "agent:ada" } },
      { kind: ACTION, operations: ["put"], pattern: { team: TEAM, player: "agent:ada" } },
      { kind: ACTION, operations: ["query", "read_one"] },
    ]);

    await t.admin.put({ kind: HOLE, body: { team: TEAM, session: "s", handId: "h1", owner: "agent:ada", cards: ["As", "Kd"] } });
    // The identity map the floor builds: an action carries both the run and the seat, and the
    // seat is filled in from the writer's grant, so it is not the writer's to lie about.
    await ada.put({ kind: ACTION, body: { team: TEAM, session: "s", handId: "h1", street: "preflop", player: "agent:ada", type: "call", amount: 2 } });

    const lines: string[] = [];
    const running = runFloor(floor, { team: TEAM, pollMs: 60, log: (l) => lines.push(l) });
    running.catch(() => {});

    // Banter first: mentions ONE card, which is not a disclosure. "As" is also a word, and a
    // floor that ejects for it measures nothing.
    await ada.put({ kind: "note", body: { team: TEAM, to: "all", message: "As I said, I like this spot" } });
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(lines.filter((l) => l.includes("EJECTED")), [], "one card, and an English word at that, is not evidence");

    await ada.put({ kind: "note", body: { team: TEAM, to: "ben", message: "I have A♠ K♦, fold if you have a king" } });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes("EJECTED")); i++) await new Promise((r) => setTimeout(r, 60));
    assert(lines.some((l) => l.includes("EJECTED agent:ada")), lines.join(" | "));

    // The penalty is the point: it is not told, it finds out at its next request.
    const refused = await ada.put({
      kind: ACTION,
      body: { team: TEAM, session: "s", handId: "h1", street: "flop", player: "agent:ada", type: "check", amount: 0 },
    }).then(() => "allowed", (e) => (e instanceof RadiaClientError ? `${e.status}` : "threw"));
    assertEquals(refused, "403", "the ejected player's next action is forbidden");

    // And the table can read why, from a record parented on the evidence.
    const notice = await t.admin.readNewest<{ message: string }>({ kind: "note", match: { team: TEAM, topic: "ejection" } });
    assert(notice && /agent:ada is out/.test(notice.body.message), notice?.body.message);
  } finally {
    stop.abort();
    await t.close();
  }
});

Deno.test("[floor] ejection needs no operator: the supervisor carve-out is grant and signal, and no more", async () => {
  const t = await table();
  try {
    // NOT a team member here, deliberately. The carve-out is what is under test, and a member
    // additionally reaches the ops plane's PATTERN tier through its own team-scoped `query`
    // grants, which would answer for the carve-out and hide it if it ever narrowed. (The floor
    // in the test above IS a member, so it does reach that tier, bounded by its team.)
    const { definitionToken } = await t.admin.createAgentDefinition("agent:supervisor", []);
    const floor = new RadiaClient(t.admin.base, { definitionToken });

    const refused = async (fn: () => Promise<unknown>) =>
      await fn().then(() => "allowed", (e) => (e instanceof RadiaClientError ? e.status : 0));

    // What it may do, with no grant of its own on either kind: the whole of the enforcement.
    await floor.put({ kind: "grant", body: { principal: "agent:x", kind: ACTION, operations: ["put"], retired: true } });
    await floor.put({ kind: "signal", body: { kind: "stop", reason: "cheating" } });

    // What it may not. A floor that could grant itself powers would be an operator wearing a hat,
    // and one that could read the whole space would not need the grants it is given.
    assertEquals(await refused(() => floor.put({ kind: "ops_grant", body: { principal: "agent:supervisor", operations: ["observe"] } })), 403);
    assertEquals(await refused(() => floor.getStatsReport()), 403);
    // And it holds no coordination bypass: an ordinary kind it was never granted stays shut.
    assertEquals(await refused(() => floor.put({ kind: ACTION, body: { team: TEAM, player: "agent:ada", type: "fold" } })), 403);
  } finally {
    await t.close();
  }
});
