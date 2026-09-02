// `openapi/radia-ext.yaml` held to the route table it describes (`EXT_ROUTES` in
// `src/surfaces/extserve.ts`), both directions, request fields included.
//
// The spec is deliberately NOT the frozen contract (that is `radia.yaml`, guarded by
// `openapi.test.ts`): it is a DESCRIPTION of routes that evolve with the binary, for the
// cross-language audience that cannot read the TS to correct a drifted one — which is exactly why
// an unguarded copy would be worse than none. The table is the single statement: the dispatch
// takes its allowlists from it (`fieldsOf` throws on a missing entry), this file holds the spec
// to it, and a behavioural probe below proves each table route is one the dispatcher recognises.
//
// The YAML parse is shallow, by line shape, exactly as `openapi.test.ts` reads `radia.yaml`: this
// test and the spec are written together, so the layout is a contract between them, and a spec
// these regexes cannot read fails the non-empty assertion rather than half-passing.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../sdk/ts/client.ts";
import { EXT_ROUTES, extHandler } from "../src/surfaces/extserve.ts";

const SPEC = new URL("../openapi/radia-ext.yaml", import.meta.url).pathname;
const yaml = await Deno.readTextFile(SPEC);

/** (method, path) per documented operation, with the `servers` base applied. */
function specOperations(text: string): { method: string; path: string }[] {
  const base = text.match(/^servers:\s*\n\s*- url:\s*(\S+)/m)?.[1] ?? "";
  const body = text.split("\npaths:", 2)[1]?.split("\ncomponents:", 2)[0] ?? "";
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

/** The lines of ONE operation: from its method key to the next method or the next path. */
function operationLines(text: string, path: string, method: string): string[] | null {
  const body = text.split("\npaths:", 2)[1]?.split("\ncomponents:", 2)[0] ?? "";
  const lines = body.split("\n");
  let i = lines.findIndex((l) => new RegExp(`^ {2}${path.replace(/[/{}.]/g, "\\$&")}:\\s*$`).test(l));
  if (i < 0) return null;
  for (i++; i < lines.length && !/^ {2}\//.test(lines[i]); i++) {
    if (new RegExp(`^ {4}${method.toLowerCase()}:\\s*$`).test(lines[i])) break;
  }
  if (i >= lines.length || !new RegExp(`^ {4}${method.toLowerCase()}:`).test(lines[i])) return null;
  const out: string[] = [];
  for (i++; i < lines.length && !/^ {2}\//.test(lines[i]) && !/^ {4}[a-z]+:\s*$/.test(lines[i]); i++) {
    out.push(lines[i]);
  }
  return out;
}

/** `{name, in}` for an operation's parameters, read from `- name:` / `in:` line pairs. */
function specParams(op: string[]): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (let i = 0; i < op.length; i++) {
    const n = op[i].match(/^ {8}- name:\s*(\w+)\s*$/);
    if (!n) continue;
    for (let j = i + 1; j < op.length && j <= i + 3; j++) {
      const w = op[j].match(/^ {10}in:\s*(\w+)\s*$/);
      if (w) {
        out.push({ name: n[1], where: w[1] });
        break;
      }
    }
  }
  return out;
}

/** The component name an operation's requestBody references, or null when it has none. */
function requestSchemaRef(op: string[]): string | null {
  let inBody = false;
  for (const line of op) {
    if (/^ {6}requestBody:\s*$/.test(line)) inBody = true;
    else if (/^ {6}\w+:\s*$/.test(line)) inBody = false;
    else if (inBody) {
      const m = line.match(/#\/components\/schemas\/(\w+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Property names of a named schema under `components/schemas`, read by indentation
 *  (`openapi.test.ts` reads `radia.yaml` the same way). */
function componentFields(text: string, name: string): string[] {
  const lines = text.split("\n");
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

/** A table path as the spec writes it: absolute under /ext, rest-params flattened. */
const specPathOf = (p: string) => "/ext/" + p.replace(/\{(\w+)\.\.\.\}/g, "{$1}");

Deno.test("[ext-openapi] every table route is documented, and nothing else is", () => {
  const ops = specOperations(yaml);
  assert(ops.length > 0, "the spec parsed to zero operations; the layout contract broke");
  // `GET /ext/health` is the one route outside the table: it is the discovery endpoint the table
  // itself is advertised through, unauthenticated, and the dispatch handles it before routing.
  const documented = new Set(ops.map((o) => `${o.method} ${o.path}`));
  const served = new Set(EXT_ROUTES.map((r) => `${r.method} ${specPathOf(r.path)}`));
  served.add("GET /ext/health");
  assertEquals([...documented].sort(), [...served].sort());
});

Deno.test("[ext-openapi] POST request schemas match the allowlists, field for field", () => {
  for (const r of EXT_ROUTES.filter((r) => r.method === "POST")) {
    const op = operationLines(yaml, specPathOf(r.path).slice("/ext".length), "post");
    assert(op, `spec has no POST ${r.path}`);
    const ref = requestSchemaRef(op);
    if (!r.fields) {
      assertEquals(ref, null, `POST ${r.path} reads no body, but the spec documents one`);
      continue;
    }
    assert(ref, `POST ${r.path} has fields but the spec's requestBody references no schema`);
    assertEquals(
      componentFields(yaml, ref).sort(),
      [...r.fields].sort(),
      `schema ${ref} does not match POST ${r.path}'s rejectUnknownFields allowlist`,
    );
  }
});

Deno.test("[ext-openapi] parameters match the table: query lists exactly, path params named", () => {
  for (const r of EXT_ROUTES) {
    const op = operationLines(yaml, specPathOf(r.path).slice("/ext".length), r.method.toLowerCase());
    assert(op, `spec has no ${r.method} ${r.path}`);
    const params = specParams(op);
    assertEquals(
      params.filter((p) => p.where === "query").map((p) => p.name).sort(),
      [...(r.query ?? [])].sort(),
      `${r.method} ${r.path}: documented query parameters differ from the ones the route reads`,
    );
    const pathParams = [...r.path.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    assertEquals(
      params.filter((p) => p.where === "path").map((p) => p.name).sort(),
      pathParams,
      `${r.method} ${r.path}: path parameters undocumented`,
    );
  }
});

Deno.test("[ext-openapi] every route the dispatch SERVES is in the table (nothing served-but-undocumented)", async () => {
  // The direction `openapi.test.ts` has over `radia.yaml` and this file otherwise lacked: a route
  // added to the dispatch without a table entry would be undocumented AND untested, the exact
  // drift the spec exists to prevent. A POST self-catches (`fieldsOf` throws), but a GET would
  // slip through. So scan the dispatch source: inside each `case "<ext>"` block, every
  // `rest === "<literal>"` branch is a served path `<ext>/v1/<literal>` that MUST be in the table.
  //
  // The three workspace routes matched by REGEX (`rest.match(/…files…|…edit|…{name}/)`) are not
  // literals and are covered behaviourally by the binding suite instead; this asserts they are
  // the ONLY regex branches, so a fourth added without a table entry fails here rather than
  // hiding.
  const src = await Deno.readTextFile(new URL("../src/surfaces/extserve.ts", import.meta.url).pathname);
  const dispatch = src.split("async function dispatch(", 2)[1] ?? "";
  assert(dispatch.length > 0, "could not find the dispatch function to scan");

  const tablePaths = new Set(EXT_ROUTES.map((r) => r.path));
  const served: string[] = [];
  let ext: string | undefined;
  for (const line of dispatch.split("\n")) {
    const c = line.match(/^ {4}case "(\w+)": \{/);
    if (c) {
      ext = c[1];
      continue;
    }
    if (!ext) continue;
    for (const m of line.matchAll(/rest === "([a-z]+)"/g)) served.push(`${ext}/v1/${m[1]}`);
  }
  assert(served.length >= 15, `scanned only ${served.length} literal routes; the dispatch shape changed`);
  const undocumented = [...new Set(served)].filter((p) => !tablePaths.has(p)).sort();
  assertEquals(undocumented, [], "dispatch serves these routes, but EXT_ROUTES (and the spec) omit them");

  // The regex branches: exactly the three workspace routes, each present in the table.
  const regexBranches = [...dispatch.matchAll(/rest\.match\(/g)].length;
  assertEquals(regexBranches, 3, "a workspace regex route was added or removed; update the table and this count");
  for (const p of ["workspace/v1/workspaces/{name}", "workspace/v1/workspaces/{name}/edit", "workspace/v1/workspaces/{name}/files/{path...}"]) {
    assert(tablePaths.has(p), `regex-matched route ${p} is not in EXT_ROUTES`);
  }
});

Deno.test("[ext-openapi] the dispatcher recognises every table route", async () => {
  // A stub client that reaches nothing: the question is whether the DISPATCH knows the path, so
  // any answer but its own miss (404 "no <METHOD> /ext/…") is a pass — a 400 for a missing field
  // or a 500 for the unreachable space both prove the route was found. The same bar as
  // `openapi.test.ts` direction 1.
  const handler = extHandler(() => new RadiaClient("http://127.0.0.1:1", "t"));
  for (const r of EXT_ROUTES) {
    const concrete = specPathOf(r.path).replace("{name}", "n").replace("{path}", "a/b.txt")
      .replace(/\{\w+\}/g, "x");
    const res = await handler(
      new Request(`http://x${concrete}`, { method: r.method, headers: { authorization: "Bearer t" } }),
    );
    const body = await res.json().catch(() => ({}));
    const miss = res.status === 404 && typeof body.detail === "string" && body.detail.startsWith(`no ${r.method} /ext/`);
    assert(!miss, `${r.method} ${concrete} is in EXT_ROUTES but the dispatcher does not serve it`);
  }
});

Deno.test("[ext-openapi] the spec states that it is not frozen", () => {
  // The file a cross-language reader finds must correct the assumption an OpenAPI file invites.
  assert(/NOT\s+frozen/.test(yaml), "the stability policy sentence is gone from the spec's description");
});
