#!/usr/bin/env -S deno run -A
// Replay a recorded lab run against a fresh binary, with no model and no tokens.
//
//   deno task lab-replay <run-dir>…            (add --binary ./radia if it is not built yet)
//
// WHAT THIS IS. A run directory holds what each model ASKED FOR, one JSONL line per tool call
// (`radia mcp --trace`). Those calls are a corpus no one would have written by hand: real sequences,
// with the arguments a real model chose. This re-issues them through a real `radia mcp` against a
// space built from the same scenario, and reports what a call ANSWERS today. Free, offline, and
// repeatable, which is the one thing the lab itself can never be.
//
// WHAT THIS IS NOT. It observes no model, so nothing it says is a finding about agent behaviour:
// every claim in agent_docs/research-agent-sessions.md is about a CHOICE, and a replay makes none.
// This is a regression suite for the adapter and the space, built out of the lab's leavings.
//
// THE VERDICT IS DELIBERATELY ASYMMETRIC, because a replay cannot reproduce a race. Two agents
// racing for one record settle it differently every time, and the untraced participants (a
// background worker, an operator script) are not re-run at all, so a population can legitimately
// differ. Only one direction is a regression: a call that was ANSWERED and now REFUSES or ERRORS.
// A population that changed is `diverged` and is reported, never failed. Over-reporting here would
// put false findings in front of a reader, which is the failure `report.ts` is also written against.
//
// Coverage is stated rather than implied: participants that were not re-run, and calls that could
// not be faithfully rebuilt, are counted and named. A replay that silently skipped half a trace
// while printing "no regressions" would be worse than no replay.

const argv = Deno.args;
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
/** Only these take a value, so a boolean flag does not swallow the directory after it. */
const VALUED = new Set(["--binary", "--wait"]);
const dirs = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));
const keep = argv.includes("--keep");
/** Live per-call output, on unless asked otherwise. Off inside a test, where the lines are noise. */
const quiet = argv.includes("--quiet");
/**
 * WHAT IS UNDER TEST, and the reason it is a choice. The lab runs a compiled binary because a
 * harness is handed one; a replay has no harness, so it can run the SOURCE and skip the compile.
 * `--source` is what makes this usable in CI and in a change-run-change loop, where a per-attempt
 * `deno task compile` is most of the wall clock. The adapter must be started the same way as the
 * space, or the run would test a stale build against fresh source and report the difference as a
 * regression in whichever half was older.
 */
export interface Build {
  cmd: string;
  pre: string[];
}
/** From source, deno is named rather than pathed (`Deno.execPath()`), so a permission allowlist can
 *  name it too: `scripts/agent-lab/replay.test.ts` runs under `--allow-run=…,deno`. */
export const SOURCE: Build = { cmd: "deno", pre: ["run", "-A", "src/main.ts"] };
const RADIA: Build = argv.includes("--source") ? SOURCE : { cmd: flag("--binary", "./radia")!, pre: [] };

/**
 * How long a call that WAITS is allowed to wait. Default 5 seconds, `--wait <n>` to change it.
 *
 * `space_watch` asks for what has not happened yet, and in a replay it never will: the record it
 * waits for was written by a participant this does not re-run, so every watch would burn its full
 * `timeoutSeconds` (120 in the corpus, five of them in one run) and the tool would look hung. So a
 * wait argument is CAPPED and the call is counted, which turns a ten-minute stall into a `diverged`
 * line saying the population is not here. A hard deadline sits behind it for anything that blocks
 * for a reason nobody predicted; the abandoned answer arrives later and is skipped on its id.
 */
const WAIT_CAP = Number(flag("--wait", "5"));
const WAIT_ARGS = ["timeoutSeconds"];
/** The tools that settle a claim, and so name a `claimId` this process minted rather than an id. */
const SETTLES = new Set(["space_ack", "space_nack", "space_release"]);

interface TraceLine {
  ts: string;
  session: string;
  principal?: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "empty" | "error";
  records?: number;
  error?: string;
}
interface AgentSpec {
  name: string;
  harness?: string;
  command?: string;
  background?: boolean;
  grants?: string[];
  unscopedGrants?: string[];
}
interface Scenario {
  name: string;
  team?: string;
  agents: AgentSpec[];
  kinds?: Record<string, unknown>[];
  seed?: { kind: string; body: Record<string, unknown> }[];
}
interface Rec { id: string; kind: string; body: Record<string, unknown> }

type Verdict = "ok" | "diverged" | "regressed" | "skipped";
interface Outcome {
  line: TraceLine;
  verdict: Verdict;
  was: string;
  now: string;
  why?: string;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

// ---- the adapter, over stdio ----------------------------------------------------

/** One `radia mcp` process, driven the way a harness drives it: newline-delimited JSON-RPC on
 *  stdin and stdout. No `initialize`, for the same reason `run.ts`'s `toolNames` sends none: the
 *  adapter answers a `tools/*` request in either protocol era. */
class Adapter {
  #child: Deno.ChildProcess;
  #w: WritableStreamDefaultWriter<Uint8Array>;
  #lines: AsyncIterableIterator<string>;
  #id = 0;

  constructor(cmd: string, args: string[], env: Record<string, string>) {
    this.#child = new Deno.Command(cmd, { args, env, stdin: "piped", stdout: "piped", stderr: "null" }).spawn();
    this.#w = this.#child.stdin.getWriter();
    this.#lines = lines(this.#child.stdout);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const id = ++this.#id;
    await this.#w.write(enc.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } })}\n`));
    // `next()` by hand rather than `for await`, which calls `return()` on the iterator when the
    // loop breaks and so CLOSES the stream: the first call would answer and every later one would
    // find a dead adapter. The session has to outlive one request.
    while (true) {
      const { value, done } = await this.#lines.next();
      if (done) return { text: "the adapter closed before answering", isError: true };
      let msg: { id?: number; result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
      try {
        msg = JSON.parse(value);
      } catch {
        continue; // not a frame we sent for
      }
      if (msg.id !== id) continue;
      if (msg.error) return { text: msg.error.message ?? "error", isError: true };
      const text = (msg.result?.content ?? []).map((c) => c.text ?? "").join("");
      return { text, isError: msg.result?.isError === true };
    }
  }

  async close() {
    await this.#w.close().catch(() => {});
    try {
      this.#child.kill("SIGTERM");
    } catch { /* already gone */ }
    await this.#child.status;
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) yield p;
  }
}

/** The trace's own classifier, re-implemented here rather than imported: `src/surfaces/mcp/trace.ts`
 *  is runtime code and this is a script, so importing it would tie a lab tool to a source path. The
 *  two must agree, and `scripts/agent-lab/replay.test.ts` holds them to the same answers. */
export function classify(text: string, isError: boolean): "ok" | "empty" | "error" {
  if (isError) return "error";
  if (/^nothing available for that pattern/.test(text)) return "empty";
  if (/^\{"found":false/.test(text)) return "empty";
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length === 0 ? "empty" : "ok";
    if (parsed === null) return "empty";
    if (parsed && typeof parsed === "object") {
      for (const key of ["records", "stats", "children", "lineage", "events", "kinds"]) {
        const list = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(list)) return list.length === 0 ? "empty" : "ok";
      }
    }
  } catch { /* a sentence, a table, or an error string */ }
  return "ok";
}

// ---- rebuilding an argument -----------------------------------------------------

const TRUNCATED = /^(.*)…\[(\d+) chars\]$/s;
const ID = /\b01[0-9A-HJKMNP-TV-Z]{24}\b/;

/** Every string the run's records contain, so a value the trace CUT can be recovered whole.
 *  `trace.ts` trims at 512 characters and states the original length, which leaves a prefix long
 *  enough to identify one string in practice; an ambiguous or absent match is reported, never
 *  guessed at. */
async function stringIndex(records: Rec[], dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  for (const r of records) walk(r.body);
  // THE BLOBS TOO, because a record never holds the bytes: a workspace manifest names artifacts by
  // digest, so a file a model wrote is in the blob store and nowhere else. Without this every
  // `space_save_workspace` in the corpus is unreplayable, which is most of what a workspace run is.
  // Text only, and bounded: a blob that is not UTF-8 is not a truncated argument's original.
  const text = new TextDecoder("utf-8", { fatal: true });
  for await (const f of walkFiles(`${dir}/space-blobs`)) {
    const bytes = await Deno.readFile(f).catch(() => null);
    if (!bytes || bytes.length > 1 << 18) continue;
    try {
      out.push(text.decode(bytes));
    } catch { /* binary: no argument was ever this */ }
  }
  return out;
}

async function* walkFiles(root: string): AsyncIterableIterator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    return; // no blob directory: an older run, or one that stored none
  }
  for (const e of entries) {
    const p = `${root}/${e.name}`;
    if (e.isDirectory) yield* walkFiles(p);
    else if (e.isFile) yield p;
  }
}

/** Rebuild one call's arguments. Returns the reason it cannot be rebuilt, or the arguments. */
function rebuild(
  args: unknown,
  strings: string[],
  ids: Map<string, string>,
  /** Every id the recorded run actually held, which is what separates a reference from a literal. */
  recorded: Set<string>,
): { args: unknown } | { skip: string } {
  if (typeof args === "string") {
    const m = TRUNCATED.exec(args);
    if (m) {
      const [, prefix, len] = m;
      const hits = strings.filter((s) => s.length === Number(len) && s.startsWith(prefix));
      if (hits.length !== 1) return { skip: `an argument of ${len} characters was cut in the trace and ${hits.length === 0 ? "is in no record" : "matches several"}` };
      return { args: hits[0] };
    }
    if (ID.test(args)) {
      const was = ID.exec(args)![0];
      const now = ids.get(was);
      if (now) return { args: args.replace(was, now) };
      // AN ID THE RECORDING NEVER HELD IS A LITERAL, passed through untouched: the queue scenarios
      // plant `01ZZZ…` for an agent to look up, and a model writes ids into the PROSE of its own
      // result bodies. Refusing those as unmapped skipped the probe the scenario exists to make and
      // the ack that carried it. Only an id the evidence shows as a real record, and that this
      // replay failed to recreate, is a gap worth reporting.
      if (!recorded.has(was)) return { args };
      return { skip: `names ${was}, a record this replay never created` };
    }
    return { args };
  }
  if (Array.isArray(args)) {
    const out: unknown[] = [];
    for (const v of args) {
      const r = rebuild(v, strings, ids, recorded);
      if ("skip" in r) return r;
      out.push(r.args);
    }
    return { args: out };
  }
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      const r = rebuild(v, strings, ids, recorded);
      if ("skip" in r) return r;
      out[k] = r.args;
    }
    return { args: out };
  }
  return { args };
}

/** Ids this call brought into existence, paired with the ones the original run made. Learned from
 *  the ANSWER, which is the only place either id appears: a `space_put` answers with the record it
 *  wrote, and a `space_take` with the claim it holds. Nothing is inferred from ordering. */
function learnIds(before: TraceLine, text: string, ids: Map<string, string>, records: Rec[]) {
  const now = text.match(new RegExp(ID.source, "g"));
  if (!now?.length) return;
  // BY CONTENT ADDRESS where there is one. An artifact answers with its digest, and identical bytes
  // hash the same here as they did then, so the pairing is exact rather than inferred. It also
  // covers the one write whose ARGUMENTS do not carry a body (`space_put_artifact` sends `text`),
  // which left an artifact unmapped and cascaded: the ack that named it, the fetch that read it and
  // the tool_call that dispatched it were all skipped over one missing id.
  try {
    const answered = JSON.parse(text) as { id?: string; digest?: string };
    if (answered?.id && answered.digest) {
      const same = records.find((r) => (r.body as { digest?: string }).digest === answered.digest && !ids.has(r.id));
      if (same) {
        ids.set(same.id, answered.id);
        return;
      }
    }
  } catch { /* not a JSON answer: fall through to the body match */ }
  // The original id for a write is the record whose BODY this call carried. Matched on the body
  // rather than on position, so a run whose calls interleaved differently still pairs correctly.
  const body = (before.args.body ?? before.args.resultBody) as Record<string, unknown> | undefined;
  if (!body) return;
  const same = records.filter((r) => bodyLooksLike(r.body, body));
  if (same.length === 1 && !ids.has(same[0].id)) ids.set(same[0].id, now[0]);
}

/** The claim a take just won, remembered against the record it holds, so the settle that follows can
 *  name it. Read from the ANSWER, which is the only place this run's claimId exists. */
function learnClaim(agent: string, text: string, claims: Map<string, Map<string, string>>) {
  try {
    const p = JSON.parse(text) as { claimId?: string; record?: { id?: string } };
    if (!p.claimId || !p.record?.id) return;
    const mine = claims.get(agent) ?? new Map<string, string>();
    mine.set(p.record.id, p.claimId);
    claims.set(agent, mine);
  } catch { /* not a claim: every other tool answers something else */ }
}

/** Equal on every scalar the trace kept. A trimmed string compares by prefix, and a field the
 *  runtime stamped afterwards (a team label the adapter filled in) is not held against the match. */
function bodyLooksLike(rec: Record<string, unknown>, asked: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(asked)) {
    const got = rec[k];
    if (typeof v === "string" && typeof got === "string") {
      const m = TRUNCATED.exec(v);
      if (m ? !got.startsWith(m[1]) : got !== v) return false;
    } else if (JSON.stringify(got) !== JSON.stringify(v)) return false;
  }
  return true;
}

// ---- the run --------------------------------------------------------------------

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return undefined;
  }
}

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

export async function replay(
  dir: string,
  /** WHICH BUILD, passed rather than read from `Deno.args`: imported by a test, this module's own
   *  argv is the test runner's, so a caller that wants source has no way to say so. */
  opts: { build?: Build; keep?: boolean; quiet?: boolean; wait?: number } = {},
): Promise<{ dir: string; outcomes: Outcome[]; notRerun: string[]; scenario: string } | undefined> {
  const build = opts.build ?? RADIA;
  const fromSource = build === SOURCE || build.pre.length > 0;
  const keepWork = opts.keep ?? keep;
  // LIVE, in the shape `run.ts` prints, because the two are read the same way and a replay of a
  // trace with waits in it is slow enough to look wedged. Same columns, same arrow: what changed is
  // that a call also carries what it ANSWERED LAST TIME, which is the only thing a replay adds.
  const quietly = opts.quiet ?? quiet;
  // A test waits as little as it can: the records a watch is waiting for cannot arrive here, so
  // every second of the cap is a second of the suite spent proving that again.
  const waitCap = opts.wait ?? WAIT_CAP;
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
  const scenario = await readJson<Scenario>(`${dir}/scenario.json`);
  const space = await readJson<Record<string, { records?: Rec[] }>>(`${dir}/space.json`);
  if (!scenario || !space) {
    console.error(`${dir}: needs scenario.json and space.json (runs older than the lab's phase 2 have no scenario)`);
    return undefined;
  }
  const records: Rec[] = [];
  for (const [k, v] of Object.entries(space)) if (k.startsWith("records.")) records.push(...(v.records ?? []));
  const strings = await stringIndex(records, dir);

  const traces = new Map<string, TraceLine[]>();
  for (const a of scenario.agents) {
    const text = await Deno.readTextFile(`${dir}/${a.name}/trace.jsonl`).catch(() => "");
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceLine);
    if (lines.length) traces.set(a.name, lines);
  }
  if (!traces.size) {
    console.error(`${dir}: no traces, so there is nothing to replay`);
    return undefined;
  }
  // NAMED, not silently dropped. A background worker or an operator script is not re-run here, so
  // the records it wrote are absent and a query that found them will find fewer. That is why a
  // changed population is `diverged` rather than a regression.
  const notRerun = scenario.agents.filter((a) => !traces.has(a.name)).map((a) => a.name);
  const width = Math.max(...scenario.agents.map((a) => a.name.length));
  const say = (who: string, what: string) => {
    if (!quietly) console.log(`${elapsed().padStart(5)} ${who.padEnd(width)} ${what}`);
  };

  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const work = await Deno.makeTempDir({ prefix: "radia-replay-" });
  const env = (extra: Record<string, string> = {}) => {
    const e = { ...Deno.env.toObject() };
    // The same isolation `run.ts` documents: an inherited token would make every member the
    // operator, and an inherited credentials path would point setup verbs at a developer's own space.
    delete e.RADIA_TOKEN;
    delete e.RADIA_DEFINITION_TOKEN;
    delete e.RADIA_SESSION;
    return { ...e, RADIA_DIR: `${work}/.radia`, RADIA_CREDENTIALS: `${work}/credentials.json`, ...extra };
  };
  const radia = async (args: string[]): Promise<string> => {
    const out = await new Deno.Command(build.cmd, { args: [...build.pre, ...args, "--url", base], env: env(), stdout: "piped", stderr: "piped" }).output();
    if (!out.success) throw new Error(`radia ${args.join(" ")}: ${dec.decode(out.stderr)}`);
    return dec.decode(out.stdout);
  };

  const server = new Deno.Command(build.cmd, {
    args: [...build.pre, "dev", "--port", String(port), "--db", `${work}/space`, "--auth", "required"],
    env: env(),
    stdout: "null",
    stderr: "null",
  }).spawn();
  const adapters = new Map<string, Adapter>();
  const stop = async () => {
    for (const a of adapters.values()) await a.close();
    try {
      server.kill("SIGTERM");
    } catch { /* already gone */ }
    await server.status;
    if (!keepWork) await Deno.remove(work, { recursive: true }).catch(() => {});
  };

  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/v0/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const team = scenario.team ?? "lab";
    if (!quietly) console.log(`space  ${base}  (replaying ${dir})`);
    for (const def of scenario.kinds ?? []) await radia(["put", "kind_def", JSON.stringify(def)]);
    if (!quietly && scenario.kinds?.length) console.log(`kinds  ${scenario.kinds.length} declared for this scenario`);
    for (const name of traces.keys()) {
      const spec = scenario.agents.find((a) => a.name === name)!;
      const raw = await radia(["team", "add", name, "--team", team, "--harness", "claude", "--rotate", "--json", ...(spec.grants ?? []).flatMap((g) => ["--grant", g])]);
      for (const g of spec.unscopedGrants ?? []) {
        const [kind, ops] = g.split(":");
        await radia(["put", "grant", JSON.stringify({ principal: `agent:${name}`, kind, operations: ops.split(",") })]);
      }
      const block = JSON.parse((JSON.parse(raw) as { members: { config: string }[] }).members[0].config) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      const server = Object.values(block.mcpServers)[0];
      // `--session <name>` as the lab passes it, so a claim survives the process exactly as it did
      // in the run being replayed.
      // The printed block names the BINARY that wrote it, which is right for a harness and wrong
      // here whenever `--source` is what is under test: the adapter has to be the same build as the
      // space it talks to.
      const cmd = fromSource ? build.cmd : server.command;
      const pre = fromSource ? [...build.pre, ...server.args.slice(server.args.indexOf("mcp"))] : server.args;
      adapters.set(name, new Adapter(cmd, [...pre, "--session", name], env({ RADIA_DEFINITION_TOKEN: server.env.RADIA_DEFINITION_TOKEN })));
    }
    // SEEDED WORK IS MAPPED AS IT IS WRITTEN, matched to the recorded run on its BODY. A seeded
    // record is authored by nobody any trace mentions, so without this every settle of seeded work
    // names an id this replay has never seen: measured, every `space_ack` in all three queue runs
    // was skipped, which is the one call a contention scenario exists to exercise.
    const ids = new Map<string, string>();
    for (const s of scenario.seed ?? []) {
      const body = { team, ...s.body };
      const newId = (await radia(["put", s.kind, JSON.stringify(body)])).trim();
      const was = records.find((r) => r.kind === s.kind && !ids.has(r.id) && bodyLooksLike(r.body, body));
      if (was && newId) ids.set(was.id, newId);
    }
    if (!quietly && scenario.seed?.length) console.log(`seed   ${scenario.seed.length} records written before any call`);
    if (!quietly && notRerun.length) console.log(`skip   ${notRerun.join(", ")} not re-run (no trace, so nothing to replay)`);

    // ONE ORDER, across every agent: the traces are separate files and the calls interleaved, so
    // replaying one agent to completion before the next would rebuild a history that never happened.
    const merged = [...traces.entries()].flatMap(([name, ls]) => ls.map((l) => ({ name, l })));
    merged.sort((a, b) => (a.l.ts < b.l.ts ? -1 : a.l.ts > b.l.ts ? 1 : 0));
    if (!quietly) console.log(`\nreplaying ${merged.length} call(s) in one timeline; → is a call reaching the space\n`);

    // A CLAIM IS THIS PROCESS'S, never the recording's: `claimId` is minted per take and the
    // adapter holds the lease behind it, so a settle has to name the claim THIS agent won here.
    // agent -> (record id in this replay -> claimId).
    const claims = new Map<string, Map<string, string>>();
    const recordIds = new Set(records.map((r) => r.id));
    const outcomes: Outcome[] = [];
    for (const { name, l } of merged) {
      // A SETTLE IS RESOLVED BEFORE THE GENERIC REBUILD, and lifted out of it: the claimId this
      // replay holds already names a record of THIS run, which the id map (recorded -> replayed)
      // cannot translate and would refuse as unmapped.
      let held: string | undefined;
      let asked = l.args as Record<string, unknown>;
      if (SETTLES.has(l.tool) && typeof asked.claimId === "string") {
        const wasRecord = ID.exec(asked.claimId)?.[0];
        const nowRecord = wasRecord ? ids.get(wasRecord) : undefined;
        held = nowRecord ? claims.get(name)?.get(nowRecord) : undefined;
        if (!held) {
          // The honest reading, and not "a record this replay never created": the record exists,
          // this agent just did not win it here. That is the race the verdict refuses to fail on.
          const why = `settles ${wasRecord ?? "a claim"}, which ${name} does not hold here (its take won a different record)`;
          outcomes.push({ line: l, verdict: "skipped", was: l.outcome, now: "-", why });
          say(name, `→ ${l.tool} skipped: ${why}`);
          continue;
        }
        asked = { ...asked };
        delete asked.claimId;
      }
      // A LOCAL FILE IS NOT PART OF THE EVIDENCE. `space_put_artifact` can name a path on the
      // machine that recorded the run (a harness writes a generated image beside its own config),
      // and that file does not travel with the run directory. Replayed elsewhere the call fails,
      // and since the recording answered `ok` it would be reported as a REGRESSION: a false finding
      // caused by a missing file, which is the one thing this tool must never produce.
      if (l.tool === "space_put_artifact" && typeof asked.path === "string") {
        const there = await Deno.stat(asked.path).then(() => true, () => false);
        if (!there) {
          const why = `names ${asked.path}, a file on the machine that recorded this run`;
          outcomes.push({ line: l, verdict: "skipped", was: l.outcome, now: "-", why });
          say(name, `→ ${l.tool} skipped: ${why}`);
          continue;
        }
      }
      const built = rebuild(asked, strings, ids, recordIds);
      if ("skip" in built) {
        outcomes.push({ line: l, verdict: "skipped", was: l.outcome, now: "-", why: built.skip });
        say(name, `→ ${l.tool} skipped: ${built.skip}`);
        continue;
      }
      const callStarted = Date.now();
      const args = built.args as Record<string, unknown>;
      if (held) args.claimId = held;
      let capped = false;
      for (const k of WAIT_ARGS) {
        if (typeof args[k] === "number" && (args[k] as number) > waitCap) {
          args[k] = waitCap;
          capped = true;
        }
      }
      // The backstop, for a call that blocks on something no argument names. Abandoned rather than
      // waited out: its answer arrives later and is skipped on its id, so the session stays usable.
      const res = await Promise.race([
        adapters.get(name)!.call(l.tool, args),
        new Promise<{ text: string; isError: boolean } | null>((r) => setTimeout(() => r(null), (waitCap + 10) * 1000)),
      ]);
      if (!res) {
        outcomes.push({ line: l, verdict: "skipped", was: l.outcome, now: "-", why: `no answer within ${waitCap + 10}s` });
        say(name, `→ ${l.tool} skipped: no answer within ${waitCap + 10}s`);
        continue;
      }
      const now = classify(res.text, res.isError);
      learnIds(l, res.text, ids, records);
      learnClaim(name, res.text, claims);
      const regressed = now === "error" && l.outcome !== "error";
      // A capped wait cannot regress: it was told to give up sooner than the recording did, so an
      // answer it did not get is this tool's doing and not the space's.
      if (capped && now === "empty" && l.outcome !== "empty") {
        const why = `waited ${waitCap}s instead of ${l.args.timeoutSeconds}s; nothing here writes what it waited for`;
        outcomes.push({ line: l, verdict: "diverged", was: l.outcome, now, why });
        say(name, `→ ${l.tool} ${now}  was ${l.outcome} (${why})`);
        continue;
      }
      const verdict: Verdict = regressed ? "regressed" : now === l.outcome ? "ok" : "diverged";
      outcomes.push({ line: l, verdict, was: l.outcome, now, ...(regressed ? { why: res.text.slice(0, 300) } : {}) });
      // The recorded answer travels on the line whenever it differs, because "empty" alone reads as
      // a finding and "empty, and it was empty then too" reads as the non-event it is.
      const count = l.records !== undefined ? ` (${l.records} records then)` : "";
      say(
        name,
        verdict === "regressed"
          ? `→ ${l.tool} REGRESSED ${now}  was ${l.outcome}: ${res.text.slice(0, 160)}`
          : `→ ${l.tool} ${now}${verdict === "diverged" ? `  was ${l.outcome}${count}` : ""} ${Date.now() - callStarted}ms`,
      );
    }
    return { dir, outcomes, notRerun, scenario: scenario.name };
  } finally {
    await stop();
  }
}

// ---- the driver -----------------------------------------------------------------

if (import.meta.main) {
  if (!dirs.length) {
    console.error("usage: deno task lab-replay <run-dir>… [--binary ./radia] [--keep]");
    Deno.exit(2);
  }
  let regressions = 0;
  // COUNTED APART FROM REGRESSIONS, because they are different answers to different questions: one
  // says the space changed, the other says this directory could not be asked. Adding them made a
  // run with no `scenario.json` print "1 call(s) answered before and refuse now", naming a cause
  // for a missing file. Still non-zero at the end: a directory the caller named and this silently
  // skipped is the "a set of 70 becomes 44" failure the index page already refuses.
  const unreplayable: string[] = [];
  for (const dir of dirs) {
    const r = await replay(dir.replace(/\/+$/, ""));
    if (!r) {
      unreplayable.push(dir);
      continue;
    }
    const tally = (v: Verdict) => r.outcomes.filter((o) => o.verdict === v).length;
    console.log(`\n${"=".repeat(78)}\n${r.scenario}  ${r.dir}`);
    console.log(`  ${r.outcomes.length} calls: ${tally("ok")} ok, ${tally("diverged")} diverged, ${tally("skipped")} skipped, ${tally("regressed")} regressed`);
    if (r.notRerun.length) console.log(`  not re-run: ${r.notRerun.join(", ")} (their records are absent, so a population may differ)`);
    for (const o of r.outcomes) {
      if (o.verdict === "ok") continue;
      // Live output already showed every one of these as it happened, so repeating them here would
      // double a long run. A REGRESSION is repeated on purpose: it is what the reader came for and
      // what scrolled furthest away.
      if (!quiet && o.verdict !== "regressed") continue;
      const mark = o.verdict === "regressed" ? "REGRESSED" : o.verdict === "diverged" ? "diverged " : "skipped  ";
      console.log(`   ${mark} ${o.line.session} ${o.line.tool}: ${o.was} -> ${o.now}${o.why ? `  ${o.why}` : ""}`);
    }
    regressions += tally("regressed");
  }
  if (unreplayable.length) {
    console.log(
      `\n${unreplayable.length} of ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} could not be replayed: ${
        unreplayable.join(", ")
      }.\nA run recorded before the lab wrote \`scenario.json\` cannot be rebuilt, only read: \`deno task lab-report <dir>\`.`,
    );
  }
  if (regressions) {
    console.log(
      `\n${regressions} call(s) answered before and refuse now. A replay observes no model, so this is a regression in the adapter or the space, never a finding about an agent.`,
    );
  } else if (unreplayable.length < dirs.length) {
    console.log("\nno regressions: every recorded call that was answered is answered still.");
  }
  Deno.exit(regressions || unreplayable.length ? 1 : 0);
}
