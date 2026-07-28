// How the chat waits for a worker, and what it shows while waiting.
//
// Three things are braided together here because they are one concern: "await a record that
// another process will produce, without going blind".
//
//   1. WAKEUPS. A background watch per streaming kind turns "a matching record became available"
//      into a signal, so a turn advances when the runtime says so rather than on a fixed timer.
//      The fallback tick means a dropped or forbidden watch degrades to polling, never to a stall.
//   2. PROGRESS. Workers publish what they are doing as `progress` records; the status line is
//      those records, rendered.
//   3. STALL DIAGNOSIS. No progress record at all means nobody CLAIMED the work, a configuration
//      failure rather than slowness, so the chat names it instead of burning its timeout in silence.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { endStatus, showStatus } from "./terminal.ts";

const WAKE_FALLBACK_MS = 250;
const WAKE_KINDS = ["llm_chunk", "llm_result", "tool_result"];
const STALL_MS = 2500;
const PROGRESS_POLL_MS = 400; // progress changes a few times per call; chunks change constantly

const waiters = new Set<() => void>();

function doWake(): void {
  const pending = [...waiters];
  waiters.clear();
  for (const w of pending) w();
}

/** Sleep until a wakeup arrives or the fallback tick fires, whichever comes first. */
export function waitWake(ms: number = WAKE_FALLBACK_MS): Promise<void> {
  return new Promise((resolve) => {
    const fire = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(fire);
      resolve();
    }, ms);
    waiters.add(fire);
  });
}

/** Background: one watch per streaming kind, each wakeup releasing whatever turn is waiting. */
export function watchWakeups(client: RadiaClient, signal: AbortSignal): void {
  for (const kind of WAKE_KINDS) {
    (async () => {
      try {
        for await (const _ of client.watch({ kind }, signal)) doWake();
      } catch { /* aborted, or no grant to watch this kind: the fallback tick covers it */ }
    })();
  }
}

interface ProgressBody {
  stage: string;
  by: string;
  note?: string;
}

/** One awaited call: what has been reported about it, and how long it has been waiting. */
export class Waiter {
  private readonly seen = new Set<string>();
  private readonly started = Date.now();
  private nextPoll = 0;
  last?: ProgressBody;

  /**
   * @param prefix what the status line redraws after. MUTABLE: a caller that prints a permanent
   *   line of its own (the routing label) sets this to "" so the status stops re-printing a prompt
   *   the user has already scrolled past.
   * @param onProgress called once per NEWLY seen progress record, in emission order. This is how a
   *   caller reacts to a stage the moment a worker reports it, instead of learning it afterwards
   *   from the result. That is the difference between a label that precedes the text it
   *   describes and one that trails it.
   */
  constructor(
    private readonly client: RadiaClient,
    public prefix: string,
    private readonly onProgress?: (p: ProgressBody) => void,
  ) {}

  /** Poll this call's progress records and redraw the status line. */
  async pump(callId: string, stallHint: string): Promise<void> {
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + PROGRESS_POLL_MS;
    try {
      const rows = await this.client.query({ kind: "progress", match: { callId } }, 20);
      for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (this.seen.has(r.id)) continue;
        this.seen.add(r.id);
        this.last = r.body as ProgressBody; // ULID order = emission order, so the last one wins
        this.onProgress?.(this.last);
      }
    } catch { /* no grant to read progress: fall through to the elapsed-only status */ }
    const secs = Math.round((Date.now() - this.started) / 1000);
    if (this.last) showStatus(this.prefix, `${this.last.stage}${this.last.note ? ` ${this.last.note}` : ""} (${this.last.by}) · ${secs}s`);
    else if (Date.now() - this.started > STALL_MS) showStatus(this.prefix, `${stallHint} · ${secs}s`);
    else showStatus(this.prefix, `waiting · ${secs}s`);
  }

  /** The error to raise when the deadline passes: name the last stage reached, or the stall. */
  timeout(stallHint: string, slowHint: string): Error {
    endStatus(this.prefix);
    return new Error(this.last ? `${slowHint} after '${this.last.stage}' (${this.last.by})` : `timed out: ${stallHint}`);
  }
}
