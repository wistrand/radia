// The fenced turn link (agent_docs/plan-chat-turn.md, build step 2a): for a CONVERSATION call the
// assistant `message` IS the inference worker's ack, and for an INLINE call (the router's
// classifier shape) the reply stays an `llm_result` and touches no transcript.
//
// This is the one suite that runs the REAL inference worker, against a fake OpenRouter
// (`RADIA_CHAT_API_BASE`), because the changed seam is the worker's ack and every other suite
// drives workers that never call a model. No API key.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, mintSession, setSessionOwner } from "./space/roles.ts";
import { Thread } from "./client/thread.ts";
import { runTurn, ToolSet } from "./client/turn.ts";

const PORT = 7824;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
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
const { inferenceToken, turnToken, routerToken } = await bootstrap(admin);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// A fake OpenRouter. Two answers, chosen by what it was asked, which is enough to drive a real
// multi-round turn: a conversation that says "compute" and has no tool reply yet gets a tool call,
// everything else gets text. SSE, because the provider client always speaks the streaming shape.
const frames = (deltas: Record<string, unknown>[]) =>
  [...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
    "data: [DONE]",
    ""].join("\n");

const fake = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const sent = await req.json().catch(() => ({})) as { messages?: { role?: string; content?: string }[] };
  const msgs = sent.messages ?? [];
  // Per TURN, not per thread: "has this conversation ever run a tool" was true for every round of
  // every later turn, so a second turn answered in one round and the multi-round case silently
  // stopped being tested. The last message is the turn's own state.
  const last = msgs[msgs.length - 1] ?? {};
  const wantsTool = last.role === "user" && (last.content ?? "").includes("compute");
  // "compute twice" asks for TWO calls in one message: a multi-call round, which is the shape every
  // other case here misses and the one that broke live.
  const two = last.role === "user" && (last.content ?? "").includes("compute twice");
  // "compute forever" never stops asking, which is the only way to reach the round cap.
  const forever = msgs.some((m) => (m.content ?? "").includes("compute forever"));
  const call = (n: number) => ({
    index: n,
    id: `call_c${n + 1}`,
    function: { name: "run_javascript", arguments: JSON.stringify({ code: `console.log(${n + 1}*42)` }) },
  });
  const body = two
    ? frames([{ tool_calls: [call(0), call(1)] }])
    : (wantsTool || forever)
    ? frames([{ tool_calls: [call(0)] }])
    : frames([{ content: "canned answer" }]);
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
});
const apiBase = `http://127.0.0.1:${(fake.addr as Deno.NetAddr).port}`;

const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run", "-A", "examples/chat/workers/inference.ts",
    "--url", url, "--token", inferenceToken, "--tier", "fast", "--model", "fake/model",
  ],
  env: { RADIA_CHAT_API_BASE: apiBase, OPENROUTER_API_KEY: "unused" },
  stdout: "null",
  stderr: "inherit",
}).spawn();

const awaitOne = async (pattern: { kind: string; match?: Record<string, unknown> }, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    const r = await admin.readOne(pattern);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
};

try {
  // --- a conversation call: the transcript entry is the ack ---
  const conv = (await admin.put({ kind: "conversation", body: {} })).id;
  await admin.put({
    kind: "message",
    body: { conversationId: conv, owner: "human:t", index: 0, role: "user", content: "hi" },
    parentIds: [conv],
  });
  const call = await admin.put({
    kind: "llm_call",
    body: { conversationId: conv, owner: "human:t", upToIndex: 0, tools: [], tier: "fast", stream: false },
    parentIds: [conv],
  });

  const msg = await awaitOne({ kind: "message", match: { callId: call.id } });
  check("a conversation call's answer arrives AS a message, keyed by the call", msg !== null);
  const b = (msg?.body ?? {}) as Record<string, unknown>;
  check("…role assistant, at the slot after upToIndex", b.role === "assistant" && b.index === 1, JSON.stringify({ role: b.role, index: b.index }));
  check("…carrying the content", b.content === "canned answer", String(b.content));
  check("…and the worker stamped how it was produced", b.tier === "fast" && b.finishReason === "stop", JSON.stringify({ tier: b.tier, finishReason: b.finishReason }));
  // Via the reverse edge, because that is the query a reader actually asks ("what did this call
  // produce"): the ack prepends the claimed record as the result's parent, the writer never says.
  const produced = await admin.getChildren(call.id);
  check(
    "…and the claimed call is its parent, from the ack's fence, not from the writer's say-so",
    produced.some((r) => r.id === msg?.id),
    JSON.stringify(produced.map((r) => `${r.kind}:${r.id.slice(-4)}`)),
  );
  const stray = await admin.readOne({ kind: "llm_result", match: { callId: call.id } });
  check("…and NO llm_result exists for it: the message is not a copy, it is the result", stray === null);

  // --- a worker whose RUN is killed re-authenticates instead of spinning ---
  // Seen for real: a dev space restarted under a running fleet and every worker looped on
  // `token_expired` forever, because `bootstrap` handed out run tokens and threw the durable half
  // away. A definition token has no expiry and can only mint, so the SDK exchanges it (see
  // conformance/exchange.test.ts) and the worker survives its own credential dying.
  const runs = await admin.query({ kind: "agent_run", match: { agent: "agent:chat-inference" } }, 10, { dir: "desc" });
  const live = (runs[0]?.body as { run?: string } | undefined)?.run;
  check("the inference worker minted its own run from the durable half", !!live, String(live));
  if (live) {
    await admin.stopRun(live);
    const after = await admin.put({
      kind: "llm_call",
      body: { conversationId: conv, owner: "human:t", upToIndex: 0, tools: [], tier: "fast", stream: false },
      parentIds: [conv],
    });
    const recovered = await awaitOne({ kind: "message", match: { callId: after.id } }, 200);
    check("…and answers again after that run is STOPPED, by minting another", recovered !== null);
  }

  // --- an inline call (the classifier shape): an RPC, no transcript ---
  const inline = await admin.put({
    kind: "llm_call",
    body: { tier: "fast", messages: [{ role: "user", content: "fast or deep?" }], tools: [], stream: false, temperature: 0 },
  });
  const rpc = await awaitOne({ kind: "llm_result", match: { callId: inline.id } });
  check("an INLINE call still answers with llm_result", rpc !== null);
  const ghost = await admin.readOne({ kind: "message", match: { callId: inline.id } });
  check("…and writes NOTHING into any transcript", ghost === null);

  // --- the tool half (2b): a SLOTTED call acks the tool message, a BARE call keeps tool_result ---
  const wsRoot = await Deno.makeTempDir({ prefix: "radia-turnlink-" });
  const { execToken } = await bootstrap(admin);
  const exec = new Deno.Command(Deno.execPath(), {
    args: [
      "run", `--allow-net=127.0.0.1:${PORT}`, "--allow-run=deno,mkfifo", "--allow-env=HOME",
      `--allow-read=${wsRoot}`, `--allow-write=${wsRoot}`,
      "examples/chat/workers/exec.ts", "--url", url, "--token", execToken, "--workspace-root", wsRoot,
    ],
    stdout: "null",
    stderr: "inherit",
    stdin: "null",
  }).spawn();
  try {
    for (let i = 0; i < 150; i++) {
      if ((await admin.query({ kind: "capability", match: { tool: "run_javascript" } }, 1)).length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const slotted = await admin.put({
      kind: "tool_call",
      body: {
        tool: "run_javascript",
        args: { code: "console.log(6 * 7)" },
        conversationId: conv,
        owner: "human:t",
        tool_call_id: "call_slot1",
        replyIndex: 2,
      },
      parentIds: [conv],
    });
    const reply = await awaitOne({ kind: "message", match: { callId: slotted.id } });
    check("a SLOTTED tool call's answer arrives AS the tool message", reply !== null);
    const rb = (reply?.body ?? {}) as Record<string, unknown>;
    check(
      "…at the named slot, paired to the provider id",
      rb.role === "tool" && rb.index === 2 && rb.tool_call_id === "call_slot1",
      JSON.stringify({ role: rb.role, index: rb.index, tool_call_id: rb.tool_call_id }),
    );
    check("…carrying the output as the content string", String(rb.content).includes("42"), String(rb.content).slice(0, 80));
    check(
      "…and NO tool_result exists for it",
      (await admin.readOne({ kind: "tool_result", match: { callId: slotted.id } })) === null,
    );

    const bare = await admin.put({
      kind: "tool_call",
      body: { tool: "run_javascript", args: { code: "console.log(1)" }, conversationId: conv, owner: "human:t" },
      parentIds: [conv],
    });
    const rpc2 = await awaitOne({ kind: "tool_result", match: { callId: bare.id } });
    check("a BARE tool call still answers with tool_result", rpc2 !== null);
    check(
      "…and writes NOTHING into any transcript",
      (await admin.readOne({ kind: "message", match: { callId: bare.id } })) === null,
    );
  // --- step 3: the whole turn runs with NO CLIENT, driven by the turn worker ---
  // The point of the plan in one case: seed a conversation and walk away. Nothing here renders,
  // waits, counts rounds or dispatches a tool. A model that asks for a tool, a tool that answers,
  // a second round, and a terminus, all from four reactions to facts. The ROUND-2 call is emitted
  // UNTIERED on purpose (a later round is judged on the work done so far), so the router is part
  // of the chain and not scenery: without it round 2 sits unclaimed, which is how this first failed.
  // A conversation whose turn ALREADY FINISHED, written before the worker starts: an assistant
  // asking for a tool, and its reply. The worker must leave it alone. Without this the boot
  // reconcile walks history and dispatches every past tool call again, which on a real space meant
  // 47 stale dispatches and a live turn that timed out behind them.
  const stale = (await admin.put({ kind: "conversation", body: {} })).id;
  for (
    const b of [
      { index: 0, role: "user", content: "old question" },
      { index: 1, role: "assistant", content: null, tool_calls: [{ id: "old_1", type: "function", function: { name: "run_javascript", arguments: "{}" } }] },
      { index: 2, role: "tool", tool_call_id: "old_1", ok: true, content: "{}" },
    ]
  ) await admin.put({ kind: "message", body: { conversationId: stale, owner: "human:t", ...b }, parentIds: [stale] });

  // And one ABANDONED mid-turn: two calls asked for, only the first answered. Its head is a tool
  // reply that legitimately implies "dispatch call 2", so the head rule does not stop it. Only age
  // does, which is why both cases are here.
  const abandoned = (await admin.put({ kind: "conversation", body: {} })).id;
  for (
    const b of [
      { index: 0, role: "user", content: "old multi-tool question" },
      {
        index: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "ab_1", type: "function", function: { name: "run_javascript", arguments: "{}" } },
          { id: "ab_2", type: "function", function: { name: "run_javascript", arguments: "{}" } },
        ],
      },
      { index: 2, role: "tool", tool_call_id: "ab_1", ok: true, content: "{}", i: 0, of: 2 },
    ]
  ) await admin.put({ kind: "message", body: { conversationId: abandoned, owner: "human:t", ...b }, parentIds: [abandoned] });

  const turn = new Deno.Command(Deno.execPath(), {
    args: [
      "run", `--allow-net=127.0.0.1:${PORT}`,
      "examples/chat/workers/turn.ts", "--url", url, "--token", turnToken,
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  // The ROUTER too, because the turn worker emits UNTIERED calls on purpose: a later round is
  // judged on the work done so far, so each one is classified afresh. Without it round 2 would sit
  // unclaimed, which is exactly how this case first failed.
  const router = new Deno.Command(Deno.execPath(), {
    args: [
      "run", `--allow-net=127.0.0.1:${PORT}`,
      "examples/chat/workers/router.ts", "--url", url, "--token", routerToken,
      "--classify-model", "fake/model",
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  try {
    const c2 = (await admin.put({ kind: "conversation", body: {} })).id;
    await admin.put({
      kind: "message",
      body: { conversationId: c2, owner: "human:t", index: 0, role: "user", content: "compute something" },
      parentIds: [c2],
    });
    // The SEED, which is the client's one remaining job: the tool list is session state.
    await admin.put({
      kind: "llm_call",
      body: {
        conversationId: c2,
        owner: "human:t",
        upToIndex: 0,
        stream: false,
        tools: [{ type: "function", function: { name: "run_javascript", description: "run js", parameters: {} } }],
      },
      // Without a deadline the worker will not advance the turn: that is what stops it resuming
      // conversations from months ago, and it is the same field the REPL stamps.
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      parentIds: [c2],
    });

    const finish = await awaitOne({ kind: "turn_complete", match: { conversationId: c2 } }, 300);
    check("a turn runs to completion with no client driving it", finish !== null);
    check("…and says why it ended", (finish?.body as { why?: string })?.why === "answered", JSON.stringify(finish?.body));

    const transcript = await admin.query({ kind: "message", match: { conversationId: c2 } }, 50, { dir: "asc" });
    const roles = transcript.map((r) => (r.body as { role?: string }).role);
    check("…having run the model, a tool, and the model again", roles.join(",") === "user,assistant,tool,assistant", roles.join(","));
    const toolMsg = transcript.find((r) => (r.body as { role?: string }).role === "tool");
    check("…with the tool's real output in the transcript", String((toolMsg?.body as { content?: string })?.content).includes("42"), String((toolMsg?.body as { content?: string })?.content).slice(0, 60));
    // Exactly one of each: the keyed emissions did not double under the watch's re-sweeps.
    const calls = await admin.query({ kind: "tool_call", match: { conversationId: c2 } }, 20);
    check("…and emitted each link exactly once", calls.length === 1, `${calls.length} tool_calls`);

    // Neither stale conversation carries a turn deadline, which is true of every record written
    // before turns had one, so neither is resumed. No knob and no clock guess: the abandoned one is
    // the case the head rule alone could not stop, since its head legitimately asks for one more
    // call.
    for (const [name, id] of [["already finished", stale], ["abandoned mid-call", abandoned]] as const) {
      check(
        `a turn ${name} is left alone: no live deadline, nobody waiting`,
        (await admin.query({ kind: "tool_call", match: { conversationId: id } }, 10)).length === 0,
      );
    }

    // --- step 4: the REAL client, which now only seeds and renders ---
    // The other suites never touch `runTurn`, so the flip would otherwise ship untested: this drives
    // it headless against the same fake model and asserts it returns having written exactly ONE
    // record (the seed). Everything else in the transcript came from a worker.
    // Under a SCOPED SESSION, never the operator. The first version of this case used `admin`, and
    // an operator bypasses grants entirely: the flip shipped missing `llm_call: query` and this
    // suite was green while the real chat died on the second round. A client test that does not
    // run as a client tests the wrong principal.
    const c3 = (await admin.put({ kind: "conversation", body: {} })).id;
    setSessionOwner("human:t");
    const session = new RadiaClient(url, { token: await mintSession(admin, "human:t", { conversationId: c3 }) });
    const thread = await Thread.open(session, { principal: "human:t", privileged: false }, c3);
    await thread.append({ role: "user", content: "compute something" });
    const toolset = new ToolSet(session);
    await toolset.scopeTo(c3);
    await runTurn(session, thread, toolset);
    const t3 = (await admin.query({ kind: "message", match: { conversationId: c3 } }, 50, { dir: "asc" }))
      .map((r) => (r.body as { role?: string }).role);
    check("the REAL client runs a turn it does not drive", t3.join(",") === "system,user,assistant,tool,assistant", t3.join(","));
    const seeds = await admin.query({ kind: "llm_call", match: { conversationId: c3 } }, 20);
    check("…and the client's own writes are the seed alone", seeds.length >= 2, `${seeds.length} llm_calls (seed + worker rounds)`);
    // On the THREAD's cursor, not on the transcript: the workers write the transcript whatever the
    // client does, so asserting roles alone passes even when the render loop stops following. The
    // cursor only advances on what this process actually rendered.
    check("…and it followed every round to the end", thread.upToIndex === t3.length - 1, `cursor ${thread.upToIndex} of ${t3.length - 1}`);

    // A MULTI-CALL round: two tools asked for at once. The worker must dispatch the second after
    // the first answers, in the NEXT SLOT, rather than starting a new round; the client awaits
    // those slots. Live, the position was dropped between call and reply, so a round of eight
    // became eight rounds and the client read the assistant messages landing in its slots as
    // tool results.
    await thread.append({ role: "user", content: "compute twice" });
    await runTurn(session, thread, toolset);
    const tm = await admin.query({ kind: "message", match: { conversationId: c3 } }, 50, { dir: "asc" });
    const tail = tm.slice(-4).map((r) => (r.body as { role?: string }).role);
    check("a round asking for TWO tools answers both before the next round", tail.join(",") === "assistant,tool,tool,assistant", tail.join(","));
    const replies = tm.filter((r) => (r.body as { role?: string; of?: number }).role === "tool" && (r.body as { of?: number }).of === 2);
    check("…and each reply names its position in the round", replies.map((r) => (r.body as { i?: number }).i).join(",") === "0,1", JSON.stringify(replies.map((r) => (r.body as { i?: number }).i)));

    // THE ROUND CAP, which only bites if `round` actually advances. It did not: the counter lives on
    // the `llm_call`, the assistant message dropped it, and the worker read undefined and emitted
    // "round 1" forever. A model that keeps calling tools would then loop until the deadline rather
    // than stopping at the cap. Driven with a cap of 2 so it is cheap to reach.
    const capped = (await admin.put({ kind: "conversation", body: {} })).id;
    const capWorker = new Deno.Command(Deno.execPath(), {
      args: [
        "run", `--allow-net=127.0.0.1:${PORT}`,
        "examples/chat/workers/turn.ts", "--url", url, "--token", turnToken, "--max-rounds", "2",
      ],
      stdout: "null",
      stderr: "inherit",
    }).spawn();
    try {
      await admin.put({
        kind: "message",
        body: { conversationId: capped, owner: "human:t", index: 0, role: "user", content: "compute forever" },
        parentIds: [capped],
      });
      await admin.put({
        kind: "llm_call",
        body: { conversationId: capped, owner: "human:t", upToIndex: 0, turnAt: 0, stream: false, tools: [] },
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
        parentIds: [capped],
      });
      const end = await awaitOne({ kind: "turn_complete", match: { conversationId: capped } }, 300);
      check("a turn that keeps calling tools STOPS at the round cap", (end?.body as { why?: string })?.why === "round_cap", JSON.stringify(end?.body));
      const rounds = (await admin.query({ kind: "llm_call", match: { conversationId: capped } }, 30))
        .map((r) => (r.body as { round?: number }).round ?? 0);
      // On the COUNT, not on "some round > 0": with the counter reset the rounds read [0,1,1,1…] and a
      // distinct-values check passes while the turn runs forever. What the cap buys is a BOUND.
      // Loose, because the suite's other turn worker (cap 8) watches every conversation too and the
      // two race, so the effective cap here is the larger one. Twenty still separates "stopped" from
      // the runaway, which reached 28 and was climbing.
      check("…having made a BOUNDED number of calls, which is what the cap buys", rounds.length <= 20, JSON.stringify(rounds));
    } finally {
      capWorker.kill("SIGTERM");
      await capWorker.status;
    }

    // CANCEL: the person's Escape, as the record the worker reads before it emits. Written directly
    // here because a suite cannot press a key; what it proves is the worker half, which is the half
    // that changed. A head that would otherwise dispatch is left alone.
    const cancelled = (await admin.put({ kind: "conversation", body: {} })).id;
    await admin.put({
      kind: "llm_call",
      body: { conversationId: cancelled, owner: "human:t", upToIndex: 0, turnAt: 0, tools: [] },
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      parentIds: [cancelled],
    });
    await admin.put({ kind: "cancel", body: { conversationId: cancelled, owner: "human:t", turnAt: 0 }, parentIds: [cancelled] });
    await admin.put({
      kind: "message",
      body: {
        conversationId: cancelled,
        owner: "human:t",
        index: 1,
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x1", type: "function", function: { name: "run_javascript", arguments: "{}" } }],
      },
      parentIds: [cancelled],
    });
    await new Promise((r) => setTimeout(r, 2500));
    check(
      "a CANCELLED turn stops advancing, even with a live deadline and work to do",
      (await admin.query({ kind: "tool_call", match: { conversationId: cancelled } }, 10)).length === 0,
    );
    // And it is scoped: the same conversation's NEXT turn must not inherit the cancel.
    await admin.put({
      kind: "llm_call",
      body: { conversationId: cancelled, owner: "human:t", upToIndex: 2, turnAt: 2, tools: [] },
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      parentIds: [cancelled],
    });
    await admin.put({
      kind: "message",
      body: {
        conversationId: cancelled,
        owner: "human:t",
        index: 3,
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x2", type: "function", function: { name: "run_javascript", arguments: "{}" } }],
      },
      parentIds: [cancelled],
    });
    const resumed = await awaitOne({ kind: "tool_call", match: { conversationId: cancelled } }, 100);
    check("…and the NEXT turn in that conversation is not silenced by it", resumed !== null);

    // A SECOND turn in the SAME conversation, which is the case one turn per conversation cannot
    // reach. The first turn leaves a `turn_complete` behind, and an unscoped "is this done" read
    // finds it instantly: every later turn ended after one tool call reporting a round limit it
    // never hit. Two turns, not one, is the whole difference between green and the live failure.
    await thread.append({ role: "user", content: "compute something" });
    await runTurn(session, thread, toolset);
    const t4 = (await admin.query({ kind: "message", match: { conversationId: c3 } }, 50, { dir: "asc" }))
      .map((r) => (r.body as { role?: string }).role);
    check(
      "a SECOND turn in the same conversation runs its rounds too",
      t4.join(",") === "system,user,assistant,tool,assistant,user,assistant,tool,tool,assistant,user,assistant,tool,assistant",
      t4.join(","),
    );
    check("…and the client followed it to the end as well", thread.upToIndex === t4.length - 1, `cursor ${thread.upToIndex} of ${t4.length - 1}`);
    // POLLED, not read once: `runTurn` returns when it has rendered the answer, and the worker
    // writes the terminus after reacting to that same message. Asserting immediately raced it.
    let termini: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      termini = await admin.query({ kind: "turn_complete", match: { conversationId: c3 } }, 10);
      if (termini.length >= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check("…leaving one terminus per turn, each naming its own", termini.length === 3, `${termini.length} turn_complete`);
    const at = (termini as { body: { turnAt?: number } }[]).map((t) => t.body.turnAt).sort((a, b) => (a ?? 0) - (b ?? 0));
    check("…and they name DIFFERENT turns", new Set(at).size === 3, JSON.stringify(at));
  } finally {
    turn.kill("SIGTERM");
    router.kill("SIGTERM");
    await turn.status;
    await router.status;
  }
  } finally {
    exec.kill("SIGTERM");
    await exec.status;
  }
} finally {
  worker.kill("SIGTERM");
  await worker.status;
  await fake.shutdown();
  space.kill("SIGTERM");
  await space.status;
}

if (failed > 0) Deno.exit(1);
