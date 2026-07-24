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
import { problem } from "../problem.ts";

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

/** Map a RadiaError to a status: forbidden→403, idempotency_conflict→409, else the fallback. */
function statusFor(code: string, fallback: number): number {
  if (code === "forbidden") return 403;
  if (code === "idempotency_conflict") return 409;
  return fallback;
}

export async function handlePut(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await readJson(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");

  // Pick only client-submittable fields. Authoritative fields are never read from input.
  const put: PutRequest = {
    kind: j.kind as string,
    body: j.body,
    clientMeta: j.clientMeta as Record<string, unknown> | undefined,
    parentIds: j.parentIds as string[] | undefined,
    deadlineAt: j.deadlineAt as string | undefined,
    retentionUntil: j.retentionUntil as string | undefined,
    taint: j.taint === true ? true : undefined, // client may RAISE taint only; never clear it
  };

  try {
    await space.authorize(principal, "put", put.kind);
    const { id } = await space.put(put, req.headers.get("Idempotency-Key") ?? undefined);
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
  try {
    const constraint = await space.authorize(principal, "query", template.kind);
    if (constraint) template.match = combineMatch(template.match, constraint); // grant ∧ request
    const records = await space.query(template, limit);
    return Response.json({ records });
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
    const record = await space.readOne(template);
    return Response.json(record); // null serializes to `null`
  } catch (e) {
    // Template validation failures (undeclared_path, unknown_kind, ...) are client errors.
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}
