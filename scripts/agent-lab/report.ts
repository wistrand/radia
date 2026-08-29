#!/usr/bin/env -S deno run -A
// Phase 2 of the lab (agent_docs/plan-agent-lab.md): read run directories and print ranked
// findings, so a run stops being a directory somebody has to know how to interrogate.
//
// EVERYTHING HERE IS COMPUTED FROM EVIDENCE ALREADY COLLECTED. No new instrumentation: the event
// log gives claim history per record, the traces give what each model ASKED FOR, `space.json` gives
// the records and the mined flows, `tally.json` gives models and exit codes. That is deliberate,
// because the alternative (asking the agent whether it followed the intended path) is the third
// evidence source and the weakest one.
//
// TWO MODES, and the second is the point. One directory prints that run. Several print RATES, which
// is what a finding actually is here: the same scenario with the same models produces different
// choices, so a single run is an anecdote (`agent_docs/research-agent-sessions.md`). A PAIRED run
// is two sets of directories, one variable moved between them.
//
// A CLIENT of the evidence, never of the space: it starts nothing and reads no credential.

// Also IMPORTED, by `run.ts`, which renders a run's page the moment it finishes. So everything
// below is definitions, and nothing runs until the driver at the bottom, under `import.meta.main`.
const argv = Deno.args;

// ---- the evidence -------------------------------------------------------------

interface Event {
  seq: number;
  ts: string;
  runId: string;
  operation: string;
  recordId: string;
  kind: string;
  state?: string;
}
interface Rec {
  id: string;
  kind: string;
  body: Record<string, unknown>;
  runtimeMeta: { createdBy: string; parentIds?: string[]; createdAt: string };
}
interface TraceLine {
  ts: string;
  session: string;
  principal?: string;
  tool: string;
  args?: Record<string, unknown>;
  outcome: string;
  error?: string;
  ms?: number;
}
interface Flow {
  signature: string;
  occurrences: number;
  outcomes: { complete: number; open: number; failed: number };
}
interface Run {
  dir: string;
  scenario: string;
  models: { asked: Record<string, string>; reported: Record<string, string> };
  results: { name: string; code: number | string; calls: number }[];
  events: Event[];
  records: Rec[];
  flows: Flow[];
  traces: Map<string, TraceLine[]>;
  /** Every agent the scenario started, traced or not, named by `tally.json`. */
  participants: Set<string>;
  /** Participants that ran as the OPERATOR. Their writes are authored by `local:dev`, so an
   *  authorship check must not look for records under their own name. */
  operators: Set<string>;
  /** Whether this run collected `agent_run`, without which an untraced worker's records cannot be
   *  attributed to it. Runs recorded before that was collected answer "cannot tell", never "no". */
  mapped: boolean;
  /** A record CARRYING the bytes of the artifact it descends from: verbatim, or altered. This is
   *  "verify the execution path" made mechanical. Correctness of the final answer proves nothing
   *  about whether the delivered code is the code that ran, and an agent that retypes or improves
   *  what it was handed produces the same number by a different route. */
  carried: { carrier: string; kind: string; artifact: string; bytes: number; verbatim: boolean }[];
  /** run id to agent name, recovered from the traces: the only place the two appear together. */
  actor: Map<string, string>;
  /** What the run ASKED for, when it recorded it: roles, prompts, seeded work. Runs made before
   *  `scenario.json` was written have none, and the renderer says so rather than inventing it. */
  asked?: {
    name?: string;
    seedWhen?: string;
    sequential?: boolean;
    seed?: { kind: string; body: Record<string, unknown> }[];
    agents?: { name: string; harness?: string; model?: string; prompt?: string; background?: boolean; credential?: string }[];
  };
  /** What each agent SAID, in its own words: the `agent_message` lines codex and agy emit and the
   *  final summary Claude Code prints. The third evidence source, and the weakest, so it is shown
   *  beside the calls rather than instead of them. */
  narration: Map<string, { ts?: string; text: string }[]>;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}

export async function load(dir: string): Promise<Run | undefined> {
  const space = await readJson(`${dir}/space.json`);
  const tally = await readJson(`${dir}/tally.json`);
  if (!space || !tally) {
    console.error(`${dir}: no space.json or tally.json (an unfinished run leaves neither)`);
    return undefined;
  }
  const records: Rec[] = [];
  for (const [k, v] of Object.entries(space)) {
    // `agent_run` is evidence ABOUT the participants rather than work they did, and counting it as
    // a record would report a bypassed run as productive.
    if (k.startsWith("records.") && k !== "records.agent_run") {
      records.push(...((v as { records: Rec[] }).records ?? []));
    }
  }
  const traces = new Map<string, TraceLine[]>();
  const actor = new Map<string, string>();
  let mapped = false;
  // The AUTHORITATIVE mapping, covering participants that hold no adapter and therefore no trace.
  for (const r of ((space["records.agent_run"] as { records: Rec[] })?.records ?? [])) {
    const b = r.body as { run?: string; agent?: string };
    if (b.run && b.agent) actor.set(b.run, b.agent.replace(/^agent:/, ""));
    mapped = true;
  }
  // FROM THE TALLY, not from the directory listing: a run directory also holds `space/` and
  // whatever the space itself created beside it (`.radia`, a blob directory), and reporting those
  // as silent participants is the over-reporting that puts false findings in front of a reader.
  const participants = new Set(Object.keys((tally.tally as Record<string, unknown>) ?? {}));
  const operators = new Set((tally.operators as string[]) ?? []);
  for (const name of participants) {
    const text = await Deno.readTextFile(`${dir}/${name}/trace.jsonl`).catch(() => "");
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceLine);
    if (lines.length) traces.set(name, lines);
    for (const l of lines) if (l.principal && !actor.has(l.principal)) actor.set(l.principal, name);
  }
  // Hashed HERE because the checks are synchronous and WebCrypto is not. Only strings long enough
  // to be a payload are considered, and only on records descending from the artifact itself, so a
  // note that merely mentions an artifact is never mistaken for one carrying it.
  const artifacts = new Map(
    records.filter((x) => x.kind === "artifact" && typeof x.body.digest === "string")
      .map((x) => [x.id, { digest: String(x.body.digest), size: Number(x.body.size ?? 0) }]),
  );
  const carried: Run["carried"] = [];
  for (const rec of records) {
    for (const parent of rec.runtimeMeta.parentIds ?? []) {
      const art = artifacts.get(parent);
      if (!art) continue;
      for (const text of longStrings(rec.body)) {
        const bytes = new TextEncoder().encode(text);
        // Within a tenth of the artifact's size, or it is a summary rather than a copy: a mismatch
        // is only interesting when the record was plainly meant to be carrying the payload.
        if (art.size && Math.abs(bytes.length - art.size) > art.size * 0.1) continue;
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        carried.push({ carrier: rec.id, kind: rec.kind, artifact: parent, bytes: bytes.length, verbatim: digest === art.digest });
      }
    }
  }

  const asked = await readJson(`${dir}/scenario.json`) as Run["asked"] | undefined;
  const narration = new Map<string, { ts?: string; text: string }[]>();
  for (const name of participants) {
    const said: { ts?: string; text: string }[] = [];
    const text = await Deno.readTextFile(`${dir}/stdout.log`.replace("stdout.log", `${name}/stdout.log`)).catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        // Three harnesses, three shapes, one question: what did it say in prose? codex nests an
        // `agent_message` item, agy answers with `response`, Claude Code prints `result` at the end.
        const item = d.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && item.text) said.push({ text: item.text });
        else if (typeof d.response === "string") said.push({ text: d.response });
        else if (typeof d.result === "string") said.push({ text: d.result });
      } catch { /* not one of ours */ }
    }
    if (said.length) narration.set(name, said);
  }

  return {
    dir,
    scenario: String(tally.scenario ?? "?"),
    asked,
    narration,
    models: (tally.models as Run["models"]) ?? { asked: {}, reported: {} },
    results: (tally.results as Run["results"]) ?? [],
    events: ((space.events as { events: Event[] })?.events) ?? [],
    records,
    flows: ((space.flows as { flows: Flow[] })?.flows) ?? [],
    traces,
    participants,
    operators,
    mapped,
    carried,
    actor,
  };
}

/** Every string in a body big enough to be a payload rather than a field, walked recursively. */
function longStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.length >= 64) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) longStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) longStrings(x, out);
  return out;
}

/** The agent behind a run id, or the run id when nothing claimed it (the operator, a worker). */
const who = (r: Run, runId: string) => r.actor.get(runId) ?? (runId === "local:dev" ? "operator" : runId);

// ---- checks -------------------------------------------------------------------
//
// A check returns findings. NO FINDINGS IS THE PASS, and a check that cannot apply to a run says so
// rather than passing silently: "no claimable work in this scenario" and "every task settled once"
// are different answers and a reader must not have to tell them apart by scenario name.

interface Finding {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}
interface Check {
  id: string;
  run(r: Run): { findings: Finding[]; applicable: boolean; note?: string };
}

/** Claim history per record, from the event log: the one source that records what was TRIED and won. */
function claims(r: Run) {
  const per = new Map<string, { kind: string; takes: Event[]; acks: Event[]; nacks: Event[]; last?: Event }>();
  for (const e of r.events) {
    if (!["take", "ack", "nack", "release"].includes(e.operation)) continue;
    const c = per.get(e.recordId) ?? { kind: e.kind, takes: [], acks: [], nacks: [] };
    if (e.operation === "take") c.takes.push(e);
    if (e.operation === "ack") c.acks.push(e);
    if (e.operation === "nack") c.nacks.push(e);
    c.last = e;
    per.set(e.recordId, c);
  }
  return per;
}

const CHECKS: Check[] = [
  {
    // The flagship assertion from the catalogue, and the one the trace exists for: the space cannot
    // see a claim that matched nothing, so an empty queue and a wrong question are the same event.
    id: "empty-claim-while-work-stood-available",
    run(r) {
      const takes = [...r.traces.values()].flat().filter((l) => l.tool === "space_take");
      if (takes.length === 0) return { findings: [], applicable: false, note: "nothing claimed in this run" };
      // A record is available at T when its newest event before T is a put, a nack or a release.
      const timeline = r.events
        .filter((e) => ["put", "take", "ack", "nack", "release"].includes(e.operation))
        .map((e) => ({ ...e, at: Date.parse(e.ts) }));
      const findings: Finding[] = [];
      for (const t of takes.filter((l) => l.outcome === "empty")) {
        const at = Date.parse(t.ts);
        const kind = String((t.args ?? {}).kind ?? "");
        const state = new Map<string, string>();
        for (const e of timeline) {
          if (e.at > at) break;
          if (!kind || e.kind === kind) state.set(e.recordId, e.state ?? e.operation);
        }
        const available = [...state.entries()].filter(([, s]) => s === "available").map(([id]) => id);
        if (available.length === 0) continue;
        // A CONCURRENT WINNER is not a finding, it is the fence working. Two agents claiming in the
        // same second is the whole point of a contention scenario, and flagging it would bury the
        // real case under noise.
        const raced = timeline.some((e) => e.operation === "take" && Math.abs(e.at - at) < 2000);
        if (raced) continue;
        findings.push({
          severity: "high",
          title: `${t.session}: a claim answered EMPTY while ${available.length} record(s) of kind '${kind}' stood available`,
          detail: `pattern ${JSON.stringify(t.args)} at ${t.ts}; e.g. ${available[0]}`,
        });
      }
      return { findings, applicable: true };
    },
  },
  {
    id: "settled-more-than-once",
    run(r) {
      const per = claims(r);
      if (per.size === 0) return { findings: [], applicable: false, note: "nothing claimed in this run" };
      const findings: Finding[] = [];
      for (const [id, c] of per) {
        if (c.acks.length > 1) {
          findings.push({
            severity: "high",
            title: `${c.kind} ${id} was settled ${c.acks.length} times`,
            detail: `by ${c.acks.map((a) => who(r, a.runId)).join(", ")}`,
          });
        }
      }
      return { findings, applicable: true };
    },
  },
  {
    id: "left-claimed-or-dead-lettered",
    run(r) {
      const per = claims(r);
      if (per.size === 0) return { findings: [], applicable: false, note: "nothing claimed in this run" };
      const findings: Finding[] = [];
      for (const [id, c] of per) {
        // The adapter KEEPS a named session's claims on exit, so a lease outliving the run is
        // invisible work rather than a crash: nothing tells the asker, and nothing tells an
        // operator until it expires.
        if (c.last?.state === "leased") {
          findings.push({
            severity: "high",
            title: `${c.kind} ${id} was still claimed when the run ended`,
            detail: `held by ${who(r, c.last.runId)} since ${c.last.ts}`,
          });
        }
        if (c.last?.state === "dead_letter") {
          findings.push({
            severity: "high",
            title: `${c.kind} ${id} dead-lettered after ${c.takes.length} attempts`,
            detail: `a dead-lettered record emits NO result, so whoever asked learns nothing`,
          });
        }
      }
      return { findings, applicable: true };
    },
  },
  {
    // Observed: three nacks with backoffSeconds 0 on one record, re-claimed each time, two short of
    // the dead-letter ceiling. A retry loop on work that cannot succeed is a livelock with a clock.
    id: "retry-loop-on-one-record",
    run(r) {
      const per = claims(r);
      if (per.size === 0) return { findings: [], applicable: false, note: "nothing claimed in this run" };
      const nacks = [...r.traces.values()].flat().filter((l) => l.tool === "space_nack");
      const findings: Finding[] = [];
      for (const [id, c] of per) {
        if (c.nacks.length < 2) continue;
        const zero = nacks.filter((n) => Number((n.args ?? {}).backoffSeconds ?? -1) === 0).length;
        findings.push({
          severity: "medium",
          title: `${c.kind} ${id} was nacked ${c.nacks.length} times and re-claimed`,
          detail: `${c.takes.length} attempts by ${who(r, c.nacks[0].runId)}` +
            (zero ? `, ${zero} nack(s) with backoffSeconds 0` : ""),
        });
      }
      return { findings, applicable: true };
    },
  },
  {
    // A worker that holds no model leaves no trace, so "did it participate" is a RECORD it wrote,
    // never a call count: `tally.json` reads 0 calls for a working one and for a bypassed one alike.
    id: "participant-authored-nothing",
    run(r) {
      const authors = new Set(r.records.map((rec) => who(r, rec.runtimeMeta.createdBy)));
      // A participant whose authorship CANNOT be resolved is not a participant that authored
      // nothing. Without `agent_run` an untraced worker's records carry a run id nothing here can
      // name, and reporting that as silence is a false high finding on the check most likely to be
      // believed.
      const decidable = [...r.participants]
        .filter((a) => !r.operators.has(a))
        .filter((a) => r.mapped || r.traces.has(a));
      const silent = decidable.filter((a) => !authors.has(a));
      const undecided = [...r.participants].filter((a) => !decidable.includes(a) && !r.operators.has(a));
      if (decidable.length === 0) {
        return { findings: [], applicable: false, note: `cannot attribute authorship (this run collected no agent_run)` };
      }
      // ARRIVING LATE IS NOT BEING BYPASSED. An agent that tried to claim and was answered empty
      // every time lost a race; one that never tried, or whose work went somewhere else, is the
      // finding this check exists for. Measured: three harnesses on five instant tasks orient
      // 16 seconds apart, and the last one to arrive found the queue drained, did the right thing,
      // and was reported at the same severity as a bypass (agent_docs/research-agent-sessions.md).
      const raced = (a: string) => {
        const calls = r.traces.get(a) ?? [];
        const takes = calls.filter((l) => l.tool === "space_take");
        return takes.length > 0 && takes.every((l) => l.outcome === "empty");
      };
      return {
        applicable: true,
        note: undecided.length ? `not decidable for ${undecided.join(", ")}: no trace and no agent_run` : undefined,
        findings: silent.map((a) => ({
          severity: raced(a) ? ("low" as const) : ("high" as const),
          title: raced(a) ? `${a} claimed nothing: every attempt found the queue empty` : `${a} authored no records`,
          detail: raced(a)
            ? `it tried and lost every race, which is a scenario with too little work for its agents rather than a bypass`
            : r.traces.has(a)
            ? `it made ${r.results.find((x) => x.name === a)?.calls ?? 0} tool calls and wrote nothing`
            : `an untraced worker, so a record it wrote is the ONLY evidence it took part`,
        })),
      };
    },
  },
  {
    // OUTCOME CORRECTNESS IS NOT ENOUGH. A run where the requester retypes the code it was handed
    // produces the same number by a different route, and every other signal (exit code, the final
    // answer, the mined flow) reads identical. The digest is the only thing that separates them.
    id: "delivered-code-was-altered",
    run(r) {
      if (r.carried.length === 0) {
        return { findings: [], applicable: false, note: "no record in this run carries an artifact it descends from" };
      }
      return {
        applicable: true,
        findings: r.carried.filter((c) => !c.verbatim).map((c) => ({
          severity: "high" as const,
          title: `${c.kind} ${c.carrier} carries ${c.bytes} bytes that are NOT artifact ${c.artifact}`,
          detail: `same size to within a tenth, different digest: the payload was edited between delivery and use`,
        })),
      };
    },
  },
  {
    id: "refusals",
    run(r) {
      const findings: Finding[] = [];
      for (const [name, lines] of r.traces) {
        for (const l of lines.filter((x) => x.outcome === "error")) {
          findings.push({
            severity: "medium",
            title: `${name}: ${l.tool} refused (${l.error})`,
            detail: `${JSON.stringify(l.args).slice(0, 160)} at ${l.ts}`,
          });
        }
      }
      return { findings, applicable: true };
    },
  },
  {
    // 2-for-2 predictor in the hand-run sessions, and the reason several fixes moved out of kind
    // usage strings and into tool descriptions.
    id: "wrote-without-reading-the-vocabulary",
    run(r) {
      const findings: Finding[] = [];
      for (const [name, lines] of r.traces) {
        const kindsAt = lines.findIndex((l) => l.tool === "space_kinds");
        const wroteAt = lines.findIndex((l) => ["space_put", "space_ack", "space_take"].includes(l.tool));
        if (wroteAt >= 0 && (kindsAt < 0 || kindsAt > wroteAt)) {
          findings.push({
            severity: "medium",
            title: `${name} acted before reading what this space holds`,
            detail: kindsAt < 0 ? "never called space_kinds" : `called space_kinds only after ${lines[wroteAt].tool}`,
          });
        }
      }
      return { findings, applicable: r.traces.size > 0 };
    },
  },
];

// ---- html ---------------------------------------------------------------------
//
// One self-contained page per run, because the text report answers "what went wrong" and a person
// coming back to a run a week later first has to ask "what was this trying to do". The two share
// this file's loader and CHECKS deliberately: a second implementation of the findings would drift,
// and the whole point of the report is that its verdict is the same one however you read it.
//
// NO EXTERNAL ANYTHING. Inline CSS, inline JS, no fonts, no CDN: a run directory is copied around
// and mailed, and a page that needs the network is a page that renders blank on the machine that
// matters. The same rule the published site follows.

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Seconds from the first recorded moment, so every lane shares one clock. */
function timeline(r: Run) {
  const stamps: number[] = [];
  for (const ls of r.traces.values()) for (const l of ls) stamps.push(Date.parse(l.ts));
  for (const e of r.events) stamps.push(Date.parse(e.ts));
  const t0 = stamps.length ? Math.min(...stamps) : 0;
  const t1 = stamps.length ? Math.max(...stamps) : t0 + 1;
  return { t0, span: Math.max(1, t1 - t0) };
}

/** The one-line reading of a run. SHARED, because the index and the run's own page state the same
 *  verdict and two computations of it would drift the way two implementations of a check would. */
function summarize(rep: ReturnType<typeof describe>) {
  const r = rep.run;
  const claimed = claims(r);
  const answers = new Map<string, number>();
  for (const rec of r.records) {
    for (const p of rec.runtimeMeta.parentIds ?? []) answers.set(p, (answers.get(p) ?? 0) + 1);
  }
  const work = [...claimed.entries()].map(([id, c]) => ({ id, state: c.last?.state ?? "", answered: (answers.get(id) ?? 0) > 0 }));
  // Counts records that got an ANSWER, never how many derived records each got: two children is an
  // ordinary shape (an ack result plus a note beside it), and calling that "answered twice" put a
  // defect in front of the reader that no check had found. Answering twice is a double SETTLE, and
  // that is a check.
  const answered = work.filter((w) => w.answered).length;
  const stuck = work.filter((w) => w.state === "leased" || w.state === "dead_letter").length;
  const findings = [...rep.per.values()].flat();
  const fired = [...rep.per.entries()].filter(([, fs]) => fs.length).map(([id]) => id).sort();
  const { t0, span } = timeline(r);
  return {
    verdict: work.length === 0
      ? "No claimable work in this run."
      : `${answered} of ${work.length} claimed records answered` + (stuck ? `, ${stuck} left unsettled.` : "."),
    work: work.length,
    answered,
    stuck,
    findings,
    fired,
    severities: { high: 0, medium: 0, low: 0, ...Object.fromEntries(["high", "medium", "low"].map((s) => [s, findings.filter((f) => f.severity === s).length])) },
    calls: [...r.traces.values()].reduce((n, ls) => n + ls.length, 0),
    startedAt: t0,
    seconds: span / 1000,
  };
}

export function htmlFor(rep: ReturnType<typeof describe>): string {
  const r = rep.run;
  const { t0, span } = timeline(r);
  const at = (ts: string) => ((Date.parse(ts) - t0) / span) * 100;
  const secs = (ts: string) => ((Date.parse(ts) - t0) / 1000).toFixed(1);
  const findings = [...rep.per.values()].flat().sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const lanes = [...r.traces.keys()];
  const claimed = claims(r);

  // WHAT THE WORK DID, one row per claimable record: who won it and what answered it. This is the
  // question a reader actually has, and it is nowhere in the raw evidence: it joins the event log
  // (who claimed) to the records (what came back).
  const answers = new Map<string, Rec[]>();
  for (const rec of r.records) {
    for (const p of rec.runtimeMeta.parentIds ?? []) answers.set(p, [...(answers.get(p) ?? []), rec]);
  }
  const work = [...claimed.entries()].map(([id, c]) => ({
    id,
    kind: c.kind,
    title: String((r.records.find((x) => x.id === id)?.body as { title?: string })?.title ?? ""),
    by: c.acks.length ? who(r, c.acks[0].runId) : "",
    attempts: c.takes.length,
    state: c.last?.state ?? "",
    answers: answers.get(id) ?? [],
  }));

  const sevColour = { high: "#f87171", medium: "#fbbf24", low: "#60a5fa" };
  const laneColour = ["#60a5fa", "#34d399", "#c084fc", "#fbbf24", "#f472b6"];
  const colourOf = (name: string) => laneColour[lanes.indexOf(name) % laneColour.length];

  const { verdict } = summarize(rep);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.scenario)} — lab run</title>
<style>
:root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:1100px; margin:0 auto; padding:28px 20px 80px; }
h1 { font-size:1.5rem; margin:0 0 4px; }
h2 { font-size:1.1rem; margin:34px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
.sub { color:var(--dim); margin:0 0 18px; }
.claim { font-size:1.05rem; margin:0 0 16px; }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:12px 14px; }
.card h3 { margin:0 0 6px; font-size:.95rem; }
.card .n { font-size:1.6rem; font-weight:600; }
.card .d { color:var(--dim); font-size:.85rem; }
table { width:100%; border-collapse:collapse; margin:12px 0; font-size:.9rem; }
th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:600; }
.lane { display:grid; grid-template-columns:130px 1fr; align-items:center; gap:10px; margin:7px 0; }
.track { position:relative; height:26px; background:var(--panel); border:1px solid var(--line); border-radius:4px; }
.mark { position:absolute; top:3px; height:18px; width:8px; margin-left:-4px; border-radius:2px; cursor:pointer; }
.seed { position:absolute; top:-4px; bottom:-4px; width:2px; background:var(--warn); }
.f { border-left:3px solid; padding:9px 12px; margin:9px 0; background:var(--panel); border-radius:0 5px 5px 0; }
.f .t { font-weight:600; }
.f .d { color:var(--dim); font-size:.88rem; margin-top:3px; }
.said { background:var(--panel); border:1px solid var(--line); border-left:3px solid; border-radius:0 5px 5px 0; padding:9px 12px; margin:9px 0; white-space:pre-wrap; font-size:.88rem; }
.pill { display:inline-block; padding:1px 7px; border-radius:20px; font-size:.76rem; border:1px solid var(--line); color:var(--dim); }
details { margin:8px 0; } summary { cursor:pointer; color:var(--dim); }
.log { max-height:420px; overflow:auto; }
.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .dim{color:var(--dim)}
</style></head><body><div class="wrap">

<h1>${esc(r.scenario)}</h1>
<p class="sub mono">${esc(r.dir)}</p>

<h2>What this run tried to do</h2>
${
    r.asked
      ? `<p class="claim">${
        esc(
          `${(r.asked.agents ?? []).length} participants, ` +
            `${r.asked.seed?.length ?? 0} pieces of work seeded ` +
            (r.asked.seedWhen === "agents-ready" ? "once every agent had made a call" : "before any agent started") +
            (r.asked.sequential ? ", run one after another." : ", run together."),
        )
      }</p>
  <table><tr><th>agent</th><th>harness</th><th>model</th><th>asked to</th></tr>${
        (r.asked.agents ?? []).map((a) =>
          `<tr><td class="mono">${esc(a.name)}</td><td>${esc(a.harness ?? "script")}</td><td class="mono">${
            esc(a.model ?? (r.models.asked[a.name] ?? "-"))
          }</td><td>${
            a.background
              ? '<span class="dim">a worker, started first and never waited for</span>'
              : a.credential === "operator"
              ? '<span class="dim">a privileged deployment step, not a model</span>'
              // Only a HARNESS is given a prompt. A script's `prompt` field is a placeholder the
              // scenario format requires, and showing it as an instruction reads as one.
              : !a.harness
              ? '<span class="dim">a script, told nothing: it does one fixed thing</span>'
              : `<details><summary>${esc((a.prompt ?? "").split("\\n")[0].slice(0, 90))}…</summary><div class="said" style="border-left-color:${
                colourOf(a.name)
              }">${esc(a.prompt)}</div></details>`
          }</td></tr>`
        ).join("")
      }</table>
  ${
        r.asked.seed?.length
          ? `<details><summary>the ${r.asked.seed.length} seeded records</summary><table><tr><th>kind</th><th>body</th></tr>${
            r.asked.seed.map((s) => `<tr><td class="mono">${esc(s.kind)}</td><td class="mono">${esc(JSON.stringify(s.body))}</td></tr>`).join("")
          }</table></details>`
          : ""
      }`
      : `<p class="claim dim">This run predates <code>scenario.json</code>, so what it asked for was not recorded. Everything below is what happened.</p>`
  }

<h2>How it went</h2>
<p class="claim">${esc(verdict)}</p>
<div class="cards">
${
    r.results.map((res) => {
      const t = r.traces.get(res.name) ?? [];
      const empty = t.filter((l) => l.outcome === "empty").length;
      const errs = t.filter((l) => l.outcome === "error").length;
      const won = t.filter((l) => l.tool === "space_take" && l.outcome === "ok").length;
      return `<div class="card"><h3 style="color:${colourOf(res.name)}">${esc(res.name)}</h3>
  <div class="n">${res.calls}<span class="d"> calls</span></div>
  <div class="d">${won} claim${won === 1 ? "" : "s"} won &middot; ${empty} empty &middot; <span class="${
        errs ? "bad" : "dim"
      }">${errs} refused</span></div>
  <div class="d">exit ${esc(res.code)}${r.models.reported[res.name] ? ` &middot; ran ${esc(r.models.reported[res.name])}` : ""}</div></div>`;
    }).join("")
  }
</div>

<h2>Progression</h2>
<p class="sub">Every tool call on one clock, ${(span / 1000).toFixed(0)} seconds end to end. Hover a mark for the call.</p>
${
    lanes.map((name) => {
      const marks = (r.traces.get(name) ?? []).map((l) => {
        const c = l.outcome === "error" ? "#f87171" : l.outcome === "empty" ? "#8b949e" : colourOf(name);
        return `<div class="mark" style="left:${at(l.ts).toFixed(2)}%;background:${c}" title="${
          esc(`${secs(l.ts)}s  ${l.tool}  ${l.outcome}${l.error ? ` (${l.error})` : ""}`)
        }"></div>`;
      }).join("");
      return `<div class="lane"><div class="mono" style="color:${colourOf(name)}">${esc(name)}</div><div class="track">${marks}</div></div>`;
    }).join("")
  }
<p class="sub"><span class="dim">grey = answered nothing</span> &middot; <span class="bad">red = refused</span> &middot; coloured = ok</p>

${
    work.length
      ? `<h2>What happened to the work</h2>
<table><tr><th>record</th><th>claimed by</th><th>attempts</th><th>answered with</th></tr>${
        work.map((w) =>
          `<tr><td>${esc(w.title || w.kind)}<br><span class="mono dim">${esc(w.id.slice(-8))}</span></td>
  <td class="mono" style="color:${w.by ? colourOf(w.by) : "inherit"}">${esc(w.by || "-")}</td>
  <td class="${w.attempts > 1 ? "warn" : ""}">${w.attempts}</td>
  <td>${
            w.answers.length
              ? w.answers.map((a) => `<span class="mono">${esc(JSON.stringify(a.body).slice(0, 110))}</span>`).join("<br>")
              : '<span class="bad">nothing</span>'
          }</td></tr>`
        ).join("")
      }</table>`
      : ""
  }

<h2>Problems</h2>
${
    findings.length === 0
      ? '<p class="claim ok">None. Every check either passed or reported that it could not apply.</p>'
      : findings.map((f) =>
        `<div class="f" style="border-left-color:${sevColour[f.severity]}"><div class="t">${
          esc(f.title)
        } <span class="pill">${f.severity}</span></div><div class="d mono">${esc(f.detail)}</div></div>`
      ).join("")
  }
${
    [...rep.caveats.entries()].map(([id, why]) => `<p class="sub"><span class="pill">partial</span> ${esc(id)}: ${esc(why)}</p>`).join("")
  }
${
    [...rep.skipped.entries()].map(([id, why]) => `<p class="sub"><span class="pill">n/a</span> ${esc(id)}: ${esc(why)}</p>`).join("")
  }

${
    r.flows.length
      ? `<h2>The shape it made</h2><p class="sub">Mined from lineage afterwards, not declared anywhere.</p><table><tr><th>times</th><th>complete</th><th>shape</th></tr>${
        r.flows.map((f) =>
          `<tr><td>${f.occurrences}</td><td>${f.outcomes.complete}/${f.occurrences}</td><td class="mono">${esc(f.signature)}</td></tr>`
        ).join("")
      }</table>`
      : ""
  }

${
    r.narration.size
      ? `<h2>What the agents said</h2><p class="sub">Their own account, which is the weakest evidence here: compare it with the calls above.</p>${
        [...r.narration.entries()].map(([name, said]) =>
          `<details><summary>${esc(name)} (${said.length})</summary>${
            said.map((m) => `<div class="said" style="border-left-color:${colourOf(name)}">${esc(m.text)}</div>`).join("")
          }</details>`
        ).join("")
      }`
      : ""
  }

<h2>Every call</h2>
<details><summary>${[...r.traces.values()].reduce((n, l) => n + l.length, 0)} tool calls, in order</summary>
<div class="log"><table><tr><th>at</th><th>agent</th><th>tool</th><th>outcome</th><th>arguments</th></tr>${
    [...r.traces.entries()].flatMap(([name, ls]) => ls.map((l) => ({ name, l })))
      .sort((a, b) => Date.parse(a.l.ts) - Date.parse(b.l.ts))
      .map(({ name, l }) =>
        `<tr><td class="mono dim">${secs(l.ts)}s</td><td class="mono" style="color:${colourOf(name)}">${esc(name)}</td>
  <td class="mono">${esc(l.tool)}</td><td class="${
          l.outcome === "error" ? "bad" : l.outcome === "empty" ? "dim" : "ok"
        }">${esc(l.outcome)}${l.error ? ` <span class="mono">${esc(l.error)}</span>` : ""}</td>
  <td class="mono dim">${esc(JSON.stringify(l.args ?? {}).slice(0, 150))}</td></tr>`
      ).join("")
  }</table></div></details>

</div></body></html>`;
}

// ---- output -------------------------------------------------------------------

const RANK = { high: 0, medium: 1, low: 2 };

export function describe(r: Run) {
  const per = new Map<string, Finding[]>();
  const skipped = new Map<string, string>();
  // A check that ran but could not cover EVERYTHING says which part it left out, the way the ops
  // aggregates name what they did not count rather than answering zero for it.
  const caveats = new Map<string, string>();
  for (const c of CHECKS) {
    const out = c.run(r);
    if (!out.applicable) skipped.set(c.id, out.note ?? "not applicable to this scenario");
    else {
      per.set(c.id, out.findings);
      if (out.note) caveats.set(c.id, out.note);
    }
  }
  return { run: r, per, skipped, caveats };
}

/** One page over many runs. It exists because a finding here is a RATE: the per-scenario block is
 *  the honest reading of a corpus, and the table under it is how you get from a rate back to the
 *  single run that produced it. Unreadable directories are LISTED rather than dropped, or a set of
 *  70 silently becomes a set of 44 and the reader concludes the killed runs never happened. */
export function indexFor(
  reports: ReturnType<typeof describe>[],
  unreadable: string[],
  indexDir: string,
): string {
  const rows = reports.map((rep) => {
    const s = summarize(rep);
    const dir = rep.run.dir.replace(/\/+$/, "");
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    const href = dir.startsWith(indexDir + "/") ? `${dir.slice(indexDir.length + 1)}/run.html` : `${dir}/run.html`;
    const who = rep.run.results.map((x) => x.name);
    const models = who.map((n) => rep.run.models.reported[n] ?? rep.run.models.asked[n]).filter(Boolean);
    return {
      name,
      href,
      scenario: rep.run.scenario,
      when: s.startedAt ? new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19) : name.slice(rep.run.scenario.length + 1, rep.run.scenario.length + 20).replace("T", " "),
      seconds: s.seconds,
      calls: s.calls,
      people: who,
      models: [...new Set(models)],
      verdict: s.verdict,
      sev: s.severities,
      ids: s.fired,
      intent: Boolean(rep.run.asked),
      failed: rep.run.results.filter((x) => x.code !== 0).map((x) => `${x.name} exit ${x.code}`),
    };
  }).sort((a, b) => b.when.localeCompare(a.when));

  const byScenario = new Map<string, typeof rows>();
  for (const row of rows) byScenario.set(row.scenario, [...(byScenario.get(row.scenario) ?? []), row]);
  const chip = (n: number, sev: "high" | "medium" | "low") => n ? `<span class="sev ${sev}">${n}</span>` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent lab runs</title>
<style>
:root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:1180px; margin:0 auto; padding:28px 20px 80px; }
h1 { font-size:1.5rem; margin:0 0 4px; }
h2 { font-size:1.05rem; margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
.sub { color:var(--dim); margin:0 0 18px; }
table { width:100%; border-collapse:collapse; font-size:.88rem; }
th { text-align:left; color:var(--dim); font-weight:500; border-bottom:1px solid var(--line); padding:6px 8px; cursor:pointer; user-select:none; }
th:hover { color:var(--fg); }
td { padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:hover td { background:var(--panel); }
a { color:#79c0ff; text-decoration:none; }
a:hover { text-decoration:underline; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em; }
.dim { color:var(--dim); }
.sev { display:inline-block; min-width:1.5em; text-align:center; border-radius:3px; padding:0 5px; margin-right:3px; font-size:.8rem; font-weight:600; color:#0d1117; }
.sev.high { background:#f87171; } .sev.medium { background:#fbbf24; } .sev.low { background:#60a5fa; }
input[type=search] { background:var(--panel); border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:7px 10px; width:280px; font:inherit; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; margin-bottom:6px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px; }
.card h3 { margin:0 0 4px; font-size:.9rem; }
.card .n { font-size:1.35rem; font-weight:600; }
.card .d { color:var(--dim); font-size:.8rem; }
</style></head><body><div class="wrap">
<h1>agent lab runs</h1>
<p class="sub">${rows.length} readable run${rows.length === 1 ? "" : "s"} across ${byScenario.size} scenario${byScenario.size === 1 ? "" : "s"}${
    unreadable.length ? `, and ${unreadable.length} directory that held no evidence`.replace("directory that held", unreadable.length === 1 ? "directory that held" : "directories that held") : ""
  }. Each row links to that run's own page.</p>

<h2>By scenario</h2>
<p class="sub">A finding here is a RATE. One run is an anecdote: the same scenario with the same models makes different choices, so the number that means something is how often, out of how many.</p>
<div class="cards">${
    [...byScenario.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, rs]) => {
      const withF = rs.filter((x) => x.sev.high + x.sev.medium + x.sev.low > 0).length;
      const sorted = rs.map((x) => x.seconds).sort((a, b) => a - b);
      const median = sorted[(sorted.length - 1) >> 1];
      return `<div class="card"><h3>${esc(name)}</h3><div class="n">${rs.length}<span class="d"> run${rs.length === 1 ? "" : "s"}</span></div>` +
        `<div class="d">${withF} with findings &middot; ${median.toFixed(0)}s median</div></div>`;
    }).join("")
  }</div>

<h2>Every run</h2>
<p class="sub"><input type="search" id="q" placeholder="filter by scenario, model, agent, finding"> <span class="dim" id="count"></span> &middot; click a column to sort</p>
<table id="t"><thead><tr>
<th data-k="when">when</th><th data-k="scenario">scenario</th><th data-k="who">who</th>
<th data-k="secs">took</th><th data-k="calls">calls</th><th data-k="sev">findings</th><th data-k="verdict">verdict</th>
</tr></thead><tbody>${
    rows.map((row) =>
      `<tr data-when="${esc(row.when)}" data-scenario="${esc(row.scenario)}" data-who="${esc(row.people.join(" "))}" data-secs="${row.seconds.toFixed(1)}" data-calls="${row.calls}" data-sev="${
        row.sev.high * 100 + row.sev.medium * 10 + row.sev.low
      }" data-verdict="${esc(row.verdict)}" data-text="${esc([row.scenario, ...row.people, ...row.models, ...row.ids, row.name].join(" ").toLowerCase())}">` +
      `<td class="mono"><a href="${esc(row.href)}">${esc(row.when)}</a>${row.intent ? "" : ` <span class="dim" title="made before scenario.json existed, so what it asked for was not recorded">?</span>`}</td>` +
      `<td>${esc(row.scenario)}</td>` +
      `<td>${esc(row.people.join(", "))}${row.models.length ? `<div class="dim mono">${esc(row.models.join(", "))}</div>` : ""}${
        row.failed.length ? `<div class="dim">${esc(row.failed.join(", "))}</div>` : ""
      }</td>` +
      `<td class="mono">${row.seconds.toFixed(0)}s</td><td class="mono">${row.calls}</td>` +
      `<td>${chip(row.sev.high, "high")}${chip(row.sev.medium, "medium")}${chip(row.sev.low, "low")}<span class="dim mono"> ${esc(row.ids.join(" "))}</span></td>` +
      `<td class="dim">${esc(row.verdict)}</td></tr>`
    ).join("")
  }</tbody></table>
${
    unreadable.length
      ? `<h2>Directories with no evidence</h2>
<p class="sub">These hold a space directory and nothing else: a run stopped before it wrote <code>space.json</code> and <code>tally.json</code>, so there is nothing to report and no page. They are listed because dropping them turns a set of ${
        rows.length + unreadable.length
      } into a set of ${rows.length} with nothing saying so.</p>
<p class="mono dim">${unreadable.map((d) => esc(d.replace(/\/+$/, "").split("/").pop())).join("<br>")}</p>`
      : ""
  }
<script>
const tb = document.querySelector("#t tbody"), q = document.getElementById("q"), count = document.getElementById("count");
const rows = [...tb.rows];
const show = () => {
  const s = q.value.trim().toLowerCase();
  let n = 0;
  for (const r of rows) { const hit = !s || r.dataset.text.includes(s); r.style.display = hit ? "" : "none"; if (hit) n++; }
  count.textContent = n + " of " + rows.length + " shown";
};
q.addEventListener("input", show); show();
let last = "", asc = false;
for (const th of document.querySelectorAll("#t th")) {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    asc = k === last ? !asc : false; last = k;
    const num = ["secs", "calls", "sev"].includes(k);
    rows.sort((a, b) => {
      const x = a.dataset[k], y = b.dataset[k];
      const c = num ? Number(x) - Number(y) : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
    for (const r of rows) tb.appendChild(r);
  });
}
</script>
</div></body></html>`;
}

if (import.meta.main) {
  // ---- the driver ---------------------------------------------------------------

  const isDir = (p: string) => {
    try {
      return Deno.statSync(p).isDirectory;
    } catch {
      return false;
    }
  };
  /** The optional path after a flag. A RUN DIRECTORY is never it, whichever order the flags and the
   *  directories arrive in: `deno task` appends the user's arguments after the task's own, so
   *  `lab-index ~/.radia-lab/*\/` puts a run directory straight after `--index` and naming it as the
   *  output wrote the page over a directory. */
  const pathAfter = (name: string) => {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const next = argv[argv.indexOf(name) + 1];
    return next && !next.startsWith("--") && !isDir(next) ? next : "";
  };
  const given = (name: string) => argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
  const dirs = argv.filter((a) => !a.startsWith("--") && a !== pathAfter("--html") && a !== pathAfter("--index"));
  const asJson = argv.includes("--json");
  /** `--html` alone writes `run.html` inside each run directory; `--html <path>` names the file, which
   *  only makes sense for one run. */
  const htmlAt = given("--html") ? pathAfter("--html") : undefined;
  /** `--index` writes ONE page over every directory given, next to them by default. */
  const indexAt = given("--index") ? pathAfter("--index") : undefined;
  if (dirs.length === 0) {
    console.error(
      "usage: deno task lab-report <run-dir>… [--json] [--html [file]] [--index [file]]\n\n" +
        "  one directory  prints that run's findings\n" +
        "  several        prints the same findings as rates, which is how a lab finding is stated\n" +
        "  --html         also writes a standalone page per run: what it tried, how it went, what broke\n" +
        "  --index        also writes one page listing every run given, linking to each one's page",
    );
    Deno.exit(2);
  }

  const runs: Run[] = [];
  const unreadable: string[] = [];
  for (const d of dirs) {
    const r = await load(d);
    if (r) runs.push(r);
    else unreadable.push(d);
  }
  if (runs.length === 0) Deno.exit(1);
  const reports = runs.map(describe);

  if (htmlAt !== undefined) {
    for (const rep of reports) {
      // Beside the evidence by default, so the page travels with the run it explains.
      const out = htmlAt && reports.length === 1 ? htmlAt : `${rep.run.dir.replace(/\/+$/, "")}/run.html`;
      await Deno.writeTextFile(out, htmlFor(rep));
      console.log(`wrote ${out}`);
    }
  }

  if (indexAt !== undefined) {
    // Default: the directory the runs share, which is where somebody looking for them already is.
    const parents = [...new Set(runs.map((r) => r.dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "")))];
    const out = indexAt || `${parents.length === 1 ? parents[0] : "."}/index.html`;
    const dir = out.replace(/\/[^/]+$/, "");
    await Deno.writeTextFile(out, indexFor(reports, unreadable, dir));
    console.log(`wrote ${out}  (${reports.length} runs${unreadable.length ? `, ${unreadable.length} with no evidence` : ""})`);
  }

  if (htmlAt !== undefined || indexAt !== undefined) {
    if (!asJson) Deno.exit(0);
  }

  if (asJson) {
    console.log(JSON.stringify(
      reports.map((x) => ({
        dir: x.run.dir,
        scenario: x.run.scenario,
        models: x.run.models,
        findings: Object.fromEntries(x.per),
        caveats: Object.fromEntries(x.caveats),
        skipped: Object.fromEntries(x.skipped),
      })),
      null,
      2,
    ));
    Deno.exit(0);
  }

  for (const { run: r, per, skipped, caveats } of reports) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`${r.scenario}  ${r.dir.replace(Deno.env.get("HOME") ?? "", "~")}`);
    const asked = Object.entries(r.models.asked);
    console.log(
      `  models  ${
        asked.length
          ? asked.map(([n, m]) => {
            const rep = r.models.reported[n];
            // ASKED and REPORTED are printed together when they differ, because an alias resolves on
            // the vendor's side and a rate compared across runs rests on which model actually ran.
            return rep && rep !== m ? `${n}=${m} (ran ${rep})` : `${n}=${m}`;
          }).join("  ")
          : "harness defaults"
      }`,
    );
    console.log(`  agents  ${r.results.map((x) => `${x.name} exit ${x.code}, ${x.calls} calls`).join("  |  ")}`);
    console.log(`  records ${r.records.length} across ${new Set(r.records.map((x) => x.kind)).size} kinds`);
    for (const f of r.flows) {
      console.log(`  flow    ${f.occurrences}x ${f.outcomes.complete}/${f.occurrences} complete  ${f.signature}`);
    }
    for (const c of r.carried.filter((x) => x.verbatim)) {
      console.log(`  carried ${c.kind} ${c.carrier.slice(-6)} holds artifact ${c.artifact.slice(-6)} VERBATIM (${c.bytes} bytes)`);
    }

    const all = [...per.values()].flat().sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    console.log(`\n  findings: ${all.length === 0 ? "none" : all.length}`);
    for (const f of all) {
      console.log(`   [${f.severity}] ${f.title}`);
      console.log(`           ${f.detail}`);
    }
    // A check that did not apply is REPORTED, never silently passed: "no claimable work here" and
    // "every claim settled once" are different answers and the reader must not have to guess which.
    for (const [id, why] of caveats) console.log(`   [part] ${id}: ${why}`);
    for (const [id, why] of skipped) console.log(`   [n/a]  ${id}: ${why}`);
  }

  if (reports.length > 1) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`rates over ${reports.length} runs\n`);
    for (const c of CHECKS) {
      const applied = reports.filter((x) => x.per.has(c.id));
      if (applied.length === 0) continue;
      const hit = applied.filter((x) => (x.per.get(c.id) ?? []).length > 0).length;
      const pct = Math.round((hit / applied.length) * 100);
      console.log(`  ${String(pct).padStart(3)}%  ${String(`${hit}/${applied.length}`).padStart(7)}  ${c.id}`);
    }
    console.log(`\n  A rate is the finding. One run is an anecdote, and the same scenario with the`);
    console.log(`  same models produces different choices (agent_docs/research-agent-sessions.md).`);
  }
}

/** Render one finished run's page. Called by `run.ts` the moment a run ends, so the page exists
 *  without anybody remembering a second command; `--html` is the same call over old directories. */
export async function renderRun(dir: string): Promise<string | undefined> {
  const r = await load(dir);
  if (!r) return undefined;
  const out = `${dir.replace(/\/+$/, "")}/run.html`;
  await Deno.writeTextFile(out, htmlFor(describe(r)));
  return out;
}
