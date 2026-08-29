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

import { renderRun } from "./report.ts";

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(name);
/** Every occurrence of a repeatable flag, in order. */
const flagAll = (name: string) =>
  argv.flatMap((x, i) => (x === name && argv[i + 1] && !argv[i + 1].startsWith("--") ? [argv[i + 1]] : []));

/**
 * `--model` on the command line, either for every agent or for one.
 *
 * `--model sonnet` sets all of them; `--model claude-lab=sonnet` sets one and is repeatable, which
 * is what a paired run needs: hold one arm fixed and move the other. The resolved models land in
 * `tally.json`, because a rate compared across runs is meaningless without knowing which model
 * produced it, and the harnesses version themselves underneath us.
 */
const modelOverrides = new Map<string, string>();
let modelForAll: string | undefined;
for (const m of flagAll("--model")) {
  const eq = m.indexOf("=");
  if (eq > 0) modelOverrides.set(m.slice(0, eq), m.slice(eq + 1));
  else modelForAll = m;
}

interface AgentSpec {
  name: string;
  harness?: "claude" | "codex" | "agy" | "json";
  /** argv for the harness, run with the agent's directory as cwd. The PROMPT goes in on stdin, so
   *  a scenario never has to quote it into a shell. */
  command: string[];
  prompt: string;
  /** Where this harness reads its MCP config. Relative to the agent's directory unless absolute.
   *  Claude Code takes a project-local `.mcp.json`; Codex reads one file per HOME, which is the
   *  "one config for every project" trap architecture-teams.md names, so it needs a path here. */
  configPath?: string;
  /** Extra environment for this harness only (an API key, a CODEX_HOME). */
  env?: Record<string, string>;
  /**
   * Which credential this agent acts under. `member` (the default) is its own definition token;
   * `operator` is the run's operator, and is REFUSED for a harness.
   *
   * The exception exists because two verbs are deliberately not a member's to call: `promote`
   * writes grants and `bind` is the escalation root, so together they decide which code runs as
   * which principal (agent_docs/architecture-workspace-agents.md). A scenario that deploys needs a
   * step that holds the operator, and naming it here is what keeps that visible instead of a
   * script quietly resolving one. A MODEL never gets it: that is the whole isolation rule the lab
   * runs under, and a harness asking for it is a scenario bug rather than a choice.
   */
  credential?: "member" | "operator";
  /**
   * The model this harness runs, substituted as `{{model}}` into its own `command`.
   *
   * NOT a flag the runner appends, because the flag differs per harness (`--model` for Claude
   * Code, `-m` for Codex) and harness argv is the one thing this file deliberately does not know
   * (it changes on somebody else's release schedule). The scenario states the default; `--model` on
   * the command line overrides it, which is what makes a PAIRED run possible without editing a
   * scenario: one question, two arms, the same day and the same prompt.
   */
  model?: string;
  timeoutSeconds?: number;
  /**
   * A WORKER rather than a harness: started before the others, never waited for, killed at the end.
   *
   * It is what lets a scenario have a third party that holds no model and costs nothing to run. A
   * one-shot harness answers and exits; a worker serves until the run is over, so waiting for it
   * would hang the lab.
   */
  background?: boolean;
  /** Extra grants for this member, `<kind>:<op,op>`, TEAM-SCOPED like everything else it holds. */
  grants?: string[];
  /**
   * Grants written WITHOUT the team pattern, for reference kinds that carry no team: `sandbox`
   * describes what the space can execute, the way `kind_def` describes what it stores. A
   * team-scoped grant on one of those matches nothing and refuses every write, which is the same
   * trap `DISCOVERY_GRANTS` exists for (agent_docs/architecture-teams.md).
   */
  unscopedGrants?: string[];
  /**
   * When this worker is READY, as a record that exists once it is. Polled rather than slept on: a
   * worker advertises what it serves, so its own `capability` record is the honest signal, and a
   * sleep long enough to be safe is a sleep added to every run.
   */
  readyWhen?: { kind: string; match?: Record<string, unknown> };
}

interface Scenario {
  name: string;
  team?: string;
  agents: AgentSpec[];
  /** Run agents one after another instead of together. Concurrency is the default because
   *  CONTENTION is what a space is for, and a lab that serialises never sees a lost race. */
  sequential?: boolean;
  /** Kind declarations this scenario needs beyond the team's own, as `kind_def` bodies. Declared by
   *  the OPERATOR before any member starts, because a member holds no `kind_def: put`. */
  kinds?: Record<string, unknown>[];
  /**
   * WHEN the seed is written. `start` (the default) is before any agent launches; `agents-ready`
   * holds it until every harness has made its first tool call.
   *
   * The second exists because a contention scenario with fast work measures STARTUP LATENCY
   * instead. Measured three times: harnesses orient between 5 and 25 seconds apart, two of them
   * drained nine instant tasks in the 23 seconds before the third's first claim, so the third
   * did everything right and got nothing. Raising the seed count does not fix it, because the
   * fast agents drain whatever is there; the fix is to put the work in front of all of them at
   * once. The readiness signal is the TRACE, which already exists and is already tailed: an agent
   * that has made a tool call is an agent that can claim.
   */
  seedWhen?: "start" | "agents-ready";
  /**
   * Records the OPERATOR writes before any agent starts, as `{kind, body}`.
   *
   * For a scenario whose subject is CLAIMING rather than handing off. Every scenario so far has one
   * agent write the work another claims, which buys a realistic handoff and pays for it with a
   * startup race wider than the work (agent_docs/plan-agent-lab.md). Seeding removes both, and is
   * the only way to put a KNOWN number of claimable records in front of two agents at once, which
   * is what a contention finding is measured against.
   */
  seed?: { kind: string; body: Record<string, unknown> }[];
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

/** Background agents, killed with the space. Declared HERE for the dead-zone reason in
 *  `startWorker` below. */
const workers: { name: string; child: Deno.ChildProcess; trace?: { stop(): void } }[] = [];
let stopped = false;
// `--keep` and `--dry-run` both end with the runner exiting while the space must stay up, and
// `Deno.exit` fires `unload`, so the handler below would kill the space the message just said was
// running. Measured: the first dry run printed "stop the space with: kill <pid>" for a process it
// had already ended.
let keepAlive = false;
const stopSpace = () => {
  if (stopped || keepAlive) return;
  stopped = true;
  stopWorkers();
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

// The scenario's own kinds, declared by the OPERATOR before any member starts: a member holds
// `kind_def: query` and never `put`, deliberately (the team pattern belongs on kinds that carry
// data, never on the ones that describe them).
for (const def of scenario.kinds ?? []) {
  await radia(["put", "kind_def", JSON.stringify(def)]);
}
if (scenario.kinds?.length) console.log(`kinds  ${scenario.kinds.length} declared for this scenario`);

// One `team add` per agent, so each gets its own harness block. ONE MEMBER PER SESSION is the rule
// being honoured (architecture-teams.md): two harnesses sharing a credential are one principal, and
// nothing afterwards can tell their work apart.
const agents: (AgentSpec & { dir: string; token: string; invocation: { command: string; args: string[] } })[] = [];
for (const a of scenario.agents) {
  const dir = `${runDir}/${a.name}`;
  await Deno.mkdir(dir, { recursive: true });
  // `--rotate` unconditionally: run 2 against a persistent space would otherwise be refused,
  // because a SECOND definition for one agent is not a rotation and looks exactly like one.
  const raw = await radia([
    "team",
    "add",
    a.name,
    "--team",
    team,
    "--harness",
    "claude",
    "--rotate",
    "--json",
    ...(a.grants ?? []).flatMap((g) => ["--grant", g]),
  ]);
  // Reference kinds carry no team, so a team-scoped grant on one matches nothing and refuses every
  // write. Written directly as the operator, which is also the only way to say "unscoped" here.
  for (const g of a.unscopedGrants ?? []) {
    const [kind, ops] = g.split(":");
    await radia(["put", "grant", JSON.stringify({ principal: `agent:${a.name}`, kind, operations: ops.split(",") })]);
  }
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

// The seeded work, written AFTER the members exist because `team add` is what declares the team's
// own kinds, so a `task` seeded before the first member is a `kind_not_declared`.
//
// The team label is STAMPED here rather than repeated in every seed body. A member's grants are
// pattern-scoped to its team, and there is deliberately no unlabelled lane
// (agent_docs/architecture-teams.md), so an unlabelled seed is invisible to every agent in the run
// and reads as an empty queue. A body naming its own `team` still wins, since a scenario may want
// exactly that: work nobody in this team can see is how an isolation test is written.
async function writeSeed(): Promise<void> {
  for (const s of scenario.seed ?? []) {
    await radia(["put", s.kind, JSON.stringify({ team, ...s.body })]);
  }
}
if (scenario.seed?.length && scenario.seedWhen !== "agents-ready") {
  await writeSeed();
  console.log(`seed   ${scenario.seed.length} records written before any agent started`);
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

/**
 * Where a harness keeps its own state, and which credential file makes a private copy usable.
 *
 * Two harnesses need this and they name the directory differently: codex reads `CODEX_HOME`, and
 * antigravity has no variable of its own, so its whole `HOME` moves and it finds `~/.gemini` inside
 * it. Both accumulate a TRUST LIST for every directory they are run in, which is the leak this
 * exists to stop.
 */
const PRIVATE_HOMES: Record<string, { dir: string; env: string; from: string; credentials: string[] }> = {
  codex: { dir: "codex-home", env: "CODEX_HOME", from: ".codex", credentials: ["auth.json"] },
  // HOME, not a config path: agy resolves `~/.gemini` from it, so moving HOME moves the config, the
  // trust list, the history and the caches together. The four credential files were established by
  // running it with nothing else linked in.
  agy: {
    dir: "agy-home",
    env: "HOME",
    from: ".gemini",
    credentials: ["oauth_creds.json", "google_accounts.json", "user_id", "settings.json"],
  },
};

/** The private home a harness gets, and the variable that points it there. */
function privateHome(a: AgentSpec & { dir: string }): { env: string; value: string } | undefined {
  const spec = a.harness ? PRIVATE_HOMES[a.harness] : undefined;
  return spec ? { env: spec.env, value: `${a.dir}/${spec.dir}` } : undefined;
}

/**
 * A private home per agent, because one home cannot hold two of them.
 *
 * MEASURED, in the operator's own file: `--ignore-user-config` governs READS, so every codex run
 * still wrote `[projects."<run dir>"] trust_level = "trusted"` into the real `~/.codex/config.toml`,
 * and twenty lab directories had accumulated there. Two codex agents in one run also share that
 * file, the history, the caches and the sqlite state, so they are not independent participants:
 * they are one installation used twice, which is the same mistake as two harnesses on one Radia
 * credential.
 *
 * THE CREDENTIAL STAYS SHARED, deliberately, and it is the one thing not isolated. `auth.json` is
 * SYMLINKED rather than copied: a login is a login, all codex processes on this machine already
 * write that one file today, and a copy would break the sharing rather than preserve it, so a token
 * refreshed inside a lab run would leave the operator's own copy stale. The failure mode of the
 * symlink is degradation, never corruption: if codex replaces the file rather than writing in place,
 * the run continues against a stale copy and the operator's file is untouched.
 *
 * Everything else is per agent and per run, which is what makes the trust entry, the history and
 * the caches land in the run directory where they can be read afterwards and thrown away with it.
 */
async function harnessHome(a: AgentSpec & { dir: string }): Promise<string | undefined> {
  const spec = a.harness ? PRIVATE_HOMES[a.harness] : undefined;
  if (!spec) return undefined;
  // The operator's own, wherever it is: an explicitly set variable wins, since somebody running the
  // lab from an already-isolated home means it.
  const source = `${Deno.env.get(spec.env) ?? home}/${spec.from}`.replace(`${home}/${spec.from}/${spec.from}`, `${home}/${spec.from}`);
  const target = `${a.dir}/${spec.dir}`;
  // agy's credentials sit one level down, in `<home>/.gemini`; codex's sit in `CODEX_HOME` itself.
  // Naming the source directory and the target the same way keeps that difference in the table
  // above rather than in a branch here.
  const into = spec.env === "HOME" ? `${target}/${spec.from}` : target;
  await Deno.mkdir(into, { recursive: true });
  for (const file of spec.credentials) {
    try {
      await Deno.symlink(`${source}/${file}`, `${into}/${file}`);
    } catch (e) {
      // A missing or unreadable credential is NOT fatal: a scenario may authenticate by environment
      // variable instead, and failing here would turn a working setup into a broken one.
      if (!(e instanceof Deno.errors.AlreadyExists)) {
        say(a.name, `no ${a.harness} credential '${file}' linked (${e instanceof Error ? e.message : e}); it may still authenticate by environment`);
      }
    }
  }
  return target;
}

// The config the harness reads. Written HERE rather than pasted, and it adds the two flags the
// printed block cannot know about: a named `--session`, so a restart keeps the same principal and
// can settle claims it left behind, and `--trace`, which is the only record of what the model
// ASKED FOR (a claim that matched nothing writes no event anywhere).
for (const a of agents) {
  // WHERE THIS HARNESS LOOKS. Claude Code takes a config file on the command line, so any path
  // works; agy takes none and reads `<home>/.gemini/config/mcp_config.json`, so the file has to be
  // written where its private home will put it. The SHAPE is the same `mcpServers` object for both,
  // which is why there is one writer below and not two.
  const configPath = a.configPath
    ? (a.configPath.startsWith("/") ? a.configPath : `${a.dir}/${a.configPath}`)
    : a.harness === "agy"
    ? `${a.dir}/agy-home/.gemini/config/mcp_config.json`
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
  // Not `home`: that name is the operator's HOME at module scope, and shadowing it here would put
  // two very different directories one letter apart in a function that links a credential.
  const privateDir = await harnessHome(a);
  const where = privateHome(a);
  console.log(`member ${a.name}  config ${configPath}${privateDir ? `  ${where!.env} ${privateDir}` : ""}`);
}

// A HARNESS MAY NEVER HOLD THE OPERATOR. The lab's whole posture is that each agent acts as itself
// under real grants, and one model with the operator credential deletes the scoping under
// observation without failing anything.
for (const a of agents) {
  if (a.credential === "operator" && a.harness) {
    console.error(`${a.name}: a harness may not run as the operator. Move the privileged step to a script.`);
    Deno.exit(1);
  }
}

// A `--model` naming an agent that is not in this scenario is a TYPO, and a silent one: the run
// proceeds on the harness default and the evidence says a model was asked for that never was.
for (const name of modelOverrides.keys()) {
  if (!agents.some((a) => a.name === name)) {
    console.error(`--model ${name}=… names no agent in this scenario (it has ${agents.map((a) => a.name).join(", ")})`);
    Deno.exit(1);
  }
}
const models = Object.fromEntries(agents.filter((a) => modelOf(a)).map((a) => [a.name, modelOf(a)]));
console.log(
  Object.keys(models).length
    ? `model  ${Object.entries(models).map(([n, m]) => `${n}=${m}`).join("  ")}`
    : `model  each harness's own default (pass --model <name> or --model <agent>=<name> to pin one)`,
);

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
/** The model this agent runs: `--model <agent>=<name>`, then `--model <name>`, then the scenario. */
function modelOf(a: AgentSpec): string {
  return modelOverrides.get(a.name) ?? modelForAll ?? a.model ?? "";
}

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
    "{{model}}": modelOf(a),
    // THE PROMPT IN ARGV, for a harness that takes no stdin. Claude Code and Codex both read one
    // from stdin, which is why a scenario never has to quote a multi-line prompt into a shell;
    // `agy` takes it as the value of `-p` and says so if you get it wrong. A command using this
    // gets no stdin at all, so the two paths cannot both deliver a prompt.
    "{{prompt}}": a.prompt,
    "{{trace}}": `${a.dir}/trace.jsonl`,
    "{{session}}": a.name,
    "{{dir}}": a.dir,
    // Where the lab was STARTED from, so a scenario can name a script in this repo: an agent runs
    // with its own directory as cwd, which is deliberately not the checkout.
    "{{repo}}": Deno.cwd(),
  };
  const filled = argv.map((s) => s.replace(/\{\{\w+\}\}/g, (m) => values[m] ?? m));
  // AN UNSET MODEL DROPS ITS FLAG, rather than passing an empty argument the harness will reject.
  // That keeps "no model named" meaning what it has always meant here: the harness picks, which is
  // the behaviour every recorded run so far was measured under. It works because the flag and the
  // value are separate argv entries in both harnesses (`--model X`, `-m X`), so the pair is the
  // template token and the token before it.
  if (!modelOf(a)) {
    const at = argv.findIndex((s) => s === "{{model}}");
    if (at > 0) filled.splice(at - 1, 2);
  }
  return filled;
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
    // A HARNESS reads its token from the MCP config this runner wrote; a SCRIPT has no config to
    // read, so it gets the same token in its environment rather than on the command line, where it
    // would sit in `ps` for every process on the machine. An `operator` step gets neither and
    // resolves the run's operator from `RADIA_CREDENTIALS`, which is what `promote` and `bind`
    // need and what no model is ever given.
    // A PRIVATE HOME per agent, so two of one harness are two installations rather than one used
    // twice, and so the trust entry a run writes lands in the run directory instead of the
    // operator's own config (measured: twenty lab directories had accumulated in `~/.codex`).
    env: childEnv({
      ...(privateHome(a) ? { [privateHome(a)!.env]: privateHome(a)!.value } : {}),
      ...(a.harness || a.credential === "operator" ? a.env : { ...a.env, RADIA_DEFINITION_TOKEN: a.token, RADIA_URL: base }),
    }),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // The prompt on STDIN, so a scenario never has to quote it into a shell and a multi-line prompt
  // stays readable in its own file. A command that templates `{{prompt}}` has already been handed
  // it in argv, so stdin is closed empty: sending it twice would run the turn twice on a harness
  // that reads both, and hang one that reads neither.
  const w = child.stdin.getWriter();
  if (!a.command.some((x) => x.includes("{{prompt}}"))) await w.write(new TextEncoder().encode(a.prompt));
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

// ---- workers ------------------------------------------------------------------

/** A background agent, started and left running. Its output is teed like any other; nothing waits
 *  for it, and `stopWorkers` ends it when the harnesses are done. `workers` itself is declared with
 *  `stopSpace` above, not here: the early-exit paths (a port taken, a space that never answered)
 *  run `stopSpace` long before this line is evaluated, and a `const` reached in its temporal dead
 *  zone would replace the real error with "Cannot access 'workers' before initialization".
 */
async function startWorker(a: typeof agents[number]): Promise<void> {
  const command = substitute(a.command, a, `${a.dir}/.mcp.json`);
  say(a.name, `starting ${clip(command.join(" "), 120)}`);
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: a.dir,
    env: childEnv({
      ...(privateHome(a) ? { [privateHome(a)!.env]: privateHome(a)!.value } : {}),
      ...a.env,
      RADIA_DEFINITION_TOKEN: a.token,
      RADIA_URL: base,
    }),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const trace = tailTrace(`${a.dir}/trace.jsonl`, a.name);
  // The tail's INTERVAL is kept so it can be cleared. Dropping the handle left a live
  // `setInterval` per worker, and Deno does not exit while one is pending: the whole run finished,
  // wrote its evidence, and then hung until the outer timeout killed it.
  workers.push({ name: a.name, child, trace });
  const out = await Deno.open(`${a.dir}/stdout.log`, { create: true, write: true, truncate: true });
  const err = await Deno.open(`${a.dir}/stderr.log`, { create: true, write: true, truncate: true });
  tee(child.stdout, out, a.name, "|").catch(() => {});
  tee(child.stderr, err, a.name, "!").catch(() => {});
}

/**
 * Wait until a worker's readiness RECORD exists.
 *
 * Polled against the space rather than slept on: a worker advertises what it serves, so its own
 * `capability` record is the honest signal that it is up, jailed and listening. A sleep long enough
 * to be safe on a cold jail probe is a sleep added to every run.
 */
async function awaitReady(a: typeof agents[number], seconds = 60): Promise<boolean> {
  const ready = a.readyWhen;
  if (!ready) return true;
  for (let i = 0; i < seconds * 2; i++) {
    const rows = await radia([
      "query",
      ready.kind,
      "--json",
      ...(ready.match ? ["--match", JSON.stringify(ready.match)] : []),
    ]).then((t) => JSON.parse(t)).catch(() => null);
    const found = Array.isArray(rows) ? rows.length : (rows?.records?.length ?? 0);
    if (found > 0) {
      say(a.name, `ready (${ready.kind} record present after ${(i / 2).toFixed(1)}s)`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  say(a.name, `NOT READY after ${seconds}s: no ${ready.kind} record. The harnesses run anyway; expect refusals.`);
  return false;
}

function stopWorkers(): void {
  for (const w of workers) {
    w.trace?.stop();
    try {
      w.child.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}

const background = agents.filter((a) => a.background);
const harnesses = agents.filter((a) => !a.background);
for (const a of background) await startWorker(a);
for (const a of background) await awaitReady(a);

console.log(`\nrunning ${harnesses.length} agent(s)${scenario.sequential ? " in sequence" : " together"}…`);
console.log(`  | is the harness's stdout, ! its stderr, → a tool call reaching the space\n`);

// THE SEED, HELD UNTIL EVERY HARNESS CAN CLAIM. Runs alongside them rather than blocking the
// launch, because the thing it waits for is the agents themselves starting. A harness that never
// makes a call must not cost the whole run, so the wait has a ceiling and says which agent it gave
// up on: seeding late is a worse experiment, seeding never is no experiment at all.
if (scenario.seed?.length && scenario.seedWhen === "agents-ready") {
  (async () => {
    const started = Date.now();
    const CEILING_MS = 120_000;
    const waitingFor = () =>
      harnesses.filter((a) => {
        try {
          return Deno.statSync(`${a.dir}/trace.jsonl`).size === 0;
        } catch {
          return true; // no file yet: it has made no call
        }
      }).map((a) => a.name);
    let late: string[] = [];
    while ((late = waitingFor()).length > 0 && Date.now() - started < CEILING_MS) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const waited = Math.round((Date.now() - started) / 1000);
    await writeSeed();
    say(
      "lab",
      late.length
        ? `seed ${scenario.seed!.length} records after ${waited}s; gave up waiting for ${late.join(", ")}`
        : `seed ${scenario.seed!.length} records after ${waited}s, once every agent had made a call`,
    );
  })();
}
// A HEARTBEAT, because the quiet stretch is real: a harness can spend a minute starting before its
// first token, and silence has to be distinguishable from a stall.
const beat = setInterval(() => {
  const idle = harnesses.map((a) => a.name).join(", ");
  say("lab", `still running (${idle}); logs under ${runDir}`);
}, 30_000);
const results: { name: string; code: number | "timeout"; calls: number }[] = [];
if (scenario.sequential) {
  for (const a of harnesses) results.push(await runAgent(a));
} else {
  results.push(...await Promise.all(harnesses.map(runAgent)));
}
clearInterval(beat);
// The workers stop once the work does. Their evidence is already on disk; leaving them running
// would hold the space open and make `--keep` mean something different for them than for it.
stopWorkers();
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
// RUN TO AGENT, which nothing else in the evidence carries for every participant. A record's
// `createdBy` is a run, the traces pair a run with an agent only for the harnesses that HAVE a
// trace, and a background SDK worker has none: without this, "which participant wrote this record"
// is unanswerable for exactly the participant a bypass check is about (agent_docs/plan-agent-lab.md).
await collect("records.agent_run", ["query", "agent_run", "--json", "--limit", "500"]);
// BY THE PRINCIPAL, which is `agent:<name>` and not the member name the grants above are written
// under (line ~330). Asking about a name nothing holds is not an error: the space answers about a
// principal with no grants, so every member's permissions read `kinds: []` and the evidence said
// each of them held NOTHING while they were coordinating perfectly well.
for (const a of agents) await collect(`permissions.${a.name}`, ["permissions", `agent:${a.name}`, "--json"]);
await Deno.writeTextFile(`${runDir}/space.json`, JSON.stringify(collected, null, 2));

// THE SCENARIO AS RUN, resolved. The evidence held what happened and never what was ASKED: the
// prompts, the seeded work and the roles lived only in a file outside the run directory, which a
// reader coming back to it a week later does not have. Written with the models RESOLVED, so a run
// records the arm it actually was rather than the scenario's default.
await Deno.writeTextFile(
  `${runDir}/scenario.json`,
  JSON.stringify({ ...scenario, agents: scenario.agents.map((a) => ({ ...a, model: modelOf(a) || undefined })) }, null, 2),
);

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
const tally: Record<string, { calls: number; empty: number; errors: Record<string, number>; traced?: false }> = {};
for (const a of agents) {
  const text = await Deno.readTextFile(`${a.dir}/trace.jsonl`).catch(() => "");
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
  const per = tally[a.name] = { calls: lines.length, empty: 0, errors: {} as Record<string, number> };
  // AN SDK WORKER IS NOT TRACED, and zero is what a successful one prints. `--trace` sits in the
  // MCP adapter, so a `background` agent speaking the SDK directly leaves no line here whatever it
  // did: the first `team-exec` run read `lab-exec: 0 calls` on a failure and the second read the
  // same on a success. Whether it worked is a RECORD it authored, in space.json.
  if (a.background && lines.length === 0) (per as { traced?: false }).traced = false;
  for (const l of lines) {
    if (l.outcome === "empty") per.empty++;
    if (l.outcome === "error") per.errors[l.error ?? "unknown"] = (per.errors[l.error ?? "unknown"] ?? 0) + 1;
  }
}
/**
 * The model the harness says it USED, which is not always the one it was asked for.
 *
 * Asked and reported are recorded separately because an alias resolves on somebody else's side
 * (`--model sonnet` becomes whatever `sonnet` points at today) and a fallback can substitute a
 * different model mid-run without saying so in the argv. Claude Code names it in its final JSON;
 * Codex names none, and an absent value is reported as absent rather than assumed to be the ask.
 */
async function reportedModel(dir: string): Promise<string | undefined> {
  try {
    const path = `${dir}/stdout.log`;
    const size = (await Deno.stat(path)).size;
    let text: string;
    if (size > 2_000_000) {
      // The tail only: the summary is the LAST line, and a run that moved megabytes of artifact
      // through its transcript must not be read into memory to find it.
      using f = await Deno.open(path);
      await f.seek(size - 256_000, Deno.SeekMode.Start);
      text = new TextDecoder().decode(await new Response(f.readable).arrayBuffer().then((b) => new Uint8Array(b)));
    } else {
      text = await Deno.readTextFile(path);
    }
    return text.match(/"canonicalModel"\s*:\s*"([^"]+)"/)?.[1] ??
      text.match(/"modelUsage"\s*:\s*\{\s*"([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const reported: Record<string, string> = {};
for (const a of harnesses) {
  const m = await reportedModel(a.dir);
  if (m) reported[a.name] = m;
}
await Deno.writeTextFile(
  `${runDir}/tally.json`,
  JSON.stringify({
    scenario: scenario.name,
    models: { asked: models, reported },
    // WHO RAN AS THE OPERATOR, so a reader does not look for their records under their own name:
    // an operator step's writes are authored by `local:dev`, and a check counting authorship would
    // otherwise report a working deploy as a participant that did nothing.
    operators: agents.filter((a) => a.credential === "operator").map((a) => a.name),
    results,
    tally,
  }, null, 2),
);

console.log(`\ntool calls`);
for (const [name, t] of Object.entries(tally)) {
  if (t.traced === false) {
    console.log(`  ${name}: not traced (an SDK worker holds no adapter); what it did is in space.json`);
    continue;
  }
  const errs = Object.entries(t.errors).map(([k, n]) => `${k}×${n}`).join(" ");
  console.log(`  ${name}: ${t.calls} calls, ${t.empty} answered EMPTY${errs ? `, refused: ${errs}` : ""}`);
}
// The page, written now rather than by a second command somebody has to remember. Rendering reads
// only files this run already wrote, so a failure here costs the page and never the evidence.
let page: string | undefined;
try {
  page = await renderRun(runDir);
} catch (e) {
  console.log(`\n(no run.html: ${e instanceof Error ? e.message : String(e)}; the evidence is intact, run lab-report over it)`);
}

console.log(`\nevidence in ${runDir}/`);
if (page) console.log(`  run.html       what this run tried, how it went, and what broke  <- open this`);
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
