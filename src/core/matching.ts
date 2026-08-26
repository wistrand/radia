// Pattern matching: compilation, validation, and the semantic ORACLE.
//
// The evaluator here DEFINES what a pattern matches. Adapters may later push predicates
// into indexed SQL, but that SQL must agree with this function; the conformance suite uses
// it as the reference. Keep it backend-neutral.
//
// Divergences from Mongo (deliberate, conformance-backed):
//   - missing != null: an absent field never matches except $exists:false
//   - no type coercion: cross-type comparison is false
//   - explicit array quantifiers $any/$each: scalar predicates never distribute over arrays
//   - $and/$or depth <= 3
// Forbidden forever: $regex/$where/$expr (patterns are data, not code).
// Deferred (rejected at compile for now): $ne/$nin/$not/$prefix.

import type {
  CmpOp,
  CompiledMatch,
  ElemPred,
  MatchNode,
  OrderBy,
  RadiaRecord,
} from "../storage/adapter.ts";
import type { KindDef } from "./kinds.ts";
import { RadiaError } from "./errors.ts";

// The wire vocabulary is DEFINED in `sdk/ts/wire.ts` and re-exported here, so every import
// path inside `src/` is unchanged while the SDK ships without reaching back into the runtime.
// See that file's header for why the direction runs this way.
import type {
  OrderKey,
  Pattern,
} from "../../sdk/ts/wire.ts";
export type {
  OrderKey,
  Pattern,
};

/**
 * `grant ∧ request`: narrow a requested match by a set of grant patterns (their union). Returns
 * a match object to compile. The request must match AND at least one grant pattern. Used for
 * pattern-scoped grants (server-side, per design-auth). `grantPatterns` must be non-empty; an
 * empty request means "all", so the result is just the constraint. Grant patterns should be
 * simple (flat), because a nested `$or`/`$and` inside one can exceed the compiler's depth-3 limit.
 */
export function combineMatch(
  requestMatch: Record<string, unknown> | undefined,
  grantPatterns: Record<string, unknown>[],
): Record<string, unknown> {
  const constraint = grantPatterns.length === 1 ? grantPatterns[0] : { $or: grantPatterns };
  if (!requestMatch || Object.keys(requestMatch).length === 0) return constraint;
  return { $and: [requestMatch, constraint] };
}

const MAX_DEPTH = 3;

/**
 * Pattern resource limits (design-data-model §2).
 *
 * A pattern is not a one-off request: it is STORED (in a grant, in an interest) and then evaluated
 * against every candidate record, so its cost is paid per record forever rather than once. These
 * bound the evaluation, not the parse.
 *
 * `MAX_PREDICATES` counts compiled NODES, which is the thing the oracle walks. Depth alone does not
 * bound it: a flat object with ten thousand fields is depth 1.
 */
const MAX_PATTERN_BYTES = 8 * 1024;
const MAX_PREDICATES = 64;
const MAX_OR_BRANCHES = 16;
const MAX_IN_VALUES = 256;
const CMP_OPS: Record<string, CmpOp> = {
  $eq: "eq",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
};
const FORBIDDEN = new Set(["$regex", "$where", "$expr"]);
const DEFERRED = new Set(["$ne", "$nin", "$not", "$prefix", "$text"]);

// ---------------------------------------------------------------------------
// Compilation + validation
// ---------------------------------------------------------------------------

interface Ctx {
  kind: string;
  indexed: Map<string, string>; // path -> type
  sortable: Set<string>;
  registered: boolean;
}

export function compilePattern(t: Pattern, def: KindDef | undefined): CompiledMatch {
  const ctx: Ctx = {
    kind: t.kind,
    indexed: new Map((def?.indexedPaths ?? []).map((p) => [p.path, p.type])),
    sortable: new Set(def?.sortablePaths ?? []),
    registered: def !== undefined,
  };

  // `match` is validated here rather than at each caller, for the same reason `compileOrderBy` is:
  // in-process callers (SDK, MCP, examples, the runtime itself) reach this without passing a
  // handler. Never cast a non-object match straight through: `Object.keys(3)` is empty, so
  // `match: 3` compiles to "no predicate" and the query silently returns EVERY record of the
  // kind instead of failing. A malformed filter that widens is the worst shape of this bug: the
  // caller gets a plausible answer to a question it did not ask.
  if (t.match !== undefined && t.match !== null) {
    if (typeof t.match !== "object" || Array.isArray(t.match)) {
      throw new RadiaError("invalid_pattern", "pattern.match must be an object of path → condition");
    }
  }
  // Size before parse: a pattern this large is a denial of service on the matcher, and refusing it
  // by BYTES is the one check that cannot itself be expensive.
  if (t.match) {
    const bytes = new TextEncoder().encode(JSON.stringify(t.match)).length;
    if (bytes > MAX_PATTERN_BYTES) {
      throw new RadiaError(
        "pattern_too_large",
        `pattern is ${bytes} bytes, over the ${MAX_PATTERN_BYTES} limit. A pattern is evaluated ` +
          `against every candidate record, so its cost is paid per record rather than once`,
      );
    }
  }
  const where = t.match && Object.keys(t.match).length > 0
    ? compileObject(t.match, ctx, 1)
    : undefined;
  // Counted on the COMPILED form, which is what the oracle walks. Depth alone does not bound it:
  // a flat object with ten thousand fields is depth 1 and ten thousand comparisons per record.
  const predicates = countNodes(where);
  if (predicates > MAX_PREDICATES) {
    throw new RadiaError(
      "too_many_predicates",
      `pattern has ${predicates} predicates, over the ${MAX_PREDICATES} limit`,
    );
  }

  const orderBy = compileOrderBy(t.orderBy, ctx);

  return { kind: t.kind, where, orderBy };
}

/** Nodes in the compiled tree: what the oracle evaluates per candidate record. */
function countNodes(n: MatchNode | undefined): number {
  if (!n) return 0;
  if (n.t === "and" || n.t === "or") return 1 + n.nodes.reduce((a, x) => a + countNodes(x), 0);
  return 1;
}

function requireIndexed(ctx: Ctx, path: string): void {
  if (!ctx.registered) {
    throw new RadiaError("unknown_kind", `kind '${ctx.kind}' is not registered`);
  }
  if (!ctx.indexed.has(path)) {
    throw new RadiaError(
      "undeclared_path",
      `path '${path}' is not a declared indexed path of kind '${ctx.kind}'`,
    );
  }
}

function compileObject(obj: Record<string, unknown>, ctx: Ctx, depth: number): MatchNode {
  if (depth > MAX_DEPTH) {
    throw new RadiaError("too_deep", `$and/$or nesting exceeds depth ${MAX_DEPTH}`);
  }
  const nodes: MatchNode[] = [];
  for (const [key, spec] of Object.entries(obj)) {
    if (key === "$or" || key === "$and") {
      if (!Array.isArray(spec)) {
        throw new RadiaError("invalid_predicate", `${key} expects an array`);
      }
      if (spec.length > MAX_OR_BRANCHES) {
        // Branches MULTIPLY the work, and unlike depth they are cheap to add by the thousand.
        throw new RadiaError(
          "too_many_branches",
          `${key} has ${spec.length} branches, over the ${MAX_OR_BRANCHES} limit`,
        );
      }
      const subs = spec.map((s) => compileObject(asObject(s, key), ctx, depth + 1));
      nodes.push({ t: key === "$or" ? "or" : "and", nodes: subs });
    } else if (key.startsWith("$")) {
      throw operatorError(key);
    } else {
      requireIndexed(ctx, key);
      nodes.push(compileField(key, spec));
    }
  }
  return nodes.length === 1 ? nodes[0] : { t: "and", nodes };
}

function compileField(path: string, spec: unknown): MatchNode {
  if (!isOperatorObject(spec)) {
    return { t: "cmp", path, op: "eq", value: spec }; // implicit $eq
  }
  const nodes: MatchNode[] = [];
  for (const [op, val] of Object.entries(spec as Record<string, unknown>)) {
    if (op in CMP_OPS) {
      nodes.push({ t: "cmp", path, op: CMP_OPS[op], value: val });
    } else if (op === "$in") {
      if (!Array.isArray(val)) {
        throw new RadiaError("invalid_predicate", `$in expects an array at '${path}'`);
      }
      if (val.length > MAX_IN_VALUES) {
        throw new RadiaError(
          "too_many_values",
          `$in at '${path}' has ${val.length} values, over the ${MAX_IN_VALUES} limit`,
        );
      }
      nodes.push({ t: "in", path, values: val });
    } else if (op === "$exists") {
      if (typeof val !== "boolean") {
        throw new RadiaError("invalid_predicate", `$exists expects a boolean at '${path}'`);
      }
      nodes.push({ t: "exists", path, exists: val });
    } else if (op === "$any" || op === "$each") {
      nodes.push({ t: "quant", quant: op === "$any" ? "any" : "each", path, pred: compileElem(val) });
    } else {
      throw operatorError(op);
    }
  }
  return nodes.length === 1 ? nodes[0] : { t: "and", nodes };
}

function compileElem(spec: unknown): ElemPred {
  if (!isOperatorObject(spec)) {
    return { t: "cmp", op: "eq", value: spec };
  }
  const entries = Object.entries(spec as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new RadiaError("invalid_predicate", "$any/$each element predicate must be a single operator");
  }
  const [op, val] = entries[0];
  if (op in CMP_OPS) return { t: "cmp", op: CMP_OPS[op], value: val };
  if (op === "$in") {
    if (!Array.isArray(val)) throw new RadiaError("invalid_predicate", "$in expects an array");
    return { t: "in", values: val };
  }
  throw operatorError(op);
}

function compileOrderBy(orderBy: OrderKey[] | undefined, ctx: Ctx): OrderBy[] | undefined {
  if (orderBy === undefined || orderBy === null) return undefined;
  // Validate the SHAPE here rather than trusting the caller's cast: a client sending
  // `orderBy: "index"` would otherwise reach `.map` on a string and turn a bad request into a 500.
  if (!Array.isArray(orderBy)) {
    throw new RadiaError("invalid_pattern", "order_by must be an array of {path, dir?}");
  }
  if (orderBy.length === 0) return undefined;
  for (const k of orderBy) {
    if (!k || typeof k !== "object" || typeof (k as OrderKey).path !== "string") {
      throw new RadiaError("invalid_pattern", "each order_by entry must be an object with a string `path`");
    }
  }
  return orderBy.map((k) => {
    if (!ctx.registered) {
      throw new RadiaError("unknown_kind", `kind '${ctx.kind}' is not registered`);
    }
    if (!ctx.sortable.has(k.path)) {
      throw new RadiaError(
        "unsortable_path",
        `order_by path '${k.path}' is not a declared sortable path of kind '${ctx.kind}'`,
      );
    }
    return { path: k.path, dir: k.dir === "desc" ? "desc" : "asc" };
  });
}

function operatorError(op: string): RadiaError {
  if (FORBIDDEN.has(op)) {
    return new RadiaError("operator_forbidden", `operator ${op} is not allowed (patterns are data, not code)`);
  }
  if (DEFERRED.has(op)) {
    return new RadiaError("operator_deferred", `operator ${op} is not supported yet`);
  }
  return new RadiaError("unknown_operator", `unknown operator ${op}`);
}

function isOperatorObject(spec: unknown): boolean {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return false;
  const keys = Object.keys(spec as Record<string, unknown>);
  if (keys.length === 0) return false; // {} is an empty literal, an eq target
  const dollar = keys.filter((k) => k.startsWith("$")).length;
  if (dollar === 0) return false; // literal object -> eq target
  if (dollar !== keys.length) {
    throw new RadiaError("mixed_operator", "a predicate cannot mix operators and literal keys");
  }
  return true;
}

function asObject(v: unknown, ctxKey: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new RadiaError("invalid_predicate", `${ctxKey} entries must be objects`);
  }
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Evaluation (the oracle)
// ---------------------------------------------------------------------------

/** An array index as JSON can express it: `0`, `12`, never `00`, `+1` or `length`. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Resolve a dotted path against a record body, over STORED DATA ONLY. Absent -> undefined (never
 * null). Own properties only, and an array only by a canonical index.
 *
 * Bare property access reached the prototype: `arr.length` and `obj.constructor` resolved for every
 * record, while SQL correctly saw nothing there, so the pre-filter EXCLUDED records this said
 * matched — the one direction `storage/pushdown.ts` may never take. The fix belongs here, not in
 * the SQL: a prototype property is not data anybody put in the space. A body that really carries a
 * key named `length` still resolves, because that one IS data.
 */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX.test(part)) return undefined;
      cur = cur[Number(part)];
    } else {
      if (!Object.hasOwn(cur, part)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

export function matchesRecord(rec: RadiaRecord, m: CompiledMatch): boolean {
  if (rec.kind !== m.kind) return false;
  if (!m.where) return true;
  return evalNode(rec.body, m.where);
}

function evalNode(body: unknown, node: MatchNode): boolean {
  switch (node.t) {
    case "cmp":
      return cmp(getPath(body, node.path), node.op, node.value);
    case "in": {
      const actual = getPath(body, node.path);
      if (actual === undefined) return false; // missing != anything
      return node.values.some((v) => valueEq(actual, v));
    }
    case "exists":
      return (getPath(body, node.path) !== undefined) === node.exists;
    case "quant": {
      const arr = getPath(body, node.path);
      if (!Array.isArray(arr)) return false; // no silent distribution over non-arrays
      const test = (e: unknown) => elem(e, node.pred);
      return node.quant === "any" ? arr.some(test) : arr.every(test);
    }
    case "and":
      return node.nodes.every((n) => evalNode(body, n));
    case "or":
      return node.nodes.some((n) => evalNode(body, n));
  }
}

function elem(e: unknown, pred: ElemPred): boolean {
  return pred.t === "cmp"
    ? cmp(e, pred.op, pred.value)
    : pred.values.some((v) => valueEq(e, v));
}

/** Comparison with strict typing (no coercion). Missing (undefined) never orders/matches. */
function cmp(actual: unknown, op: CmpOp, value: unknown): boolean {
  if (op === "eq") return valueEq(actual, value);
  if (actual === undefined) return false;
  if (typeof actual !== typeof value) return false; // no coercion
  if (typeof actual === "number" && typeof value === "number") {
    return order(actual, value, op);
  }
  if (typeof actual === "string" && typeof value === "string") {
    return order(actual < value ? -1 : actual > value ? 1 : 0, 0, op);
  }
  return false; // booleans/objects are not ordered
}

function order(a: number, b: number, op: CmpOp): boolean {
  switch (op) {
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

/** Strict equality, no coercion. Deep-compares arrays/objects structurally. */
function valueEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Records sorted by the pattern's order (then record id, always, for determinism). */
export function orderRecords(
  records: RadiaRecord[],
  orderBy: OrderBy[] | undefined,
): RadiaRecord[] {
  return [...records].sort((x, y) => compareRecords(x, y, orderBy ?? []));
}

/**
 * The whole page clause for one keyset walk: the direction, the cursor comparison, and the ORDER BY,
 * decided together in one place.
 *
 * A PAIR is not enough, and that is the lesson rather than a preference. This default was written
 * five times in three forms (twice per dialect, plus `pageRecords` below), and the SQL paths derive
 * the comparison from the direction while the oracle path reverses a sorted array. Changing four of
 * the five produced not a test failure but a silently broken cursor: a 25-record kind paged 139
 * records with repeats and never terminated, because SQL walked one way while the oracle ordered the
 * other and `after` therefore pointed backwards. Emitting the clause leaves nothing to mismatch.
 *
 * `column` is the qualified id column (`id`, `r.id`) and `placeholder` renders the dialect's bind
 * marker, the same injection the `JsonDialect` in `storage/pushdown.ts` already uses. `params` holds
 * the cursor value when there is one, so a caller splices rather than deciding.
 *
 * The default is ASCENDING, deliberately: it matches the claim order (`take` ranks
 * `available_at asc, record_id asc`), which is what makes `after` a forward walk through time.
 * See agent_docs/plan-bounded-reads.md.
 */
export function pageClause(
  page: { after?: string; dir?: "asc" | "desc" } | undefined,
  o: { column: string; placeholder: () => string },
): { where: string; orderBy: string; params: string[]; dir: "asc" | "desc"; cmp: "<" | ">" } {
  const dir = page?.dir === "desc" ? "desc" : "asc";
  const cmp = dir === "desc" ? "<" : ">";
  return {
    where: page?.after ? ` and ${o.column} ${cmp} ${o.placeholder()}` : "",
    orderBy: `order by ${o.column} ${dir}`,
    params: page?.after ? [page.after] : [],
    // For a caller that must build a SECOND cursor on the same axis: the chunked scan walks the
    // kind in pieces and needs its own comparison, which must be the one this page already chose.
    // Handed back rather than re-derived, so the two cannot disagree.
    dir,
    cmp,
  };
}

/** Whether a natural-order page walks newest-first. The oracle path has no cursor to render, so it
 *  takes only this half, from the same decision `pageClause` makes. */
export function pageIsDescending(page?: { dir?: "asc" | "desc" }): boolean {
  return page?.dir === "desc";
}

export function pageRecords(
  records: RadiaRecord[],
  orderBy: OrderBy[] | undefined,
  limit: number,
  page?: { dir?: "asc" | "desc" },
): RadiaRecord[] {
  const ordered = orderRecords(records, orderBy);
  const natural = !orderBy || orderBy.length === 0;
  if (natural && pageIsDescending(page)) ordered.reverse();
  return ordered.slice(0, limit);
}

/** First record by the pattern's order (then record id, always, for determinism). */
export function firstByOrder(
  records: RadiaRecord[],
  orderBy: OrderBy[] | undefined,
): RadiaRecord | null {
  return records.length === 0 ? null : orderRecords(records, orderBy)[0];
}

function compareRecords(x: RadiaRecord, y: RadiaRecord, orderBy: OrderBy[]): number {
  for (const key of orderBy) {
    const c = compareValues(getPath(x.body, key.path), getPath(y.body, key.path));
    if (c !== 0) return key.dir === "desc" ? -c : c;
  }
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; // deterministic tie-break
}

function compareValues(a: unknown, b: unknown): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // missing sorts last
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a), bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
