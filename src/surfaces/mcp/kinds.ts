// `space_kinds`, joined with the caller's own permissions: each kind says what YOU may do with it.
//
// SHOW, never hide. A kind the caller cannot use stays listed by NAME, because a scoped principal
// learns kind names by being refused anyway, and the name is what it needs to ask for a grant. What
// is dropped for such a kind is its `usage` and paths: listed with its description, a kind the caller
// cannot read reads as protected state it ought to consult, and policy-bound agents stalled on
// exactly that (agent_docs/research-agent-sessions.md, "Listing a kind you cannot read").
//
// No runtime or wire change: `permissions` for the caller itself is always answerable
// (`asksAboutSelf` in `src/server/http.ts`), and this is presentation over two reads.

import { type EffectivePermissions, type KindDef, RESERVED_KINDS } from "../../../sdk/ts/wire.ts";

/**
 * What the caller may do with one kind.
 *
 * `patterns` is EXACT only when every grant on the kind carries the same pattern. `EffectivePermissions`
 * unions patterns across ALL grants on a kind while enforcement consults only the grants permitting the
 * operation asked (`patternConstraint`, src/core/authorization.ts), so a patterned `put` beside an
 * unpatterned `query` must not read as an unbounded `put`, nor two different patterns as bounding
 * every operation. Anything short of exact is shown as the union with `patternsPartial: true`.
 */
export type KindAccess =
  | "all"
  | "no access"
  | { operations: string[]; patterns?: Record<string, unknown>[]; patternsPartial?: true; readsScopedToSelf?: true };

export type KindView = (KindDef & { you: KindAccess }) | { kind: string; you: "no access" };

export function withAccess(defs: KindDef[], perms: EffectivePermissions): { kinds: KindView[]; notes: string[] } {
  const notes: string[] = [];
  if (perms.privileged) return { kinds: defs.map((d) => ({ ...d, you: "all" as const })), notes };
  const held = new Map(perms.kinds.filter((k) => k.operations.length > 0).map((k) => [k.kind, k]));
  const reserved = new Set<string>(RESERVED_KINDS);
  const usable: KindView[] = [], usableReserved: KindView[] = [], closed: KindView[] = [], closedReserved: KindView[] = [];
  let partial = false;
  for (const d of defs) {
    const g = held.get(d.kind);
    if (g) {
      const distinct = [...new Map(g.patterns.map((p) => [JSON.stringify(p), p])).values()];
      const exact = !g.unpatterned && distinct.length === 1;
      if (distinct.length > 0 && !exact) partial = true;
      const you: KindAccess = {
        operations: g.operations,
        ...(distinct.length > 0 ? { patterns: distinct } : {}),
        ...(distinct.length > 0 && !exact ? { patternsPartial: true as const } : {}),
        ...(g.readsScopedToSelf ? { readsScopedToSelf: true as const } : {}),
      };
      (reserved.has(d.kind) ? usableReserved : usable).push({ ...d, you });
    } else {
      (reserved.has(d.kind) ? closedReserved : closed).push({ kind: d.kind, you: "no access" });
    }
  }
  if (partial) {
    notes.push("`patternsPartial`: the patterns are pooled from several grants on the kind, so one operation may be bounded by only some of them, or by none; a refusal says which.");
  }
  if (perms.actingFor) {
    notes.push(`This is a delegated run acting for ${perms.actingFor}: \`you\` is the intersection it was minted with.`);
  }
  const delegable = (perms.delegable ?? []).map((d) => d.kind);
  if (delegable.length) {
    notes.push(`Reachable only through a delegated run, not with your own token: ${delegable.join(", ")}.`);
  }
  if (perms.opsPowers.includes("observe")) {
    notes.push("You hold `observe`: ops-plane reads (space_get, space_events, space_stats) reach every kind. `you` describes the coordination plane.");
  }
  if (!perms.complete) {
    notes.push("Your grants could not be read completely; a kind shown as `no access` may still be reachable.");
  }
  return { kinds: [...usable, ...usableReserved, ...closed, ...closedReserved], notes };
}
