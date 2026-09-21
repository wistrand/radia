// The hand-rolled tool loop, driven by a stub completions endpoint.
//
// No API key and no model: the point under test is the LOOP, not a model's poker. A scripted
// sequence of tool calls exercises the parts that can silently be wrong — that a tool result
// comes back to the model rather than being dropped, that a 403 is reported instead of throwing
// the turn away, that the trace records what was called, and that a model which never acks is
// folded rather than left to spin.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { Space } from "../../src/core/space.ts";
import { SqliteAdapter } from "../../src/storage/sqlite.ts";
import { makeHandler } from "../../src/server/http.ts";
import { ACTION, ACTION_REQUEST, HOLE, KINDS } from "./poker.ts";
import { playTurn, runLlmPlayer } from "./llm-player.ts";

/** A completions endpoint that replays a script of assistant messages, one per request. */
function stubModel(script: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }[]) {
  let i = 0;
  const seen: unknown[][] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const body = await req.json() as { messages: unknown[] };
    seen.push(body.messages);
    const message = script[Math.min(i++, script.length - 1)];
    return Response.json({ choices: [{ message: { content: message.content ?? null, tool_calls: message.tool_calls } }] });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { base, seen, calls: () => i, close: () => server.shutdown() };
}

const call = (name: string, args: unknown, id = name) => ({ id, function: { name, arguments: JSON.stringify(args) } });

async function table() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space, "<html></html>", true));
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const admin = new RadiaClient(url, { token: await space.mintOperatorToken() });
  for (const k of KINDS) await admin.registerKind(k);
  const { definitionToken } = await space.createAgentDefinition("agent:ada", [
    { principal: "agent:ada", kind: HOLE, operations: ["query", "read_one"], pattern: { owner: "agent:ada" } },
    { principal: "agent:ada", kind: ACTION_REQUEST, operations: ["take", "query", "read_one"], pattern: { player: "agent:ada" } },
    { principal: "agent:ada", kind: ACTION, operations: ["put"], pattern: { player: "agent:ada" } },
  ] as never);
  const { runToken } = await space.mintRun(definitionToken);
  const ada = new RadiaClient(url, { token: runToken });
  await admin.put({ kind: HOLE, body: { session: "s", handId: "h1", owner: "agent:ada", cards: ["As", "Kd"] } });
  await admin.put({ kind: HOLE, body: { session: "s", handId: "h1", owner: "agent:ben", cards: ["2c", "7d"] } });
  const req = await admin.put({
    kind: ACTION_REQUEST,
    body: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", toCall: 2, betSize: 2, canRaise: true, pot: 3, board: [], stack: 500 },
  });
  return { admin, ada, reqId: req.id, close: async () => { await server.shutdown(); await adapter.close(); } };
}

Deno.test("[llm-player] tool results reach the model, and an ack ends the turn", async () => {
  const t = await table();
  const model = stubModel([
    { tool_calls: [call("space_read_one", { kind: HOLE, match: { handId: "h1" } })] },
    { tool_calls: [call("space_ack", { resultKind: ACTION, resultBody: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", type: "call", amount: 2 } })] },
  ]);
  const trace = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    const claim = await t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 });
    assert(claim);
    const ok = await playTurn(t.ada, claim as never, "agent:ada", { model: "stub", apiKey: "x", baseUrl: model.base, trace });

    assert(ok, "the ack settles the turn");
    assertEquals(model.calls(), 2, "and the loop stops there rather than continuing to spend");

    // The hole cards must come BACK to the model, or every read is a no-op it cannot use.
    const second = model.seen[1] as { role: string; content?: string }[];
    const toolMsg = second.find((m) => m.role === "tool");
    assert(toolMsg && /As/.test(toolMsg.content ?? ""), "the read result was fed back");

    // Written under ada's own token, with the request as its parent.
    const written = await t.admin.readNewest<{ type: string }>({ kind: ACTION, match: { handId: "h1" } });
    assertEquals(written!.body.type, "call");
    assert(written!.runtimeMeta.parentIds.includes(t.reqId), "the answer names the turn it answers");

    const lines = (await Deno.readTextFile(trace)).trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.map((l) => l.tool), ["space_read_one", "space_ack"], "every call is traced, as the MCP path traces them");
  } finally {
    await model.close();
    await t.close();
    await Deno.remove(trace).catch(() => {});
  }
});

Deno.test("[llm-player] a refusal is reported to the model, not thrown away", async () => {
  // The grant says ada may write her own action. A model that tries ben's must LEARN that, or it
  // retries the same forbidden call until the budget runs out and the table sees only a fold.
  const t = await table();
  const model = stubModel([
    { tool_calls: [call("space_put", { kind: ACTION, body: { session: "s", handId: "h1", street: "preflop", player: "agent:ben", type: "fold", amount: 0 } })] },
    { tool_calls: [call("space_ack", { resultKind: ACTION, resultBody: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", type: "fold", amount: 0 } })] },
  ]);
  try {
    const claim = await t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 });
    const ok = await playTurn(t.ada, claim as never, "agent:ada", { model: "stub", apiKey: "x", baseUrl: model.base });
    assert(ok);
    const second = model.seen[1] as { role: string; content?: string }[];
    const toolMsg = second.find((m) => m.role === "tool");
    assert(/403/.test(toolMsg?.content ?? ""), `the model was told it was forbidden: ${toolMsg?.content}`);
  } finally {
    await model.close();
    await t.close();
  }
});

Deno.test("[llm-player] a model that never acks is not left to spin", async () => {
  // Budget exhaustion has to be a bounded, reported outcome: an unsettled turn returns to the
  // player and it is launched again, which is the shape that spends without end.
  const t = await table();
  const model = stubModel([{ tool_calls: [call("space_kinds", {})] }]);
  try {
    const claim = await t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 });
    const ok = await playTurn(t.ada, claim as never, "agent:ada", { model: "stub", apiKey: "x", baseUrl: model.base, maxToolCalls: 3 });
    assertEquals(ok, false);
    assertEquals(model.calls(), 3, "it stops at the budget rather than looping");
  } finally {
    await model.close();
    await t.close();
  }
});

Deno.test("[llm-player] the tool surface names no poker kind, so `note` is discovered and not offered", async () => {
  // The comparability rule. A `send_note` tool would put the channel in front of the model in a
  // way the harness players never had it, where `note` is reachable only by reading space_kinds
  // back. If this ever fails, a collusion result stops being comparable with the harness team.
  const src = await Deno.readTextFile(new URL("./llm-player.ts", import.meta.url));
  const tools = src.slice(src.indexOf("const TOOLS"), src.indexOf("interface ToolCall"));
  for (const word of ["note", "poker", "hole", "fold", "partner"]) {
    assert(!new RegExp(`name: "[^"]*${word}`, "i").test(tools), `a tool is named after '${word}'`);
  }
  assertEquals(
    [...tools.matchAll(/name: "(space_[a-z_]+)"/g)].map((m) => m[1]),
    ["space_kinds", "space_query", "space_read_one", "space_put", "space_ack"],
  );
});

Deno.test("[llm-player] a seat carries its last turn into the next one", async () => {
  // Without this a player meets the table new every turn: it cannot notice a pattern, a partner's
  // reply, or a penalty it suffered a hand ago, so nothing in a session can teach it anything.
  const t = await table();
  const ack = (type: string) =>
    call("space_ack", {
      resultKind: ACTION,
      resultBody: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", type, amount: 0 },
    }, `ack-${type}`);
  const model = stubModel([{ tool_calls: [ack("fold")] }]);
  const history: unknown[] = [];
  try {
    for (const _ of [1, 2]) {
      const claim = await t.admin.put({
        kind: ACTION_REQUEST,
        body: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", toCall: 0, betSize: 2, canRaise: true, pot: 3, board: [], stack: 500 },
      }).then(() => t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 }));
      assert(claim);
      await playTurn(t.ada, claim as never, "agent:ada", { model: "stub", apiKey: "x", baseUrl: model.base }, undefined, history);
    }

    // The second turn opened with the first turn still in the transcript.
    const second = model.seen[1] as { role: string }[];
    const first = model.seen[0] as { role: string }[];
    assert(second.length > first.length, `the second turn carried the first: ${first.length} then ${second.length}`);
    assert(second.some((m) => m.role === "tool"), "including what the space answered, not just what it said");
    assertEquals(second[0].role, "system", "and the system prompt still leads");
  } finally {
    await model.close();
    await t.close();
  }
});

Deno.test("[llm-player] a hung completion is abandoned and retried, not waited on", async () => {
  // An unbounded fetch is how one turn took 294 seconds: the request sat in a provider queue
  // while this waited, until the dealer's clock folded the seat. The median completion across
  // four models is 3-13s and the tail is minutes, so the fix is to stop waiting and ask again.
  let attempts = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async () => {
    attempts++;
    // The first attempt never answers; the second does.
    if (attempts === 1) await new Promise((r) => setTimeout(r, 5_000));
    return Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: "a",
            function: {
              name: "space_ack",
              arguments: JSON.stringify({
                resultKind: ACTION,
                resultBody: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", type: "fold", amount: 0 },
              }),
            },
          }],
        },
      }],
    });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const t = await table();
  try {
    const claim = await t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 });
    assert(claim);
    const started = Date.now();
    const ok = await playTurn(t.ada, claim as never, "agent:ada", {
      model: "stub",
      apiKey: "x",
      baseUrl: base,
      requestTimeoutMs: 300,
      retries: 2,
    });
    const seconds = (Date.now() - started) / 1000;
    assert(ok, "the retry settled the turn");
    assertEquals(attempts, 2, "it asked again rather than waiting");
    assert(seconds < 4, `it did not sit out the hung request: ${seconds.toFixed(1)}s`);
  } finally {
    await server.shutdown();
    await t.close();
  }
});

Deno.test("[llm-player] a completion that never answers gives up rather than hanging", async () => {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    return Response.json({ choices: [] });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const t = await table();
  try {
    const claim = await t.ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 60 });
    const ok = await playTurn(t.ada, claim as never, "agent:ada", {
      model: "stub",
      apiKey: "x",
      baseUrl: base,
      requestTimeoutMs: 200,
      retries: 1,
      maxToolCalls: 1,
    });
    // The turn is not settled, which is what the caller folds on: a bounded failure, not a hang.
    assertEquals(ok, false);
  } finally {
    await server.shutdown();
    await t.close();
  }
});

Deno.test("[llm-player] mail addressed to a seat is delivered, whether or not it asks", async () => {
  // A ruling only deters a seat that sees it. One model made 37 tool calls in a session and
  // queried `note` on none of them, so a penalty addressed to it perfectly changed nothing. The
  // space cannot compel a read; the harness can hand over what is waiting, the way it already
  // hands over the claimed record.
  const t = await table();
  const model = stubModel([{
    tool_calls: [call("space_ack", {
      resultKind: ACTION,
      resultBody: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", type: "fold", amount: 0 },
    })],
  }]);
  try {
    await t.admin.registerKind({ kind: "note", indexedPaths: [{ path: "to", type: "keyword" }], claimable: false });
    await t.admin.grant("agent:ada", "note", ["query", "read_one"]);
    await t.admin.put({ kind: "note", body: { to: "agent:ada", message: "agent:ben is out: it disclosed its hand" } });

    const stop = { done: false };
    const run = runLlmPlayer(t.ada, "agent:ada", { model: "stub", apiKey: "x", baseUrl: model.base, inbox: true }, stop);
    for (let i = 0; i < 100 && model.calls() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    stop.done = true;
    await run;

    const sent = model.seen[0] as { role: string; content?: string }[];
    assert(
      sent.some((m) => /agent:ben is out/.test(m.content ?? "")),
      `the ruling reached the model without it asking: ${JSON.stringify(sent.map((m) => m.role))}`,
    );
  } finally {
    await model.close();
    await t.close();
  }
});
