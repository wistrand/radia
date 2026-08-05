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
import { AGENT_DEFINITION, AGENT_RUN, GRANT, INTEREST, KIND_DEF, SIGNAL } from "./kinds.ts";
import { getPath } from "./matching.ts";
import type { RadiaRecord } from "../storage/adapter.ts";

/** Reserved kinds compaction knows how to key IN CODE. Everything else reserved is excluded. */
const RUNTIME_KEYS: Record<string, string[]> = {
  // A run's records (mint, renewals at half-life, the stop) all carry the same `run`; the newest
  // holds the live tokenHash/expiry/status, which is exactly what credential resolution reads.
  [AGENT_RUN]: ["run"],
};

/** Reserved kinds that must never compact, whatever anyone declares. See the header. */
const NEVER_COMPACT = new Set([GRANT, KIND_DEF, SIGNAL, AGENT_DEFINITION]);

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

export interface CompactionResult {
  /** Records deleted (0 on dryRun). */
  compacted: number;
  /** Records found superseded or dead (== compacted unless dryRun or a lease intervened). */
  superseded: number;
  byKind: Record<string, number>;
  /** A kind's walk hit the page cap: more may remain. Never read a capped count as the total. */
  more: boolean;
}

const PAGE = 500;
/** Most records one call walks per kind: bounds a pathological registry without a config knob.
 *  Compaction is idempotent, so a capped call plus `more: true` is a smaller next call. */
const MAX_WALK = 20_000;

/** The latest-wins identity of one record, or null when it cannot be classified (a key path
 *  missing means KEEP: an unclassifiable record must never be deleted on a guess). */
function keyOf(rec: RadiaRecord, paths: string[]): string | null {
  const parts: unknown[] = [];
  for (const p of paths) {
    const v = getPath(rec.body, p);
    if (v === undefined) return null;
    parts.push(v);
  }
  return JSON.stringify(parts);
}

export async function compactRegistries(
  host: CompactionHost,
  opts: { dryRun?: boolean; runId: string },
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
    const paths = RUNTIME_KEYS[def.kind] ?? def.contentKey;
    if (paths && paths.length > 0) keyed.push({ kind: def.kind, paths });
  }
  for (const { kind, paths } of keyed) {
    const seen = new Set<string>();
    const doomed: string[] = [];
    let after: string | undefined;
    let walked = 0;
    for (;;) {
      const page = await host.pageDesc(kind, PAGE, after);
      for (const rec of page) {
        const key = keyOf(rec, paths);
        if (key === null) continue; // unclassifiable: keep
        // Newest-first, so the FIRST record per key is the projection's winner — tombstone or not —
        // and everything after it is superseded. This line is the resurrection guard.
        if (seen.has(key)) doomed.push(rec.id);
        else seen.add(key);
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
  {
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
