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
  // Waiters KEYED BY KIND, so a write of kind K wakes only streams watching K. Kind-blind wakeup
  // was the O(U) term behind the chat's fan-out: one write woke every parked stream, each of which
  // then read the log and re-parked (bench/suites/fanout.ts measured N getEvents per write for N
  // streams, of which one matched). A watch matches only events of its own kind (Space.matchesEvent
  // requires kind equality), so waking a foreign kind's watchers was always pure waste.
  //
  // Two buckets. `#byKind` is a Set per kind (a timed-out waiter removes itself, so a quiet space
  // does not accumulate dead closures). `#any` is for a waiter that names no kind and for the
  // cross-instance poll, which cannot know which kind changed from a single probe and so wakes
  // everyone — see Space.pollForForeignChanges and #tick below.
  #byKind = new Map<string, Set<() => void>>();
  #any = new Set<() => void>();
  /** `ReturnType`, not `number`: the ambient typings differ per runtime (Deno's `number` vs Node's
   *  `Timeout`), and this file is compiled under both when the SDK package is built. */
  #timer?: ReturnType<typeof setTimeout>;

  /** @param poll asks whether anything changed outside this process. Omitted (tests, spaces with
   *              no storage behind them) means local notifications only. */
  constructor(private readonly poll?: () => Promise<boolean>) {}

  #total(): number {
    let n = this.#any.size;
    for (const s of this.#byKind.values()) n += s.size;
    return n;
  }

  /**
   * Wake waiters. `kind` wakes that kind's watchers plus the any-set; `undefined` wakes EVERYONE.
   *
   * Undefined is the conservative wake, used where the caller cannot cheaply name the kind whose
   * watchers newly match OR where a write may affect every stream: an authorization-kind write
   * (a grant/run/definition change the SSE loop re-scopes on), a quarantine that reopens leases
   * across kinds, and the foreign-change poll. Space names the kind on the hot paths (put, and an
   * ack that emits a result), which is where the fan-out is.
   */
  notify(kind?: string): void {
    const fired: (() => void)[] = [];
    if (kind === undefined) {
      for (const s of this.#byKind.values()) fired.push(...s);
      this.#byKind.clear();
    } else {
      const s = this.#byKind.get(kind);
      if (s) {
        fired.push(...s);
        this.#byKind.delete(kind);
      }
    }
    fired.push(...this.#any);
    this.#any.clear();
    this.#stopPolling();
    for (const f of fired) f();
  }

  /** Resolve on a matching notify(), on a change another instance made, or after timeoutMs
   *  (keepalive), whichever comes first. `kind` scopes the wakeup; omit it to wake on anything. */
  wait(timeoutMs: number, kind?: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let bucket: Set<() => void>;
      if (kind === undefined) {
        bucket = this.#any;
      } else {
        bucket = this.#byKind.get(kind) ?? new Set();
        this.#byKind.set(kind, bucket);
      }
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        bucket.delete(fire);
        if (kind !== undefined && bucket.size === 0) this.#byKind.delete(kind);
        if (this.#total() === 0) this.#stopPolling();
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      bucket.add(fire);
      this.#startPolling();
    });
  }

  /** Waiters currently parked here, across every kind. Diagnostic; also what the tests assert
   *  nothing leaks into. */
  get waiting(): number {
    return this.#total();
  }

  #startPolling(): void {
    if (!this.poll || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => void this.#tick(), CHANGE_POLL_MS);
  }

  async #tick(): Promise<void> {
    this.#timer = undefined;
    if (this.#total() === 0) return; // everyone left while the timer ran
    let changed = false;
    try {
      changed = await this.poll!();
    } catch {
      // A hint that failed is a hint not taken: the caller still has its keepalive, and the log is
      // still the truth. Never let a polling error take down a stream.
    }
    if (this.#total() === 0) return;
    // A foreign change of UNKNOWN kind wakes everyone: the poll's single-event probe cannot report
    // every kind that changed, so it cannot be kind-selective without becoming a log reader itself.
    if (changed) this.notify();
    else this.#startPolling();
  }

  #stopPolling(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
