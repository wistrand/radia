// Advertising which model a worker serves, so the router can DISCOVER tiers instead of naming them.
//
// Same shape as `publishCapability`, and for the same two reasons: read before writing so restarts
// do not grow the space, and withdraw by writing a successor rather than deleting.
//
// KNOWN LIMIT, stated here because the record does not say it: an advertisement describes a TIER,
// not a live worker. Retiring on shutdown covers the ordinary case (the launcher stops the fleet),
// but a worker that is killed or crashes leaves its advertisement behind, and the router will
// happily dispatch an `llm_call` to a tier nobody serves: the call sits `available` and the chat
// reports a stall rather than failing over. Closing that properly needs liveness the substrate does
// not have yet: a heartbeat record would reintroduce exactly the unbounded-registry growth this
// file exists to avoid, and the natural alternative (advertisements that expire) needs the
// retention GC that is still M2. Do not "fix" it with a periodic re-publish.

import type { RadiaClient } from "../../../sdk/ts/client.ts";

export interface ModelAd {
  tier: string;
  model: string;
  rank: number;
  modalities?: string[];
  retired?: boolean;
}

/** The current advertisement record for a tier, newest-first. A retirement is the LATEST record,
 *  so an ascending read would return the advertisement it withdrew. */
async function current(client: RadiaClient, tier: string): Promise<{ id: string; ad: ModelAd } | undefined> {
  try {
    const rows = await client.query({ kind: "model", match: { tier } }, 1, { dir: "desc" });
    return rows[0] ? { id: rows[0].id, ad: rows[0].body as ModelAd } : undefined;
  } catch {
    return undefined; // no grant to read models: fall through and publish
  }
}

function same(a: ModelAd | undefined, b: ModelAd): boolean {
  return a !== undefined && !a.retired && a.model === b.model && a.rank === b.rank &&
    JSON.stringify(a.modalities ?? null) === JSON.stringify(b.modalities ?? null);
}

/**
 * Advertise the model this worker serves. Safe (and cheap) to call on every startup.
 *
 * The unconditional version of this wrote a fresh record per worker per launch. A content key does
 * not prevent that: an idempotency key is scoped `(principal, operation, key)` and a worker's
 * principal is a new `run:<ulid>` every time, so the same unchanged advertisement was a new record
 * on every restart. That is the growth that eventually pushes the newest entry off a bounded
 * discovery page, which is how the fleet loses track of a tool (or here, a tier).
 */
export async function publishModel(client: RadiaClient, ad: ModelAd): Promise<void> {
  const now = await current(client, ad.tier);
  if (same(now?.ad, ad)) return;
  let key = `model:${ad.tier}:${ad.model}:${ad.rank}:${(ad.modalities ?? []).join("+")}`;
  // REVIVING a retired tier needs a key that differs from the advertisement being revived, or the
  // write is an idempotent replay of that older record and the retirement stays newest: the tier
  // is withdrawn forever and the worker has no way to say otherwise. Keying on the retirement it
  // supersedes is unique per revival and still idempotent for a repeated attempt against the same
  // one. (This does not bite across a real restart, where the principal, and so the idempotency
  // scope, is a fresh run; relying on that would make correctness depend on who is calling.)
  if (now?.ad.retired) key += `:after:${now.id}`;
  await client.put({ kind: "model", body: ad }, key);
}

/**
 * Withdraw the advertisement, so a stopped worker stops being routed to.
 *
 * A successor carrying `retired: true`, honoured by the same latest-wins projection every registry
 * uses. Nothing is deleted, and re-publishing on the next start revives the tier because that
 * record is newer still. The key differs from the publish key on purpose: the same key would be an
 * idempotent replay of the advertisement within one principal's scope.
 */
export async function retireModel(client: RadiaClient, ad: ModelAd): Promise<void> {
  const key = `model:${ad.tier}:${ad.model}:${ad.rank}:retired`;
  await client.put({ kind: "model", body: { ...ad, retired: true } }, key);
}
