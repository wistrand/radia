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
import { RadiaError } from "../core/errors.ts";

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

/** Thrown by `withDeadline` when the operation outlived its budget. Internal: callers see
 *  `database_unavailable`. */
class Deadline extends Error {}

/** Race `p` against `ms`. The loser is not cancelled (the driver has no cancellation), so its
 *  eventual rejection is caught here: an unhandled one would end the process. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function databaseUnavailable(ms: number, what: string): RadiaError {
  return new RadiaError(
    "database_unavailable",
    `the database did not answer ${what} within ${ms}ms. A write's outcome is unknown: retry it with ` +
      `the same idempotency key, which returns the first result if it did commit.`,
  );
}

/**
 * The connection pool, in place of the driver's `Pool`, for two reasons.
 *
 * The driver's pool loses a slot for good whenever reconnecting it fails: `DeferredAccessStack.pop`
 * takes the client off the stack and does not put it back when its connect throws, as every connect
 * does while a primary is down. After as many failed connects as the pool was wide, every request
 * waited forever on an empty pool (measured during a failover, plan-cluster-bench.md phase 3). Here a
 * failed connect returns the client first.
 *
 * And NOTHING in the driver times out. A database that vanishes without resetting its connections (a
 * dead host, a dropped path) leaves a query waiting on a socket until the kernel gives up, which for
 * an idle connection is never, and every request queued behind the pool waits with it
 * (plan-audit-remediation.md AC1). So every step has a deadline: waiting for a slot, connecting, and
 * the operation. A client that misses one is REPLACED, never reused: its query is still pending in
 * the driver, and when it settles it releases the connection's internal query lock into whatever
 * session the client has by then, which would let two queries interleave on one connection.
 */
class ClientPool {
  readonly #all: Client[];
  readonly #idle: Client[];
  readonly #waiters: Array<(c: Client) => void> = [];

  constructor(private readonly url: string, size: number, private readonly timeoutMs: number) {
    this.#all = Array.from({ length: size }, () => new Client(url)); // lazy: connects on acquire
    this.#idle = [...this.#all];
  }

  async acquire(): Promise<Client> {
    const c = this.#idle.pop() ?? await this.#wait();
    if (!c.connected) {
      try {
        await withDeadline(c.connect(), this.timeoutMs);
      } catch (e) {
        if (e instanceof Deadline) {
          this.replace(c);
          throw databaseUnavailable(this.timeoutMs, "a connect");
        }
        await this.release(c);
        throw e;
      }
    }
    return c;
  }

  /** Wait for a released client, for no longer than the deadline: with every slot held by an
   *  operation that will itself time out, queueing forever would outlast all of them. */
  #wait(): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const waiter = (c: Client) => {
        clearTimeout(timer);
        resolve(c);
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(databaseUnavailable(this.timeoutMs, "with a free connection"));
      }, this.timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /** A client handed back inside a transaction (its commit or rollback failed) is in no state to
   *  reuse, so it is ended and the next acquire reconnects it. */
  async release(c: Client): Promise<void> {
    if (c.connected && c.session.current_transaction !== null) await c.end().catch(() => {});
    this.#handOut(c);
  }

  /** Abandon `c` (its operation outlived the deadline) and put a fresh client in its slot. Ending it
   *  closes the socket, which settles the abandoned operation; that is left to run in the background,
   *  since on a black-holed connection it may take as long as the kernel does. */
  replace(c: Client): void {
    c.end().catch(() => {});
    const i = this.#all.indexOf(c);
    if (i < 0) return; // already replaced: its slot has a fresh client
    const fresh = new Client(this.url);
    this.#all[i] = fresh;
    this.#handOut(fresh);
  }

  #handOut(c: Client): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(c);
    else this.#idle.push(c);
  }

  async end(): Promise<void> {
    await Promise.all(this.#all.map((c) => withDeadline(c.end(), this.timeoutMs).catch(() => {})));
  }
}

export interface PostgresOptions {
  /** Confine all tables to this schema (set as `search_path` on every connection). */
  schema?: string;
  /** Create the schema on init and DROP ... CASCADE on close (test/ephemeral use). */
  ephemeral?: boolean;
  /** Pool size (concurrent connections). Default 8. */
  poolSize?: number;
  /** The most one database operation may take, waiting for a connection and connecting included,
   *  before it fails `database_unavailable` and its connection is replaced. Default 30s: well past
   *  any single statement this runtime issues (GC and compaction work in bounded batches), and
   *  short enough that a vanished database is reported rather than waited on forever. */
  operationTimeoutMs?: number;
}

/** Wrap a deno-postgres connection pool to the SqlBackend port. */
class PostgresBackend implements SqlBackend {
  #pool?: ClientPool;
  readonly #schema?: string;
  readonly #ephemeral: boolean;
  readonly #poolSize: number;
  readonly #timeoutMs: number;

  constructor(private readonly url: string, opts: PostgresOptions = {}) {
    patchDriverSockets(); // before any connection is opened
    this.#schema = opts.schema;
    this.#ephemeral = opts.ephemeral ?? false;
    this.#poolSize = opts.poolSize ?? 8;
    this.#timeoutMs = opts.operationTimeoutMs ?? 30_000;
  }

  async init(): Promise<void> {
    this.#pool = new ClientPool(this.url, this.#poolSize, this.#timeoutMs);
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
    const op = (async () => {
      if (this.#schema) await c.queryArray(`set search_path to "${this.#schema}"`);
      return await fn(c);
    })();
    let out: T;
    try {
      out = await withDeadline(op, this.#timeoutMs);
    } catch (e) {
      if (e instanceof Deadline) {
        pool.replace(c);
        throw databaseUnavailable(this.#timeoutMs, "an operation");
      }
      await pool.release(c);
      throw e;
    }
    await pool.release(c);
    return out;
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
