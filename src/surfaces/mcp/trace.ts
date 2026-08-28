// What the model ASKED FOR, which the space cannot see.
//
// A `take` appends its event only after it wins a record and a read appends none, so a claim that
// matched nothing is invisible to the event log, to lineage and to `radia flows`
// (agent_docs/plan-agent-lab.md). Every finding that shape has produced so far came from a human
// reading a transcript. This is the same evidence as data: one JSONL line per tool call.
//
// A FILE, NEVER RECORDS IN THE SPACE. Records would be the doctrinal choice and are the wrong one
// here: the space is the thing under observation, and trace records would land in its own flows,
// stats, event chain and registry budgets. Import the file into a SECOND space to query it.
//
// OFF unless `--trace <file>` is passed. The tracer is best-effort by construction: a failed write
// disables tracing for the rest of the process rather than failing the tool call, because an
// observation must never break the thing it observes.

import { appendTextFile } from "../../platform.ts";

/** How a call ended, from what the adapter can actually see.
 *  `empty` is the load-bearing one: it is the answer that looks like success and is why a pattern
 *  bug goes unnoticed (a claim that matched nothing reads as "no work"). */
export type Outcome = "ok" | "empty" | "error";

export interface TraceEntry {
  /** THE HARNESS's clock, never the space's. Nothing decides anything on this value: it orders a
   *  log for a human and for a later join against the event log, whose own `ts` is the DB clock. */
  ts: string;
  session?: string;
  principal?: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: Outcome;
  /** The runtime's own error code when there is one (`forbidden`, `undeclared_path`, …), which is
   *  what makes a refusal countable rather than a string to grep. */
  error?: string;
  /** Records in the answer, when the answer was a list. Absent when the result is not countable. */
  records?: number;
  ms: number;
}

/** Long values are TRUNCATED, not dropped: `space_put_artifact` carries base64 megabytes, and a
 *  trace nobody can open is a trace nobody reads. The marker states what was cut so a reader is
 *  never guessing whether an argument was short or shortened. */
const MAX_VALUE = 512;
function trim(v: unknown): unknown {
  if (typeof v === "string" && v.length > MAX_VALUE) return `${v.slice(0, MAX_VALUE)}…[${v.length} chars]`;
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trim(x)]));
  }
  return v;
}

/**
 * Classify a tool's answer without re-running it.
 *
 * The adapter's tools answer with TEXT, so this reads the text back. Deliberately NARROW: an empty
 * JSON array, and the two sentences the adapter itself writes for "found nothing". Anything it
 * cannot classify is `ok`, because over-reporting `empty` would put false findings in front of a
 * reader, and this file exists to make findings trustworthy.
 */
export function classify(text: string): { outcome: Outcome; records?: number } {
  if (/^nothing available for that pattern/.test(text)) return { outcome: "empty" };
  if (/^\{"found":false/.test(text)) return { outcome: "empty" };
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { outcome: parsed.length === 0 ? "empty" : "ok", records: parsed.length };
    if (parsed === null) return { outcome: "empty" };
    // A NARROWED answer wraps its list beside the scope (`render.ts`), so the count moved one level
    // in. Reading only the bare array would have called every scoped read `ok`, including the empty
    // ones, which is the measurement this file exists to make.
    if (parsed && typeof parsed === "object") {
      for (const key of ["records", "stats", "children", "lineage", "events"]) {
        const list = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(list)) return { outcome: list.length === 0 ? "empty" : "ok", records: list.length };
      }
    }
  } catch { /* not JSON: a sentence, a rendered table, or an error string */ }
  return { outcome: "ok" };
}

export interface Tracer {
  call(entry: Omit<TraceEntry, "ts">): void;
}

/** A tracer writing JSONL to `path`, or undefined when tracing is off. `log` reports the one-time
 *  failure; the caller passes its own logger so nothing here writes to stdout, which on this
 *  surface is the JSON-RPC channel. */
export function fileTracer(path: string, log: (s: string) => void): Tracer {
  let live = true;
  return {
    call(entry) {
      if (!live) return;
      try {
        appendTextFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry, args: trim(entry.args) })}\n`);
      } catch (e) {
        live = false;
        log(`radia mcp: tracing to ${path} failed (${(e as Error).message}); continuing untraced`);
      }
    },
  };
}
