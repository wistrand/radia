// Editing a line of input, with no terminal in it.
//
// Everything here is a pure function of keystrokes and state, so the awkward parts (a `_` in the
// middle of a word motion, a cursor at the end of a scrolled window, an escape sequence split
// across two arrivals) can be driven from a test rather than from a keyboard. `terminal.ts` owns
// stdin, raw mode and the actual writing; this file owns what a key MEANS and what the line looks
// like afterwards.
//
// Why any of this exists: in cooked mode the terminal driver gives you backspace, `^W` and `^U`, and
// nothing else. Arrow keys are not handled by anybody, so pressing left inserts the literal bytes
// `^[[D` into what you are typing, and there is no history at all. The only way to fix that is to
// own raw mode and do the editing yourself.

import { join } from "@std/path";

/** What a keystroke means. `char` carries the text; everything else is an action. */
export type KeyType =
  | "char"
  | "enter"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "wordLeft"
  | "wordRight"
  | "home"
  | "end"
  | "up"
  | "down"
  | "killToEnd"
  | "killToStart"
  | "killWord"
  | "clear"
  | "interrupt"
  | "eof"
  | "escape"
  | "pasteStart"
  | "pasteEnd"
  /** Ctrl-V: fetch the clipboard OURSELVES, for the things a terminal cannot send. */
  | "clipboard"
  | "ignore";

export interface Key {
  type: KeyType;
  text?: string;
}

/** Sequences that are a complete key on their own. Longest match wins, so `\x1b[1;5D` is tried
 *  before `\x1b[1`. */
const SEQUENCES: [string, KeyType][] = [
  ["\x1b[200~", "pasteStart"],
  ["\x1b[201~", "pasteEnd"],
  ["\x1b[1;5D", "wordLeft"],
  ["\x1b[1;5C", "wordRight"],
  ["\x1b[1;3D", "wordLeft"],
  ["\x1b[1;3C", "wordRight"],
  ["\x1b[3~", "delete"],
  ["\x1b[1~", "home"],
  ["\x1b[7~", "home"],
  ["\x1b[4~", "end"],
  ["\x1b[8~", "end"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
  ["\x1bOH", "home"],
  ["\x1bOF", "end"],
  ["\x1bb", "wordLeft"],
  ["\x1bf", "wordRight"],
];

const CONTROL: Record<string, KeyType> = {
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\x08": "backspace",
  "\x01": "home",
  "\x02": "left",
  "\x03": "interrupt",
  "\x04": "eof",
  "\x05": "end",
  "\x06": "right",
  "\x0b": "killToEnd",
  "\x0c": "clear",
  "\x0e": "down",
  "\x10": "up",
  "\x15": "killToStart",
  // Ctrl-V, and it does not collide with the terminal's own paste even though Shift is not encoded:
  // Ctrl+Shift+V is consumed by the EMULATOR, which sends the clipboard's text as a bracketed paste
  // and never sends this byte. So the two coexist, and this key is the one to press when the other
  // did nothing, which is exactly what happens with a picture on the clipboard.
  "\x16": "clipboard",
  "\x17": "killWord",
};

/**
 * Read one key off the front of `buf`.
 *
 * `null` means "not enough input to decide", which is the whole reason this returns a count rather
 * than mutating: an escape sequence arrives in as many pieces as the terminal feels like sending,
 * and a decoder that guesses on a partial one turns an arrow key into a cancel. `flush` forces a
 * decision, for the case where nothing more is coming.
 */
export function decodeKey(buf: string, flush = false): { key: Key; consumed: number } | null {
  if (buf.length === 0) return null;
  const c = buf[0];

  if (c === "\x1b") {
    for (const [seq, type] of SEQUENCES) {
      if (buf.startsWith(seq)) return { key: { type }, consumed: seq.length };
      // A prefix of a longer sequence: wait, unless the caller says nothing more is coming.
      if (!flush && seq.startsWith(buf)) return null;
    }
    // An escape sequence this table does not name: a function key, PageUp, a terminal answering a
    // query nobody asked. CONSUMED and dropped rather than fallen through, because falling through
    // emitted an Escape and then typed the remainder into the line, so PageUp inserted `[5~`.
    // CSI is `\x1b[`, parameters, then a final byte in @-~; SS3 is `\x1bO` and one byte.
    if (buf[1] === "[") {
      for (let i = 2; i < buf.length; i++) {
        if (buf[i] >= "@" && buf[i] <= "~") return { key: { type: "ignore" }, consumed: i + 1 };
      }
      return flush ? { key: { type: "ignore" }, consumed: buf.length } : null;
    }
    if (buf[1] === "O") {
      if (buf.length >= 3) return { key: { type: "ignore" }, consumed: 3 };
      return flush ? { key: { type: "ignore" }, consumed: buf.length } : null;
    }

    // A bare Escape. Only decidable once we know no sequence follows it, which is what `flush` says.
    if (!flush && buf.length === 1) return null;
    return { key: { type: "escape" }, consumed: 1 };
  }

  const control = CONTROL[c];
  if (control) return { key: { type: control }, consumed: 1 };
  // Other C0 controls are dropped rather than inserted: a stray one is invisible in the line and
  // then confusing in the message that gets sent.
  if (c < " ") return { key: { type: "ignore" }, consumed: 1 };

  // A whole grapheme, so a surrogate pair or a combining mark moves as one character.
  const graphemes = [...buf];
  return { key: { type: "char", text: graphemes[0] }, consumed: graphemes[0].length };
}

const WORD = /[A-Za-z0-9_]/;

/** The line being typed: text, cursor, and the edits a key performs on it. */
export class LineBuffer {
  text = "";
  /** Measured in CHARACTERS, not UTF-16 units, so an emoji is one step. */
  cursor = 0;

  private chars(): string[] {
    return [...this.text];
  }

  set(text: string, cursor = [...text].length): void {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, [...text].length));
  }

  insert(s: string): void {
    const c = this.chars();
    this.set(c.slice(0, this.cursor).join("") + s + c.slice(this.cursor).join(""), this.cursor + [...s].length);
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const c = this.chars();
    this.set(c.slice(0, this.cursor - 1).join("") + c.slice(this.cursor).join(""), this.cursor - 1);
  }

  delete(): void {
    const c = this.chars();
    if (this.cursor >= c.length) return;
    this.set(c.slice(0, this.cursor).join("") + c.slice(this.cursor + 1).join(""), this.cursor);
  }

  /** Skip the run of separators, then the run of word characters, which is what every editor means
   *  by a word motion and what a naive "back to the last space" gets wrong on `foo.bar(baz)`. */
  wordStart(): number {
    const c = this.chars();
    let i = this.cursor;
    while (i > 0 && !WORD.test(c[i - 1])) i--;
    while (i > 0 && WORD.test(c[i - 1])) i--;
    return i;
  }

  wordEnd(): number {
    const c = this.chars();
    let i = this.cursor;
    while (i < c.length && !WORD.test(c[i])) i++;
    while (i < c.length && WORD.test(c[i])) i++;
    return i;
  }

  killWord(): void {
    const start = this.wordStart();
    const c = this.chars();
    this.set(c.slice(0, start).join("") + c.slice(this.cursor).join(""), start);
  }

  killToEnd(): void {
    this.set(this.chars().slice(0, this.cursor).join(""), this.cursor);
  }

  killToStart(): void {
    this.set(this.chars().slice(this.cursor).join(""), 0);
  }

  get length(): number {
    return this.chars().length;
  }
}

/**
 * What has been typed before, most recent last.
 *
 * Persisted per USER rather than per space, beside the credential file, because history follows the
 * person across every space they talk to. Bounded on write: an unbounded history file is the same
 * unbounded-registry mistake in a different medium.
 */
export class History {
  private entries: string[] = [];
  /** Where the user is while browsing; `entries.length` means "back at the line being typed". */
  private at = 0;
  /** The partially typed line, parked while browsing so Down returns to it. */
  private draft = "";

  constructor(private readonly limit = 500) {}

  load(lines: string[]): void {
    this.entries = lines.filter((l) => l.trim()).slice(-this.limit);
    this.at = this.entries.length;
  }

  all(): string[] {
    return [...this.entries];
  }

  /** Record a submitted line. A repeat of the previous one is not recorded, which is what makes
   *  Up useful after running the same thing twice. */
  add(line: string): void {
    if (!line.trim()) return;
    if (this.entries[this.entries.length - 1] === line) {
      this.at = this.entries.length;
      return;
    }
    this.entries.push(line);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    this.at = this.entries.length;
  }

  /** Older, or undefined at the top. `current` is parked on the first step so Down can return it. */
  up(current: string): string | undefined {
    if (this.at === this.entries.length) this.draft = current;
    if (this.at === 0) return undefined;
    this.at--;
    return this.entries[this.at];
  }

  /** Newer, or the parked draft at the bottom. */
  down(): string | undefined {
    if (this.at >= this.entries.length) return undefined;
    this.at++;
    return this.at === this.entries.length ? this.draft : this.entries[this.at];
  }

  /** Leave browsing, so the next Up starts from the newest entry again. */
  reset(): void {
    this.at = this.entries.length;
  }
}

/**
 * The prompt line as a single physical row, scrolled horizontally when the text does not fit.
 *
 * A single row on purpose. Wrapping onto several rows means tracking how many the previous draw
 * used and moving the cursor back up over them, and getting that wrong leaves fragments the erase
 * cannot reach: the same failure the status line already had. Scrolling keeps every redraw a
 * `\r`, an erase and one row of text.
 *
 * Embedded newlines (which only arrive by paste) render as a marker so the row stays a row. The
 * text keeps the real newline, so what gets sent is what was pasted.
 */
export function renderLine(
  prompt: string,
  text: string,
  cursor: number,
  width: number,
  marker = "⏎",
): { line: string; cursorColumn: number } {
  const chars = [...text].map((c) => (c === "\n" ? marker : c));
  const room = Math.max(8, width - prompt.length - 1);
  // Keep the cursor inside the window, with a little context after it where there is any.
  let start = 0;
  if (chars.length > room) {
    start = Math.min(Math.max(0, cursor - room + 4), chars.length - room);
  }
  const visible = chars.slice(start, start + room);
  return { line: prompt + visible.join(""), cursorColumn: prompt.length + (cursor - start) };
}

/** Per-user history file, beside the credential file and by the same convention. */
export function historyPath(): string {
  const env = (k: string) => {
    try {
      return Deno.env.get(k);
    } catch {
      return undefined;
    }
  };
  const explicit = env("RADIA_CHAT_HISTORY");
  if (explicit) return explicit;
  const xdg = env("XDG_STATE_HOME");
  if (xdg) return join(xdg, "radia", "chat-history");
  const appData = env("APPDATA");
  if (appData) return join(appData, "radia", "chat-history");
  const home = env("HOME") ?? env("USERPROFILE");
  if (home) return join(home, ".radia", "chat-history");
  return join(".", ".radia-chat-history");
}

/** Read the history file. A missing or unreadable one is an empty history, never an error: losing
 *  a session over a file nobody asked for would be the wrong trade. */
export function loadHistory(path: string): string[] {
  try {
    return Deno.readTextFileSync(path).split("\n").filter((l) => l.length > 0).map(decodeEntry);
  } catch {
    return [];
  }
}

/** `mode` because this file is every question the person has asked, which is not something to leave
 *  at whatever the umask says. Ignored on Windows, where the parent directory is the boundary. */
export function saveHistory(path: string, lines: string[]): void {
  try {
    Deno.mkdirSync(path.replace(/[/\\][^/\\]*$/, ""), { recursive: true });
    Deno.writeTextFileSync(path, lines.map(encodeEntry).join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
  } catch { /* read-only home, or no permission: history is a convenience */ }
}

// One entry per line, so a pasted multi-line input has to survive the round trip. Escaped rather
// than stored as JSON, because a history file is something a person reads and greps.
const encodeEntry = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const decodeEntry = (s: string) => s.replace(/\\\\|\\n/g, (m) => (m === "\\n" ? "\n" : "\\"));
