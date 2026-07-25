// Embedded adapter: SQLite (via Deno's built-in `node:sqlite`).
//
// The lighter adapter and the real test that the port abstracts: SQLite's WAL
// single-writer concurrency, its json_extract path functions, and its lack of Postgres
// generated-column parity differ from PGlite, so any Postgres assumption that leaks into
// core/ surfaces here. Single writer, so takes serialize in-process.
//
// Uses `node:sqlite` (built into the Deno runtime) rather than an FFI package: zero
// external dependency, no native library download, and no --allow-ffi — the best fit for
// the minimal-deps / platform-independence invariant. (The `jsr:@db/sqlite` FFI package
// segfaulted under this Deno build; see agent_docs/gotchas.md.)

import { DatabaseSync } from "node:sqlite";
import {
  type AckResult,
  type CompiledMatch,
  type Envelope,
  type IdempotencyKey,
  type KindStateCount,
  type LeaseRef,
  type LeaseSpec,
  type PutInput,
  type PutResult,
  type EventInput,
  type RadiaRecord,
  type RenewResult,
  type SettleResult,
  type SpaceEvent,
  type StorageAdapter,
  type TakeResult,
  type TakeSelector,
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
  runtimeInsertValues,
} from "./row.ts";
import { firstByOrder, matchesRecord, orderRecords } from "../core/matching.ts";
import { type Candidate, rankClaimable } from "../core/take.ts";
import { addSeconds, minIso } from "../core/time.ts";
import { newUlid } from "../core/ids.ts";
import { RadiaError } from "../core/errors.ts";

const CANDIDATE_COLS =
  "r.*, rt.record_id, rt.state, rt.attempt, rt.available_at, rt.claim_until, " +
  "rt.effective_priority, rt.lease_id, rt.lease_epoch, rt.lease_owner, rt.leased_until, " +
  "rt.lease_hard_deadline";

type SqlParam = string | number | null;

// SQLite has no boolean type; taint is stored as integer 0/1.
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
  seq integer primary key autoincrement,
  id text not null,
  ts text not null,
  run_id text not null,
  operation text not null,
  record_id text,
  kind text,
  state text,
  detail text
);
`;

type SqlValue = string | number | null;

/** SQLite has no boolean; map booleans to 0/1, pass everything else through. */
function toSqlValues(values: unknown[]): SqlValue[] {
  return values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v as SqlValue));
}

export class SqliteAdapter implements StorageAdapter {
  readonly name = "sqlite";
  #db?: DatabaseSync;

  /** @param path `:memory:` for an in-memory database, else a file path. */
  constructor(private readonly path = ":memory:") {}

  init(): Promise<void> {
    this.#db = new DatabaseSync(this.path);
    // WAL is a no-op for :memory: but is the intended mode for file-backed dev spaces.
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(DDL);
    return Promise.resolve();
  }

  close(): Promise<void> {
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
          operation: "put",
          recordId: input.record.id,
          kind: input.record.kind,
          state: "available",
        }, input.envelope.availableAt);
        return { id: input.record.id, deduped: false };
      })
    ));
  }

  async take(selector: TakeSelector, spec: LeaseSpec): Promise<TakeResult | null> {
    const now = await this.now();
    return this.tx(() => {
      const candidates = this.fetchCandidates(selector);
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
            this.run(
              "update record_runtime set state='dead_letter', lease_id=null where record_id=? and state='leased' and lease_epoch=?",
              [id, cand.env.leaseEpoch ?? 0],
            );
            this.appendEvent({
              runId: spec.ownerRun,
              operation: "expire",
              recordId: id,
              kind: cand.record.kind,
              state: "dead_letter",
            }, now);
            continue;
          }
          this.run(
            `update record_runtime set state='leased', attempt=?, lease_id=?, lease_epoch=?,
               lease_owner=?, leased_until=?, lease_hard_deadline=?
             where record_id=? and state='leased' and lease_epoch=?`,
            [newAttempt, spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id, cand.env.leaseEpoch ?? 0],
          );
        } else {
          this.run(
            `update record_runtime set state='leased', lease_id=?, lease_epoch=?,
               lease_owner=?, leased_until=?, lease_hard_deadline=?
             where record_id=? and state='available'`,
            [spec.leaseId, epoch, spec.ownerRun, leasedUntil, hardDeadline, id],
          );
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
    });
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
        this.run(
          "update record_runtime set leased_until=? where record_id=? and lease_id=? and lease_epoch=?",
          [until, ref.recordId, ref.leaseId, ref.epoch],
        );
        return {
          status: "ok",
          lease: { leaseId: ref.leaseId, epoch: ref.epoch, ownerRun: String(row!.lease_owner), recordId: ref.recordId, expiresAt: until },
        };
      })
    );
  }

  async ack(ref: LeaseRef, result?: PutInput, idem?: IdempotencyKey): Promise<AckResult> {
    const now = await this.now();
    return this.tx(() =>
      this.withIdem(idem, (): AckResult => {
        const row = this.fetchEnvelopeRow(ref.recordId);
        if (!leaseValid(row, ref)) return { status: "lease_lost" };
        if (result) this.insertRecord(result);
        this.run(
          "update record_runtime set state='consumed', lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [ref.recordId, ref.leaseId, ref.epoch],
        );
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
      if (newAttempt > maxAttempts) {
        this.run(
          "update record_runtime set state='dead_letter', attempt=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [newAttempt, ref.recordId, ref.leaseId, ref.epoch],
        );
      } else {
        this.run(
          "update record_runtime set state='available', attempt=?, available_at=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [newAttempt, addSeconds(now, backoffSeconds), ref.recordId, ref.leaseId, ref.epoch],
        );
      }
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
        this.run(
          "update record_runtime set state='available', available_at=?, lease_id=null where record_id=? and lease_id=? and lease_epoch=?",
          [now, ref.recordId, ref.leaseId, ref.epoch],
        );
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

  childrenOf(recordId: string): Promise<RadiaRecord[]> {
    // parent_ids is a JSON text array of quoted ids; a LIKE on `"<id>"` finds children.
    const rows = this.db.prepare("select * from records where parent_ids like ?").all(`%"${recordId}"%`) as RawRow[];
    return Promise.resolve(rows.map(rowToRecord));
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

  envelopesInState(state: string, limit: number, excludeKinds?: string[]): Promise<Envelope[]> {
    const exclude = excludeKinds && excludeKinds.length > 0
      ? ` and kind not in (${excludeKinds.map(() => "?").join(", ")})`
      : "";
    const rows = this.db
      .prepare(`select * from record_runtime where state = ?${exclude} order by available_at limit ?`)
      .all(state, ...(excludeKinds ?? []), limit) as RawRow[];
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

  quarantineLeasesOf(ownerRun: string, now: string): Promise<number> {
    return Promise.resolve(this.tx(() => {
      const held = this.db
        .prepare("select record_id, kind from record_runtime where state='leased' and lease_owner=?")
        .all(ownerRun) as { record_id: string; kind: string }[];
      if (held.length === 0) return 0;
      this.db.prepare(
        `update record_runtime set state='available', available_at=?, attempt=attempt+1,
           lease_epoch=lease_epoch+1, lease_id=null
         where state='leased' and lease_owner=?`,
      ).run(now, ownerRun);
      for (const r of held) {
        this.appendEvent({
          runId: "admin",
          operation: "quarantine",
          recordId: r.record_id,
          kind: r.kind,
          state: "available",
          detail: { ownerRun },
        }, now);
      }
      return held.length;
    }));
  }

  private appendEvent(e: EventInput, ts: string): void {
    this.db.prepare(
      "insert into events (id, ts, run_id, operation, record_id, kind, state, detail) values (?,?,?,?,?,?,?,?)",
    ).run(newUlid(), ts, e.runId, e.operation, e.recordId ?? null, e.kind ?? null, e.state ?? null, e.detail ? JSON.stringify(e.detail) : null);
  }

  readOne(match: CompiledMatch): Promise<RadiaRecord | null> {
    // Fetch by kind, filter + order with the core oracle. Predicate pushdown onto
    // per-kind expression indexes is a tracked follow-up; the oracle defines correctness.
    const rows = this.db
      .prepare("select * from records where kind = ?")
      .all(match.kind) as RawRow[];
    const matches = rows
      .map(rowToRecord)
      .filter((rec) => matchesRecord(rec, match));
    return Promise.resolve(firstByOrder(matches, match.orderBy));
  }

  query(match: CompiledMatch, limit: number): Promise<RadiaRecord[]> {
    const rows = this.db.prepare("select * from records where kind = ?").all(match.kind) as RawRow[];
    const matches = rows.map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    return Promise.resolve(orderRecords(matches, match.orderBy).slice(0, limit));
  }

  stats(): Promise<KindStateCount[]> {
    const rows = this.db.prepare(
      "select kind, state, count(*) as count from record_runtime group by kind, state order by kind, state",
    ).all() as RawRow[];
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

  private run(sql: string, params: SqlParam[]): void {
    this.db.prepare(sql).run(...params);
  }

  // Idempotency wrapper. Runs INSIDE the op's transaction and checks the stored response
  // BEFORE the effect (which includes lease validation), so a retry replays the original
  // outcome. A key reused with a different request is a conflict.
  private withIdem<T>(idem: IdempotencyKey | undefined, run: () => T): T {
    if (!idem) return run();
    const found = this.db
      .prepare("select request_hash, response_json from idempotency where principal=? and operation=? and idem_key=?")
      .get(idem.principal, idem.operation, idem.key) as RawRow | undefined;
    if (found) {
      if (String(found.request_hash) !== idem.requestHash) {
        throw new RadiaError("idempotency_conflict", "idempotency key reused with a different request");
      }
      return JSON.parse(String(found.response_json)) as T;
    }
    const result = run();
    this.db
      .prepare("insert into idempotency (principal, operation, idem_key, request_hash, response_json) values (?,?,?,?,?)")
      .run(idem.principal, idem.operation, idem.key, idem.requestHash, JSON.stringify(result));
    return result;
  }

  private fetchCandidates(selector: TakeSelector): Candidate[] {
    const rows = "recordId" in selector
      ? this.db.prepare(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.id=? and rt.state in ('available','leased')`,
      ).all(selector.recordId) as RawRow[]
      : this.db.prepare(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.kind=? and rt.state in ('available','leased')`,
      ).all(selector.template.kind) as RawRow[];
    return rows.map((row) => ({ record: rowToRecord(row), env: rowToEnvelope(row) }));
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
  }

  private get db(): DatabaseSync {
    if (!this.#db) throw new Error("SqliteAdapter not initialized");
    return this.#db;
  }
}

function leaseValid(row: RawRow | null, ref: LeaseRef): boolean {
  return row !== null &&
    row.state === "leased" &&
    String(row.lease_id) === ref.leaseId &&
    Number(row.lease_epoch) === ref.epoch;
}
