// Saved procedures, end to end, with NO MODEL in the loop:
//
//   deno run -A examples/chat/smoke-procedures.ts
//
// A tool call is just a record, so every step the assistant would take here can be taken directly
// — which makes the whole save/run/read path testable without an OPENROUTER_API_KEY. It spawns its
// own space and exec-worker on port 7799 and cleans them up.
//
// This is a script, not a `*.test.ts`: it is not part of `deno task conformance` (that suite is for
// PORT contracts, not for an example). Run it after changing the exec worker.
import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap } from "./space/roles.ts";
import { ToolSet } from "./client/turn.ts";

const PORT = 7799;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const admin = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await admin.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

await registerChatKinds(admin);
const { execToken } = await bootstrap(admin, "admin");

const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--allow-net=127.0.0.1:${PORT}`,
    "--allow-run=deno",
    "--allow-env=HOME",
    "examples/chat/workers/exec.ts",
    "--url",
    url,
    "--token",
    execToken,
    "--timeout-ms",
    "5000",
  ],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const convA = (await admin.put({ kind: "conversation", body: { title: "A" } })).id;
const convB = (await admin.put({ kind: "conversation", body: { title: "B" } })).id;

async function callTool(tool: string, args: unknown, conversationId: string, timeoutMs = 20_000) {
  const { id } = await admin.put({ kind: "tool_call", body: { tool, args, conversationId }, parentIds: [conversationId] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
    if (r) return r.body as { ok: boolean; output: unknown };
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`no tool_result for ${tool} within ${timeoutMs}ms`);
}

const check = (label: string, pass: boolean, detail = "") => console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);

// 1. Save a procedure.
const saved = await callTool("save_procedure", {
  name: "add_nums",
  description: "Add args.a and args.b, print the sum.",
  code: "console.log(args.a + args.b);",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
}, convA);
check("save_procedure succeeds", saved.ok, JSON.stringify(saved.output).slice(0, 90));

// 2. The code is an artifact, and the record points at it.
const procs = await admin.query({ kind: "procedure", match: { name: "add_nums", conversationId: convA } }, 10);
const body = procs[0]?.body as { artifactId?: string } | undefined;
check("a procedure record exists, scoped to the conversation", procs.length === 1);
const source = body?.artifactId ? new TextDecoder().decode(await admin.getArtifact(body.artifactId)) : "";
check("its code is stored as an artifact", source.includes("console.log(args.a + args.b)"));

// 3. Call it by name — the args reach the code.
const ran = await callTool("add_nums", { a: 2, b: 40 }, convA);
const out = ran.output as { stdout?: string };
check("calling it by name runs the saved code with args", ran.ok && out.stdout?.trim() === "42", `stdout=${JSON.stringify(out.stdout)}`);

// 4. Re-saving the same name replaces it (successor, latest wins) rather than 409ing.
const resaved = await callTool("save_procedure", {
  name: "add_nums",
  description: "Add args.a and args.b, print the sum, doubled.",
  code: "console.log((args.a + args.b) * 2);",
}, convA);
const ran2 = await callTool("add_nums", { a: 2, b: 40 }, convA);
check("re-saving a name replaces it", resaved.ok && (ran2.output as { stdout?: string }).stdout?.trim() === "84");

// 5. THE BOUNDARY: another conversation cannot run it, even naming it exactly.
const other = await callTool("add_nums", { a: 1, b: 1 }, convB);
check("another conversation is refused", !other.ok, String(other.output).slice(0, 70));

// 6. Reading it back: what "improve a procedure" depends on.
const read = await callTool("read_procedure", { name: "add_nums" }, convA);
const rb = read.output as { code?: string; versions?: number; description?: string };
check("read_procedure returns the current source", read.ok && rb.code?.includes("* 2") === true, `versions=${rb.versions}`);
check("every version is kept (immutable records)", rb.versions === 2);

// 7. Reading another conversation's procedure is refused, same boundary as running it.
const readOther = await callTool("read_procedure", { name: "add_nums" }, convB);
check("read_procedure honours the conversation boundary", !readOther.ok, String(readOther.output).slice(0, 60));

// NOTE: a name that was never saved anywhere has no claim template, so no worker takes it and the
// chat surfaces it through its existing "no worker serves X" stall path. That is the same
// behaviour as calling any nonexistent tool, so there is nothing procedure-specific to assert.

// 8. Discovery: the real ToolSet, driven against the real space. This is the projection under
//    test, not a reimplementation of it.
const tools = new ToolSet(admin);
await tools.scopeTo(convA);
const named = () => tools.all().map((t) => t.function.name);
check("a saved procedure is offered as a tool", named().includes("add_nums"));
check("the built-ins are still there", named().includes("run_code") && named().includes("save_procedure"));

const toolsB = new ToolSet(admin);
await toolsB.scopeTo(convB);
check("and only to the conversation that saved it", !toolsB.all().some((t) => t.function.name === "add_nums"));

// 9. Retire it: stop offering it, without erasing it.
const retired = await callTool("retire_procedure", { name: "add_nums", reason: "superseded" }, convA);
check("retire_procedure succeeds", retired.ok, JSON.stringify(retired.output).slice(0, 60));
await tools.scopeTo(convA);
check("a retired procedure is no longer offered", !named().includes("add_nums"));
check("retiring does not disturb the built-ins", named().includes("run_code"));

const afterRetire = await callTool("add_nums", { a: 1, b: 1 }, convA);
check("calling a retired procedure is refused, promptly", !afterRetire.ok, String(afterRetire.output).slice(0, 60));

const readRetired = await callTool("read_procedure", { name: "add_nums" }, convA);
check("but its code is still readable — retire is not delete", readRetired.ok);
check("retiring twice is refused", !(await callTool("retire_procedure", { name: "add_nums" }, convA)).ok);

// 10. Saving the name again brings it back: the successor is newer, so latest-wins un-retires it
//     with no un-retire path needed.
const revived = await callTool("save_procedure", {
  name: "add_nums",
  description: "Add args.a and args.b.",
  code: "console.log(args.a + args.b);",
}, convA);
check("re-saving a retired name revives it", revived.ok);
await tools.scopeTo(convA);
check("and it is offered again", named().includes("add_nums"));
const ran3 = await callTool("add_nums", { a: 20, b: 22 }, convA);
check("and it runs again", ran3.ok && (ran3.output as { stdout?: string }).stdout?.trim() === "42");

try {
  worker.kill();
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
