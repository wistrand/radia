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

// ONE reader for the whole process, shared by the line reader and the cancel watcher.
//
// `Deno.stdin.readable.getReader()` is exclusive, so two of them cannot coexist — and the watcher
// has to read the same stream, because that is where Escape arrives. They never overlap in practice:
// the REPL is strictly sequential (read a line, run a turn, read a line), so exactly one of them is
// reading at any moment. What they do share is `pushback`, below.
let sharedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
function stdinReader(): ReadableStreamDefaultReader<Uint8Array> {
  return sharedReader ??= Deno.stdin.readable.getReader();
}
/** Bytes read by one consumer that belong to the other. A `read()` already in flight cannot be
 *  cancelled, so when the watcher stops it hands back whatever arrived — which is also what makes
 *  type-ahead during a turn survive into the next prompt instead of vanishing. */
let pushback = "";

/** Read stdin a line at a time. Works for an interactive TTY and for piped input, unlike prompt(). */
export function lineReader(): () => Promise<string | null> {
  const decoder = new TextDecoder();
  let buf = "";
  return async function nextLine(): Promise<string | null> {
    while (true) {
      if (pushback) {
        buf += pushback;
        pushback = "";
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        return line;
      }
      const { value, done } = await stdinReader().read();
      if (done) {
        const rest = buf;
        buf = "";
        return rest || null;
      }
      buf += decoder.decode(value, { stream: true });
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
  if (!Deno.stdin.isTerminal()) return () => {};
  Deno.stdin.setRaw(true);
  let stopped = false;
  (async () => {
    const decoder = new TextDecoder();
    while (!stopped) {
      const { value, done } = await stdinReader().read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      if (stopped) {
        // The read was already in flight when the turn ended: these bytes are the next prompt's.
        pushback += text;
        return;
      }
      // ESC alone. An arrow key or any other escape SEQUENCE also starts with 0x1b, so requiring
      // the byte to arrive on its own is what separates "the user pressed Escape" from "the user
      // pressed Up". Not perfect — a fast terminal can coalesce — but wrong in the safe direction:
      // a missed cancel is a wait, a false one would discard work nobody asked to discard.
      if (text === "\x1b") {
        onCancel();
        return;
      }
    }
  })().catch(() => {});
  return () => {
    stopped = true;
    try {
      Deno.stdin.setRaw(false);
    } catch { /* not a terminal any more, or already restored */ }
  };
}
