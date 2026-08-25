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

import type { Page, RadiaRecord, Ulid } from "./wire.ts";

/** The body field that withdraws a registry entry. A convention honoured by the projections here,
 *  never by the matching layer. */
export const RETIRED = "retired";

export function isRetired(body: unknown): boolean {
  return (body as Record<string, unknown> | null)?.[RETIRED] === true;
}

/**
 * Which of two records for one key is NEWER: `created_at` first, the id only as a tie-break.
 *
 * `created_at` is stamped by the DATABASE, so it is the one ordering every instance agrees on. A
 * ULID's timestamp is the writing PROCESS's clock, so ordering by id alone lets two skewed
 * instances sort a second of writes backwards and a revocation lose to the grant it revokes.
 * Inside one DB millisecond the ids decide, deliberately: they are monotonic per process, and
 * retire-then-revive lands there routinely (resolving that tie toward retirement was tried and
 * reverted for breaking revival). NOT commit order — `created_at` is read before commit, so a
 * same-millisecond cross-instance race stays undefined; closing it needs the event cursor's `xid8`
 * machinery carried on the record, i.e. through the frozen wire contract.
 *
 * EXPORTED because a second definition of newest is a bug with a delay on it. `radia gc`'s
 * compaction kept the first record per key while paging by id, which is precisely the
 * "ordering by id alone" this comment warns against, and the sweep is the side that DELETES: it
 * could drop the record the projection considers current, which for an authorization registry is a
 * `retired: true` tombstone (audit package W3).
 */
export function newer(a: RadiaRecord, b: RadiaRecord): boolean {
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
  records: Population,
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
  records: Population,
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
 *
 * A SET, as the name says. It returned an array, which offers `.at`, `[0]` and a position that
 * means nothing here: the order is whichever key the projection saw first in a descending walk.
 * Reading that as recency is how `currentFleetKey` sealed to the fleet key about to be retired, and
 * these are GRANTS. Ordering by a real field still works through a spread.
 */
export function activeSet<T = unknown>(
  records: Population,
  keyOf: (body: T, record: RadiaRecord) => string | undefined,
): ReadonlySet<RadiaRecord> {
  return new Set(activeByKey(records, keyOf).values());
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

/** The logical identity of an ops grant (architecture-ops-tiers.md): principal plus its sorted power set,
 *  so re-assigning the same powers dedups and a retraction targets exactly one entry. Same
 *  versioned-tag rule as `grantKey`: bump the tag whenever the body's shape changes. */
export function opsGrantKey(body: unknown): string | undefined {
  const g = body as { principal?: unknown; operations?: unknown };
  if (typeof g?.principal !== "string") return undefined;
  const ops = Array.isArray(g.operations) ? [...g.operations].map(String).sort().join(",") : "";
  return JSON.stringify(["og1", g.principal, ops]);
}

/** The logical identity of an OIDC mapping (design-auth.md "OIDC"): the `(iss, sub)` pair. The
 *  PRINCIPAL is deliberately not part of the key: a rename is a successor for the same identity,
 *  latest-wins, never a second live entry. Same versioned-tag rule as `grantKey`. */
export function oidcIdentityKey(body: unknown): string | undefined {
  const m = body as { iss?: unknown; sub?: unknown };
  if (typeof m?.iss !== "string" || typeof m?.sub !== "string") return undefined;
  return JSON.stringify(["oi1", m.iss, m.sub]);
}

/**
 * An idempotency key that names the CONTENT, so a re-put of the same thing dedupes and a changed
 * one is a new record.
 *
 * The other key functions here answer a different question and the two are easy to confuse, which
 * is how the mistake this exists to prevent gets made:
 *
 *   `grantKey`, `opsGrantKey`, `kindDefKey`, `oidcIdentityKey` give a LOGICAL IDENTITY — a SUBSET
 *     of the body — so every successor shares the key, including a `retired: true` tombstone. That
 *     is what makes latest-wins work: a withdrawal must supersede rather than sit beside.
 *   `contentKey` gives the WHOLE content, so any change at all is a different key.
 *
 * Choose by what a re-put should MEAN. If writing it again must supersede, key on identity. If
 * writing the same thing twice must be free and writing something different must be a new record,
 * key on content. A key that names the container rather than the content dedupes writes that were
 * meant to change something: the call returns 200, and nothing happened.
 *
 * A record can need both. The chat's `conversation_key` is read latest-wins by `conversationId` and
 * written keyed by its wrap set, because enrolling a machine must produce a successor rather than
 * replay the first write (agent_docs/plan-encryption.md).
 *
 * HASHED, not the canonical string itself: `idem_key` is part of a PRIMARY KEY, and Postgres has a
 * btree tuple limit that a few kilobytes of body would cross. Async for the same reason it is
 * hashed — Web Crypto's digest is async, and a non-cryptographic hash cannot be used for a key
 * whose collision means two different requests silently become one.
 *
 * Always pass a body that is a pure function of the logical write. A timestamp or a random id in
 * it makes every key unique, which turns the dedupe off silently — the failure this has in common
 * with naming the container, in the opposite direction.
 */
export async function contentKey(tag: string, body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // 128 bits: short enough for an index, far past birthday range for anything one space writes.
  return `${tag}:${[...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** JSON with object keys sorted, so field order cannot change the key. Arrays keep their order:
 *  there, order is content. `undefined` members are dropped, as `JSON.stringify` drops them. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}


/**
 * Records from a read that EXHAUSTED, or that said it could not.
 *
 * A brand rather than a comment, because the alternative is a rule: "a latest-wins projection needs
 * the whole history", which three audits and a grep guard have caught being broken and which the
 * type system can simply enforce. `activeByKey` / `newestByKey` / `activeSet` take only this, and
 * only `queryAll` and `readAll` produce it.
 *
 * WHAT IT DOES NOT MEAN IS COMPLETE. `readAll` brands its accumulation while reporting
 * `complete: false`, and that is deliberate: the brand says **this read either exhausted or told you
 * it did not**, which is exactly what separates it from `query(p, 500)`, which says nothing at all.
 * A caller still has to read `complete`.
 */
declare const exhaustive: unique symbol;
export type Population = RadiaRecord[] & { readonly [exhaustive]: true };

/**
 * Records the caller KNOWS to be a whole set, for the cases the type cannot see: a concatenation of
 * two exhaustive reads, a set passed in by a caller that already exhausted, a literal in a test.
 *
 * NAMED, and `why` is MANDATORY, because the alternative is `as unknown as Population`, which loses
 * the type and the grep at once. Every use is legal, visible and countable; a rising count is the
 * signal that the brand is being routed around rather than the escape being needed.
 */
export function unsafeAsPopulation(records: RadiaRecord[], why: string): Population {
  if (!why) throw new Error("unsafeAsPopulation needs a reason: say why these records are a whole set");
  return records as Population;
}

/** Pages one registry read takes before giving up. Generous: a content-keyed registry holds one
 *  record per entry, so exhausting it is normally a single page. */
const REGISTRY_PAGE = 500;

/** One page of an exhaustive walk, built by `readAll` and passed straight through by the caller.
 *  `limit` rides along so the caller needs nothing of its own:
 *  `client.queryPage(pattern, p.limit, p)`. Spelled out rather than `extends Page`, because `Page`
 *  is a union (after+dir OR cursor) and a registry walk is always the first arm. */
export interface RegistryPage {
  after?: Ulid;
  limit: number;
  dir: "desc";
  cursor?: never;
}
const REGISTRY_MAX_PAGES = 40;

/**
 * Read a paged query COMPLETELY, newest-first.
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
 * THE CALLER NEVER NAMES A DIRECTION. It is handed the whole page, built here, and passes it
 * through: `(page) => client.query(pattern, page.limit, page)`. The contract used to be prose
 * ("`read(limit, after)` must return records NEWEST-FIRST"), and five call sites in this repo paged
 * ASCENDING against it. They were right only because this function exhausts; on the incomplete path
 * they would have kept the OLDEST records, which is the half missing every retirement and every
 * current entry, while `complete: false` said only that something was missing. A rule a caller can
 * get wrong is a rule that will be got wrong, so the caller no longer states it.
 *
 * ONE JOB: exhaust. It projected too, taking a `keyOf` and returning both a retirement-dropped map
 * and a raw one, which made it two functions wearing one name — and the way to ask for the second
 * was to pass `(_b, r) => r.id`, a key that means "no key". Projection is `activeByKey` /
 * `newestByKey`, named at the call site, over the `Population` this returns.
 */
export async function readAll(
  read: (page: RegistryPage) => Promise<RadiaRecord[]>,
): Promise<{ records: Population; complete: boolean; scanned: number }> {
  const all: RadiaRecord[] = [];
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < REGISTRY_MAX_PAGES; page++) {
    const rows = await read({ limit: REGISTRY_PAGE, dir: "desc", after });
    all.push(...rows);
    if (rows.length < REGISTRY_PAGE) {
      complete = true;
      break;
    }
    after = rows[rows.length - 1].id;
  }
  // WHERE THE BRAND IS EARNED: this loop either exhausted the kind or set `complete: false` above,
  // which is exactly what `Population` asserts. Nothing else in this file may mint one.
  return { records: unsafeAsPopulation(all, "readAll paged to exhaustion or reported it could not"), complete, scanned: all.length };
}
