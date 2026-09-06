// `radia activity` (src/surfaces/activity.ts): the console's Activity timeline in a terminal.
//
// Two contracts. The MODEL must agree with the console's `activityModel` (test/console.test.ts pins
// that one on the same cases): a take of another agent's record in the tail is a handoff, a take of
// one's own is not, a take of a record older than the tail is credited to the "written earlier"
// source, and a full tail younger than the window says the window is cut. The RENDERING must be
// plain text without colour (a pipe, NO_COLOR, --no-color) and carry the lanes, the axis, the
// handoffs and the legend either way.
import { assert, assertEquals } from "@std/assert";
import { activityModel, EARLIER, kindColor, renderActivity, TAIL, wantColor } from "../src/surfaces/activity.ts";
import type { SpaceEvent } from "../sdk/ts/client.ts";

const now = Date.parse("2026-09-05T12:00:00Z");
const at = (s: number) => new Date(now - s * 1000).toISOString();
let seq = 0;
const ev = (operation: string, runId: string, recordId: string, kind: string, ago: number): SpaceEvent =>
  ({ seq: ++seq, cursor: String(seq), id: `01M${seq}`, ts: at(ago), operation, runId, recordId, kind }) as unknown as SpaceEvent;
const name = (r: string) => ({ "run:a": "agent:a", "run:b": "agent:b", "run:c": "agent:c" })[r] ?? r;
const events = [
  ev("put", "run:a", "r1", "task", 50),
  ev("take", "run:b", "r1", "task", 40), // a handoff: A wrote, B claimed, 10s later
  ev("ack", "run:b", "r1", "task", 35),
  ev("put", "run:b", "r2", "note", 30),
  ev("take", "run:b", "r2", "note", 20), // B's own record: no handoff
  ev("take", "run:c", "old", "task", 10), // written before the tail reaches
  ev("nack", "run:c", "old", "task", 5),
];

Deno.test("activity: the model credits a handoff to the writer and never to the claimer's own record", () => {
  const m = activityModel(events, name, now, 60_000);
  assertEquals(m.handoffs.map((h) => `${h.from}>${h.to}:${h.kind}x${h.n}`), ["agent:a>agent:b:taskx1", `${EARLIER}>agent:c:taskx1`]);
  assertEquals(m.handoffs[0].delays, [10]);
  assertEquals(m.handoffs[1].delays, [], "a write outside the tail has no delay to report");
  assertEquals(m.agents.get("agent:b")!.own, 1);
  assertEquals(m.agents.get("agent:b")!.claims, 2);
  assertEquals(m.marks.length, 7);
  assertEquals(m.kinds, ["note", "task"]);
  assertEquals(activityModel(events, name, now, 60_000, "note").marks.length, 2);
  assertEquals(activityModel(events, name, now, 15_000).marks.length, 2, "the window excludes what is older than it");
});

Deno.test("activity: a full tail younger than the window reports the window as cut", () => {
  const full = Array.from({ length: TAIL }, (_, i) => ev("put", "run:a", `f${i}`, "task", 50 - (i % 50)));
  assertEquals(activityModel(full, name, now, 60_000).covered, false);
  assertEquals(activityModel(full, name, now, 45_000).covered, true);
  assertEquals(activityModel(events, name, now, 60_000).covered, true, "a partial tail is the whole log");
});

Deno.test("activity: colour is off into a pipe, under NO_COLOR, and past --no-color", () => {
  assertEquals(wantColor(false, undefined, true), true);
  assertEquals(wantColor(false, undefined, false), false);
  assertEquals(wantColor(false, "", true), false, "NO_COLOR set to anything, the empty string included");
  assertEquals(wantColor(true, undefined, true), false);
});

Deno.test("activity: the plain rendering carries lanes, an axis, the handoffs and the legend, and no escapes", () => {
  const m = activityModel(events, name, now, 60_000);
  const text = renderActivity(m, { columns: 80, color: false, windowLabel: "the last minute" });
  assert(!text.includes("\x1b["), "no ANSI without colour");
  assert(text.includes("7 events in the last minute: 2 written, 3 claimed, 2 handed between agents, 3 agents active"), text);
  for (const a of ["agent:a", "agent:b", "agent:c"]) assert(text.includes(a), `lane for ${a}`);
  assert(!text.split("\n").some((l) => l.includes(EARLIER) && l.includes("┈")), "the earlier source gets no lane");
  assert(/agent:a\s+→\s+agent:b\s+task ×1\s+claimed 10s after the write \(median\)/.test(text), text);
  assert(new RegExp(`\\${EARLIER.slice(0, 1)}${EARLIER.slice(1, -1)}\\)\\s+→\\s+agent:c\\s+task ×1`).test(text), text);
  assert(/-1m .*now/.test(text), "the axis runs from the window start to now");
  assert(text.includes("● written  ○ claimed  ■ answered  ✕ handed back"), "legend");
  assert(text.includes("colour is the kind: note, task"), "kind legend");
  // The lane rows: B's row holds a write, two claims and an answer; the answer outranks the claim
  // if they share a cell, and the glyphs land in time order.
  const rowB = text.split("\n").find((l) => l.startsWith("agent:b".padStart(8)))!;
  assert(/○.*●.*○/.test(rowB) || /■.*●.*○/.test(rowB), rowB);
  const colored = renderActivity(m, { columns: 80, color: true });
  assert(colored.includes(`\x1b[38;5;${kindColor("task")}m`), "kind colour applied");
  assert(colored.includes("\x1b[0m"));
});

Deno.test("activity: an empty window says so rather than drawing nothing", () => {
  const text = renderActivity(activityModel([], name, now, 60_000), { columns: 80, color: false });
  assert(text.startsWith("nothing happened in the last 1 minutes"), text);
});

Deno.test("activity: a kind's colour is stable and never a dark cube entry", () => {
  assertEquals(kindColor("task"), kindColor("task"));
  for (const k of ["task", "note", "llm_call", "tool_call", "message", "x", "artifact"]) {
    const c = kindColor(k) - 16;
    const r = Math.floor(c / 36), g = Math.floor(c / 6) % 6, b = c % 6;
    assert([r, g, b].filter((v) => v >= 3).length >= 2, `${k} -> ${kindColor(k)} is too dark`);
  }
});

Deno.test("activity: a follow frame fits the terminal, keeping the latest lanes", () => {
  // `--follow` repaints in place, so a frame taller than the screen loses its HEAD: the summary and
  // the lanes scroll away and the reader is left watching the legend. Twenty agents and twenty
  // handoff pairs is more than any terminal shows, which is the case a live team reaches.
  let n = 0;
  const many: SpaceEvent[] = [];
  for (let a = 0; a < 20; a++) {
    for (let i = 0; i < 4; i++) {
      // Higher-numbered agents act LATER, so recency and busyness disagree and the tie-break shows.
      const ago = (20 - a) * 30 + i;
      many.push(ev("put", `run:x${a}`, `p${a}-${i}`, `k${a % 5}`, ago));
      many.push(ev("take", `run:x${a}`, `p${(a + 1) % 20}-${i}`, `k${a % 5}`, ago));
    }
    n++;
  }
  many.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const m = activityModel(many, (r) => r.replace("run:x", "agent:x"), now, 3_600_000);
  assertEquals(m.agents.size, 20);

  const height = (rows: number | undefined) => renderActivity(m, { columns: 100, color: false, rows }).replace(/\n$/, "").split("\n").length;
  assert(height(undefined) > 24, `unbounded should be tall: ${height(undefined)}`);
  // Every plausible terminal, down to sizes where the overhead alone does not fit and the frame is
  // trimmed rather than allowed to scroll.
  for (const rows of [40, 30, 24, 20, 14, 10, 6, 3]) {
    assert(height(rows) <= rows, `${rows} rows produced ${height(rows)} lines`);
  }
  assert(height(40) >= 30, `a tall terminal should be USED, not left mostly empty: ${height(40)}`);

  // Prioritised by RECENCY: the agents that acted last survive the cut, and the picture keeps more
  // rows than its annotation.
  const short = renderActivity(m, { columns: 100, color: false, rows: 16 });
  // A LANE line, not any mention: `agent:x0` still appears as the source of a handoff, which is a
  // different thing from having a row of its own.
  const laneNames = short.split("\n").filter((l) => /^\s*agent:x\d+\s+[┈●○■✕]/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  assert(laneNames.includes("agent:x19"), `the most recent lane is drawn: ${laneNames}`);
  assert(!laneNames.includes("agent:x0"), `the least recent lane is not: ${laneNames}`);
  assert(short.includes("less active agents not drawn"), "and the frame says how many it dropped");
  const laneLines = laneNames.length;
  const handoffLines = short.split("\n").filter((l) => /→/.test(l)).length;
  assert(laneLines > handoffLines, `lanes are the picture, handoffs annotate it: ${laneLines} vs ${handoffLines}`);
  assert(/… \d+ more/.test(short), "the handoffs it could not fit are counted");
});
