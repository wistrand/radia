// Registry compaction: deleting SUPERSEDED entries of latest-wins registries
// (agent_docs/plan-gc.md, phase 2).
//
// The measured motive: on a live chat space, registry successors were 52% of all records —
// `agent_run` at 6.8 records per run (renewals and stops), `capability` at 38 records per tool
// (every session retires ~40 on the way out and republishes them on the way in). "Withdrawal is a
// successor record" is the design principle that manufactures this growth; compaction is its
// missing other half. The PROJECTION is what a registry means, and every record strictly older
// than the newest per content key contributes nothing to it.
//
// THE FAILURE MODE IS RESURRECTION, and it is why keep-newest is the entire correctness condition:
// the newest entry per key must survive even when it is a `retired: true` tombstone. Delete a
// retire-marker while an older live entry survives and the withdrawal silently un-happens — for a
// capability that is a ghost tool, for anything authorization-adjacent it is worse. So the
// compactor never chooses what to keep: it walks NEWEST-FIRST and deletes only what it has already
// seen a newer same-key record for. That order makes a partial walk safe too: whatever page the
// walk stops on, everything deleted had a newer survivor by construction.
//
// Never compacted: `grant`, `kind_def`, `signal`, `agent_definition`. "The audit trail survives
// revocation" is a documented property of grants, and the others are small, security-load-bearing,
// or both. The exclusion is enforced HERE, not left to who declares a `contentKey`: a kind_def
// redeclaration must not be able to opt the grant registry into deletion.
//
// Extracted from `space.ts`-style code into its own module per the flows/artifacts/inspection
// pattern, except this port deliberately holds the one destructive member (`sweepIds`), and the
// adapters re-check the lease floor under it whatever this logic decides.

import type { KindDef } from "./kinds.ts";
import { AGENT_DEFINITION, AGENT_RUN, GRANT, INTEREST, KIND_DEF, OIDC_IDENTITY, OPS_GRANT, SIGNAL } from "./kinds.ts";
import { getPath } from "./matching.ts";
import type { RadiaRecord } from "../storage/adapter.ts";
import { newer } from "./registry.ts";

/** Reserved kinds compaction knows how to key IN CODE. Everything else reserved is excluded.
 *  A runtime key also NEUTRALIZES a hostile redeclaration: `RUNTIME_KEYS[kind] ?? contentKey`
 *  means a `put: kind_def` grant cannot re-key one of these registries into compaction under an
 *  arbitrary key (the move that keeps `shred`/`interest`… out of this table entirely). */
export const RUNTIME_KEYS: Record<string, string[]> = {
  // A run's records (mint, renewals at half-life, the stop) all carry the same `run`; the newest
  // holds the live tokenHash/expiry/status, which is exactly what credential resolution reads.
  [AGENT_RUN]: ["run"],
  // An identity's records (enrollment, display refreshes, renames, retires) all carry the same
  // (iss, sub); the newest is what the mint reads (`view.newest`), tombstone included. Compacting
  // the rest is a PRIVACY property as much as a space one: superseded mappings from before
  // display claims moved into profile artifacts carry names in immutable bodies, and
  // supersede-then-compact is their only deletion path (plan-oidc.md).
  [OIDC_IDENTITY]: ["iss", "sub"],
};

/** Reserved kinds that must never compact, whatever anyone declares. See the header. `ops_grant`
 *  for the same reason as `grant`: the assignment history of an ops power is audit, and deleting
 *  a retire-marker would silently restore a power. `oidc_identity` is NOT here: it compacts
 *  under its RUNTIME key above (newest per (iss, sub) survives, tombstone included, so a ban
 *  stands), and the runtime key is itself what defeats the hostile-contentKey redeclaration
 *  that once argued for listing it. */
const NEVER_COMPACT = new Set([GRANT, KIND_DEF, SIGNAL, AGENT_DEFINITION, OPS_GRANT]);

/** Everything compaction needs from the space. `sweepIds` is the destructive member; the rest are
 *  reads. The adapters keep their own lease floor under `sweepIds`. */
export interface CompactionHost {
  listKinds(): KindDef[];
  /** Newest-first keyset page of a kind (dir desc, after = the previous page's last id). */
  pageDesc(kind: string, limit: number, after?: string): Promise<RadiaRecord[]>;
  sweepIds(ids: string[], runId: string): Promise<{ swept: number; byKind: Record<string, number> }>;
  /** Is this principal's run still able to act? Non-run principals are always "live". */
  runIsLive(run: string): Promise<boolean>;
}

import type { CompactionResult } from "../../sdk/ts/wire.ts";
export type { CompactionResult };

const PAGE = 500;
/** Most records one call walks per kind: bounds a pathological registry without a config knob.
 *  Compaction is idempotent, so a capped call plus `more: true` is a smaller next call. */
const MAX_WALK = 20_000;

/**
 * A record's latest-wins identity, from the paths its kind DECLARES.
 *
 * Exported so compaction and the registry read use ONE derivation. The key was otherwise stated
 * twice per registry: once as `contentKey` (what `gc` compacts by) and again as a `keyOf` closure at
 * each reader, and nothing checked they agreed. Disagreement is silent and one-directional in the
 * worst way: `gc` deletes by its key while readers project by theirs, so a record every reader
 * considers current can be swept.
 *
 * AN ABSENT PATH IS A VALUE, not a refusal to classify. Returning null instead was a
 * one-directional bug of exactly the kind this function exists to end: compaction kept such a
 * record while the projection SKIPPED it, so a `capability` advertised without a provider was
 * invisible to every reader that used the declared key, and the tool vanished from the model's list
 * with no error. Absence groups: two records missing the same path are one entry, newest wins, which
 * is what each reader's own `?`-style fallback already did by hand.
 *
 * ABSENT IS NOT NULL. A NUL cannot appear in `JSON.stringify` output (control characters are
 * escaped), so the marker collides with no encodable value, and a body carrying an explicit `null`
 * keys as `"null"` and stays a separate entry. SQL conflates the two and the oracle must not
 * (`test/conformance/suites/pushdown.ts`); neither may this.
 */
const ABSENT = "\u0000";
export function keyOf(rec: RadiaRecord, paths: string[]): string {
  return paths.map((p) => {
    const v = getPath(rec.body, p);
    return v === undefined ? ABSENT : JSON.stringify(v);
  }).join("\u0001");
}

export async function compactRegistries(
  host: CompactionHost,
  /** `only` restricts the walk to one kind. That is what lets the amortized trigger pay for the
   *  kind it just dirtied instead of walking every registry in the space (plan-registry-cost.md
   *  item 3); the `gc` verb passes nothing and walks them all, as before. */
  opts: { dryRun?: boolean; runId: string; only?: string },
): Promise<CompactionResult> {
  const out: CompactionResult = { compacted: 0, superseded: 0, byKind: {}, more: false };
  const record = async (ids: string[], kind: string) => {
    out.superseded += ids.length;
    if (ids.length === 0) return;
    // `byKind` is attributed on the dry run too, from the walk's own knowledge: a dry answer of
    // "2 superseded: (nothing)" names a number and refuses to say of what, which is the kind of
    // report nobody can act on. The live path still counts what was ACTUALLY deleted, since the
    // adapter's lease floor may keep some.
    if (opts.dryRun) {
      out.byKind[kind] = (out.byKind[kind] ?? 0) + ids.length;
      return;
    }
    const r = await host.sweepIds(ids, opts.runId);
    out.compacted += r.swept;
    for (const [k, n] of Object.entries(r.byKind)) out.byKind[k] = (out.byKind[k] ?? 0) + n;
  };

  // --- keyed registries: app kinds that declared a contentKey, plus the runtime's own keys.
  const keyed: { kind: string; paths: string[] }[] = [];
  for (const def of host.listKinds()) {
    if (NEVER_COMPACT.has(def.kind)) continue;
    if (opts.only !== undefined && def.kind !== opts.only) continue;
    const paths = RUNTIME_KEYS[def.kind] ?? def.contentKey;
    if (paths && paths.length > 0) keyed.push({ kind: def.kind, paths });
  }
  for (const { kind, paths } of keyed) {
    // The winner per key, decided by the SAME comparator the projection uses (`newer`), never by
    // the order this loop happens to page in. Paging is id-descending because that is what a keyset
    // cursor can do; ids carry the writing PROCESS's clock, so on two instances they can disagree
    // with `created_at`, and this loop is the one that DELETES. Trusting page order here could drop
    // the record every reader considers current, tombstones included (audit package W3).
    const winner = new Map<string, RadiaRecord>();
    const doomed: string[] = [];
    let after: string | undefined;
    let walked = 0;
    for (;;) {
      const page = await host.pageDesc(kind, PAGE, after);
      for (const rec of page) {
        const key = keyOf(rec, paths);
        const held = winner.get(key);
        if (!held) winner.set(key, rec);
        else if (newer(held, rec)) {
          // A later page carried the real winner. Doom the one we were holding, not this.
          doomed.push(held.id);
          winner.set(key, rec);
        } else doomed.push(rec.id);
      }
      walked += page.length;
      if (page.length < PAGE) break;
      if (walked >= MAX_WALK) {
        out.more = true;
        break;
      }
      after = page[page.length - 1].id;
    }
    await record(doomed, kind);
  }

  // --- interests: live while their RUN is, so the key is liveness, not succession. An interest
  // is published per run at agentLoop start, which makes every restart append; the dead runs'
  // entries are what `liveInterests` filters on every read, forever, until they are gone.
  if (opts.only === undefined || opts.only === INTEREST) {
    const liveness = new Map<string, boolean>();
    const doomed: string[] = [];
    let after: string | undefined;
    let walked = 0;
    for (;;) {
      const page = await host.pageDesc(INTEREST, PAGE, after);
      for (const rec of page) {
        const by = rec.runtimeMeta.createdBy;
        let live = liveness.get(by);
        if (live === undefined) {
          live = await host.runIsLive(by);
          liveness.set(by, live);
        }
        if (!live) doomed.push(rec.id);
      }
      walked += page.length;
      if (page.length < PAGE) break;
      if (walked >= MAX_WALK) {
        out.more = true;
        break;
      }
      after = page[page.length - 1].id;
    }
    await record(doomed, INTEREST);
  }

  return out;
}
