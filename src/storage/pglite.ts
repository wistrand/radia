// Embedded adapter: PGlite (WASM Postgres).
//
// Keeps one adapter's SQL dialect and take semantics aligned with the M1 Postgres
// adapter. Single-connection, so takes serialize in-process — the embedded equivalent
// of `FOR UPDATE SKIP LOCKED`.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  type AckResult,
  type CompiledMatch,
  type Envelope,
  type IdempotencyKey,
  type KindStateCount,
  type Lease,
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

const CANDIDATE_COLS =
  "r.*, rt.record_id, rt.state, rt.attempt, rt.available_at, rt.claim_until, " +
  "rt.effective_priority, rt.lease_id, rt.lease_epoch, rt.lease_owner, rt.leased_until, " +
  "rt.lease_hard_deadline";

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
  id text not null,
  ts text not null,
  run_id text not null,
  operation text not null,
  record_id text,
  kind text,
  state text,
  detail text
);
create table if not exists kinds (
  kind text primary key,
  def text not null
);
`;

export class PgliteAdapter implements StorageAdapter {
  readonly name = "pglite";
  #db?: PGlite;

  /** @param dataDir omit or `memory://` for an in-memory database. */
  constructor(private readonly dataDir?: string) {}

  async init(): Promise<void> {
    this.#db = new PGlite(this.dataDir);
    await this.#db.exec(DDL);
  }

  async close(): Promise<void> {
    await this.#db?.close();
    this.#db = undefined;
  }

  async now(): Promise<string> {
    const r = await this.db.query<{ now: string }>(
      "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as now",
    );
    return r.rows[0].now;
  }

  async put(input: PutInput): Promise<PutResult> {
    return await this.db.transaction((tx) =>
      this.withIdem(tx, input.idempotency, async () => {
        await this.insertRecord(tx, input);
        await this.appendEvent(tx, {
          runId: input.record.runtimeMeta.createdBy,
          operation: "put",
          recordId: input.record.id,
          kind: input.record.kind,
          state: "available",
        }, input.envelope.availableAt);
        return { id: input.record.id, deduped: false };
      })
    );
  }

  async readOne(match: CompiledMatch): Promise<RadiaRecord | null> {
    // Fetch by kind, filter + order with the core oracle. Predicate pushdown onto
    // per-kind expression indexes is a tracked follow-up; the oracle defines correctness.
    const res = await this.db.query<RawRow>(
      "select * from records where kind = $1",
      [match.kind],
    );
    const matches = res.rows
      .map(rowToRecord)
      .filter((rec) => matchesRecord(rec, match));
    return firstByOrder(matches, match.orderBy);
  }

  async query(match: CompiledMatch, limit: number): Promise<RadiaRecord[]> {
    const res = await this.db.query<RawRow>("select * from records where kind = $1", [match.kind]);
    const matches = res.rows.map(rowToRecord).filter((rec) => matchesRecord(rec, match));
    return orderRecords(matches, match.orderBy).slice(0, limit);
  }

  async stats(): Promise<KindStateCount[]> {
    const res = await this.db.query<RawRow>(
      "select kind, state, count(*)::int as count from record_runtime group by kind, state order by kind, state",
    );
    return res.rows.map((r) => ({
      kind: String(r.kind),
      state: String(r.state) as KindStateCount["state"],
      count: Number(r.count),
    }));
  }

  async take(selector: TakeSelector, spec: LeaseSpec): Promise<TakeResult | null> {
    const now = await this.now();
    return await this.db.transaction(async (tx) => {
      const candidates = await this.fetchCandidates(tx, selector);
      const template = "template" in selector ? selector.template : undefined;
      const ranked = rankClaimable(candidates, template, now);

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
    const now = await this.now();
    return await this.db.transaction((tx) =>
      this.withIdem(tx, idem, async (): Promise<RenewResult> => {
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
      })
    );
  }

  async ack(ref: LeaseRef, result?: PutInput, idem?: IdempotencyKey): Promise<AckResult> {
    const now = await this.now();
    return await this.db.transaction((tx) =>
      this.withIdem(tx, idem, async (): Promise<AckResult> => {
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
      })
    );
  }

  async nack(ref: LeaseRef, backoffSeconds: number, maxAttempts: number, idem?: IdempotencyKey): Promise<SettleResult> {
    const now = await this.now();
    return await this.db.transaction((tx) =>
      this.withIdem(tx, idem, async (): Promise<SettleResult> => {
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
      })
    );
  }

  async release(ref: LeaseRef, idem?: IdempotencyKey): Promise<SettleResult> {
    const now = await this.now();
    return await this.db.transaction((tx) =>
      this.withIdem(tx, idem, async (): Promise<SettleResult> => {
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
      })
    );
  }

  async getEnvelope(recordId: string): Promise<Envelope | null> {
    const res = await this.db.query<RawRow>("select * from record_runtime where record_id = $1", [recordId]);
    return res.rows.length ? rowToEnvelope(res.rows[0]) : null;
  }

  async getRecord(recordId: string): Promise<RadiaRecord | null> {
    const res = await this.db.query<RawRow>("select * from records where id = $1", [recordId]);
    return res.rows.length ? rowToRecord(res.rows[0]) : null;
  }

  async childrenOf(recordId: string): Promise<RadiaRecord[]> {
    // parent_ids is a JSON text array of quoted ids; a LIKE on `"<id>"` finds children.
    const res = await this.db.query<RawRow>("select * from records where parent_ids like $1", [`%"${recordId}"%`]);
    return res.rows.map(rowToRecord);
  }

  async getEvents(afterSeq: number, limit: number): Promise<SpaceEvent[]> {
    const res = await this.db.query<RawRow>(
      "select seq, id, ts, run_id, operation, record_id, kind, state, detail from events where seq > $1 order by seq asc limit $2",
      [afterSeq, limit],
    );
    return res.rows.map(rowToEvent);
  }

  async latestEventSeq(): Promise<number> {
    const res = await this.db.query<{ seq: number }>("select coalesce(max(seq), 0)::int as seq from events");
    return res.rows[0].seq;
  }

  async putKind(kind: string, defJson: string): Promise<void> {
    await this.db.query(
      "insert into kinds (kind, def) values ($1, $2) on conflict (kind) do update set def = excluded.def",
      [kind, defJson],
    );
  }

  async loadKinds(): Promise<string[]> {
    const res = await this.db.query<{ def: string }>("select def from kinds order by kind");
    return res.rows.map((r) => r.def);
  }

  private async appendEvent(tx: Transaction, e: EventInput, ts: string): Promise<void> {
    await tx.query(
      "insert into events (id, ts, run_id, operation, record_id, kind, state, detail) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [newUlid(), ts, e.runId, e.operation, e.recordId ?? null, e.kind ?? null, e.state ?? null, e.detail ? JSON.stringify(e.detail) : null],
    );
  }

  private async fetchCandidates(tx: Transaction, selector: TakeSelector): Promise<Candidate[]> {
    const rows = "recordId" in selector
      ? (await tx.query<RawRow>(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.id=$1 and rt.state in ('available','leased')`,
        [selector.recordId],
      )).rows
      : (await tx.query<RawRow>(
        `select ${CANDIDATE_COLS} from records r join record_runtime rt on rt.record_id=r.id
           where r.kind=$1 and rt.state in ('available','leased')`,
        [selector.template.kind],
      )).rows;
    return rows.map((row) => ({ record: rowToRecord(row), env: rowToEnvelope(row) }));
  }

  private async fetchEnvelopeRow(tx: Transaction, recordId: string): Promise<RawRow | null> {
    const res = await tx.query<RawRow>("select * from record_runtime where record_id = $1", [recordId]);
    return res.rows[0] ?? null;
  }

  private async insertRecord(tx: Transaction, input: PutInput): Promise<void> {
    for (const pid of input.record.runtimeMeta.parentIds) {
      const res = await tx.query("select 1 from records where id = $1", [pid]);
      if (res.rows.length === 0) throw new RadiaError("parent_not_found", `parent ${pid} does not exist`);
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

  // Idempotency wrapper. Runs INSIDE the op's transaction and checks the stored response
  // BEFORE the effect (which includes lease validation), so a retry replays the original
  // outcome. A key reused with a different request is a conflict.
  private async withIdem<T>(tx: Transaction, idem: IdempotencyKey | undefined, run: () => Promise<T>): Promise<T> {
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
    await tx.query(
      "insert into idempotency (principal, operation, idem_key, request_hash, response_json) values ($1,$2,$3,$4,$5)",
      [idem.principal, idem.operation, idem.key, idem.requestHash, JSON.stringify(result)],
    );
    return result;
  }

  private leaseValid(row: RawRow | null, ref: LeaseRef): boolean {
    return row !== null &&
      row.state === "leased" &&
      String(row.lease_id) === ref.leaseId &&
      Number(row.lease_epoch) === ref.epoch;
  }

  private get db(): PGlite {
    if (!this.#db) throw new Error("PgliteAdapter not initialized");
    return this.#db;
  }
}
