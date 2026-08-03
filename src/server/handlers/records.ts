// HTTP handlers for the record data plane: put and read_one.
//
// The put handler is where client-supplied authoritative fields are dropped: it builds a
// PutRequest by PICKING ONLY client-submittable fields from the wire JSON. Anything else
// the client sends (createdBy, runtimeMeta, schemaVersion, taint, ...) is ignored, so the
// server-side metadata assignment in core/record.ts is authoritative.

import type { Space } from "../../core/space.ts";
import { clientTaint } from "../../core/kinds.ts";

/** `taint` in a JSON body is an ARRAY of labels. A bare string is refused rather than parsed as a
 *  comma list (that leniency exists for headers, which can only carry strings): a wrong-typed field
 *  is a caller believing it restricted a record, and silently reading it as "no raise" is the
 *  fail-open behaviour the label vocabulary exists to end. */
function bodyTaint(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new RadiaError("invalid_taint", "taint must be an array of labels");
  return clientTaint(raw);
}
import type { PutRequest } from "../../core/record.ts";
import { combineMatch, type Pattern } from "../../core/matching.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem, statusFor } from "../problem.ts";

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await req.json();
    return j && typeof j === "object" && !Array.isArray(j)
      ? j as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Build a `PutRequest` from wire JSON: pick only client-submittable fields, and VALIDATE their
 * types rather than casting. A cast is a promise to the type checker, not a check. Otherwise
 * `parentIds: 42` or `deadlineAt: {}` sails through and fails deep in the adapter, turning a
 * malformed request into a 500. Returns a problem message instead of throwing so the caller can
 * answer 400.
 */
function pickPut(j: Record<string, unknown>): PutRequest | string {
  if (typeof j.kind !== "string" || j.kind.length === 0) return "kind must be a non-empty string";
  if (j.parentIds !== undefined) {
    if (!Array.isArray(j.parentIds) || j.parentIds.some((p) => typeof p !== "string")) {
      return "parentIds must be an array of record ids";
    }
  }
  for (const field of ["deadlineAt", "retentionUntil"] as const) {
    const v = j[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return `${field} must be an ISO-8601 timestamp`;
  }
  if (j.clientMeta !== undefined && (typeof j.clientMeta !== "object" || j.clientMeta === null || Array.isArray(j.clientMeta))) {
    return "clientMeta must be an object";
  }
  return {
    kind: j.kind,
    body: j.body,
    clientMeta: j.clientMeta as Record<string, unknown> | undefined,
    parentIds: j.parentIds as string[] | undefined,
    deadlineAt: j.deadlineAt as string | undefined,
    retentionUntil: j.retentionUntil as string | undefined,
    // A client may RAISE labels on its own output and never clear one: raising is monotone, so it
    // needs no trust, while removal is declassify and privileged.
    taint: bodyTaint(j.taint),
  };
}

/** The same validation for a result record emitted with `ack`, which is a PutRequest too. */
export function pickResult(v: unknown): PutRequest | string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return "result must be an object";
  return pickPut(v as Record<string, unknown>);
}

export async function handlePut(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");

  const put = pickPut(j);
  if (typeof put === "string") return problem(400, "invalid_body", put);

  try {
    const constraint = await space.authorize(principal, "put", put.kind);
    if (constraint && !space.bodyMatchesGrant(put.kind, put.body, constraint)) {
      return problem(403, "forbidden", `record body is outside the pattern scope of your put grant for '${put.kind}'`);
    }
    const { id } = await space.put(put, req.headers.get("Idempotency-Key") ?? undefined, principal);
    return new Response(JSON.stringify({ id }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 422), e.code, e.message);
    throw e;
  }
}

/**
 * What a grant narrowed this read to, when it narrowed anything.
 *
 * A read that narrows silently makes a scoped caller confidently wrong: one whose grants limit
 * `message` to a single conversation queries `message`, gets its own conversation, and cannot tell
 * that from "this is every message there is". It then reports its slice as the space and goes
 * looking for a grant to fix a gap it cannot see. The ops plane says this; so must this plane.
 *
 * Absent when nothing was narrowed, so an unrestricted read stays exactly as it was on the wire.
 */
function describeReadScope(
  constraint: Record<string, unknown>[] | null,
  authors: string[] | undefined,
): { scope?: { narrowedBy?: Record<string, unknown>[]; ownRecordsOnly?: true; note: string } } {
  const patterns = (constraint ?? []).filter((t) => Object.keys(t).length > 0);
  if (patterns.length === 0 && !authors) return {};
  return {
    scope: {
      ...(patterns.length > 0 ? { narrowedBy: patterns } : {}),
      ...(authors ? { ownRecordsOnly: true as const } : {}),
      note: "your grant narrows this read. Records outside it are not returned and are not counted. " +
        "This is a slice, not the whole kind.",
    },
  };
}

export async function handleQuery(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  if (typeof j.kind !== "string" || j.kind.length === 0) {
    return problem(400, "invalid_pattern", "pattern.kind must be a non-empty string");
  }
  const pattern: Pattern = {
    kind: j.kind,
    match: j.match as Record<string, unknown> | undefined,
    orderBy: j.orderBy as Pattern["orderBy"],
  };
  const limit = typeof j.limit === "number" && j.limit > 0 ? Math.min(j.limit, 500) : 100;
  // Keyset page. Validated at the boundary rather than cast: `after` reaching SQL as a non-string
  // and `dir` as anything but asc/desc are exactly the shapes that turn a bad request into a 500.
  if (j.after !== undefined && typeof j.after !== "string") {
    return problem(400, "invalid_pattern", "after must be a record id string");
  }
  if (j.dir !== undefined && j.dir !== "asc" && j.dir !== "desc") {
    return problem(400, "invalid_pattern", "dir must be 'asc' or 'desc'");
  }
  const page = j.after !== undefined || j.dir !== undefined
    ? { after: j.after as string | undefined, dir: j.dir as "asc" | "desc" | undefined }
    : undefined;
  try {
    // Both halves of the read scope in one call. A self-scoped grant narrows the coordination
    // plane too, and asking for the pattern alone is how that gets forgotten.
    const { constraint, createdBy } = await space.readAccess(principal, "query", pattern.kind);
    if (constraint) pattern.match = combineMatch(pattern.match, constraint); // grant ∧ request
    const records = await space.query(pattern, limit, page, createdBy ? { createdBy } : undefined);
    // The cursor for the NEXT page is the last id of this one, echoed so a caller never has to
    // know that the cursor happens to be a record id.
    // `explain: true` annotates the answer with the traps this query walked into. Opt-in so the
    // hot path pays nothing, and never affects the result.
    const explain = j.explain === true ? space.explainQuery(pattern, records.length, limit, page) : [];
    return Response.json({
      records,
      nextAfter: records.length === limit ? records[records.length - 1]?.id : undefined,
      ...describeReadScope(constraint, createdBy),
      ...(explain.length > 0 ? { explain } : {}),
    });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}

export async function handleReadOne(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  if (typeof j.kind !== "string" || j.kind.length === 0) {
    return problem(400, "invalid_pattern", "pattern.kind must be a non-empty string");
  }

  const pattern: Pattern = {
    kind: j.kind,
    match: j.match as Record<string, unknown> | undefined,
    orderBy: j.orderBy as Pattern["orderBy"],
  };
  try {
    const { constraint, createdBy } = await space.readAccess(principal, "read_one", pattern.kind);
    if (constraint) pattern.match = combineMatch(pattern.match, constraint); // grant ∧ request
    const record = await space.readOne(pattern, createdBy ? { createdBy } : undefined);
    return Response.json(record); // null serializes to `null`
  } catch (e) {
    // Pattern validation failures (undeclared_path, unknown_kind, ...) are client errors.
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}
