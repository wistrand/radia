// Publishing a tool so agents can DISCOVER it.
//
// A worker advertises what it serves as a `capability` record; the chat watches those records to
// build its tool list, so adding a worker adds a tool with no code or prompt change anywhere else.
//
// The write is content-keyed, like `kind_def` declarations: the SAME definition dedups across
// restarts, a CHANGED one becomes a successor record (latest per tool wins on discovery), never a
// 409. The key must be header-safe, because an `Idempotency-Key` is a ByteString and tool
// descriptions carry Unicode (…, →) that would break the fetch header. So the definition is
// HASHED into the key rather than embedded in it.
//
// NAMESPACED BY PROVIDER, which the flat version was not. The registry key was the bare tool name,
// so two workers advertising `read_file` were one entry and the newer record silently replaced the
// other: the model kept calling the name and got whichever worker's description happened to win,
// while BOTH still claimed the calls. MCP namespaces by server for exactly this reason. The key
// here is `(provider, tool)`, and the collapse back to one name per tool is what distinguishes the
// two cases the flat key confused: replicas of one worker (identical definitions, legitimate, and
// silent) from two different tools wearing one name (a real conflict, and now loud).

import { activeByKey, type RadiaClient, type RadiaRecord } from "../../../sdk/ts/client.ts";
import type { ToolDef } from "../provider/openrouter.ts";

/** A capability record's body. `provider` is absent on records written before namespacing. */
export interface CapabilityBody {
  tool: string;
  def?: ToolDef;
  provider?: string;
}

async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The registry key: one entry per (provider, tool). A record from before namespacing has no
 *  provider and groups under `?`, which keeps it visible rather than colliding with a named one. */
export function capabilityKey(b: CapabilityBody): string | undefined {
  return typeof b?.tool === "string" ? `${b.provider ?? "?"}|${b.tool}` : undefined;
}

/**
 * Advertise one tool. Safe to call on every startup, and now actually cheap to.
 *
 * The content key does NOT make this idempotent across restarts, which is the trap: an
 * idempotency key is scoped `(principal, operation, key)`, and a worker's principal is a fresh
 * `run:<ulid>` every launch. So the same unchanged definition wrote a NEW record on every start,
 * and a long-lived space grew by the whole fleet's tool count per restart, until discovery's
 * bounded page no longer reached the newest tool. Read first, and write only on a real change.
 */
export async function publishCapability(client: RadiaClient, def: ToolDef, provider?: string): Promise<void> {
  const tool = def.function.name;
  const hash = await defHash(def);
  let key = `capability:${provider ?? "?"}:${tool}:${hash}`;
  try {
    // Newest first, and narrowed to THIS provider: another worker's advertisement of the same name
    // must not read as "unchanged, nothing to say" and suppress this one's.
    const match = provider ? { tool, provider } : { tool };
    const existing = await client.query({ kind: "capability", match }, 1, { dir: "desc" });
    const current = existing[0]?.body as (CapabilityBody & { retired?: boolean }) | undefined;
    if (current?.retired) {
      // REVIVAL, and the trap this codebase keeps re-meeting. An idempotency key is scoped
      // `(principal, operation, key)`, so re-publishing an unchanged definition after a retirement
      // REPLAYS the original write: nothing is written, the call reports success, and the
      // retirement is still the newest record, so the tool never comes back. Anchoring the key on
      // the retirement it supersedes makes the revival a fresh write, and repeats stay idempotent
      // because the anchor only moves when something is retired again. Same shape as
      // `RadiaClient.grant`, and found here by a test rather than by a silent missing tool.
      key += `:after:${existing[0].id}`;
    } else if (current?.def && await defHash(current.def) === hash) {
      return; // unchanged and live: nothing to say
    }
  } catch {
    // No grant to read capabilities (or an older server): fall through and publish.
  }
  const body: CapabilityBody = provider ? { tool, def, provider } : { tool, def };
  await client.put({ kind: "capability", body }, key);
}

/** Withdraw one advertisement: a successor carrying `retired: true`, the same shape every registry
 *  in this codebase uses, so the projection drops it and the audit trail survives. */
export async function retireCapability(client: RadiaClient, tool: string, provider: string): Promise<void> {
  await client.put(
    { kind: "capability", body: { tool, provider, retired: true } },
    `capability:${provider}:${tool}:retired`,
  );
}

/**
 * Withdraw everything a set of PROVIDERS advertised. Called by whoever launched them.
 *
 * The worker cannot do this for itself reliably. Retiring in a signal handler races the process's
 * own death (the launcher kills and exits without waiting), and a SIGKILL or a crash runs no
 * handler at all. The launcher outlives every worker it started, holds a credential, and can await
 * the write, so the withdrawal belongs there.
 *
 * What this does NOT cover, and the reason the chat's tool timeout still hedges: a worker that dies
 * while its launcher lives leaves an advertisement standing. A capability record is a claim about
 * intent, never evidence of liveness. Jini concluded the same thing in 1999 and answered it with
 * renewable leases; the honest version here is that a clean shutdown withdraws and a crash does not.
 */
export async function retireProviderCapabilities(client: RadiaClient, providers: string[]): Promise<number> {
  if (providers.length === 0) return 0;
  const wanted = new Set(providers);
  let retired = 0;
  try {
    const live = activeByKey<CapabilityBody>(await client.queryAll({ kind: "capability" }), capabilityKey);
    await Promise.all(
      [...live.values()].map(async (rec) => {
        const b = rec.body as CapabilityBody;
        if (!b.provider || !wanted.has(b.provider)) return;
        try {
          await retireCapability(client, b.tool, b.provider);
          retired++;
        } catch { /* best effort: shutdown must not fail over a withdrawal */ }
      }),
    );
  } catch {
    // No grant to read capabilities, or the space is already gone. Shutdown continues either way.
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
 * Compared by SERIALIZED DEFINITION rather than by hash, because the question is exact equality and
 * both sides are built by the same code from the same literal, so key order is stable. Identical
 * definitions from several providers are replicas of one worker: legitimate, common when a fleet
 * scales out, and reported as one tool with no noise. Definitions that DIFFER are two tools wearing
 * one name; the newest wins, since the registry is latest-wins everywhere else, and the caller is
 * told rather than left to discover it from behaviour.
 */
export function collapseByTool(entries: Map<string, RadiaRecord>): Map<string, ToolEntry> {
  const byTool = new Map<string, { rec: RadiaRecord; body: CapabilityBody }[]>();
  for (const rec of entries.values()) {
    const body = rec.body as CapabilityBody;
    if (typeof body?.tool !== "string" || typeof body.def?.function?.name !== "string") continue;
    const group = byTool.get(body.tool);
    if (group) group.push({ rec, body });
    else byTool.set(body.tool, [{ rec, body }]);
  }
  const out = new Map<string, ToolEntry>();
  for (const [tool, all] of byTool) {
    // A record with NO provider predates namespacing, so it is an older advertisement of this same
    // tool rather than a rival one. Treating it as a peer was wrong and it was loud: on a space with
    // any history, every upgraded worker was reported as disagreeing with its own past self, once
    // per turn, forever. If anyone has claimed this name properly, the anonymous ones are superseded.
    const named = all.filter((g) => g.body.provider);
    const group = named.length > 0 ? named : all;
    // Newest first: record ids are monotonic, so this is the same latest-wins rule as everywhere.
    group.sort((a, b) => (a.rec.id < b.rec.id ? 1 : -1));
    const shapes = new Set(group.map((g) => JSON.stringify(g.body.def)));
    out.set(tool, {
      def: group[0].body.def!,
      providers: [...new Set(group.map((g) => g.body.provider ?? "?"))].sort(),
      // Only a disagreement between NAMED providers counts. One provider superseding its own older
      // definition is an upgrade, which is the ordinary case and must stay silent.
      conflicted: shapes.size > 1 && new Set(group.map((g) => g.body.provider)).size > 1,
    });
  }
  return out;
}
