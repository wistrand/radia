// HTTP handlers for the record data plane: put and read_one.
//
// The put handler is where client-supplied authoritative fields are dropped: it builds a
// PutRequest by PICKING ONLY client-submittable fields from the wire JSON. Anything else
// the client sends (createdBy, runtimeMeta, schemaVersion, taint, ...) is ignored, so the
// server-side metadata assignment in core/record.ts is authoritative.

import type { Space } from "../../core/space.ts";
import type { PutRequest } from "../../core/record.ts";
import { combineMatch, type Template } from "../../core/matching.ts";
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
 * types rather than casting. A cast is a promise to the type checker, not a check — `parentIds: 42`
 * or `deadlineAt: {}` used to sail through and fail deep in the adapter, turning a malformed
 * request into a 500. Returns a problem message instead of throwing so the caller can answer 400.
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
    taint: j.taint === true ? true : undefined, // client may RAISE taint only; never clear it
  };
}

/** The same validation for a result record emitted with `ack` — it is a PutRequest too. */
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
      return problem(403, "forbidden", `record body is outside the template scope of your put grant for '${put.kind}'`);
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

export async function handleQuery(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  if (typeof j.kind !== "string" || j.kind.length === 0) {
    return problem(400, "invalid_template", "template.kind must be a non-empty string");
  }
  const template: Template = {
    kind: j.kind,
    match: j.match as Record<string, unknown> | undefined,
    orderBy: j.orderBy as Template["orderBy"],
  };
  const limit = typeof j.limit === "number" && j.limit > 0 ? Math.min(j.limit, 500) : 100;
  // Keyset page. Validated at the boundary rather than cast: `after` reaching SQL as a non-string
  // and `dir` as anything but asc/desc are exactly the shapes that turn a bad request into a 500.
  if (j.after !== undefined && typeof j.after !== "string") {
    return problem(400, "invalid_template", "after must be a record id string");
  }
  if (j.dir !== undefined && j.dir !== "asc" && j.dir !== "desc") {
    return problem(400, "invalid_template", "dir must be 'asc' or 'desc'");
  }
  const page = j.after !== undefined || j.dir !== undefined
    ? { after: j.after as string | undefined, dir: j.dir as "asc" | "desc" | undefined }
    : undefined;
  try {
    const constraint = await space.authorize(principal, "query", template.kind);
    if (constraint) template.match = combineMatch(template.match, constraint); // grant ∧ request
    // A self-scoped grant narrows the coordination plane too. Without this, approving "only its own
    // records" scoped the ops plane while `query` still returned every record of the kind.
    const authors = await space.authorScope(principal, "query", template.kind);
    const records = await space.query(template, limit, page, authors ? { createdBy: authors } : undefined);
    // The cursor for the NEXT page is the last id of this one — echoed so a caller never has to
    // know that the cursor happens to be a record id.
    return Response.json({ records, nextAfter: records.length === limit ? records[records.length - 1]?.id : undefined });
  } catch (e) {
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}

export async function handleReadOne(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  if (typeof j.kind !== "string" || j.kind.length === 0) {
    return problem(400, "invalid_template", "template.kind must be a non-empty string");
  }

  const template: Template = {
    kind: j.kind,
    match: j.match as Record<string, unknown> | undefined,
    orderBy: j.orderBy as Template["orderBy"],
  };
  try {
    const constraint = await space.authorize(principal, "read_one", template.kind);
    if (constraint) template.match = combineMatch(template.match, constraint); // grant ∧ request
    const authors = await space.authorScope(principal, "read_one", template.kind);
    const record = await space.readOne(template, authors ? { createdBy: authors } : undefined);
    return Response.json(record); // null serializes to `null`
  } catch (e) {
    // Template validation failures (undeclared_path, unknown_kind, ...) are client errors.
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}
