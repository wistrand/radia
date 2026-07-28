// The context payload, checked without a model:
//
//   deno run -A examples/chat/smoke-context.ts
//
// `assembleContext` is pure, so the provider's protocol rules can be asserted directly. Both bugs
// this file guards against were found in production, not in review: a window that evicted the very
// question being answered, and a `system` message in a position no provider accepts (which is what
// a RESUMED conversation produces, since resume appends fresh standing instructions mid-thread).

import { assembleContext, type ThreadRow } from "./provider/context.ts";

const check = (label: string, pass: boolean, detail = "") => console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
const row = (index: number, role: string, content = `m${index}`): ThreadRow => ({ index, role, content });

/** The rule every provider enforces: at most one system message, and it must lead. */
function systemPlacementOk(messages: { role: string }[]): boolean {
  const at = messages.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
  return at.length === 0 || (at.length === 1 && at[0] === 0);
}

// A resumed conversation: the original system message, a prior session, then FRESH standing
// instructions appended at index 11. That is the exact shape that returned a 400.
const resumed = [
  row(0, "system", "old instructions"),
  ...Array.from({ length: 10 }, (_, i) => row(i + 1, i % 2 === 0 ? "user" : "assistant")),
  row(11, "system", "current instructions"),
  row(12, "user", "what happened in this space"),
];
const a = assembleContext(resumed[11], resumed);
check("a resumed thread yields a valid system placement", systemPlacementOk(a.messages));
check("exactly one system message survives", a.messages.filter((m) => m.role === "system").length === 1);
check("and it carries the NEWEST instructions", String(a.messages[0].content).includes("current instructions"));
check("the stale one is gone from the body", !a.messages.slice(1).some((m) => String(m.content).includes("old instructions")));
// 13 rows in, 2 of them system: one leading system message plus the 11 non-system turns.
check("every non-system turn is kept", a.messages.length === 12, `${a.messages.length} messages`);

// Windowing: the notice used to be its own system message right after the head. Same violation,
// on any conversation long enough to drop messages.
const windowed = [row(7, "user"), row(8, "assistant"), row(9, "user")];
const b = assembleContext(row(0, "system", "instructions"), windowed);
check("a windowed thread yields a valid system placement", systemPlacementOk(b.messages));
check("the hidden-message notice is folded into the system message", String(b.messages[0].content).includes("not included here"));
check("and reports how many are missing", b.hidden === 6, `hidden=${b.hidden}`);

// An unwindowed thread says nothing about hidden messages.
const whole = [row(1, "user"), row(2, "assistant")];
const c = assembleContext(row(0, "system", "instructions"), whole);
check("a complete thread carries no notice", !String(c.messages[0].content).includes("not included"));
check("and reports nothing hidden", c.hidden === 0);

// A tool reply whose assistant call fell outside the window is a protocol error on its own.
const orphan = [row(5, "tool"), row(6, "tool"), row(7, "assistant"), row(8, "user")];
const d = assembleContext(row(0, "system", "s"), orphan);
check("orphaned tool replies are trimmed", d.messages.filter((m) => m.role === "tool").length === 0);
check("…but the rest of the window is kept", d.messages.length === 3);

// A conversation with no system message at all must not fabricate one.
const e = assembleContext(undefined, [row(0, "user")]);
check("no system message means no head", e.messages.length === 1 && e.messages[0].role === "user");
