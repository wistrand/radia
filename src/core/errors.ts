// Typed runtime errors. `code` is the stable machine-readable slug; it maps to the
// RFC 9457 problem `type` at the HTTP boundary and to a status body for non-error
// outcomes. Keep codes kebab/snake stable, because clients branch on them.

export class RadiaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RadiaError";
  }
}

/**
 * An event cursor that names a transaction this database has never assigned. It can only come from
 * a database that went further: a failover to a standby that had not received the tail the cursor
 * was read from. Resuming from it would compare new events against a position they never reach, and
 * skip them in silence (measured: 3,830 records that exist, missed by every watcher,
 * plan-cluster-bench.md phase 3). So it is refused as expired, which every client re-syncs on.
 */
export function cursorAhead(cursor: string, next: string): RadiaError {
  return new RadiaError(
    "cursor_expired",
    `cursor ${cursor} is ahead of this log, whose next position is ${next}: it was read from a log ` +
      `that went further (a failover to a standby that had not received it, or a restore from an ` +
      `older copy). Re-sync by query, then reconnect from the current head.`,
  );
}

/**
 * One read examined more rows than `CompiledMatch.scanBudget` allows. Raised by the ADAPTERS, and
 * built here so both dialects say the same thing: the message is the only place a caller learns
 * which part of its pattern the database could not decide.
 */
export function scanBudgetExceeded(kind: string, budget: number): RadiaError {
  return new RadiaError(
    "scan_budget_exceeded",
    `this pattern examined more than ${budget} records of kind '${kind}' without the database ` +
      `being able to decide it, so the whole kind was crossing into the matcher one record at a ` +
      `time. Narrow it (an equality or range on a declared indexed path is decided in SQL), page ` +
      `it with 'after', or declare the path this predicate uses. Array quantifiers: '$any' is ` +
      `decided in SQL, '$each' is not.`,
  );
}
