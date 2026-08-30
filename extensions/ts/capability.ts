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
import { newer } from "../../sdk/ts/registry.ts";

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
  /**
   * This provider BEATS (`extensions/ts/presence.ts`), so a reader may treat the absence of a live
   * beat as proof the advertisement is stale. Opt-in, and it travels on the record rather than in
   * the reader's configuration for two reasons: a reader discovers which providers to police
   * instead of being told, and the claim OUTLIVES the beats, which is what makes it usable — a
   * crashed provider's presence records age out precisely when a reader needs to know it is gone.
   *
   * Without it a provider is outside the convention and always counts live, so a fleet that does
   * not beat keeps working unchanged.
   */
  presence?: true;
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
 * Every advertisement in force: newest per (provider, tool), retirements dropped.
 *
 * THE ONE PLACE the kind name and the body shape are stated together. A consumer that called
 * `client.registry<CapabilityBody>(CAPABILITY)` wrote both at every read, which is the same fact
 * twice with nothing checking they agree; here it is beside the `CAPABILITY_KIND` declaration that
 * makes it true. `complete: false` still means a prefix, and a tool list built on one is a guess.
 */
export function liveCapabilities(
  client: RadiaClient,
  match?: Record<string, unknown>,
): Promise<{ entries: ReadonlySet<RadiaRecord<CapabilityBody>>; complete: boolean; scanned: number }> {
  return client.registry<CapabilityBody>(CAPABILITY, match);
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
export async function publishCapability(
  client: RadiaClient,
  def: ToolDef,
  provider?: string,
  /** Body fields a pattern-scoped grant requires, e.g. `{team: "alpha"}` for a team member
   *  (`extensions/ts/team.ts`). Without them such a publisher is refused outright; with them the
   *  scope has to reach the KEY and the read as well, or one member advertising one tool in two
   *  scopes writes once (the second publish replays the first key) and reads the wrong scope's
   *  record as "unchanged, nothing to say". Absent, every byte of this function is as it was. */
  scope?: Record<string, string>,
  /** Claim presence tracking on the advertisement (`CapabilityBody.presence`). Only for a provider
   *  something actually beats for: claiming it without beats makes every reader treat this tool as
   *  gone. */
  opts: { presence?: boolean } = {},
): Promise<void> {
  const tool = def.function.name;
  const hash = await defHash(def);
  const scoped = scope && Object.keys(scope).length ? `:${await defHash(Object.entries(scope).sort())}` : "";
  // The flag is part of the KEY and of the unchanged-check below, or a provider that STARTS beating
  // re-puts an identical body under the identical key, the write dedups, and the advertisement it
  // meant to upgrade stays untracked forever.
  let key = `capability:${provider ?? "?"}:${tool}:${hash}${scoped}${opts.presence ? ":p" : ""}`;
  try {
    // Narrowed to THIS provider: another worker's advertisement of the same name must not read as
    // "unchanged, nothing to say" and suppress this one.
    const match = { ...scope, ...(provider ? { tool, provider } : { tool }) };
    const existing = await client.queryNewest<CapabilityBody & { retired?: boolean }>({ kind: CAPABILITY, match }, 1);
    const current = existing[0]?.body;
    if (current?.retired) {
      // REVIVAL. Re-publishing an unchanged definition after a retirement replays the original write
      // under the same key: nothing is written, the call reports success, and the retirement is
      // still the newest record, so the tool never comes back. Anchoring the key on the retirement
      // it supersedes makes this a fresh write. NOT the same anchor rule as `RadiaClient.grant`,
      // which anchors on the newest retirement even when a revival is already newest: here the
      // repeat-publish that rule protects against exits early on the hash check above, so
      // "newest is retired" suffices and the simpler condition is the honest one.
      key += `:after:${existing[0].id}`;
    } else if (current?.def) {
      if (await defHash(current.def) === hash && !!current.presence === !!opts.presence) {
        return; // unchanged and live
      }
      // SUPERSEDING A LIVE RECORD, so anchor on it. The definition hash is already in the key, but
      // `presence` only picks between two constant keys, so a provider that turns the flag back to a
      // value it used before replays THAT write: nothing is written, the call reports success, and
      // the older record stays newest. A worker restarted by hand after running under a launcher
      // was left advertising `presence: true` with nothing beating for it, which hides the tool it
      // is serving from every reader.
      key += `:after:${existing[0].id}`;
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
  // Scope UNDER the body, never over it: a value stated here is what the grant will check, and a
  // caller that named one itself is left to be refused on its own terms rather than corrected.
  const body: CapabilityBody = {
    ...scope,
    ...(provider ? { tool, def, provider } : { tool, def }),
    ...(opts.presence ? { presence: true as const } : {}),
  };
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
export async function retireCapability(
  client: RadiaClient,
  tool: string,
  provider: string,
  supersedes?: string,
  /** The advertisement's scope fields, as `publishCapability` took them. A withdrawal is a put like
   *  any other, so without them a pattern-scoped publisher cannot withdraw what it wrote. */
  scope?: Record<string, string>,
): Promise<void> {
  const scoped = scope && Object.keys(scope).length ? `:${await defHash(Object.entries(scope).sort())}` : "";
  await client.put(
    { kind: CAPABILITY, body: { ...scope, tool, provider, retired: true } },
    `capability:${provider}:${tool}:retired${scoped}${supersedes ? `:after:${supersedes}` : ""}`,
  );
}

/** The scope fields a record carries beyond the ones this module writes itself. Read off the record
 *  rather than passed in, so a withdrawal lands in the same scope as the advertisement without the
 *  launcher having to know which scopes its workers publish under. */
function scopeOf(b: CapabilityBody): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b as unknown as Record<string, unknown>)) {
    if (k === "tool" || k === "def" || k === "provider" || k === "retired") continue;
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
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
    const live = await liveCapabilities(client);
    await Promise.all(
      [...live.entries].map(async (rec) => {
        const b = rec.body;
        if (!b.provider || !wanted.has(b.provider)) return;
        try {
          // Anchored on the record being withdrawn: this projection already read it, so a repeat
          // withdrawal after a republish is a fresh write rather than a replayed one.
          await retireCapability(client, b.tool, b.provider, rec.id, scopeOf(b));
          retired++;
        } catch { /* best effort: shutdown must not fail over a withdrawal */ }
      }),
    );
  } catch {
    // No grant to read capabilities, or the space is already gone.
  }
  return retired;
}

/**
 * Drop the advertisements of providers that claimed presence and are not beating.
 *
 * A FILTER over records rather than an argument to `collapseByTool`, which is what keeps the two
 * conventions apart: `capability.ts` imports nothing from `presence.ts`, and an app that wires them
 * together passes the live set it already read. Applied BEFORE the collapse, so a dead provider can
 * neither win a tool name nor manufacture a conflict against the live one.
 *
 * FAIL-OPEN by construction: only a provider that opted in can be dropped. An advertisement with no
 * `presence` flag, or none with a provider at all, is outside the convention and always survives.
 *
 * `unserved` names the tools that had advertisements and now have none, because a tool that
 * silently disappears from a model's list reads as a tool that was never there. Nothing here logs;
 * the caller decides what to say.
 */
export function liveAdvertisements(
  entries: Iterable<RadiaRecord<CapabilityBody>>,
  /**
   * Who is beating, or UNDEFINED when the caller could not find out (no grant to read presence, a
   * space that predates it, a failed read). Undefined polices nothing and keeps every
   * advertisement; an EMPTY SET is the opposite claim, that everyone tracked is dead, and drops
   * every tracked tool. The distinction is the whole safety of this function: a caller that turned
   * a failed read into an empty set would silently strip a working fleet's entire tool list.
   */
  liveProviders: ReadonlySet<string> | undefined,
): { entries: RadiaRecord<CapabilityBody>[]; unserved: Map<string, string[]> } {
  if (!liveProviders) return { entries: [...entries], unserved: new Map() };
  const kept: RadiaRecord<CapabilityBody>[] = [];
  const dropped = new Map<string, Set<string>>();
  const served = new Set<string>();
  for (const rec of entries) {
    const b = rec.body;
    const tool = typeof b?.tool === "string" ? b.tool : undefined;
    if (tool && b.presence === true && b.provider && !liveProviders.has(b.provider)) {
      const set = dropped.get(tool) ?? new Set<string>();
      set.add(b.provider);
      dropped.set(tool, set);
      continue;
    }
    kept.push(rec);
    // The SAME test `collapseByTool` applies, or a record carrying a tool name with no usable
    // definition counts as serving it here and is skipped there: the name would then be reported
    // by neither `tools` nor `unserved`, which is the silent disappearance this map exists to
    // prevent.
    if (tool && typeof b.def?.function?.name === "string") served.add(tool);
  }
  const unserved = new Map<string, string[]>();
  for (const [tool, providers] of dropped) if (!served.has(tool)) unserved.set(tool, [...providers].sort());
  return { entries: kept, unserved };
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
 * that DIFFER are two tools wearing one name, and that name is WITHHELD by default: newest-wins
 * hands a model one description while either provider may claim the call, which reports the
 * disagreement to a caller who has already passed the wrong definition on. Answering with nothing
 * is the honest answer to an ambiguous question; `onConflict: "newest"` is the opt-out.
 */
export interface ToolCatalog {
  /** The tools a caller may offer. */
  tools: Map<string, ToolEntry>;
  /**
   * Names WITHHELD because live providers disagree about what they mean. Disjoint from `tools`,
   * and empty under `onConflict: "newest"`, where a conflicted entry stays in `tools` carrying
   * `conflicted: true` instead.
   *
   * Report these. A tool that vanishes without explanation reads as one that never existed.
   */
  conflicts: Map<string, ToolEntry>;
}

export function collapseByTool(
  entries: Iterable<RadiaRecord<CapabilityBody>>,
  opts: {
    /**
     * What to do when two live providers advertise incompatible definitions under one name.
     *
     * `"withhold"` (default) drops the name from `tools`. The model is otherwise handed one
     * description while EITHER provider may claim the call, so what it was told and what runs can
     * differ, and a principal holding `capability: put` can substitute a tool's definition rather
     * than merely break it. Withholding is not a fix for a hostile publisher: it changes what a
     * model is TOLD and never who may claim a `tool_call`.
     *
     * `"newest"` keeps the pre-2026-08-30 behaviour, newest definition wins, for a caller that
     * would rather serve an ambiguous tool than none.
     */
    onConflict?: "withhold" | "newest";
  } = {},
): ToolCatalog {
  const byTool = new Map<string, { rec: RadiaRecord<CapabilityBody>; body: CapabilityBody }[]>();
  for (const rec of entries) {
    const body = rec.body;
    if (typeof body?.tool !== "string" || typeof body.def?.function?.name !== "string") continue;
    const group = byTool.get(body.tool);
    if (group) group.push({ rec, body });
    else byTool.set(body.tool, [{ rec, body }]);
  }
  const tools = new Map<string, ToolEntry>();
  const conflicts = new Map<string, ToolEntry>();
  for (const [tool, all] of byTool) {
    // A record with NO provider predates namespacing: an older advertisement of this same tool, not
    // a rival one. Treated as a peer, every upgraded worker reports as disagreeing with its own past
    // self, once per turn, forever. If anyone has claimed this name properly, the anonymous ones are
    // superseded.
    const named = all.filter((g) => g.body.provider);
    const group = named.length > 0 ? named : all;
    // The winner by the SHARED comparator. Sorting on id alone is the process clock, and this
    // group spans PROVIDERS, so its records come from different processes by construction.
    const winner = group.reduce((a, b) => (newer(a.rec, b.rec) ? b : a));
    const shapes = new Set(group.map((g) => JSON.stringify(g.body.def)));
    const entry: ToolEntry = {
      def: winner.body.def!,
      providers: [...new Set(group.map((g) => g.body.provider ?? "?"))].sort(),
      // Only a disagreement between NAMED providers counts. One provider superseding its own older
      // definition is an upgrade: the ordinary case, and it must stay silent.
      conflicted: shapes.size > 1 && new Set(group.map((g) => g.body.provider)).size > 1,
    };
    // A conflict this reaches is between LIVE providers: `liveAdvertisements` has already dropped
    // the advertisements of anything that stopped beating, so a crashed worker's stale definition
    // can no longer withhold a tool the survivor serves unambiguously. That ordering is why this
    // default could be flipped at all.
    if (entry.conflicted && opts.onConflict !== "newest") conflicts.set(tool, entry);
    else tools.set(tool, entry);
  }
  return { tools, conflicts };
}
