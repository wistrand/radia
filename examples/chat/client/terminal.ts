// Everything the chat draws, and nothing else.
//
// Three rules hold the rendering together.
//
// ESCAPES ARE FOR TERMINALS. A status line is only drawn on a TTY, and so is colour: piped output
// must stay byte-identical to a run with no status at all, or the example stops being scriptable.
// That rule was stated here from the start and `dim` did not follow it, so every redirected
// transcript carried `\x1b[2m` around a third of its lines.
//
// THE LINE BEING REDRAWN is `<prefix><dim status>`, and the prefix is reprinted on every redraw so
// the cursor never ends up somewhere the next write does not expect. It is also truncated to the
// TERMINAL's width rather than a constant: a status wider than the window wraps onto a second
// physical row, and `\r\x1b[2K` erases only the row the cursor is on, leaving the first row's
// fragment on screen for the rest of the session.
//
// ONE WRITER OWNS THE CURSOR. Anything produced by a background watcher (a capability wakeup, a
// worker's stderr) goes through `notice`, which holds it until the line is idle. Written directly,
// those arrived in the middle of a streaming answer and spliced a bracketed line into the model's
// sentence.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { IMAGE_DIR, url } from "./config.ts";
import { type AnswerStream, MarkdownStream, passthrough } from "./markdown.ts";

const enc = new TextEncoder();
export const tty = Deno.stdout.isTerminal();
/** NO_COLOR is the de-facto opt-out (no-color.org); read defensively so a missing --allow-env
 *  degrades to colour rather than throwing. */
const colour = tty && !(() => {
  try {
    return Deno.env.get("NO_COLOR");
  } catch {
    return "";
  }
})();

/** True when the cursor sits at column 0, so a full line may be printed without cutting into one. */
let atLineStart = true;

/** TEST SEAM, the output twin of `__useTestInput`. Ordering is the whole property here (was a line
 *  held back, and did it come out at the right moment), and ordering is invisible from outside a
 *  process whose writes go straight to the terminal. Set by `smoke-render.ts` and nothing else. */
let sink: ((s: string) => void) | null = null;
export function __captureOutput(): { text: () => string; stop: () => void } {
  let out = "";
  sink = (s) => {
    out += s;
  };
  atLineStart = true;
  holding = false;
  pending.length = 0;
  return { text: () => out, stop: () => (sink = null) };
}

export function write(s: string): void {
  if (!s) return;
  if (sink) sink(s);
  else Deno.stdout.writeSync(enc.encode(s));
  atLineStart = s.endsWith("\n");
}

/** How wide the window is. 80 when that cannot be known (piped, or no terminal). */
export function columns(): number {
  if (!tty) return 80;
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80;
  }
}

/** At most `n` characters, ellipsis INCLUDED. It used to append after slicing, so every truncated
 *  string was one character over its budget: harmless in a message, and exactly enough to wrap the
 *  status line onto a second row that the redraw could not erase. */
export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

/**
 * The status line's text, cut so that prefix + status fits one physical row.
 *
 * Separate and exported because this is the whole of the bug: the cut used to be a constant 100, so
 * on any narrower window the line wrapped onto a second row and `\r\x1b[2K` erased only the row the
 * cursor was on. The fragment left on the first row stayed there for the rest of the session.
 */
export function statusText(prefix: string, s: string): string {
  return trunc(s, Math.max(16, columns() - prefix.length - 1));
}

/** Redraw the current line as prefix + dim status, cut to fit the window. */
export const showStatus = (prefix: string, s: string) =>
  tty && write(`\r\x1b[2K${prefix}\x1b[2m${statusText(prefix, s)}\x1b[0m`);

/** Wipe the status, keeping the prefix, so real output can continue on the same line. */
export const endStatus = (prefix: string) => tty && write(`\r\x1b[2K${prefix}`);

export const dim = (s: string) => colour ? `\x1b[2m${s}\x1b[0m` : s;

/**
 * Where the assistant's answer goes: a markdown renderer on a terminal, the model's own bytes
 * anywhere else.
 *
 * The passthrough is not a fallback, it is the same rule the status line follows. A redirected
 * transcript is markdown, which is a format, and rewriting it into box characters and escape codes
 * would make the example unscriptable to make it prettier in a window nobody is looking at.
 */
export function answerStream(): AnswerStream {
  return tty ? new MarkdownStream(write, { colour, width: columns() }) : passthrough(write);
}

// ---- out-of-band output ----
//
// A `capability` wakeup, a worker's stderr and a partial-registry warning all arrive on somebody
// else's schedule. The turn owns the line while it runs, so these are queued and printed at the next
// idle point rather than into the middle of whatever is being streamed.

let holding = false;
const pending: string[] = [];

/** Claim the line for the duration of a turn. Releasing flushes anything that arrived meanwhile. */
export function holdLine(on: boolean): void {
  holding = on;
  if (!on) flushNotices();
}

/** Print an out-of-band line, now or at the next idle point. Always ends up on its own line. */
export function notice(s: string): void {
  const line = s.endsWith("\n") ? s : `${s}\n`;
  if (!holding && atLineStart) write(line);
  else pending.push(line);
}

/** Print whatever was held back. Safe at any point where the cursor is at column 0. */
export function flushNotices(): void {
  if (pending.length === 0) return;
  const held = pending.splice(0, pending.length);
  if (!atLineStart) write("\n");
  for (const line of held) write(line);
}

/**
 * A tool result that references an artifact is a payload the terminal cannot draw, so print a link.
 * With RADIA_CHAT_IMAGE_DIR set, save the bytes too.
 *
 * The link is the STABLE artifact URL, deliberately not a capability URL. A capability is
 * short-lived and in-memory: right for the console, which mints one per `<img>` render and uses it
 * immediately, wrong for terminal scrollback, where the URL outlives the token, later reads as
 * broken, and leaves a token in the user's history. On a default local space an unauthenticated
 * GET resolves to the operator, so the plain URL opens in a browser as-is.
 */
export async function showArtifact(client: RadiaClient, output: unknown): Promise<void> {
  const ref = output as { artifactId?: string; mediaType?: string; size?: number } | null;
  if (!ref || typeof ref !== "object" || typeof ref.artifactId !== "string") return;
  try {
    write(`    ${dim(`${ref.mediaType ?? "artifact"} · ${Math.round((ref.size ?? 0) / 1024)} KB · ${url}/v0/artifacts/${ref.artifactId}`)}\n`);
    if (IMAGE_DIR) {
      const bytes = await client.getArtifact(ref.artifactId);
      const ext = (ref.mediaType ?? "image/png").split("/")[1] ?? "png";
      const path = `${IMAGE_DIR}/${ref.artifactId}.${ext}`;
      await Deno.writeFile(path, bytes);
      write(`    ${dim(`saved ${path}`)}\n`);
    }
  } catch (e) {
    write(`    ${dim(`(artifact ${ref.artifactId}: ${e})`)}\n`);
  }
}

// ONE consumer of stdin for the whole process, and everything else reads what it buffered.
//
// The line reader and the cancel watcher both need the same stream (Escape arrives where the typing
// does), and `Deno.stdin.readable.getReader()` is exclusive. Sharing the READER was not enough,
// because a `read()` already in flight cannot be cancelled: when a turn ended, the watcher's read
// was still pending, the next `nextLine()` queued a SECOND read behind it, and the user's line
// resolved the watcher's — which stashed it for later while the line reader went on blocking for
// input that had already arrived. The visible bug was an Enter that did nothing and a second one
// that produced a blank line before the command finally ran.
//
// So there is exactly one reader, running forever, and consumers wait on the BUFFER. Type-ahead
// during a turn survives by construction rather than by being handed back, and no byte can be
// delivered to the wrong consumer, because bytes are not delivered to anyone: they accumulate.
let sharedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
/**
 * TEST SEAM, and it earns its keep: this file's bug class is INVISIBLE to piped input, because the
 * cancel watcher is a no-op off a terminal, so the interleaving that loses a keystroke can only be
 * reproduced with a stand-in stream. Set by `smoke-input.ts` and by nothing else.
 */
let testInput: ReadableStream<Uint8Array> | null = null;
export function __useTestInput(stream: ReadableStream<Uint8Array>): void {
  testInput = stream;
  sharedReader = null;
  pumping = false;
  buffered = "";
  lastChunk = "";
  inputSeq = 0;
  inputEnded = false;
  waiters.clear();
}
/** Input that has arrived and nobody has consumed. */
let buffered = "";
/** The most recent chunk, verbatim. The cancel watcher needs the CHUNK BOUNDARY, not just the
 *  bytes: ESC alone is a cancel, ESC as the first byte of a longer chunk is an arrow key. */
let lastChunk = "";
/** Bumped per chunk, so a waiter can ask for "something new" rather than "buffer non-empty" —
 *  otherwise the watcher spins on type-ahead it is deliberately not consuming. */
let inputSeq = 0;
let inputEnded = false;
let pumping = false;
const waiters = new Set<() => void>();

function pumpStdin(): void {
  if (pumping) return;
  pumping = true;
  (async () => {
    const decoder = new TextDecoder();
    sharedReader ??= (testInput ?? Deno.stdin.readable).getReader();
    for (;;) {
      const { value, done } = await sharedReader.read();
      if (done) break;
      lastChunk = decoder.decode(value, { stream: true });
      buffered += lastChunk;
      inputSeq++;
      for (const wake of [...waiters]) wake();
      waiters.clear();
    }
  })().catch(() => {}).finally(() => {
    inputEnded = true;
    for (const wake of [...waiters]) wake();
    waiters.clear();
  });
}

/** Resolve once a chunk newer than `after` has arrived, or stdin has ended. */
function inputChanged(after: number): Promise<void> {
  pumpStdin();
  if (inputSeq > after || inputEnded) return Promise.resolve();
  return new Promise<void>((resolve) => waiters.add(resolve));
}

/** Read stdin a line at a time. Works for an interactive TTY and for piped input, unlike prompt(). */
export function lineReader(): () => Promise<string | null> {
  return async function nextLine(): Promise<string | null> {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        // The TERMINAL echoed the newline, not us, so nothing else can know the cursor moved. Say
        // so, or every notice after the first prompt queues forever waiting for a line start.
        atLineStart = true;
        flushNotices();
        return line;
      }
      if (inputEnded) {
        const rest = buffered;
        buffered = "";
        return rest || null;
      }
      await inputChanged(inputSeq);
    }
  };
}

/**
 * Watch for Escape while a turn is in flight. Returns a stop function.
 *
 * RAW MODE ONLY WHILE A TURN RUNS. Cooked mode delivers nothing until Enter, so Escape would arrive
 * after the thing it was meant to interrupt had finished. Raw mode also stops Ctrl-C raising SIGINT,
 * which is why it is entered for the turn and left immediately afterwards: at the prompt, Ctrl-C
 * must still kill the process.
 *
 * A no-op when stdin is not a terminal, so piped input and the smoke suites are unaffected.
 */
export function watchCancel(onCancel: () => void): () => void {
  if (!testInput && !Deno.stdin.isTerminal()) return () => {};
  if (!testInput) Deno.stdin.setRaw(true);
  let stopped = false;
  (async () => {
    let seen = inputSeq;
    while (!stopped) {
      await inputChanged(seen);
      if (inputEnded) return;
      seen = inputSeq;
      // Checked AFTER the wait: the turn may have ended while this was parked, and the bytes that
      // woke it belong to the next prompt. It consumes nothing, so they are already where the line
      // reader will find them.
      if (stopped) return;
      // ESC alone. An arrow key or any other escape SEQUENCE also starts with 0x1b, so requiring
      // the byte to arrive as its own chunk is what separates "the user pressed Escape" from "the
      // user pressed Up". Not perfect — a fast terminal can coalesce — but wrong in the safe
      // direction: a missed cancel is a wait, a false one would discard work nobody asked to.
      if (lastChunk === "\x1b") {
        // Taken out of the buffer: Escape is a command, not text for the next prompt. Everything
        // else the user typed during the turn stays, which is what makes type-ahead survive.
        if (buffered.endsWith("\x1b")) buffered = buffered.slice(0, -1);
        onCancel();
        return;
      }
    }
  })().catch(() => {});
  return () => {
    stopped = true;
    try {
      if (!testInput) Deno.stdin.setRaw(false);
    } catch { /* not a terminal any more, or already restored */ }
  };
}
