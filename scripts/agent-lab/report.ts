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

const argv = Deno.args;
const dirs = argv.filter((a) => !a.startsWith("--"));
const asJson = argv.includes("--json");
if (dirs.length === 0) {
  console.error(
    "usage: deno task lab-report <run-dir>… [--json]\n\n" +
      "  one directory  prints that run's findings\n" +
      "  several        prints the same findings as rates, which is how a lab finding is stated",
  );
  Deno.exit(2);
}

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
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}

async function load(dir: string): Promise<Run | undefined> {
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

  return {
    dir,
    scenario: String(tally.scenario ?? "?"),
    models: (tally.models as Run["models"]) ?? { asked: {}, reported: {} },
    results: (tally.results as Run["results"]) ?? [],
    events: ((space.events as { events: Event[] })?.events) ?? [],
    records,
    flows: ((space.flows as { flows: Flow[] })?.flows) ?? [],
    traces,
    participants,
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
      const decidable = [...r.participants].filter((a) => r.mapped || r.traces.has(a));
      const silent = decidable.filter((a) => !authors.has(a));
      const undecided = [...r.participants].filter((a) => !decidable.includes(a));
      if (decidable.length === 0) {
        return { findings: [], applicable: false, note: `cannot attribute authorship (this run collected no agent_run)` };
      }
      return {
        applicable: true,
        note: undecided.length ? `not decidable for ${undecided.join(", ")}: no trace and no agent_run` : undefined,
        findings: silent.map((a) => ({
          severity: "high" as const,
          title: `${a} authored no records`,
          detail: r.traces.has(a)
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

// ---- output -------------------------------------------------------------------

const RANK = { high: 0, medium: 1, low: 2 };

function describe(r: Run) {
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

const runs: Run[] = [];
for (const d of dirs) {
  const r = await load(d);
  if (r) runs.push(r);
}
if (runs.length === 0) Deno.exit(1);
const reports = runs.map(describe);

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
