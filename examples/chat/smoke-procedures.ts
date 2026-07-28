// Saved procedures, end to end, with NO MODEL in the loop:
//
//   deno run -A examples/chat/smoke-procedures.ts
//
// A tool call is just a record, so every step the assistant would take here can be taken directly.
// That makes the whole save/run/read path testable without an OPENROUTER_API_KEY. It spawns its
// own space and exec-worker on port 7799 and cleans them up.
//
// This is a script, not a `*.test.ts`: it is not part of `deno task conformance` (that suite is for
// PORT contracts, not for an example). Run it after changing the exec worker.
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
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
const { execToken } = await bootstrap(admin);

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

// 3. Call it by name: the args reach the code.
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

// NOTE: a name that was never saved anywhere has no claim pattern, so no worker takes it and the
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
check("but its code is still readable (retire is not delete)", readRetired.ok);
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

// 11. PROVENANCE: a result must name the exact procedure version that produced it. This is the
//     question a model answered wrong from memory ("yes I ran the saved code"; it had not), and
//     it should be answerable from the space instead of from recall.
const provRun = await callTool("add_nums", { a: 1, b: 2 }, convA);
check("the procedure still runs", provRun.ok);
const results = await admin.query({ kind: "tool_result" }, 200);
// One record, read both ways. Citing the last result but reading the first one's parents is how
// this test failed the first time.
const withProc = results.filter((r) => (r.body as { procedure?: unknown }).procedure);
check("a procedure call records which procedure served it", withProc.length > 0);
const lastRun = withProc[withProc.length - 1];
const cited = (lastRun.body as { procedure: { name: string; recordId: string; artifactId: string } }).procedure;
check("it cites a record id, not just a name", Boolean(cited.recordId) && cited.name === "add_nums");

const citedRec = await admin.getRecord(cited.recordId);
check("the cited record exists and is a procedure", citedRec?.kind === "procedure");

// …and it is reachable by walking UP from the result, so "which code produced this?" is a
// lineage query rather than a recollection.
const parents = lastRun.runtimeMeta?.parentIds ?? [];
check("the procedure record is a PARENT of the result", parents.includes(cited.recordId), parents.join(" "));
const lineage = await admin.getLineage?.(lastRun.id).catch(() => null) ?? null;
if (lineage) check("and shows up in the lineage walk", JSON.stringify(lineage).includes(cited.recordId));

// 12. Saving without a `parameters` schema says so, at the moment it can be acted on.
const noParams = await callTool("save_procedure", {
  name: "fixed_thing",
  description: "Always prints the same thing.",
  code: "console.log('always the same');",
}, convA);
check("saving with no parameters warns", Boolean((noParams.output as { note?: string }).note), String((noParams.output as { note?: string }).note ?? "").slice(0, 62));

const withParams = await callTool("save_procedure", {
  name: "takes_input",
  description: "Prints args.x.",
  code: "console.log(args.x);",
  parameters: { type: "object", properties: { x: { type: "string" } } },
}, convA);
check("a parameterised save does not warn", !(withParams.output as { note?: string }).note);

// 13. SHADOWING: a procedure must not take a name a worker already serves. The exec worker
//     publishes run_code/save_procedure/read_procedure/retire_procedure as capabilities, so those
//     are the names available to test here. The check is against DISCOVERED capabilities, not a
//     hardcoded list, which is what makes it cover other workers' tools too.
for (const taken of ["run_code", "read_procedure"]) {
  const clash = await callTool("save_procedure", {
    name: taken,
    description: "should be refused",
    code: "console.log('hijack');",
  }, convA);
  check(`saving over the built-in '${taken}' is refused`, !clash.ok, String(clash.output).slice(0, 58));
}
// …and the built-in still works afterwards, i.e. nothing was overwritten on the way to refusing.
const stillWorks = await callTool("run_code", { code: "console.log('intact');" }, convA);
check("the built-in still runs", stillWorks.ok && (stillWorks.output as { stdout?: string }).stdout?.trim() === "intact");

try {
  worker.kill();
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
