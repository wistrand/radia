// The line editor: what a keystroke means, and what the line looks like afterwards.
//
//   deno run -A examples/chat/smoke-edit.ts
//
// The prompt runs in RAW MODE now, which is what buys arrow keys, word motion and history, and what
// obliges the chat to answer every key the terminal driver used to answer for it. Ctrl-C no longer
// raises a signal. Escape sequences arrive in as many pieces as the terminal feels like sending. A
// paste is a burst of bytes that happens to contain newlines. None of that is testable through a
// keyboard, and all of it is a pure function of the input, so it lives in `client/edit.ts` with no
// I/O in it and gets driven from here.
//
// The half that IS I/O (raw mode, the shared stdin pump, the redraw) is exercised through the real
// `lineReader` at the bottom, over the same test seam `smoke-input.ts` uses.

import { decodeKey, History, LineBuffer, loadHistory, renderLine, saveHistory } from "./client/edit.ts";
import { __captureOutput, __useTestInput, lineReader } from "./client/terminal.ts";

Deno.env.set("RADIA_CHAT_HISTORY", await Deno.makeTempFile({ prefix: "radia-edit-history-" }));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ---- decoding ----

{
  const one = (s: string, flush = false) => decodeKey(s, flush);
  check("a printable character is itself", one("a")?.key.text === "a");
  check("Enter submits", one("\r")?.key.type === "enter");
  check("Backspace is the DEL byte terminals actually send", one("\x7f")?.key.type === "backspace");
  check("an arrow key is one key, not three bytes", one("\x1b[D")?.key.type === "left" && one("\x1b[D")?.consumed === 3);
  check("Ctrl-arrow moves by word", one("\x1b[1;5C")?.key.type === "wordRight");
  check("Home and End have two encodings each", one("\x1b[H")?.key.type === "home" && one("\x1b[4~")?.key.type === "end");
  check("Ctrl-C is a key now, not a signal", one("\x03")?.key.type === "interrupt");
  check("Ctrl-W kills a word", one("\x17")?.key.type === "killWord");
  // The key that fetches the clipboard itself, for the bytes a terminal cannot send. It does not
  // collide with the emulator's Ctrl+Shift+V, which never reaches us: that one is consumed by the
  // terminal, which sends the clipboard's TEXT as a bracketed paste instead.
  check("Ctrl-V asks for the clipboard", one("\x16")?.key.type === "clipboard");

  // The property the whole decoder exists for: a partial sequence must not be guessed at. Deciding
  // early turns an arrow key into a cancel, which discards a turn nobody asked to discard.
  check("a partial sequence waits for the rest", one("\x1b") === null && one("\x1b[") === null && one("\x1b[1;") === null);
  check("…and is decided when nothing more is coming", one("\x1b", true)?.key.type === "escape");
  check("a bare Escape with something after it is an Escape", one("\x1bx")?.key.type === "escape");

  // A key arriving one byte at a time is the normal case over a slow link, and the reason `consumed`
  // is returned rather than the decoder mutating a buffer it does not own.
  let buf = "";
  let got = "";
  for (const b of "\x1b[Cx") {
    buf += b;
    for (;;) {
      const d = decodeKey(buf);
      if (!d) break;
      buf = buf.slice(d.consumed);
      got += d.key.type === "char" ? d.key.text : `<${d.key.type}>`;
    }
  }
  check("a key split byte by byte still decodes once", got === "<right>x", got);

  check("a surrogate pair is one character", one("🙂")?.consumed === 2 && one("🙂")?.key.text === "🙂");

  // A sequence the table does not name has to be CONSUMED, not fallen through. Falling through
  // emitted an Escape (clearing the line) and then typed the remainder into it, so PageUp inserted
  // `[5~` and F1 inserted `OP`. Every terminal sends keys nobody enumerated.
  const whole = (s: string) => {
    let buf = s;
    let out = "";
    for (;;) {
      const d = decodeKey(buf, true);
      if (!d) break;
      buf = buf.slice(d.consumed);
      out += d.key.type === "char" ? d.key.text : `<${d.key.type}>`;
      if (!buf) break;
    }
    return out;
  };
  check("PageUp is dropped whole, not typed into the line", whole("\x1b[5~") === "<ignore>", whole("\x1b[5~"));
  check("a function key too", whole("\x1bOP") === "<ignore>", whole("\x1bOP"));
  check("…including a multi-parameter one", whole("\x1b[15;2~") === "<ignore>", whole("\x1b[15;2~"));
  check("an unknown sequence still waits for its final byte", decodeKey("\x1b[5") === null && decodeKey("\x1bO") === null);
  check("…and the keys around it are untouched", whole("\x1b[5~a") === "<ignore>a", whole("\x1b[5~a"));
}

// ---- editing ----

{
  const b = new LineBuffer();
  b.insert("hello world");
  check("typing appends", b.text === "hello world" && b.cursor === 11);
  b.cursor = 5;
  b.insert(",");
  check("insertion happens at the cursor", b.text === "hello, world", b.text);
  b.backspace();
  check("backspace takes the character before it", b.text === "hello world", b.text);
  b.delete();
  check("delete takes the one under it", b.text === "helloworld", b.text);
}

{
  // Word motion over punctuation is where "back to the last space" gets it wrong.
  const b = new LineBuffer();
  b.set("space.query(kind)");
  check("word-left skips the separators then the word", b.wordStart() === 12, String(b.wordStart()));
  b.cursor = 0;
  check("word-right lands after the first word", b.wordEnd() === 5, String(b.wordEnd()));
  b.cursor = b.length;
  b.killWord();
  check("Ctrl-W removes one word, not the line", b.text === "space.query(", b.text);
}

{
  const b = new LineBuffer();
  b.set("keep this cut that");
  b.cursor = 10;
  b.killToEnd();
  check("Ctrl-K cuts to the end", b.text === "keep this ", b.text);
  b.set("cut this keep that", 9);
  b.killToStart();
  check("Ctrl-U cuts to the start", b.text === "keep that" && b.cursor === 0, b.text);
}

{
  // A cursor measured in UTF-16 units splits an emoji in half and leaves an unpaired surrogate in
  // the message, which the storage layer's JSON type will not take.
  const b = new LineBuffer();
  b.set("a🙂b");
  check("an emoji counts as one character", b.length === 3, String(b.length));
  b.cursor = 2;
  b.backspace();
  check("…and deletes as one", b.text === "ab", JSON.stringify(b.text));
}

// ---- history ----

{
  const h = new History(3);
  h.add("one");
  h.add("two");
  check("Up walks back", h.up("draft") === "two" && h.up("") === "one");
  check("…and stops at the top", h.up("") === undefined);
  check("Down walks forward", h.down() === "two");
  check("…and returns the line being typed", h.down() === "draft");

  h.add("two");
  check("a repeat of the previous line is not recorded twice", h.all().join(",") === "one,two", h.all().join(","));
  h.add("three");
  h.add("four");
  check("the ring is bounded", h.all().join(",") === "two,three,four", h.all().join(","));
  h.add("");
  check("a blank line is not history", h.all().length === 3);
}

// ---- rendering ----

{
  const wide = renderLine("you> ", "short", 5, 80);
  check("a short line is drawn whole", wide.line === "you> short", wide.line);
  check("…with the cursor after it", wide.cursorColumn === 10, String(wide.cursorColumn));

  // A single physical row, always. Wrapping means tracking how many rows the last draw used and
  // moving back up over them, and getting that wrong leaves fragments the erase cannot reach: the
  // exact failure the status line already had.
  const text = "x".repeat(200);
  const narrow = renderLine("you> ", text, 200, 40);
  check("a long line is scrolled, not wrapped", narrow.line.length <= 40, `${narrow.line.length} of 40`);
  check("…with the cursor still on screen", narrow.cursorColumn < 40, String(narrow.cursorColumn));
  const atStart = renderLine("you> ", text, 0, 40);
  check("…and the window follows the cursor", atStart.line.endsWith("x") && atStart.cursorColumn === 5, String(atStart.cursorColumn));

  // A pasted newline is real text and must survive to the message; it just cannot be DRAWN on a row.
  const pasted = renderLine("you> ", "one\ntwo", 7, 80);
  check("an embedded newline is drawn as a marker", pasted.line === "you> one⏎two", pasted.line);
}

// ---- through the real reader ----

const enc = new TextEncoder();
function keyboard() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  __useTestInput(readable);
  const w = writable.getWriter();
  return { type: (s: string) => w.write(enc.encode(s)), close: () => w.close() };
}
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<"TIMED OUT">((r) => setTimeout(() => r("TIMED OUT"), ms))]);

const cap = __captureOutput();

{
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine("you> ");
  await kb.type("helo");
  await kb.type("\x1b[D"); // left
  await kb.type("l");
  await kb.type("\n");
  check("editing mid-line works end to end", (await within(2000, pending)) === "hello", String(await within(50, pending)));
}

{
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine("you> ");
  await kb.type("throw this away");
  await kb.type("\x03"); // Ctrl-C
  await kb.type("keep this\n");
  check("Ctrl-C clears the line instead of killing the process", (await within(2000, pending)) === "keep this", String(await within(50, pending)));
}

{
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine("you> ");
  await kb.type("\x03"); // Ctrl-C on an empty line
  check("…and quits when there is nothing left to clear", (await within(2000, pending)) === null);
}

{
  // Ctrl-V inserts whatever the hook returns, at the cursor, and the hook is where the effects are.
  // The editor must not know what an artifact is; here the hook stands in for "read the clipboard,
  // store the bytes, hand back a marker", which is exactly its contract in the chat.
  const kb = keyboard();
  const nextLine = lineReader({ onClipboard: () => Promise.resolve("[attached shot.png · image/png · 12 KB · artifactId 01K]") });
  const pending = nextLine("you> ");
  await kb.type("look at ");
  await kb.type("\x16");
  await kb.type(" please\n");
  check(
    "Ctrl-V inserts what the hook returns",
    (await within(2000, pending)) === "look at [attached shot.png · image/png · 12 KB · artifactId 01K] please",
    String(await within(50, pending)),
  );
}

{
  // A hook that throws must cost the keystroke and nothing else. A clipboard read leaves the
  // process (a subprocess that can hang, a space that can refuse the write), so this is the
  // ordinary case rather than the exotic one, and losing the line being typed would be the worst
  // possible answer to a failed paste.
  const kb = keyboard();
  const nextLine = lineReader({ onClipboard: () => Promise.reject(new Error("no clipboard reader")) });
  const pending = nextLine("you> ");
  await kb.type("still here");
  await kb.type("\x16");
  await kb.type("\n");
  check("a failing clipboard keeps the line", (await within(2000, pending)) === "still here", String(await within(50, pending)));
}

{
  // With no hook at all (a chat built without one, or a host with no reader) the key is inert
  // rather than a stray character in the line.
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine("you> ");
  await kb.type("plain\x16text\n");
  check("Ctrl-V with no hook inserts nothing", (await within(2000, pending)) === "plaintext", String(await within(50, pending)));
}

{
  // A pasted block keeps its newlines instead of submitting once per line, which is what a reader
  // without bracketed paste does and the single most annoying thing about pasting into one.
  const kb = keyboard();
  const nextLine = lineReader();
  const pending = nextLine("you> ");
  await kb.type("\x1b[200~first\nsecond\x1b[201~");
  await kb.type("\n");
  check("a pasted multi-line block is ONE input", (await within(2000, pending)) === "first\nsecond", JSON.stringify(await within(50, pending)));
}

{
  const kb = keyboard();
  const nextLine = lineReader();
  // The reader is started BEFORE anything is typed, here and above: nothing pumps stdin until a
  // consumer asks for input, so a test that types first waits forever on a full queue.
  const first = nextLine("you> ");
  await kb.type("remembered\n");
  check("a line is submitted", (await within(2000, first)) === "remembered");
  const pending = nextLine("you> ");
  await kb.type("\x1b[A\n"); // Up, then Enter
  check("…and Up brings it back on the next prompt", (await within(2000, pending)) === "remembered", String(await within(50, pending)));
}

cap.stop();

// ---- what it leaves on disk ----
{
  // The history file is every question the person has asked. It should not be readable by other
  // users on the machine, and the umask is not something to leave that decision to.
  const path = Deno.env.get("RADIA_CHAT_HISTORY")!;
  saveHistory(path, ["a secret question"]);
  check("history round-trips", loadHistory(path).join(",") === "a secret question", loadHistory(path).join(","));
  saveHistory(path, ["one\ntwo", "three"]);
  check("…including a pasted multi-line entry", loadHistory(path).length === 2 && loadHistory(path)[0] === "one\ntwo", JSON.stringify(loadHistory(path)));
  if (Deno.build.os !== "windows") {
    const mode = Deno.statSync(path).mode! & 0o777;
    check("…and is not readable by anyone else", mode === 0o600, mode.toString(8));
  }
}

console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
