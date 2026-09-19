// The stable Postgres endpoint every Radia instance connects to, and the thing a failover moves.
//
// deno-postgres 0.19 takes one host, so an instance cannot follow a promotion by itself; a managed
// Postgres solves that by moving a DNS name, and this does the same by moving a TCP target.
// `retarget` SEVERS every open connection by default, because a real failover does: the old
// primary's sockets die with it, and whether the driver's pool notices is the question phase 3 of
// agent_docs/plan-cluster-bench.md exists to answer.
//
// In-process with the harness, a plain byte pump, no protocol awareness. `partition` holds every byte
// until `heal`, which is a network partition as the instances see it.

export interface Target {
  hostname: string;
  port: number;
}

export class PgProxy {
  readonly port: number;
  #target: Target;
  readonly #listener: Deno.TcpListener;
  readonly #open = new Set<Deno.Conn>();
  #accepted = 0;

  private constructor(listener: Deno.TcpListener, target: Target) {
    this.#listener = listener;
    this.#target = target;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#serve();
  }

  /** Listen on an ephemeral loopback port, forwarding to `target`. */
  static start(target: Target): PgProxy {
    return new PgProxy(Deno.listen({ hostname: "127.0.0.1", port: 0 }), target);
  }

  get target(): Target {
    return this.#target;
  }

  /** Connections accepted since start, and open now (both ends of a pair count once). */
  stats(): { accepted: number; open: number } {
    return { accepted: this.#accepted, open: this.#open.size / 2 };
  }

  /** Point new connections at `target`; by default drop every open one, as a failover would. */
  retarget(target: Target, opts: { sever?: boolean } = {}): void {
    this.#target = target;
    if (opts.sever !== false) this.#severAll();
  }

  close(): void {
    try {
      this.#listener.close();
    } catch { /* already closed */ }
    this.#severAll();
  }

  async #serve(): Promise<void> {
    try {
      for await (const client of this.#listener) this.#pair(client);
    } catch { /* listener closed */ }
  }

  /** Black-hole every byte, both ways, and every new connection, until `heal`: a PARTITION, where
   *  packets are dropped rather than connections refused, so a query hangs instead of failing. */
  partition(): void {
    if (this.#gate) return;
    this.#gate = new Promise((r) => this.#heal = r);
  }

  heal(): void {
    this.#heal?.();
    this.#gate = undefined;
  }

  #gate?: Promise<void>;
  #heal?: () => void;

  async #pair(client: Deno.Conn): Promise<void> {
    this.#accepted++;
    while (this.#gate) await this.#gate;
    let upstream: Deno.Conn;
    try {
      upstream = await Deno.connect(this.#target);
    } catch {
      // The target is down (mid-failover): refuse the way a dead primary would, by closing.
      close(client);
      return;
    }
    // Nagle off on both legs. The Postgres protocol exchanges many small messages per query, and
    // Nagle holding one back until the peer's delayed ACK costs about 40ms per round trip.
    for (const c of [client, upstream]) (c as Deno.TcpConn).setNoDelay(true);
    this.#open.add(client);
    this.#open.add(upstream);
    const done = () => {
      close(client);
      close(upstream);
      this.#open.delete(client);
      this.#open.delete(upstream);
    };
    // Either direction ending ends the pair: a half-open Postgres connection is a dead one.
    await Promise.race([this.#pump(client, upstream), this.#pump(upstream, client)]);
    done();
  }

  /** Copy bytes one way, holding each chunk while the proxy is partitioned. */
  async #pump(from: Deno.Conn, to: Deno.Conn): Promise<void> {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await from.read(buf);
        if (n === null) return;
        while (this.#gate) await this.#gate;
        for (let off = 0; off < n;) off += await to.write(buf.subarray(off, n));
      }
    } catch { /* either side closed */ }
  }

  #severAll(): void {
    for (const c of this.#open) close(c);
    this.#open.clear();
  }
}

function close(c: Deno.Conn): void {
  try {
    c.close();
  } catch { /* already closed */ }
}
