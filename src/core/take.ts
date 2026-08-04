// Pure claim-ranking: given candidate (record, envelope) pairs and the DB clock, decide
// which are claimable and in what order. Kept out of the adapters so the take policy is
// backend-neutral; the adapter supplies candidates (via SQL) and performs the atomic
// claim on the winner this returns.

import type { CompiledMatch, Envelope, RadiaRecord } from "../storage/adapter.ts";
import { matchesRecord } from "./matching.ts";

export interface Candidate {
  record: RadiaRecord;
  env: Envelope;
}

export interface RankedCandidate extends Candidate {
  /** "available": claim as-is. "expired": prior lease lapsed; reclaim bumps attempt. */
  how: "available" | "expired";
}

/**
 * Filter to claimable candidates and rank them in claim order
 * (effective_priority desc, available_at asc, record id asc: the partial-index order).
 * `match` (when present) is re-checked here; `now` is the DB clock.
 */
export function rankClaimable(
  candidates: Candidate[],
  match: CompiledMatch | undefined,
  now: string,
  allowTaint: string[] | undefined = undefined,
  createdBy?: string[],
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    if (match && !matchesRecord(c.record, match)) continue;
    // The barrier: a candidate is skipped unless every label it carries is on the allowlist. An
    // ALLOWLIST, so a label introduced after this grant was written bars the claim instead of
    // being silently admitted, and the reserved `unknown` (a record written before labels existed)
    // is barred by every allowlist there can be.
    if (allowTaint && c.record.runtimeMeta.taint.some((l) => !allowTaint.includes(l))) continue;
    // A self-scoped grant restricts a claim to the principal's own records. `created_by` is
    // envelope metadata, not body, so no pattern can express this. It has to be a claim filter.
    if (createdBy && !createdBy.includes(c.record.runtimeMeta.createdBy)) continue;
    const e = c.env;
    if (e.state === "available" && e.availableAt <= now) {
      ranked.push({ ...c, how: "available" });
    } else if (e.state === "leased" && e.leasedUntil !== undefined && e.leasedUntil < now) {
      ranked.push({ ...c, how: "expired" });
    }
  }
  ranked.sort((a, b) => {
    if (a.env.effectivePriority !== b.env.effectivePriority) {
      return b.env.effectivePriority - a.env.effectivePriority;
    }
    if (a.env.availableAt !== b.env.availableAt) {
      return a.env.availableAt < b.env.availableAt ? -1 : 1;
    }
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });
  return ranked;
}

/**
 * Where a candidate window stopped, in the claim order's own key.
 *
 * Lives here rather than in an adapter because both of them page the queue by it, and the key must
 * be the ORDER's key: `effective_priority desc, available_at asc, record_id asc`. An offset-based
 * window assumes the rows before it stay put, and in a queue those are exactly the rows other
 * claimers are taking, so each departure shifts the rest forward and a window skips them — a `take`
 * answering "nothing claimable" while work sits in the kind.
 */
export interface ClaimCursor {
  priority: number;
  availableAt: string;
  recordId: string;
}

/** The cursor for the last row a window examined. */
export function cursorOf(c: Candidate): ClaimCursor {
  return { priority: c.env.effectivePriority ?? 0, availableAt: c.env.availableAt, recordId: c.record.id };
}
