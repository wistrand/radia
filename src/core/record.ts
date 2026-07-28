// Building a committed record from a client put request.
//
// This is where the hard client-vs-runtime metadata split (CLAUDE.md invariant) lives:
// PutRequest carries ONLY client-submittable fields. Every authoritative field is
// assigned here, server-side, and can never come from the client. The HTTP handler is
// responsible for constructing PutRequest by picking only these fields from the wire
// JSON, so a client that sends `createdBy` or `runtimeMeta` has them ignored.

import type { DelegationContext, RadiaRecord } from "../storage/adapter.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";

/** A genuine U+0000 escape in serialized JSON: an EVEN number of preceding backslashes. The literal
 *  six-character text that spells the escape has an odd run and must stay storable. */
const NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000/;

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
  /** Source attestation: a client may RAISE taint (`true`) to mark its output as untrusted data.
   *  `false`/absent is ignored. The server never lets a client clear taint (only declassify does). */
  taint?: boolean;
}

export interface BuildContext {
  principal: string; // server-known caller (auto-provisioned locally in M0)
  schemaVersion: number; // post-validation schema version (registry lands in M1)
  now: string; // DB clock, ISO 8601
  /** Server-derived authority chain. Set only for work emitted under a lease (ack). */
  delegationContext?: DelegationContext;
  /** Server-computed taint (client-raise OR any data-parent tainted). Defaults untainted. */
  taint?: boolean;
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
  // U+0000 is valid in a JSON string and CANNOT be represented in Postgres `jsonb`. Postgres and
  // PGlite parse bodies into `body_jsonb` for predicate pushdown, so such a body is unstorable
  // there (and fails as a 500 from deep inside the driver) while SQLite accepts it. Rejected
  // here, in core, so every adapter agrees and the caller gets an answer, not an internal error.
  //
  // The pattern matches a genuine NUL ESCAPE: an even number of preceding backslashes. The literal
  // six-character text that spells the escape serializes with a doubled backslash and stays storable.
  if (NUL_ESCAPE.test(bodyJson)) {
    throw new RadiaError(
      "invalid_body",
      "record bodies may not contain U+0000 (NUL): valid JSON, but it has no representation in the storage layer's JSON type",
    );
  }
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
      delegationContext: ctx.delegationContext, // server-derived from the lease (ack); undefined for a direct put
      parentIds,
      taint: ctx.taint ?? false, // server-computed: client-raise OR any data-parent tainted; cleared only by declassify
      schemaVersion: ctx.schemaVersion,
      createdAt: ctx.now,
    },
    deadlineAt: req.deadlineAt,
    retentionUntil: req.retentionUntil,
  };

  return { record, bodyJson };
}
