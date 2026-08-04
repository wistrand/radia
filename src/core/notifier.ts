// Wakeup for watch streams. A mutation calls notify(); SSE loops await wait().
//
// TWO SOURCES, because one process is not the whole space: `notify()` covers this instance's own
// mutations, and a waiter drives a periodic `poll` of the event log for everyone else's. The poll
// runs only while somebody is waiting, so an idle space holds no timer and issues no queries.
// Both are HINTS ("look again"), never what changed; the log stays the source of truth, so a poll
// that fails or fires spuriously costs one wasted loop iteration.

/** How often a waiting stream asks the log whether another instance wrote something. A latency
 *  floor for every cross-instance hop (it was the caller's 15s keepalive before), and one query
 *  per interval per SPACE however many watchers are open. */
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
