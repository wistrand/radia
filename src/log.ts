// Process logging: what THIS PROCESS did, which no record can tell you.
//
// The space already answers "what happened to the records" three ways (the event log, lineage,
// mined flows), and `radia mcp --trace` answers "what did the model ask for". None of them answers
// "what did this build do at 02:00": which credential resolved, why a sweep took nine seconds,
// which grant refused a write, what the config parsed to. That was 40 bare `console.log` calls with
// no level, no source, no destination and no way to turn any of it on or off.
//
// THE LINE AGAINST THE EVENT LOG, and it is the one rule that keeps this from becoming a second
// one: if another AGENT could need it, it is a RECORD; if only an operator debugging this process
// needs it, it is a log. A log line about a record is a hint for a human, never state anybody reads
// back.
//
// STDERR, ALWAYS, unless a file is named. `radia mcp` speaks JSON-RPC on stdout, so a log line
// there corrupts the stream and the harness sees a dead server. Routed through `platform.ts` like
// every other host operation, which is also what lets the browser backend take it.
//
// SYNCHRONOUS, AND LOST LINES ARE LOST. A queue with a flush is a second failure mode in a process
// whose job is somebody else's coordination; `--trace` made the same call for the same reason.
//
// It reads NO configuration. `src/main.ts` configures it once, before anything can log, which is
// what keeps `src/core` from importing a surface's flag parsing to be able to say something.

import { appendTextFile, writeStderr } from "./platform.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Four levels, not six. `trace` and `fatal` are the two this codebase cannot honestly
 *  distinguish: a trace is what `--trace` already is, and only `main.ts` may end the process, so
 *  nothing else can report a fatality. */
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  /** The component, from `getLogger(name)`: `core.space`, `server.http`, `mcp`. */
  source?: string;
  message: string;
  /** Structured detail. An `error` key is rendered specially, message and stack, because that is
   *  the field a reader always wants unfolded. */
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Guard for a message whose CONTEXT is expensive to build (a record body, a scan summary). */
  isDebug(): boolean;
  child(name: string): Logger;
}

export interface LogConfig {
  level?: LogLevel;
  /** Append JSONL here as well as writing text to stderr. An unwritable path disables the file and
   *  says so once: an observation must never break the thing it observes. */
  file?: string;
  /** Overridden by tests and by anything that wants the lines without a terminal. */
  sink?: (line: string) => void;
  /** Entries kept for `recentLogs`, which is what lets `radia doctor` show a tail with no file. */
  buffer?: number;
}

let level: LogLevel = "info";
let file: string | undefined;
let fileLive = false;
let sink: (line: string) => void = (line) => writeStderr(line);
let bufferMax = 200;
const buffer: LogEntry[] = [];

/** Configure once, from `src/main.ts`, before anything logs. Calling it again replaces the whole
 *  configuration, which is what a test wants and what a long-running process never does. */
export function configureLogging(cfg: LogConfig = {}): void {
  level = cfg.level ?? level;
  file = cfg.file;
  fileLive = file !== undefined;
  if (cfg.sink) sink = cfg.sink;
  if (cfg.buffer !== undefined) bufferMax = Math.max(0, cfg.buffer);
  buffer.length = 0;
}

/** The last entries, newest last. For `radia doctor` and for a test that wants to assert on what
 *  was said rather than on where it went. */
export function recentLogs(count?: number): LogEntry[] {
  return count === undefined || count >= buffer.length ? [...buffer] : buffer.slice(-count);
}

export function logLevel(): LogLevel {
  return level;
}

/** `debug`/`info`/`warn`/`error`, or undefined for anything else: a bad `--log-level` is the
 *  caller's to report, so this only decides whether the word is one. */
export function parseLevel(word: string | undefined): LogLevel | undefined {
  return word && word in RANK ? word as LogLevel : undefined;
}

function render(e: LogEntry): string {
  const parts = [e.ts.slice(11, 23), e.level.toUpperCase().padEnd(5), e.source ?? "-", e.message];
  let line = parts.join(" ");
  const ctx = e.context ?? {};
  const extra = Object.entries(ctx).filter(([k]) => k !== "error");
  if (extra.length > 0) line += ` | ${extra.map(([k, v]) => `${k}=${short(v)}`).join(" ")}`;
  if ("error" in ctx) {
    const err = ctx.error;
    line += ` | error: ${err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ""}` : String(err)}`;
  }
  return `${line}\n`;
}

/** One value, bounded. A log line carrying a whole record body is a line nobody reads. */
function short(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function emit(entry: LogEntry): void {
  if (bufferMax > 0) {
    buffer.push(entry);
    while (buffer.length > bufferMax) buffer.shift();
  }
  try {
    sink(render(entry));
  } catch { /* a sink that throws must not take the caller down */ }
  if (!fileLive || !file) return;
  try {
    // JSONL to the file, text to the terminal: one is read by a person and the other by a program,
    // and a format that serves both serves neither.
    appendTextFile(file, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    fileLive = false;
    try {
      sink(render({
        ts: new Date().toISOString(),
        level: "warn",
        source: "log",
        message: `logging to ${file} failed; continuing without the file`,
        context: { error: e },
      }));
    } catch { /* nothing left to say it with */ }
  }
}

function make(source?: string): Logger {
  const at = (lvl: LogLevel) => (message: string, context?: Record<string, unknown>) => {
    if (RANK[lvl] < RANK[level]) return;
    emit({ ts: new Date().toISOString(), level: lvl, source, message, context });
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    isDebug: () => RANK.debug >= RANK[level],
    child: (name: string) => make(source ? `${source}.${name}` : name),
  };
}

const root = make();

/** A component logger. Cached, so a hot path can call this rather than hold a field. */
const loggers = new Map<string, Logger>();
export function getLogger(name: string): Logger {
  const memo = loggers.get(name);
  if (memo) return memo;
  const made = root.child(name);
  loggers.set(name, made);
  return made;
}

/** The unnamed logger, for a call site with no obvious component. */
export const log: Logger = root;
