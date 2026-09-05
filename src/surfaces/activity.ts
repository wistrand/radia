// `radia activity`: the console's Activity timeline in a terminal. One lane per agent, time across,
// every event a mark coloured by its kind, and the handoffs (a record one agent wrote and another
// claimed) listed below the lanes. A CLIENT of two reads the console already makes,
// `GET /v0/ops/events?tail=` and one `agent_run` lookup per run; nothing here is a new server
// surface, and the model is the console's `activityModel` in `src/ui/index.html`, kept in step by
// `test/activity.test.ts` asserting the same cases.
//
// Colour is ANSI 256 and is OFF whenever stdout is not a terminal, `NO_COLOR` is set (any value,
// per no-color.org) or `--no-color` is passed, so a piped run is plain text.

import type { RadiaClient, SpaceEvent } from "../../sdk/ts/client.ts";

export const WINDOWS: Record<string, number> = { "2m": 120_000, "10m": 600_000, "1h": 3_600_000 };
/** The server's cap on `tail`: asking for more returns this many and would read as a full window. */
export const TAIL = 500;
export const EARLIER = "(written earlier)";
export const MAX_AGENTS = 12;

export type OpClass = "put" | "take" | "ack" | "fail" | "other";

export interface Mark {
  ts: number;
  agent: string;
  op: OpClass;
  operation: string;
  kind: string;
  id: string;
}

export interface Handoff {
  from: string;
  to: string;
  kind: string;
  n: number;
  /** Seconds from write to claim, for the handoffs whose write is inside the window. */
  delays: number[];
}

export interface AgentStats {
  events: number;
  writes: number;
  claims: number;
  own: number;
}

export interface ActivityModel {
  since: number;
  now: number;
  windowMs: number;
  /** False when the tail is full and its oldest event is younger than the window start. */
  covered: boolean;
  oldestAgeS: number;
  agents: Map<string, AgentStats>;
  handoffs: Handoff[];
  marks: Mark[];
  kinds: string[];
}

export function opClass(op: string): OpClass {
  if (op === "put") return "put";
  if (op === "take" || op === "renew") return "take";
  if (op === "ack") return "ack";
  if (op === "nack" || op === "expire" || op === "dead_letter" || op === "quarantine") return "fail";
  return "other";
}

/**
 * The window's events as lanes and handoffs. PURE. `name` turns a run id into the agent to draw
 * (the durable principal where it is known, else the run); `now` is the DB clock. A `take` of a
 * record whose `put` is in the tail and was made by another agent is a handoff; a take of one's
 * own record is `own` and draws nothing; a take of a record older than the tail is credited to
 * `EARLIER`, which is listed as a source and never given a lane.
 */
export function activityModel(
  events: SpaceEvent[],
  name: (runId: string) => string,
  now: number,
  windowMs: number,
  kindFilter?: string,
): ActivityModel {
  const since = now - windowMs;
  const oldest = events.length ? Date.parse(events[0].ts) : now;
  const covered = events.length < TAIL || oldest <= since;
  const writer = new Map<string, { agent: string; ts: number }>();
  for (const e of events) if (e.operation === "put" && e.recordId) writer.set(e.recordId, { agent: name(e.runId), ts: Date.parse(e.ts) });
  const agents = new Map<string, AgentStats>();
  const touch = (a: string): AgentStats => {
    let s = agents.get(a);
    if (!s) agents.set(a, s = { events: 0, writes: 0, claims: 0, own: 0 });
    return s;
  };
  const handoffs = new Map<string, Handoff>();
  const marks: Mark[] = [];
  const kinds = new Set<string>();
  for (const e of events) {
    if (!e.recordId) continue;
    const ts = Date.parse(e.ts);
    if (ts < since || (kindFilter && e.kind !== kindFilter)) continue;
    const agent = name(e.runId), a = touch(agent);
    a.events++;
    if (e.kind) kinds.add(e.kind);
    marks.push({ ts, agent, op: opClass(e.operation), operation: e.operation, kind: e.kind ?? "", id: e.recordId });
    if (e.operation === "put") a.writes++;
    if (e.operation !== "take") continue;
    a.claims++;
    const w = writer.get(e.recordId);
    if (w && w.agent === agent) {
      a.own++;
      continue;
    }
    const from = w ? w.agent : EARLIER;
    touch(from);
    const key = `${from}\0${agent}\0${e.kind ?? ""}`;
    let h = handoffs.get(key);
    if (!h) handoffs.set(key, h = { from, to: agent, kind: e.kind ?? "", n: 0, delays: [] });
    h.n++;
    if (w && w.ts >= since) h.delays.push((ts - w.ts) / 1000);
  }
  return {
    since,
    now,
    windowMs,
    covered,
    oldestAgeS: Math.max(0, Math.round((now - oldest) / 1000)),
    agents,
    handoffs: [...handoffs.values()].sort((x, y) => y.n - x.n),
    marks,
    kinds: [...kinds].sort(),
  };
}

/** Whether to colour: never into a pipe, never under NO_COLOR (any value), never past --no-color. */
export function wantColor(noColorFlag: boolean, noColorEnv: string | undefined, isTerminal: boolean): boolean {
  return !noColorFlag && noColorEnv === undefined && isTerminal;
}

// ---- rendering ----

const GLYPH: Record<OpClass, string> = { put: "●", take: "○", ack: "■", fail: "✕", other: "·" };
const RANK: Record<OpClass, number> = { fail: 4, ack: 3, take: 2, put: 1, other: 0 };
const ESC = "\x1b[";

/** A kind's colour: an ANSI 256 cube entry hashed from the name, kept bright enough to read on
 *  either background (the same hash the console uses for its hue, so the two agree per kind). */
export function kindColor(kind: string): number {
  let h = 0;
  for (const c of kind) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  // 6x6x6 cube: pick r,g,b in 1..5 with at least two channels >= 3, so nothing lands near black.
  const r = 1 + (h % 5), g = 1 + (Math.floor(h / 5) % 5), b = 1 + (Math.floor(h / 25) % 5);
  const bright = [r, g, b].filter((c) => c >= 3).length >= 2 ? [r, g, b] : [Math.max(r, 3), Math.max(g, 3), b];
  return 16 + 36 * bright[0] + 6 * bright[1] + bright[2];
}

function paint(text: string, color: boolean, sgr: string): string {
  return color ? `${ESC}${sgr}m${text}${ESC}0m` : text;
}

function ago(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `-${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return `-${m}m${s ? s + "s" : ""}`;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface RenderOptions {
  columns: number;
  color: boolean;
  maxAgents?: number;
  windowLabel?: string;
}

/** The model as text: a summary line, the lanes with a time axis, the handoffs, a legend. */
export function renderActivity(m: ActivityModel, o: RenderOptions): string {
  const color = o.color, maxAgents = o.maxAgents ?? MAX_AGENTS;
  const label = o.windowLabel ?? `the last ${Math.round(m.windowMs / 60_000)} minutes`;
  const real = [...m.agents].filter(([a]) => a !== EARLIER);
  const writes = real.reduce((n, [, a]) => n + a.writes, 0), claims = real.reduce((n, [, a]) => n + a.claims, 0);
  const handed = m.handoffs.reduce((n, h) => n + h.n, 0);
  const lines: string[] = [];
  if (!m.marks.length) {
    lines.push(`nothing happened in ${label}. Widen the window (--window 1h), or run an example against this space.`);
    if (!m.covered) lines.push(`(the log's last ${TAIL} events reach back only ${m.oldestAgeS}s)`);
    return lines.join("\n") + "\n";
  }
  lines.push(
    `${m.marks.length} event${m.marks.length === 1 ? "" : "s"} in ${label}: ${writes} written, ${claims} claimed, ` +
      `${handed} handed between agents, ${real.length} agent${real.length === 1 ? "" : "s"} active`,
  );
  if (!m.covered) lines.push(paint(`the log's last ${TAIL} events reach back only ${m.oldestAgeS}s, so the window is cut there`, color, "33"));
  lines.push("");

  // Lanes: the most active agents, one row each, the window across the remaining columns.
  const lanes = real.sort((x, y) => y[1].events - x[1].events).slice(0, maxAgents).map(([a]) => a);
  const labelW = Math.min(28, Math.max(8, ...lanes.map((a) => a.length)));
  const cols = Math.max(20, o.columns - labelW - 3);
  const span = m.now - m.since;
  const col = (ts: number) => Math.min(cols - 1, Math.max(0, Math.floor(((ts - m.since) / span) * cols)));
  for (const a of lanes) {
    const cells: ({ op: OpClass; kind: string; n: number } | undefined)[] = new Array(cols);
    for (const k of m.marks) {
      if (k.agent !== a) continue;
      const c = col(k.ts), cur = cells[c];
      if (!cur) cells[c] = { op: k.op, kind: k.kind, n: 1 };
      else {
        cur.n++;
        if (RANK[k.op] > RANK[cur.op]) {
          cur.op = k.op;
          cur.kind = k.kind;
        }
      }
    }
    let row = "";
    for (let i = 0; i < cols; i++) {
      const c = cells[i];
      if (!c) {
        row += paint("┈", color, "2");
        continue;
      }
      const sgr = `${c.n > 1 ? "1;" : ""}38;5;${kindColor(c.kind || "?")}`;
      row += paint(GLYPH[c.op], color, sgr);
    }
    const name = a.length > labelW ? (a.startsWith("run:") ? "run:…" + a.slice(-(labelW - 5)) : a.slice(0, labelW - 1) + "…") : a;
    lines.push(`${name.padStart(labelW)}  ${row}`);
  }
  // Axis: five ticks, as seconds ago.
  let axis = " ".repeat(labelW + 2);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ c: Math.min(cols - 1, Math.floor(f * cols)), t: ago(Math.round((span * (1 - f)) / 1000)) }));
  let at = 0;
  for (const t of ticks) {
    const pos = t.c - (t.c === cols - 1 ? t.t.length - 1 : 0);
    if (pos < at) continue;
    axis += " ".repeat(pos - at) + t.t;
    at = pos + t.t.length;
  }
  lines.push(paint(axis, color, "2"));
  const more = real.length - lanes.length;
  if (more > 0) lines.push(paint(`${more} less active agent${more === 1 ? "" : "s"} not drawn`, color, "2"));
  lines.push("");

  // Handoffs: who wrote, who claimed, how many, how long they waited.
  if (m.handoffs.length) {
    lines.push("handoffs (written by → claimed by):");
    const fromW = Math.max(...m.handoffs.map((h) => h.from.length)), toW = Math.max(...m.handoffs.map((h) => h.to.length));
    for (const h of m.handoffs.slice(0, 20)) {
      const med = median(h.delays);
      lines.push(
        `  ${h.from.padEnd(fromW)}  →  ${h.to.padEnd(toW)}  ${paint(h.kind || "?", color, `38;5;${kindColor(h.kind || "?")}`)} ×${h.n}` +
          (med === undefined ? "" : paint(`  claimed ${med < 10 ? med.toFixed(1) : Math.round(med)}s after the write (median)`, color, "2")),
      );
    }
    if (m.handoffs.length > 20) lines.push(paint(`  … ${m.handoffs.length - 20} more`, color, "2"));
  } else {
    const own = real.reduce((n, [, a]) => n + a.own, 0);
    lines.push(`no record changed hands in this window${own ? ` (${own} claim${own === 1 ? "" : "s"} of an agent's own record)` : ""}`);
  }
  lines.push("");
  lines.push(
    `${GLYPH.put} written  ${GLYPH.take} claimed  ${GLYPH.ack} answered  ${GLYPH.fail} handed back, expired or given up` +
      (color ? "  bold = several in one cell" : "  (a cell shows its most significant event)"),
  );
  if (m.kinds.length) lines.push("colour is the kind: " + m.kinds.map((k) => paint(k, color, `38;5;${kindColor(k)}`)).join(", "));
  return lines.join("\n") + "\n";
}

// ---- loading ----

/** The two reads, with runs resolved to agents fail-soft: a session that may not read `agent_run`
 *  keeps the run id in the lane rather than losing the lane. */
export async function loadActivity(
  client: RadiaClient,
  windowMs: number,
  kind?: string,
  memo: Map<string, string> = new Map(),
): Promise<ActivityModel> {
  const [page, health] = await Promise.all([client.getEventsPage("0", TAIL, { tail: TAIL }), client.health()]);
  const events = page.events;
  const now = health.now ? Date.parse(health.now) : Date.now();
  const runs = [...new Set(events.map((e) => e.runId).filter((r) => r && r.startsWith("run:") && !memo.has(r)))];
  await Promise.all(runs.map(async (run) => {
    try {
      const rows = await client.queryNewest<{ agent?: string }>({ kind: "agent_run", match: { run } }, 1);
      memo.set(run, rows[0]?.body.agent ?? run);
    } catch {
      memo.set(run, run);
    }
  }));
  return activityModel(events, (r) => memo.get(r) ?? r, now, windowMs, kind);
}

/** The model as JSON: the same figures the text shows, for a script. */
export function activityJson(m: ActivityModel): unknown {
  return {
    since: new Date(m.since).toISOString(),
    now: new Date(m.now).toISOString(),
    covered: m.covered,
    agents: Object.fromEntries([...m.agents].map(([a, s]) => [a, s])),
    handoffs: m.handoffs.map((h) => ({ from: h.from, to: h.to, kind: h.kind, n: h.n, medianDelayS: median(h.delays) })),
    events: m.marks.length,
    kinds: m.kinds,
  };
}
