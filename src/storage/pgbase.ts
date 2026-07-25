// Shared Postgres-dialect adapter body. Both the embedded PGlite adapter (WASM Postgres) and
// the standalone Postgres adapter speak the SAME SQL — the only difference is the driver — so
// the entire StorageAdapter implementation lives here once, parameterized over a minimal SQL
// port (`SqlBackend`). Each backend wraps its driver to that port; drift between the two is
// impossible because there is only one copy of the logic (and the conformance suite runs both).
//
// The SQLite adapter is deliberately NOT built on this base: it needs a different dialect
// (`?` placeholders, 0/1 booleans, its own transaction API), so it maps `row.ts` directly.

import {
  type AckResult,
  type CompiledMatch,
  type Envelope,
  type EventInput,
  type IdempotencyKey,
  type KindStateCount,
  type LeaseRef,
  type LeaseSpec,
  type PutInput,
  type PutResult,
  type RadiaRecord,
  type RenewResult,
  type SettleResult,
  type SpaceEvent,
  type StorageAdapter,
  type TakeResult,
  type TakeSelector,
} from "./adapter.ts";
import {
  pgPlaceholders,
  type RawRow,
  RECORD_COLUMN_COUNT,
  RECORD_COLUMNS,
  recordInsertValues,
  rowToEnvelope,
  rowToEvent,
  rowToRecord,
  runtimeInsertValues,
} from "./row.ts";
import { firstByOrder, matchesRecord, orderRecords } from "../core/matching.ts";
import { type Candidate, rankClaimable } from "../core/take.ts";
import { addSeconds, minIso } from "../core/time.ts";
import { newUlid } from "../core/ids.ts";
import { RadiaError } from "../core/errors.ts";

/** Result of a SQL statement: the rows and (for writes) the number of rows affected. */
export interface SqlResult<T> {
  rows: T[];
  affectedRows: number;
}

/** A statement executor — either the backend itself (autocommit) or a transaction handle. */
export interface Sql {
  query<T = RawRow>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
}

/** The minimal driver port the shared adapter body runs on. A backend adapts its concrete
 *  driver (PGlite, deno-postgres, …) to this; the adapter logic never sees the driver. */
export interface SqlBackend extends Sql {
  /** Run `fn` inside a single transaction on one connection; commit on success, roll back on throw. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** Run schema DDL (may be multiple statements). */
  exec(ddl: string): Promise<void>;
  /** The DB clock, ISO 8601 UTC (INVARIANT: all lease/timing math uses this). */
  now(): Promise<string>;
  /** Open the backend (connect / instantiate); does NOT create tables — the base runs DDL. */
  init(): Promise<void>;
  close(): Promise<void>;
}

const CANDIDATE_COLS =
  "r.*, rt.record_id, rt.state, rt.attempt, rt.available_at, rt.claim_until, " +
  "rt.effective_priority, rt.lease_id, rt.lease_epoch, rt.lease_owner, rt.leased_until, " +
  "rt.lease_hard_deadline";

/** The DB clock as ISO 8601 UTC. Shared so the backends' `now()` and the in-transaction
 *  `txNow` read it identically. */
export const NOW_SQL =
  "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as now";

/** Schema DDL, portable across PGlite and Postgres. Idempotent — but note that `create table if
 *  not exists` only ever creates: it does NOT reshape a table that already exists. Any column
 *  added after the initial schema therefore also needs an `alter table ... add column if not
 *  exists` in the migrations block at the end, or databases created by an older build keep the
 *  old shape and fail at query time. */
export const DDL = `
create table if not exists records (
  id text primary key,
  kind text not null,
  body_json text not null,
  body_sha256 text not null,
  client_meta text,
  created_by text not null,
  delegation_context text,
  parent_ids text not null default '[]',
  taint boolean not null default false,
  schema_version integer not null,
  created_at text not null,
  deadline_at text,
  retention_until text
);
create table if not exists record_runtime (
  record_id text primary key references records(id),
  kind text not null,
  state text not null,
  attempt integer not null default 0,
  available_at text not null,
  claim_until text,
  deadline_at text,
  effective_priority integer not null default 0,
  lease_id text,
  lease_epoch integer,
  lease_owner text,
  leased_until text,
  lease_hard_deadline text
);
create index if not exists idx_runtime_claim
  on record_runtime (kind, available_at, effective_priority desc, record_id)
  where state = 'available';
create table if not exists idempotency (
  principal text not null,
  operation text not null,
  idem_key text not null,
  request_hash text not null,
  response_json text not null,
  created_at text not null default '',
  primary key (principal, operation, idem_key)
);
create table if not exists events (
  seq bigint generated always as identity primary key,
  xid xid8 not null default pg_current_xact_id(),
  id text not null,
  ts text not null,
  run_id text not null,
  operation text not null,
  record_id text,
  kind text,
  state text,
  detail text
);

-- migrations: columns added after the initial schema. No-ops on a database the CREATEs above
-- just built, so the only path that needs them is a database from an older build.
-- events.xid is the gap-safe watch cursor. Without it every getEvents (watch SSE and
-- /v0/ops/events) fails with 'column "xid" does not exist'. The default is volatile, so
-- Postgres rewrites the table and stamps all pre-existing rows with this ALTER's own xid:
-- they sort before every later event, keeping their relative seq order, which is the
-- correct history.
alter table events add column if not exists xid xid8 not null default pg_current_xact_id();
`;

/** Internal signal: a concurrent op committed the same idempotency key first. Caught by
 *  `withRetry`, which rolls back this attempt and replays the winner's stored response. Never
 *  surfaces to callers. */
class IdempotencyReplay extends Error {}

/**
 * The full StorageAdapter, in Postgres SQL, over a `SqlBackend`. `take` uses
 * `FOR UPDATE SKIP LOCKED` when the backend is a real server (concurrent claims race for the
 * row lock, exactly one wins); on the single-connection embedded backend the same statement
 * serializes in-process — the same contract either way.
 */
export class PgSqlAdapter implements StorageAdapter {
  constructor(readonly name: string, protected readonly sql: SqlBackend) {}

  async init(): Promise<void> {
    await this.sql.init();
    await this.sql.exec(DDL);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  now(): Promise<string> {
    return this.sql.now();
  }

  async put(input: PutInput): Promise<PutResult> {
    return await this.txIdem(input.idempotency, async (tx) => {
      await this.insertRecord(tx, input);
      await this.appendEvent(tx, {
        runId: input.record.runtimeMeta.createdBy,
        operation: "put",
        recordId: input.record.id,
        kind: input.record.kind,
        state: "available",
      }, input.envelope.availableAt);
      return { id: input.record.id, deduped: false };
    });
  }

  async readOne(match: CompiledMatch): Promise<RadiaRecord | null> {
    // Fetch by kind, filter + order with the core oracle. Predicate pushdown onto
    // per-kind expression indexes is a tracked follow-up; the oracle defines correctness.
    const res = await this.sql.query<RawRow>("select * from records where kind = $1", [match.kind]);
    const matches = res.rows.map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    return firstByOrder(matches, match.orderBy);
  }

  async query(match: CompiledMatch, limit: number): Promise<RadiaRecord[]> {
    const res = await this.sql.query<RawRow>("select * from records where kind = $1", [match.kind]);
    const matches = res.rows.map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    return orderRecords(matches, match.orderBy).slice(0, limit);
  }

  async stats(): Promise<KindStateCount[]> {
    const res = await this.sql.query<RawRow>(
      "select kind, state, count(*)::int as count from record_runtime group by kind, state order by kind, state",
    );
    return res.rows.map((r) => ({
      kind: String(r.kind),
      state: String(r.state) as KindStateCount["state"],
      count: Number(r.count),
    }));
  }

  async take(selector: TakeSelector, spec: LeaseSpec): Promise<TakeResult | null> {
    return await this.sql.transaction(async (tx) => {
      const now = await this.txNow(tx);
      const candidates = await this.fetchCandidates(tx, selector);
      const template = "template" in selector ? selector.template : undefined;
      const ranked = rankClaimable(candidates, template, now, spec.requireUntainted);

      for (const cand of ranked) {
        const id = cand.record.id;
        const epoch = (cand.env.leaseEpoch ?? 0) + 1;
        const leasedUntil = addSeconds(now, spec.leaseSeconds);
        const hardDeadline = addSeconds(now, spec.maxCumulativeSeconds);

        if (cand.how === "expired") {
          const newAttempt = cand.env.attempt + 1;
          if (newAttempt > spec.maxAttempts) {
            await tx.query(
              "update record_runtime set state='dead_letter', lease_id=null where record_id=$1 and state='leased' and lease_epoch=$2",
              [id, cand.env.leaseEpoch],
            );
            await this.appendEvent(tx, {
              runId: spec.ownerRun,
              operation: "expire",
              recordId: id,
              kind: cand.record.kind,
              state: "dead_letter",
            }, now);
            continue;
          }
          await tx.query(
            `update record_runtime set state='leased', attempt=$1, lease_id=$2, lease_epoch=$3,
               lease_owner=$4, leased_until=$5, lease_hard_deadline=$6
             where record_id=$7 and state='leased' and lease_epoch=$8`,
            [newAttempt, spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id, cand.env.leaseEpoch],
          );
        } else {
          await tx.query(
            `update record_runtime set state='leased', lease_id=$1, lease_epoch=$2,
               lease_owner=$3, leased_until=$4, lease_hard_deadline=$5
             where record_id=$6 and state='available'`,
            [spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id],
          );
        }
        await this.appendEvent(tx, {
          runId: spec.ownerRun,
          operation: "take",
          recordId: id,
          kind: cand.record.kind,
          state: "leased",
          detail: { leaseId: spec.leaseId, epoch, reclaimed: cand.how === "expired" },
        }, now);
        return {
          record: cand.record,
          lease: { leaseId: spec.leaseId, epoch, ownerRun: spec.ownerRun, recordId: id, expiresAt: leasedUntil },
        };
      }
      return null;
    });
  }

  async renew(ref: LeaseRef, leaseSeconds: number, idem?: IdempotencyKey): Promise<RenewResult> {
    return await this.txIdem(idem, async (tx): Promise<RenewResult> => {
      const now = await this.txNow(tx);
      const row = await this.fetchEnvelopeRow(tx, ref.recordId);
      if (!this.leaseValid(row, ref)) return { status: "lease_lost" };
      const hard = row!.lease_hard_deadline != null ? String(row!.lease_hard_deadline) : undefined;
      if (hard !== undefined && now >= hard) return { status: "lease_lost" };
      const wanted = addSeconds(now, leaseSeconds);
      const until = hard !== undefined ? minIso(wanted, hard) : wanted;
      await tx.query(
        "update record_runtime set leased_until=$1 where record_id=$2 and lease_id=$3 and lease_epoch=$4",
        [until, ref.recordId, ref.leaseId, ref.epoch],
      );
      return {
        status: "ok",
        lease: { leaseId: ref.leaseId, epoch: ref.epoch, ownerRun: String(row!.lease_owner), recordId: ref.recordId, expiresAt: until },
      };
    });
  }

  async ack(ref: LeaseRef, result?: PutInput, idem?: IdempotencyKey): Promise<AckResult> {
    return await this.txIdem(idem, async (tx): Promise<AckResult> => {
      const now = await this.txNow(tx);
      const row = await this.fetchEnvelopeRow(tx, ref.recordId);
      if (!this.leaseValid(row, ref)) return { status: "lease_lost" };
      if (result) await this.insertRecord(tx, result);
      await tx.query(
        "update record_runtime set state='consumed', lease_id=null where record_id=$1 and lease_id=$2 and lease_epoch=$3",
        [ref.recordId, ref.leaseId, ref.epoch],
      );
      await this.appendEvent(tx, {
        runId: String(row!.lease_owner),
        operation: "ack",
        recordId: ref.recordId,
        kind: String(row!.kind),
        state: "consumed",
        detail: result ? { resultId: result.record.id } : undefined,
      }, now);
      return { status: "ok", resultId: result?.record.id };
    });
  }

  async nack(ref: LeaseRef, backoffSeconds: number, maxAttempts: number, idem?: IdempotencyKey): Promise<SettleResult> {
    return await this.txIdem(idem, async (tx): Promise<SettleResult> => {
      const now = await this.txNow(tx);
      const row = await this.fetchEnvelopeRow(tx, ref.recordId);
      if (!this.leaseValid(row, ref)) return { status: "lease_lost" };
      const newAttempt = Number(row!.attempt) + 1;
      if (newAttempt > maxAttempts) {
        await tx.query(
          "update record_runtime set state='dead_letter', attempt=$1, lease_id=null where record_id=$2 and lease_id=$3 and lease_epoch=$4",
          [newAttempt, ref.recordId, ref.leaseId, ref.epoch],
        );
      } else {
        await tx.query(
          "update record_runtime set state='available', attempt=$1, available_at=$2, lease_id=null where record_id=$3 and lease_id=$4 and lease_epoch=$5",
          [newAttempt, addSeconds(now, backoffSeconds), ref.recordId, ref.leaseId, ref.epoch],
        );
      }
      await this.appendEvent(tx, {
        runId: String(row!.lease_owner),
        operation: "nack",
        recordId: ref.recordId,
        kind: String(row!.kind),
        state: newAttempt > maxAttempts ? "dead_letter" : "available",
        detail: { attempt: newAttempt },
      }, now);
      return { status: "ok" };
    });
  }

  async release(ref: LeaseRef, idem?: IdempotencyKey): Promise<SettleResult> {
    return await this.txIdem(idem, async (tx): Promise<SettleResult> => {
      const now = await this.txNow(tx);
      const row = await this.fetchEnvelopeRow(tx, ref.recordId);
      if (!this.leaseValid(row, ref)) return { status: "lease_lost" };
      await tx.query(
        "update record_runtime set state='available', available_at=$1, lease_id=null where record_id=$2 and lease_id=$3 and lease_epoch=$4",
        [now, ref.recordId, ref.leaseId, ref.epoch],
      );
      await this.appendEvent(tx, {
        runId: String(row!.lease_owner),
        operation: "release",
        recordId: ref.recordId,
        kind: String(row!.kind),
        state: "available",
      }, now);
      return { status: "ok" };
    });
  }

  async getEnvelope(recordId: string): Promise<Envelope | null> {
    const res = await this.sql.query<RawRow>("select * from record_runtime where record_id = $1", [recordId]);
    return res.rows.length ? rowToEnvelope(res.rows[0]) : null;
  }

  async getRecord(recordId: string): Promise<RadiaRecord | null> {
    const res = await this.sql.query<RawRow>("select * from records where id = $1", [recordId]);
    return res.rows.length ? rowToRecord(res.rows[0]) : null;
  }

  async childrenOf(recordId: string): Promise<RadiaRecord[]> {
    // parent_ids is a JSON text array of quoted ids; a LIKE on `"<id>"` finds children.
    const res = await this.sql.query<RawRow>("select * from records where parent_ids like $1", [`%"${recordId}"%`]);
    return res.rows.map(rowToRecord);
  }

  async getEvents(afterCursor: string, limit: number): Promise<SpaceEvent[]> {
    // Cursor is the inserting xid (as a decimal string), not seq. The watermark
    // `xid < pg_snapshot_xmin(...)` withholds events whose transaction (or any older one) may
    // still be in flight, so ordering by (xid, seq) is gap-free: every xid falls in exactly one
    // (cursor, watermark] window as the watermark advances, and a low-seq/high-xid straggler that
    // commits late is delivered then, not skipped.
    const after = afterCursor && afterCursor.length > 0 ? afterCursor : "0";
    const res = await this.sql.query<RawRow>(
      `select seq, xid::text as cursor, id, ts, run_id, operation, record_id, kind, state, detail
       from events
       where xid > $1::text::xid8 and xid < pg_snapshot_xmin(pg_current_snapshot())
       order by xid, seq asc limit $2`,
      [after, limit],
    );
    return res.rows.map(rowToEvent);
  }

  async latestCursor(): Promise<string> {
    // Fresh-watch cursor: the current watermark, so only future events are delivered. Everything
    // already committed (xid < xmin) is "already happened" and excluded by `xid > cursor`.
    const res = await this.sql.query<{ cursor: string }>(
      "select (pg_snapshot_xmin(pg_current_snapshot())::text::numeric - 1)::text as cursor",
    );
    return String(res.rows[0].cursor);
  }

  async envelopesInState(state: string, limit: number, excludeKinds?: string[]): Promise<Envelope[]> {
    const params: unknown[] = [state];
    let where = "state = $1";
    if (excludeKinds && excludeKinds.length > 0) {
      const ph = excludeKinds.map((_, i) => `$${params.length + i + 1}`).join(", ");
      where += ` and kind not in (${ph})`;
      params.push(...excludeKinds);
    }
    params.push(limit);
    const res = await this.sql.query<RawRow>(
      `select * from record_runtime where ${where} order by available_at limit $${params.length}`,
      params,
    );
    return res.rows.map(rowToEnvelope);
  }

  async adminTransition(
    recordId: string,
    fromStates: string[],
    toState: string,
    opts: { now: string; bumpAttempt?: boolean; onlyExpired?: boolean },
  ): Promise<boolean> {
    const inList = fromStates.map((s) => `'${s}'`).join(","); // fixed enum, no injection
    const sets = [`state = '${toState}'`, "lease_id = null"];
    const params: unknown[] = [];
    if (opts.bumpAttempt) sets.push("attempt = attempt + 1");
    if (toState === "available") {
      params.push(opts.now);
      sets.push(`available_at = $${params.length}`);
    }
    params.push(recordId);
    let where = `record_id = $${params.length} and state in (${inList})`;
    if (opts.onlyExpired) {
      params.push(opts.now);
      where += ` and leased_until < $${params.length}`;
    }
    return await this.sql.transaction(async (tx) => {
      const res = await tx.query(`update record_runtime set ${sets.join(", ")} where ${where}`, params);
      if (res.affectedRows === 0) return false;
      const kr = await tx.query<{ kind: string }>("select kind from record_runtime where record_id = $1", [recordId]);
      await this.appendEvent(tx, {
        runId: "admin",
        operation: "admin",
        recordId,
        kind: kr.rows[0]?.kind,
        state: toState as Envelope["state"],
        detail: { from: fromStates },
      }, opts.now);
      return true;
    });
  }

  async quarantineLeasesOf(ownerRun: string, now: string): Promise<number> {
    return await this.sql.transaction(async (tx) => {
      const held = (await tx.query<{ record_id: string; kind: string }>(
        "select record_id, kind from record_runtime where state='leased' and lease_owner=$1",
        [ownerRun],
      )).rows;
      if (held.length === 0) return 0;
      await tx.query(
        `update record_runtime set state='available', available_at=$1, attempt=attempt+1,
           lease_epoch=lease_epoch+1, lease_id=null
         where state='leased' and lease_owner=$2`,
        [now, ownerRun],
      );
      for (const r of held) {
        await this.appendEvent(tx, {
          runId: "admin",
          operation: "quarantine",
          recordId: r.record_id,
          kind: r.kind,
          state: "available",
          detail: { ownerRun },
        }, now);
      }
      return held.length;
    });
  }

  private async appendEvent(tx: Sql, e: EventInput, ts: string): Promise<void> {
    await tx.query(
      "insert into events (id, ts, run_id, operation, record_id, kind, state, detail) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [newUlid(), ts, e.runId, e.operation, e.recordId ?? null, e.kind ?? null, e.state ?? null, e.detail ? JSON.stringify(e.detail) : null],
    );
  }

  private async fetchCandidates(tx: Sql, selector: TakeSelector): Promise<Candidate[]> {
    const rows = "recordId" in selector
      ? (await tx.query<RawRow>(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.id=$1 and rt.state in ('available','leased') for update of rt skip locked`,
        [selector.recordId],
      )).rows
      : (await tx.query<RawRow>(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.kind=$1 and rt.state in ('available','leased') for update of rt skip locked`,
        [selector.template.kind],
      )).rows;
    return rows.map((row) => ({ record: rowToRecord(row), env: rowToEnvelope(row) }));
  }

  private async fetchEnvelopeRow(tx: Sql, recordId: string): Promise<RawRow | null> {
    const res = await tx.query<RawRow>("select * from record_runtime where record_id = $1", [recordId]);
    return res.rows[0] ?? null;
  }

  private async insertRecord(tx: Sql, input: PutInput): Promise<void> {
    const parents = input.record.runtimeMeta.parentIds;
    if (parents.length > 0) {
      // One round-trip regardless of parent count (was one SELECT per parent).
      const res = await tx.query<{ id: string }>("select id from records where id = any($1::text[])", [parents]);
      const found = new Set(res.rows.map((r) => String(r.id)));
      for (const pid of parents) {
        if (!found.has(pid)) throw new RadiaError("parent_not_found", `parent ${pid} does not exist`);
      }
    }
    await tx.query(
      `insert into records (${RECORD_COLUMNS}) values (${pgPlaceholders(RECORD_COLUMN_COUNT)})`,
      recordInsertValues(input),
    );
    await tx.query(
      `insert into record_runtime
         (record_id, kind, state, attempt, available_at, claim_until, deadline_at, effective_priority)
       values ($1, $2, 'available', 0, $3, $4, $5, $6)`,
      runtimeInsertValues(input),
    );
  }

  // Run a state-changing op in a transaction with idempotency + concurrent-insert replay.
  private txIdem<T>(idem: IdempotencyKey | undefined, body: (tx: Sql) => Promise<T>): Promise<T> {
    return this.withRetry(() => this.sql.transaction((tx) => this.withIdem(tx, idem, () => body(tx))));
  }

  // The DB clock, read on the transaction's OWN connection — so a settle op is one connection and
  // one round-trip is saved versus a separate pre-transaction `now()` acquire.
  private async txNow(tx: Sql): Promise<string> {
    const r = await tx.query<{ now: string }>(NOW_SQL);
    return r.rows[0].now;
  }

  // Idempotency wrapper. Runs INSIDE the op's transaction and checks the stored response
  // BEFORE the effect (which includes lease validation), so a retry replays the original
  // outcome. A key reused with a different request is a conflict.
  private async withIdem<T>(tx: Sql, idem: IdempotencyKey | undefined, run: () => Promise<T>): Promise<T> {
    if (!idem) return run();
    const found = await tx.query<RawRow>(
      "select request_hash, response_json from idempotency where principal=$1 and operation=$2 and idem_key=$3",
      [idem.principal, idem.operation, idem.key],
    );
    if (found.rows.length) {
      if (String(found.rows[0].request_hash) !== idem.requestHash) {
        throw new RadiaError("idempotency_conflict", "idempotency key reused with a different request");
      }
      return JSON.parse(String(found.rows[0].response_json)) as T;
    }
    const result = await run();
    // With pooled connections, concurrent same-key ops all reach here (their SELECTs all saw
    // nothing). ON CONFLICT DO NOTHING makes exactly one win; a loser (0 rows) throws
    // IdempotencyReplay, which rolls this attempt back (discarding its effect) so withRetry
    // re-runs and the SELECT above replays the winner's stored response. On single-connection
    // embedded backends there is no race, so this always inserts (1 row).
    const ins = await tx.query(
      `insert into idempotency (principal, operation, idem_key, request_hash, response_json)
       values ($1,$2,$3,$4,$5) on conflict (principal, operation, idem_key) do nothing`,
      [idem.principal, idem.operation, idem.key, idem.requestHash, JSON.stringify(result)],
    );
    if (ins.affectedRows === 0) throw new IdempotencyReplay();
    return result;
  }

  // Re-run an idempotent op that lost the insert race (its transaction rolled back), so the
  // replay reads the now-committed response. Bounded; only IdempotencyReplay is retried — a
  // real error (including idempotency_conflict) propagates.
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof IdempotencyReplay && attempt < 5) continue;
        throw e;
      }
    }
  }

  private leaseValid(row: RawRow | null, ref: LeaseRef): boolean {
    return row !== null &&
      row.state === "leased" &&
      String(row.lease_id) === ref.leaseId &&
      Number(row.lease_epoch) === ref.epoch;
  }
}
