// `team.json`: the members `radia team up` runs as workers, and how each harness is launched.
//
// The file names WHO (a member `radia team add` minted), WHAT they claim (patterns), and HOW the
// harness starts (a command template per harness). The templates are the non-interactive
// invocations the agent lab has run real harnesses with; they change on somebody else's release
// schedule, which is why a file may override them and why nothing here verifies them.

import type { Pattern } from "../../sdk/ts/client.ts";
import { UsageError } from "../platform.ts";

export interface TeamFileMember {
  /** The member's name as given to `radia team add` (with or without `agent:`). */
  name: string;
  /** `claude`, `codex`, or a key in `harnesses`. */
  harness: string;
  model?: string;
  /** What this member claims. Default `[{kind: "task"}]`, which the member's own grant pattern
   *  narrows to its team. */
  patterns?: Pattern[];
  prompt?: string;
  /** The prompt as a file beside `team.json`, for a prompt too long for a JSON string. */
  promptFile?: string;
  /** Keep ONE harness session per member across claims (`claude --resume`, `codex exec resume`),
   *  so a later move starts with the earlier ones in context. Costs grow with the session and a
   *  session that failed is dropped rather than resumed. Default false: a fresh process per claim. */
  resume?: boolean;
  /** The prompt for a RESUMED session, which already holds the earlier moves; defaults to
   *  `prompt`. `resumePromptFile` reads it from beside the file. */
  resumePrompt?: string;
  resumePromptFile?: string;
  /** Wrap the prompt in the FRAME (`FRAME`, `RESUME_FRAME`: who you are, the record, the claim and
   *  the three moves as exact calls), so the prompt is only the game. Default true. */
  frame?: boolean;
  timeoutSeconds?: number;
  leaseSeconds?: number;
  concurrency?: number;
  cwd?: string;
  /** The MCP session name the harness resumes, so it shares the loop's run. Default: the name. */
  session?: string;
  env?: Record<string, string>;
  /** A command of this member's own, in place of the harness template. */
  command?: string[];
  /** The durable half, for a file written where `radia team add` did not run. Otherwise the token
   *  `team add` stored on this machine is used. */
  definitionToken?: string;
  /** A JSONL file the launched adapter appends one line per tool call to (`radia mcp --trace`),
   *  which is how the agent lab sees what a launched harness ASKED FOR. */
  trace?: string;
}

export interface SeedRecord {
  kind: string;
  body: Record<string, unknown>;
  parentIds?: string[];
}

export interface TeamFile {
  url?: string;
  /** The team label every member's grants are scoped to, and every seed carries. Default `default`. */
  team?: string;
  members: TeamFileMember[];
  harnesses?: Record<string, { command: string[] }>;
  /** Records the operator writes to start the work (`radia team up --seed`), the team label added. */
  seed?: SeedRecord[];
  /** What the FINAL ANSWER looks like: a pattern. `radia team up` exits once a record matching it
   *  is written after the run started, printing that record, so a run with an end ends itself.
   *  The team label is added to the match. */
  done?: Pattern;
  /** Where the file was read from, so `promptFile` resolves beside it. Set by `loadTeamFile`. */
  dir?: string;
}

const MEMBER_FIELDS = new Set([
  "name",
  "harness",
  "model",
  "patterns",
  "prompt",
  "promptFile",
  "resume",
  "resumePrompt",
  "resumePromptFile",
  "frame",
  "timeoutSeconds",
  "leaseSeconds",
  "concurrency",
  "cwd",
  "session",
  "env",
  "command",
  "definitionToken",
  "trace",
]);
const FILE_FIELDS = new Set(["url", "team", "members", "harnesses", "seed", "done"]);

/**
 * The command templates. Placeholders: `{{model}}` (its flag is dropped when no model is set),
 * `{{config}}` (an MCP config JSON file naming the adapter with the member's token and session),
 * `{{binary}}`/`{{mcpArgs}}`/`{{token}}`/`{{credentials}}`/`{{radiaDir}}` (the same, for a harness
 * configured on its command line; the file and directory are what let the adapter resume the
 * loop's session, since a harness passes its MCP server only the env it is given),
 * `{{codexTools}}` (Codex's per-tool approval table), `{{prompt}}` (in argv; absent, stdin).
 */
export const BUILTIN_HARNESSES: Record<string, string[]> = {
  /** Claude Code: `--session-id` names the session on its first run, `--resume` continues it. */
  "claude-first": [
    "claude",
    "-p",
    "--session-id",
    "{{harnessSession}}",
    "--model",
    "{{model}}",
    "--mcp-config",
    "{{config}}",
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__radia",
    "--output-format",
    "json",
  ],
  "claude-resume": [
    "claude",
    "-p",
    "--resume",
    "{{harnessSession}}",
    "--model",
    "{{model}}",
    "--mcp-config",
    "{{config}}",
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__radia",
    "--output-format",
    "json",
  ],
  claude: [
    "claude",
    "-p",
    "--model",
    "{{model}}",
    "--mcp-config",
    "{{config}}",
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__radia",
    "--output-format",
    "json",
  ],
  codex: [
    "codex",
    "exec",
    "-",
    "--json",
    "-m",
    "{{model}}",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-s",
    "workspace-write",
    "-c",
    "mcp_servers.radia.command={{binary}}",
    "-c",
    "mcp_servers.radia.args={{mcpArgs}}",
    "-c",
    'mcp_servers.radia.env={ RADIA_DEFINITION_TOKEN = "{{token}}", RADIA_CREDENTIALS = "{{credentials}}", RADIA_DIR = "{{radiaDir}}" }',
    "-c",
    "mcp_servers.radia.tools={{codexTools}}",
  ],
  /** Codex: the first run is `exec` as above (its thread id is read from the `thread.started`
   *  event it prints), later runs `exec resume <id> -` with the same config. */
  // `exec resume` takes no `-s`: the sandbox is the `sandbox_mode` config key there (the first
  // run's argument set was rejected with "unexpected argument '-s'", 2026-09-05).
  "codex-resume": [
    "codex",
    "exec",
    "resume",
    "{{harnessSession}}",
    "-",
    "--json",
    "-m",
    "{{model}}",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "mcp_servers.radia.command={{binary}}",
    "-c",
    "mcp_servers.radia.args={{mcpArgs}}",
    "-c",
    'mcp_servers.radia.env={ RADIA_DEFINITION_TOKEN = "{{token}}", RADIA_CREDENTIALS = "{{credentials}}", RADIA_DIR = "{{radiaDir}}" }',
    "-c",
    "mcp_servers.radia.tools={{codexTools}}",
  ],
};

/** The template a member's launch uses: with `resume`, the harness's first-run and resume
 *  variants where they exist, else the plain one. `{{harnessSession}}` stays for the worker,
 *  which owns the id. */
export function harnessTemplates(
  harness: string,
  resume: boolean,
  custom?: Record<string, { command: string[] }>,
): { first: string[]; resume?: string[] } {
  const own = custom?.[harness]?.command ?? BUILTIN_HARNESSES[harness];
  if (!resume) return { first: own };
  const first = custom?.[`${harness}-first`]?.command ?? BUILTIN_HARNESSES[`${harness}-first`] ?? own;
  const later = custom?.[`${harness}-resume`]?.command ?? BUILTIN_HARNESSES[`${harness}-resume`];
  return { first, resume: later };
}

/**
 * THE FRAME: the mechanics every launched harness needs, wrapped around a team's own prompt so the
 * prompt is only the game. It names who the harness is, the record it was started for, the claim
 * it may settle, the three moves (answer, hand on, give back) as exact calls, and the one rule a
 * launcher needs: one record per launch. The team's prompt follows under "Your job", and a
 * resumed session gets the shorter frame, since it holds the earlier moves already.
 */
export const FRAME = [
  "You are {{agent}}, a worker on a shared Radia space, started because this {{kind}} record was",
  "claimed for you (record {{recordId}}):",
  "",
  "{{body}}",
  "",
  "HOW TO ACT. Use the radia MCP tools for everything you read or write, and nothing else in the",
  "space needs discovering: do not list kinds, workspaces or artifacts. The claim is held for you as",
  "claimId \"{{claimId}}\". Three moves exist, and the last two go in ONE turn:",
  "  read:    space_lineage {recordId: \"{{recordId}}\"} is everything that led here, and",
  "           space_children {recordId: <a record>} is what was answered on it.",
  "  answer:  space_ack {claimId: \"{{claimId}}\", resultKind: \"note\", resultBody: {…}} settles",
  "           the claim; the body is your answer and reaches whoever asked.",
  "  hand on: space_put {kind: \"task\", body: {…, tags: [<who is next>]}, parentIds: [\"{{recordId}}\"]}",
  "           gives the next move to another member; omit it when there is no next move.",
  "  give back: space_nack {claimId: \"{{claimId}}\"} only if the work cannot be done at all.",
  "Anything you write takes the RECORD id as its parent, never the claim id. Never claim any other",
  "task: this launcher hands you one record at a time. Do not think out loud between calls. Stop",
  "once the claim is settled, with one line saying what you did.",
  "",
  "YOUR JOB.",
  "{{job}}",
].join("\n");

/** The frame for a RESUMED session, which holds the earlier moves already: no re-orientation. */
export const RESUME_FRAME = [
  "Next move, same game. The claimed record ({{recordId}}):",
  "",
  "{{body}}",
  "",
  "Claim: \"{{claimId}}\". Read only what is new since your last move (space_children on the task",
  "you put last, one call), then answer (space_ack) and hand on (space_put, parentIds",
  "[\"{{recordId}}\"]) in ONE turn. Stop with one line.",
  "",
  "{{job}}",
].join("\n");

/** A team with no prompt of its own: the frame around the plainest job. */
export const DEFAULT_JOB = "Do what the record asks and answer through the space.";

/** A prompt as the harness sees it: the frame with the team's prompt as the job, unless the
 *  member turned the frame off (`frame: false`), in which case the prompt is used as it is. */
export function framePrompt(job: string | undefined, frame: boolean, resumed: boolean): string {
  const body = job ?? DEFAULT_JOB;
  if (!frame) return body;
  return (resumed ? RESUME_FRAME : FRAME).replace("{{job}}", body);
}

function fail(where: string, msg: string): never {
  throw new UsageError(`${where}: ${msg}`);
}

/** Parse and validate the file. Unknown fields are refused BY NAME, since a misspelled one that
 *  narrows (a pattern, a timeout) would otherwise widen silently. */
export function parseTeamFile(text: string, where = "team.json"): TeamFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(where, `not JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(where, "expected an object");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!FILE_FIELDS.has(k)) fail(where, `unknown field '${k}' (fields: ${[...FILE_FIELDS].join(", ")})`);
  if (obj.url !== undefined && typeof obj.url !== "string") fail(where, "'url' must be a string");
  if (obj.team !== undefined && (typeof obj.team !== "string" || !obj.team)) fail(where, "'team' must be a non-empty string");
  if (obj.done !== undefined && (!obj.done || typeof obj.done !== "object" || typeof (obj.done as Pattern).kind !== "string")) {
    fail(where, "'done' must be a pattern naming a kind, e.g. {\"kind\": \"note\", \"match\": {\"topic\": \"final\"}}");
  }
  const seed: SeedRecord[] = [];
  if (obj.seed !== undefined) {
    if (!Array.isArray(obj.seed)) fail(where, "'seed' must be an array of {kind, body}");
    obj.seed.forEach((r, i) => {
      const rr = r as Record<string, unknown>;
      if (!rr || typeof rr !== "object" || typeof rr.kind !== "string" || !rr.body || typeof rr.body !== "object") fail(where, `seed[${i}] must be {kind, body}`);
      for (const k of Object.keys(rr)) if (!["kind", "body", "parentIds"].includes(k)) fail(where, `seed[${i}]: unknown field '${k}'`);
      seed.push(rr as unknown as SeedRecord);
    });
  }
  if (!Array.isArray(obj.members) || obj.members.length === 0) fail(where, "'members' must be a non-empty array");
  const harnesses: Record<string, { command: string[] }> = {};
  if (obj.harnesses !== undefined) {
    if (!obj.harnesses || typeof obj.harnesses !== "object" || Array.isArray(obj.harnesses)) fail(where, "'harnesses' must be an object");
    for (const [name, h] of Object.entries(obj.harnesses as Record<string, unknown>)) {
      const cmd = (h as { command?: unknown })?.command;
      if (!Array.isArray(cmd) || !cmd.length || !cmd.every((s) => typeof s === "string")) fail(where, `harnesses.${name}.command must be a non-empty array of strings`);
      const extra = Object.keys(h as object).filter((k) => k !== "command");
      if (extra.length) fail(where, `harnesses.${name}: unknown field '${extra[0]}'`);
      harnesses[name] = { command: cmd as string[] };
    }
  }
  const members: TeamFileMember[] = [];
  const seen = new Set<string>();
  obj.members.forEach((m, i) => {
    const at = `members[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) fail(where, `${at} must be an object`);
    const mm = m as Record<string, unknown>;
    for (const k of Object.keys(mm)) if (!MEMBER_FIELDS.has(k)) fail(where, `${at}: unknown field '${k}' (fields: ${[...MEMBER_FIELDS].join(", ")})`);
    if (typeof mm.name !== "string" || !mm.name) fail(where, `${at}.name must be a non-empty string`);
    if (typeof mm.harness !== "string" || !mm.harness) fail(where, `${at}.harness must name a harness (claude, codex, or a key in 'harnesses')`);
    if (!(mm.harness in BUILTIN_HARNESSES) && !(mm.harness in harnesses) && !Array.isArray(mm.command)) {
      fail(where, `${at}.harness '${mm.harness}' is not built in and not in 'harnesses'`);
    }
    if (mm.resume !== undefined && typeof mm.resume !== "boolean") fail(where, `${at}.resume must be true or false`);
    if (mm.frame !== undefined && typeof mm.frame !== "boolean") fail(where, `${at}.frame must be true or false`);
    for (const k of ["model", "prompt", "promptFile", "resumePrompt", "resumePromptFile", "cwd", "session", "definitionToken", "trace"]) {
      if (mm[k] !== undefined && typeof mm[k] !== "string") fail(where, `${at}.${k} must be a string`);
    }
    for (const k of ["timeoutSeconds", "leaseSeconds", "concurrency"]) {
      if (mm[k] !== undefined && (typeof mm[k] !== "number" || !(mm[k] as number > 0))) fail(where, `${at}.${k} must be a positive number`);
    }
    if (mm.patterns !== undefined) {
      if (!Array.isArray(mm.patterns) || !mm.patterns.length) fail(where, `${at}.patterns must be a non-empty array`);
      for (const p of mm.patterns) if (!p || typeof p !== "object" || typeof (p as Pattern).kind !== "string") fail(where, `${at}.patterns: every pattern names a kind`);
    }
    if (mm.command !== undefined && (!Array.isArray(mm.command) || !mm.command.length || !mm.command.every((s) => typeof s === "string"))) {
      fail(where, `${at}.command must be a non-empty array of strings`);
    }
    if (mm.env !== undefined && (!mm.env || typeof mm.env !== "object" || Object.values(mm.env as object).some((v) => typeof v !== "string"))) {
      fail(where, `${at}.env must map names to strings`);
    }
    const name = (mm.name as string).replace(/^agent:/, "");
    if (seen.has(name)) fail(where, `${at}: '${name}' is listed twice; one member per worker`);
    seen.add(name);
    members.push({ ...(mm as unknown as TeamFileMember), name });
  });
  return { url: obj.url as string | undefined, team: obj.team as string | undefined, members, harnesses, seed, done: obj.done as Pattern | undefined };
}

/**
 * A team as a DIRECTORY or a file: `radia team up examples/teams/twenty-questions` reads that
 * directory's `team.json`, and a member's `promptFile` resolves beside it, so a team is one folder
 * that can be copied. `read` is injected because this module knows no platform.
 */
export function loadTeamFile(path: string, read: (p: string) => string | undefined): TeamFile {
  const isDir = !path.endsWith(".json");
  const file = isDir ? `${path.replace(/\/$/, "")}/team.json` : path;
  const text = read(file);
  if (text === undefined) throw new UsageError(`${file}: not found. A team is a directory holding team.json (see examples/teams/)`);
  const team = parseTeamFile(text, file);
  team.dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  for (const m of team.members) {
    for (const [fileKey, promptKey] of [["promptFile", "prompt"], ["resumePromptFile", "resumePrompt"]] as const) {
      const rel = m[fileKey];
      if (!rel) continue;
      const at = rel.startsWith("/") ? rel : `${team.dir}/${rel}`;
      const text = read(at);
      if (text === undefined) throw new UsageError(`${file}: members '${m.name}' names ${fileKey} ${rel}, which is not beside it`);
      m[promptKey] = text;
    }
  }
  return team;
}

/** Fill a command template. `{{model}}` with no model drops the flag before it as well, the way
 *  the lab does, since `--model ""` is a different request from no flag. */
export function substitute(argv: string[], values: Record<string, string>): string[] {
  const filled = argv.map((s) => s.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k === "prompt" || k === "harnessSession" ? m : (values[k] ?? m))));
  if (!values.model) {
    const at = argv.findIndex((s) => s === "{{model}}");
    if (at > 0) filled.splice(at - 1, 2);
    else if (at === 0) filled.splice(0, 1);
  }
  return filled;
}
