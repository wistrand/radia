// The frozen wire contract, checked against the thing that serves it (audit package P).
//
// `openapi/radia.yaml` is the source of truth for `/v0`, and nothing verified it — the enforcement
// status the layering rules had before `layering.test.ts` existed. Both directions of drift matter
// and fail differently: a path documented but not routed is a promise to a client that 404s, and a
// path routed but not documented is surface nobody agreed to freeze.
//
// Direction 1 is BEHAVIOURAL: every documented operation is driven through `makeHandler` and must
// not come back "no route for …". A 400, 401 or a not-found for the id is a pass — the question is
// whether the router recognises the path, not whether a synthetic request is valid. That matters
// because the router has no route TABLE to diff against: 21 literal `case` labels plus ten
// prefix-matched families, so the only complete enumeration is the spec itself.
//
// Direction 2 is STRUCTURAL, over the `/v0` string literals in `http.ts`, and it is the half that
// catches an endpoint someone added without touching the contract.
//
// The YAML parse is deliberately shallow (path keys and method keys, by line shape). A parser
// dependency for two regexes would cost more than it is worth, and a malformed spec fails loudly
// here rather than being half-read: the operation count is asserted non-zero.

import { assert, assertEquals } from "@std/assert";
import { makeArtifactHandler, makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";

const SPEC = new URL("../openapi/radia.yaml", import.meta.url).pathname;
const HTTP = new URL("../src/server/http.ts", import.meta.url).pathname;

/** (method, path) for every documented operation, with the `servers` base already applied. */
function specOperations(yaml: string): { method: string; path: string }[] {
  const base = yaml.match(/^servers:\s*\n\s*- url:\s*(\S+)/m)?.[1] ?? "";
  const body = yaml.split("\npaths:", 2)[1] ?? "";
  const out: { method: string; path: string }[] = [];
  let path: string | undefined;
  for (const line of body.split("\n")) {
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) {
      path = base + p[1];
      continue;
    }
    const m = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (m && path) out.push({ method: m[1].toUpperCase(), path });
  }
  return out;
}

/** Plausible values for the spec's path parameters. None needs to EXIST: a 404 for a missing
 *  record still proves the route was found, and only "no route for" means it was not. */
const PARAMS: Record<string, string> = {
  "{recordId}": "01J0000000000000000000000A",
  "{id}": "01J0000000000000000000000A",
  "{watchId}": "01J0000000000000000000000B",
  "{runId}": "run:01J0000000000000000000000C",
  "{agent}": "agent:example",
  "{capability}": "0123456789abcdef0123456789abcdef",
  "{action}": "reclaim",
};

function concrete(path: string): string {
  return path.replace(/\{[^}]+\}/g, (m) => PARAMS[m] ?? "x");
}

async function newHandler() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  // Auth OPEN: the subject is routing, and a 401 would mask which paths exist. BOTH handlers,
  // because the contract is served by two origins: capability URLs (`/v0/a/…`, `/v0/w/…`) are the
  // isolated artifact origin's, and scriptable bytes render there precisely so they share nothing
  // with the console. An operation is routed if EITHER answers to it.
  return {
    handler: makeHandler(space, "<html>console</html>", false),
    artifacts: makeArtifactHandler(space),
    close: () => adapter.close(),
  };
}

Deno.test("openapi: every documented operation is routed by the implementation", async () => {
  const ops = specOperations(await Deno.readTextFile(SPEC));
  assert(ops.length > 20, `the spec parse found ${ops.length} operations; it should find dozens`);

  const { handler, artifacts, close } = await newHandler();
  try {
    // The router's own miss, distinct from a handler's 404 for a record that does not exist.
    const unrouted = async (h: (r: Request) => Promise<Response>, method: string, url: string) => {
      const req = method === "GET" || method === "DELETE"
        ? new Request(url, { method })
        : new Request(url, { method, headers: { "content-type": "application/json" }, body: "{}" });
      const res = await h(req);
      const text = await res.text();
      return res.status === 404 && (text.includes("no route for") || text.includes("by capability URL only"));
    };
    const missing: string[] = [];
    for (const { method, path } of ops) {
      const url = `http://t${concrete(path)}`;
      if (await unrouted(handler, method, url) && await unrouted(artifacts, method, url)) {
        missing.push(`${method} ${path}`);
      }
    }
    assertEquals(missing, [], "documented operations with no route (the contract promises these)");
  } finally {
    await close();
  }
});

Deno.test("openapi: every `/v0` path the router names is documented", async () => {
  // Source text, because there is no table: the router matches 21 literal routes and ten
  // `startsWith` families. A literal here that no documented path starts with is undocumented
  // surface. Comments are stripped first — this file's own prose names paths, and so does
  // `http.ts`'s (two greps in this repo have matched their own explanation).
  const src = (await Deno.readTextFile(HTTP))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
  // The switch labels carry the METHOD inside the string (`"GET /v0/health"`), so the optional
  // verb prefix is part of the pattern; without it this matched nine of twenty-five and would have
  // passed while checking almost nothing.
  const literals = [
    ...new Set(
      [...src.matchAll(/["'`](?:(?:GET|POST|PUT|PATCH|DELETE) )?(\/v0\/[A-Za-z0-9\-_/]*)["'`]/g)].map((m) => m[1]),
    ),
  ];
  assert(literals.length > 20, `expected the router to name many /v0 paths, found ${literals.length}`);

  const documented = specOperations(await Deno.readTextFile(SPEC)).map((o) => o.path);
  // A literal is either a whole path or the PREFIX of a family (`/v0/ops/records/` covers
  // `/v0/ops/records/{recordId}/lineage`). Compare on the fixed part before the first parameter.
  const stems = new Set(documented.map((p) => p.split("/{")[0]));
  const undocumented = literals.filter((l) => {
    const stem = l.replace(/\/$/, "");
    return ![...stems].some((s) => s === stem || s.startsWith(stem + "/") || stem.startsWith(s + "/"));
  });
  assertEquals(undocumented, [], "routes the implementation serves that the contract does not describe");
});

// ---------------------------------------------------------------------------
// Direction 3: the FIELD level (audit package W7's promised guard, built 2026-08-26).
//
// Paths and methods were one level above where the drift lives. `explain` shipped on the frozen
// data plane with zero occurrences in the spec, and package X then produced five defects that were
// all the same shape from the other side: a request field picked BY NAME and silently dropped when
// misspelled (`patern` committed an unscoped grant, `allow_taint` removed a caller's taint barrier,
// `order_by` answered 200 unsorted rows). `rejectUnknown` closed that from the server. This closes
// it from the CONTRACT: a field the handler accepts and the spec never mentions is surface nobody
// agreed to freeze, and a field the spec promises and the handler refuses is a 400 waiting for a
// client that believed the document.
//
// The handler's own `rejectUnknown(j, [...])` list IS the enumeration; there is no second copy to
// keep in sync. That is the whole reason this is checkable at all.
// ---------------------------------------------------------------------------

/** Every `rejectUnknown(j, [...])` list in the server, by the handler function enclosing it. */
function handlerFields(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let fn = "";
  for (const line of src.split("\n")) {
    const f = line.match(/^export async function (handle\w+)/);
    if (f) fn = f[1];
    const r = line.match(/rejectUnknown\(\w+,\s*\[([^\]]*)\]/);
    if (r && fn) {
      const fields = [...r[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      // A handler may guard more than one body shape; union them, since the spec documents the
      // operation and not the branch.
      out.set(fn, [...new Set([...(out.get(fn) ?? []), ...fields])]);
    }
  }
  return out;
}

/** Property names of a named schema under `components/schemas`, read by indentation. */
function componentFields(yaml: string, name: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ {4}${name}:\\s*$`).test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lines[i].search(/\S/) <= 4) break; // next component
    if (/^ {6}properties:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        const col = lines[j].search(/\S/);
        if (col <= 6) break;
        if (col === 8) {
          const m = lines[j].match(/^\s*([A-Za-z_]\w*):/);
          if (m) out.push(m[1]);
        }
      }
    }
  }
  return out;
}

/** Property names under an operation's requestBody schema, read by indentation, INCLUDING those
 *  reached through `allOf` + `$ref`. Resolving the ref is not optional polish: `/records/query`
 *  composes `Pattern` that way, so a reader that skips it reports `kind` and `match` as
 *  undocumented, which is a guard that cries wolf on its first run. Shallow otherwise, like the
 *  path reader above; a spec this cannot read fails the non-empty assertion rather than passing. */
function specRequestFields(yaml: string, path: string, method: string): string[] | null {
  const body = yaml.split("\npaths:", 2)[1] ?? "";
  const lines = body.split("\n");
  let i = lines.findIndex((l) => new RegExp(`^ {2}${path.replace(/[/{}]/g, "\\$&")}:\\s*$`).test(l));
  if (i < 0) return null;
  // Walk to the method, stopping at the next path.
  for (i++; i < lines.length && !/^ {2}\//.test(lines[i]); i++) {
    if (new RegExp(`^ {4}${method}:\\s*$`).test(lines[i])) break;
  }
  if (i >= lines.length || !new RegExp(`^ {4}${method}:`).test(lines[i])) return null;
  // Then to `requestBody:` and no further. Bounding the scan there is what keeps this a REQUEST
  // check: the operation's `responses:` block carries its own `properties`, and reading those
  // reported every response field as a request the handler would reject.
  for (i++; i < lines.length && !/^ {2}\//.test(lines[i]) && !/^ {4}[a-z]+:\s*$/.test(lines[i]); i++) {
    if (/^ {6}requestBody:\s*$/.test(lines[i])) break;
  }
  if (i >= lines.length || !/^ {6}requestBody:/.test(lines[i])) return null;
  // Collect every inline `properties:` block and every `$ref`erenced component inside it, stopping
  // at the next key at the operation's own level (`responses:`).
  const props = new Set<string>();
  let sawSchema = false;
  for (i++; i < lines.length && !(lines[i].trim() !== "" && lines[i].search(/\S/) <= 6); i++) {
    const ref = lines[i].match(/\$ref:\s*"#\/components\/schemas\/(\w+)"/);
    if (ref) {
      sawSchema = true;
      for (const f of componentFields(yaml, ref[1])) props.add(f);
    }
    if (/^\s+properties:\s*$/.test(lines[i])) {
      sawSchema = true;
      const indent = lines[i].search(/\S/) + 2;
      for (let j = i + 1; j < lines.length; j++) {
        const cur = lines[j].search(/\S/);
        if (lines[j].trim() === "") continue;
        if (cur < indent) break;
        if (cur === indent) {
          const m = lines[j].match(/^\s*([A-Za-z_]\w*):/);
          if (m) props.add(m[1]);
        }
      }
    }
  }
  return sawSchema ? [...props] : null;
}

Deno.test("openapi: every request field a handler accepts is in the contract", async () => {
  const yaml = await Deno.readTextFile(SPEC);
  const handlers = new Map<string, string[]>();
  for (const f of ["records.ts", "leases.ts", "ops.ts", "agents.ts", "artifacts.ts", "watches.ts"]) {
    const src = await Deno.readTextFile(new URL(`../src/server/handlers/${f}`, import.meta.url));
    for (const [k, v] of handlerFields(src)) handlers.set(k, v);
  }
  assert(handlers.size >= 4, `failed to extract rejectUnknown lists; found ${handlers.size}`);

  // The one mapping this cannot derive: a handler name to the operation it serves. Kept here rather
  // than guessed, and asserted non-empty, so adding a guarded handler without a row is visible.
  const ROUTES: Record<string, { path: string; method: string }> = {
    handleQuery: { path: "/records/query", method: "post" },
    handleRegistry: { path: "/records/registry", method: "post" },
    handleReadOne: { path: "/records/read-one", method: "post" },
    handleTake: { path: "/takes", method: "post" },
    handleRemediate: { path: "/ops/remediate", method: "post" },
  };

  const problems: string[] = [];
  for (const [fn, accepted] of handlers) {
    const route = ROUTES[fn];
    if (!route) continue; // a guarded handler with no row: reported below, not here
    const documented = specRequestFields(yaml, route.path, route.method);
    if (documented === null) {
      problems.push(`${route.method.toUpperCase()} ${route.path}: no requestBody properties in the spec, but ${fn} accepts ${accepted.length} fields`);
      continue;
    }
    for (const field of accepted) {
      if (!documented.includes(field)) {
        problems.push(`${route.method.toUpperCase()} ${route.path}: handler accepts \`${field}\`, the contract does not mention it`);
      }
    }
    for (const field of documented) {
      if (!accepted.includes(field)) {
        problems.push(`${route.method.toUpperCase()} ${route.path}: the contract promises \`${field}\`, ${fn} would answer 400 for it`);
      }
    }
  }
  assertEquals(problems, [], "the frozen contract and its handlers disagree about request fields");

  // Every handler that bothers to guard its fields should be reachable from a row above, or the
  // check quietly covers less than it looks.
  const unmapped = [...handlers.keys()].filter((h) => !ROUTES[h]);
  assertEquals(unmapped, [], "these handlers guard their request fields but no route row maps them to an operation");
});
