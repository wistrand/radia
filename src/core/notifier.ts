// In-process wakeup for watch streams. A mutation calls notify(); SSE loops await wait()
// so they react near-instantly instead of polling. This is the embedded equivalent of
// Postgres LISTEN/NOTIFY: a wakeup only. The event log remains the source of truth.

export class Notifier {
  #waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /** Resolve on the next notify(), or after timeoutMs (keepalive), whichever comes first. */
  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      this.#waiters.push(fire);
    });
  }
}
