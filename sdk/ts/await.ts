// Waiting for a record that another agent will write.
//
// The half of content routing every client re-implements. A caller writes a request record and then
// has to sit until somebody claims it, does the work, and acks a result — and there is no call
// stack to block on, because the point of the space is that the two sides never met. So every
// client grows a poll loop with a deadline, and every one of them gets the same three details
// slightly wrong: reading once more after the wake (so a result that landed during it is not lost
// to the timeout), separating "nothing yet" from "cancelled", and reporting a timeout as an outcome
// rather than as an exception the caller must classify.
//
// Deliberately NOT a watch subscription. A watch per outstanding call is a stream per call, and the
// clients that need this most already hold ONE wake signal shared across every wait (the chat's
// `waitWake`). So the wake is injected: pass a shared one, or take the default sleep.

import type { Pattern, RadiaRecord } from "./wire.ts";
import type { RadiaClient } from "./client.ts";

/**
 * Why the wait ended. A DISCRIMINATED result rather than a record-or-throw, because "nobody
 * answered in time" is an ordinary outcome of asking a fleet for something: the caller has a
 * sentence to write about it, and making it an exception means every caller invents its own error
 * type and then catches it two lines later.
 */
export type AwaitOutcome<T = unknown> =
  | { status: "ok"; record: RadiaRecord; body: T }
  | { status: "timeout"; waitedMs: number }
  | { status: "aborted" };

export interface AwaitOptions {
  /** How long to keep asking before giving up. With `alive`, this is how long the work may go
   *  UNOBSERVED rather than how long it may take: a deadline on total elapsed time cannot tell a
   *  slow answer from a dead worker, and the expensive models are the slow ones. */
  timeoutMs: number;
  /**
   * Evidence the work is still happening, checked on every wait. Returning a value DIFFERENT from
   * last time restarts the clock.
   *
   * A caller that can see progress (streamed chunks, a worker's status records) should pass it:
   * otherwise a long answer is indistinguishable from a stopped worker, and the caller abandons a
   * turn the worker then finishes for nobody.
   */
  alive?: () => unknown;
  /** Wait for something to change. Defaults to a sleep of `pollMs`; pass a shared watch-driven
   *  wake to avoid a stream per outstanding call. */
  wake?: () => Promise<void>;
  pollMs?: number;
  /** Run before each read. The chat flushes streamed tokens here, so a partial answer keeps
   *  printing while the final record is still on its way. */
  beforeRead?: () => Promise<void> | void;
  /** Run after a read found nothing, before waiting again: status lines, prompts, anything that
   *  should happen only while the answer is genuinely outstanding. */
  onWait?: () => Promise<void> | void;
  /** Checked AFTER the wake rather than before the read, so a result that arrived while the user
   *  was reaching for the cancel key is still delivered. Cancelling a wait that already finished
   *  throws away an answer for nothing. */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll for the first record matching `pattern`, until it appears or the deadline passes.
 *
 * The pattern is ordinarily `{kind, match: {callId}}`: the correlation id the requester chose, which
 * is what stands in for a return address in a space that has none.
 */
export async function awaitResult<T = unknown>(
  client: RadiaClient,
  pattern: Pattern,
  opts: AwaitOptions,
): Promise<AwaitOutcome<T>> {
  const started = Date.now();
  let deadline = started + opts.timeoutMs;
  let seen = opts.alive?.();
  const wake = opts.wake ?? (() => sleep(opts.pollMs ?? 200));
  while (Date.now() < deadline) {
    if (opts.beforeRead) await opts.beforeRead();
    const record = await client.readOne(pattern);
    if (record) return { status: "ok", record, body: record.body as T };
    if (opts.onWait) await opts.onWait();
    await wake();
    if (opts.signal?.aborted) return { status: "aborted" };
    if (opts.alive) {
      const now = opts.alive();
      if (now !== seen) {
        seen = now;
        deadline = Date.now() + opts.timeoutMs; // still working: the clock is about SILENCE
      }
    }
  }
  // One last read on the way out. The deadline expiring between the previous read and now is the
  // common case on a slow tool, and reporting a timeout for a result already in the space is the
  // most annoying way this can be wrong.
  if (opts.beforeRead) await opts.beforeRead();
  const late = await client.readOne(pattern);
  if (late) return { status: "ok", record: late, body: late.body as T };
  return { status: "timeout", waitedMs: Date.now() - started };
}
