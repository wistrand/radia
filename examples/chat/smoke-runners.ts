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

import { activeByKey, type Population, RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, mintSession } from "./space/roles.ts";
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
    if ((await admin.queryOldest({ kind: "capability", match: { tool: "run_javascript" } }, 1)).length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { conv, proc };
}

/** tool -> its CURRENT description, latest-wins and retirement-aware. */
// `Population`, not `RadiaRecord[]`: the obligation to have exhausted belongs to the CALLER, and
// typing it here is what carries the rule across the function boundary the grep guard cannot see.
function descriptions(rows: Population): Map<string, string> {
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

// As a PERSON, not the operator: exec resolves who it acts for from the call's author, and an
// operator has no grant set to narrow to, so a delegated mint for one is refused. Anything that
// then reads a workspace runs with the worker's own reach, which no longer includes reading one
// (agent_docs/plan-delegation.md phase 4).
const caller = new RadiaClient(url, { token: await mintSession(admin, "human:runners") });

async function call(conv: string, tool: string, args: Record<string, unknown>) {
  const { id } = await caller.put({
    kind: "tool_call",
    body: { tool, args, conversationId: conv, owner: "agent:chat-user" },
    parentIds: [conv],
  });
  for (let i = 0; i < 200; i++) {
    const r = await admin.readOne<{ output: Record<string, unknown>; ok?: boolean }>({ kind: "tool_result", match: { callId: id } });
    if (r) {
      const body = r.body;
      return { id, output: body.output, ok: body.ok !== false };
    }
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
  (await admin.queryAll<{ tool: string }>({ kind: "capability" })).map((r) => r.body.tool),
);
check("the JS runner is advertised", capsAfter.has("run_javascript"));
check(
  "…and a runner whose jail could not be started is NOT",
  !capsAfter.has("run_python"),
  [...capsAfter].sort().join(", "),
);
// The sandbox registry answers the same question at a lower level: nothing declared it either, so an
// operator asking what this space can run gets one answer, not a claim with a caveat.
const jails = (await admin.queryAll<{ name: string }>({ kind: "sandbox" })).map((r) => r.body.name);
check("…and no sandbox record claims a jail that failed its probe", !jails.includes("python"), jails.join(", ") || "none");

// A description may only name a tool that EXISTS. With Python unserved, `run_javascript` pointing
// at `run_python` is unreachable advice: the model calls it and gets "unknown tool", which is the
// same defect as naming no alternative at all. So the cross-reference is built per boot, and it has
// to say the honest thing here — this space runs one language.
// Through the shared projection, not a hand-rolled map. `run_javascript` is REPUBLISHED per boot
// (its description names a sibling only where one is served), so the space holds more than one
// record for that tool and "the last row I saw" is whichever way the page happened to be ordered.
// That is the bounded-read-treated-as-a-population bug this codebase keeps rediscovering.
const soloDesc = descriptions(await admin.queryAll({ kind: "capability" })).get("run_javascript") ?? "";
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
    const now = descriptions(await admin.queryAll({ kind: "capability" }));
    if (now.has("run_python") && /run_python/.test(now.get("run_javascript") ?? "")) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // The failure that prompted this: asked for "python code finding the first 10 primes", the model
  // called `run_javascript` with a Python program, twice, and read back a SyntaxError. Nothing was
  // broken — `run_javascript` simply never mentioned that a sibling existed, and a model comparing
  // tools reads the opening clause, where "JavaScript" was one word ahead of four hundred about
  // save_as. Each must now name the other AND state what selects it, which is the language written.
  const desc = descriptions(await admin.queryAll({ kind: "capability" }));
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
  const checks = await admin.queryNewest<{ sandbox?: string }>({ kind: "check", match: { conversationId: both.conv } }, 20);
  const jailsNamed = new Set(checks.map((r) => r.body.sandbox));
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
      r.body as { isolation: string; processes: boolean; readonlyPaths?: string[]; confiner?: string; importsConfined?: boolean },
    ]),
  );
  check(
    "both jails are declared",
    (specs.has("deno") || specs.has("deno-confined")) && specs.has("python"),
    [...specs.keys()].sort().join(", "),
  );

  // WHICH JAIL RAN IS A RECORD, not a log line. This worker was launched with a bare `--allow-run`,
  // so it can spawn `bwrap` and should have chosen the CONFINED Deno jail: the permission model
  // does not bound module loading, and a mount namespace is what closes it. The js-only worker
  // above could not spawn `bwrap` and fell back, which is the posture a host without it keeps.
  const confined = specs.get("deno-confined") as { confiner?: string; importsConfined?: boolean } | undefined;
  check(
    "the JS jail this worker serves is CONFINED, and the record says by what",
    confined?.confiner === "bubblewrap" && confined?.importsConfined === true,
    `deno-confined=${JSON.stringify(confined)} (declared: ${[...specs.keys()].sort().join(", ")})`,
  );
  const plain = specs.get("deno") as { confiner?: string; importsConfined?: boolean } | undefined;
  check(
    "…and the fallback jail does not pretend to be one",
    plain === undefined || (plain.confiner === "none" && plain.importsConfined === false),
    JSON.stringify(plain),
  );
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

// ── rehearsing an AGENT entrypoint from the chat ─────────────────────────────────────────────────
//
// The gap this closes: the chat's jail has no broker, so an entrypoint written as
// `default(record, space)` could only ever be tested against a hand-written stub of `space`, which
// is exactly where "passes in chat, fails in prod" lives. A rehearsal runs the real shim, the real
// frames and the real jail, and records what would have been written instead of writing it.
{
  // `mkfifo` alongside `deno`: the broker's channel is a pipe pair on the filesystem, so a host
  // that rehearses an entrypoint spawns one coreutils binary as well as its interpreter.
  const js = await startWorker("rehearsal", "--allow-run=deno,mkfifo");

  // THE REAL LAUNCHER, checked as text, because this suite passing says nothing about the fleet the
  // chat actually starts: the same missing name shipped there and only surfaced in a live session,
  // as six nacks and a tool timeout. A permission list out of sync with what the code spawns is not
  // something a run of this file can notice.
  const fleet = await Deno.readTextFile(new URL("./client/fleet.ts", import.meta.url));
  const allowRun = fleet.match(/"--allow-run=([^"]*)"/)?.[1] ?? "";
  check(
    "the fleet's exec worker may spawn the broker's mkfifo, not only its jails",
    allowRun.split(",").includes("mkfifo"),
    `--allow-run=${allowRun}`,
  );
  await writeWorkspace(admin, {
    name: "agentish",
    owner: "agent:chat-user",
    conversationId: js.conv,
    files: {
      "main.ts": "export default async (record: any, space: any) => {\n" +
        "  await space.put({ kind: 'note', body: { seen: record.body.job } });\n" +
        "  return { kind: 'exec_result', body: { tag: 'did:' + record.body.job } };\n" +
        "};\n",
    },
    entrypoint: "main.ts",
  });

  const dry = await call(js.conv, "run_javascript", { workspace: "agentish", record: { job: "alpha" } });
  const out = dry.output as {
    rehearsal?: boolean;
    result?: { kind: string; body: { tag?: string } };
    wouldWrite?: { kind: string; body: Record<string, unknown>; parentIds: string[] }[];
  };
  check("an entrypoint can be rehearsed as an agent would run it", out.rehearsal === true && out.result?.kind === "exec_result", JSON.stringify(out).slice(0, 120));
  check("…and it is TypeScript, called with the record", out.result?.body?.tag === "did:alpha", JSON.stringify(out.result));
  check("…and what it would WRITE comes back", out.wouldWrite?.length === 1 && out.wouldWrite[0].kind === "note", JSON.stringify(out.wouldWrite));
  check(
    "…carrying the claimed record as a parent, which the code never wrote",
    (out.wouldWrite?.[0].parentIds ?? []).length === 1,
    JSON.stringify(out.wouldWrite?.[0].parentIds),
  );
  // A REHEARSAL THAT FAILS ANSWERS ANYWAY. The failure used to nack, so at-least-once ran the same
  // doomed code six times and the model got a timeout instead of the diagnosis, which is how two
  // separate bugs stayed invisible to everyone except whoever was watching the terminal.
  await writeWorkspace(admin, {
    name: "agentish-broken",
    owner: "agent:chat-user",
    conversationId: js.conv,
    files: {
      "main.ts": "export default async (record: any, space: any) => {\n" +
        "  await space.put('note', { tag: 'positional' });\n" +
        "  return { kind: 'exec_result', body: {} };\n" +
        "};\n",
    },
    entrypoint: "main.ts",
  });
  const broke = await call(js.conv, "run_javascript", { workspace: "agentish-broken", record: { job: "x" } });
  check("a rehearsal that FAILS still answers, rather than nacking until the call times out", broke.ok === false, JSON.stringify(broke).slice(0, 100));
  check("…and the answer carries the diagnosis the model needs to fix its code", String(broke.output).includes("space.put({kind, body})"), String(broke.output).slice(0, 160));

  // `write` WITH `record` used to be ignored in silence, and a model that wanted a real run went
  // looking for another way: it added an `import.meta.main` guard so a plain call would execute,
  // which runs the tree as a PROGRAM rather than as the agent. A refusal that names the two
  // meanings costs one turn; a silent no-op cost a redesign of the file.
  const combined = await call(js.conv, "run_javascript", { workspace: "agentish", record: { job: "x" }, write: true });
  check("`write` with `record` is refused, not quietly ignored", combined.ok === false, JSON.stringify(combined).slice(0, 90));
  check("…and the refusal says where a real run comes from", String(combined.output).includes("bind the tree to an agent"), String(combined.output).slice(-60));

  // The assertion the feature rests on: a rehearsal is not a run.
  const notes = await admin.queryOldest({ kind: "note" }, 10);
  check("…and NOTHING was written", notes.length === 0, `${notes.length} notes`);
  js.proc.kill();
  await js.proc.status;
}

// ── --require-confinement ────────────────────────────────────────────────────────────────────────
//
// A read permission does not bound module loading, so an unconfined jail reads any JSON its user
// can read. Off by default (that jail is what every host had until the confiners existed), but a
// space where model-written code runs near anything that matters can refuse it. The failing
// condition is made honestly: a worker launched with `--allow-run=deno` cannot spawn `bwrap`, so no
// confiner can hold however good the host is.
{
  const conv = (await admin.put({ kind: "conversation", body: { title: "require confinement" } })).id;
  const tokens = await bootstrap(admin, { conversationId: conv });
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--allow-net=127.0.0.1:${PORT}`,
      "--allow-run=deno", // NOT bwrap: nothing here can confine
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
      "--require-confinement",
    ],
    stdout: "null",
    stderr: "piped",
    stdin: "null",
  }).spawn();
  // BOUNDED, because the failure this guards against is a flag that is read and never acted on, and
  // that shape makes the worker keep RUNNING. Waiting on it would hang the suite instead of failing
  // it, which is the least useful way for a test to be right.
  const done = await Promise.race([
    proc.output().then((o) => o),
    new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
  ]);
  if (!done) {
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await proc.status;
  }
  const err = done ? new TextDecoder().decode(done.stderr) : "";
  check("--require-confinement refuses to serve when nothing confines", done !== null && done.code !== 0, done ? `exit=${done.code}` : "still running after 20s: the flag was read and ignored");
  check("…and says what would fix it", /REFUSING to serve/.test(err) && /bubblewrap/.test(err), err.split("\n")[0]?.slice(0, 140));
  // It refuses EVERYTHING rather than declining one tool: a procedure is code execution too.
  const served = await admin.queryOldest({ kind: "capability", match: { tool: "run_javascript" } }, 50);
  check(
    "…and publishes no runner for that conversation",
    !served.some((r) => (r.body as { by?: string; conversationId?: string }).conversationId === conv),
    `${served.length} run_javascript capabilities in the space`,
  );
}

space.kill();
await space.status;
await Deno.remove(wsRoot, { recursive: true }).catch(() => {});
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
