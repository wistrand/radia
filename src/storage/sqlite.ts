// Embedded adapter: SQLite (via Deno's built-in `node:sqlite`).
//
// The lighter adapter and the real test that the port abstracts: SQLite's WAL
// single-writer concurrency, its json_extract path functions, and its lack of Postgres
// generated-column parity differ from PGlite, so any Postgres assumption that leaks into
// core/ surfaces here. Single writer, so takes serialize in-process.
//
// Uses `node:sqlite` (built into the Deno runtime) rather than an FFI package: zero
// external dependency, no native library download, and no --allow-ffi. That is the best fit for
// the minimal-deps / platform-independence invariant. (The `jsr:@db/sqlite` FFI package
// segfaulted under this Deno build; see agent_docs/gotchas.md.)

import { DatabaseSync } from "node:sqlite";
import {
  type AckResult,
  type CmpOp,
  type CompiledMatch,
  type Envelope,
  type IdempotencyKey,
  type KindStateCount,
  type LeaseRef,
  type LeaseSpec,
  type Page,
  type PutInput,
  type PutResult,
  type EventInput,
  type EventSeal,
  type RadiaRecord,
  type RenewResult,
  type SettleResult,
  type SpaceEvent,
  type StatsScope,
  type StorageAdapter,
  type TakeResult,
  type TakeSelector,
  type EventPosition,
  type EventSweepResult,
  type SweepAnchor,
  type SweepResult,
  type SweptIds,
  type SweepSelector,
  type EventHorizonCheck,
  type EnvelopeQuery,
  resolveEventHorizon,
  scanChunkSize,
  yieldToEventLoop,
} from "./adapter.ts";
import {
  qmarks,
  type RawRow,
  RECORD_COLUMN_COUNT,
  RECORD_COLUMNS,
  recordInsertValues,
  rowToEnvelope,
  rowToEvent,
  rowToRecord,
  rowToSeal,
  runtimeInsertValues,
} from "./row.ts";
import { firstByOrder, matchesRecord, orderRecords, pageClause, pageRecords } from "../core/matching.ts";
import { isTrivial, type JsonDialect, pushdown } from "./pushdown.ts";
import { type Candidate, type ClaimCursor, cursorOf, rankClaimable } from "../core/take.ts";
import { addSeconds, minIso } from "../core/time.ts";
import { newUlid } from "../core/ids.ts";
import { RadiaError, scanBudgetExceeded } from "../core/errors.ts";

/** One claim examines this many candidates at a time; a selective match pages further. */
const CANDIDATE_WINDOW = 64;

const CANDIDATE_COLS =
  "r.*, rt.record_id, rt.state, rt.attempt, rt.available_at, rt.claim_until, " +
  "rt.effective_priority, rt.lease_id, rt.lease_epoch, rt.lease_owner, rt.leased_until, " +
  "rt.lease_hard_deadline";

type SqlParam = string | number | null;

const SQL_CMP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * SQLite half of predicate pushdown (see `pushdown.ts` for the soundness contract). Presence and
 * type are always asked via `json_type`, never via the extracted value: `json_extract` returns SQL
 * NULL for BOTH an absent key and a JSON `null`, and the oracle draws a hard line between them.
 * `json_type` reports 'null' for the latter and SQL NULL for the former.
 *
 * Text comparisons ride SQLite's default BINARY collation, which is byte order: what
 * `pushdown`'s ASCII-bound rule assumes.
 */
class SqliteJson implements JsonDialect {
  readonly params: SqlParam[] = [];

  /** `table` qualifies the body column. Required wherever more than one `records` alias is in
   *  scope, as in the claim window's inner select. */
  constructor(private readonly table = "") {}

  private get col(): string {
    return `${this.table ? `${this.table}.` : ""}body_json`;
  }
  mark(): number {
    return this.params.length;
  }
  rollback(mark: number): void {
    this.params.length = mark;
  }
  private bind(v: SqlParam): string {
    this.params.push(v);
    return "?";
  }
  /** Safe to inline: `pushablePath` has already restricted segments to `[A-Za-z0-9_]`, minus
   *  all-digit ones, so `$.a.0` (a key named "0", NULL over an array here) never gets rendered. */
  private at(path: string[]): string {
    return `json_extract(${this.col}, '$.${path.join(".")}')`;
  }
  private type(path: string[]): string {
    return `json_type(${this.col}, '$.${path.join(".")}')`;
  }

  present(path: string[]): string {
    return `(${this.type(path)} is not null)`;
  }

  eqScalar(path: string[], value: string | number | boolean | null): string {
    // json_type alone settles null and booleans. SQLite extracts both JSON `true` and the number
    // 1 as integer 1, so the type check is what keeps them apart.
    if (value === null) return `(${this.type(path)} = 'null')`;
    if (typeof value === "boolean") return `(${this.type(path)} = '${value}')`;
    if (typeof value === "number") {
      return `(${this.type(path)} in ('integer','real') and ${this.at(path)} = ${this.bind(value)})`;
    }
    return `(${this.type(path)} = 'text' and ${this.at(path)} = ${this.bind(value)})`;
  }

  cmpNumber(path: string[], op: CmpOp, value: number): string {
    return `(${this.type(path)} in ('integer','real') and ${this.at(path)} ${SQL_CMP[op]} ${this.bind(value)})`;
  }

  cmpString(path: string[], op: CmpOp, value: string): string {
    return `(${this.type(path)} = 'text' and ${this.at(path)} ${SQL_CMP[op]} ${this.bind(value)})`;
  }

  /**
   * `$any`, as an EXISTS over `json_each` of the array at `path`.
   *
   * The `json_type = 'array'` guard is the semantics rather than a filter: `json_each` over a
   * scalar yields that scalar as a single row, so without it `{tags:"x"}` would satisfy
   * `{tags:{$any:"x"}}` while the oracle says false. Its `type` column carries the same
   * distinctions `json_type` does above, which is what keeps `true` apart from the number 1.
   */
  private anyWhere(path: string[], where: string): string {
    return `(${this.type(path)} = 'array' and exists (select 1 from json_each(${this.col}, '$.${path.join(".")}') je where ${where}))`;
  }

  anyEqScalar(path: string[], value: string | number | boolean | null): string {
    if (value === null) return this.anyWhere(path, `je.type = 'null'`);
    if (typeof value === "boolean") return this.anyWhere(path, `je.type = '${value}'`);
    if (typeof value === "number") {
      return this.anyWhere(path, `je.type in ('integer','real') and je.value = ${this.bind(value)}`);
    }
    return this.anyWhere(path, `je.type = 'text' and je.value = ${this.bind(value)}`);
  }

  anyCmpNumber(path: string[], op: CmpOp, value: number): string {
    return this.anyWhere(path, `je.type in ('integer','real') and je.value ${SQL_CMP[op]} ${this.bind(value)}`);
  }

  anyCmpString(path: string[], op: CmpOp, value: string): string {
    return this.anyWhere(path, `je.type = 'text' and je.value ${SQL_CMP[op]} ${this.bind(value)}`);
  }
}

// SQLite has no boolean type; taint is stored as integer 0/1.
// NOTE: this is a template literal. A backtick anywhere inside, including in a `-- comment`,
// ends the string and produces a wall of TS syntax errors pointing at the SQL.
const DDL = `
create table if not exists records (
  id text primary key,
  kind text not null,
  body_json text not null,
  body_sha256 text not null,
  client_meta text,
  created_by text not null,
  delegation_context text,
  parent_ids text not null default '[]',
  taint integer not null default 0,
  -- The labels behind the boolean above. NULLABLE on purpose: null means "written by a build that
  -- had no labels", which row.ts reads as the reserved unknown label, while an empty JSON array
  -- means "written with none".
  taint_labels text,
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
-- BY's order (priority leads, not available_at), and state must NOT appear before them. An
-- index on (kind, state, ...) can satisfy state in ('available','leased') but only sorts WITHIN
-- each state, so the database still sorts the whole set and the index buys nothing. Measured:
-- adding the state-first version changed a claim by 1.4ms; this one took it from 19.5ms to 0.8ms
-- at 40k records, by turning a full scan of the envelope table into an ordered seek that stops
-- once the window is full.
create index if not exists idx_runtime_claim_order
  on record_runtime (kind, effective_priority desc, available_at asc, record_id asc);
-- The lineage DAG's edges, one row per (parent, child). records.parent_ids stays the source of
-- truth. This table is a derived REVERSE index, because parent_ids answers "who are my parents"
-- for free and "who are my children" only by scanning every record. Written in the same
-- transaction as the record, so it cannot lag; rebuilt from parent_ids by the backfill below.
create table if not exists record_edges (
  parent_id text not null,
  child_id text not null,
  primary key (parent_id, child_id)
);
-- Credential resolution, the one lookup on the path of EVERY authenticated request. It is an
-- ordinary query (kind + an equality on tokenHash) and takes the ordinary route through pushdown,
-- so what it needs is an ordinary index -- except that Postgres serves it from the GIN index over
-- every path, and SQLite has no equivalent, so its hot path gets a physical index.
--
-- Two things about the shape, both learned by measuring rather than by reading:
--   * (kind, expr), not a partial index on the two credential kinds. SQLite cannot use a partial
--     index when the query binds the kind as a PARAMETER -- it can't prove at plan time that the
--     bound value satisfies the index predicate -- so the partial version was never chosen and
--     changed nothing. Putting kind in the index KEY works with a parameter.
--   * The expression must match what SqliteJson.at emits, character for character.
-- Measured over 3000 credential records: 1.17ms scanning, 0.012ms with this index. The ORDER BY
-- was the reason the scan was so bad -- newest-first over a filter matching one OLD row walks the
-- whole kind -- and it is also why an index on tokenHash ALONE did not help.
create index if not exists idx_records_token_hash
  on records (kind, json_extract(body_json, '$.tokenHash'));
-- What makes an exact filter's PUSHED LIMIT actually cheap, and the SQLite counterpart of
-- idx_records_id_c on the Postgres side. "where kind = ? ... order by id limit N" over the primary
-- key alone plans as USE TEMP B-TREE FOR ORDER BY: the whole kind is read and sorted before the
-- limit applies, so the limit saves nothing and read_one grows linearly with the space. With kind
-- leading and id second the same query is an ordered seek that stops at the Nth match. Measured on
-- 40k records, a predicate matching 1 in 7: 12.0ms -> 0.05ms, and flat rather than linear.
create index if not exists idx_records_kind_id on records (kind, id);
-- The retention sweep's eligibility scan. PARTIAL, because most records carry no retention at all
-- (absence means permanent), so the index holds only the sweepable minority and costs the common
-- put nothing.
create index if not exists idx_records_retention on records (retention_until) where retention_until is not null;
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
  seq integer primary key autoincrement,
  id text not null,
  ts text not null,
  run_id text not null,
  operation text not null,
  record_id text,
  kind text,
  state text,
  detail text,
  body_sha256 text
);
-- The tamper-evident chain, one row per sealed event. A separate table on purpose: hash columns
-- on the events table would mean UPDATE-ing the very table whose immutability is the thing proved.
create table if not exists event_seal (
  idx integer primary key,
  event_id text not null,
  cursor text not null,
  seq integer not null,
  hash text not null,
  prev_hash text not null,
  sig text
);
-- One-time backfill of the reverse edge index for a database written by an older build. The
-- guard makes this free on every later startup: on a populated table the NOT EXISTS short-circuits
-- and the INSERT reads nothing. A space that genuinely has no edges (no record ever had a parent)
-- re-runs the scan each start, which costs one scan of a table whose parent_ids are all empty.
insert or ignore into record_edges (parent_id, child_id)
  select p.value, r.id from records r, json_each(r.parent_ids) as p
   where not exists (select 1 from record_edges);
`;

type SqlValue = string | number | null;

/** SQLite has no boolean; map booleans to 0/1, pass everything else through. */
function toSqlValues(values: unknown[]): SqlValue[] {
  return values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v as SqlValue));
}

export class SqliteAdapter implements StorageAdapter {
  readonly name = "sqlite";
  #db?: DatabaseSync;
  /** `getRecords` statements, keyed by placeholder count. Cleared with the database. */
  #byIds = new Map<number, ReturnType<DatabaseSync["prepare"]>>();

  /** @param path `:memory:` for an in-memory database, else a file path. */
  constructor(private readonly path = ":memory:") {}

  init(): Promise<void> {
    // Re-initializing an open adapter would otherwise leak the previous connection (and, for
    // `:memory:`, silently swap in an EMPTY database while the caller believes it reconnected).
    if (this.#db) this.close();
    this.#db = new DatabaseSync(this.path);
    // WAL is a no-op for :memory: but is the intended mode for file-backed dev spaces.
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(DDL);
    this.#migrate();
    return Promise.resolve();
  }

  /**
   * Schema changes a `create table if not exists` cannot apply to an existing database.
   *
   * SQLite has no `add column if not exists`, so each one is guarded by reading the table's actual
   * columns first. Guarded rather than try/catch: swallowing an ALTER error would also swallow a
   * genuine failure, and this must be loud if the schema is not what it claims.
   *
   * Adding a column NULLABLE is what makes the migration free. A row written before labels existed
   * gets null, which `row.ts` reads as the reserved `unknown` label; back-filling a value here
   * would invent a classification the space cannot know.
   */
  #migrate(): void {
    const cols = new Set(
      (this.#db!.prepare("select name from pragma_table_info('records')").all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!cols.has("taint_labels")) this.#db!.exec("alter table records add column taint_labels text");
    // The chain's tie to record CONTENT. A pre-existing row gets null, which is honest: it was
    // written before anything captured the hash, so a chain over it proves its order and not the
    // body it refers to.
    const eventCols = new Set(
      (this.#db!.prepare("select name from pragma_table_info('events')").all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!eventCols.has("body_sha256")) this.#db!.exec("alter table events add column body_sha256 text");
    // Pre-column rows get '' (age unknown), which the idempotency sweep deliberately never touches.
    const idemCols = new Set(
      (this.#db!.prepare("select name from pragma_table_info('idempotency')").all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!idemCols.has("created_at")) this.#db!.exec("alter table idempotency add column created_at text not null default ''");
  }

  close(): Promise<void> {
    this.#byIds.clear(); // statements belong to the database being closed
    this.#db?.close();
    this.#db = undefined;
    return Promise.resolve();
  }

  now(): Promise<string> {
    // DB clock, not the host clock (adapter invariant). Millisecond-precision UTC ISO.
    const row = this.db
      .prepare("select strftime('%Y-%m-%dT%H:%M:%fZ', 'now') as now")
      .get() as { now: string };
    return Promise.resolve(row.now);
  }

  put(input: PutInput): Promise<PutResult> {
    return Promise.resolve(this.tx(() =>
      this.withIdem(input.idempotency, (): PutResult => {
        this.insertRecord(input);
        this.appendEvent({
          runId: input.record.runtimeMeta.createdBy,
          operation: input.event?.operation ?? "put",
          recordId: input.record.id,
          kind: input.record.kind,
          state: "available",
          bodySha256: input.record.bodySha256,
          ...(input.event?.detail ? { detail: input.event.detail } : {}),
        }, input.envelope.availableAt);
        return { id: input.record.id, deduped: false };
      })
    ));
  }

  async take(selector: TakeSelector, spec: LeaseSpec): Promise<TakeResult | null> {
    const now = await this.now();
    return this.tx(() => {
      const pattern = "pattern" in selector ? selector.pattern : undefined;
      const byId = "recordId" in selector;
      // The cursor is the LAST ROW EXAMINED, in claim order (see `windowRows`).
      let examined = 0;
      for (let after: ClaimCursor | undefined;;) {
        const candidates = this.fetchCandidates(selector, CANDIDATE_WINDOW, after);
        if (candidates.length === 0) return null;
        // A claim pages in windows, so it never had the memory problem `candidateMatches` had. It
        // has the other one: an unpushable pattern makes every window a window of the QUEUE rather
        // than of the matches, so the claim walks the whole kind 64 rows at a time and the ranker
        // rejects almost all of it. Same budget, same reason.
        examined += candidates.length;
        if (pattern?.scanBudget !== undefined && examined > pattern.scanBudget) {
          throw scanBudgetExceeded(pattern.kind, pattern.scanBudget);
        }
        const ranked = rankClaimable(candidates, pattern, now, spec.allowTaint, spec.createdBy);
        const claimed = this.claimFirst(ranked, spec, now);
        if (claimed) return claimed;
        // Nothing in this window was claimable (all filtered out, or every CAS lost). A record-id
        // take has no further windows; a pattern take keeps paging until the kind is exhausted.
        if (byId || candidates.length < CANDIDATE_WINDOW) return null;
        after = cursorOf(candidates[candidates.length - 1]);
      }
    });
  }

  /** Try each ranked candidate in order; return the first whose compare-and-set actually wins. */
  private claimFirst(ranked: ReturnType<typeof rankClaimable>, spec: LeaseSpec, now: string): TakeResult | null {
    {
      for (const cand of ranked) {
        const id = cand.record.id;
        const epoch = (cand.env.leaseEpoch ?? 0) + 1;
        const leasedUntil = addSeconds(now, spec.leaseSeconds);
        const hardDeadline = addSeconds(now, spec.maxCumulativeSeconds);

        if (cand.how === "expired") {
          const newAttempt = cand.env.attempt + 1;
          if (newAttempt > spec.maxAttempts) {
            if (
              this.run(
                "update record_runtime set state='dead_letter', lease_id=null where record_id=? and state='leased' and lease_epoch=?",
                [id, cand.env.leaseEpoch ?? 0],
              ) === 0
            ) continue; // someone else already moved it
            this.appendEvent({
              runId: spec.ownerRun,
              operation: "expire",
              recordId: id,
              kind: cand.record.kind,
              state: "dead_letter",
            }, now);
            continue;
          }
          const wonExpired = this.run(
            `update record_runtime set state='leased', attempt=?, lease_id=?, lease_epoch=?,
               lease_owner=?, leased_until=?, lease_hard_deadline=?
             where record_id=? and state='leased' and lease_epoch is ?`,
            // NULL-safe like the available path below, and the same binding Postgres uses, so the
            // two adapters agree on every input rather than only on the ones that occur.
            [newAttempt, spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id, cand.env.leaseEpoch ?? null],
          );
          if (wonExpired === 0) continue; // another claimer reclaimed it first
        } else {
          // The guard names everything the READ relied on, matching the Postgres adapter: with only
          // `state='available'`, a record nacked into a backoff between the read and this update
          // was claimed anyway, under a stale epoch. Single-connection here, so it is defence in
          // depth rather than a live fix — and the two adapters must agree on the claim rule or the
          // conformance suite is testing two different ones. (`is` is SQLite's null-safe equality,
          // for a record that has never been leased.)
          const won = this.run(
            `update record_runtime set state='leased', lease_id=?, lease_epoch=?,
               lease_owner=?, leased_until=?, lease_hard_deadline=?
             where record_id=? and state='available' and available_at <= ? and lease_epoch is ?`,
            [spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id, now, cand.env.leaseEpoch ?? null],
          );
          if (won === 0) continue; // it moved between the read and the update
        }
        this.appendEvent({
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
        } as TakeResult;
      }
      return null;
    }
  }

  async renew(ref: LeaseRef, leaseSeconds: number, idem?: IdempotencyKey): Promise<RenewResult> {
    const now = await this.now();
    return this.tx(() =>
      this.withIdem(idem, (): RenewResult => {
        const row = this.fetchEnvelopeRow(ref.recordId);
        if (!leaseValid(row, ref)) return { status: "lease_lost" };
        const hard = row!.lease_hard_deadline != null ? String(row!.lease_hard_deadline) : undefined;
        if (hard !== undefined && now >= hard) return { status: "lease_lost" };
        const wanted = addSeconds(now, leaseSeconds);
        const until = hard !== undefined ? minIso(wanted, hard) : wanted;
        // The guarded update IS the fence. Always check that it matched, so this adapter cannot
        // drift from the pooled one where the read and the update genuinely race.
        const renewed = this.run(
          "update record_runtime set leased_until=? where record_id=? and lease_id=? and lease_epoch=?",
          [until, ref.recordId, ref.leaseId, ref.epoch],
        );
        if (renewed === 0) return { status: "lease_lost" };
        return {
          status: "ok",
          lease: { leaseId: ref.leaseId, epoch: ref.epoch, ownerRun: String(row!.lease_owner), recordId: ref.recordId, expiresAt: until },
        };
      })
    );
  }

  async ack(ref: LeaseRef, result?: PutInput, idem?: IdempotencyKey, beforeWrite?: () => Promise<void>): Promise<AckResult> {
    const now = await this.now();
    // Outside the transaction, for the reason the pg twin gives: the caller's check reads the
    // space, and `withIdem` below stays the authority on whether this is a replay.
    if (beforeWrite && !this.hasStoredResponse(idem)) await beforeWrite();
    return this.tx(() =>
      this.withIdem(idem, (): AckResult => {
        const row = this.fetchEnvelopeRow(ref.recordId);
        if (!leaseValid(row, ref)) return { status: "lease_lost" };
        // Fence BEFORE writing anything. Never insert the result first: a fenced-out worker would
        // commit its result into the space and report `ok`. This adapter serializes in-process, so
        // the race is not reachable here, but the rule has to hold in both adapters or the
        // pooled one drifts, and embedded mode is never a weaker cousin of Postgres.
        const consumed = this.run(
          "update record_runtime set state='consumed', lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [ref.recordId, ref.leaseId, ref.epoch],
        );
        if (consumed === 0) return { status: "lease_lost" };
        if (result) {
          this.insertRecord(result);
          // The result is a new record entering the space, so it gets its own `put` event, the
          // same shape as a direct put. Without it the record would exist with no `available`
          // event of its own kind, and `matchesEvent` would never wake a watcher on that kind
          // (the ack event below is `consumed` and carries the PARENT's kind). Emitted before
          // the ack event.
          this.appendEvent({
            runId: result.record.runtimeMeta.createdBy,
            operation: "put",
            recordId: result.record.id,
            kind: result.record.kind,
            state: "available",
            detail: { ackOf: ref.recordId },
          }, result.envelope.availableAt);
        }
        this.appendEvent({
          runId: String(row!.lease_owner),
          operation: "ack",
          recordId: ref.recordId,
          kind: String(row!.kind),
          state: "consumed",
          detail: result ? { resultId: result.record.id } : undefined,
        }, now);
        return { status: "ok", resultId: result?.record.id };
      })
    );
  }

  async nack(ref: LeaseRef, backoffSeconds: number, maxAttempts: number, idem?: IdempotencyKey): Promise<SettleResult> {
    const now = await this.now();
    return this.tx(() =>
      this.withIdem(idem, (): SettleResult => {
      const row = this.fetchEnvelopeRow(ref.recordId);
      if (!leaseValid(row, ref)) return { status: "lease_lost" };
      const newAttempt = Number(row!.attempt) + 1;
      // The guarded update is the fence; a zero row count means the lease moved on (see `ack`).
      const settled = newAttempt > maxAttempts
        ? this.run(
          "update record_runtime set state='dead_letter', attempt=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [newAttempt, ref.recordId, ref.leaseId, ref.epoch],
        )
        : this.run(
          "update record_runtime set state='available', attempt=?, available_at=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [newAttempt, addSeconds(now, backoffSeconds), ref.recordId, ref.leaseId, ref.epoch],
        );
      if (settled === 0) return { status: "lease_lost" };
      this.appendEvent({
        runId: String(row!.lease_owner),
        operation: "nack",
        recordId: ref.recordId,
        kind: String(row!.kind),
        state: newAttempt > maxAttempts ? "dead_letter" : "available",
        detail: { attempt: newAttempt },
      }, now);
      return { status: "ok" };
      })
    );
  }

  async release(ref: LeaseRef, idem?: IdempotencyKey): Promise<SettleResult> {
    const now = await this.now();
    return this.tx(() =>
      this.withIdem(idem, (): SettleResult => {
        const row = this.fetchEnvelopeRow(ref.recordId);
        if (!leaseValid(row, ref)) return { status: "lease_lost" };
        // The guarded update is the fence; a zero row count means the lease moved on (see `ack`).
        const released = this.run(
          "update record_runtime set state='available', available_at=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [now, ref.recordId, ref.leaseId, ref.epoch],
        );
        if (released === 0) return { status: "lease_lost" };
        this.appendEvent({
          runId: String(row!.lease_owner),
          operation: "release",
          recordId: ref.recordId,
          kind: String(row!.kind),
          state: "available",
        }, now);
        return { status: "ok" };
      })
    );
  }

  getEnvelope(recordId: string): Promise<Envelope | null> {
    const row = this.db.prepare("select * from record_runtime where record_id = ?").get(recordId) as RawRow | undefined;
    return Promise.resolve(row ? rowToEnvelope(row) : null);
  }

  getRecord(recordId: string): Promise<RadiaRecord | null> {
    const row = this.db.prepare("select * from records where id = ?").get(recordId) as RawRow | undefined;
    return Promise.resolve(row ? rowToRecord(row) : null);
  }

  childrenOf(recordId: string, limit: number, page?: Page): Promise<RadiaRecord[]> {
    // Indexed lookup through the reverse edge table. `record_edges` exists so that finding a
    // record's children is an index seek; matching against the `parent_ids` JSON is a scan of
    // every record in the space to find a handful of children.
    const walk = pageClause(page, { column: "r.id", placeholder: () => "?" });
    const rows = this.db.prepare(
      `select r.* from record_edges e join records r on r.id = e.child_id
        where e.parent_id = ?${walk.where} ${walk.orderBy} limit ?`,
    ).all(recordId, ...walk.params, limit) as RawRow[];
    return Promise.resolve(rows.map(rowToRecord));
  }

  getRecords(ids: string[]): Promise<RadiaRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    // Cached by id count. The SQL text varies with the number of placeholders, so preparing it
    // fresh each call re-parses an identical statement on every hop of a graph walk, which costs
    // more than the batching saves. A walk issues the same handful of widths over and over, so
    // this cache stays small.
    let stmt = this.#byIds.get(ids.length);
    if (!stmt) {
      stmt = this.db.prepare(`select * from records where id in (${qmarks(ids.length)})`);
      this.#byIds.set(ids.length, stmt);
    }
    return Promise.resolve((stmt.all(...ids) as RawRow[]).map(rowToRecord));
  }

  getEvents(afterCursor: string, limit: number): Promise<SpaceEvent[]> {
    // Single-connection → commit order == seq order, so the cursor IS the seq (no watermark needed).
    const after = Number(afterCursor) || 0;
    const rows = this.db.prepare(
      "select seq, id, ts, run_id, operation, record_id, kind, state, detail from events where seq > ? order by seq asc limit ?",
    ).all(after, limit) as RawRow[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  latestCursor(): Promise<string> {
    const row = this.db.prepare("select coalesce(max(seq), 0) as seq from events").get() as { seq: number };
    return Promise.resolve(String(row.seq));
  }

  latestEvents(limit: number): Promise<SpaceEvent[]> {
    const rows = this.db.prepare(
      `select * from (
         select seq, id, ts, run_id, operation, record_id, kind, state, detail from events
          order by seq desc limit ?
       ) order by seq asc`,
    ).all(limit) as RawRow[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  async envelopesInState(q: EnvelopeQuery): Promise<Envelope[]> {
    const params: SqlParam[] = [q.state];
    let where = "rt.state = ?";
    if (q.excludeKinds && q.excludeKinds.length > 0) {
      where += ` and rt.kind not in (${qmarks(q.excludeKinds.length)})`;
      params.push(...q.excludeKinds);
    }
    // The caller's kinds and the SCOPE's kinds are separate clauses, ANDed. Intersecting them here
    // in JS would be the same answer with one extra way to get it wrong; two clauses cannot widen.
    if (q.kinds) {
      where += ` and rt.kind in (${qmarks(q.kinds.length)})`;
      params.push(...q.kinds);
    }
    if (q.scope?.kinds) {
      where += ` and rt.kind in (${qmarks(q.scope.kinds.length)})`;
      params.push(...q.scope.kinds);
    }
    // Every predicate is applied BEFORE the cap. A limit taken first and filtered after would
    // return a short page and read as "that is all of them"; see the port's comment for the two
    // verbs that lied when `expired` and `staleSeconds` were evaluated one layer up.
    if (q.expired || q.staleSeconds !== undefined) {
      const now = await this.now(); // the DATABASE clock, never the caller's
      if (q.expired) {
        where += ` and rt.leased_until < ?`;
        params.push(now);
      }
      if (q.staleSeconds !== undefined) {
        where += ` and rt.attempt = 0 and rt.available_at < ?`;
        params.push(addSeconds(now, -q.staleSeconds));
      }
    }
    const join = q.scope?.createdBy ? " join records r on r.id = rt.record_id" : "";
    if (q.scope?.createdBy) {
      where += ` and r.created_by in (${qmarks(q.scope.createdBy.length)})`;
      params.push(...q.scope.createdBy);
    }
    params.push(q.limit);
    const rows = this.db
      .prepare(`select rt.* from record_runtime rt${join} where ${where} order by rt.available_at limit ?`)
      .all(...params) as RawRow[];
    return Promise.resolve(rows.map(rowToEnvelope));
  }

  adminTransition(
    recordId: string,
    fromStates: string[],
    toState: string,
    opts: { now: string; bumpAttempt?: boolean; onlyExpired?: boolean },
  ): Promise<boolean> {
    const inList = fromStates.map((s) => `'${s}'`).join(","); // fixed enum, no injection
    const sets = [`state = '${toState}'`, "lease_id = null"];
    if (opts.bumpAttempt) sets.push("attempt = attempt + 1");
    if (toState === "available") sets.push("available_at = ?");
    let where = `record_id = ? and state in (${inList})`;
    if (opts.onlyExpired) where += " and leased_until < ?";
    // param order matches ? left-to-right: [available_at?], record_id, [leased_until?]
    const params: SqlParam[] = [];
    if (toState === "available") params.push(opts.now);
    params.push(recordId);
    if (opts.onlyExpired) params.push(opts.now);

    return Promise.resolve(this.tx(() => {
      const info = this.db.prepare(`update record_runtime set ${sets.join(", ")} where ${where}`).run(...params);
      if (Number(info.changes) === 0) return false;
      const kr = this.db.prepare("select kind from record_runtime where record_id = ?").get(recordId) as { kind: string } | undefined;
      this.appendEvent({
        runId: "admin",
        operation: "admin",
        recordId,
        kind: kr?.kind,
        state: toState as Envelope["state"],
        detail: { from: fromStates },
      }, opts.now);
      return true;
    }));
  }

  quarantineLeasesOf(ownerRun: string, now: string, actor: string): Promise<number> {
    return Promise.resolve(this.tx(() => {
      // RETURNING, for the reason the pg twin gives: the events and the count describe the rows
      // that moved, never the rows a prior read happened to see.
      const moved = this.db.prepare(
        `update record_runtime set state='available', available_at=?, attempt=attempt+1,
           lease_epoch=lease_epoch+1, lease_id=null
         where state='leased' and lease_owner=?
         returning record_id, kind`,
      ).all(now, ownerRun) as { record_id: string; kind: string }[];
      for (const r of moved) {
        this.appendEvent({
          runId: actor,
          operation: "quarantine",
          recordId: r.record_id,
          kind: r.kind,
          state: "available",
          detail: { ownerRun },
        }, now);
      }
      return moved.length;
    }));
  }

  sweepExpired(sel: SweepSelector): Promise<SweepResult> {
    return this.now().then((now) =>
      Promise.resolve(this.tx(() => {
        // Eligibility in one indexed select (see the partial index over retention_until): columns
        // only, so a sweep of a huge backlog never touches the oracle or the scan budget.
        const neverPh = sel.neverKinds.length > 0 ? ` and r.kind not in (${qmarks(sel.neverKinds.length)})` : "";
        const anyPh = sel.anyStateKinds.length > 0
          ? ` or r.kind in (${qmarks(sel.anyStateKinds.length)})`
          : "";
        const rows = this.db.prepare(
          `select r.id, r.kind from records r join record_runtime rt on rt.record_id = r.id
            where r.retention_until is not null and r.retention_until < ?
              and (rt.lease_id is null or rt.leased_until is null or rt.leased_until <= ?)${neverPh}
              and (rt.state in ('consumed','dead_letter')${anyPh})
            order by r.id limit ?`,
        ).all(now, now, ...sel.neverKinds, ...sel.anyStateKinds, sel.limit) as { id: string; kind: string }[];

        const byKind: Record<string, number> = {};
        for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        // The idempotency store, in the same transaction: age-based, and rows with created_at ''
        // (age unknown) are never touched.
        let idem = 0;
        if (sel.idempotencyBefore) {
          idem = sel.dryRun
            ? Number((this.db.prepare("select count(*) c from idempotency where created_at <> '' and created_at < ?").get(sel.idempotencyBefore) as { c: number }).c)
            : this.run("delete from idempotency where created_at <> '' and created_at < ?", [sel.idempotencyBefore]);
        }
        const result: SweepResult = {
          swept: sel.dryRun ? 0 : rows.length,
          eligible: rows.length,
          idempotency: idem,
          byKind,
          more: rows.length >= sel.limit,
        };
        if (sel.dryRun || rows.length === 0) return result;

        // Envelope and edges go with the record, in this transaction: a record without its runtime
        // row is a state no reader is written for, so the deletion is all-or-nothing per batch.
        const ph = qmarks(rows.length);
        const ids = rows.map((r) => r.id);
        this.db.prepare(`delete from record_runtime where record_id in (${ph})`).run(...ids);
        this.db.prepare(`delete from record_edges where parent_id in (${ph}) or child_id in (${ph})`).run(...ids, ...ids);
        this.db.prepare(`delete from records where id in (${ph})`).run(...ids);
        // One recordless event per KIND, not per record: the audit residue must not replace the
        // growth it removes with smaller growth forever.
        for (const [kind, swept] of Object.entries(byKind)) {
          this.appendEvent({ runId: sel.runId, operation: "gc", kind, detail: { swept, cutoff: now } }, now);
        }
        return result;
      }))
    );
  }

  sweepIds(ids: string[], runId: string): Promise<SweptIds> {
    if (ids.length === 0) return Promise.resolve({ swept: 0, byKind: {} });
    return this.now().then((now) =>
      Promise.resolve(this.tx(() => {
        // The safety floor, re-checked HERE whatever the caller computed: a live lease wins.
        const ph = qmarks(ids.length);
        const rows = this.db.prepare(
          `select r.id, r.kind from records r join record_runtime rt on rt.record_id = r.id
            where r.id in (${ph})
              and (rt.lease_id is null or rt.leased_until is null or rt.leased_until <= ?)`,
        ).all(...ids, now) as { id: string; kind: string }[];
        const byKind: Record<string, number> = {};
        for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        if (rows.length === 0) return { swept: 0, byKind };
        const del = rows.map((r) => r.id);
        const dph = qmarks(del.length);
        this.db.prepare(`delete from record_runtime where record_id in (${dph})`).run(...del);
        this.db.prepare(`delete from record_edges where parent_id in (${dph}) or child_id in (${dph})`).run(...del, ...del);
        this.db.prepare(`delete from records where id in (${dph})`).run(...del);
        for (const [kind, swept] of Object.entries(byKind)) {
          this.appendEvent({ runId, operation: "gc", kind, detail: { swept, compacted: true } }, now);
        }
        return { swept: rows.length, byKind };
      }))
    );
  }

  private appendEvent(e: EventInput, ts: string): void {
    this.db.prepare(
      "insert into events (id, ts, run_id, operation, record_id, kind, state, detail, body_sha256) values (?,?,?,?,?,?,?,?,?)",
    ).run(
      newUlid(),
      ts,
      e.runId,
      e.operation,
      e.recordId ?? null,
      e.kind ?? null,
      e.state ?? null,
      e.detail ? JSON.stringify(e.detail) : null,
      e.bodySha256 ?? null,
    );
  }

  // ---- integrity chain (M1) ----
  // One writer and one connection, so seq order IS commit order: no watermark, and the cursor is
  // the seq. The tuple comparison degenerates to `seq > s`, which is why the same core sealer runs
  // unchanged on both dialects.
  sealableEvents(after: EventPosition | null, limit: number): Promise<SpaceEvent[]> {
    const rows = this.db.prepare(
      `select seq, id, ts, run_id, operation, record_id, kind, state, detail, body_sha256
         from events where seq > ? order by seq asc limit ?`,
    ).all(after?.seq ?? 0, limit) as RawRow[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  sealHead(): Promise<EventSeal | null> {
    const row = this.db.prepare(
      "select idx, event_id, cursor, seq, hash, prev_hash, sig from event_seal order by idx desc limit 1",
    ).get() as RawRow | undefined;
    return Promise.resolve(row ? rowToSeal(row) : null);
  }

  appendSeals(seals: EventSeal[]): Promise<number> {
    const stmt = this.db.prepare(
      `insert into event_seal (idx, event_id, cursor, seq, hash, prev_hash, sig)
       values (?,?,?,?,?,?,?) on conflict (idx) do nothing`,
    );
    let written = 0;
    for (const s of seals) {
      const r = stmt.run(s.idx, s.eventId, s.cursor, s.seq, s.hash, s.prevHash, s.sig ?? null);
      if (Number(r.changes) === 0) break; // another sealer got there first; its links stand
      written++;
    }
    return Promise.resolve(written);
  }

  getSeals(afterIdx: number, limit: number): Promise<EventSeal[]> {
    const rows = this.db.prepare(
      "select idx, event_id, cursor, seq, hash, prev_hash, sig from event_seal where idx > ? order by idx asc limit ?",
    ).all(afterIdx, limit) as RawRow[];
    return Promise.resolve(rows.map(rowToSeal));
  }

  eventHorizon(after: string): Promise<EventHorizonCheck> {
    const row = this.db.prepare(
      "select idx, event_id, cursor, seq, hash, prev_hash, sig from event_seal order by idx asc limit 1",
    ).get() as RawRow | undefined;
    if (!row) return Promise.resolve({ expired: false, horizon: null });
    const oldest = rowToSeal(row);
    const exists = this.db.prepare("select 1 from events where seq = ?").get(oldest.seq) !== undefined;
    return Promise.resolve(resolveEventHorizon(oldest, exists, after));
  }

  async appendGcEvent(e: EventInput): Promise<EventPosition> {
    const now = await this.now();
    this.appendEvent(e, now);
    const row = this.db.prepare("select last_insert_rowid() as seq").get() as { seq: number };
    return { cursor: String(row.seq), seq: row.seq };
  }

  latestSealBefore(cutoffTs: string): Promise<EventSeal | null> {
    const row = this.db.prepare(
      `select s.idx, s.event_id, s.cursor, s.seq, s.hash, s.prev_hash, s.sig
         from event_seal s join events e on e.seq = s.seq
        where e.ts < ? order by s.idx desc limit 1`,
    ).get(cutoffTs) as RawRow | undefined;
    return Promise.resolve(row ? rowToSeal(row) : null);
  }

  sweepSealedEvents(anchor: SweepAnchor, limit: number, dryRun?: boolean): Promise<EventSweepResult> {
    if (dryRun) {
      const row = this.db.prepare(
        "select count(*) c from event_seal s join events e on e.seq = s.seq where s.idx <= ?",
      ).get(anchor.idx) as { c: number };
      return Promise.resolve({ events: row.c, done: true });
    }
    return Promise.resolve(this.tx(() => {
      const doomed = this.db.prepare(
        "select idx, seq from event_seal where idx < ? order by idx asc limit ?",
      ).all(anchor.idx, limit) as { idx: number; seq: number }[];
      let events = 0;
      if (doomed.length > 0) {
        events += this.run(`delete from events where seq in (${qmarks(doomed.length)})`, doomed.map((d) => d.seq));
        this.run(`delete from event_seal where idx in (${qmarks(doomed.length)})`, doomed.map((d) => d.idx));
      }
      const done = doomed.length < limit;
      if (done) events += this.run("delete from events where seq = ?", [anchor.seq]);
      return { events, done };
    }));
  }

  /**
   * Rows of the kind that survive the SQL pre-filter: a superset of what the oracle accepts.
   *
   * `want` is how many records the caller will ultimately keep. It becomes a SQL `LIMIT` only when
   * the filter is EXACT and the caller has no `orderBy`, because only then does the database agree
   * with the oracle about both which rows match and which come first: with no `orderBy` the
   * oracle's order is `x.id < y.id`, its deterministic tie-break, which `order by id asc` matches
   * exactly. Any other case fetches everything and lets the oracle sort; see `Pushed.exact`.
   */
  private async candidateMatches(
    match: CompiledMatch,
    want?: number,
    page?: Page,
    scope?: StatsScope,
  ): Promise<RadiaRecord[]> {
    const d = new SqliteJson();
    const filter = pushdown(match.where, d);
    const where = isTrivial(filter) ? "" : ` and ${filter.sql}`;
    // The cursor is an id comparison, so it is always EXACT: it constrains nothing the oracle
    // would have to re-check, and it applies whether or not the body filter could be pushed.
    const walk = pageClause(page, { column: "id", placeholder: () => "?" });
    const { where: cursor, orderBy, cmp } = walk;
    // The author restriction is an exact column predicate, so it never needs the oracle's help and
    // never blocks the pushed limit.
    const author = scope?.createdBy ? ` and created_by in (${qmarks(scope.createdBy.length)})` : "";
    const head = [match.kind, ...d.params, ...(page?.after ? [page.after] : []), ...(scope?.createdBy ?? [])];
    const bounded = want !== undefined && filter.exact && !match.orderBy?.length;
    if (bounded) {
      const rows = this.db
        .prepare(`select * from records where kind = ?${where}${cursor}${author} ${orderBy} limit ?`)
        .all(...head, want) as RawRow[];
      return rows.map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    }
    // The inexact path, where SQL narrows and the oracle decides. Walked in CHUNKS rather than
    // fetched whole, for three reasons: the whole kind no longer has to fit in memory at once; the
    // budget can stop it partway instead of after the damage; and the `await` between chunks is
    // what lets another principal's request run, which a single `.all()` over a million rows does
    // not (this adapter's driver is synchronous, so nothing else yields).
    const chunk = this.db
      .prepare(`select * from records where kind = ?${where}${cursor}${author} and id ${cmp} ? ${orderBy} limit ?`);
    const first = this.db
      .prepare(`select * from records where kind = ?${where}${cursor}${author} ${orderBy} limit ?`);
    const size = scanChunkSize(match.scanBudget);
    const out: RadiaRecord[] = [];
    let examined = 0;
    let after: string | undefined;
    for (;;) {
      const rows = (after === undefined ? first.all(...head, size) : chunk.all(...head, after, size)) as RawRow[];
      if (rows.length === 0) return out;
      examined += rows.length;
      for (const row of rows) {
        const rec = rowToRecord(row);
        if (matchesRecord(rec, match)) out.push(rec);
      }
      // An `orderBy` has to see every match before it can say which comes first, so only the
      // natural order can stop early. That is also the only order the SQL walk agrees with.
      if (!match.orderBy?.length && want !== undefined && out.length >= want) return out;
      if (rows.length < size) return out;
      // Checked HERE, not before the oracle: the budget bounds the walk, so a read that finishes
      // inside a chunk is never refused for the size of the chunk it happened to be given. What it
      // refuses is continuing, which is the unbounded part.
      if (match.scanBudget !== undefined && examined >= match.scanBudget) {
        throw scanBudgetExceeded(match.kind, match.scanBudget);
      }
      after = String(rows[rows.length - 1].id);
      await yieldToEventLoop();
    }
  }

  async readOne(match: CompiledMatch, scope?: StatsScope): Promise<RadiaRecord | null> {
    // SQL narrows; the core oracle decides. `pushdown` is a sound over-approximation, so this
    // filter never removes a record `matchesRecord` would have accepted.
    return firstByOrder(await this.candidateMatches(match, 1, undefined, scope), match.orderBy);
  }

  async query(match: CompiledMatch, limit: number, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]> {
    return pageRecords(await this.candidateMatches(match, limit, page, scope), match.orderBy, limit, page);
  }

  stats(scope?: StatsScope): Promise<KindStateCount[]> {
    // Scoped counts JOIN records, because `created_by` lives there. Unscoped stays a pure
    // record_runtime aggregate, so the common path pays nothing for the scoped one.
    const params: SqlParam[] = [];
    const conds: string[] = [];
    if (scope?.createdBy) {
      conds.push(`r.created_by in (${qmarks(scope.createdBy.length)})`);
      params.push(...scope.createdBy);
    }
    if (scope?.kinds) {
      conds.push(`rt.kind in (${qmarks(scope.kinds.length)})`);
      params.push(...scope.kinds);
    }
    const rows = this.db.prepare(
      conds.length > 0
        ? `select rt.kind, rt.state, count(*) as count from record_runtime rt
             join records r on r.id = rt.record_id
            where ${conds.join(" and ")}
            group by rt.kind, rt.state order by rt.kind, rt.state`
        : "select kind, state, count(*) as count from record_runtime group by kind, state order by kind, state",
    ).all(...params) as RawRow[];
    return Promise.resolve(rows.map((r) => ({
      kind: String(r.kind),
      state: String(r.state) as KindStateCount["state"],
      count: Number(r.count),
    })));
  }

  private tx<T>(fn: () => T): T {
    const db = this.db;
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Returns the number of rows the statement changed, needed to tell a won compare-and-set
   *  from a lost one, which is what makes single-winner independent of row locking. */
  private run(sql: string, params: SqlParam[]): number {
    return Number(this.db.prepare(sql).run(...params).changes ?? 0);
  }

  // Idempotency wrapper. Runs INSIDE the op's transaction and checks the stored response
  // BEFORE the effect (which includes lease validation), so a retry replays the original
  // outcome. A key reused with a different request is a conflict.
  /** Is there already a stored response for this key? Advisory only; see `ack`. */
  private hasStoredResponse(idem?: IdempotencyKey): boolean {
    if (!idem) return false;
    const row = this.db
      .prepare("select 1 as hit from idempotency where principal=? and operation=? and idem_key=?")
      .get(idem.principal, idem.operation, idem.key);
    return row !== undefined;
  }

  private withIdem<T>(idem: IdempotencyKey | undefined, run: () => T): T {
    if (!idem) return run();
    const found = this.db
      .prepare("select request_hash, response_json from idempotency where principal=? and operation=? and idem_key=?")
      .get(idem.principal, idem.operation, idem.key) as RawRow | undefined;
    if (found) {
      if (String(found.request_hash) !== idem.requestHash) {
        throw new RadiaError(
          "idempotency_conflict",
          `idempotency key reused with a different request: ${idem.operation} '${idem.key}' ` +
            `(principal ${idem.principal}). The key is derived from the request's content, so a ` +
            `key that matches while the content differs means the content changed shape.`,
        );
      }
      return JSON.parse(String(found.response_json)) as T;
    }
    const result = run();
    this.db
      // `created_at` is stamped IN SQL with the same expression `now()` uses (the DB clock
      // invariant), because an insert that omitted it fell to the schema's `''` default — which
      // meant EVERY row, not just pre-column ones, read as "age unknown" and the age-based sweep
      // in `sweepExpired` would have deleted nothing forever.
      .prepare(
        "insert into idempotency (principal, operation, idem_key, request_hash, response_json, created_at) values (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      )
      .run(idem.principal, idem.operation, idem.key, idem.requestHash, JSON.stringify(result));
    return result;
  }

  /** One window of candidates in claim order. Bounded on purpose: never fetch every
   *  available-or-leased record of the kind, which makes a claim O(kind size). */
  private fetchCandidates(selector: TakeSelector, limit = CANDIDATE_WINDOW, after?: ClaimCursor): Candidate[] {
    const rows = "recordId" in selector
      ? this.db.prepare(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.id=? and rt.state in ('available','leased')`,
      ).all(selector.recordId) as RawRow[]
      : this.windowRows(selector, limit, after);
    return rows.map((row) => ({ record: rowToRecord(row), env: rowToEnvelope(row) }));
  }

  /**
   * One window of claim candidates, in `rankClaimable` order.
   *
   * Pick the window from the narrow envelope table FIRST, then fetch bodies for just those rows.
   * Sorting the join materializes every record body of the kind before the limit applies, which is
   * most of the cost of a claim on a large kind.
   *
   * A pattern with a pushable predicate joins `records` inside that inner select so the window is
   * drawn from ROWS THAT CAN MATCH. Without it the window is the head of the queue regardless of
   * the pattern, so a selective take pages through the entire kind 64 rows at a time. That is
   * correct, but O(kind size) round trips to find one record. The filter is a sound
   * over-approximation, so
   * `rankClaimable` still decides.
   *
   * SQLite answers this from `idx_runtime_claim_order`: an ordered seek that stops once the window
   * is full. Postgres does NOT, and cannot be talked into it by rewriting the SQL: it estimates a
   * jsonb predicate at ~26 rows when 5,715 match, so it collects every match through the body index
   * and sorts. The fix is a better ESTIMATE, not a better query: see gotchas.md, "a claim on
   * Postgres is planned on a guess".
   */
  private windowRows(selector: { pattern: CompiledMatch }, limit: number, after?: ClaimCursor): RawRow[] {
    const d = new SqliteJson("r2");
    const filter = pushdown(selector.pattern.where, d);
    // KEYSET, not OFFSET, matching the Postgres adapter: an offset assumes the rows before the
    // cursor stay put, and in a queue those are precisely the rows other claimers are removing, so
    // each departure shifts the rest forward and the next window skips them. Single-writer here, so
    // this is agreement rather than a live fix — but the two adapters must page a queue by the same
    // rule, or the conformance suite is testing two different claim orders.
    const keyset = after
      ? ` and (PRI < ? or (PRI = ? and (AVL > ? or (AVL = ? and ID > ?))))`
      : "";
    const bare = keyset.replace(/PRI/g, "effective_priority").replace(/AVL/g, "available_at").replace(/ID/g, "record_id");
    const joined = keyset.replace(/PRI/g, "rt2.effective_priority").replace(/AVL/g, "rt2.available_at").replace(
      /ID/g,
      "rt2.record_id",
    );
    const inner = isTrivial(filter)
      ? `select record_id from record_runtime
           where kind=? and state in ('available','leased')${bare}
           order by effective_priority desc, available_at asc, record_id asc
           limit ?`
      : `select rt2.record_id from record_runtime rt2 join records r2 on r2.id=rt2.record_id
           where rt2.kind=? and rt2.state in ('available','leased') and ${filter.sql}${joined}
           order by rt2.effective_priority desc, rt2.available_at asc, rt2.record_id asc
           limit ?`;
    const cursorArgs = after ? [after.priority, after.priority, after.availableAt, after.availableAt, after.recordId] : [];
    return this.db.prepare(
      `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
         where rt.record_id in (${inner})
         order by rt.effective_priority desc, rt.available_at asc, r.id asc`,
    ).all(selector.pattern.kind, ...d.params, ...cursorArgs, limit) as RawRow[];
  }

  private fetchEnvelopeRow(recordId: string): RawRow | null {
    return (this.db.prepare("select * from record_runtime where record_id = ?").get(recordId) as RawRow | undefined) ?? null;
  }

  private insertRecord(input: PutInput): void {
    const parentExists = this.db.prepare("select 1 from records where id = ?");
    for (const pid of input.record.runtimeMeta.parentIds) {
      if (!parentExists.get(pid)) {
        throw new RadiaError("parent_not_found", `parent ${pid} does not exist`);
      }
    }
    this.db.prepare(
      `insert into records (${RECORD_COLUMNS}) values (${qmarks(RECORD_COLUMN_COUNT)})`,
    ).run(...toSqlValues(recordInsertValues(input)));
    this.db.prepare(
      `insert into record_runtime
         (record_id, kind, state, attempt, available_at, claim_until, deadline_at, effective_priority)
       values (?, ?, 'available', 0, ?, ?, ?, ?)`,
    ).run(...toSqlValues(runtimeInsertValues(input)));
    // The reverse edge, in the SAME transaction as the record: a derived index that can never
    // lag the thing it indexes.
    if (input.record.runtimeMeta.parentIds.length > 0) {
      const edge = this.db.prepare("insert or ignore into record_edges (parent_id, child_id) values (?, ?)");
      for (const pid of input.record.runtimeMeta.parentIds) edge.run(pid, input.record.id);
    }
  }

  private get db(): DatabaseSync {
    if (!this.#db) throw new Error("SqliteAdapter not initialized");
    return this.#db;
  }
}

function leaseValid(row: RawRow | null, ref: LeaseRef): boolean {
  if (row === null) return false;
  // Owner-bound settle, checked HERE and not by the caller: this runs inside the transaction,
  // after `withIdem` has replayed any stored response, which is the ordering the
  // idempotency-before-lease-validation invariant requires. See `LeaseRef.expectOwner`.
  if (ref.expectOwner !== undefined && row.lease_owner != null && String(row.lease_owner) !== ref.expectOwner) {
    return false;
  }
  return row.state === "leased" &&
    String(row.lease_id) === ref.leaseId &&
    Number(row.lease_epoch) === ref.epoch;
}
