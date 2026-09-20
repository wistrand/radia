// One turn, one model, against a real OpenRouter call. The qualifier to run before spending on a
// long session with a model you have not used here before.
//
//   deno task poker-llm-smoke                                   # the default cheap model
//   deno task poker-llm-smoke --model google/gemini-3-flash     # any OpenRouter slug
//
// NOT part of `deno task test`, and it never should be: it costs money and needs a key, while a
// suite has to run for anyone. `llm-player.test.ts` covers the loop against a stub with no key;
// this covers the half a stub cannot, which is whether a given model actually drives the tools.
// Without a key it says so and exits 0, so a CI that stumbles into it does not fail.
//
// It exists because the first two live attempts failed and both failures were invisible to the
// stub: a model that called `space_kinds` and still guessed the kind name, and a model that spent
// five acks discovering a field its grant required. Each was a real defect (a prompt that told
// the player to discover what the harness players are told outright, and a missing `ScopeFiller`),
// and each is the kind of thing only a real model finds.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { Space } from "../../src/core/space.ts";
import { SqliteAdapter } from "../../src/storage/sqlite.ts";
import { makeHandler } from "../../src/server/http.ts";
import { ACTION, ACTION_REQUEST, HOLE, KINDS } from "./poker.ts";
import { playTurn } from "./llm-player.ts";

const arg = (name: string, fallback?: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? Deno.args[at + 1] : fallback;
};
const model = arg("model", "deepseek/deepseek-v4-flash")!;

if (!Deno.env.get("OPENROUTER_API_KEY")) {
  console.log("poker-llm-smoke: no OPENROUTER_API_KEY, nothing to check. Set one to run it.");
  Deno.exit(0);
}

const adapter = new SqliteAdapter(":memory:");
await adapter.init();
const space = new Space(adapter);
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space, "<html></html>", true));
const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
const trace = await Deno.makeTempFile({ prefix: "poker-llm-", suffix: ".jsonl" });
let failures = 0;
const check = (what: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${what}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

try {
  const admin = new RadiaClient(url, { token: await space.mintOperatorToken() });
  for (const k of KINDS) await admin.registerKind(k);
  // The same grants a seat holds at the real table, patterns included: a model that cannot write
  // its own action here would not be able to play there either.
  const { definitionToken } = await space.createAgentDefinition("agent:ada", [
    { principal: "agent:ada", kind: HOLE, operations: ["query", "read_one"], pattern: { owner: "agent:ada" } },
    { principal: "agent:ada", kind: ACTION_REQUEST, operations: ["take", "query", "read_one"], pattern: { player: "agent:ada" } },
    { principal: "agent:ada", kind: ACTION, operations: ["put"], pattern: { player: "agent:ada" } },
    { principal: "agent:ada", kind: ACTION, operations: ["query", "read_one"] },
  ] as never);
  const ada = new RadiaClient(url, { token: (await space.mintRun(definitionToken)).runToken });

  await admin.put({ kind: HOLE, body: { session: "s", handId: "h1", owner: "agent:ada", cards: ["As", "Kd"] } });
  await admin.put({ kind: HOLE, body: { session: "s", handId: "h1", owner: "agent:ben", cards: ["2c", "7d"] } });
  await admin.put({
    kind: ACTION_REQUEST,
    body: { session: "s", handId: "h1", street: "preflop", player: "agent:ada", toCall: 2, betSize: 2, canRaise: true, pot: 3, board: [], stack: 500 },
  });

  console.log(`poker-llm-smoke: ${model}\n`);
  const claim = await ada.take({ pattern: { kind: ACTION_REQUEST, match: { player: "agent:ada" } } }, { leaseSeconds: 180 });
  if (!claim) throw new Error("the turn was not claimable, which is a space problem and not a model one");

  const started = Date.now();
  let settled = false;
  let error = "";
  try {
    settled = await playTurn(ada, claim as never, "agent:ada", { model, trace });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const calls = (await Deno.readTextFile(trace)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> });
  for (const c of calls) console.log(`  -> ${c.tool} ${JSON.stringify(c.args).slice(0, 96)}`);
  console.log();

  check(`the model drove the tools at all (${seconds}s)`, calls.length > 0, error || `${calls.length} calls`);
  check("it settled the turn", settled, error);
  // The two live failures, as assertions. A model that reads the wrong kind gets no cards and is
  // playing blind; one that acks repeatedly is paying to discover what its grant already says.
  check("it read its own cards from the right kind", calls.some((c) => c.args.kind === HOLE), calls.map((c) => c.args.kind).filter(Boolean));
  check("one ack, not a series of refused ones", calls.filter((c) => c.tool === "space_ack").length === 1, calls.filter((c) => c.tool === "space_ack").length);

  const written = await admin.readNewest<{ type: string; amount: number; player: string }>({ kind: ACTION, match: { handId: "h1" } });
  check("an action landed", written !== null);
  if (written) {
    check("with a type the dealer can read", ["fold", "check", "call", "bet", "raise"].includes(written.body.type), written.body.type);
    // Filled in by `ScopeFiller` from the grant, never written by the model: the property that
    // makes a player unable to act as anyone else.
    check("and the seat filled in from the grant", written.body.player === "agent:ada", written.body.player);
  }
  console.log(failures === 0 ? `\npoker-llm-smoke: ${model} ok` : `\npoker-llm-smoke: ${model}, ${failures} FAILED`);
} finally {
  await server.shutdown();
  await adapter.close();
  await Deno.remove(trace).catch(() => {});
}

Deno.exit(failures === 0 ? 0 : 1);
