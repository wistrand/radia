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
  /** Source attestation: classification labels the client RAISES on its own output, from the closed
   *  vocabulary (`TAINT_LABELS`). Raising is monotone, so it needs no trust: a client can only ever
   *  restrict what the record may reach, never widen it. Removal is declassify, and privileged. */
  taint?: string[];
}

export interface BuildContext {
  principal: string; // server-known caller (auto-provisioned locally in M0)
  schemaVersion: number; // post-validation schema version (registry lands in M1)
  now: string; // DB clock, ISO 8601
  /** Server-derived authority chain. Set only for work emitted under a lease (ack). */
  delegationContext?: DelegationContext;
  /** Server-computed labels: the UNION of every data parent's, plus whatever the client raised. */
  taint?: string[];
  /** Largest serialized body accepted, in bytes. See the check in `buildRecord`. */
  maxRecordBytes: number;
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
  // SIZE. A body must stay queryable JSON: it is matched against, returned in pages, and re-sent in
  // whatever context reads it. That is the familiar reason, and it is not the load-bearing one.
  //
  // The erasure boundary is that a PAYLOAD is out of line so it can be destroyed, while a BODY is
  // not, so it cannot (see design-data-model.md). With no limit here, base64ing a secret into a
  // body is the way unerasable data enters a space: `shredArtifact` reaches blobs, and no verb
  // reaches a body. So this limit is not a cost control, it is what keeps the erasure promise
  // true, and it belongs where the serialized form first exists rather than at one entry point.
  //
  // Measured in BYTES of the serialized JSON, not characters: what storage holds and what travels
  // on the wire is the encoded form, and a body of astral-plane characters is twice its length.
  const bodyBytes = new TextEncoder().encode(bodyJson).length;
  if (bodyBytes > ctx.maxRecordBytes) {
    throw new RadiaError(
      "record_too_large",
      `record body is ${bodyBytes} bytes, over the ${ctx.maxRecordBytes} limit. A body this size is ` +
        `a payload in the wrong place: store the bytes as an ARTIFACT and let the record carry ` +
        `{digest, mediaType, size}. A body cannot be erased, and an artifact can.`,
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
      taint: ctx.taint ?? [], // server-computed: union of parents + client raise; cleared only by declassify
      schemaVersion: ctx.schemaVersion,
      createdAt: ctx.now,
    },
    deadlineAt: req.deadlineAt,
    retentionUntil: req.retentionUntil,
  };

  return { record, bodyJson };
}
