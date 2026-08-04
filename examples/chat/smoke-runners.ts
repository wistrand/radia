// A second language, as a capability like any other.
//
//   deno run -A examples/chat/smoke-runners.ts
//
// `run_code` became `run_javascript` when `run_python` arrived, and the two facts this suite exists
// for are both about the SET rather than either member.
//
// DISCOVERY IS THE AVAILABILITY ANSWER. A language is a tool name, published only where its jail
// probed clean, so a space that cannot spawn `bwrap` never advertises `run_python` and a model
// never picks a tool it cannot reach. The alternative shape (`run_javascript {language: "python"}`)
// is expressible everywhere and fails at execution, after a turn has already been committed to it.
// The first half of this suite denies the worker permission to spawn anything but `deno` and checks
// that the capability is ABSENT, which is the fail-closed direction and needs no bubblewrap to run.
//
// A CHECK AGAINST ONE MEMBER OF A SET BREAKS WHEN THE SET GROWS. The dispatch decided "this is a
// saved procedure" with `tool !== "run_javascript"`, so every Python call went down the procedure
// path and came back as "no procedure named run_python" — with the capability published and the
// jail working, which is why it read as an execution bug rather than a routing one. The second half
// runs both runners for real, and it is skipped rather than failed where `bwrap` is not installed.
//
// No model and no API key: a tool_call is a record, so both runners can be driven directly.

import { activeByKey, RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap } from "./space/roles.ts";
import { writeWorkspace } from "../../extensions/ts/workspace.ts";

const PORT = 7818;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const probe = new RadiaClient(url); // liveness only: /v0/health is public
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

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}
function skip(name: string, why: string) {
  console.log(`  OK   ${name}  (skipped: ${why})`);
}

const wsRoot = await Deno.makeTempDir({ prefix: "radia-runners-" });

/** Start an exec-worker on its own conversation, with the host permissions this case is about. */
async function startWorker(title: string, allowRun: string) {
  const conv = (await admin.put({ kind: "conversation", body: { title } })).id;
  const tokens = await bootstrap(admin, { conversationId: conv });
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--allow-net=127.0.0.1:${PORT}`,
      allowRun,
      "--allow-env=HOME",
      `--allow-read=${wsRoot}`,
      `--allow-write=${wsRoot}`,
      "examples/chat/workers/exec.ts",
      "--url",
      url,
      "--token",
      tokens.execToken,
      "--workspace-root",
      wsRoot,
    ],
    stdout: "null",
    stderr: "null", // a refused spawn is expected in the first case; it must not read as a crash
    stdin: "null",
  }).spawn();
  // Wait on the JS runner, which every host can serve: once it is up the boot probes have all run,
  // so the ABSENCE of the other one is a decision rather than a race.
  for (let i = 0; i < 150; i++) {
    if ((await admin.query({ kind: "capability", match: { tool: "run_javascript" } }, 1)).length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { conv, proc };
}

/** tool -> its CURRENT description, latest-wins and retirement-aware. */
// deno-lint-ignore no-explicit-any
function descriptions(rows: any[]): Map<string, string> {
  const active = activeByKey<{ tool: string; def: { function: { description?: string } } }>(
    rows,
    (b) => b.tool,
  );
  return new Map(
    [...active.entries()].map(([tool, r]) => [
      tool,
      (r.body as { def: { function: { description?: string } } }).def.function.description ?? "",
    ]),
  );
}

async function call(conv: string, tool: string, args: Record<string, unknown>) {
  const { id } = await admin.put({
    kind: "tool_call",
    body: { tool, args, conversationId: conv, owner: "agent:chat-user" },
    parentIds: [conv],
  });
  for (let i = 0; i < 200; i++) {
    const r = await admin.readOne({ kind: "tool_result", match: { callId: id } });
    if (r) return { id, output: (r.body as { output: Record<string, unknown> }).output };
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`no tool_result for ${tool}`);
}

const haveBwrap = await (async () => {
  try {
    const out = await new Deno.Command("bwrap", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return out.success;
  } catch {
    return false;
  }
})();

// ── 1. a jail the host cannot start is not advertised ────────────────────────────────────────────
// `--allow-run=deno` lets the worker spawn its JS child and nothing else, which is exactly the shape
// of a host with no bubblewrap installed. The worker must publish one runner, not two, and must not
// publish a broken one with a warning.
const jsOnly = await startWorker("js only", "--allow-run=deno");
const capsAfter = new Set(
  (await admin.queryAll({ kind: "capability" })).map((r) => (r.body as { tool: string }).tool),
);
check("the JS runner is advertised", capsAfter.has("run_javascript"));
check(
  "…and a runner whose jail could not be started is NOT",
  !capsAfter.has("run_python"),
  [...capsAfter].sort().join(", "),
);
// The sandbox registry answers the same question at a lower level: nothing declared it either, so an
// operator asking what this space can run gets one answer, not a claim with a caveat.
const jails = (await admin.queryAll({ kind: "sandbox" })).map((r) => (r.body as { name: string }).name);
check("…and no sandbox record claims a jail that failed its probe", !jails.includes("python"), jails.join(", ") || "none");

// A description may only name a tool that EXISTS. With Python unserved, `run_javascript` pointing
// at `run_python` is unreachable advice: the model calls it and gets "unknown tool", which is the
// same defect as naming no alternative at all. So the cross-reference is built per boot, and it has
// to say the honest thing here — this space runs one language.
// Through the shared projection, not a hand-rolled map. `run_javascript` is REPUBLISHED per boot
// (its description names a sibling only where one is served), so the space holds more than one
// record for that tool and "the last row I saw" is whichever way the page happened to be ordered.
// That is the bounded-read-treated-as-a-population bug this codebase keeps rediscovering.
const soloDesc = descriptions(await admin.query({ kind: "capability" }, 500, { dir: "desc" })).get("run_javascript") ?? "";
check("…so the JS runner does not point at a tool nobody serves", !/run_python/.test(soloDesc));
check("…and says this space runs one language", /only language|no Python here/i.test(soloDesc));

const js = await call(jsOnly.conv, "run_javascript", { code: "console.log(6 * 7)" });
check("the JS runner still runs", (js.output.stdout as string ?? "").trim() === "42", JSON.stringify(js.output.stdout));

// A run over a CLASSIFIED tree inherits the tree's labels, and it inherits them through the parent
// EDGE: the result names the workspace manifest, and `computeTaint` unions along data parents. The
// mechanism is pinned in `extensions/conformance/` against a simulated result record; this is the
// leg that test cannot reach — that the real worker still threads `wsParent` into the result's
// `parentIds`. A future edit dropping it loses classification silently, which is the documented
// hole (agent_docs/plan-audit-remediation.md, package R) landing somewhere specific enough to fail.
//
// The label is `net`, deliberately. Any workspace run also gets `file` from its read roots, so
// asserting that would pass whether or not the edge exists; `net` can only have come from the tree.
await writeWorkspace(admin, {
  name: "classified",
  owner: "agent:chat-user",
  conversationId: jsOnly.conv,
  files: { "note.txt": "from a classified tree\n" },
  taint: ["net"],
});
const classified = await call(jsOnly.conv, "run_javascript", {
  workspace: "classified",
  code: "console.log(Deno.readTextFileSync('note.txt').trim())",
});
const resultRecord = await admin.readOne({ kind: "tool_result", match: { callId: classified.id } });
const labels = resultRecord?.runtimeMeta.taint ?? [];
check(
  "a run over a classified tree inherits the tree's labels",
  labels.includes("net"),
  `labels=${JSON.stringify(labels)} (a missing 'net' means the result stopped naming the manifest)`,
);

try {
  jsOnly.proc.kill();
  await jsOnly.proc.status;
} catch { /* already gone */ }

// ── 2. both runners, on a host that has the jail ─────────────────────────────────────────────────
if (!haveBwrap) {
  skip("Python runs, in its own jail", "bwrap not installed");
  skip("…and each runner reaches its own language", "bwrap not installed");
  skip("…and a workspace materialises for either one", "bwrap not installed");
  skip("…and a check names the jail the verdict was reached in", "bwrap not installed");
} else {
  const both = await startWorker("both runners", "--allow-run");
  // Wait for the SETTLED advertisement, not for the first record to appear. Publishing two tools is
  // two writes, and the JS description is rewritten to name its new sibling, so a test that starts
  // asserting the moment `run_python` exists reads a `run_javascript` that has not caught up yet.
  // The window is real for the model too, which is why the sibling is named only AFTER the tool it
  // names exists: a description pointing at a tool that is not there yet is the failure mode, and a
  // description that does not yet mention one is merely incomplete.
  for (let i = 0; i < 150; i++) {
    const now = descriptions(await admin.query({ kind: "capability" }, 500, { dir: "desc" }));
    if (now.has("run_python") && /run_python/.test(now.get("run_javascript") ?? "")) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // The failure that prompted this: asked for "python code finding the first 10 primes", the model
  // called `run_javascript` with a Python program, twice, and read back a SyntaxError. Nothing was
  // broken — `run_javascript` simply never mentioned that a sibling existed, and a model comparing
  // tools reads the opening clause, where "JavaScript" was one word ahead of four hundred about
  // save_as. Each must now name the other AND state what selects it, which is the language written.
  const desc = descriptions(await admin.query({ kind: "capability" }, 500, { dir: "desc" }));
  const jsDesc = desc.get("run_javascript") ?? "";
  const pyDesc = desc.get("run_python") ?? "";
  check("the JS runner names the Python one", /run_python/.test(jsDesc));
  check("…and the Python one names the JS one", /run_javascript/.test(pyDesc));
  check(
    "…and each states its language as the thing that selects it",
    /JAVASCRIPT ONLY/.test(jsDesc) && /PYTHON ONLY/.test(pyDesc),
  );
  // The other half of the same turn: told it could not run Python here, a model reaches for
  // os.system('python3 …'). Under the Deno jail that cannot work, and saying so costs one sentence.
  check("…and the JS runner forecloses shelling out to an interpreter", /cannot start processes/.test(jsDesc));

  const py = await call(both.conv, "run_python", { code: "print(6 * 7)" });
  check("Python runs, in its own jail", (py.output.stdout as string ?? "").trim() === "42", JSON.stringify(py.output));

  // The bug this suite is named for: `run_python` fell through to the saved-procedure path, so it
  // returned "no procedure named run_python" rather than executing. Each name must reach its own
  // language, which a program only one of them can parse proves in one call.
  const jsSyntax = await call(both.conv, "run_python", { code: "console.log('js in python')" });
  check(
    "…and each runner reaches its own language",
    (jsSyntax.output.exitCode as number) !== 0 && /NameError|SyntaxError/.test(jsSyntax.output.stderr as string ?? ""),
    JSON.stringify(jsSyntax.output.stderr ?? "").slice(0, 90),
  );

  // A workspace is language-neutral: the tree is materialised the same way and cwd is the tree, so
  // relative paths resolve as they would in a checkout whichever runner opens them.
  // Written straight through the convention rather than through `save_workspace`: that tool lives in
  // the tools-worker, and spawning a second fleet here would test the launcher rather than the
  // runners.
  await writeWorkspace(admin, {
    name: "poly",
    owner: "agent:chat-user",
    conversationId: both.conv,
    files: {
      "data.txt": "shared by both\n",
      "main.py": "print('ran from the tree')\n",
    },
  });
  const pyWs = await call(both.conv, "run_python", {
    workspace: "poly",
    code: "print(open('data.txt').read().strip())",
  });
  const jsWs = await call(both.conv, "run_javascript", {
    workspace: "poly",
    code: "console.log(Deno.readTextFileSync('data.txt').trim())",
  });
  // "Run the file I just saved" is the shape a model actually asks for, and `code` arrives on stdin
  // with no path of its own, so it cannot be imported by the tree. The description names the way
  // through; this checks the way through works.
  const entry = await call(both.conv, "run_python", {
    workspace: "poly",
    code: "import runpy; runpy.run_path('main.py', run_name='__main__')",
  });
  check(
    "…and a saved program can be RUN from the tree",
    (entry.output.stdout as string ?? "").trim() === "ran from the tree",
    JSON.stringify(entry.output.stdout ?? entry.output.stderr),
  );

  check(
    "…and a workspace materialises for either one",
    (pyWs.output.stdout as string ?? "").trim() === "shared by both" &&
      (jsWs.output.stdout as string ?? "").trim() === "shared by both",
    `py=${JSON.stringify(pyWs.output.stdout)} js=${JSON.stringify(jsWs.output.stdout)}`,
  );

  // An attestation that does not say WHERE it was reached is worth less than it looks: the two jails
  // differ on filesystem surface and on whether a program can fork, so a pass under one is not a
  // pass under the other.
  await call(both.conv, "run_python", { code: "print(2 + 2)", expect: { stdout_contains: "4" } });
  await call(both.conv, "run_javascript", { code: "console.log(2 + 2)", expect: { stdout_contains: "4" } });
  const checks = await admin.query({ kind: "check", match: { conversationId: both.conv } }, 20, { dir: "desc" });
  const jailsNamed = new Set(checks.map((r) => (r.body as { sandbox?: string }).sandbox));
  check(
    "…and a check names the jail the verdict was reached in",
    jailsNamed.has("python") && jailsNamed.has("deno"),
    [...jailsNamed].join(", "),
  );

  // Both are declared, and they DISAGREE, which is the whole reason the record exists. A namespace
  // jail has to make an interpreter visible and does not stop fork/exec; a permission model gives
  // the child nothing and cannot spawn at all.
  const specs = new Map(
    (await admin.queryAll({ kind: "sandbox" })).map((r) => [
      (r.body as { name: string }).name,
      r.body as { isolation: string; processes: boolean; readonlyPaths?: string[] },
    ]),
  );
  check("both jails are declared", specs.has("deno") && specs.has("python"), [...specs.keys()].sort().join(", "));
  check(
    "…and they differ on what they guarantee, which is why one record cannot cover both",
    specs.get("deno")?.processes === false && specs.get("python")?.processes === true,
    `deno.processes=${specs.get("deno")?.processes} python.processes=${specs.get("python")?.processes}`,
  );

  try {
    both.proc.kill();
    await both.proc.status;
  } catch { /* already gone */ }
}

space.kill();
await space.status;
await Deno.remove(wsRoot, { recursive: true }).catch(() => {});
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
