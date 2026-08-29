// Who can get data OUT of a compartment, answered from the grants that decide it.
//
// A compartment (agent_docs/architecture-workspace-agents.md D1) is a dedicated kind plus pattern-scoped
// grants. Agents join it by being granted, work inside it freely, and the only way across is a
// principal deliberately granted BOTH sides: read inside, write outside. Phase 1 proved the
// runtime enforces that. What was missing is the other half of any rule like it: a way to FIND
// the principals who hold both, so "never grant one principal both sides except the one whose job
// that is" is checkable rather than aspirational. There is no second mechanism behind that rule,
// so a mis-written grant IS the leak, and this is the audit to run before promoting.
//
// It reports three things, because the boundary has three doors and only the first is obvious:
//
//   1. CROSSERS: read inside, write outside.
//   2. UNSCOPED PAYLOAD GRANTS: `artifact` is reserved, so a compartment cannot have its own
//      artifact kind and must scope by pattern instead. A grant that forgot the field reads
//      compartment bytes. This is the plan's most likely real-world leak. `workspace` is the same
//      door with a longer handle: a tree is a manifest naming artifacts, so an unscoped grant on it
//      hands over this compartment's CODE and, through the ids it lists, the bytes.
//   3. OPS POWERS: `observe` reads every record BODY regardless of any grant, and `declassify`
//      clears the labels a policy bars on. Neither shows up as a grant.
//
// WHAT IT CANNOT SEE, stated in the result rather than here alone: a privileged principal
// bypasses grants entirely, holds every power, and is named in the space's config rather than in
// any record. This enumerates what is written down; the operator set is a separate question.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { activeSet, grantKey, opsGrantKey } from "../../sdk/ts/registry.ts";

/** Kinds that carry a compartment's payload out of it. `artifact` IS the bytes; a `workspace` is a
 *  manifest naming them, so reading one is reading the code and the ids to fetch the rest. */
const PAYLOAD_KINDS = ["artifact", "workspace"];

const READ_OPS = ["query", "read_one", "take"];

export interface Crosser {
  principal: string;
  /** Compartment kinds it can read or claim. */
  reads: string[];
  /** Kinds outside the compartment it can write. */
  writes: string[];
}

export interface CompartmentAudit {
  crossers: Crosser[];
  /** Principals whose `artifact` or `workspace` grants are not scoped to the compartment field.
   *  Both carry payloads out: an artifact IS the bytes, a workspace names them. */
  unscopedArtifact: { principal: string; kind: string; operations: string[] }[];
  /** Ops powers held as `ops_grant` records. `observe` and `declassify` are boundary-relevant. */
  opsPowers: { principal: string; powers: string[] }[];
  /** Always populated: what this answer does not cover, in the words an operator needs. */
  caveats: string[];
}

interface GrantBody {
  principal?: unknown;
  kind?: unknown;
  operations?: unknown;
  pattern?: Record<string, unknown>;
}

/** Live grants across the whole space, projected the way authorization reads them: newest per
 *  identity, retirements dropped. Paged to exhaustion, and `queryAll` throws rather than handing
 *  back a prefix, because an audit that silently missed a page would report a clean boundary. */
async function liveGrants(client: RadiaClient): Promise<ReadonlySet<RadiaRecord<GrantBody>>> {
  return activeSet<GrantBody>(await client.queryAll({ kind: "grant" }), grantKey);
}

/**
 * The boundary, read from the records that enforce it.
 *
 * `inside` names the compartment's kinds; every other kind is outside. `field` is the pattern
 * field membership is scoped by (default `compartment`), used only for the artifact check.
 */
export async function auditCompartment(
  client: RadiaClient,
  opts: { inside: string[]; field?: string },
): Promise<CompartmentAudit> {
  const field = opts.field ?? "compartment";
  const inside = new Set(opts.inside);
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  // Keyed by `principal\u0000kind`, so one principal holding two unscoped payload grants is two
  // rows rather than a merged one an operator has to take apart.
  const unscopedArtifact = new Map<string, Set<string>>();

  for (const rec of await liveGrants(client)) {
    const g = rec.body;
    if (typeof g.principal !== "string" || typeof g.kind !== "string" || !Array.isArray(g.operations)) continue;
    const ops = g.operations.map(String);
    const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));

    if (inside.has(g.kind) && ops.some((o) => READ_OPS.includes(o))) add(reads, g.principal, g.kind);
    if (!inside.has(g.kind) && ops.includes("put")) add(writes, g.principal, g.kind);
    // An artifact grant carrying no compartment field reaches every artifact record in the space,
    // and through it the bytes. Reported whatever its operations: a read is the leak, a write is
    // how unlabelled bytes get in.
    if (PAYLOAD_KINDS.includes(g.kind) && (g.pattern === undefined || !(field in g.pattern))) {
      for (const o of ops) add(unscopedArtifact, `${g.principal}\u0000${g.kind}`, o);
    }
  }

  const crossers: Crosser[] = [];
  for (const [principal, r] of reads) {
    const w = writes.get(principal);
    if (!w || w.size === 0) continue;
    crossers.push({ principal, reads: [...r].sort(), writes: [...w].sort() });
  }
  crossers.sort((a, b) => (a.principal < b.principal ? -1 : 1));

  const powers = activeSet<{ principal?: unknown; operations?: unknown }>(await client.queryAll({ kind: "ops_grant" }), opsGrantKey);
  const byPrincipal = new Map<string, Set<string>>();
  for (const rec of powers) {
    const b = rec.body;
    if (typeof b.principal !== "string" || !Array.isArray(b.operations)) continue;
    const set = byPrincipal.get(b.principal) ?? new Set<string>();
    for (const op of b.operations) set.add(String(op));
    byPrincipal.set(b.principal, set);
  }
  const opsPowers = [...byPrincipal.entries()]
    .map(([principal, s]) => ({ principal, powers: [...s].sort() }))
    .sort((a, b) => (a.principal < b.principal ? -1 : 1));

  const caveats = [
    "privileged principals bypass grants entirely and are named in the space's config, not in " +
    "records: this enumerates what is written down, so check the operator set separately",
  ];
  const observers = opsPowers.filter((p) => p.powers.includes("observe")).map((p) => p.principal);
  if (observers.length) {
    caveats.push(
      `${observers.join(", ")} hold the 'observe' ops power, which reads every record BODY ` +
        "regardless of grants: an observer is inside every compartment for reading",
    );
  }
  const declassifiers = opsPowers.filter((p) => p.powers.includes("declassify")).map((p) => p.principal);
  if (declassifiers.length) {
    caveats.push(`${declassifiers.join(", ")} may declassify, which clears the labels a policy bars on`);
  }
  if (unscopedArtifact.size) {
    caveats.push(
      `artifact or workspace grants without a '${field}' pattern reach every payload in the ` +
        "space; both kinds are shared, so a compartment can only scope them by pattern",
    );
  }
  return {
    crossers,
    unscopedArtifact: [...unscopedArtifact.entries()]
      .map(([key, s]) => {
        const [principal, kind] = key.split("\u0000");
        return { principal, kind, operations: [...s].sort() };
      })
      .sort((a, b) => (a.principal + a.kind < b.principal + b.kind ? -1 : 1)),
    opsPowers,
    caveats,
  };
}

/**
 * The promotion checklist, as a function rather than a paragraph nobody runs.
 *
 * Returns the crossers that were NOT expected. Promotion is the moment to ask, because it is the
 * point where somebody decided this code may run against real data; `expected` is the exporter
 * (or exporters) whose job crossing is, and anything else in the answer is a finding.
 */
export async function unexpectedCrossers(
  client: RadiaClient,
  opts: { inside: string[]; expected: string[]; field?: string },
): Promise<Crosser[]> {
  const audit = await auditCompartment(client, opts);
  const allowed = new Set(opts.expected);
  return audit.crossers.filter((c) => !allowed.has(c.principal));
}
