// Promotion as a grant rotation: which CODE a tier is allowed to run, pinned by content address.
//
// The mechanism is agent_docs/plan-workspace-agents.md phase 2, and the reason it is here rather
// than in the runtime is that there is nothing to add: a candidate is a workspace tree digest,
// and "prod runs this digest" is a pattern-scoped grant naming it. Promotion writes a grant and
// retires the one it replaces. Rollback is promotion pointed at the previous digest. The
// promotion state IS the grant registry, so the event chain covers it and
// `radia permissions <runner>` answers "what is this tier running right now" from the enforcement
// path rather than from a deploy log.
//
// TWO FOOTGUNS, which are the whole reason this file exists rather than a snippet in a README:
//
//   1. ORDER. Grant the new digest BEFORE retiring the old one. Grants union, so both are briefly
//      live, which is the safe direction; retire-first leaves a window where the tier can claim
//      nothing.
//   2. REVIVE. A grant identity that was retired cannot be re-granted under the same content key:
//      the write replays the retirement, reports success, and grants nothing. Rolling back to a
//      previously promoted digest is exactly that case. `RadiaClient.grant` anchors the key on
//      the retirement it supersedes, so this file gets it right by calling that rather than
//      writing the record itself.
//
// WHAT THIS DOES NOT DO. It stops anyone from SUBMITTING or CLAIMING a request that names an
// unpromoted digest. That the runner then executes exactly those bytes is the runner's
// discipline: the runtime executes nothing, by design.

import type { KindDef, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { grantKey, isRetired } from "../../sdk/ts/registry.ts";

/** The kind an execution request uses. An app may pass its own; the contract is the two indexed
 *  paths below, since a grant pattern may only name DECLARED indexed paths of the kind and a pin
 *  that cannot compile is a pin that does not hold. */
export const EXEC_REQUEST = "exec_request";

export const EXEC_REQUEST_KIND: KindDef = {
  kind: EXEC_REQUEST,
  indexedPaths: [
    { path: "workspace", type: "keyword" }, // the tree digest the request is for
    { path: "tier", type: "keyword" }, // experiment | prod | whatever an app names
  ],
};

/** Declare the kind. Idempotent: `registerKind` is content-keyed. */
export async function declareExecRequest(client: RadiaClient, def: KindDef = EXEC_REQUEST_KIND): Promise<void> {
  await client.registerKind(def);
}

/** One side of a pin. A runner takes; a submitter puts. Both are pinned to the same digest, so
 *  neither can name an unpromoted one. */
export interface Pin {
  principal: string;
  operations: string[];
}

export interface PromotionResult {
  digest: string;
  tier: string;
  /** Grants written, one per pin. A repeat promotion writes nothing new and reports the same ids,
   *  because `grant` is content-keyed. */
  granted: { principal: string; id: string }[];
  /** Grants retired, with the digest each was pinned to: the audit line for a rotation. */
  retired: { principal: string; digest: string; recordId: string }[];
}

interface GrantBody {
  principal?: unknown;
  kind?: unknown;
  operations?: unknown;
  pattern?: { workspace?: unknown; tier?: unknown };
}

const sameOps = (a: unknown, b: string[]) =>
  Array.isArray(a) && JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].sort());

/**
 * The live grants a principal holds on `kind`, projected the way authorization reads them.
 *
 * Paged to exhaustion (`queryAll` throws rather than returning a prefix) because a rotation that
 * missed a page would leave an older digest live while reporting success, which is the
 * bounded-read-as-population bug wearing a promotion hat.
 */
async function liveGrants(client: RadiaClient, principal: string, kind: string): Promise<RadiaRecord[]> {
  const rows = await client.queryAll({ kind: "grant", match: { principal, kind } });
  const newest = new Map<string, RadiaRecord>();
  // `queryAll` pages newest-first, so the first record seen per identity is the current one.
  for (const rec of rows) {
    const key = grantKey(rec.body);
    if (key === undefined || newest.has(key)) continue;
    newest.set(key, rec);
  }
  return [...newest.values()].filter((rec) => !isRetired(rec.body));
}

/**
 * Make `digest` the code this tier runs, for every pin, and retire whatever digest it replaces.
 *
 * Scoped to the (principal, kind, operations, tier) it names: another tier's pins are untouched,
 * so promoting prod never disturbs the experiment tier, and a differently-shaped grant the
 * principal holds for other work is left alone.
 */
export async function promote(
  client: RadiaClient,
  opts: { digest: string; tier: string; pins: Pin[]; kind?: string },
): Promise<PromotionResult> {
  const kind = opts.kind ?? EXEC_REQUEST;
  const out: PromotionResult = { digest: opts.digest, tier: opts.tier, granted: [], retired: [] };
  for (const pin of opts.pins) {
    // Read BEFORE granting, so the grant just written is never a candidate for retirement.
    const live = await liveGrants(client, pin.principal, kind);

    // 1. Grant the new digest first (footgun 1). `grant` handles the revive key (footgun 2).
    const { id } = await client.grant(pin.principal, kind, pin.operations, { workspace: opts.digest, tier: opts.tier });
    out.granted.push({ principal: pin.principal, id });

    // 2. Retire the same pin on the same tier at any OTHER digest.
    for (const rec of live) {
      const body = rec.body as GrantBody;
      if (body.kind !== kind || !sameOps(body.operations, pin.operations)) continue;
      if (body.pattern?.tier !== opts.tier) continue;
      const was = body.pattern?.workspace;
      if (typeof was !== "string" || was === opts.digest) continue;
      // Keyed on the RECORD being retired, never on the grant identity alone: one key per
      // identity means an identity could be retired only once ever, so a later re-grant of the
      // same digest would survive the next rotation and stay live. That is silent widening, and
      // it is the same reasoning `Space.supersedeGrantsFor` records.
      await client.put({ kind: "grant", body: { ...(rec.body as object), retired: true } }, `grant-retire:${rec.id}`);
      out.retired.push({ principal: pin.principal, digest: was, recordId: rec.id });
    }
  }
  return out;
}

/**
 * Roll back to a previously promoted digest.
 *
 * The same operation as `promote`, named for the intent because the audit trail reads better and
 * because this is the call that exercises the revive path: the digest being restored was retired
 * by the promotion that replaced it.
 */
export function rollback(
  client: RadiaClient,
  opts: { digest: string; tier: string; pins: Pin[]; kind?: string },
): Promise<PromotionResult> {
  return promote(client, opts);
}

/**
 * What this principal is currently pinned to on this tier, read from the grants that enforce it.
 *
 * Normally one digest. Two means a rotation is in flight or a promotion half-finished, which is
 * worth seeing rather than hiding behind a "current" that picks one.
 */
export async function pinnedDigests(
  client: RadiaClient,
  opts: { principal: string; tier: string; kind?: string },
): Promise<string[]> {
  const kind = opts.kind ?? EXEC_REQUEST;
  const digests = new Set<string>();
  for (const rec of await liveGrants(client, opts.principal, kind)) {
    const body = rec.body as GrantBody;
    if (body.pattern?.tier !== opts.tier) continue;
    if (typeof body.pattern?.workspace === "string") digests.add(body.pattern.workspace);
  }
  return [...digests].sort();
}
