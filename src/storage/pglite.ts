// Embedded adapter: PGlite (WASM Postgres). A thin driver binding over the shared
// Postgres-dialect body in pgbase.ts. PGlite and the standalone Postgres adapter run the
// SAME SQL, so all logic lives once in `PgSqlAdapter`. Single-connection, so takes serialize
// in-process; the checked compare-and-set that decides a contended claim on a real server is
// therefore never actually contended here, so it cannot validate the concurrent path.
//
// Like the standalone adapter, an optional `schema` confines a run to its own namespace and
// `instance` runs on a PGlite somebody else booted. Both exist for the conformance harness, where
// booting one WASM Postgres per test dominated the run (~300ms of boot around single-digit ms of
// work); see `PgliteOptions.instance` for the one rule a shared instance imposes.

import { PGlite } from "@electric-sql/pglite";
import { NOW_SQL, PgSqlAdapter, type Sql, type SqlBackend, type SqlResult } from "./pgbase.ts";
import type { RawRow } from "./row.ts";

export interface PgliteOptions {
  /** Confine all tables to this schema (set as `search_path` on the connection). */
  schema?: string;
  /** Create the schema on init and DROP ... CASCADE on close (test/ephemeral use). */
  ephemeral?: boolean;
  /**
   * Run on an EXISTING PGlite rather than booting one. The caller owns it: `close()` drops this
   * adapter's ephemeral schema and leaves the instance running.
   *
   * PGlite is a single connection, and `search_path` is state on that connection, so two adapters
   * sharing an instance must not have statements in flight at the same time. Sequential use (a
   * test at a time) is what this is for; concurrent use wants separate instances.
   */
  instance?: PGlite;
}

/** Which schema each shared instance is currently pinned to, so re-pinning is skipped when it
 *  would be a no-op (the common case: one adapter at a time). Keyed weakly: an instance the
 *  caller closes and drops must not be held alive by this. */
const pinnedSchema = new WeakMap<PGlite, string>();

/** Wrap PGlite to the SqlBackend port. PGlite's result shape ({rows, affectedRows}) and
 *  transaction/exec APIs already match; this just narrows the types. */
class PgliteBackend implements SqlBackend {
  #db?: PGlite;
  #owned = true;
  readonly #schema?: string;
  readonly #ephemeral: boolean;
  readonly #instance?: PGlite;

  /** @param dataDir omit or `memory://` for an in-memory database. */
  constructor(private readonly dataDir?: string, opts: PgliteOptions = {}) {
    this.#schema = opts.schema;
    this.#ephemeral = opts.ephemeral ?? false;
    this.#instance = opts.instance;
  }

  async init(): Promise<void> {
    if (this.#instance) {
      this.#db = this.#instance;
      this.#owned = false;
    } else {
      this.#db = new PGlite(this.dataDir);
    }
    if (this.#schema && this.#ephemeral) {
      // Before the pin: the schema has to exist to be searched.
      await this.db.exec(`create schema if not exists "${this.#schema}"`);
    }
    await this.#pin();
  }

  async close(): Promise<void> {
    if (!this.#db) return;
    if (this.#schema && this.#ephemeral) {
      await this.#pin();
      await this.db.exec(`drop schema if exists "${this.#schema}" cascade`);
      if (pinnedSchema.get(this.db) === this.#schema) pinnedSchema.delete(this.db);
    }
    if (this.#owned) await this.db.close();
    this.#db = undefined;
  }

  async exec(ddl: string): Promise<void> {
    await this.#pin();
    await this.db.exec(ddl);
  }

  async query<T = RawRow>(text: string, params: unknown[] = []): Promise<SqlResult<T>> {
    await this.#pin();
    const r = await this.db.query<T>(text, params);
    return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    await this.#pin();
    return await this.db.transaction((tx) =>
      fn({
        query: async <U>(text: string, params: unknown[] = []) => {
          const r = await tx.query<U>(text, params);
          return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
        },
      })
    ) as Promise<T>;
  }

  async now(): Promise<string> {
    const r = await this.query<{ now: string }>(NOW_SQL);
    return r.rows[0].now;
  }

  /** Point the connection at this adapter's schema, unless it already is. A no-op for the
   *  unconfined case, which is every non-test deployment. */
  async #pin(): Promise<void> {
    if (!this.#schema) return;
    if (pinnedSchema.get(this.db) === this.#schema) return;
    await this.db.exec(`set search_path to "${this.#schema}"`);
    pinnedSchema.set(this.db, this.#schema);
  }

  private get db(): PGlite {
    if (!this.#db) throw new Error("PgliteBackend not initialized");
    return this.#db;
  }
}

export class PgliteAdapter extends PgSqlAdapter {
  /**
   * @param dataDir omit or `memory://` for an in-memory database.
   * @param opts    optional schema confinement / shared instance (see PgliteOptions).
   */
  constructor(dataDir?: string, opts: PgliteOptions = {}) {
    super("pglite", new PgliteBackend(dataDir, opts));
  }
}
