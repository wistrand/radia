// Everything the chat draws, and nothing else.
//
// Two rules hold the rendering together. First, a status line is only ever drawn on a TTY: piped
// output must stay byte-identical to a run with no status at all, or the example stops being
// scriptable. Second, the line being redrawn is `<prefix><dim status>`, and the prefix is reprinted
// on every redraw so the cursor never ends up somewhere the next write does not expect.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { IMAGE_DIR, url } from "./config.ts";

const enc = new TextEncoder();
export const write = (s: string) => Deno.stdout.writeSync(enc.encode(s));
export const tty = Deno.stdout.isTerminal();

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Redraw the current line as prefix + dim status. */
export const showStatus = (prefix: string, s: string) => tty && write(`\r\x1b[2K${prefix}\x1b[2m${trunc(s, 100)}\x1b[0m`);

/** Wipe the status, keeping the prefix, so real output can continue on the same line. */
export const endStatus = (prefix: string) => tty && write(`\r\x1b[2K${prefix}`);

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

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
