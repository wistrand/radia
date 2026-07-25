// Shared row <-> record mapping and insert-value builders, used by every adapter so the
// column contract can't drift between backends. SQL dialect (placeholders, types,
// transactions) stays in each adapter; the value ordering and reconstruction live here.

import type { Envelope, PutInput, RadiaRecord, SpaceEvent } from "./adapter.ts";

export type RawRow = Record<string, unknown>;

/** Reconstruct a SpaceEvent from an `events` row. */
export function rowToEvent(row: RawRow): SpaceEvent {
  return {
    seq: Number(row.seq),
    cursor: String(row.cursor ?? row.seq), // opaque; pg aliases the xid watermark as `cursor`, sqlite → seq

    id: String(row.id),
    ts: String(row.ts),
    runId: String(row.run_id),
    operation: String(row.operation),
    recordId: row.record_id != null ? String(row.record_id) : undefined,
    kind: row.kind != null ? String(row.kind) : undefined,
    state: row.state != null ? String(row.state) as SpaceEvent["state"] : undefined,
    detail: row.detail != null ? JSON.parse(String(row.detail)) : undefined,
  };
}

/** Column order for `records` inserts. Must match recordInsertValues(). */
export const RECORD_COLUMNS =
  "id, kind, body_json, body_sha256, client_meta, created_by, delegation_context, " +
  "parent_ids, taint, schema_version, created_at, deadline_at, retention_until";

export const RECORD_COLUMN_COUNT = 13;

/** Values for a `records` insert, in RECORD_COLUMNS order. `taint` is a boolean; the
 *  SQLite adapter maps booleans to 0/1 (SQLite has no boolean type). */
export function recordInsertValues(input: PutInput): unknown[] {
  const r = input.record;
  return [
    r.id,
    r.kind,
    input.bodyJson,
    r.bodySha256,
    r.clientMeta ? JSON.stringify(r.clientMeta) : null,
    r.runtimeMeta.createdBy,
    r.runtimeMeta.delegationContext ? JSON.stringify(r.runtimeMeta.delegationContext) : null,
    JSON.stringify(r.runtimeMeta.parentIds),
    r.runtimeMeta.taint,
    r.runtimeMeta.schemaVersion,
    r.runtimeMeta.createdAt,
    r.deadlineAt ?? null,
    r.retentionUntil ?? null,
  ];
}

/** Values for a `record_runtime` insert. state='available' and attempt=0 are SQL literals
 *  in each adapter, so they are not included here. Order:
 *  (record_id, kind, available_at, claim_until, deadline_at, effective_priority). */
export function runtimeInsertValues(input: PutInput): unknown[] {
  const e = input.envelope;
  return [
    input.record.id,
    e.kind,
    e.availableAt,
    e.claimUntil ?? null,
    e.deadlineAt ?? null,
    e.effectivePriority,
  ];
}

/** Reconstruct a RadiaRecord from a `records` row. Tolerates both backends' types
 *  (Postgres boolean vs SQLite 0/1 for taint; text vs native for the rest). */
export function rowToRecord(row: RawRow): RadiaRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    body: JSON.parse(String(row.body_json)),
    bodySha256: String(row.body_sha256),
    clientMeta: row.client_meta != null
      ? JSON.parse(String(row.client_meta))
      : undefined,
    runtimeMeta: {
      createdBy: String(row.created_by),
      delegationContext: row.delegation_context != null
        ? JSON.parse(String(row.delegation_context))
        : undefined,
      parentIds: JSON.parse(String(row.parent_ids ?? "[]")),
      taint: Boolean(row.taint),
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at),
    },
    deadlineAt: row.deadline_at != null ? String(row.deadline_at) : undefined,
    retentionUntil: row.retention_until != null
      ? String(row.retention_until)
      : undefined,
  };
}

/** Reconstruct an Envelope from a `record_runtime` row. */
export function rowToEnvelope(row: RawRow): Envelope {
  const opt = (v: unknown): string | undefined => (v != null ? String(v) : undefined);
  return {
    recordId: String(row.record_id),
    kind: String(row.kind),
    state: String(row.state) as Envelope["state"],
    attempt: Number(row.attempt),
    availableAt: String(row.available_at),
    claimUntil: opt(row.claim_until),
    deadlineAt: opt(row.deadline_at),
    effectivePriority: Number(row.effective_priority),
    leaseId: opt(row.lease_id),
    leaseEpoch: row.lease_epoch != null ? Number(row.lease_epoch) : undefined,
    leaseOwner: opt(row.lease_owner),
    leasedUntil: opt(row.leased_until),
  };
}

/** `$1, $2, ... $n` for Postgres. */
export function pgPlaceholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
}

/** `?, ?, ... ?` (n times) for SQLite. */
export function qmarks(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
