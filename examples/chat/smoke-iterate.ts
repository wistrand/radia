// The code-generation loop as records: attempts that link, and verdicts the model cannot author.
//
//   deno run -A examples/chat/smoke-iterate.ts
//
// Real LLM code generation is iterative: write, run, read the error, fix, rerun. Two things about
// that loop had no representation in the space.
//
// ATTEMPTS DID NOT LINK. Every `tool_call` parented to the conversation, so eight tries were eight
// siblings with no ordering and no causality. Lineage from the last one said nothing about the
// seven before it, and "how did this end up working" could only be reconstructed from the
// transcript, which is the thing records exist to replace.
//
// A PASS WAS THE MODEL'S OPINION. Nothing expressed what the code was supposed to do, so
// "it works" was prose sitting next to output only the model had read. An `expect` states the
// success condition BEFORE the run; the exec-worker judges it and writes a `check`. The session has
// no grant to put one, which is the entire point: a verdict is evidence, not a claim.
//
// No model and no API key: a tool_call is a record, so the loop can be driven directly.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, mintSession, userGrants } from "./space/roles.ts";

const PORT = 7811;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let admin: RadiaClient;
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
admin = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(admin);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const conv = (await admin.put({ kind: "conversation", body: { title: "iterate" } })).id;
const OWNER = "agent:chat-user";

// The exec-worker, running for real: it is what judges a run, and the point of this suite is that
// the verdict comes from the process that executed the code.
const tokens = await bootstrap(admin, { conversationId: conv });
const wsRoot = Deno.makeTempDirSync({ prefix: "radia-ws-" });
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-run=deno",
    "--allow-env=HOME",
    // A procedure is a WORKSPACE now, so every call materialises a tree and the worker needs
    // somewhere to put it. fleet.ts has always done this; these launchers predate the change.
    `--allow-write=${wsRoot}`,
    `--allow-read=${wsRoot}`,
    "examples/chat/workers/exec.ts",
    "--workspace-root",
    wsRoot,
    "--url",
    url,
    "--token",
    tokens.execToken,
  ],
  stdout: "null",
  stderr: "inherit",
  stdin: "null",
}).spawn();
for (let i = 0; i < 100; i++) {
  if ((await admin.query({ kind: "capability", match: { tool: "run_javascript" } }, 1)).length > 0) break;
  await new Promise((r) => setTimeout(r, 200));
}

/** Drive one attempt the way `turn.ts` does, and wait for the worker to settle it. */
async function attempt(
  code: string,
  opts: { attempt: number; retryOf?: string; expect?: Record<string, unknown> } = { attempt: 1 },
): Promise<{ id: string; output: Record<string, unknown> }> {
  const { id } = await admin.put({
    kind: "tool_call",
    body: {
      tool: "run_javascript",
      args: { code, ...(opts.expect ? { expect: opts.expect } : {}) },
      conversationId: conv,
      owner: OWNER,
      attempt: opts.attempt,
      ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    },
    parentIds: opts.retryOf ? [conv, opts.retryOf] : [conv],
  });
  for (let i = 0; i < 150; i++) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
    if (r) return { id, output: (r.body as { output: Record<string, unknown> }).output };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no tool_result");
}

// ── a debugging session: broken, still broken, working ───────────────────────────────────────────
const a1 = await attempt("console.log(1 +)", { attempt: 1, expect: { exit_zero: true, stdout_equals: "2" } });
check("attempt 1 fails to run", (a1.output.exitCode as number) !== 0, `exit ${a1.output.exitCode}`);
check("…and the verdict says so", (a1.output.check as { verdict: string })?.verdict === "fail");

const a2 = await attempt("console.log(1 + 2)", { attempt: 2, retryOf: a1.id, expect: { exit_zero: true, stdout_equals: "2" } });
check("attempt 2 runs but is WRONG", (a2.output.exitCode as number) === 0);
check("…and the verdict catches what the exit code cannot", (a2.output.check as { verdict: string })?.verdict === "fail");
check(
  "…naming the clause that missed",
  ((a2.output.check as { reasons: string[] })?.reasons ?? []).some((r) => /stdout did not equal/.test(r)),
  JSON.stringify((a2.output.check as { reasons: string[] })?.reasons),
);

const a3 = await attempt("console.log(1 + 1)", { attempt: 3, retryOf: a2.id, expect: { exit_zero: true, stdout_equals: "2" } });
check("attempt 3 passes", (a3.output.check as { verdict: string })?.verdict === "pass", JSON.stringify(a3.output.check));

// ── 1. the attempts are a chain, not a pile ──────────────────────────────────────────────────────
// This is what the transcript used to be the only record of.
const lineage = await admin.getLineage(a3.id);
const ids = lineage.map((n) => n.record.id);
check("lineage from the last attempt reaches the first", ids.includes(a1.id) && ids.includes(a2.id), `${ids.length} records`);
check("…and the conversation, so the chain is anchored", ids.includes(conv));

const chain = await admin.query(
  { kind: "tool_call", match: { conversationId: conv, tool: "run_javascript" }, orderBy: [{ path: "attempt", dir: "asc" }] },
  50,
);
check("the chain reads in attempt order", chain.map((r) => (r.body as { attempt: number }).attempt).join(",") === "1,2,3");
check("…and each retry names the one it replaces", (chain[2].body as { retryOf: string }).retryOf === a2.id);
// "How many tries did this take" is a count, not a graph walk.
check("the last attempt knows it was the third", (chain[2].body as { attempt: number }).attempt === 3);

// ── 2. a verdict is evidence, not a claim ────────────────────────────────────────────────────────
const checks = await admin.query({ kind: "check", match: { conversationId: conv } }, 50);
check("one check per attempt that stated an expectation", checks.length === 3, `${checks.length}`);
check(
  "failures are one query, which is the question an auditor asks",
  (await admin.query({ kind: "check", match: { conversationId: conv, verdict: "fail" } }, 50)).length === 2,
);
const passing = checks.find((r) => (r.body as { verdict: string }).verdict === "pass");
check("a check records what was CLAIMED, not just the outcome", JSON.stringify((passing?.body as { expected: unknown }).expected).includes("stdout_equals"));
check("…and hangs off the attempt it judges", (passing?.runtimeMeta.parentIds ?? []).includes(a3.id));
// Written by the worker's principal, so `created_by` names who observed it.
check("…and is attributed to the worker that ran the code", String(passing?.runtimeMeta.createdBy).startsWith("run:"), String(passing?.runtimeMeta.createdBy));

// THE property. If a session could write one of these, a verdict would be the model grading itself,
// which is what prose already does.
const session = new RadiaClient(url, { token: await mintSession(admin, OWNER, { conversationId: conv }) });
check("the session may READ verdicts", (await session.query({ kind: "check", match: { conversationId: conv } }, 50)).length === 3);
let forged = "wrote it";
try {
  await session.put({ kind: "check", body: { callId: a1.id, conversationId: conv, owner: OWNER, verdict: "pass" } });
} catch (e) {
  forged = (e as Error).message;
}
check("…but cannot WRITE one", forged !== "wrote it", forged);
check(
  "…which is enforced by the grant list, not by convention",
  !userGrants({ conversationId: conv }).some((g) => g.kind === "check" && g.operations.includes("put")),
);

// ── no expectation means NO verdict, never a passing one ─────────────────────────────────────────
// An unverified run must look unverified. Defaulting to "pass" would make the whole kind worthless:
// every legacy call would read as checked.
const plain = await attempt("console.log('no claim made')", { attempt: 1 });
check("a run with no expectation returns no verdict", plain.output.check === undefined);
check(
  "…and writes no check record",
  (await admin.query({ kind: "check", match: { callId: plain.id } }, 5)).length === 0,
);

// A timeout must not satisfy exit_zero: a killed process has a null exit code, and reading that as
// zero would turn the worst outcome into a pass.
const killed = await attempt("while(true){}", { attempt: 1, expect: { exit_zero: true } });
check("a timeout fails an exit_zero expectation", (killed.output.check as { verdict: string })?.verdict === "fail", JSON.stringify(killed.output.check));

try {
  worker.kill();
  await worker.status;
} catch { /* already gone */ }
space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
