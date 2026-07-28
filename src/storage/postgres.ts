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

import { Pool, type PoolClient } from "@db/postgres";
import { NOW_SQL, PgSqlAdapter, type Sql, type SqlBackend, type SqlResult } from "./pgbase.ts";
import type { RawRow } from "./row.ts";
import { newUlid } from "../core/ids.ts";

// deno-postgres (0.19.x) does not set TCP_NODELAY, so its extended-protocol (parameterized)
// queries send several small packets and hit Nagle + delayed-ACK, costing ~40ms PER query, which is
// catastrophic for a chatty coordination workload (measured 42ms → 0.18ms with NODELAY). The
// driver connects via `Deno.connect` and exposes no socket hook, so enable NODELAY by wrapping
// `Deno.connect` once. Only raw TCP connects are affected (radia's other I/O is `Deno.serve` and
// `fetch`, a native HTTP client rather than `Deno.connect`), and NODELAY on a Postgres socket is
// unconditionally correct. Remove if deno-postgres starts setting it. Idempotent.
let noDelayEnabled = false;
function enableTcpNoDelay(): void {
  if (noDelayEnabled) return;
  noDelayEnabled = true;
  const original = Deno.connect.bind(Deno);
  Object.defineProperty(Deno, "connect", {
    configurable: true,
    value: async (opts: Deno.ConnectOptions | Deno.UnixConnectOptions): Promise<Deno.Conn> => {
      const conn = await original(opts as Deno.ConnectOptions);
      try {
        (conn as Deno.TcpConn).setNoDelay(true);
      } catch { /* not a TCP connection */ }
      return conn;
    },
  });
}

export interface PostgresOptions {
  /** Confine all tables to this schema (set as `search_path` on every connection). */
  schema?: string;
  /** Create the schema on init and DROP ... CASCADE on close (conformance/ephemeral use). */
  ephemeral?: boolean;
  /** Pool size (concurrent connections). Default 8. */
  poolSize?: number;
}

/** Wrap a deno-postgres connection pool to the SqlBackend port. */
class PostgresBackend implements SqlBackend {
  #pool?: Pool;
  readonly #schema?: string;
  readonly #ephemeral: boolean;
  readonly #poolSize: number;

  constructor(private readonly url: string, opts: PostgresOptions = {}) {
    enableTcpNoDelay(); // before any connection is opened
    this.#schema = opts.schema;
    this.#ephemeral = opts.ephemeral ?? false;
    this.#poolSize = opts.poolSize ?? 8;
  }

  async init(): Promise<void> {
    this.#pool = new Pool(this.url, this.#poolSize, true); // lazy: connect on first acquire
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
  private async withConn<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!this.#pool) throw new Error("PostgresBackend not initialized");
    const c = await this.#pool.connect();
    try {
      if (this.#schema) await c.queryArray(`set search_path to "${this.#schema}"`);
      return await fn(c);
    } finally {
      c.release();
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
