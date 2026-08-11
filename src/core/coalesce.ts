// One answer for identical questions asked at the same instant.
//
// THE PROBLEM IT SOLVES, measured (bench/suites/fanout.ts, agent_docs/plan-scaling.md): every SSE
// watch stream parked on the notifier is woken by the same `notify()` call, and each then reads
// the log (`getEvents`) and fetches the event's record (`matchesEvent`) for itself. With U streams
// that is 2U database queries for ONE write, of which 2 do any work: the log read is the same read
// U times, and the record fetch is the same record U times. Measured at 250 streams: 250 + 250.
//
// SINGLE-FLIGHT, NOT A CACHE, and the distinction is the whole safety argument. An entry lives
// only while its read is in flight; the moment it settles it is gone. So two callers share a
// result only when the second asked while the first was still waiting, which is exactly the
// wakeup burst and nothing else. There is no TTL to tune, no invalidation to get wrong, and no
// window in which a later caller can be served something stale: a sequential caller always hits
// the database.
//
// WHY THE BURST COALESCES AT ALL: `notify()` resolves every parked waiter synchronously, so all U
// stream loops resume in the same microtask batch and issue their reads before any of them can
// complete (the database round trip is the first await). They overlap by construction, not by
// luck. A stream that is mid-processing when the burst happens simply misses it and reads for
// itself on its next lap, which is correct and costs one query.
//
// WHAT IT IS NOT: a broadcast tailer. The alternative design (one reader that fans events out to
// subscribers from a ring) needs to place a subscriber's cursor in that ring, and cursors are
// deliberately OPAQUE and not ordered (an xid8 decimal string on Postgres, a seq on SQLite), so
// there is no correct comparison to do it with. This gets the same outcome (one log read, one
// record fetch, per-stream predicates evaluated in memory) without inventing cursor arithmetic.

/** Collapse identical CONCURRENT reads into one. Keyed by a caller-built string; the key must
 *  name everything the read depends on, or two different questions share one answer. */
export class Coalescer {
  #inflight = new Map<string, Promise<unknown>>();

  /**
   * Run `load` under `key`, or join the one already running.
   *
   * Only safe for reads whose answer cannot change while in flight. Both current callers qualify:
   * the event log below the finality watermark is append-only, and records are immutable after
   * commit. A shared record is still AUTHORIZED per caller (`matchesEvent` runs each watch's own
   * scope against it), so sharing the fetch changes what is read, never what is allowed.
   */
  run<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const started = load();
    this.#inflight.set(key, started);
    // Settle-or-fail both clear the entry, and `then` with two handlers (rather than `finally`)
    // means the derived promise never rejects: a failed read must not surface as an unhandled
    // rejection in a caller that already has the error through its own await.
    const clear = () => {
      if (this.#inflight.get(key) === started) this.#inflight.delete(key);
    };
    started.then(clear, clear);
    return started;
  }

  /** Reads in flight right now. Diagnostic, and what the tests assert nothing leaks into. */
  get inflight(): number {
    return this.#inflight.size;
  }
}
