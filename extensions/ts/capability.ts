// Tools advertised as records, so an agent DISCOVERS what it can do instead of being configured
// with it. A worker publishes a `capability` record for what it serves; a client watches those to
// build its tool list, so adding a worker adds a tool with no code or prompt change anywhere else.
//
// KEYED BY (provider, tool), never by the bare name. Under a flat key two workers advertising
// `read_file` are one entry: the newer record replaces the other while BOTH keep claiming the calls,
// and the model gets whichever description won. `collapseByTool` folds the namespace back to one
// name per tool and separates the two cases a flat key confuses — replicas of one worker (identical
// definitions, legitimate, silent) from two different tools wearing one name (a conflict, reported).

import type { KindDef, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";

export const CAPABILITY = "capability";

/**
 * A tool as a model is offered it: the OpenAI/OpenRouter function-calling shape.
 *
 * Here rather than beside a provider client, because it is what a `capability` record CARRIES. A
 * second provider speaking a different shape converts at its own edge.
 */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** `provider` is absent on records written before namespacing. */
export interface CapabilityBody {
  tool: string;
  def?: ToolDef;
  provider?: string;
}

/** `contentKey` is the latest-wins identity, declared so `radia gc` can compact the registry:
 *  measured at 1,498 records over 39 (provider, tool) pairs, since a fleet retires its tools on the
 *  way out and republishes on the way in. The projection reads only the newest per pair. */
export const CAPABILITY_KIND: KindDef = {
  kind: CAPABILITY,
  indexedPaths: [{ path: "tool", type: "keyword" }, { path: "provider", type: "keyword" }],
  claimable: false,
  contentKey: ["provider", "tool"],
};

async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The registry key: one entry per (provider, tool). A record from before namespacing has no
 *  provider and groups under `?`, which keeps it visible rather than colliding with a named one.
 *
 *  Kept for `retireCapability`'s write key, NOT as a projection key: readers use
 *  `client.registry(CAPABILITY)`, which projects by the declared `contentKey` and groups an absent
 *  provider the same way (`src/core/gc.ts`, `keyOf`). Restating it here as a `keyOf` closure is the
 *  drift those two agreeing exists to prevent. */
export function capabilityKey(b: CapabilityBody): string | undefined {
  return typeof b?.tool === "string" ? `${b.provider ?? "?"}|${b.tool}` : undefined;
}

/**
 * Advertise one tool. Safe to call on every startup.
 *
 * The definition is HASHED into the content key rather than embedded: an `Idempotency-Key` is a
 * ByteString, and tool descriptions carry Unicode that would break the header.
 *
 * It reads before writing even so. The key alone dedups an unchanged re-publish, but only a read
 * catches the two cases it cannot: a definition that CHANGED must supersede, and one that was
 * RETIRED must revive.
 */
export async function publishCapability(client: RadiaClient, def: ToolDef, provider?: string): Promise<void> {
  const tool = def.function.name;
  const hash = await defHash(def);
  let key = `capability:${provider ?? "?"}:${tool}:${hash}`;
  try {
    // Narrowed to THIS provider: another worker's advertisement of the same name must not read as
    // "unchanged, nothing to say" and suppress this one.
    const match = provider ? { tool, provider } : { tool };
    const existing = await client.queryNewest({ kind: CAPABILITY, match }, 1);
    const current = existing[0]?.body as (CapabilityBody & { retired?: boolean }) | undefined;
    if (current?.retired) {
      // REVIVAL. Re-publishing an unchanged definition after a retirement replays the original write
      // under the same key: nothing is written, the call reports success, and the retirement is
      // still the newest record, so the tool never comes back. Anchoring the key on the retirement
      // it supersedes makes this a fresh write. NOT the same anchor rule as `RadiaClient.grant`,
      // which anchors on the newest retirement even when a revival is already newest: here the
      // repeat-publish that rule protects against exits early on the hash check above, so
      // "newest is retired" suffices and the simpler condition is the honest one.
      key += `:after:${existing[0].id}`;
    } else if (current?.def && await defHash(current.def) === hash) {
      return; // unchanged and live
    }
  } catch (e) {
    // No grant to read capabilities, or an older server. The publish still happens, but it can no
    // longer REVIVE: an unchanged definition re-published after a retirement replays the original
    // key, the write dedups, and the tombstone stays newest — so the worker serves a tool nothing
    // can discover and says nothing about it. Silence is what made that cost an afternoon, so the
    // degraded mode announces itself.
    console.error(
      `[capability] ${tool}: cannot read this provider's advertisements (${e instanceof Error ? e.message : e}), ` +
        `so a retired one cannot be revived. Grant this principal \`capability: query\`.`,
    );
  }
  const body: CapabilityBody = provider ? { tool, def, provider } : { tool, def };
  await client.put({ kind: CAPABILITY, body }, key);
}

/**
 * Withdraw one advertisement: a successor carrying `retired: true`, so the projection drops it and
 * the audit trail survives.
 *
 * `supersedes` is the record this retirement replaces, and it is what makes a SECOND withdrawal
 * land. A constant key replays the first retirement: nothing is written, the call reports success,
 * and whatever republished in between stays newest — the exact mirror of the revival case above,
 * and the reason a tool that was retired, revived, and retired again stayed on every tool list.
 * Callers that already read the record they are retiring pass its id; without one this stays
 * best-effort on the constant key.
 */
export async function retireCapability(client: RadiaClient, tool: string, provider: string, supersedes?: string): Promise<void> {
  await client.put(
    { kind: CAPABILITY, body: { tool, provider, retired: true } },
    `capability:${provider}:${tool}:retired${supersedes ? `:after:${supersedes}` : ""}`,
  );
}

/**
 * Withdraw everything a set of PROVIDERS advertised. For whoever launched them.
 *
 * A worker cannot do this for itself: retiring in a signal handler races the process's own death,
 * and a SIGKILL runs no handler. The launcher outlives every worker it started, holds a credential,
 * and can await the write.
 *
 * A capability record is a claim about intent, never evidence of liveness. A clean shutdown
 * withdraws; a crash leaves the advertisement standing, so a caller still needs its own timeout.
 */
export async function retireProviderCapabilities(client: RadiaClient, providers: string[]): Promise<number> {
  if (providers.length === 0) return 0;
  const wanted = new Set(providers);
  let retired = 0;
  try {
    const live = await client.registry(CAPABILITY);
    await Promise.all(
      live.entries.map(async (rec) => {
        const b = rec.body as CapabilityBody;
        if (!b.provider || !wanted.has(b.provider)) return;
        try {
          // Anchored on the record being withdrawn: this projection already read it, so a repeat
          // withdrawal after a republish is a fresh write rather than a replayed one.
          await retireCapability(client, b.tool, b.provider, rec.id);
          retired++;
        } catch { /* best effort: shutdown must not fail over a withdrawal */ }
      }),
    );
  } catch {
    // No grant to read capabilities, or the space is already gone.
  }
  return retired;
}

/** One tool name, and who serves it. */
export interface ToolEntry {
  def: ToolDef;
  providers: string[];
  /** True when providers disagree about what the name MEANS, as distinct from replicating it. */
  conflicted: boolean;
}

/**
 * Collapse a provider-keyed registry into the one-name-per-tool list a model can be handed.
 *
 * Compared by SERIALIZED DEFINITION rather than by hash: the question is exact equality, and both
 * sides are built by the same code from the same literal, so key order is stable. Identical
 * definitions from several providers are replicas of one worker and report as one tool. Definitions
 * that DIFFER are two tools wearing one name; the newest wins, as everywhere else in a latest-wins
 * registry, and the caller is told rather than left to infer it from behaviour.
 */
export function collapseByTool(entries: Iterable<RadiaRecord>): Map<string, ToolEntry> {
  const byTool = new Map<string, { rec: RadiaRecord; body: CapabilityBody }[]>();
  for (const rec of entries) {
    const body = rec.body as CapabilityBody;
    if (typeof body?.tool !== "string" || typeof body.def?.function?.name !== "string") continue;
    const group = byTool.get(body.tool);
    if (group) group.push({ rec, body });
    else byTool.set(body.tool, [{ rec, body }]);
  }
  const out = new Map<string, ToolEntry>();
  for (const [tool, all] of byTool) {
    // A record with NO provider predates namespacing: an older advertisement of this same tool, not
    // a rival one. Treated as a peer, every upgraded worker reports as disagreeing with its own past
    // self, once per turn, forever. If anyone has claimed this name properly, the anonymous ones are
    // superseded.
    const named = all.filter((g) => g.body.provider);
    const group = named.length > 0 ? named : all;
    group.sort((a, b) => (a.rec.id < b.rec.id ? 1 : -1)); // ids are monotonic: newest first
    const shapes = new Set(group.map((g) => JSON.stringify(g.body.def)));
    out.set(tool, {
      def: group[0].body.def!,
      providers: [...new Set(group.map((g) => g.body.provider ?? "?"))].sort(),
      // Only a disagreement between NAMED providers counts. One provider superseding its own older
      // definition is an upgrade: the ordinary case, and it must stay silent.
      conflicted: shapes.size > 1 && new Set(group.map((g) => g.body.provider)).size > 1,
    });
  }
  return out;
}
