#!/usr/bin/env -S deno run -A
// The agent lab, phase 0 (agent_docs/plan-agent-lab.md): compile, start a space, mint a member per
// harness, run them against a scenario, and leave a directory of evidence behind.
//
// It exists because every finding so far came from a human restarting harnesses by hand and pasting
// transcripts. Nothing here is clever: the value is that a run is REPEATABLE and its artifacts are
// files, so two runs against two binaries can be diffed.
//
// A CLIENT, never part of the runtime. It spawns the binary and talks to nothing private.
//
// WHAT IT CANNOT VERIFY: the harnesses' own non-interactive flags. They live in the scenario file
// (`command`), because they change on somebody else's release schedule and a wrong guess baked in
// here would be discovered as a mystery rather than as a line to edit.

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(name);

interface AgentSpec {
  name: string;
  harness?: "claude" | "codex" | "json";
  /** argv for the harness, run with the agent's directory as cwd. The PROMPT goes in on stdin, so
   *  a scenario never has to quote it into a shell. */
  command: string[];
  prompt: string;
  /** Where this harness reads its MCP config. Relative to the agent's directory unless absolute.
   *  Claude Code takes a project-local `.mcp.json`; Codex reads one file per HOME, which is the
   *  "one config for every project" trap architecture-teams.md names, so it needs a path here. */
  configPath?: string;
  /** Extra environment for this harness only (an API key, a CODEX_HOME, a model pin). */
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

interface Scenario {
  name: string;
  team?: string;
  agents: AgentSpec[];
  /** Run agents one after another instead of together. Concurrency is the default because
   *  CONTENTION is what a space is for, and a lab that serialises never sees a lost race. */
  sequential?: boolean;
}

// `team-code` by default: it exercises the same shape as `team-image` (ask, claim, answer with
// something too big for a body) for a fraction of the money, because generating an image costs more
// than the coordination being measured.
const scenarioPath = flag("--scenario", "scripts/agent-lab/scenarios/team-code.json")!;
const scenario = JSON.parse(await Deno.readTextFile(scenarioPath)) as Scenario;
const binary = flag("--binary", "./radia")!;
/**
 * A port nothing else holds, asked of the OS rather than guessed.
 *
 * Two magic numbers failed first: 7899 is one the suites use, so a lab space left running failed
 * `test:quick` with `port_in_use` in a test that has nothing to do with the lab; 7860 was already
 * held by an unrelated service on this machine. A lab starts many short-lived spaces and must never
 * make the person running it think about ports.
 */
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}
const port = Number(flag("--port")) || freePort();
const base = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// OUTSIDE THE REPO by default, and this is a confounder rather than a preference: Claude Code walks
// UP from its working directory collecting CLAUDE.md, so a run under `radia/runs/` hands every lab
// agent 500 lines about this codebase and stops measuring what a naive agent does. `--out` still
// takes anything; put it back in the repo deliberately, not by accident.
const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
const runDir = flag("--out", `${home}/.radia-lab/${scenario.name}-${stamp}`)!;
const team = scenario.team ?? "lab";

if (!await stat(binary)) {
  console.error(
    `${binary} not found. Build it first:\n  deno task compile\n\n` +
      `The lab runs the BINARY on purpose: the config a member gets names the binary that wrote it ` +
      `(src/surfaces/mcp/config.ts), so "did the new build change behaviour" is answerable.`,
  );
  Deno.exit(1);
}

await Deno.mkdir(runDir, { recursive: true });
const spaceDir = `${runDir}/space`;

/**
 * Environment every child gets.
 *
 * ISOLATED FROM THE OPERATOR'S OWN SPACE, which is the whole reason this is a function: `RADIA_DIR`
 * moves what the space writes, and `RADIA_CREDENTIALS` moves the credential file, so a lab run
 * never appends to the credentials the person is using and `radia credentials` afterwards shows
 * nothing new. RADIA_TOKEN is DROPPED rather than passed: it would override a member's definition
 * token and every agent would act as whoever started the lab.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited = { ...Deno.env.toObject() };
  delete inherited.RADIA_TOKEN;
  delete inherited.RADIA_DEFINITION_TOKEN;
  delete inherited.RADIA_SESSION;
  return {
    ...inherited,
    RADIA_DIR: `${runDir}/.radia`,
    RADIA_CREDENTIALS: `${runDir}/credentials.json`,
    ...extra,
  };
}

async function stat(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/**
 * Run the binary as a CLI verb against THIS RUN's space, and return stdout.
 *
 * `--url` is added here rather than at each call site, and that is not tidiness: without it every
 * verb targets `defaultBase()`, which on a developer's machine is their own `radia dev`. The first
 * dry run of this script sent `team add --rotate` there and was saved only by the credential
 * isolation above, which refused it. A setup verb pointed at the wrong space is the one mistake a
 * lab must not be able to make.
 *
 * Throws with stderr, because a lab that continues past a failed setup step reports findings about
 * a space it never built.
 */
async function radia(args: string[]): Promise<string> {
  const out = await new Deno.Command(binary, {
    args: [...args, "--url", base],
    env: childEnv(),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (!out.success) throw new Error(`radia ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`);
  return text;
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/v0/health`, { signal: AbortSignal.timeout(1000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

if (await reachable()) {
  console.error(`something is already serving ${base}. Pass --port <n>, or stop it.`);
  Deno.exit(1);
}

// ---- the space ----------------------------------------------------------------

// PERSISTENT, so a run can be opened afterwards: `radia dev --db <runDir>/space` leaves the
// database in the run directory, and a finding that needs a fifth query does not need a rerun.
// AUTH REQUIRED, because in open mode every member resolves to the operator and the scoping the
// lab exists to observe stops existing (`test/defaults.test.ts` holds that posture).
const space = new Deno.Command(binary, {
  args: ["dev", "--port", String(port), "--db", spaceDir, "--auth", "required"],
  env: childEnv(),
  stdout: "piped",
  stderr: "piped",
}).spawn();
const spaceLog = await Deno.open(`${runDir}/space.log`, { create: true, write: true, truncate: true });
space.stdout.pipeTo(spaceLog.writable).catch(() => {});
space.stderr.pipeTo(Deno.openSync(`${runDir}/space.err`, { create: true, write: true, truncate: true }).writable).catch(() => {});

let stopped = false;
// `--keep` and `--dry-run` both end with the runner exiting while the space must stay up, and
// `Deno.exit` fires `unload`, so the handler below would kill the space the message just said was
// running. Measured: the first dry run printed "stop the space with: kill <pid>" for a process it
// had already ended.
let keepAlive = false;
const stopSpace = () => {
  if (stopped || keepAlive) return;
  stopped = true;
  try {
    space.kill("SIGTERM");
  } catch { /* already gone */ }
};
globalThis.addEventListener("unload", stopSpace);

for (let i = 0; !await reachable(); i++) {
  if (i > 100) {
    stopSpace();
    // The space's OWN message, not just a pointer to it: `dev` explains a taken port and a locked
    // database precisely, and making the reader open a file to see that costs a round trip.
    const why = (await Deno.readTextFile(`${runDir}/space.err`).catch(() => "")).trim().split("\n")[0];
    console.error(`the space never answered on ${base}${why ? `:\n  ${why}` : `; see ${runDir}/space.err`}`);
    Deno.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`space  ${base}  (db ${spaceDir})`);

// ---- members ------------------------------------------------------------------

// One `team add` per agent, so each gets its own harness block. ONE MEMBER PER SESSION is the rule
// being honoured (architecture-teams.md): two harnesses sharing a credential are one principal, and
// nothing afterwards can tell their work apart.
const agents: (AgentSpec & { dir: string; token: string; invocation: { command: string; args: string[] } })[] = [];
for (const a of scenario.agents) {
  const dir = `${runDir}/${a.name}`;
  await Deno.mkdir(dir, { recursive: true });
  // `--rotate` unconditionally: run 2 against a persistent space would otherwise be refused,
  // because a SECOND definition for one agent is not a rotation and looks exactly like one.
  const raw = await radia(["team", "add", a.name, "--team", team, "--harness", "claude", "--rotate", "--json"]);
  const parsed = JSON.parse(raw) as { members: { agent: string; config: string }[] };
  const block = JSON.parse(parsed.members[0].config) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = Object.values(block.mcpServers)[0];
  const token = server.env.RADIA_DEFINITION_TOKEN;
  if (!token) throw new Error(`no definition token in the config printed for ${a.name}`);
  // The two flags the printed block cannot know about, added ONCE and here: a named `--session`, so
  // a restart keeps the same principal and can settle claims it left behind, and `--trace`, the
  // only record of what the model ASKED FOR. Appending them at the config writer instead left
  // `{{mcpArgs}}` short, so the harness configured on the COMMAND LINE (Codex) ran untraced while
  // the one configured by file did not: the lab's whole output, missing for one agent.
  const args = [...server.args, "--session", a.name, "--trace", `${dir}/trace.jsonl`];
  agents.push({ ...a, dir, token, invocation: { command: server.command, args } });
}

/**
 * The adapter's tool names, asked of the BINARY over stdio rather than hardcoded.
 *
 * Codex refuses an MCP call that is not pre-approved, per TOOL: an isolated session (which is what
 * `--ignore-user-config` buys, and the isolation is the point) starts with no approvals at all, so
 * the first real run answered "MCP tool call requires approval, but approval policy is never",
 * spent 85k tokens and made zero calls. Approving by name means knowing the names, and asking the
 * binary means a tool added later is approved without anybody editing a scenario.
 */
async function toolNames(a: typeof agents[number]): Promise<string[]> {
  const child = new Deno.Command(a.invocation.command, {
    args: a.invocation.args.filter((x, i, all) => x !== "--trace" && all[i - 1] !== "--trace"),
    env: childEnv({ RADIA_DEFINITION_TOKEN: a.token }),
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  ));
  const names: string[] = [];
  const dec = new TextDecoder();
  let buf = "";
  outer: for await (const chunk of child.stdout) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const tools = (JSON.parse(l) as { result?: { tools?: { name: string }[] } }).result?.tools;
      if (tools) {
        names.push(...tools.map((t) => t.name));
        break outer;
      }
    }
  }
  await w.close().catch(() => {});
  try {
    child.kill("SIGTERM");
  } catch { /* already gone */ }
  await child.status;
  return names;
}
let tools: string[] = [];

// The config the harness reads. Written HERE rather than pasted, and it adds the two flags the
// printed block cannot know about: a named `--session`, so a restart keeps the same principal and
// can settle claims it left behind, and `--trace`, which is the only record of what the model
// ASKED FOR (a claim that matched nothing writes no event anywhere).
for (const a of agents) {
  const configPath = a.configPath
    ? (a.configPath.startsWith("/") ? a.configPath : `${a.dir}/${a.configPath}`)
    : `${a.dir}/.mcp.json`;
  const config = {
    mcpServers: {
      radia: {
        command: a.invocation.command,
        args: a.invocation.args,
        // ONLY what the adapter needs. Writing the whole inherited environment into a config file
        // put a hundred of the operator's variables on disk, including an ssh-agent socket path,
        // for no gain: the command is absolute and the harness passes its own environment through.
        env: {
          RADIA_DIR: `${runDir}/.radia`,
          RADIA_CREDENTIALS: `${runDir}/credentials.json`,
          RADIA_DEFINITION_TOKEN: a.token,
        },
      },
    },
  };
  await Deno.mkdir(configPath.replace(/\/[^/]*$/, ""), { recursive: true });
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
  console.log(`member ${a.name}  config ${configPath}`);
}

// Once, from the first member: every session sees the same tool list.
tools = await toolNames(agents[0]);
console.log(`tools  ${tools.length} advertised by the adapter`);

if (has("--dry-run")) {
  keepAlive = true; // the commands below are only runnable while the space is up
  console.log(`\ndry run: the space and the members are up, nothing was launched.`);
  for (const a of agents) {
    const cfg = a.configPath?.startsWith("/") ? a.configPath : `${a.dir}/${a.configPath ?? ".mcp.json"}`;
    console.log(`  ${a.name}: (cd ${a.dir} && ${substitute(a.command, a, cfg).map((s) => (/\s/.test(s) ? `'${s}'` : s)).join(" ")})`);
  }
  console.log(`\nstop the space with: kill ${space.pid}`);
  Deno.exit(0);
}

// ---- the harnesses ------------------------------------------------------------

/**
 * The scenario's argv with this run's values substituted.
 *
 * Needed because the two harnesses take an MCP server two different ways: Claude Code reads a FILE
 * (`--mcp-config {{config}}`), while Codex takes config on the command line (`-c
 * mcp_servers.radia.args={{mcpArgs}}`), and neither can be written down before the run mints a
 * token. A scenario that hardcoded either would work for one harness only.
 */
function substitute(argv: string[], a: typeof agents[number], configPath: string): string[] {
  const values: Record<string, string> = {
    "{{config}}": configPath,
    "{{url}}": base,
    "{{binary}}": a.invocation.command,
    // TOML array syntax and JSON array syntax agree for strings, which is what lets one value serve
    // Codex's `-c` and a JSON config alike.
    "{{mcpArgs}}": JSON.stringify(a.invocation.args),
    "{{token}}": a.token,
    // Codex's per-tool approvals as one TOML inline table, from the live tool list.
    "{{codexTools}}": `{ ${tools.map((t) => `${t} = { approval_mode = "approve" }`).join(", ")} }`,
    "{{trace}}": `${a.dir}/trace.jsonl`,
    "{{session}}": a.name,
    "{{dir}}": a.dir,
    // Where the lab was STARTED from, so a scenario can name a script in this repo: an agent runs
    // with its own directory as cwd, which is deliberately not the checkout.
    "{{repo}}": Deno.cwd(),
  };
  return argv.map((s) => s.replace(/\{\{\w+\}\}/g, (m) => values[m] ?? m));
}

// ---- live output ---------------------------------------------------------------
//
// A run is minutes of model time, and piping both streams straight to a file was correct and
// unusable: `claude -p --output-format json` prints ONCE, at the end, so a working run and a wedged
// one look identical for three minutes. Everything below exists to answer "is anything happening",
// and the trace tail answers a sharper question than the transcript does: whether the harness has
// reached the space at all.

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const quiet = has("--quiet");
const width = Math.max(...agents.map((a) => a.name.length));
function say(who: string, what: string) {
  if (!quiet) console.log(`${elapsed().padStart(5)} ${who.padEnd(width)} ${what}`);
}
/** Long lines are CLIPPED, not wrapped: a stream-json event is one line of many hundred characters
 *  and a console full of them hides the two lines that matter. The file keeps everything. */
const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A child's stream, to its log file AND to this console one line at a time. */
async function tee(stream: ReadableStream<Uint8Array>, file: Deno.FsFile, who: string, tag: string) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    await file.write(chunk);
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) say(who, `${tag} ${clip(l.trim())}`);
  }
  if (buf.trim()) say(who, `${tag} ${clip(buf.trim())}`);
  file.close();
}

/** Follow the adapter's trace while the agent runs. THE most useful progress signal: a harness that
 *  has not called a tool yet is starting up or stuck on its own side, which the transcript cannot
 *  distinguish. Polled rather than watched, because the file is small and a poll cannot miss a
 *  write it has not read yet. */
function tailTrace(path: string, who: string): { stop(): void; count(): number } {
  let seen = 0;
  const timer = setInterval(async () => {
    const text = await Deno.readTextFile(path).catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    for (const l of lines.slice(seen)) {
      try {
        const e = JSON.parse(l) as { tool: string; outcome: string; error?: string; records?: number; ms: number };
        const detail = e.error ?? (e.records !== undefined ? `${e.records} records` : "");
        say(who, `→ ${e.tool} ${e.outcome}${detail ? ` (${detail})` : ""} ${e.ms}ms`);
      } catch { /* a line still being written; the next poll gets it whole */ }
    }
    seen = lines.length;
  }, 400);
  return { stop: () => clearInterval(timer), count: () => seen };
}

async function runAgent(a: typeof agents[number]): Promise<{ name: string; code: number | "timeout"; calls: number }> {
  const command = substitute(a.command, a, a.configPath?.startsWith("/") ? a.configPath : `${a.dir}/${a.configPath ?? ".mcp.json"}`);
  say(a.name, `starting ${clip(command.join(" "), 120)}`);
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: a.dir,
    env: childEnv(a.env),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // The prompt on STDIN, so a scenario never has to quote it into a shell and a multi-line prompt
  // stays readable in its own file.
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(a.prompt));
  await w.close();

  const outFile = await Deno.open(`${a.dir}/stdout.log`, { create: true, write: true, truncate: true });
  const errFile = await Deno.open(`${a.dir}/stderr.log`, { create: true, write: true, truncate: true });
  const pumped = Promise.all([
    tee(child.stdout, outFile, a.name, "|"),
    tee(child.stderr, errFile, a.name, "!"),
  ]);
  const trace = tailTrace(`${a.dir}/trace.jsonl`, a.name);

  const seconds = a.timeoutSeconds ?? 600;
  const timer = setTimeout(() => {
    say(a.name, `TIMEOUT after ${seconds}s; killing`);
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, seconds * 1000);
  const status = await child.status;
  clearTimeout(timer);
  await pumped.catch(() => {});
  // One last poll, or the calls made between the final tick and exit are missing from the console
  // while sitting in the file.
  await new Promise((r) => setTimeout(r, 450));
  trace.stop();
  say(a.name, `exit ${status.code}${status.signal ? ` (${status.signal})` : ""}, ${trace.count()} tool calls`);
  return { name: a.name, code: status.success ? 0 : (status.signal ? "timeout" : status.code), calls: trace.count() };
}

console.log(`\nrunning ${agents.length} agent(s)${scenario.sequential ? " in sequence" : " together"}…`);
console.log(`  | is the harness's stdout, ! its stderr, → a tool call reaching the space\n`);
// A HEARTBEAT, because the quiet stretch is real: a harness can spend a minute starting before its
// first token, and silence has to be distinguishable from a stall.
const beat = setInterval(() => {
  const idle = agents.map((a) => a.name).join(", ");
  say("lab", `still running (${idle}); logs under ${runDir}`);
}, 30_000);
const results: { name: string; code: number | "timeout"; calls: number }[] = [];
if (scenario.sequential) {
  for (const a of agents) results.push(await runAgent(a));
} else {
  results.push(...await Promise.all(agents.map(runAgent)));
}
clearInterval(beat);
for (const r of results) console.log(`  ${r.name}: exit ${r.code}, ${r.calls} tool calls`);

// ---- evidence -----------------------------------------------------------------

// Collected while the space is still up, because half of it is an ops-plane read. The space stays
// on disk either way; this is the part a diff between two runs can read without starting anything.
const kinds = JSON.parse(await radia(["kinds", "--json"])) as { kind: string }[];
const collected: Record<string, unknown> = {};
const collect = async (name: string, args: string[]) => {
  try {
    collected[name] = JSON.parse(await radia(args));
  } catch (e) {
    collected[name] = { error: (e as Error).message };
  }
};
await collect("flows", ["flows", "--json"]);
await collect("stats", ["stats", "--json"]);
await collect("events", ["events", "--json", "--limit", "1000"]);
for (const k of kinds) await collect(`records.${k.kind}`, ["query", k.kind, "--json", "--limit", "500"]);
for (const a of agents) await collect(`permissions.${a.name}`, ["permissions", a.name, "--json"]);
await Deno.writeTextFile(`${runDir}/space.json`, JSON.stringify(collected, null, 2));

// ---- tally --------------------------------------------------------------------

// A COUNT, not an assertion pass. Phase 2 of the plan joins this against the space and ranks
// findings; what belongs here is the shape of the session, and the one column no other artifact
// carries: how many calls came back EMPTY.
interface Line {
  tool: string;
  outcome: string;
  error?: string;
  principal?: string;
  session?: string;
}
const tally: Record<string, { calls: number; empty: number; errors: Record<string, number> }> = {};
for (const a of agents) {
  const text = await Deno.readTextFile(`${a.dir}/trace.jsonl`).catch(() => "");
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
  const per = tally[a.name] = { calls: lines.length, empty: 0, errors: {} as Record<string, number> };
  for (const l of lines) {
    if (l.outcome === "empty") per.empty++;
    if (l.outcome === "error") per.errors[l.error ?? "unknown"] = (per.errors[l.error ?? "unknown"] ?? 0) + 1;
  }
}
await Deno.writeTextFile(`${runDir}/tally.json`, JSON.stringify({ scenario: scenario.name, results, tally }, null, 2));

console.log(`\ntool calls`);
for (const [name, t] of Object.entries(tally)) {
  const errs = Object.entries(t.errors).map(([k, n]) => `${k}×${n}`).join(" ");
  console.log(`  ${name}: ${t.calls} calls, ${t.empty} answered EMPTY${errs ? `, refused: ${errs}` : ""}`);
}
console.log(`\nevidence in ${runDir}/`);
console.log(`  space.json     flows, stats, events, every record, every member's permissions`);
console.log(`  <agent>/trace.jsonl   what the model asked for, one line per call`);
console.log(`  <agent>/stdout.log    what the harness said`);
if (has("--keep")) {
  keepAlive = true;
  console.log(`\nspace left running on ${base} (pid ${space.pid}); kill it when done.`);
  Deno.exit(0);
}
stopSpace();
await space.status;
