// What the chat DRAWS: the funnel every write goes through, and the two renderers on either side.
//
//   deno run -A examples/chat/smoke-render.ts
//
// No space, no model, no terminal. Three bugs live here and all three are invisible to a person
// reading the code, because each one only appears when two writers overlap or when the window is a
// size the author's was not.
//
//   A BACKGROUND WRITER SPLICED ITSELF INTO A STREAMING ANSWER. `ToolSet.refresh` runs from a
//   `capability` watch wakeup and printed directly, so a worker restarting mid-turn put
//   "[tool list may be incomplete...]" in the middle of the model's sentence. Worker stderr was
//   inherited and did the same, unlabelled, at whatever column the answer had reached.
//
//   THE STATUS LINE CORRUPTED ON A NARROW WINDOW. It was cut at a constant 100 columns, so on an
//   80-column terminal it wrapped to a second physical row and the redraw's `\r\x1b[2K` erased only
//   the row the cursor was on. The fragment on the first row stayed for the rest of the session.
//
//   COLOUR ESCAPED INTO PIPED OUTPUT. `terminal.ts` opens by saying redirected output must be
//   byte-identical to a run with no status at all. `dim()` did not follow it, so every saved
//   transcript carried `\x1b[2m` around a third of its lines. THIS SUITE runs with stdout piped,
//   which is exactly the condition the rule is about.

import { __captureOutput, columns, dim, ensureLine, flushNotices, holdLine, notice, statusText, write } from "./client/terminal.ts";
import { showArgs, showOutput } from "./client/turn.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ---- the funnel ----

{
  const cap = __captureOutput();
  notice("[a worker said something]");
  cap.stop();
  check("an idle line takes a notice immediately", cap.text() === "[a worker said something]\n", JSON.stringify(cap.text()));
}

{
  const cap = __captureOutput();
  holdLine(true);
  write("\nassistant> ");
  write("the answer begins");
  notice("[tool list may be incomplete]");
  write(" and ends.\n");
  const duringTurn = cap.text();
  holdLine(false);
  cap.stop();
  check(
    "a notice during a turn does NOT split the answer",
    !duringTurn.includes("[tool list may be incomplete]"),
    JSON.stringify(duringTurn),
  );
  check("…the answer is intact", duringTurn.endsWith("the answer begins and ends.\n"), JSON.stringify(duringTurn));
  check(
    "…and it lands once the turn releases the line",
    cap.text().endsWith("[tool list may be incomplete]\n"),
    JSON.stringify(cap.text().slice(-40)),
  );
}

{
  // The status line holds the cursor mid-row without a turn being in flight (the boot wait does
  // this). A notice printed there would land inside it.
  const cap = __captureOutput();
  write("  waiting");
  notice("[exec] a worker crashed");
  const mid = cap.text();
  write("\n");
  flushNotices();
  cap.stop();
  check("a notice mid-line waits for the line to end", mid === "  waiting", JSON.stringify(mid));
  check("…and is printed on its own line after it", cap.text() === "  waiting\n[exec] a worker crashed\n", JSON.stringify(cap.text()));
}

{
  const cap = __captureOutput();
  holdLine(true);
  notice("[first]");
  notice("[second]");
  write("mid-sentence");
  holdLine(false);
  cap.stop();
  // Order is the property: two workers reporting during one turn must not be interleaved or lost,
  // and a release that finds the cursor mid-row has to break the line before printing.
  check(
    "several held notices keep their order, after a line break",
    cap.text() === "mid-sentence\n[first]\n[second]\n",
    JSON.stringify(cap.text()),
  );
}

{
  // A worker in a restart loop writes to stderr for as long as the turn runs. The queue is bounded
  // so a screen of identical stack traces cannot bury the answer they interrupted, and the drop is
  // REPORTED, because a missing line reads as nothing having happened.
  const cap = __captureOutput();
  holdLine(true);
  for (let i = 0; i < 100; i++) notice(`[exec] failure ${i}`);
  holdLine(false);
  cap.stop();
  const lines = cap.text().trimEnd().split("\n");
  check("a flood of notices is bounded", lines.length < 60, `${lines.length} lines`);
  check("…keeping the first, which is the original failure", lines[0] === "[exec] failure 0", lines[0]);
  check("…and saying how many were dropped", lines[lines.length - 1].includes("60 more lines"), lines[lines.length - 1]);
}

// ---- width ----

{
  // Piped, so `columns()` reports its floor rather than throwing on `consoleSize`.
  check("width is known even with no terminal", columns() === 80, String(columns()));
  const long = "generating balanced · anthropic/claude-sonnet-5 (agent:chat-inference) · 12s and more and more";
  const prefix = "assistant> ";
  const cut = statusText(prefix, long);
  check(
    "a status line plus its prefix fits one row",
    prefix.length + cut.length < columns(),
    `${prefix.length + cut.length} of ${columns()}`,
  );
  check("…and says it was cut", cut.endsWith("…"), cut.slice(-12));
  check("a short status is left alone", statusText(prefix, "waiting · 1s") === "waiting · 1s");
  // A prefix wider than the window must not produce a negative budget and a thrown slice.
  check("an absurd prefix still yields a line", statusText("x".repeat(200), "waiting").length > 0);
}

// ---- colour ----

{
  const cap = __captureOutput();
  write(dim("dimmed"));
  cap.stop();
  check("piped output carries no escape sequences", cap.text() === "dimmed", JSON.stringify(cap.text()));
  check("…not even the reset", !cap.text().includes("\x1b"), JSON.stringify(cap.text()));
}

// ---- a line that has to stand on its own, after output that is not ours ----

{
  // The routing label follows the ANSWER, whose last character belongs to the model. Written
  // without checking, it was appended to the final sentence: a real transcript ended
  // "…let me know!  [fast · 34/228 msgs]".
  const cap = __captureOutput();
  write("the last sentence.");
  ensureLine();
  write("[fast]\n");
  cap.stop();
  check("a trailing label starts its own line", cap.text() === "the last sentence.\n[fast]\n", JSON.stringify(cap.text()));
}

{
  const cap = __captureOutput();
  write("already ended.\n");
  ensureLine();
  write("[fast]\n");
  cap.stop();
  check("…and adds no blank one when the line already ended", cap.text() === "already ended.\n[fast]\n", JSON.stringify(cap.text()));
}

// ---- the two renderers ----

check("one argument prints as its value", showArgs({ expr: "17+156223" }) === "17+156223", showArgs({ expr: "17+156223" }));
check(
  "several print as k=v",
  showArgs({ path: "a.ts", start: 1 }) === "path=a.ts start=1",
  showArgs({ path: "a.ts", start: 1 }),
);
check("no arguments print as nothing", showArgs({}) === "");

check("a scalar result prints as itself", showOutput(156240) === "156240");
check("a string result prints as itself", showOutput("done") === "done");
check("nothing prints as nothing", showOutput(null) === "(nothing)");
{
  // The case that made this worth writing: an image result was `{"artifactId":"01K…","mediaType":…}`
  // truncated at 80 characters, so the line showed punctuation and no answer.
  const out = showOutput({ artifactId: "01KZ7BKE1Z", mediaType: "image/png", size: 4096, model: "vendor/eyes" });
  check("an object leads with the field that carries the answer", out.startsWith("01KZ7BKE1Z"), out);
  check("…and says how much is not shown", out.includes("+3"), out);
}
check(
  "an answer beats an id when both are present",
  showOutput({ artifactId: "01K", answer: "a tabby cat" }).startsWith("a tabby cat"),
  showOutput({ artifactId: "01K", answer: "a tabby cat" }),
);
check("an object with no obvious field falls back to JSON", showOutput({ a: 1, b: 2 }) === '{"a":1,"b":2}', showOutput({ a: 1, b: 2 }));
check("an empty primary field is not chosen", showOutput({ answer: "", name: "run-7" }).startsWith("run-7"), showOutput({ answer: "", name: "run-7" }));

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
