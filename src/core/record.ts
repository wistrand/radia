// Building a committed record from a client put request.
//
// This is where the hard client-vs-runtime metadata split (CLAUDE.md invariant) lives:
// PutRequest carries ONLY client-submittable fields. Every authoritative field is
// assigned here, server-side, and can never come from the client. The HTTP handler is
// responsible for constructing PutRequest by picking only these fields from the wire
// JSON, so a client that sends `createdBy` or `runtimeMeta` has them ignored.

import type { RadiaRecord } from "../storage/adapter.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";

/** The only fields a client may submit. Claims, not authority. */
export interface PutRequest {
  kind: string;
  body: unknown;
  /** Client claims: confidence, requested_priority, app fields. Preserved, never trusted. */
  clientMeta?: Record<string, unknown>;
  /** Data/causality lineage the client asserts. All must exist at commit (checked in put). */
  parentIds?: string[];
  deadlineAt?: string;
  retentionUntil?: string;
}

export interface BuildContext {
  principal: string; // server-known caller (auto-provisioned locally in M0)
  schemaVersion: number; // post-validation schema version (registry lands in M1)
  now: string; // DB clock, ISO 8601
}

export interface BuiltRecord {
  record: RadiaRecord;
  /** Exact serialized body that bodySha256 is computed over; the adapter stores it verbatim. */
  bodyJson: string;
}

export async function buildRecord(
  req: PutRequest,
  ctx: BuildContext,
): Promise<BuiltRecord> {
  if (typeof req.kind !== "string" || req.kind.length === 0) {
    throw new RadiaError("invalid_kind", "record.kind must be a non-empty string");
  }

  const id = newUlid();
  const bodyJson = JSON.stringify(req.body ?? null);
  const bodySha256 = await sha256Hex(bodyJson);

  const parentIds = req.parentIds ?? [];
  if (parentIds.includes(id)) {
    // Unreachable while ids are server-assigned, but the invariant is explicit.
    throw new RadiaError("self_parent", "a record cannot be its own parent");
  }

  const record: RadiaRecord = {
    id,
    kind: req.kind,
    body: req.body ?? null,
    bodySha256,
    clientMeta: req.clientMeta, // preserved as claims
    runtimeMeta: {
      // ---- all server-assigned, never client-editable ----
      createdBy: ctx.principal,
      delegationContext: undefined, // derived from a lease; N/A for a direct put
      parentIds,
      taint: false, // server-computed; full taint model is M3
      schemaVersion: ctx.schemaVersion,
      createdAt: ctx.now,
    },
    deadlineAt: req.deadlineAt,
    retentionUntil: req.retentionUntil,
  };

  return { record, bodyJson };
}
