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
  type CmpOp,
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
import { isTrivial, type JsonDialect, pushdown } from "./pushdown.ts";
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

/** Every column of `records` EXCEPT the generated `body_jsonb`. Never `select *` from this table:
 *  `body_jsonb` is a second, larger copy of the body that exists only so the DATABASE can filter
 *  on it, and shipping it to the runtime would cost more than pushdown saves. `rowToRecord`
 *  ignores unknown columns, so a wildcard would fail silently — as bytes on the wire, not as an
 *  error. */
const RECORD_COLS = "id, kind, body_json, body_sha256, client_meta, created_by, delegation_context, " +
  "parent_ids, taint, schema_version, created_at, deadline_at, retention_until";

const RECORD_COLS_R = RECORD_COLS.split(", ").map((c) => `r.${c}`).join(", ");

const CANDIDATE_COLS = `${RECORD_COLS_R}, rt.record_id, rt.state, rt.attempt, rt.available_at, rt.claim_until, ` +
  "rt.effective_priority, rt.lease_id, rt.lease_epoch, rt.lease_owner, rt.leased_until, " +
  "rt.lease_hard_deadline";

/** The DB clock as ISO 8601 UTC. Shared so the backends' `now()` and the in-transaction
 *  `txNow` read it identically. */
/** Claim order, identical to `rankClaimable`'s: highest priority, then oldest eligible, then id.
 *  The window is only safe to bound because SQL sorts by the same key the ranker does — the head
 *  of this ordering IS the winner the unbounded scan would have picked. Ordering also gives every
 *  claimer the same traversal, so two transactions cannot deadlock updating rows in opposite
 *  orders. */
const CLAIM_ORDER = "order by rt.effective_priority desc, rt.available_at asc, r.id asc";

/** How many candidates one claim examines at a time. `take` used to fetch — and row-lock — EVERY
 *  available-or-leased record of the kind, which made a claim O(kind size) and, worse, let one
 *  claimer's open transaction hide the whole queue from everyone else (`skip locked` finds nothing
 *  unlocked, so a peer is told "empty" while work remains). A template with a selective match
 *  pages through further windows rather than truncating. */
const CANDIDATE_WINDOW = 64;

export const NOW_SQL =
  "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as now";

/** Schema DDL, portable across PGlite and Postgres. Idempotent — but note that `create table if
 *  not exists` only ever creates: it does NOT reshape a table that already exists. Any column
 *  added after the initial schema therefore also needs an `alter table ... add column if not
 *  exists` in the migrations block at the end, or databases created by an older build keep the
 *  old shape and fail at query time.
 *
 *  NOTE: this is a template literal — a backtick anywhere inside, including in a `-- comment`,
 *  ends the string and produces a wall of TS syntax errors pointing at the SQL. Quote identifiers
 *  in comments some other way. */
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
-- The claim window's ordering, column for column. Two things make this index and not the one
-- above the one a claim uses, and both are easy to get wrong: the columns must be in the ORDER
-- BY's order (priority leads, not available_at), and state must NOT appear before them — an
-- index on (kind, state, ...) can satisfy state in ('available','leased') but only sorts WITHIN
-- each state, so the database still sorts the whole set and the index buys nothing. Measured:
-- adding the state-first version changed a claim by 1.4ms; this one took it from 19.5ms to 0.8ms
-- at 40k records, by turning a full scan of the envelope table into an ordered seek that stops
-- once the window is full.
create index if not exists idx_runtime_claim_order
  on record_runtime (kind, effective_priority desc, available_at asc, record_id asc);
-- The lineage DAG's edges, one row per (parent, child). records.parent_ids stays the source of
-- truth — this table is a derived REVERSE index, because parent_ids answers "who are my parents"
-- for free and "who are my children" only by scanning every record. Written in the same
-- transaction as the record, so it cannot lag; rebuilt from parent_ids by the backfill below.
create table if not exists record_edges (
  parent_id text not null,
  child_id text not null,
  primary key (parent_id, child_id)
);
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
-- records.body_jsonb is the parsed form of body_json, for predicate pushdown. GENERATED, so it
-- cannot drift from the text the record actually committed with, and no write path has to know it
-- exists. Without it every pushed predicate would re-parse the body text once per row per
-- comparison, which costs more than the scan it replaces. Postgres backfills existing rows on the
-- ALTER; the cast is immutable, which is what makes it legal in a generated column.
alter table records add column if not exists body_jsonb jsonb generated always as (body_json::jsonb) stored;
-- One GIN index serves equality on EVERY path, so a kind declaring a new indexed path needs no
-- DDL and no migration — which is what keeps kinds-as-records from dragging a schema change
-- behind it. jsonb_path_ops (rather than the default operator class) indexes hashed path/value
-- pairs: smaller, faster to search, and it supports exactly the one operator pushdown emits, @>.
-- Range predicates cannot use it and still scan.
create index if not exists idx_records_body_gin on records using gin (body_jsonb jsonb_path_ops);
-- Record ids under BYTE order, which is what the oracle's id tie-break means (a JS string
-- comparison). The primary key index sorts under the database's collation instead, and a
-- linguistic collation is free to order the same ids differently — so a pushed ordered limit
-- would otherwise have to sort the whole match set to be correct, and read_one could answer with
-- a different record here than on SQLite. This index is what keeps the limit cheap AND identical
-- across adapters.
create index if not exists idx_records_id_c on records (id collate "C");
-- One-time backfill of the reverse edge index for a database written by an older build. The
-- guard makes this free on every later startup: the NOT EXISTS is evaluated once, and on a
-- populated table the whole INSERT reads nothing. A space that genuinely has no edges (no record
-- ever had a parent) re-runs the scan each start, which costs one sequential scan of a table
-- whose records all have empty parent_ids.
insert into record_edges (parent_id, child_id)
  select p.value, r.id from records r, jsonb_array_elements_text(r.parent_ids::jsonb) as p
   where not exists (select 1 from record_edges)
  on conflict do nothing;
`;

const SQL_CMP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** `["a","b"], 1` -> `{a: {b: 1}}` — the containment probe for a value at a dotted path. */
function nest(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

/**
 * Postgres half of predicate pushdown (see `pushdown.ts` for the soundness contract).
 *
 * Scalar equality is a single `jsonb =`, which is already the oracle's rule for scalars: typed,
 * exact, and numerically aware (`5` equals `5.0`, and neither equals `"5"`). That does NOT extend
 * to objects and arrays — jsonb normalizes key order while the oracle compares serialized text —
 * which is why `pushdown` refuses to hand them here.
 *
 * Ordered comparison always guards on `jsonb_typeof` first. jsonb has a total order ACROSS types
 * (object > array > boolean > number > string > null), so an unguarded `>` would happily compare a
 * string to a number and match rows the oracle rejects — sound, but it would also mean the guard
 * is doing the real work, so it is stated explicitly. Numbers compare as jsonb (no cast, so no
 * chance of a cast error on a row that a reordered plan reaches before the guard); strings compare
 * as extracted text under `COLLATE "C"`, which is byte order — what `pushdown`'s ASCII-bound rule
 * assumes, and what the database's default collation would NOT give.
 */
class PgJson implements JsonDialect {
  readonly params: unknown[] = [];
  /** `offset` is how many bound parameters the enclosing statement already used; `table` qualifies
   *  the body column, required wherever more than one `records` alias is in scope. */
  constructor(private readonly offset: number, private readonly table = "") {}

  private get col(): string {
    return `${this.table ? `${this.table}.` : ""}body_jsonb`;
  }
  mark(): number {
    return this.params.length;
  }
  rollback(mark: number): void {
    this.params.length = mark;
  }
  private bind(v: unknown): string {
    this.params.push(v);
    return `$${this.offset + this.params.length}`;
  }
  /** Safe to inline: `pushablePath` has already restricted segments to `[A-Za-z0-9_]`. */
  private at(path: string[]): string {
    return `${this.col} #> '{${path.join(",")}}'`;
  }
  private text(path: string[]): string {
    return `${this.col} #>> '{${path.join(",")}}'`;
  }

  present(path: string[]): string {
    // A missing path yields SQL NULL; a JSON null yields 'null'::jsonb. The oracle needs exactly
    // that distinction, and this is the operator that preserves it.
    return `(${this.at(path)} is not null)`;
  }

  eqScalar(path: string[], value: string | number | boolean | null): string {
    // Two terms doing different jobs. `@>` is the only operator the GIN index answers, so it is
    // what turns this from a scan into a lookup — but containment is WEAKER than the oracle's
    // equality (jsonb treats a scalar as contained in an array at the same key, so {"a":["x"]}
    // contains {"a":"x"}). The `=` term restores exactness. Weaker-then-exact is the sound order:
    // the index narrows, the comparison decides.
    const contains = `${this.col} @> ${this.bind(JSON.stringify(nest(path, value)))}::jsonb`;
    const exact = value === null
      ? `jsonb_typeof(${this.at(path)}) = 'null'`
      : `${this.at(path)} = ${this.bind(JSON.stringify(value))}::jsonb`;
    return `(${contains} and ${exact})`;
  }

  cmpNumber(path: string[], op: CmpOp, value: number): string {
    return `(jsonb_typeof(${this.at(path)}) = 'number' and ${this.at(path)} ${SQL_CMP[op]} ${
      this.bind(JSON.stringify(value))
    }::jsonb)`;
  }

  cmpString(path: string[], op: CmpOp, value: string): string {
    return `(jsonb_typeof(${this.at(path)}) = 'string' and (${this.text(path)}) collate "C" ${SQL_CMP[op]} ${
      this.bind(value)
    })`;
  }
}

/** Internal signal: a concurrent op committed the same idempotency key first. Caught by
 *  `withRetry`, which rolls back this attempt and replays the winner's stored response. Never
 *  surfaces to callers. */
class IdempotencyReplay extends Error {}

/**
 * The full StorageAdapter, in Postgres SQL, over a `SqlBackend`. Single-winner claiming rests on
 * a CHECKED compare-and-set — the state transition names the state it expects, and a claimer
 * whose update affects zero rows lost the race and moves to the next candidate. That holds on a
 * real server (concurrent claims race, exactly one wins) and on the single-connection embedded
 * backend (where transactions serialize in-process anyway) — the same contract either way. A
 * take by record id additionally uses `FOR UPDATE SKIP LOCKED`, which is safe because it locks
 * exactly the one row it intends to claim; see `CANDIDATE_WINDOW` for why a template take must
 * not.
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

  /**
   * Rows of the kind that survive the SQL pre-filter — a superset of what the oracle accepts.
   *
   * `want` is how many records the caller will ultimately keep. It becomes a SQL `LIMIT` only when
   * the filter is EXACT and the caller has no `orderBy`, because only then does the database agree
   * with the oracle about both which rows match and which come first: with no `orderBy` the
   * oracle's order is `x.id < y.id`, its deterministic tie-break, which `order by id asc` matches
   * exactly. Any other case fetches everything and lets the oracle sort — see `Pushed.exact`.
   */
  private async candidateRows(match: CompiledMatch, want?: number): Promise<RawRow[]> {
    const d = new PgJson(1); // $1 is the kind
    const filter = pushdown(match.where, d);
    const where = isTrivial(filter) ? "" : ` and ${filter.sql}`;
    const bounded = want !== undefined && filter.exact && !match.orderBy?.length;
    const res = await this.sql.query<RawRow>(
      `select ${RECORD_COLS} from records where kind = $1${where}` +
        (bounded ? ` order by id collate "C" asc limit $${2 + d.params.length}` : ""),
      bounded ? [match.kind, ...d.params, want] : [match.kind, ...d.params],
    );
    return res.rows;
  }

  async readOne(match: CompiledMatch): Promise<RadiaRecord | null> {
    // SQL narrows; the core oracle decides. `pushdown` is a sound over-approximation, so this
    // filter never removes a record `matchesRecord` would have accepted.
    const matches = (await this.candidateRows(match, 1)).map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    return firstByOrder(matches, match.orderBy);
  }

  async query(match: CompiledMatch, limit: number): Promise<RadiaRecord[]> {
    const matches = (await this.candidateRows(match, limit)).map(rowToRecord).filter((rec) => matchesRecord(rec, match));
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
      const template = "template" in selector ? selector.template : undefined;
      const byId = "recordId" in selector;

      // Page through candidate windows. Single-winner no longer rests on holding a lock over the
      // whole candidate set: the claim below is a compare-and-set whose result is CHECKED, so a
      // lost race falls through to the next candidate instead of returning a lease for a record
      // somebody else already took.
      for (let offset = 0;; offset += CANDIDATE_WINDOW) {
        const candidates = await this.fetchCandidates(tx, selector, CANDIDATE_WINDOW, offset);
        if (candidates.length === 0) return null;
        const ranked = rankClaimable(candidates, template, now, spec.requireUntainted);
        const claimed = await this.claimFirst(tx, ranked, spec, now);
        if (claimed) return claimed;
        // Nothing in this window was claimable (all filtered out, or every CAS lost). A record-id
        // take has no further windows; a template take keeps paging until the kind is exhausted.
        if (byId || candidates.length < CANDIDATE_WINDOW) return null;
      }
    });
  }

  /** Try each ranked candidate in order; return the first whose compare-and-set actually wins. */
  private async claimFirst(
    tx: Sql,
    ranked: ReturnType<typeof rankClaimable>,
    spec: LeaseSpec,
    now: string,
  ): Promise<TakeResult | null> {
    {
      for (const cand of ranked) {
        const id = cand.record.id;
        const epoch = (cand.env.leaseEpoch ?? 0) + 1;
        const leasedUntil = addSeconds(now, spec.leaseSeconds);
        const hardDeadline = addSeconds(now, spec.maxCumulativeSeconds);

        if (cand.how === "expired") {
          const newAttempt = cand.env.attempt + 1;
          if (newAttempt > spec.maxAttempts) {
            const shredded = await tx.query(
              "update record_runtime set state='dead_letter', lease_id=null where record_id=$1 and state='leased' and lease_epoch=$2",
              [id, cand.env.leaseEpoch],
            );
            if (shredded.affectedRows === 0) continue; // someone else already moved it
            await this.appendEvent(tx, {
              runId: spec.ownerRun,
              operation: "expire",
              recordId: id,
              kind: cand.record.kind,
              state: "dead_letter",
            }, now);
            continue;
          }
          const won = await tx.query(
            `update record_runtime set state='leased', attempt=$1, lease_id=$2, lease_epoch=$3,
               lease_owner=$4, leased_until=$5, lease_hard_deadline=$6
             where record_id=$7 and state='leased' and lease_epoch=$8`,
            [newAttempt, spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id, cand.env.leaseEpoch],
          );
          if (won.affectedRows === 0) continue; // another claimer reclaimed it first
        } else {
          const won = await tx.query(
            `update record_runtime set state='leased', lease_id=$1, lease_epoch=$2,
               lease_owner=$3, leased_until=$4, lease_hard_deadline=$5
             where record_id=$6 and state='available'`,
            [spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id],
          );
          if (won.affectedRows === 0) continue; // it was claimed between the read and the update
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
    }
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
      if (result) {
        await this.insertRecord(tx, result);
        // The result is a new record entering the space, so it gets its own `put` event — same
        // shape as a direct put. Without it the record would exist with no `available` event of
        // its own kind, and `matchesEvent` would never wake a watcher on that kind (the ack
        // event below is `consumed` and carries the PARENT's kind). Emitted before the ack,
        // mirroring the insert-then-consume order of this transaction.
        await this.appendEvent(tx, {
          runId: result.record.runtimeMeta.createdBy,
          operation: "put",
          recordId: result.record.id,
          kind: result.record.kind,
          state: "available",
          detail: { ackOf: ref.recordId },
        }, result.envelope.availableAt);
      }
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
    // Indexed lookup through the reverse edge table. This used to be
    // `parent_ids like '%"<id>"%'` — correct (ids are ULIDs, so they carry no LIKE wildcards) but
    // a scan of every record in the space to find a handful of children.
    const res = await this.sql.query<RawRow>(
      `select ${RECORD_COLS_R} from record_edges e join records r on r.id = e.child_id
        where e.parent_id = $1 order by r.id`,
      [recordId],
    );
    return res.rows.map(rowToRecord);
  }

  async getRecords(ids: string[]): Promise<RadiaRecord[]> {
    if (ids.length === 0) return [];
    const res = await this.sql.query<RawRow>(
      `select ${RECORD_COLS} from records where id = any($1::text[])`,
      [ids],
    );
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

  private async fetchCandidates(
    tx: Sql,
    selector: TakeSelector,
    limit = CANDIDATE_WINDOW,
    offset = 0,
  ): Promise<Candidate[]> {
    const rows = "recordId" in selector
      ? (await tx.query<RawRow>(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.id=$1 and rt.state in ('available','leased') for update of rt skip locked`,
        [selector.recordId],
      )).rows
      : await this.windowRows(tx, selector, limit, offset);
    return rows.map((row) => ({ record: rowToRecord(row), env: rowToEnvelope(row) }));
  }

  /**
   * One window of claim candidates, in `rankClaimable` order.
   *
   * Pick the window from the narrow envelope table FIRST, then fetch bodies for only those rows.
   * Ordering the join instead makes the database materialize every record body of the kind before
   * the limit applies — most of the cost of a claim on a large kind.
   *
   * A template with a pushable predicate joins `records` inside that inner select so the window is
   * drawn from ROWS THAT CAN MATCH. Without it the window is the head of the queue regardless of
   * the template, so a selective take pages through the entire kind 64 rows at a time — correct,
   * but O(kind size) round trips to find one record. The filter is a sound over-approximation, so
   * `rankClaimable` still decides.
   *
   * SQLite answers this from `idx_runtime_claim_order`: an ordered seek that stops once the window
   * is full. Postgres does NOT, and cannot be talked into it by rewriting the SQL — it estimates a
   * jsonb predicate at ~26 rows when 5,715 match, so it collects every match through the body index
   * and sorts. The fix is a better ESTIMATE, not a better query: see gotchas.md, "a claim on
   * Postgres is planned on a guess".
   */
  private async windowRows(
    tx: Sql,
    selector: { template: CompiledMatch },
    limit: number,
    offset: number,
  ): Promise<RawRow[]> {
    const d = new PgJson(1, "r2"); // $1 is the kind
    const filter = pushdown(selector.template.where, d);
    const n = 1 + d.params.length;
    const inner = isTrivial(filter)
      ? `select record_id from record_runtime
          where kind=$1 and state in ('available','leased')
          order by effective_priority desc, available_at asc, record_id asc
          limit $${n + 1} offset $${n + 2}`
      : `select rt2.record_id from record_runtime rt2 join records r2 on r2.id=rt2.record_id
          where rt2.kind=$1 and rt2.state in ('available','leased') and ${filter.sql}
          order by rt2.effective_priority desc, rt2.available_at asc, rt2.record_id asc
          limit $${n + 1} offset $${n + 2}`;
    return (await tx.query<RawRow>(
      `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
         where rt.record_id in (${inner})
         ${CLAIM_ORDER}`,
      [selector.template.kind, ...d.params, limit, offset],
    )).rows;
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
    // The reverse edge, in the SAME transaction as the record — a derived index that can never
    // lag the thing it indexes. One statement regardless of parent count.
    if (parents.length > 0) {
      await tx.query(
        "insert into record_edges (parent_id, child_id) select unnest($1::text[]), $2 on conflict do nothing",
        [parents, input.record.id],
      );
    }
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
