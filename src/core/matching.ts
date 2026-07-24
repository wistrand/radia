// Template matching — compilation, validation, and the semantic ORACLE.
//
// The evaluator here DEFINES what a template matches. Adapters may later push predicates
// into indexed SQL, but that SQL must agree with this function; the conformance suite uses
// it as the reference. Keep it backend-neutral.
//
// Divergences from Mongo (deliberate, conformance-backed):
//   - missing != null: an absent field never matches except $exists:false
//   - no type coercion: cross-type comparison is false
//   - explicit array quantifiers $any/$each: scalar predicates never distribute over arrays
//   - $and/$or depth <= 3
// Forbidden forever: $regex/$where/$expr (templates are data, not code).
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

export interface OrderKey {
  path: string;
  dir?: "asc" | "desc";
}

/** Wire template. `match` values are implicit-$eq scalars or operator objects. */
export interface Template {
  kind: string;
  match?: Record<string, unknown>;
  orderBy?: OrderKey[];
}

/**
 * `grant ∧ request`: narrow a requested match by a set of grant templates (their union). Returns
 * a match object to compile — the request must match AND at least one grant template. Used for
 * template-scoped grants (server-side, per design-auth). `grantTemplates` must be non-empty; an
 * empty request means "all", so the result is just the constraint. Grant templates should be
 * simple (flat) — a nested `$or`/`$and` inside one can exceed the compiler's depth-3 limit.
 */
export function combineMatch(
  requestMatch: Record<string, unknown> | undefined,
  grantTemplates: Record<string, unknown>[],
): Record<string, unknown> {
  const constraint = grantTemplates.length === 1 ? grantTemplates[0] : { $or: grantTemplates };
  if (!requestMatch || Object.keys(requestMatch).length === 0) return constraint;
  return { $and: [requestMatch, constraint] };
}

const MAX_DEPTH = 3;
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

export function compileTemplate(t: Template, def: KindDef | undefined): CompiledMatch {
  const ctx: Ctx = {
    kind: t.kind,
    indexed: new Map((def?.indexedPaths ?? []).map((p) => [p.path, p.type])),
    sortable: new Set(def?.sortablePaths ?? []),
    registered: def !== undefined,
  };

  const where = t.match && Object.keys(t.match).length > 0
    ? compileObject(t.match, ctx, 1)
    : undefined;

  const orderBy = compileOrderBy(t.orderBy, ctx);

  return { kind: t.kind, where, orderBy };
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
  if (!orderBy || orderBy.length === 0) return undefined;
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
    return new RadiaError("operator_forbidden", `operator ${op} is not allowed (templates are data, not code)`);
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

/** Resolve a dotted path against a record body. Absent -> undefined (never null). */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
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

/** Records sorted by the template's order (then record id, always, for determinism). */
export function orderRecords(
  records: RadiaRecord[],
  orderBy: OrderBy[] | undefined,
): RadiaRecord[] {
  return [...records].sort((x, y) => compareRecords(x, y, orderBy ?? []));
}

/** First record by the template's order (then record id, always, for determinism). */
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
