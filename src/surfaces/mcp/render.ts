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
  /**
   * What to DO about the page, in the operation's own vocabulary. Caller-supplied because the
   * remedy is operation-specific and the disclosure is not: "use space_stats for totals, or narrow
   * the match" is right for a query and false for `space_children`, which has no match to narrow
   * and whose fan-out `space_stats` cannot count. Omit it rather than say something untrue.
   */
  remedy?: string;
}

/**
 * The single-record answer, same rule as `answer`: one shape either way, the record last.
 *
 * `null` alone cannot say WHY nothing came back. A null beside a `scope` was produced inside a
 * grant's bounds, which means the record may exist and belong to somebody else; a null without one
 * means no such record. Every other read gained that distinction this week and this was the one
 * that could still only be guessed at.
 */
export function one(record: unknown, meta: { scope?: unknown; notes?: string[] } = {}): string {
  return JSON.stringify(
    {
      found: record !== null && record !== undefined,
      ...(meta.scope ? { scope: meta.scope } : {}),
      ...(meta.notes && meta.notes.length > 0 ? { notes: meta.notes } : {}),
      record: record ?? null,
    },
    null,
    2,
  );
}

export function answer(key: string, rows: unknown[], meta: AnswerMeta = {}): string {
  const warning = meta.more
    ? `more records exist than the ${meta.limit ?? rows.length} returned; this is a PAGE, not the ` +
      `total. Do not count or aggregate from it.${meta.remedy ? ` ${meta.remedy}` : ""}`
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
