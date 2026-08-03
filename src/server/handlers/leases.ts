// HTTP handlers for the take/lease data plane. The lease the client holds is echoed back
// in the body of settlement calls (renew/ack/nack/release); fencing checks its
// recordId+leaseId+epoch. `lease_lost` is returned as a 200 status body, not an error.

import type { Space, TakeInput } from "../../core/space.ts";
import type { Lease } from "../../storage/adapter.ts";
import type { PutRequest } from "../../core/record.ts";
import { combineMatch, type Pattern } from "../../core/matching.ts";
import { RadiaError } from "../../core/errors.ts";
import { pickResult } from "./records.ts";
import { clientTaint } from "../../core/kinds.ts";

/**
 * Both taint barriers at once: the caller's own and the one its grants impose.
 *
 * INTERSECTION, not union. A caller may narrow what it is willing to receive and may never widen
 * past what its grants permit, so `undefined` (no barrier) on either side falls through to the
 * other and two lists meet in the middle.
 */
function intersectAllow(caller: string[] | undefined, grant: string[] | undefined): string[] | undefined {
  if (!caller) return grant;
  if (!grant) return caller;
  return caller.filter((l) => grant.includes(l));
}
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
  // `typeof [] === "object"`, so a bare object check lets `pattern: []` and `pattern: {}` through
  // to the matcher with no kind. That is a 500 for what is plainly a bad request.
  // Present-but-invalid is rejected rather than silently ignored: dropping it would claim a
  // different record than asked.
  let pattern: Pattern | undefined;
  if (j.pattern !== undefined && j.pattern !== null) {
    const t = j.pattern as Record<string, unknown>;
    if (typeof t !== "object" || Array.isArray(t) || typeof t.kind !== "string" || t.kind.length === 0) {
      return problem(400, "invalid_pattern", "pattern.kind must be a non-empty string");
    }
    pattern = t as unknown as Pattern;
  }
  if (!recordId && !pattern) {
    return problem(400, "invalid_selector", "take requires `pattern` or `recordId`");
  }

  const leaseSeconds = typeof j.leaseSeconds === "number" && j.leaseSeconds > 0 ? j.leaseSeconds : undefined;
  // The caller's own barrier: the labels it is willing to receive. `requireUntainted: true` used to
  // mean "none"; the same intent is now an empty allowlist, stated as a list.
  const callerAllow = j.requireUntainted === true ? [] : clientTaint(j.allowTaint);
  try {
    // Authorize on the kind (from the pattern, or the record's own kind for a record-id take).
    let kind = pattern?.kind;
    if (!kind && recordId) kind = (await space.getRecord(recordId))?.kind;
    let createdBy: string[] | undefined;
    let grantAllow: string[] | undefined;
    if (kind) {
      const access = await space.readAccess(principal, "take", kind);
      // A pattern-scoped grant narrows the claim: the record must also match the grant (grant ∧
      // request). For a record-id take that means synthesizing a pattern the record must satisfy.
      if (access.constraint) {
        pattern = { kind, match: combineMatch(pattern?.match, access.constraint), orderBy: pattern?.orderBy };
      }
      // A claim returns the record BODY, so a self scope has to narrow `take` exactly as it
      // narrows `query`. Otherwise draining the queue reads every record of the kind. It cannot
      // ride in the pattern: `created_by` is envelope metadata, which patterns never see.
      createdBy = access.createdBy;
      // The grant's barrier is ORed with the caller's own flag: a worker may always be MORE
      // careful than its grants require, never less. Without this, `scope: {taint: "none"}` would
      // be advice rather than enforcement.
      grantAllow = access.allowTaint;
    }
    const sel: TakeInput = recordId ? { recordId, pattern } : { pattern: pattern! };
    const result = await space.take(
      sel,
      // Both barriers apply, and the effective allowlist is their INTERSECTION: the caller may
      // narrow what it accepts, and may never widen past what its grants permit.
      { leaseSeconds, allowTaint: intersectAllow(callerAllow, grantAllow), createdBy },
      principal,
    );
    return ok(result); // {record, lease} or null
  } catch (e) {
    if (e instanceof RadiaError) return problem(e.code === "forbidden" ? 403 : 400, e.code, e.message);
    throw e;
  }
}

export async function handleAck(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  // The ack result is a PutRequest, so it needs the same type checking as a direct put. Without
  // it a malformed result record fails inside the adapter as a 500 instead of a 400.
  const result = pickResult(j.result);
  if (typeof result === "string") return problem(400, "invalid_body", result);
  return settle(() => space.ack(lease, result, idemKey(req), principal));
}

export async function handleNack(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  const backoffSeconds = typeof j.backoffSeconds === "number" ? j.backoffSeconds : undefined;
  return settle(() => space.nack(lease, { backoffSeconds }, idemKey(req), principal));
}

export async function handleRelease(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  return settle(() => space.release(lease, idemKey(req), principal));
}

export async function handleRenew(space: Space, req: Request, principal: string): Promise<Response> {
  const j = await body(req);
  if (!j) return problem(400, "invalid_body", "expected a JSON object");
  const lease = parseLease(j);
  if (!lease) return problem(400, "invalid_lease", "missing or malformed lease");
  const leaseSeconds = typeof j.leaseSeconds === "number" && j.leaseSeconds > 0 ? j.leaseSeconds : undefined;
  return settle(() => space.renew(lease, { leaseSeconds }, idemKey(req), principal));
}
