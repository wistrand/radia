// Wakeup for watch streams. A mutation calls notify(); SSE loops await wait() so they react
// near-instantly instead of polling.
//
// TWO SOURCES OF WAKEUP, because one process is not the whole space. `notify()` covers mutations
// this instance performed. Anything committed by ANOTHER instance (or another Space object over
// the same database) is invisible here, and the event log is the only thing both sides share, so
// a waiter also drives a periodic `poll` of it. That poll runs ONLY while somebody is waiting: an
// idle space issues no queries and holds no timer, which is what keeps this from being a
// background job with a lifecycle to manage.
//
// The poll is a HINT, exactly like the local notify: it says "look again", never what changed.
// The event log remains the source of truth, so a poll that fails, lags or fires spuriously costs
// a wasted loop iteration and nothing else.

/** How often a waiting stream asks the log whether another instance wrote something.
 *
 *  The number is a latency floor for every cross-instance hop, so it is set by what an interactive
 *  agent turn can absorb rather than by what is cheap: before this, a wakeup that crossed
 *  instances waited for the caller's keepalive (15s in the SSE loop). One query per interval per
 *  SPACE, not per stream, however many watchers are open. */
export const CHANGE_POLL_MS = 250;

export class Notifier {
  /** A Set, not an array: a waiter that TIMES OUT removes itself. As an array it stayed until the
   *  next notify(), so a quiet space with a reconnecting client accumulated dead closures. */
  #waiters = new Set<() => void>();
  /** `ReturnType`, not `number`: the ambient typings differ per runtime (Deno's `number` vs Node's
   *  `Timeout`), and this file is compiled under both when the SDK package is built. */
  #timer?: ReturnType<typeof setTimeout>;

  /** @param poll asks whether anything changed outside this process. Omitted (tests, spaces with
   *              no storage behind them) means local notifications only. */
  constructor(private readonly poll?: () => Promise<boolean>) {}

  notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    this.#stopPolling();
    for (const w of waiters) w();
  }

  /** Resolve on the next notify(), on a change another instance made, or after timeoutMs
   *  (keepalive), whichever comes first. */
  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters.delete(fire);
        if (this.#waiters.size === 0) this.#stopPolling();
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      this.#waiters.add(fire);
      this.#startPolling();
    });
  }

  /** Waiters currently parked here. Diagnostic; also what the tests assert nothing leaks into. */
  get waiting(): number {
    return this.#waiters.size;
  }

  #startPolling(): void {
    if (!this.poll || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => void this.#tick(), CHANGE_POLL_MS);
  }

  async #tick(): Promise<void> {
    this.#timer = undefined;
    if (this.#waiters.size === 0) return; // everyone left while the timer ran
    let changed = false;
    try {
      changed = await this.poll!();
    } catch {
      // A hint that failed is a hint not taken: the caller still has its keepalive, and the log is
      // still the truth. Never let a polling error take down a stream.
    }
    if (this.#waiters.size === 0) return;
    if (changed) this.notify();
    else this.#startPolling();
  }

  #stopPolling(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
