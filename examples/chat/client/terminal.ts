// Everything the chat draws, and nothing else.
//
// Two rules hold the rendering together. First, a status line is only ever drawn on a TTY: piped
// output must stay byte-identical to a run with no status at all, or the example stops being
// scriptable. Second, the line being redrawn is `<prefix><dim status>` — the prefix is reprinted
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
 * A tool result that references an artifact is a payload the terminal cannot draw, so print a link
 * — and, with RADIA_CHAT_IMAGE_DIR set, save the bytes too.
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

/** Read stdin a line at a time. Works for an interactive TTY and for piped input, unlike prompt(). */
export function lineReader(): () => Promise<string | null> {
  const stdin = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return async function nextLine(): Promise<string | null> {
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        return line;
      }
      const { value, done } = await stdin.read();
      if (done) {
        const rest = buf;
        buf = "";
        return rest || null;
      }
      buf += decoder.decode(value, { stream: true });
    }
  };
}
