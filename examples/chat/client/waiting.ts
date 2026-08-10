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
const WAKE_KINDS = ["llm_chunk", "message", "tool_result"];
// How long before the status line stops saying "waiting" and offers the caller's hint instead.
//
// Raised from 2 500 after the hint turned out to be wrong most of the time it appeared. The trigger
// is "no progress record yet", and most tools emit no progress records AT ALL, so the old value
// fired on every ordinary tool that took longer than a couple of seconds: a jailed python start, an
// image, a workspace materialise. The hint is a DIAGNOSIS, so it should wait until "this is taking
// unusually long" is actually true, and the elapsed seconds are on screen the whole time anyway.
const STALL_MS = 9000;
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

/**
 * One progress record as a status line, trimmed to what is not inferable.
 *
 * Both trims are about the same thing: the line is redrawn several times a second, so anything
 * constant in it is read once and then costs width forever. `agent:chat-` prefixes every worker in
 * this fleet, and a worker's `note` (the model, the tool, the workspace) already says which one is
 * acting, so the principal only earns its place when there is no note at all.
 */
function describe(p: ProgressBody): string {
  const who = p.by.replace(/^agent:(chat-)?/, "");
  return p.note ? `${p.stage} ${p.note}` : `${p.stage} (${who})`;
}

/** One awaited call: what has been reported about it, and how long it has been waiting. */
export class Waiter {
  private readonly seen = new Set<string>();
  /** How many progress records this waiter has ever seen. A caller uses the CHANGE as evidence the
   *  work is still happening, which is what separates a slow answer from a stopped worker. */
  beats = 0;
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

  /**
   * Poll this call's progress records and redraw the status line.
   *
   * `force` skips the throttle, for the one moment that cannot wait for the next tick: the instant
   * before the first token is printed. A routing decision written inside the last poll interval was
   * otherwise never read, because the poll only runs while nothing has been printed, so the label
   * describing the answer arrived AFTER the answer.
   */
  /** @param match how to find the progress records to report: `{callId}` when the caller wrote the
   *   call and knows its id, `{conversationId}` when a WORKER wrote it and the caller only knows the
   *   turn (plan-chat-turn.md step 4). Only one thing runs at a time in a turn, so the conversation
   *   is as precise in practice and does not need an id the client never saw. */
  async pump(match: string | Record<string, unknown>, stallHint: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now < this.nextPoll) return;
    this.nextPoll = now + PROGRESS_POLL_MS;
    try {
      const rows = await this.client.query(
        { kind: "progress", match: typeof match === "string" ? { callId: match } : match },
        20,
      );
      for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (this.seen.has(r.id)) continue;
        this.seen.add(r.id);
        this.beats++;
        this.last = r.body as ProgressBody; // ULID order = emission order, so the last one wins
        this.onProgress?.(this.last);
      }
      // A read that WORKED clears the flag, or one transient hiccup marks the waiter blind for the
      // rest of the call and the timeout blames a permission problem that lasted 400ms.
      this.blind = undefined;
    } catch (e) {
      // Remembered, not just swallowed. "I looked and saw nothing" and "I was not allowed to look"
      // are different facts, and reporting the second as the first is how a timeout came to blame a
      // missing fleet for a call the router had claimed six seconds in.
      this.blind = e instanceof Error ? e.message : String(e);
    }
    if (force) return; // the caller is about to print; drawing a status line over it is noise
    const secs = Math.round((Date.now() - this.started) / 1000);
    if (this.last) showStatus(this.prefix, `${describe(this.last)} · ${secs}s`);
    else if (this.blind) showStatus(this.prefix, `waiting · ${secs}s (progress unreadable)`);
    else if (Date.now() - this.started > STALL_MS) showStatus(this.prefix, `${stallHint} · ${secs}s`);
    else showStatus(this.prefix, `waiting · ${secs}s`);
  }

  /** Why this waiter cannot see progress records, when it cannot. */
  private blind?: string;

  /**
   * The error to raise when the deadline passes: name the last stage reached, or the stall.
   *
   * THREE outcomes, because there are three states and conflating two of them misdirects whoever
   * reads the message: a stage was seen (slow), nothing was seen (nobody claimed it), or progress
   * could not be read at all, in which case this waiter knows nothing about who claimed what and
   * must say so instead of guessing.
   */
  timeout(stallHint: string, slowHint: string): Error {
    endStatus(this.prefix);
    if (this.last) return new Error(`${slowHint} after '${this.last.stage}' (${this.last.by})`);
    if (this.blind) {
      return new Error(
        `timed out. Whether a worker claimed this is UNKNOWN: reading progress records failed (${this.blind}), ` +
          `so this session cannot see the fleet. Check the grant on 'progress' before blaming the workers.`,
      );
    }
    return new Error(`timed out: ${stallHint}`);
  }
}
