// Rendering an answer that the runtime NARROWED, without hiding that it did.
//
// Every ops-plane read and the coordination query attach an `OpsScope`/`ReadScope` when a grant
// bounded what came back: which kinds the numbers cover, which are reachable by pattern and
// therefore deliberately not counted, and a sentence saying so. The runtime is careful about this
// and `test/team.test.ts` asserts it. The SURFACE was not: `space_stats` called the SDK method that
// returns `r.stats` alone, so a team member asking for stats got `[]` and read it as an empty
// space. Observed in a real agent-lab run (agent_docs/plan-agent-lab.md), which is where a model
// meets these answers and has no second source.
//
// A BARE LIST WHEN NOTHING WAS NARROWED. An unscoped caller sees exactly what it saw before, so the
// common answer keeps its shape and only the narrowed one grows a wrapper. That also keeps the
// wrapper meaningful: its presence IS the statement.

/**
 * A list answer plus the scope, when there is one.
 *
 * `key` names the list in the wrapped form (`records`, `stats`, `children`, `lineage`), matching
 * what the wire calls it, so a model that has seen the endpoint sees the same word.
 */
export function scoped(list: unknown[], scope: unknown, key: string): string {
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  return scope ? j({ [key]: list, scope }) : j(list);
}
