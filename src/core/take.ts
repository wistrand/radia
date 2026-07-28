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
  requireUntainted = false,
  createdBy?: string[],
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    if (match && !matchesRecord(c.record, match)) continue;
    if (requireUntainted && c.record.runtimeMeta.taint) continue; // sensitive consumer skips tainted work
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
