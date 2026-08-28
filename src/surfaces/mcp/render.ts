// How a read ANSWERS, when the honest answer is more than the rows.
//
// Ported from `extensions/ts/agent-tools.ts`, which is the other model-facing surface and had all
// of this already. Three facts travel with a list and were being dropped here:
//
// SCOPE. Every ops read and the coordination query attach an `OpsScope`/`ReadScope` when a grant
// bounded what came back. A member asking for stats on a space holding eight kinds got `[]` and
// read it as an empty space (seen in an agent-lab run, agent_docs/plan-agent-lab.md).
//
// TRUNCATION. "A page that reports only its own size reads as a population: the model counts 10
// records and states a total" (`agent-tools.ts`). A limit is not a total, and the answer has to say
// so even when this surface offers no cursor to continue with: disclosure and continuation are
// separate, and only the first was ever in question.
//
// THE SERVER'S OWN NOTES. `explain` already names the traps a correct-looking query walked into
// (an undeclared kind, a scalar predicate on an array path, a full page). It is opt-in, and the
// adapter never asked for it, so warnings the runtime wrote for exactly this reader were discarded.
//
// ONE SHAPE, ALWAYS AN OBJECT. The first version wrapped only when there was something to say,
// which made the answer polymorphic: a bare array sometimes, an object others. Text is what a model
// gets, so it copes, but everything mechanical downstream then handles both, and the lab's own
// trace classifier had to do exactly that inside one commit. The rows go LAST, after the caveats,
// so what qualifies them is read first.

export interface AnswerMeta {
  /** True when more exist than came back. Known from a `limit + 1` probe, or from a page cursor. */
  more?: boolean;
  /** The limit that bounded this answer, named in the warning so the reader can raise it. */
  limit?: number;
  /** The `OpsScope`/`ReadScope` the runtime attached, when a grant narrowed the read. */
  scope?: unknown;
  /** `explain` notes from the same code that answered. */
  notes?: string[];
}

export function answer(key: string, rows: unknown[], meta: AnswerMeta = {}): string {
  const warning = meta.more
    ? `more than ${meta.limit ?? rows.length} records match; this is a PAGE, not the total. Do not ` +
      `count or aggregate from it. Use space_stats for totals, or narrow the match.`
    : undefined;
  return JSON.stringify(
    {
      count: rows.length,
      ...(meta.more ? { more: true, warning } : {}),
      ...(meta.scope ? { scope: meta.scope } : {}),
      ...(meta.notes && meta.notes.length > 0 ? { notes: meta.notes } : {}),
      [key]: rows,
    },
    null,
    2,
  );
}
