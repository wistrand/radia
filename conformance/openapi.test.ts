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
