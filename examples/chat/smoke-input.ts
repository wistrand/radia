// Terminal input: the keystroke that used to go missing between a turn and the next prompt.
//
//   deno run -A examples/chat/smoke-input.ts
//
// No space, no model: this is the REPL's stdin plumbing on its own. It is here rather than in
// `test/` because it is an example's client code, and it is a suite rather than a review note
// because the bug was REPORTED by someone using the chat, not found by reading:
//
//   "the chat input sometimes misses an enter and needs an extra enter to run command"
//
// The cause was two readers on one exclusive stream. A `read()` already in flight cannot be
// cancelled, so when a turn ended the cancel watcher still had one parked; the next `nextLine()`
// queued a SECOND read behind it, and the user's line resolved the WATCHER's, which stashed it while
// the line reader went on waiting for input that had already arrived. Pressing Enter again resolved
// the line reader with the newer bytes, and the stash was appended AFTER them, so the command ran a
// keystroke late behind a blank line.
//
// The interleaving is invisible to piped input, because `watchCancel` is a no-op off a terminal.
// That is what `__useTestInput` exists for.

import { __captureOutput, __useTestInput, lineReader, watchCancel } from "./client/terminal.ts";

// The editor writes to the screen, and history writes to a FILE. Neither belongs in a suite: the
// redraws would bury the OK lines, and the default history path is the user's own.
Deno.env.set("RADIA_CHAT_HISTORY", await Deno.makeTempFile({ prefix: "radia-history-" }));
__captureOutput();

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const enc = new TextEncoder();

/** A fresh stand-in for stdin, plus the writer that plays the user's keystrokes. */
function keyboard() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  __useTestInput(readable);
  const w = writable.getWriter();
  return { type: (s: string) => w.write(enc.encode(s)), close: () => w.close() };
}

/** Fail rather than hang: the pre-fix bug's signature is a `nextLine()` that never resolves. */
function within<T>(ms: number, p: Promise<T>): Promise<T | "TIMED OUT"> {
  return Promise.race([p, new Promise<"TIMED OUT">((r) => setTimeout(() => r("TIMED OUT"), ms))]);
}

// ---- the reported bug ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  // A turn runs and ends. `stop()` cannot cancel the watcher's parked read, which is the whole
  // problem: the watcher is still attached to the stream when the prompt comes back.
  const stop = watchCancel(() => {});
  stop();
  // The REPL is now at the prompt, waiting. THEN the user types. This order is the bug's: reversing
  // it hides the race, which is why the line reader is started before anything is typed.
  const pending = nextLine();
  await kb.type("hello\n");
  check("one Enter runs the command", (await within(2000, pending)) === "hello");
}

// ---- type-ahead during a turn still survives ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  const stop = watchCancel(() => {});
  await kb.type("typed during the turn\n"); // the user types while the assistant is still working
  stop();
  check("type-ahead survives the turn", (await within(2000, nextLine())) === "typed during the turn");
}

// ---- Escape cancels, and does not leak into the next prompt ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  let cancelled = false;
  const stop = watchCancel(() => (cancelled = true));
  await kb.type("\x1b");
  await new Promise((r) => setTimeout(r, 20));
  stop();
  check("ESC alone cancels the turn", cancelled);
  const pending = nextLine();
  await kb.type("next\n");
  const line = await within(2000, pending);
  // The ESC is a command, not text. Left in the buffer it would prefix the next line the user typed.
  check("…and is not delivered as text to the next prompt", line === "next", String(line));
}

// ---- Ctrl-C during a turn cancels too, and spares the type-ahead around it ----
// Raw mode takes SIGINT away, so 0x03 is just a byte — and it sat in the type-ahead buffer doing
// nothing until the next prompt, which read live as "Ctrl-C does not work while calls run".
{
  const kb = keyboard();
  const nextLine = lineReader();
  let cancelled = false;
  const stop = watchCancel(() => (cancelled = true));
  // "next" on purpose: these blocks share one history file, and a NEW word here would become the
  // newest entry and break the arrow-recall case below.
  await kb.type("next"); // type-ahead the user meant for the next prompt
  await kb.type("\x03");
  await new Promise((r) => setTimeout(r, 20));
  stop();
  check("Ctrl-C during a turn cancels it", cancelled);
  const pending = nextLine();
  await kb.type("\n");
  const line = await within(2000, pending);
  check("…consuming only the interrupt, never the typing around it", line === "next", JSON.stringify(line));
}

// ---- an escape SEQUENCE is not a cancel ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  let cancelled = false;
  const stop = watchCancel(() => (cancelled = true));
  await kb.type("\x1b[A"); // Up arrow: starts with ESC, is not one
  await new Promise((r) => setTimeout(r, 20));
  check("an arrow key does not cancel", !cancelled);
  stop();
  // It stays in the buffer for the PROMPT to interpret, which is now a history recall rather than
  // three literal bytes in the line. That this test used to assert the literal bytes is exactly the
  // bug the editor exists to fix: in cooked mode nobody handled arrow keys, so pressing one typed
  // `^[[A` into whatever you were writing.
  const pending = nextLine();
  await kb.type("\n");
  const recalled = await within(2000, pending);
  check("…and reaches the prompt as a key, not as text", !String(recalled).includes("\x1b"), JSON.stringify(recalled));
  // "next" is what the block above submitted, and history is shared across these blocks by the
  // temp file at the top. Up recalling it is the arrow key doing its job.
  check("…so Up recalls the previous line", recalled === "next", JSON.stringify(recalled));
}

// ---- a line split across chunks is still one line ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine();
  await kb.type("half ");
  await kb.type("and half\n");
  check("a line split across reads arrives whole", (await within(2000, pending)) === "half and half");
}

// ---- end of input ----
{
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine();
  await kb.type("no trailing newline");
  await kb.close();
  check("a final line without a newline is still returned", (await within(2000, pending)) === "no trailing newline");
  check("…and then input ends", (await within(2000, nextLine())) === null);
}

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
