// The process logger (`src/log.ts`): levels, structure, and the two properties that decide whether
// a logging subsystem is safe to put in a coordination runtime.
//
// It must not break the thing it observes (an unwritable file disables the file and says so, once),
// and it must not write where a protocol lives (`radia mcp` speaks JSON-RPC on stdout, so the
// default sink is stderr and nothing here may reach stdout).

import { assert, assertEquals } from "@std/assert";
import { configureLogging, getLogger, type LogEntry, type LogLevel, parseLevel, recentLogs } from "../src/log.ts";

/** Capture the lines a logger renders, without a terminal or a file. */
function captured(level: LogLevel = "info") {
  const lines: string[] = [];
  configureLogging({ level, sink: (l) => lines.push(l), buffer: 50 });
  return lines;
}

Deno.test("[log] a level filters what is emitted, and the filter is checkable before building a message", () => {
  const lines = captured("warn");
  const log = getLogger("t");
  log.debug("no");
  log.info("no");
  log.warn("yes");
  log.error("yes");
  assertEquals(lines.length, 2);
  assert(lines[0].includes("WARN"), lines[0]);
  assertEquals(log.isDebug(), false, "isDebug guards a message whose CONTEXT costs something to build");

  const verbose = captured("debug");
  getLogger("t").debug("now");
  assertEquals(verbose.length, 1);
  assertEquals(getLogger("t").isDebug(), true);
});

Deno.test("[log] a line carries its source, its context, and an error unfolded", () => {
  const lines = captured();
  getLogger("core").child("space").warn("settle rejected", { op: "ack", owner: "run:abc" });
  const line = lines[0];
  assert(line.includes("core.space"), `the component must be named: ${line}`);
  assert(line.includes("op=ack") && line.includes("owner=run:abc"), `context must be structured: ${line}`);

  getLogger("x").error("boom", { error: new Error("the cause") });
  assert(lines[1].includes("the cause"), `an error must be unfolded, not "[object Object]": ${lines[1]}`);
});

Deno.test("[log] a huge value is clipped, because a line nobody reads is worse than no line", () => {
  const lines = captured();
  getLogger("x").info("big", { body: "A".repeat(5000) });
  assert(lines[0].length < 500, `a record body must not become the log: ${lines[0].length} chars`);
  assert(lines[0].includes("…"), "…and the clip must be visible");
});

Deno.test("[log] the ring buffer keeps a bounded tail, for a reader with no file", () => {
  configureLogging({ level: "info", sink: () => {}, buffer: 3 });
  for (let i = 0; i < 10; i++) getLogger("x").info(`m${i}`);
  const tail = recentLogs();
  assertEquals(tail.length, 3, "the buffer is bounded, or a long run is a leak");
  assertEquals(tail.map((e: LogEntry) => e.message), ["m7", "m8", "m9"], "newest last");
  assertEquals(recentLogs(1).map((e: LogEntry) => e.message), ["m9"]);
});

Deno.test("[log] an unwritable file disables itself once and never throws at the call site", () => {
  const lines: string[] = [];
  configureLogging({ level: "info", file: "/nonexistent-dir-for-radia/x.jsonl", sink: (l) => lines.push(l) });
  // The call must return normally: a full disk cannot be allowed to end a coordination process.
  getLogger("x").info("first");
  getLogger("x").info("second");
  const warnings = lines.filter((l) => l.includes("continuing without the file"));
  assertEquals(warnings.length, 1, "it says so ONCE, not once per line");
  assertEquals(lines.filter((l) => l.includes("second")).length, 1, "and logging continues");
});

Deno.test("[log] a file gets JSONL while the terminal gets text", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-log-" });
  const path = `${dir}/log.jsonl`;
  const lines: string[] = [];
  try {
    configureLogging({ level: "info", file: path, sink: (l) => lines.push(l) });
    getLogger("core").info("started", { port: 7788 });

    const written = (await Deno.readTextFile(path)).trim().split("\n");
    assertEquals(written.length, 1, "one call is one line, or the file is not JSONL");
    const entry = JSON.parse(written[0]) as LogEntry;
    assertEquals(entry.level, "info");
    assertEquals(entry.source, "core");
    assertEquals(entry.context?.port, 7788, "the file keeps context as DATA; the terminal renders it");
    assert(typeof entry.ts === "string" && entry.ts.endsWith("Z"));

    // Two formats on purpose: one is read by a person, the other by a program, and a format that
    // serves both serves neither.
    assert(lines[0].startsWith(entry.ts.slice(11, 23)), `the terminal line is text: ${lines[0]}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[log] an unknown level is reported by the caller rather than silently ignored", () => {
  assertEquals(parseLevel("debug"), "debug");
  assertEquals(parseLevel("WARN"), undefined, "levels are lower case; a near miss is not a level");
  assertEquals(parseLevel("chatty"), undefined);
  assertEquals(parseLevel(undefined), undefined);
});
