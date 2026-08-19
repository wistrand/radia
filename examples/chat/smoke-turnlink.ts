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
import { __captureOutput, __useStatusLine, terminalUI } from "./client/terminal.ts";
import { installUI } from "./client/ui.ts";

installUI(terminalUI); // this suite captures what the terminal draws during a real turn

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
  // "narrate": stream a sentence, go QUIET past the client's threshold, then ask for a tool. The
  // shape a deep model has live: minutes of tool-argument composition after its last visible token.
  if (last.role === "user" && (last.content ?? "").includes("narrate")) {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        // TWO deltas, spaced past the provider client's 150ms coalescing flush: a lone first delta
        // is held until the NEXT event arrives, which would deliver the text and the tool call
        // together and erase the very quiet stretch this case exists to show.
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Thinking it " } }] })}\n`));
        await new Promise((r) => setTimeout(r, 250));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "through... " } }] })}\n`));
        await new Promise((r) => setTimeout(r, 3_400));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call(0)] } }] })}\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n`));
        c.enqueue(enc.encode("data: [DONE]\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
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
        turnAt: 0,
        round: 0,
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
    // Captured so the LAYOUT is checked, not just the records. A tool-heavy turn was spending three
    // blank lines per round, and a round's tier and its cost each took a line of their own.
    // The status line is ON for this capture. It erases and redraws (`\r\x1b[2K` + prefix), and both
    // calls are no-ops off a terminal, so with plain piped output a redraw that wipes the wrong
    // thing is invisible: a deferred label erased the `assistant> ` in front of it and this very
    // check stayed green. Replayed below the way a terminal would.
    __useStatusLine(true);
    const drawn = __captureOutput();
    await runTurn(session, thread, toolset);
    const painted = drawn.text();
    drawn.stop();
    __useStatusLine(false);
    // A terminal, in ten lines: `\r` returns to column 0, `\x1b[2K` clears, `\n` commits.
    const lines: string[] = [];
    let cur = "", col = 0;
    for (const ch of painted.replace(/\x1b\[2K/g, "\u0000")) {
      if (ch === "\n") { lines.push(cur); cur = ""; col = 0; }
      else if (ch === "\r") col = 0;
      else if (ch === "\u0000") { cur = ""; col = 0; }
      else { cur = cur.slice(0, col) + ch + cur.slice(col + 1); col++; }
    }
    lines.push(cur);
    const body = lines.slice(lines.findIndex((l) => l.includes("assistant>")));
    check(
      "a turn draws no blank lines inside itself",
      !body.slice(0, -1).some((l) => l.trim() === ""),
      JSON.stringify(body.map((l) => l.slice(0, 24))),
    );
    // The round that only called a tool: its label shares the prompt's line rather than sitting
    // under a dangling `assistant>`.
    // EVERY round, not just the first: the erasure only hit the streamed round, so checking one
    // line passed while the bug was on screen. A label must never begin a line — a line starting
    // with `[` is one whose `assistant> ` was wiped by the status redraw.
    const orphaned = body.filter((l) => l.startsWith("["));
    check("…and no round's label lost its prompt to the redraw", orphaned.length === 0, JSON.stringify(orphaned));

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
        body: { conversationId: capped, owner: "human:t", upToIndex: 0, turnAt: 0, round: 0, stream: false, tools: [] },
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

    // A WATCH OUTLIVES ITS RUN, and the worker must not die with it. A run lasts fifteen minutes; the
    // SDK mints another for ordinary calls, but the SSE stream opened under the old one is REVOKED
    // with `credential_invalid`. Unsupervised, that threw out of the watch loop and killed the whole
    // turn worker, stopping every conversation on the space; the only sign was one stack trace.
    const turnRuns = await admin.query({ kind: "agent_run", match: { agent: "agent:chat-turn" } }, 10, { dir: "desc" });
    const turnRun = (turnRuns[0]?.body as { run?: string } | undefined)?.run;
    check("the turn worker minted its own run", !!turnRun, String(turnRun));
    if (turnRun) {
      await admin.stopRun(turnRun);
      await new Promise((r) => setTimeout(r, 1500)); // let the revocation reach the stream
      const revived = (await admin.put({ kind: "conversation", body: {} })).id;
      await admin.put({
        kind: "message",
        body: { conversationId: revived, owner: "human:t", index: 0, role: "user", content: "compute something" },
        parentIds: [revived],
      });
      await admin.put({
        kind: "llm_call",
        body: { conversationId: revived, owner: "human:t", upToIndex: 0, turnAt: 0, round: 0, stream: false, tools: [] },
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
        parentIds: [revived],
      });
      const after = await awaitOne({ kind: "turn_complete", match: { conversationId: revived } }, 300);
      check("…and it keeps advancing turns after that run is STOPPED under its watch", after !== null);
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

    // A TURN IS A SUBTREE, which is what makes one turn openable on its own. Every link parents to
    // the record that caused it, so descending from a turn's seed `llm_call` reaches that turn and
    // stops. Parented to the conversation instead, each round is a stub off one hub and the walk
    // from any member returns every turn in the conversation: measured live at 83 of 185 records
    // naming the conversation directly, and a 346-record thread rendered as a capped 150.
    // WHAT A DEFAULT SESSION CAN SEE OF THE FLEET. This suite scopes by `conversationId`, and the
    // chat's default is `identity` (`{owner}`) — the posture under which a worker that forgets to
    // stamp `owner` becomes invisible, because a grant narrows the answer instead of failing. The
    // router did exactly that: the chat never saw a routing record, so it had no liveness signal and
    // its timeout blamed a missing fleet for a call the router had already claimed.
    const byIdentity = new RadiaClient(url, { token: await mintSession(admin, "human:t", { owner: "human:t" }) });
    const seenStages = new Set(
      (await byIdentity.query({ kind: "progress", match: { conversationId: c3 } }, 100))
        .map((r) => String((r.body as { stage?: string }).stage)),
    );
    for (const stage of ["routing", "routed", "generating"]) {
      check(`an identity-scoped session sees '${stage}' progress`, seenStages.has(stage), [...seenStages].join(",") || "none");
    }

    const turnOf = (b: unknown) => (b as { turnAt?: number }).turnAt;
    // Every record of the conversation that names a turn, by turn. Grouped client-side on purpose:
    // this is the EXPECTATION the subtree is checked against, so deriving it from the same matching
    // the feature relies on would let one bug satisfy both sides.
    const byTurn = new Map<number, Set<string>>();
    for (const kind of ["message", "llm_call", "tool_call", "turn_complete"]) {
      for (const r of await admin.query({ kind, match: { conversationId: c3 } }, 200)) {
        const t = turnOf(r.body);
        if (t === undefined) continue;
        (byTurn.get(t) ?? byTurn.set(t, new Set()).get(t)!).add(r.id);
      }
    }
    // "the tool calls of THIS turn" is one indexed query, not a walk down children. It was rejected
    // as `undeclared_path` until `turnAt` was declared on `tool_call`, though the dispatcher had
    // been writing it all along: a body field its kind does not declare is invisible to matching.
    for (const [t, ids] of byTurn) {
      const viaQuery = await admin.query({ kind: "tool_call", match: { conversationId: c3, turnAt: t } }, 50);
      const viaBody = [...ids].length; // the grouping above already knows the answer
      const expected = (await admin.query({ kind: "tool_call", match: { conversationId: c3 } }, 200))
        .filter((r) => turnOf(r.body) === t).length;
      check(
        `tool calls of turn ${t} are reachable by query`,
        viaQuery.length === expected && expected > 0,
        `${viaQuery.length} matched, ${expected} carry turnAt=${t} (of ${viaBody} records in the turn)`,
      );
    }

    // The head of a turn is its FIRST untiered `llm_call`: the client's seed. Later rounds are
    // untiered too (the router adds the tier), so they are grouped out by turnAt rather than by a
    // round number, which `llm_call` does not declare as an indexed path.
    const untiered = await admin.query(
      { kind: "llm_call", match: { conversationId: c3, tier: { $exists: false } } },
      50,
      { dir: "asc" },
    );
    // FIRST per turn, and `new Map(entries)` would give the last: that picked each turn's final
    // round as its head, whose subtree is legitimately just the closing answer.
    const heads = new Map<number, typeof untiered[number]>();
    for (const r of untiered) if (!heads.has(turnOf(r.body)!)) heads.set(turnOf(r.body)!, r);
    const turnHeads = [...heads.values()];
    check("each turn has one seed call", turnHeads.length === 3, `${turnHeads.length} seeds`);

    let covered = 0, leaked = 0;
    for (const seed of turnHeads) {
      const mine = turnOf(seed.body)!;
      const want = byTurn.get(mine) ?? new Set<string>();
      const sub = await admin.graph(seed.id, { direction: "down", excludeKinds: ["llm_chunk", "progress"] });
      const got = new Set(sub.nodes.map((n) => n.id));
      // COVERAGE is the property, and it is the one that fails when a round parents to the
      // conversation: descending from the seed then reaches round 0's call chain and stops, which
      // an "is the subtree bigger than the seed" check happily passes.
      const missing = [...want].filter((id) => !got.has(id));
      if (missing.length === 0) covered++;
      else {
        const kinds = [];
        for (const id of missing) {
          const r = await admin.getRecord(id);
          kinds.push(`${r?.kind}:${(r?.body as {role?: string}).role ?? ""}:${id.slice(-4)}<-[${(r?.runtimeMeta.parentIds ?? []).map((x) => x.slice(-4)).join(",")}]`);
        }
        // Parents are in the detail because they name the fault: every unreachable record pointing
        // at the same id means the chain went back to the conversation instead of to its cause.
        check(`turn ${mine} subtree is complete`, false, `${missing.length}/${want.size} unreachable: ${kinds.join(" ")}`);
      }
      for (const n of sub.nodes) {
        const t = turnOf((await admin.getRecord(n.id))?.body);
        if (t !== undefined && t !== mine) leaked++;
      }
    }
    check("a turn's every record is reachable from its seed", covered === 3, `${covered}/3 turns are a complete subtree`);
    check("…and no other turn's records are", leaked === 0, `${leaked} records leaked in from another turn`);
    // ---- a QUIET stretch while composing a tool call is visibly alive ----
    // The status pump used to stop for good at the first streamed token, so everything a model
    // wrote AFTER its last visible word — tool arguments, minutes of them — was a dead screen,
    // read live as a hang, with the deadline's liveness signal frozen under a worker that was
    // heartbeating normally. After STREAM_QUIET_MS the status row must return beneath the text.
    const c4 = (await admin.put({ kind: "conversation", body: {} })).id;
    const session4 = new RadiaClient(url, { token: await mintSession(admin, "human:t", { conversationId: c4 }) });
    const thread4 = await Thread.open(session4, { principal: "human:t", privileged: false }, c4);
    await thread4.append({ role: "user", content: "narrate then work" });
    const tools4 = new ToolSet(session4);
    await tools4.scopeTo(c4);
    __useStatusLine(true);
    const drawn4 = __captureOutput();
    await runTurn(session4, thread4, tools4);
    const painted4 = drawn4.text();
    drawn4.stop();
    __useStatusLine(false);
    const spoke = painted4.indexOf("Thinking it through");
    check("the narrated text streamed before the pause", spoke >= 0);
    check(
      "…and the quiet stretch shows the worker's status, not a dead screen",
      /\x1b\[2K[^\n]*generating/.test(painted4.slice(spoke)),
      JSON.stringify(painted4.slice(spoke, spoke + 160)),
    );
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
