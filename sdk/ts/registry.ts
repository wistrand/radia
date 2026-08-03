// Registry projections: turning immutable records into a current view.
//
// Several things in Radia are REGISTRIES: a mutable-looking table (declared kinds, advertised
// capabilities, live models, assigned grants, saved procedures) that is really a projection over
// an append-only record stream. Records never change, so "update" is a successor record and the
// projection decides which one counts.
//
// Never hand-roll that projection at a call site: it is easy to get subtly wrong in ways nothing
// catches. Compare ids the wrong way and you keep the older record;
// depend on the order rows arrive in and a retirement can be resurrected by an older record
// processed after it, quietly bringing back a thing someone withdrew.
//
// TWO SHAPES, and using the wrong one is a correctness bug rather than a style choice:
//
//   latest-wins  (`activeByKey`)  : one entry per key; a re-declaration REPLACES.
//                                   kind_def (by kind), capability (by tool), model (by tier),
//                                   procedure (by name).
//   additive     (`activeSet`)    : many entries coexist; each is independently withdrawable.
//                                   grant: a principal may hold several grants on one kind, so
//                                   "latest per (principal, kind)" would silently discard the
//                                   others. The logical key is the grant's whole content.
//
// RETIREMENT is a property of the projection, not of the runtime. `{retired: true}` on a successor
// body means "this key is no longer active"; the runtime never interprets it (bodies stay opaque
// data; see the patterns-are-data invariant), it is honoured here, in the projection, once.
// Nothing is deleted: the history stays queryable, the event log stays complete, and re-declaring
// a retired key revives it because that record is newer still. There is no un-retire path to
// implement or to get wrong.

import type { RadiaRecord } from "./wire.ts";

/** The body field that withdraws a registry entry. A convention honoured by the projections here,
 *  never by the matching layer. */
export const RETIRED = "retired";

export function isRetired(body: unknown): boolean {
  return (body as Record<string, unknown> | null)?.[RETIRED] === true;
}

/**
 * Which of two records for one key is NEWER: `created_at` first, the id only as a tie-break.
 *
 * `created_at` is stamped by the DATABASE (`Space.putRaw` reads `storage.now()`; all time
 * comparisons use the DB clock), so it is the one ordering every instance agrees on. The id alone
 * is not: a ULID's timestamp comes from the writing PROCESS's clock, so two instances whose clocks
 * differ by a second order a second's worth of writes backwards, and a revocation could lose to
 * the grant it revokes. Skew is the dangerous part, and this removes it.
 *
 * Within one DB millisecond the ids decide, and that is deliberate rather than leftover: ULIDs are
 * monotonic per process, a retire-then-revive pair lands inside one millisecond routinely, and
 * resolving that tie any other way (toward retirement, say) discards real ordering information.
 * That exact "fail-closed" rule was tried and reverted for breaking revival.
 *
 * WHAT THIS STILL IS NOT: commit order. `created_at` is read before the transaction commits, so
 * two instances writing the same key inside one DB millisecond remain a tie broken by id. Closing
 * that needs a comparator the database assigns AT COMMIT — the `xid8` + snapshot-watermark
 * machinery the event cursor already uses (design-storage.md, "Watch delivery under
 * concurrency") — which means carrying that token on the record, i.e. through the frozen wire
 * contract. Not done. The residual race is one millisecond wide instead of one clock-skew wide.
 */
function newer(a: RadiaRecord, b: RadiaRecord): boolean {
  const at = a.runtimeMeta?.createdAt, bt = b.runtimeMeta?.createdAt;
  if (at && bt && at !== bt) return bt > at;
  return a.id < b.id;
}

/**
 * The newest record per key, retired or not. Use when you need to see a withdrawal: deciding
 * whether to report "already retired", or auditing what a key used to be.
 *
 * Order-independent by construction: it compares timestamps and ids (see `newer`) instead of
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
    if (!prev || newer(prev, r)) out.set(key, r);
  }
  return out;
}

/**
 * LATEST-WINS: the current record per key, with retired keys dropped.
 *
 * Retirement is applied AFTER the newest-per-key pass, never as a filter over the input. Filtering
 * first would let an older, non-retired record become "newest" and resurrect the entry.
 *
 * "Newest" is `newer` above: the DB-assigned `created_at`, id as the tie-break. Read that comment
 * before changing this rule; both halves of it are load-bearing, and the residual limit (a
 * same-millisecond cross-instance race is still decided by id) is stated there.
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
 * Same rule applied per logical key. The difference is only that the key identifies one ENTRY
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
 * A principal may hold several grants on one kind (different operations, different pattern
 * scopes), so this (not `(principal, kind)`) is what a retraction targets. Operations are sorted
 * so that the same grant written with the operations in a different order is the same entry.
 */
export function grantKey(body: unknown): string | undefined {
  const g = body as {
    principal?: unknown;
    kind?: unknown;
    operations?: unknown;
    pattern?: unknown;
    template?: unknown;
  };
  if (typeof g?.principal !== "string" || typeof g?.kind !== "string") return undefined;
  // FAIL CLOSED on a grant whose scoping field this build does not understand. `pattern` was once
  // called `template`, and this key encodes the pattern's VALUE rather than its field name. A
  // record written by the older build is indistinguishable here from an unpatterned grant, while
  // `Space.authorize` reads `.pattern`, finds nothing, and treats it as UNRESTRICTED. A narrow
  // grant silently widening to the whole kind is the worst failure this projection can produce, so
  // an unrecognized shape identifies nothing and every projection drops it instead.
  if (g.template !== undefined) return undefined;
  const ops = Array.isArray(g.operations) ? [...g.operations].map(String).sort().join(",") : "";
  // JSON-encoded parts, not a delimiter-joined string. Never separate with a NUL: it is invisible
  // in review and harmless as an in-memory Map key, but this key also travels as an idempotency
  // key, and Postgres rejects 0x00 in text outright. An encoded array is unambiguous (no value can
  // forge a boundary) and printable.
  //
  // The leading version tag namespaces these keys away from the pre-rename ones. Without it the
  // value-based encoding produces the SAME key for a grant whose body changed shape, so writing it
  // against a space that predates the rename failed with `idempotency_conflict`: a stored row
  // matched the key while disagreeing about the body. Bump the tag whenever the grant body's shape
  // changes; never reuse a tag across shapes.
  return JSON.stringify(["g2", g.principal, g.kind, ops, g.pattern ?? null]);
}

/** What a registry read produced, and whether it saw everything. */
export interface RegistryView {
  /** Current entry per key, retired ones dropped. */
  entries: Map<string, RadiaRecord>;
  /** Newest record per key INCLUDING retirements. A writer that re-declares a key needs this:
   *  reviving a retired entry requires a key that differs from the record being revived, so it
   *  has to be able to see that the newest record is a retirement, and which record that is. */
  newest: Map<string, RadiaRecord>;
  /** False when the scan hit its cap before exhausting the kind. The view may be missing entries,
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
 * This exists because registry writes are unbounded while a hand-written read is bounded, with
 * nothing connecting the two. That is the most repeated bug in this codebase. A capped read returns
 * the OLDEST matches by default, so the newest record (a retirement, a revocation, a re-declaration,
 * the tool published a minute ago) is exactly what falls off the end. The failure is silent in
 * both directions: an entry that should be gone stays live, and an entry that should be live is
 * missing.
 *
 * Two properties make it safe rather than merely convenient. It pages to EXHAUSTION, so the answer
 * does not depend on a limit someone guessed at the call site; and when it cannot exhaust, it says
 * so (`complete: false`) instead of returning a plausible prefix. Callers that authorize on this
 * must treat an incomplete view as a reason to refuse widening, never as a full picture.
 *
 * `read(limit, after)` must return records NEWEST-FIRST, `after` being the last id of the previous
 * page (i.e. a keyset page with `dir: "desc"`).
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
  const newest = newestByKey(all, keyOf);
  const entries = new Map(newest);
  for (const [key, rec] of entries) if (isRetired(rec.body)) entries.delete(key);
  return { entries, newest, complete, scanned: all.length };
}
