// Embedded adapter: PGlite (WASM Postgres). A thin driver binding over the shared
// Postgres-dialect body in pgbase.ts — PGlite and the standalone Postgres adapter run the
// SAME SQL, so all logic lives once in `PgSqlAdapter`. Single-connection, so takes serialize
// in-process; the checked compare-and-set that decides a contended claim on a real server is
// therefore never actually contended here — it cannot validate the concurrent path.

import { PGlite } from "@electric-sql/pglite";
import { NOW_SQL, PgSqlAdapter, type Sql, type SqlBackend, type SqlResult } from "./pgbase.ts";
import type { RawRow } from "./row.ts";

/** Wrap PGlite to the SqlBackend port. PGlite's result shape ({rows, affectedRows}) and
 *  transaction/exec APIs already match; this just narrows the types. */
class PgliteBackend implements SqlBackend {
  #db?: PGlite;

  /** @param dataDir omit or `memory://` for an in-memory database. */
  constructor(private readonly dataDir?: string) {}

  init(): Promise<void> {
    this.#db = new PGlite(this.dataDir);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    await this.#db?.close();
    this.#db = undefined;
  }

  exec(ddl: string): Promise<void> {
    return this.db.exec(ddl).then(() => {});
  }

  async query<T = RawRow>(text: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const r = await this.db.query<T>(text, params);
    return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
  }

  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      fn({
        query: async <U>(text: string, params: unknown[] = []) => {
          const r = await tx.query<U>(text, params);
          return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
        },
      })
    ) as Promise<T>;
  }

  async now(): Promise<string> {
    const r = await this.db.query<{ now: string }>(NOW_SQL);
    return r.rows[0].now;
  }

  private get db(): PGlite {
    if (!this.#db) throw new Error("PgliteBackend not initialized");
    return this.#db;
  }
}

export class PgliteAdapter extends PgSqlAdapter {
  /** @param dataDir omit or `memory://` for an in-memory database. */
  constructor(dataDir?: string) {
    super("pglite", new PgliteBackend(dataDir));
  }
}
