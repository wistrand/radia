// Registry projections — turning immutable records into a current view.
//
// Several things in Radia are REGISTRIES: a mutable-looking table (declared kinds, advertised
// capabilities, live models, assigned grants, saved procedures) that is really a projection over
// an append-only record stream. Records never change, so "update" is a successor record and the
// projection decides which one counts.
//
// That projection was hand-rolled in six places before this file existed, and it is easy to get
// subtly wrong in ways nothing catches: compare ids the wrong way and you keep the older record;
// depend on the order rows arrive in and a retirement can be resurrected by an older record
// processed after it, quietly bringing back a thing someone withdrew.
//
// TWO SHAPES, and using the wrong one is a correctness bug rather than a style choice:
//
//   latest-wins  (`activeByKey`)  — one entry per key; a re-declaration REPLACES.
//                                   kind_def (by kind), capability (by tool), model (by tier),
//                                   procedure (by name).
//   additive     (`activeSet`)    — many entries coexist; each is independently withdrawable.
//                                   grant: a principal may hold several grants on one kind, so
//                                   "latest per (principal, kind)" would silently discard the
//                                   others. The logical key is the grant's whole content.
//
// RETIREMENT is a property of the projection, not of the runtime. `{retired: true}` on a successor
// body means "this key is no longer active"; the runtime never interprets it (bodies stay opaque
// data — see the templates-are-data invariant), it is honoured here, in the projection, once.
// Nothing is deleted: the history stays queryable, the event log stays complete, and re-declaring
// a retired key revives it because that record is newer still — so there is no un-retire path to
// implement or to get wrong.

import type { RadiaRecord } from "../storage/adapter.ts";

/** The body field that withdraws a registry entry. A convention honoured by the projections here,
 *  never by the matching layer. */
export const RETIRED = "retired";

export function isRetired(body: unknown): boolean {
  return (body as Record<string, unknown> | null)?.[RETIRED] === true;
}

/**
 * The newest record per key, retired or not. Use when you need to see a withdrawal — deciding
 * whether to report "already retired", or auditing what a key used to be.
 *
 * Order-independent by construction: it compares ids (ULIDs, so the highest is newest) instead of
 * trusting the order the caller happened to read records in.
 */
export function newestByKey<T = unknown>(
  records: RadiaRecord[],
  keyOf: (body: T, record: RadiaRecord) => string | undefined,
): Map<string, RadiaRecord> {
  const out = new Map<string, RadiaRecord>();
  for (const r of records) {
    const key = keyOf(r.body as T, r);
    if (key === undefined) continue;
    const prev = out.get(key);
    if (!prev || prev.id < r.id) out.set(key, r);
  }
  return out;
}

/**
 * LATEST-WINS: the current record per key, with retired keys dropped.
 *
 * Retirement is applied AFTER the newest-per-key pass, never as a filter over the input — filtering
 * first would let an older, non-retired record become "newest" and resurrect the entry.
 */
export function activeByKey<T = unknown>(
  records: RadiaRecord[],
  keyOf: (body: T, record: RadiaRecord) => string | undefined,
): Map<string, RadiaRecord> {
  const newest = newestByKey(records, keyOf);
  for (const [key, rec] of newest) if (isRetired(rec.body)) newest.delete(key);
  return newest;
}

/**
 * ADDITIVE: every entry that is still in force, where entries coexist rather than replace.
 *
 * Same rule applied per logical key — the difference is only that the key identifies one ENTRY
 * (a grant's whole content) rather than a slot (a kind name). Retiring one leaves the rest alone,
 * which is exactly what revoking a single grant must do.
 */
export function activeSet<T = unknown>(
  records: RadiaRecord[],
  keyOf: (body: T, record: RadiaRecord) => string | undefined,
): RadiaRecord[] {
  return [...activeByKey(records, keyOf).values()];
}

/**
 * The logical identity of a grant: everything that decides what it permits.
 *
 * A principal may hold several grants on one kind (different operations, different template
 * scopes), so this — not `(principal, kind)` — is what a retraction targets. Operations are sorted
 * so that the same grant written with the operations in a different order is the same entry.
 */
export function grantKey(body: unknown): string | undefined {
  const g = body as { principal?: unknown; kind?: unknown; operations?: unknown; template?: unknown };
  if (typeof g?.principal !== "string" || typeof g?.kind !== "string") return undefined;
  const ops = Array.isArray(g.operations) ? [...g.operations].map(String).sort().join(",") : "";
  // JSON-encoded parts, not a delimiter-joined string. The separator here was a NUL, which was
  // invisible in review and harmless while this was only an in-memory Map key — until the key was
  // used as an idempotency key and reached Postgres, which rejects 0x00 in text outright. An
  // encoded array is unambiguous (no value can forge a boundary) and printable.
  return JSON.stringify([g.principal, g.kind, ops, g.template ?? null]);
}

/** What a registry read produced, and whether it saw everything. */
export interface RegistryView {
  /** Current entry per key, retired ones dropped. */
  entries: Map<string, RadiaRecord>;
  /** False when the scan hit its cap before exhausting the kind — the view may be missing entries,
   *  and a caller that treats it as authoritative would be guessing. */
  complete: boolean;
  scanned: number;
}

/** Pages one registry read takes before giving up. Generous: a content-keyed registry holds one
 *  record per entry, so exhausting it is normally a single page. */
const REGISTRY_PAGE = 500;
const REGISTRY_MAX_PAGES = 40;

/**
 * Read a registry COMPLETELY, newest-first, and project it.
 *
 * This exists because the same mistake was made eleven times: writes to a registry are unbounded,
 * reads were bounded, and nothing connected the two. A capped read returns the OLDEST matches by
 * default, so the newest record — a retirement, a revocation, a re-declaration, the tool published
 * a minute ago — was exactly what fell off the end. The failure is silent in both directions: an
 * entry that should be gone stays live, and an entry that should be live is missing.
 *
 * Two properties make it safe rather than merely convenient. It pages to EXHAUSTION, so the answer
 * does not depend on a limit someone guessed at the call site; and when it cannot exhaust, it says
 * so (`complete: false`) instead of returning a plausible prefix. Callers that authorize on this
 * must treat an incomplete view as a reason to refuse widening, never as a full picture.
 *
 * `read(limit, after)` must return records NEWEST-FIRST, `after` being the last id of the previous
 * page — i.e. a keyset page with `dir: "desc"`.
 */
export async function readRegistry<T = unknown>(
  read: (limit: number, after?: string) => Promise<RadiaRecord[]>,
  keyOf: (body: T, record: RadiaRecord) => string | undefined,
): Promise<RegistryView> {
  const all: RadiaRecord[] = [];
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < REGISTRY_MAX_PAGES; page++) {
    const rows = await read(REGISTRY_PAGE, after);
    all.push(...rows);
    if (rows.length < REGISTRY_PAGE) {
      complete = true;
      break;
    }
    after = rows[rows.length - 1].id;
  }
  return { entries: activeByKey(all, keyOf), complete, scanned: all.length };
}
