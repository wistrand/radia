// Extension conventions over HTTP: the app-facing binding (agent_docs/plan-extension-http.md).
//
// A CLIENT THAT HAPPENS TO LISTEN, in git-serve's slot: it binds its own port, composes `/v0`
// through the SDK and the extension conventions, and the runtime learns nothing. The routes are a
// BINDING of the extension contract, versioned per extension and deliberately NOT part of the
// frozen wire contract in `openapi/radia.yaml`: extensions evolve with the binary.
//
// ZERO CREDENTIALS. Every request runs under the CALLER's own Bearer token (`clientFor`, the same
// move as `git-http.ts`), so the facade adds no authority and there is no deputy to confuse. What
// it serves is CHOREOGRAPHY a non-TS app cannot safely hand-implement (workspace writes, the
// capability publish anchors, windowed presence beats), the fold reads, and digest verification.
// Vocabulary stays in the space: kinds are `kind_def` records, discovered by query.
//
// CORS is permissive on purpose: authentication is the Bearer header, never a cookie, so an
// allowed origin gains nothing a curl does not already have. This is also the browser story the
// runtime itself lacks (research-app-lessons.md: "no CORS, so every browser app proxies").

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";
import type { Pattern, RadiaRecord } from "../../sdk/ts/client.ts";
import {
  type EditInput,
  editWorkspace,
  mediaTypeFor,
  readWorkspace,
  summarizeWorkspaces,
  treeDigestOf,
  validatePath,
  WORKSPACE_KIND,
  type WorkspaceFile,
  type WorkspaceScope,
  type WriteInput,
  writeWorkspace,
} from "../../extensions/ts/workspace.ts";
import {
  CAPABILITY_KIND,
  collapseByTool,
  liveAdvertisements,
  liveCapabilities,
  publishCapability,
  retireCapability,
  type ToolDef,
} from "../../extensions/ts/capability.ts";
import { beatPresence, livePresence, presenceKind, presenceSpec, retirePresence } from "../../extensions/ts/presence.ts";
import { declareExecRequest, EXEC_REQUEST, type Pin, pinnedDigests, promote, rollback } from "../../extensions/ts/promotion.ts";
import { declareBinding, readBindings } from "../../extensions/ts/host.ts";
import { auditCompartment } from "../../extensions/ts/compartment.ts";
import { UsageError } from "../platform.ts";

export interface ExtServeLog {
  status: number;
  method: string;
  path: string;
}

/** How a request resolves to a client. `null` is a 401. The token may be either half of a
 *  credential: a run token is used as-is, a definition token is exchanged by the SDK on the first
 *  refusal (`{token, definitionToken}` both set covers both, see `bearerClientFor`). */
export type ExtClientFor = (req: Request) => RadiaClient | null | Promise<RadiaClient | null>;

/**
 * The caller's Bearer token, relayed as a `/v0` client against `base`.
 *
 * One client per TOKEN, not per request: a fresh client per request would exchange a definition
 * token every time, which is an `agent_run` mint per call. Bounded, oldest out. BOTH halves are
 * set on the client: a run token is used as-is, and a definition token — which the space refuses
 * as a bearer — is exchanged by the SDK on that first 401. `reuseRun`, so a definition relayed
 * here holds ONE run instead of appending one per cache eviction.
 */
export function bearerClientFor(base: string): ExtClientFor {
  const clients = new Map<string, RadiaClient>();
  return (req) => {
    const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    const cached = clients.get(token);
    if (cached) return cached;
    if (clients.size >= 256) clients.delete(clients.keys().next().value as string);
    const fresh = new RadiaClient(base, { token, definitionToken: token, reuseRun: true });
    clients.set(token, fresh);
    return fresh;
  };
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

/** Every non-preflight response: liveness and tool views must not be served from a browser's
 *  heuristic cache, and nothing here is cacheable anyway. Preflights keep plain CORS, since their
 *  caching is `access-control-max-age`'s business. */
const BASE_HEADERS: Record<string, string> = { ...CORS, "cache-control": "no-store" };

/** Media types safe to hand a browser INLINE: the main-origin paint rule restated (`RENDERABLE`,
 *  `src/server/handlers/artifacts.ts`; a surface may not import the value). Raster images, audio
 *  and video only — not svg or pdf (scriptable), not text/* (renders as markup). The file route
 *  serves CALLER-AUTHORED bytes, and co-hosted that is the console's own origin, so it follows the
 *  same rule the runtime's main-origin artifact serving does: everything else downloads, every
 *  response is nosniff under a no-privilege CSP. Programs are unaffected (fetch ignores
 *  content-disposition), and a browser navigation carries no bearer, so it 401s before this
 *  matters; these headers are the depth behind that. */
const PAINT_SAFE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

/** What `GET /health` advertises, and the one place the route set states its versions. */
export const EXTENSIONS = {
  workspace: "v1",
  capability: "v1",
  presence: "v1",
  turn: "v1",
  permissions: "v1",
  promotion: "v1",
  host: "v1",
  compartment: "v1",
} as const;

export interface ExtRoute {
  method: "GET" | "POST";
  /** Under `/ext/`. `{param}` is one path segment; `{param...}` matches across slashes. */
  path: string;
  /** POST body fields, verbatim the `rejectUnknownFields` allowlist (absent: no body is read). */
  fields?: readonly string[];
  /** Query parameters the route reads. */
  query?: readonly string[];
}

/**
 * ONE statement of the route set, with four consumers: the dispatch below takes every POST
 * allowlist from it (`fieldsOf`, which throws on a missing entry, so a route the table forgot
 * fails its first use), and `test/extopenapi.test.ts` holds `openapi/radia-ext.yaml` to it in
 * both directions, fields included. The spec DESCRIBES this table; it never generates routes.
 */
export const EXT_ROUTES: readonly ExtRoute[] = [
  { method: "GET", path: "workspace/v1/workspaces", query: ["conversationId", "scope"] },
  {
    method: "POST",
    path: "workspace/v1/workspaces",
    fields: ["name", "owner", "conversationId", "files", "filesBase64", "attach", "modes", "ignore", "entrypoint", "basedOn", "taint", "meta", "scope"],
  },
  { method: "GET", path: "workspace/v1/workspaces/{name}", query: ["conversationId", "scope"] },
  { method: "GET", path: "workspace/v1/workspaces/{name}/files/{path...}", query: ["conversationId", "scope"] },
  {
    method: "POST",
    path: "workspace/v1/workspaces/{name}/edit",
    fields: ["conversationId", "edits", "add", "addBase64", "attach", "modes", "remove", "entrypoint", "meta", "scope"],
  },
  { method: "POST", path: "workspace/v1/declare" },
  { method: "POST", path: "workspace/v1/digest", fields: ["files"] },
  { method: "POST", path: "capability/v1/declare" },
  { method: "POST", path: "capability/v1/publish", fields: ["def", "provider", "scope", "presence"] },
  { method: "POST", path: "capability/v1/retire", fields: ["tool", "provider", "supersedes", "scope"] },
  { method: "GET", path: "capability/v1/tools", query: ["scope", "presenceKind", "ttlMs", "refreshMs", "onConflict"] },
  { method: "POST", path: "presence/v1/declare", fields: ["kind", "ttlMs", "refreshMs"] },
  { method: "POST", path: "presence/v1/beat", fields: ["kind", "ttlMs", "refreshMs", "subject", "instance"] },
  { method: "POST", path: "presence/v1/retire", fields: ["kind", "ttlMs", "refreshMs", "subject", "instance"] },
  { method: "GET", path: "presence/v1/live", query: ["kind", "subject", "ttlMs", "refreshMs", "maxScan"] },
  {
    method: "POST",
    path: "turn/v1/seed",
    fields: ["kind", "body", "key", "parentIds", "clientMeta", "availableAt", "deadlineAt", "retentionUntil", "taint", "result"],
  },
  { method: "GET", path: "turn/v1/result", query: ["seed", "kind", "timeoutMs"] },
  { method: "GET", path: "permissions/v1/scopes" },
  { method: "POST", path: "promotion/v1/declare" },
  { method: "GET", path: "promotion/v1/pins", query: ["principal", "tier", "kind"] },
  { method: "POST", path: "promotion/v1/promote", fields: ["digest", "tier", "pins", "kind"] },
  { method: "POST", path: "promotion/v1/rollback", fields: ["digest", "tier", "pins", "kind"] },
  { method: "POST", path: "host/v1/declare" },
  { method: "GET", path: "host/v1/bindings", query: ["agent"] },
  { method: "GET", path: "compartment/v1/audit", query: ["inside", "field"] },
];

function fieldsOf(path: string): readonly string[] {
  const r = EXT_ROUTES.find((r) => r.method === "POST" && r.path === path);
  if (!r?.fields) throw new Error(`EXT_ROUTES has no POST ${path} with fields`);
  return r.fields;
}

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 120_000;
const POLL_MS = 400;

/** Matches the workspace capture ceiling (`CAPTURE_LIMITS.maxBytes`, `extensions/ts/workspace.ts`),
 *  since the largest legitimate request here is a whole tree as JSON. Enforced HERE because the
 *  runtime's `maxRecordBytes` bounds only what reaches `/v0`, and by then this process has already
 *  buffered the request. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLarge";
  }
}

/** Read and parse a JSON request body under the cap, without trusting Content-Length. */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UsageError("request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...BASE_HEADERS },
  });
}

function problem(status: number, title: string, detail: string): Response {
  return new Response(JSON.stringify({ title, detail }), {
    status,
    headers: { "content-type": "application/problem+json", ...BASE_HEADERS },
  });
}

/** A refusal from the space keeps its status; a validation refusal from an extension is a 400 that
 *  names itself; only a genuine programming error (TypeError and kin) reports as a 500. Split from
 *  `errorResponse` so the seed route can carry the same parts BESIDE a `seedId`. */
function errorParts(e: unknown): { status: number; title: string; detail: string } {
  if (e instanceof RadiaClientError) {
    // `server_too_old` arrives as a status-200 client error, and an error body must not ride a 2xx.
    return { status: e.status >= 400 ? e.status : 502, title: e.code, detail: e.message };
  }
  if (e instanceof UsageError) return { status: 400, title: "bad_request", detail: e.message };
  if (e instanceof BodyTooLarge) return { status: 413, title: "payload_too_large", detail: e.message };
  // `queryAll` refuses to truncate a server-side walk past its page ceiling. That is a data-volume
  // refusal on this side of the relay, never the caller's request being wrong.
  if (e instanceof Error && e.message.startsWith("queryAll:")) {
    return { status: 502, title: "read_exhaustion", detail: e.message };
  }
  if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) {
    return { status: 500, title: "internal", detail: e.message };
  }
  if (e instanceof Error) return { status: 400, title: "rejected", detail: e.message };
  return { status: 500, title: "internal", detail: String(e) };
}

function errorResponse(e: unknown): Response {
  const { status, title, detail } = errorParts(e);
  return problem(status, title, detail);
}

/**
 * The facade's own `rejectUnknown` (`src/server/problem.ts` is the runtime's, and a surface may
 * not take a value from it): a field picked by name is silently dropped when misspelled, and
 * wherever that field NARROWS, dropping it WIDENS — a misspelled `scope` on a workspace write
 * would look up and supersede across every compartment the caller can read
 * (agent_docs/plan-bounded-reads.md). Refused NAMING the field and the fields the route has.
 */
function rejectUnknownFields(b: unknown, allowed: readonly string[], where: string): asserts b is Record<string, unknown> {
  // Guarded here so a sub-value sent as a string is "must be a JSON object", not the char-index
  // riddle Object.keys makes of one ("does not have '0', '1', …").
  if (typeof b !== "object" || b === null || Array.isArray(b)) {
    throw new UsageError(`${where} must be a JSON object`);
  }
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new UsageError(
      `${where} does not have ${unknown.map((k) => `'${k}'`).join(", ")}; its fields are ${allowed.join(", ")}`,
    );
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new UsageError(`'${name}' must be a non-empty string`);
  return v;
}

/** A `WorkspaceScope` from a request: scalar values only, exactly what a grant pattern can bind. */
function asScope(v: unknown, name: string): WorkspaceScope | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new UsageError(`'${name}' must be an object of scalars`);
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new UsageError(`'${name}.${k}' must be a string, number or boolean`);
    }
  }
  const entries = Object.entries(v as Record<string, string | number | boolean>);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function scopeParam(url: URL, name = "scope"): WorkspaceScope | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  try {
    return asScope(JSON.parse(raw), name);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`'${name}' must be a JSON object: ${(e as Error).message}`);
  }
}

function numParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`'${name}' must be a number`);
  return n;
}

function decodeBase64(b64: string, path: string): Uint8Array {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new UsageError(`'filesBase64.${path}' is not valid base64`);
  }
}

/** JSON can carry text and not bytes, so a tree arrives as two maps and merges into one. */
function mergeFiles(
  files: unknown,
  filesBase64: unknown,
): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {};
  if (files !== undefined) {
    if (typeof files !== "object" || files === null || Array.isArray(files)) {
      throw new UsageError("'files' must be an object of path -> string contents");
    }
    for (const [path, contents] of Object.entries(files as Record<string, unknown>)) {
      if (typeof contents !== "string") throw new UsageError(`'files.${path}' must be a string; put bytes in 'filesBase64'`);
      out[path] = contents;
    }
  }
  if (filesBase64 !== undefined) {
    if (typeof filesBase64 !== "object" || filesBase64 === null || Array.isArray(filesBase64)) {
      throw new UsageError("'filesBase64' must be an object of path -> base64 contents");
    }
    for (const [path, b64] of Object.entries(filesBase64 as Record<string, unknown>)) {
      if (typeof b64 !== "string") throw new UsageError(`'filesBase64.${path}' must be a base64 string`);
      if (path in out) throw new UsageError(`'${path}' appears in both 'files' and 'filesBase64'`);
      out[path] = decodeBase64(b64, path);
    }
  }
  return out;
}

/**
 * Wait for a record of `kind` descended from `seedId`.
 *
 * The exact walk is `getChildren` (ops plane, covered for ordinary callers by the PATTERN read
 * tier); a caller whose grants stop at the coordination plane falls back to a newest-first query
 * filtered on `parentIds`, which is a WINDOW: a result older than the newest 100 of its kind is
 * missed there, and the fallback is remembered per call rather than retried per poll.
 */
async function awaitResult(
  client: RadiaClient,
  seedId: string,
  kind: string,
  timeoutMs: number,
): Promise<RadiaRecord | null> {
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
  let opsDenied = false;
  for (;;) {
    let hit: RadiaRecord | undefined;
    if (!opsDenied) {
      try {
        hit = (await client.getChildren(seedId, 100)).find((r) => r.kind === kind);
      } catch (e) {
        if (e instanceof RadiaClientError && (e.status === 403 || e.status === 404)) opsDenied = true;
        else throw e;
      }
    }
    if (opsDenied) {
      const rows = await client.queryNewest({ kind } satisfies Pattern, 100);
      hit = rows.find((r) => r.runtimeMeta.parentIds?.includes(seedId));
    }
    if (hit) return hit;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, left)));
  }
}

/** Serve the extension bindings. Pure `(Request) => Response` so a test can drive it directly. */
export function extHandler(
  clientFor: ExtClientFor,
  onLog?: (entry: ExtServeLog) => void,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Guarded, because this is the one line that runs OUTSIDE the dispatch's try: a malformed
    // percent-encoding (`/%zz`) would otherwise throw through the server to a bare 500 — and
    // co-hosted, through `makeHandler`'s mount forward too.
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      onLog?.({ status: 400, method: req.method, path: url.pathname });
      return problem(400, "bad_request", `malformed percent-encoding in ${url.pathname}`);
    }
    const log = (status: number) => onLog?.({ status, method: req.method, path });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // BOTH spellings, one per hosting mode: `/health` standalone (`radia serve-ext`), `/ext/health`
    // when the same handler is mounted on the space's own port (`radia dev --ext`), where only the
    // `/ext/` prefix reaches it and root `/health` stays whatever the space says it is.
    if (path === "/health" || path === "/ext/health") {
      log(200);
      return json(200, { ok: true, service: "radia-ext", extensions: EXTENSIONS });
    }

    const route = path.match(/^\/ext\/(workspace|capability|presence|turn|permissions|promotion|host|compartment)\/v1\/(.+)$/);
    if (!route) {
      log(404);
      return problem(404, "not_found", "expected /health, or /ext/<extension>/v1/… for one of: " + Object.keys(EXTENSIONS).join(", "));
    }
    const [, extension, rest] = route;

    let client: RadiaClient | null;
    try {
      client = await clientFor(req);
    } catch (e) {
      log(401);
      return problem(401, "invalid_token", e instanceof Error ? e.message : String(e));
    }
    if (!client) {
      log(401);
      return new Response(JSON.stringify({ title: "auth_required", detail: "send Authorization: Bearer <token>" }), {
        status: 401,
        headers: { "content-type": "application/problem+json", "www-authenticate": "Bearer", ...BASE_HEADERS },
      });
    }

    try {
      const res = await dispatch(client, req, url, extension, rest);
      log(res.status);
      return res;
    } catch (e) {
      const res = errorResponse(e);
      log(res.status);
      return res;
    }
  };
}

async function dispatch(
  client: RadiaClient,
  req: Request,
  url: URL,
  extension: string,
  rest: string,
): Promise<Response> {
  const body = () => readJsonBody(req);
  const get = req.method === "GET" || req.method === "HEAD";
  const post = req.method === "POST";

  switch (extension) {
    case "workspace": {
      if (get && rest === "workspaces") {
        const r = await summarizeWorkspaces(client, {
          conversationId: url.searchParams.get("conversationId") ?? undefined,
          scope: scopeParam(url),
        });
        return json(200, r);
      }
      if (post && rest === "workspaces") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("workspace/v1/workspaces"), "POST workspaces");
        const input: WriteInput = {
          name: requireString(b.name, "name"),
          // The caller's durable name when none is given: the same identity `note.to` addresses.
          owner: typeof b.owner === "string" && b.owner
            ? b.owner
            : await client.health().then((h) => h.agent ?? h.principal),
          conversationId: typeof b.conversationId === "string" ? b.conversationId : undefined,
          files: mergeFiles(b.files, b.filesBase64),
          attach: b.attach as Record<string, string> | undefined,
          modes: b.modes as WriteInput["modes"],
          ignore: Array.isArray(b.ignore) ? b.ignore.map(String) : undefined,
          entrypoint: typeof b.entrypoint === "string" ? b.entrypoint : undefined,
          basedOn: typeof b.basedOn === "string" ? b.basedOn : undefined,
          taint: Array.isArray(b.taint) ? b.taint.map(String) : undefined,
          meta: asScope(b.meta, "meta"),
          scope: asScope(b.scope, "scope"),
        };
        return json(200, await writeWorkspace(client, input));
      }
      const file = rest.match(/^workspaces\/([^/]+)\/files\/(.+)$/);
      if (get && file) {
        const [, name, filePath] = file;
        const head = await readWorkspace(client, name, url.searchParams.get("conversationId") ?? undefined, scopeParam(url));
        if (!head) return problem(404, "not_found", `no workspace named ${JSON.stringify(name)}`);
        const entry = (head.files ?? []).find((f: WorkspaceFile) => f.path === filePath);
        if (!entry) return problem(404, "not_found", `no file ${JSON.stringify(filePath)} in workspace ${JSON.stringify(name)}`);
        const bytes = await client.getArtifact(entry.artifactId);
        const mediaType = mediaTypeFor(filePath);
        const filename = (filePath.split("/").pop() ?? filePath).replace(/["\\\r\n]/g, "_");
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": mediaType,
            "x-radia-digest": entry.digest,
            "content-disposition": `${PAINT_SAFE.test(mediaType) ? "inline" : "attachment"}; filename="${filename}"`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            ...BASE_HEADERS,
          },
        });
      }
      const edit = rest.match(/^workspaces\/([^/]+)\/edit$/);
      if (post && edit) {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("workspace/v1/workspaces/{name}/edit"), "POST workspaces/{name}/edit");
        if (b.edits !== undefined && (!Array.isArray(b.edits) || b.edits.some((e) => typeof e !== "object" || e === null))) {
          throw new UsageError("'edits' must be an array of edit objects");
        }
        const input: EditInput = {
          name: edit[1],
          conversationId: typeof b.conversationId === "string" ? b.conversationId : undefined,
          edits: b.edits as EditInput["edits"],
          add: mergeFiles(b.add, b.addBase64),
          attach: b.attach as Record<string, string> | undefined,
          modes: b.modes as EditInput["modes"],
          remove: Array.isArray(b.remove) ? b.remove.map(String) : undefined,
          entrypoint: typeof b.entrypoint === "string" ? b.entrypoint : undefined,
          meta: asScope(b.meta, "meta"),
          scope: asScope(b.scope, "scope"),
        };
        return json(200, await editWorkspace(client, input));
      }
      const one = rest.match(/^workspaces\/([^/]+)$/);
      if (get && one) {
        const head = await readWorkspace(client, one[1], url.searchParams.get("conversationId") ?? undefined, scopeParam(url));
        if (!head) return problem(404, "not_found", `no workspace named ${JSON.stringify(one[1])}`);
        return json(200, head);
      }
      if (post && rest === "declare") {
        // Setup, not per-turn work: declaring the convention's kind needs `kind_def: put`, which
        // an app's setup principal holds and its sessions do not. Served because the declaration
        // (indexed paths, no contentKey where the design says none) is the part an app in another
        // language would mis-declare, and a redeclaration that narrows is refused by the space.
        await client.registerKind(WORKSPACE_KIND);
        return json(200, { declared: WORKSPACE_KIND.kind });
      }
      if (post && rest === "digest") {
        // Verification, not authoring: the normative `treeDigestOf` over a caller-supplied file
        // list, so an app can CHECK a digest without reimplementing the hash.
        const b = await body();
        rejectUnknownFields(b, fieldsOf("workspace/v1/digest"), "POST digest");
        if (!Array.isArray(b.files)) throw new UsageError("'files' must be an array of {path, digest, mode?}");
        const files: WorkspaceFile[] = b.files.map((f: unknown, i: number) => {
          const e = f as Record<string, unknown>;
          const p = requireString(e.path, `files[${i}].path`);
          validatePath(p);
          return {
            path: p,
            mode: e.mode === "100755" ? "100755" : "100644",
            digest: requireString(e.digest, `files[${i}].digest`),
            artifactId: "",
          };
        });
        return json(200, { treeDigest: await treeDigestOf(files) });
      }
      break;
    }

    case "capability": {
      if (post && rest === "declare") {
        // Same as workspace/declare: the `contentKey` is what makes the registry projectable and
        // compactable, and is the field a hand-written declaration drops first.
        await client.registerKind(CAPABILITY_KIND);
        return json(200, { declared: CAPABILITY_KIND.kind });
      }
      if (post && rest === "publish") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("capability/v1/publish"), "POST publish");
        const def = b.def as ToolDef;
        if (def?.type !== "function" || typeof def.function?.name !== "string") {
          throw new UsageError("'def' must be a ToolDef: {type: \"function\", function: {name, description, parameters}}");
        }
        await publishCapability(
          client,
          def,
          typeof b.provider === "string" ? b.provider : undefined,
          asScope(b.scope, "scope") as Record<string, string> | undefined,
          { presence: b.presence === true },
        );
        return json(200, { published: def.function.name });
      }
      if (post && rest === "retire") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("capability/v1/retire"), "POST retire");
        await retireCapability(
          client,
          requireString(b.tool, "tool"),
          requireString(b.provider, "provider"),
          typeof b.supersedes === "string" ? b.supersedes : undefined,
          asScope(b.scope, "scope") as Record<string, string> | undefined,
        );
        return json(200, { retired: b.tool });
      }
      if (get && rest === "tools") {
        const reg = await liveCapabilities(client, scopeParam(url));
        let entries = [...reg.entries];
        let unserved = new Map<string, string[]>();
        let presence: { complete: boolean; policed: boolean } | undefined;
        const pk = url.searchParams.get("presenceKind");
        if (pk) {
          const spec = presenceSpec(pk, { ttlMs: numParam(url, "ttlMs"), refreshMs: numParam(url, "refreshMs") });
          // FAIL-OPEN, per `liveAdvertisements`'s own contract: a view the caller could not get
          // (no grant on the presence kind, an incomplete walk) polices NOTHING, because the
          // alternative is a failed read stripping a working fleet's whole tool list. `policed:
          // false` is the report; the tools still answer.
          let view: Awaited<ReturnType<typeof livePresence>> | undefined;
          try {
            view = await livePresence(client, spec);
          } catch {
            view = undefined;
          }
          const liveProviders = view?.complete ? new Set([...view.live.keys()]) : undefined;
          const filtered = liveAdvertisements(entries, liveProviders);
          entries = filtered.entries;
          unserved = filtered.unserved;
          presence = { complete: view?.complete ?? false, policed: liveProviders !== undefined };
        }
        const catalog = collapseByTool(entries, {
          onConflict: url.searchParams.get("onConflict") === "newest" ? "newest" : "withhold",
        });
        const rows = (m: Map<string, { def: ToolDef; providers: string[]; conflicted: boolean }>) =>
          [...m.entries()].map(([tool, e]) => ({ tool, ...e })).sort((a, b) => a.tool.localeCompare(b.tool));
        return json(200, {
          tools: rows(catalog.tools),
          conflicts: rows(catalog.conflicts),
          unserved: Object.fromEntries(unserved),
          complete: reg.complete,
          scanned: reg.scanned,
          ...(presence ? { presence } : {}),
        });
      }
      break;
    }

    case "presence": {
      // Writer and reader must agree on the pair (`PresenceSpec`), so every route takes the same
      // two optional knobs and the same construction validates them.
      const spec = (kind: string) => presenceSpec(kind, { ttlMs: numParam(url, "ttlMs"), refreshMs: numParam(url, "refreshMs") });
      const specFrom = (b: Record<string, unknown>) =>
        presenceSpec(requireString(b.kind, "kind"), {
          ttlMs: typeof b.ttlMs === "number" ? b.ttlMs : undefined,
          refreshMs: typeof b.refreshMs === "number" ? b.refreshMs : undefined,
        });
      if (post && rest === "declare") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("presence/v1/declare"), "POST declare");
        const s = specFrom(b);
        const def = presenceKind(s);
        await client.registerKind(def);
        return json(200, { kind: s.kind, ttlMs: s.ttlMs, refreshMs: s.refreshMs, defaultRetentionSeconds: def.defaultRetentionSeconds });
      }
      if (post && rest === "beat") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("presence/v1/beat"), "POST beat");
        const s = specFrom(b);
        const who = { subject: requireString(b.subject, "subject"), instance: requireString(b.instance, "instance") };
        await beatPresence(client, s, who);
        return json(200, { ok: true, refreshMs: s.refreshMs });
      }
      if (post && rest === "retire") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("presence/v1/retire"), "POST retire");
        await retirePresence(client, specFrom(b), {
          subject: requireString(b.subject, "subject"),
          instance: requireString(b.instance, "instance"),
        });
        return json(200, { ok: true });
      }
      if (get && rest === "live") {
        const kind = url.searchParams.get("kind");
        if (!kind) throw new UsageError("'kind' is required");
        const view = await livePresence(client, spec(kind), {
          subject: url.searchParams.get("subject") ?? undefined,
          maxScan: numParam(url, "maxScan"),
        });
        return json(200, {
          live: Object.fromEntries([...view.live.entries()].map(([s, set]) => [s, [...set].sort()])),
          scanned: view.scanned,
          complete: view.complete,
        });
      }
      break;
    }

    case "permissions": {
      if (get && rest === "scopes") {
        // Which pattern-scope fields the caller's own grants bind, per kind: the DISCOVERABLE
        // form of the label the MCP adapter learns from a refusal (`src/surfaces/mcp/scope.ts`),
        // for a stateless caller with no process to learn in. Discovery, never a fill: `patterns`
        // unions every grant on a kind whatever operation it permits (architecture-teams.md), so
        // which one to stamp on a write stays the caller's decision.
        const who = await client.health();
        const perms = await client.permissions(who.principal);
        const scopes = perms.kinds
          .filter((k) => k.patterns.length > 0)
          .map((k) => ({
            kind: k.kind,
            operations: k.operations,
            patterns: k.patterns,
            // Carried through so a discovered scope on a grant that authorizes NOTHING explains
            // the refusal that follows anyway, instead of reading as working access.
            ...(k.kindNotDeclared ? { kindNotDeclared: true as const } : {}),
            ...(k.readsScopedToSelf ? { readsScopedToSelf: true as const } : {}),
          }));
        return json(200, {
          principal: perms.principal,
          subject: perms.subject,
          scopes,
          note: "patterns union every grant on a kind whatever operation it permits; which to pass as a write's scope is the caller's choice",
        });
      }
      break;
    }

    case "promotion": {
      if (post && rest === "declare") {
        await declareExecRequest(client);
        return json(200, { declared: EXEC_REQUEST });
      }
      if (get && rest === "pins") {
        const principal = url.searchParams.get("principal");
        const tier = url.searchParams.get("tier");
        if (!principal || !tier) throw new UsageError("'principal' and 'tier' are required");
        const kind = url.searchParams.get("kind") ?? undefined;
        const digests = await pinnedDigests(client, { principal, tier, ...(kind ? { kind } : {}) });
        return json(200, { principal, tier, digests });
      }
      if (post && (rest === "promote" || rest === "rollback")) {
        const b = await body();
        rejectUnknownFields(b, fieldsOf(`promotion/v1/${rest}`), `POST ${rest}`);
        const digest = requireString(b.digest, "digest");
        const tier = requireString(b.tier, "tier");
        if (!Array.isArray(b.pins) || b.pins.length === 0) {
          throw new UsageError("'pins' must be a non-empty array of {principal, operations}");
        }
        const pins: Pin[] = b.pins.map((p, i) => {
          const e = p as Record<string, unknown>;
          rejectUnknownFields(e, ["principal", "operations"], `pins[${i}]`);
          if (!Array.isArray(e.operations) || e.operations.length === 0) {
            throw new UsageError(`'pins[${i}].operations' must be a non-empty array`);
          }
          return { principal: requireString(e.principal, `pins[${i}].principal`), operations: e.operations.map(String) };
        });
        const opts = { digest, tier, pins, ...(typeof b.kind === "string" ? { kind: b.kind } : {}) };
        // One implementation, two routes, exactly as the CLI has two verbs: the audit trail reads
        // better when the intent is in the path. Grant writes are operator-only, and the relay
        // keeps that the space's decision: a non-operator caller is refused there, not here.
        return json(200, rest === "promote" ? await promote(client, opts) : await rollback(client, opts));
      }
      break;
    }

    case "host": {
      if (post && rest === "declare") {
        await declareBinding(client);
        return json(200, { declared: "binding" });
      }
      if (get && rest === "bindings") {
        const agent = url.searchParams.get("agent");
        const bindings = await readBindings(client);
        return json(200, { bindings: agent ? bindings.filter((b) => b.agent === agent) : bindings });
      }
      break;
    }

    case "compartment": {
      if (get && rest === "audit") {
        const inside = (url.searchParams.get("inside") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (inside.length === 0) throw new UsageError("'inside' is required: comma-separated compartment kinds");
        const field = url.searchParams.get("field") ?? undefined;
        return json(200, await auditCompartment(client, { inside, ...(field ? { field } : {}) }));
      }
      break;
    }

    case "turn": {
      // Seed-and-wait: work ENTERS through the space and a worker claims it, so coordination is
      // never bypassed; HTTP only carries the record in and the result out.
      if (post && rest === "seed") {
        const b = await body();
        rejectUnknownFields(b, fieldsOf("turn/v1/seed"), "POST seed");
        const kind = requireString(b.kind, "kind");
        if (b.body === undefined) throw new UsageError("'body' is required");
        // Everything below is REFUSED-or-relayed, never dropped: `availableAt` silently lost would
        // make a deferred record claimable now, `retentionUntil` lost would make it permanent.
        const seed = await client.put(
          {
            kind,
            body: b.body,
            ...(Array.isArray(b.parentIds) ? { parentIds: b.parentIds.map(String) } : {}),
            ...(typeof b.clientMeta === "object" && b.clientMeta !== null ? { clientMeta: b.clientMeta as Record<string, unknown> } : {}),
            ...(typeof b.availableAt === "string" ? { availableAt: b.availableAt } : {}),
            ...(typeof b.deadlineAt === "string" ? { deadlineAt: b.deadlineAt } : {}),
            ...(typeof b.retentionUntil === "string" ? { retentionUntil: b.retentionUntil } : {}),
            ...(Array.isArray(b.taint) ? { taint: b.taint.map(String) } : {}),
          },
          typeof b.key === "string" ? b.key : undefined,
        );
        const result = b.result as { kind?: unknown; timeoutMs?: unknown } | undefined;
        if (!result) return json(200, { seedId: seed.id });
        rejectUnknownFields(result as Record<string, unknown>, ["kind", "timeoutMs"], "'result'");
        const resultKind = requireString(result.kind, "result.kind");
        const timeoutMs = typeof result.timeoutMs === "number" ? result.timeoutMs : DEFAULT_WAIT_MS;
        try {
          const hit = await awaitResult(client, seed.id, resultKind, timeoutMs);
          return json(200, hit ? { seedId: seed.id, result: hit } : { seedId: seed.id, result: null, timedOut: true });
        } catch (e) {
          // The seed is WRITTEN. An error that hides its id makes the caller retry the whole
          // request and, without a `key`, duplicate the seed; the wait's failure rides beside the
          // id instead, and `GET result` is the retry.
          const { status, title, detail } = errorParts(e);
          return json(status, { seedId: seed.id, error: { title, detail } });
        }
      }
      if (get && rest === "result") {
        const seedId = url.searchParams.get("seed");
        const kind = url.searchParams.get("kind");
        if (!seedId || !kind) throw new UsageError("'seed' and 'kind' are required");
        const hit = await awaitResult(client, seedId, kind, numParam(url, "timeoutMs") ?? 0);
        return json(200, hit ? { seedId, result: hit } : { seedId, result: null, timedOut: true });
      }
      break;
    }
  }
  return problem(404, "not_found", `no ${req.method} /ext/${extension}/v1/${rest}`);
}
