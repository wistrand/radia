// What the chat's protocol half asks its output surface for, and nothing else.
//
// The chat's logic was never Deno-bound, but it WAS ansi-bound: `turn.ts` called eleven terminal
// functions at 44 sites and `waiting.ts` and `grants.ts` three more, so a second front end meant a
// second copy of the protocol. This file is the seam that ends that (agent_docs/plan-chat-web-ui.md
// phase 1): `terminal.ts` is now one implementation of it, and a browser is another.
//
// THE CALL SITES DID NOT CHANGE. The exports below are the same names with the same signatures,
// delegating to whichever implementation is installed, so the protocol half swapped one import line
// and kept its shape. What it bought is that `turn.ts`, `waiting.ts` and `grants.ts` no longer
// import `terminal.ts` at all, which is checkable: a bundle of them contains no `Deno.`.
//
// TWO THINGS ARE DELIBERATELY NOT HERE. Input (a line editor, raw mode, clipboard staging) stays in
// `terminal.ts`, because a textarea gives all of it free and nothing about it is shared. And
// nothing here knows about records: an implementation renders what it is handed.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { AnswerStream } from "./markdown.ts";

export type { AnswerStream };

/**
 * One output surface for a chat session.
 *
 * `dim` and `trunc` are FORMATTING HINTS rather than escape codes, and the contract is worth
 * stating because it is what keeps styling possible in a browser: `dim(s)` returns a string that
 * only THIS implementation's `write` knows how to render. The terminal returns ANSI and passes it
 * through; a DOM implementation may return a marked string its own `write` turns into markup.
 * Never inspect, measure or store the result of `dim` outside the implementation that produced it.
 */
export interface ChatUI {
  /** Raw output, no newline implied. Partial lines are normal: an answer streams through here. */
  write(s: string): void;
  /** A newline if and only if the cursor is not already at the start of one. */
  ensureLine(): void;
  /** Usable width in characters, for wrapping and truncation decisions. */
  columns(): number;
  /** Truncate to `n` visible characters, ignoring whatever styling `dim` added. */
  trunc(s: string, n: number): string;
  /** Style as secondary text. See the note above: the result is this implementation's own. */
  dim(s: string): string;
  /** Out-of-band output that must not land inside a streaming answer. */
  notice(s: string): void;
  /** Hold out-of-band output while a turn owns the surface; false flushes what queued. */
  holdLine(on: boolean): void;
  /** Where the assistant's answer goes. Markdown on a terminal, the model's bytes on a pipe. */
  answerStream(): AnswerStream;
  /** A transient one-line status, replaced in place. */
  showStatus(prefix: string, s: string): void;
  /** Clear the status line, leaving `prefix` where it was. */
  endStatus(prefix: string): void;
  /** Whether a status line is worth computing at all (a pipe has none). */
  statusLineOn(): boolean;
  /** Present a tool's artifact reference: a link, an inline image, a saved file. The client comes
   *  along because presenting it may mean fetching bytes or minting a download capability. */
  showArtifact(client: RadiaClient, output: unknown): Promise<void>;
}

/**
 * The fallback: line-buffered `console`, no styling, no status line.
 *
 * It exists so a missing install is a degraded surface rather than a crash, and it uses `console`
 * rather than the platform, so this file stays as portable as the protocol it serves. Buffering to
 * the newline matters: `write` is called with partial lines while an answer streams, and
 * `console.log` per call would shred it.
 */
function consoleUI(): ChatUI {
  let buf = "";
  const flush = (final = false) => {
    const nl = buf.lastIndexOf("\n");
    if (nl >= 0) {
      console.log(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (final && buf) {
      console.log(buf);
      buf = "";
    }
  };
  return {
    write: (s) => {
      buf += s;
      flush();
    },
    ensureLine: () => {
      if (buf) flush(true);
    },
    columns: () => 80,
    trunc: (s, n) => s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…",
    dim: (s) => s,
    notice: (s) => console.log(s),
    holdLine: () => {},
    answerStream: () => ({
      push: (t: string) => {
        buf += t;
        flush();
      },
      end: () => flush(true),
    }),
    showStatus: () => {},
    endStatus: () => {},
    statusLineOn: () => false,
    showArtifact: (_client, output) => {
      const ref = output as { artifactId?: string } | null;
      if (ref?.artifactId) console.log(`    artifact ${ref.artifactId}`);
      return Promise.resolve();
    },
  };
}

let active: ChatUI = consoleUI();

/** Install the surface for this process. Called once at boot, before a turn runs. */
export function installUI(ui: ChatUI): void {
  active = ui;
}

/** The installed surface, for a caller that needs to hand it on rather than call it. */
export function currentUI(): ChatUI {
  return active;
}

// The protocol half's vocabulary, unchanged from what `terminal.ts` exported. Delegators rather
// than re-exports, because the target is chosen at runtime and a re-export binds at import.
export const write = (s: string): void => active.write(s);
export const ensureLine = (): void => active.ensureLine();
export const columns = (): number => active.columns();
export const trunc = (s: string, n: number): string => active.trunc(s, n);
export const dim = (s: string): string => active.dim(s);
export const notice = (s: string): void => active.notice(s);
export const holdLine = (on: boolean): void => active.holdLine(on);
export const answerStream = (): AnswerStream => active.answerStream();
export const showStatus = (prefix: string, s: string): void => active.showStatus(prefix, s);
export const endStatus = (prefix: string): void => active.endStatus(prefix);
export const statusLineOn = (): boolean => active.statusLineOn();
export const showArtifact = (client: RadiaClient, output: unknown): Promise<void> => active.showArtifact(client, output);
