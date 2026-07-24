// HTTP handlers for the take/lease data plane. The lease the client holds is echoed back
// in the body of settlement calls (renew/ack/nack/release); fencing checks its
// recordId+leaseId+epoch. `lease_lost` is returned as a 200 status body, not an error.

import type { Space, TakeInput } from "../../core/space.ts";
import type { Lease } from "../../storage/adapter.ts";
import type { PutRequest } from "../../core/record.ts";
import { combineMatch, type Template } from "../../core/matching.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem } from "../problem.ts";

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await req.json();
    return j && typeof j === "object" && !Array.isArray(j) ? j as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function idemKey(req: Request): string | undefined {
  return req.headers.get("Idempotency-Key") ?? undefined;
}

/** Run a settlement, mapping an idempotency conflict to 409 and a delegation denial to 403. */
async function settle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof RadiaError && e.code === "idempotency_conflict") return problem(409, e.code, e.message);
    if (e instanceof RadiaError && e.code === "forbidden") return problem(403, e.code, e.message);
    throw e;
  }
}

function parseLease(j: Record<string, unknown>): Lease | null {
  const l = j.lease as Record<string, unknown> | undefined;
  if (!l || typeof l.recordId !== "string" || typeof l.leaseId !== "string" || typeof l.epoch !== "number") {
    return null;
  }
  return {
    recordId: l.recordId,
    leaseId: l.leaseId,
    epoch: l.epoch,
    ownerRun: String(l.ownerRun ?? ""),
    expiresAt: String(l.expiresAt ?? ""),
  };
}

export async function handleTake(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");

  const recordId = typeof j.recordId === "string" ? j.recordId : undefined;
  let template = (j.template && typeof j.template === "object") ? j.template as Template : undefined;
  if (!recordId && !template) {
    return problem(400, "invalid_selector", "take requires `template` or `recordId`");
  }

  const leaseSeconds = typeof j.leaseSeconds === "number" && j.leaseSeconds > 0 ? j.leaseSeconds : undefined;
  const requireUntainted = j.requireUntainted === true;
  try {
    // Authorize on the kind (from the template, or the record's own kind for a record-id take).
    let kind = template?.kind;
    if (!kind && recordId) kind = (await space.getRecord(recordId))?.kind;
    if (kind) {
      const constraint = await space.authorize(principal, "take", kind);
      // A template-scoped grant narrows the claim: the record must also match the grant (grant ∧
      // request). For a record-id take that means synthesizing a template the record must satisfy.
      if (constraint) {
        template = { kind, match: combineMatch(template?.match, constraint), orderBy: template?.orderBy };
      }
    }
    const sel: TakeInput = recordId ? { recordId, template } : { template: template! };
    const result = await space.take(sel, { leaseSeconds, requireUntainted }, principal);
    return ok(result); // {record, lease} or null
  } catch (e) {
    if (e instanceof RadiaError) return problem(e.code === "forbidden" ? 403 : 400, e.code, e.message);
    throw e;
  }
}

export async function handleAck(space: Space, req: Request): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  const result = j.result as PutRequest | undefined;
  return settle(() => space.ack(lease, result, idemKey(req)));
}

export async function handleNack(space: Space, req: Request): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  const backoffSeconds = typeof j.backoffSeconds === "number" ? j.backoffSeconds : undefined;
  return settle(() => space.nack(lease, { backoffSeconds }, idemKey(req)));
}

export async function handleRelease(space: Space, req: Request): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  return settle(() => space.release(lease, idemKey(req)));
}

export async function handleRenew(space: Space, req: Request): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  const leaseSeconds = typeof j.leaseSeconds === "number" && j.leaseSeconds > 0 ? j.leaseSeconds : undefined;
  return settle(() => space.renew(lease, { leaseSeconds }, idemKey(req)));
}
