// Standalone Postgres adapter (M1). The multi-instance / HA backend: N runtime instances over
// one shared server, with a checked compare-and-set giving the atomic claim across connections
// (see agent_docs/design-storage.md "Scaling"). All SQL lives in the shared
// PgSqlAdapter body. This file is only the driver binding (deno-postgres, pure-Deno TCP, no npm).
//
// Connection pooling: each op acquires a pooled connection and releases it, so concurrent takes
// genuinely race on distinct connections. This adapter is therefore the only one that exercises
// the concurrent claim path at all. The embedded adapters serialize it away, which is why a
// claim-path change must be run through `scripts/pg-conformance.sh`, not just `deno task
// conformance` (gotchas.md, "a claim must not lock what it does not claim"). An
// optional `schema` isolates a run into its own namespace, used by the conformance harness,
// which spins up an ephemeral schema per adapter and drops it on close.

import { Client } from "@db/postgres";
import { NOW_SQL, PgSqlAdapter, type Sql, type SqlBackend, type SqlResult } from "./pgbase.ts";
import type { RawRow } from "./row.ts";
import { newUlid } from "../core/ids.ts";

// Two fixes to deno-postgres (0.19.x) sockets, applied by wrapping `Deno.connect` and `Deno.startTls`
// once, since the driver exposes no socket hook. Only the driver's connects are affected (radia's
// other I/O is `Deno.serve` and `fetch`, a native HTTP client rather than `Deno.connect`). Idempotent.
//
// TCP_NODELAY. The driver never sets it, so its extended-protocol (parameterized) queries send
// several small packets and hit Nagle + delayed-ACK, costing ~40ms PER query (measured 42ms →
// 0.18ms). Remove if deno-postgres starts setting it.
//
// A DEAD SOCKET MUST END THE CONNECTION. When a connection dies WITHOUT the server's FATAL goodbye
// (a killed or failed-over server, a dropped network path, a proxy or pooler closing it; a
// `pg_terminate_backend` sends the goodbye and was always handled), the driver's next write throws
// `BrokenPipe`, which `Connection.query` does not treat as a `ConnectionError`, so the connection
// stays marked `connected`; and on the `ConnectionError` path `end()` writes a termination message
// BEFORE its `finally` closes, which throws the same way. The pool re-connects only a client that is
// not `connected`, so the slot fails every request forever: measured, one abrupt disconnect through a
// proxy failed 120 of the next 120 requests (plan-cluster-bench.md, phase 3). So a transport failure makes
// the socket DEAD: writes are swallowed and reads answer end-of-stream, which the driver turns into
// its own `ConnectionError`, whose `end()` now closes. The request in flight still fails; the next
// one on that slot reconnects. Remove if deno-postgres handles a broken pipe itself.
const TRANSPORT_ERRORS = [
  Deno.errors.BrokenPipe,
  Deno.errors.ConnectionReset,
  Deno.errors.ConnectionAborted,
  Deno.errors.NotConnected,
  Deno.errors.UnexpectedEof,
];
const isTransport = (e: unknown) => TRANSPORT_ERRORS.some((t) => e instanceof t);

/** Patched IN PLACE rather than wrapped, so `Deno.startTls` still receives the real `TcpConn`. */
function hardenSocket<C extends Deno.Conn>(conn: C): C {
  let dead = false;
  const read = conn.read.bind(conn);
  conn.read = async (p: Uint8Array) => {
    if (dead) return null;
    try {
      return await read(p);
    } catch (e) {
      if (!isTransport(e)) throw e;
      dead = true;
      return null;
    }
  };
  // The socket's own stream, taken BEFORE the property is replaced: read after, it is this wrapper.
  const socketWritable = conn.writable;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      if (dead) return;
      try {
        await (writer ??= socketWritable.getWriter()).write(chunk);
      } catch (e) {
        if (!isTransport(e)) throw e;
        dead = true;
      }
    },
  });
  Object.defineProperty(conn, "writable", { configurable: true, value: writable });
  return conn;
}

let socketsPatched = false;
function patchDriverSockets(): void {
  if (socketsPatched) return;
  socketsPatched = true;
  const connect = Deno.connect.bind(Deno);
  Object.defineProperty(Deno, "connect", {
    configurable: true,
    value: async (opts: Deno.ConnectOptions | Deno.UnixConnectOptions): Promise<Deno.Conn> => {
      const conn = await connect(opts as Deno.ConnectOptions);
      try {
        (conn as Deno.TcpConn).setNoDelay(true);
      } catch { /* not a TCP connection */ }
      return hardenSocket(conn);
    },
  });
  const startTls = Deno.startTls.bind(Deno);
  Object.defineProperty(Deno, "startTls", {
    configurable: true,
    value: async (conn: Deno.TcpConn, opts?: Deno.StartTlsOptions): Promise<Deno.TlsConn> => hardenSocket(await startTls(conn, opts)),
  });
}

/**
 * The connection pool, in place of the driver's `Pool`, which loses a slot for good whenever
 * reconnecting it fails: `DeferredAccessStack.pop` takes the client off the stack and does not put
 * it back when its connect throws, as every connect does while a primary is down. After as many
 * failed connects as the pool is wide, every request waited forever on an empty pool (measured
 * during a failover, plan-cluster-bench.md phase 3). Here a failed connect returns the client first.
 */
class ClientPool {
  readonly #all: Client[];
  readonly #idle: Client[];
  readonly #waiters: Array<(c: Client) => void> = [];

  constructor(url: string, size: number) {
    this.#all = Array.from({ length: size }, () => new Client(url)); // lazy: connects on acquire
    this.#idle = [...this.#all];
  }

  async acquire(): Promise<Client> {
    const c = this.#idle.pop() ?? await new Promise<Client>((resolve) => this.#waiters.push(resolve));
    if (!c.connected) {
      try {
        await c.connect();
      } catch (e) {
        await this.release(c);
        throw e;
      }
    }
    return c;
  }

  /** A client handed back inside a transaction (its commit or rollback failed) is in no state to
   *  reuse, so it is ended and the next acquire reconnects it. */
  async release(c: Client): Promise<void> {
    if (c.connected && c.session.current_transaction !== null) await c.end().catch(() => {});
    const waiter = this.#waiters.shift();
    if (waiter) waiter(c);
    else this.#idle.push(c);
  }

  async end(): Promise<void> {
    await Promise.all(this.#all.map((c) => c.end().catch(() => {})));
  }
}

export interface PostgresOptions {
  /** Confine all tables to this schema (set as `search_path` on every connection). */
  schema?: string;
  /** Create the schema on init and DROP ... CASCADE on close (test/ephemeral use). */
  ephemeral?: boolean;
  /** Pool size (concurrent connections). Default 8. */
  poolSize?: number;
}

/** Wrap a deno-postgres connection pool to the SqlBackend port. */
class PostgresBackend implements SqlBackend {
  #pool?: ClientPool;
  readonly #schema?: string;
  readonly #ephemeral: boolean;
  readonly #poolSize: number;

  constructor(private readonly url: string, opts: PostgresOptions = {}) {
    patchDriverSockets(); // before any connection is opened
    this.#schema = opts.schema;
    this.#ephemeral = opts.ephemeral ?? false;
    this.#poolSize = opts.poolSize ?? 8;
  }

  async init(): Promise<void> {
    this.#pool = new ClientPool(this.url, this.#poolSize);
    if (this.#schema && this.#ephemeral) {
      await this.withConn((c) => c.queryArray(`create schema if not exists "${this.#schema}"`).then(() => {}));
    }
  }

  async close(): Promise<void> {
    if (!this.#pool) return;
    if (this.#schema && this.#ephemeral) {
      await this.withConn((c) => c.queryArray(`drop schema if exists "${this.#schema}" cascade`).then(() => {}));
    }
    await this.#pool.end();
    this.#pool = undefined;
  }

  async exec(ddl: string): Promise<void> {
    // deno-postgres uses the extended protocol, which forbids multiple statements per query,
    // so split the DDL and run each statement on one connection (in-schema via search_path).
    // Strip `--` line comments FIRST: the split is naive, so a semicolon inside a comment would
    // otherwise cut it in half and feed the tail to the parser as SQL. (Assumes no `--` appears
    // inside a string literal in the DDL, which holds; see DDL in pgbase.ts.)
    const statements = ddl
      .replace(/--[^\n]*/g, "")
      .split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    await this.withConn(async (c) => {
      for (const stmt of statements) await c.queryArray(stmt);
    });
  }

  async query<T = RawRow>(text: string, params: unknown[] = []): Promise<SqlResult<T>> {
    return await this.withConn(async (c) => {
      const r = await c.queryObject<T>({ text, args: params });
      return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
    });
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return await this.withConn(async (c) => {
      const tx = c.createTransaction(`t_${newUlid()}`);
      await tx.begin();
      try {
        const sql: Sql = {
          query: async <U>(text: string, params: unknown[] = []) => {
            const r = await tx.queryObject<U>({ text, args: params });
            return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
          },
        };
        const out = await fn(sql);
        await tx.commit();
        return out;
      } catch (e) {
        await tx.rollback().catch(() => {}); // best-effort; surface the original error
        throw e;
      }
    });
  }

  async now(): Promise<string> {
    const r = await this.query<{ now: string }>(NOW_SQL);
    return r.rows[0].now;
  }

  /** Acquire a pooled connection, pin it to the schema, run `fn`, always release. */
  private async withConn<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    if (!this.#pool) throw new Error("PostgresBackend not initialized");
    const pool = this.#pool;
    const c = await pool.acquire();
    try {
      if (this.#schema) await c.queryArray(`set search_path to "${this.#schema}"`);
      return await fn(c);
    } finally {
      await pool.release(c);
    }
  }
}

export class PostgresAdapter extends PgSqlAdapter {
  /**
   * @param url  a `postgres://…` connection string (or deno-postgres connection config URL).
   * @param opts optional schema confinement (see PostgresOptions).
   */
  constructor(url: string, opts: PostgresOptions = {}) {
    super("postgres", new PostgresBackend(url, opts));
  }
}
