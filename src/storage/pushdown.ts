// Predicate pushdown: rendering a compiled pattern into a SQL PRE-FILTER.
//
// THE CONTRACT, and the only thing that makes this safe: the oracle in `core/matching.ts`
// defines what a pattern matches. This file never decides a match. It produces SQL that is a
// NECESSARY condition of the oracle's verdict: a filter that may return rows the oracle then
// rejects, but must NEVER exclude a row the oracle would accept. Adapters still run
// `matchesRecord` over whatever comes back. Sound over-approximation, in one word.
//
// That asymmetry is what lets this file be conservative: any node it cannot express EXACTLY is
// rendered as `TRUE` and left to the oracle. A missing optimization costs milliseconds; an
// unsound one silently loses a record, and `take` would report an empty space while work sat in
// it. When in doubt, return TRUE.
//
// The oracle's deliberate divergences from SQL/Mongo intuition are where unsoundness would come
// from, so each is handled explicitly:
//
//   - **No type coercion.** `{n: 5}` never matches the string "5". Every comparison is guarded by
//     the JSON type at the path, so SQL's own coercion rules can't widen a match.
//   - **missing != null.** An absent path matches nothing except `$exists:false`; a JSON `null`
//     is PRESENT. SQLite's `json_extract` returns SQL NULL for both, so presence is always asked
//     via `json_type`, never via the extracted value.
//   - **Deep equality is key-order sensitive** (the oracle compares `JSON.stringify`), while
//     jsonb equality normalizes key order. Object and array literals are therefore never pushed.
//   - **String ordering is UTF-16 code-unit order** in the oracle and collation order in SQL.
//     Range comparisons on strings are pushed only against an ASCII bound, under byte-order
//     collation. See `asciiBound`.
//   - **Array quantifiers** (`$any`/`$each`) are not pushed at all yet.

import type { CmpOp, MatchNode } from "./adapter.ts";

/** SQL that is always true. Not `TRUE`: portable across both dialects' older syntax. */
export const SQL_TRUE = "(1=1)";

/**
 * A rendered filter, and whether it is EQUIVALENT to the oracle rather than merely implied by it.
 *
 * Soundness alone lets the database narrow. Exactness lets it also DECIDE, and that is what allows
 * `LIMIT` to move into SQL. With an inexact filter a pushed limit is a correctness bug, not a
 * missed optimization: SQL returns its first N rows, the oracle rejects some, and the matching
 * rows further down were never fetched, so the caller silently gets fewer records than exist.
 */
export interface Pushed {
  sql: string;
  exact: boolean;
}

const TRUE_EXACT: Pushed = { sql: SQL_TRUE, exact: true };
const TRUE_LOOSE: Pushed = { sql: SQL_TRUE, exact: false };

/** The JSON scalar types the oracle distinguishes. Objects and arrays are never pushed. */
export type JsonScalar = "string" | "number" | "boolean" | "null";

/**
 * The per-dialect half. Each method returns a SQL boolean expression over one record row, and
 * registers its own bound parameters. `path` arrives pre-validated (see `pushablePath`), so an
 * implementation may safely inline it into a JSON path literal, which is what lets the planner
 * match an expression index.
 */
export interface JsonDialect {
  /**
   * How many parameters are bound so far. Rendering a node binds parameters as a SIDE EFFECT, so a
   * caller that then DISCARDS that node's SQL (every `TRUE` fallback does) must also discard its
   * parameters, or the statement carries bindings no placeholder refers to. Take a mark before
   * rendering a subtree you might throw away.
   */
  mark(): number;
  /** Drop every parameter bound since `mark`. */
  rollback(mark: number): void;
  /** The JSON value at `path` exists. A JSON `null` counts as existing, an absent key does not. */
  present(path: string[]): string;
  /** The JSON value at `path` is exactly `value` (same JSON type, same value). */
  eqScalar(path: string[], value: string | number | boolean | null): string;
  /** The JSON number at `path` compares `op` against `value`; false for any other type. */
  cmpNumber(path: string[], op: CmpOp, value: number): string;
  /** The JSON string at `path` compares `op` against ASCII `value` in byte order; false otherwise. */
  cmpString(path: string[], op: CmpOp, value: string): string;
}

/**
 * Only identifier-shaped path segments are pushed. Two reasons, both essential: the segment is
 * inlined into a JSON path literal (a bound parameter would defeat expression-index matching), so
 * restricting the alphabet is what makes that injection-proof; and both dialects' path grammars
 * accept an unquoted identifier without any escaping question. Anything else falls back to the
 * oracle, which handles every path.
 */
const SEGMENT = /^[A-Za-z0-9_]+$/;

export function pushablePath(path: string): string[] | null {
  const parts = path.split(".");
  return parts.length > 0 && parts.every((p) => SEGMENT.test(p)) ? parts : null;
}

/** A bound whose ordering is identical under UTF-16 code units and UTF-8 bytes (see below). */
function asciiBound(v: string): boolean {
  // For an ASCII bound the two orderings cannot disagree. Comparison runs left to right; while
  // both strings are ASCII the code unit IS the byte. At the first non-ASCII character the
  // candidate's code unit is >= 0x80 and its lead byte is >= 0xC2, both strictly greater than any
  // ASCII character it is being compared against. Both orderings put it on the same side.
  // (Restricted to the bound, not the data: the data is whatever records hold.)
  // deno-lint-ignore no-control-regex
  return /^[\x00-\x7F]*$/.test(v);
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Render `node` as a sound SQL pre-filter. Returns `SQL_TRUE` for anything not expressible.
 * Callers must still apply the oracle.
 */
export function pushdown(node: MatchNode | undefined, d: JsonDialect): Pushed {
  if (!node) return TRUE_EXACT; // "every record of the kind": trivial, but exactly right
  switch (node.t) {
    case "and": {
      // A conjunct that cannot be pushed simply drops out: the remaining conjuncts are still a
      // necessary condition of the whole. Its parameters drop out with it, and the result is no
      // longer exact, because the dropped conjunct can still reject rows.
      const parts: string[] = [];
      let exact = true;
      for (const n of node.nodes) {
        const mark = d.mark();
        const got = pushdown(n, d);
        exact &&= got.exact;
        if (got.sql === SQL_TRUE) d.rollback(mark);
        else parts.push(got.sql);
      }
      return { sql: parts.length === 0 ? SQL_TRUE : `(${parts.join(" and ")})`, exact };
    }
    case "or": {
      // A disjunct that cannot be pushed makes the WHOLE disjunction unusable: the unpushed
      // branch might be the one that matches, and dropping it would exclude those rows. When that
      // happens the branches already rendered are abandoned, parameters included.
      const mark = d.mark();
      const parts = node.nodes.map((n) => pushdown(n, d));
      if (parts.some((p) => p.sql === SQL_TRUE)) {
        d.rollback(mark);
        return TRUE_LOOSE;
      }
      return { sql: `(${parts.map((p) => p.sql).join(" or ")})`, exact: parts.every((p) => p.exact) };
    }
    case "exists": {
      const p = pushablePath(node.path);
      if (!p) return TRUE_LOOSE;
      return { sql: node.exists ? d.present(p) : `(not ${d.present(p)})`, exact: true };
    }
    case "in": {
      const p = pushablePath(node.path);
      // `$in` over a non-scalar is a deep comparison; leave the whole node to the oracle rather
      // than pushing a partial disjunction, which would exclude rows the non-scalar arm matches.
      if (!p || !node.values.every(isScalar)) return TRUE_LOOSE;
      if (node.values.length === 0) return TRUE_LOOSE; // matches nothing; let the oracle say so
      const arms = node.values.map((v) => d.eqScalar(p, v as string | number | boolean | null));
      return { sql: `(${arms.join(" or ")})`, exact: true };
    }
    case "cmp": {
      const p = pushablePath(node.path);
      if (!p) return TRUE_LOOSE;
      if (node.op === "eq") {
        // Objects and arrays: key-order-sensitive deep equality, not expressible here.
        return isScalar(node.value) ? { sql: d.eqScalar(p, node.value), exact: true } : TRUE_LOOSE;
      }
      if (typeof node.value === "number") return { sql: d.cmpNumber(p, node.op, node.value), exact: true };
      if (typeof node.value === "string" && asciiBound(node.value)) {
        return { sql: d.cmpString(p, node.op, node.value), exact: true };
      }
      // The oracle rejects an ordered comparison against a boolean/object/array outright, but
      // saying so in SQL buys nothing, since those patterns are vanishingly rare.
      return TRUE_LOOSE;
    }
    case "quant":
      return TRUE_LOOSE; // $any/$each over arrays: not pushed yet
  }
}

/** True when a rendered filter would narrow nothing, so the caller can keep its cheaper query. */
export function isTrivial(p: Pushed): boolean {
  return p.sql === SQL_TRUE;
}
