// The harness-worker contract (extensions/ts/harness-worker.ts): a member run as a worker launches
// a harness per claim and every way the harness can end maps to one settlement. Driven with a
// harness that has no model (`fake-harness.ts`), the way the lab proves its plumbing, since the
// thing under test is the loop, the prompt, the shared claim and the kill, not a model's judgement.
import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { addMember, declareTeamKinds } from "../ts/team.ts";
import { digestLine, type HarnessRun, learnCodexThread, renderPrompt, runHarnessMember } from "../ts/harness-worker.ts";
import { bootSpace, uniq } from "./space.ts";

const admin = await bootSpace(7877);
await declareTeamKinds(admin);
const fixture = new URL("./fake-harness.ts", import.meta.url).pathname;

async function member(team: string): Promise<{ agent: string; client: RadiaClient; token: string }> {
  const agent = `agent:${uniq("hw")}`;
  const { definitionToken } = await addMember(admin, agent, { teams: [team] });
  const client = new RadiaClient(admin.base, { definitionToken });
  await client.ensureCredential();
  return { agent, client, token: client.bearerToken! };
}

async function runOnce(team: string, mode: string, opts: { timeoutSeconds?: number; leaseSeconds?: number; onSpawned?: (recordId: string) => Promise<void> } = {}) {
  const m = await member(team);
  const { id } = await admin.put({ kind: "task", body: { team, title: `do ${mode}`, tags: ["fake"] } });
  const runs: HarnessRun[] = [];
  const lines: string[] = [];
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);
  await runHarnessMember(m.client, {
    agent: m.agent,
    command: [Deno.execPath(), "run", "-A", fixture],
    prompt: "record {{recordId}} of kind {{kind}} for {{agent}}: {{body}} claim {{claimId}}",
    patterns: [{ kind: "task", match: { team } }],
    leaseSeconds: opts.leaseSeconds ?? 30,
    timeoutSeconds: opts.timeoutSeconds ?? 20,
    concurrency: 1,
    env: { FAKE_MODE: mode, FAKE_TOKEN: m.token, FAKE_TEAM: team },
  }, {
    signal: ac.signal,
    once: true,
    log: (l) => {
      lines.push(l);
      if (opts.onSpawned && /fake harness got/.test(l)) opts.onSpawned(id).catch(() => {});
    },
    onRun: (r) => runs.push(r),
  });
  clearTimeout(timeout);
  const env = (await admin.getEnvelope(id))!;
  return { id, runs, lines, env, agent: m.agent };
}

Deno.test("harness-worker: the harness settles the shared claim itself, and the loop reports it rather than fencing", async () => {
  const team = uniq("t");
  const r = await runOnce(team, "settle");
  assertEquals(r.runs.map((x) => x.outcome), ["settled"]);
  assertEquals(r.env.state, "consumed");
  // The answer rode the ack: a note parented on the task, by the member.
  const notes = await admin.queryNewest<{ answer?: number }>({ kind: "note", match: { team } }, 5);
  assertEquals(notes.length, 1);
  assertEquals(notes[0].body.answer, 42);
  assert(notes[0].runtimeMeta.parentIds.includes(r.id), "the result is parented on the claimed task");
  assert(r.lines.some((l) => l.includes("settled by the handler")), r.lines.join("\n"));
  assert(!r.lines.some((l) => l.includes("duplicate work possible") || l.includes("-> nack")), "the loop neither acks nor nacks a claim the harness settled");
});

Deno.test("harness-worker: a harness that settles and lingers past a heartbeat is not fenced", async () => {
  // The heartbeat's next renewal finds the record consumed and reports lease_lost; that is our own
  // settle, not another owner, so the harness is left to finish and the run is `settled`. The
  // third lab run had this exact sequence read as `fenced` and the harness killed mid-summary.
  const r = await runOnce(uniq("t"), "settle-linger", { leaseSeconds: 3, timeoutSeconds: 20 });
  assertEquals(r.runs.map((x) => x.outcome), ["settled"]);
  assertEquals(r.runs[0].exitCode, 0, "the harness exited on its own");
  assertEquals(r.env.state, "consumed");
  assert(r.lines.some((l) => l.includes("settled by the handler")), r.lines.join("\n"));
  assert(!r.lines.some((l) => l.includes("duplicate work possible") || l.includes("-> nack")), r.lines.join("\n"));
});

Deno.test("harness-worker: the prompt carries the record, its kind, the member and a claim id the adapter recognises", async () => {
  const team = uniq("t");
  const r = await runOnce(team, "exit0");
  const echoed = r.lines.find((l) => /fake harness got \d+ chars/.test(l))!;
  assert(echoed.includes(`record ${r.id}`), echoed);
  assert(new RegExp(`claim claim-${r.id}-\\d+`).test(echoed), echoed);
  assertEquals(renderPrompt("a {{x}} {{y}}", { x: "1" }), "a 1 {{y}}", "an unknown placeholder is left, never blanked");
});

Deno.test("harness-worker: a harness that exits clean without settling is acked by the loop", async () => {
  const r = await runOnce(uniq("t"), "exit0");
  assertEquals(r.runs.map((x) => x.outcome), ["ok"]);
  assertEquals(r.env.state, "consumed");
});

Deno.test("harness-worker: a non-zero exit nacks, and the record is claimable again", async () => {
  const r = await runOnce(uniq("t"), "fail");
  assertEquals(r.runs.map((x) => x.outcome), ["failed"]);
  assertEquals(r.runs[0].exitCode, 3);
  assertEquals(r.env.state, "available");
  assert(r.lines.some((l) => l.includes("-> nack")), r.lines.join("\n"));
});

Deno.test("harness-worker: a harness past its timeout is killed and the record nacked", async () => {
  const r = await runOnce(uniq("t"), "hang", { timeoutSeconds: 2 });
  assertEquals(r.runs.map((x) => x.outcome), ["timeout"]);
  assertEquals(r.runs[0].exitCode, null);
  assert(r.runs[0].durationMs < 15_000, `killed at the timeout, not later: ${r.runs[0].durationMs}ms`);
  assertEquals(r.env.state, "available");
});

Deno.test("harness-worker: a lease lost mid-run kills the harness (a fenced worker stops at the fence)", async () => {
  // The operator DEAD-LETTERS the record while the harness hangs (a live lease cannot be reclaimed,
  // only an expired one): the loop's next heartbeat sees lease_lost, and because the record is
  // terminal rather than settled by us, the handler is fenced and the child dies with it.
  const r = await runOnce(uniq("t"), "hang", { timeoutSeconds: 40, leaseSeconds: 2, onSpawned: async (id) => {
    await admin.admin("dead-letter", id);
  } });
  assertEquals(r.runs.map((x) => x.outcome), ["fenced"]);
  assert(r.runs[0].durationMs < 20_000, `killed at the fence, not the timeout: ${r.runs[0].durationMs}ms`);
  assertEquals(r.env.state, "dead_letter");
});

Deno.test("harness-worker: the digest turns a harness's JSON stream into one line per event", () => {
  assertEquals(digestLine(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "space_ack", arguments: { claimId: "c" } } })), '→ space_ack {"claimId":"c"}');
  assertEquals(digestLine(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", tool: "space_ack", result: {} } })), undefined, "a completed call without an error is the started line's own answer");
  assertEquals(digestLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Ready.  Handed over." } })), "says: Ready. Handed over.");
  assertEquals(digestLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } })), "turn done: 12 in, 3 out");
  assertEquals(digestLine(JSON.stringify({ type: "thread.started" })), undefined);
  assertEquals(digestLine(JSON.stringify({ type: "result", result: "NO TOOLS", total_cost_usd: 0.1169, num_turns: 2 })), "result ($0.117, 2 turns): NO TOOLS");
  assertEquals(digestLine("plain text"), "plain text");
  assertEquals(digestLine(""), undefined);
  assertEquals(digestLine("x".repeat(400))!.length, 160);
});

/** Run one worker over several claims, the fixture's mode chosen per launch, until `modes` runs
 *  out. Returns the digested lines, the runs, and whatever the worker stored as its session. */
async function warmRun(opts: { modes: string[]; firstArgv: string[]; learn?: boolean; thread?: string }) {
  const team = uniq("t");
  const m = await member(team);
  const store: { id?: string } = {};
  for (const mode of opts.modes) await admin.put({ kind: "task", body: { team, title: mode, tags: ["warm"] } });
  const modeFile = `${await Deno.makeTempDir({ prefix: "radia-mode-" })}/mode`;
  let launch = 0;
  const lines: string[] = [];
  const runs: HarnessRun[] = [];
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 90_000);
  await runHarnessMember(m.client, {
    agent: m.agent,
    command: [Deno.execPath(), "run", "-A", fixture, ...opts.firstArgv],
    prompt: "cold {{recordId}}",
    resume: {
      command: [Deno.execPath(), "run", "-A", fixture, "resume", "{{harnessSession}}"],
      prompt: "warm {{recordId}}",
      sessions: { load: () => store.id, save: (id) => { store.id = id; } },
      ...(opts.learn ? { learn: learnCodexThread } : {}),
    },
    patterns: [{ kind: "task", match: { team } }],
    leaseSeconds: 30,
    timeoutSeconds: 20,
    concurrency: 1,
    env: { FAKE_TOKEN: m.token, FAKE_TEAM: team, FAKE_MODE_FILE: modeFile, ...(opts.thread ? { FAKE_THREAD: opts.thread } : {}) },
  }, {
    signal: ac.signal,
    log: (l) => lines.push(l),
    beforeSpawn: async () => {
      await Deno.writeTextFile(modeFile, opts.modes[launch++] ?? "exit0");
    },
    onRun: (r) => {
      runs.push(r);
      if (runs.length === opts.modes.length) setTimeout(() => ac.abort(), 1500);
    },
  });
  clearTimeout(timeout);
  return { lines, runs, store, argv: lines.filter((l) => l.includes("fake harness argv:")) };
}

Deno.test("harness-worker: a warm session is minted on the first launch, resumed on the next, and dropped after a failure", async () => {
  // Three claims in one worker: the first launch runs the first-run command with a fresh id, the
  // second resumes with the resume command and the resume prompt, and after a failed run the id
  // is dropped so the next would start fresh. The fixture stands in for a harness that accepts
  // the id up front (Claude Code's `--session-id`, then `--resume`).
  const r = await warmRun({ modes: ["exit0", "exit0", "fail"], firstArgv: ["first", "{{harnessSession}}"] });
  assertEquals(r.runs.map((x) => x.outcome), ["ok", "ok", "failed"]);
  const first = /argv: first (\S+)/.exec(r.argv[0])!;
  assert(first && /^[0-9a-f-]{36}$/.test(first[1]), `a UUID was minted: ${r.argv[0]}`);
  assert(r.argv[1].includes(`resume ${first[1]}`), `the second launch resumed the same id: ${r.argv[1]}`);
  assert(r.argv[2].includes(`resume ${first[1]}`), `the third launch still resumed it: ${r.argv[2]}`);
  assert(r.lines.some((l) => l.includes(`starting harness session ${first[1]}`)) && r.lines.some((l) => l.includes(`resuming harness session ${first[1]}`)), r.lines.join("\n"));
  assert(r.lines.some((l) => l.includes("harness session dropped after failed")), r.lines.join("\n"));
  assertEquals(r.store.id, undefined, "a failed run drops the session");
});

Deno.test("harness-worker: a harness that reports its own thread id (Codex) has it learned and resumed", async () => {
  const r = await warmRun({ modes: ["exit0", "exit0"], firstArgv: ["first"], learn: true, thread: "thread-from-codex" });
  assertEquals(r.runs.map((x) => x.outcome), ["ok", "ok"]);
  assert(r.argv[1].includes("resume thread-from-codex"), `the learned id was resumed: ${r.argv[1]}`);
  assertEquals(r.store.id, "thread-from-codex");
  assertEquals(learnCodexThread('{"type":"thread.started","thread_id":"abc"}'), "abc");
  assertEquals(learnCodexThread('{"type":"turn.started"}'), undefined);
  assertEquals(learnCodexThread("not json"), undefined);
});

Deno.test("harness-worker: a harness that nacks its claim is reported as settled, and the loop does not ack over it", async () => {
  const r = await runOnce(uniq("t"), "nack");
  assertEquals(r.runs.map((x) => x.outcome), ["settled"]);
  assertEquals(r.env.state, "available", "the nack handed the record back");
  assert(!r.lines.some((l) => l.includes("-> ok") || l.includes("-> nack:")), "the loop neither acked nor nacked a record the harness gave back:\n" + r.lines.join("\n"));
});

Deno.test("harness-worker: a harness that ignores SIGTERM is killed with SIGKILL at the timeout", async () => {
  const started = Date.now();
  const r = await runOnce(uniq("t"), "ignore-term", { timeoutSeconds: 2 });
  assertEquals(r.runs.map((x) => x.outcome), ["timeout"]);
  assertEquals(r.runs[0].exitCode, null);
  assert(r.lines.some((l) => l.includes("ignoring SIGTERM")), r.lines.join("\n"));
  assert(Date.now() - started < 20_000, `dead within the 5s escalation, not the 60s the harness wanted: ${Date.now() - started}ms`);
});

Deno.test("harness-worker: a warm session cannot run concurrent claims", async () => {
  const m = await member(uniq("t"));
  const ac = new AbortController();
  let threw = "";
  try {
    await runHarnessMember(m.client, {
      agent: m.agent,
      command: ["true"],
      prompt: "x",
      resume: { command: ["true"], prompt: "y", sessions: { load: () => undefined, save: () => {} } },
      patterns: [{ kind: "task" }],
      leaseSeconds: 30,
      timeoutSeconds: 5,
      concurrency: 2,
    }, { signal: ac.signal, log: () => {} });
  } catch (e) {
    threw = String(e);
  }
  assert(/one harness session/.test(threw), threw);
});
