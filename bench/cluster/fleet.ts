// What a load balancer in front of the cluster would do, done by the load generator itself
// (agent_docs/plan-cluster-bench.md, "Topology"): rotate requests across instances, give up on one
// that fails or goes silent, set it aside until a health check passes, and send the SAME request to
// the next.
//
// The same request, because that is the whole question an instance fault asks. A write whose
// connection died may have committed (the answer was lost) or not (it never arrived), and the
// client cannot tell which; resending it with its idempotency key must converge on one effect.
// Every write the workload makes carries a key, so a failover here is exactly that retry.
//
// Also a watcher that survives its instance: `resumableWatch` reconnects to ANOTHER instance with
// the last cursor it saw as `Last-Event-ID`, which is the claim that the `<xid>.<seq>` cursor is
// portable across instances (design-storage.md, "Watch delivery under concurrency").

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
import type { Cluster } from "./cluster.ts";

export class NoAnswer extends Error {
  constructor(ms: number) {
    super(`no answer in ${ms}ms`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NoAnswer(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The instance, not the request, is at fault: a network error, a timeout, a 5xx, or a 401 on an
 * OPERATOR client. Operator tokens live in the serving process, so a restarted instance refuses the
 * old one until `refresh` hands out the new one; nothing else here is ever refused a credential.
 */
export function unavailable(e: unknown): boolean {
  if (!(e instanceof RadiaClientError)) return true;
  return e.status >= 500 || e.status === 401;
}

export interface FleetOptions {
  /** Per attempt: a stalled instance answers nothing, so silence has to become a failure. */
  timeoutMs: number;
  /** How often an ejected instance is health-checked, and how long the check may take. */
  probeEveryMs: number;
  probeTimeoutMs: number;
  /** A request that has failed over for this long is given up and counted as an error. */
  deadlineMs: number;
}

export class Fleet {
  /** One operator client per instance, REPLACED IN PLACE by `refresh`, so a holder of this array
   *  (AuthRounds) sees a restarted instance's new token without being told. */
  readonly clients: RadiaClient[] = [];
  /** Set aside until a health check passes. A fixed ejection window was tried and is wrong: when
   *  it lapsed on a STALLED instance, nearly every loop's next request went to it at once and the
   *  whole load waited out the request timeout together, every few seconds, until it resumed. */
  readonly #ejected: boolean[] = [];
  #closed = false;
  #turn = 0;
  failovers = 0;
  /** Called with the instance that answered, for the per-instance recovery timeline. */
  onSuccess?: (instance: number) => void;
  onFailover?: (instance: number) => void;

  constructor(
    readonly cluster: Cluster,
    readonly opts: FleetOptions = { timeoutMs: 5_000, probeEveryMs: 500, probeTimeoutMs: 1_000, deadlineMs: 60_000 },
  ) {
    for (let i = 0; i < cluster.instances.length; i++) this.refresh(i);
  }

  get n(): number {
    return this.cluster.instances.length;
  }

  /** Re-read instance `i`'s URL and token (after a restart). The health check re-admits it. */
  refresh(i: number): void {
    const inst = this.cluster.instances[i];
    this.clients[i] = new RadiaClient(inst.url, { token: inst.token });
  }

  /** Stop the health checks. */
  close(): void {
    this.#closed = true;
  }

  endpoint(i: number): { url: string; token: string } {
    return { url: this.cluster.instances[i].url, token: this.cluster.instances[i].token };
  }

  eject(i: number): void {
    if (this.#ejected[i]) return;
    this.#ejected[i] = true;
    this.#probe(i);
  }

  /** Re-admit `i` once its operator client's `health()` answers in time. Through the operator
   *  client, so a restarted instance stays out until `refresh` has handed out its new token. */
  async #probe(i: number): Promise<void> {
    while (this.#ejected[i] && !this.#closed) {
      await sleep(this.opts.probeEveryMs);
      try {
        await withTimeout(this.clients[i].health(), this.opts.probeTimeoutMs);
        this.#ejected[i] = false;
      } catch { /* still out */ }
    }
  }

  /** The next instance in rotation that is not set aside; any instance when all of them are. */
  next(): number {
    for (let k = 0; k < this.n; k++) {
      const i = this.#turn++ % this.n;
      if (!this.#ejected[i]) return i;
    }
    return this.#turn++ % this.n;
  }

  /** `fn` through the next instance, failing over to the others until one answers. A refusal that
   *  is about the REQUEST (4xx other than 401) is the request's answer and is thrown, not retried. */
  async call<T>(fn: (c: RadiaClient, i: number) => Promise<T>): Promise<T> {
    const start = performance.now();
    for (let attempt = 1;; attempt++) {
      const i = this.next();
      try {
        const out = await withTimeout(fn(this.clients[i], i), this.opts.timeoutMs);
        this.onSuccess?.(i);
        return out;
      } catch (e) {
        if (!unavailable(e)) throw e;
        this.eject(i);
        this.failovers++;
        this.onFailover?.(i);
        if (performance.now() - start > this.opts.deadlineMs) throw e;
        if (attempt % this.n === 0) await sleep(200);
      }
    }
  }
}

export interface WatchStats {
  /** Connections opened after the first, each resuming from the last cursor seen. */
  reconnects: number;
  /** Reconnects that landed on a different instance than the one that dropped. */
  moved: number;
}

/**
 * Watch `pattern` for as long as `signal` is open, whatever happens to the instance serving it.
 * A stream that errors, ends, or says nothing for `idleMs` (the server's keepalive is 15s, and this
 * workload writes continuously, so silence means a stalled or dead instance) is abandoned and the
 * watch re-created on the next instance, resuming from the last cursor. Reconnecting a healthy but
 * quiet stream loses nothing by the same token, so the idle bound can be short.
 */
export async function resumableWatch(
  fleet: Fleet,
  home: number,
  pattern: Record<string, unknown>,
  onEvent: (e: { recordId: string; seq: number; kind: string }) => void,
  signal: AbortSignal,
  stats: WatchStats,
  idleMs = 5_000,
  /** False reconnects WITHOUT the cursor: a planted fault, so "no gaps after a move" is shown to
   *  depend on the cursor rather than on nothing having happened during the move. */
  resume = true,
): Promise<void> {
  let cursor: string | undefined;
  let inst = home;
  let first = true;
  const dec = new TextDecoder();
  while (!signal.aborted) {
    if (!first) {
      stats.reconnects++;
      const was = inst;
      inst = fleet.next();
      if (inst !== was) stats.moved++;
    }
    first = false;
    const conn = new AbortController();
    const abort = () => conn.abort();
    signal.addEventListener("abort", abort);
    try {
      const { url, token } = fleet.endpoint(inst);
      const auth = { "Authorization": `Bearer ${token}` };
      const created = await withTimeout(
        fetch(`${url}/v0/watches`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(pattern), signal: conn.signal }),
        fleet.opts.timeoutMs,
      );
      if (!created.ok) {
        await created.body?.cancel();
        throw new Error(`watch create ${created.status}`);
      }
      const { watchId } = await created.json() as { watchId: string };
      const res = await withTimeout(
        fetch(`${url}/v0/watches/${watchId}/events`, {
          headers: { ...auth, ...(resume && cursor !== undefined ? { "Last-Event-ID": cursor } : {}) },
          signal: conn.signal,
        }),
        fleet.opts.timeoutMs,
      );
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`watch events ${res.status}`);
      }
      const reader = res.body.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await withTimeout(reader.read(), idleMs);
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          let id: string | undefined, data: string | undefined, event: string | undefined;
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("data: ")) data = line.slice(6);
            else if (line.startsWith("event: ")) event = line.slice(7);
          }
          if (event === "revoked") throw new Error(`watch revoked: ${data}`);
          if (id !== undefined) cursor = id;
          if (data !== undefined && event === undefined) onEvent(JSON.parse(data));
        }
      }
    } catch {
      if (signal.aborted) return;
      fleet.eject(inst);
    } finally {
      signal.removeEventListener("abort", abort);
      conn.abort();
    }
    if (!signal.aborted) await sleep(100);
  }
}
