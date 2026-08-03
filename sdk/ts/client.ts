// RadiaClient: the TS SDK stub (seeded here; Phase 7 polishes it and adds Python parity).
// Thin fetch wrappers over the public /v0 API. This is exactly what an external agent uses. No
// privileged access. For M0 it imports the wire types from the repo; Phase 7 will extract
// a standalone type surface so the SDK can ship independently.

import type {
  AckResult,
  Lease,
  RadiaRecord,
  RenewResult,
  SettleResult,
  SpaceEvent,
  TakeResult,
} from "../../src/storage/adapter.ts";
import type { Pattern } from "../../src/core/matching.ts";
import type { Page } from "../../src/storage/adapter.ts";
import { activeByKey, grantKey, isRetired, newestByKey } from "../../src/core/registry.ts";
import type { PutRequest } from "../../src/core/record.ts";
import { KIND_DEF, type KindDef, kindDefKey, RESERVED_KINDS } from "../../src/core/kinds.ts";
export { RESERVED_KINDS };
// Re-exported because every client that reads a registry (capabilities, models, kinds, an app's
// own kinds) needs the SAME latest-wins-minus-retired rule the runtime uses. Six hand-rolled
// copies of this loop existed before it was shared, and the failure mode is silent.
export { activeByKey, activeSet, grantKey, isRetired, newestByKey, RETIRED } from "../../src/core/registry.ts";

export type { AckResult, KindDef, Lease, Page, PutRequest, RadiaRecord, SpaceEvent, Pattern };

export interface KindStateCount {
  kind: string;
  state: string;
  count: number;
}

export type TakeSelector = { pattern: Pattern } | { recordId: string; pattern?: Pattern };

export class RadiaClientError extends Error {
  constructor(public status: number, public code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RadiaClientError";
  }
}

/** Read RADIA_URL if env access is permitted; a no --allow-env worker falls back to the default.
 *  `127.0.0.1`, not `localhost`: `radia dev` binds the former and keys its provisioned credential
 *  by host, so the two names are two different spaces to anything that looks a credential up. */
function defaultBase(): string {
  try {
    return globalThis.Deno?.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
  } catch {
    return "http://127.0.0.1:7788";
  }
}

export interface ClientAuth {
  /** A run token (or definition token, for minting) sent as `Authorization: Bearer`. */
  token?: string;
}

/** What a grant narrowed a read to. Absent when nothing was narrowed. */
export interface ReadScope {
  /** Grant patterns ANDed into the request. Records outside them were not returned. */
  narrowedBy?: Record<string, unknown>[];
  /** True when the read was restricted to the caller's own records. */
  ownRecordsOnly?: true;
  note: string;
}

export class RadiaClient {
  private readonly auth: ClientAuth;
  /** @param auth a run token, either `{token}` or a bare token string. Omit for the default operator
   *  (`human:local`). To act as a scoped principal, mint a run token via the bootstrap chain. */
  constructor(readonly base: string = defaultBase(), auth: ClientAuth | string = {}) {
    this.auth = typeof auth === "string" ? { token: auth } : auth;
  }

  /** A client authenticated with a bearer token (e.g. a minted run token). */
  withToken(token: string): RadiaClient {
    return new RadiaClient(this.base, { token });
  }

  private async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.auth.token ? { "Authorization": `Bearer ${this.auth.token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new RadiaClientError(res.status, data?.title ?? "error", data?.detail ?? text);
    return data;
  }

  health(): Promise<{ storage: string; now: string; version: string; principal: string }> {
    return this.req("GET", "/v0/health");
  }

  /** Declare a kind: put a kind_def record (idempotent per declaration). Kinds are records,
   *  not a side endpoint. Discover them with `listKinds()` (a query for kind_def records). */
  async registerKind(def: KindDef): Promise<{ kind: string }> {
    await this.put({ kind: KIND_DEF, body: def }, kindDefKey(def));
    return { kind: def.kind };
  }

  put(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }> {
    return this.req("POST", "/v0/records", req, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
  }

  /** Assign a kind-scoped grant (a `grant` record, writable only by a human/supervisor
   *  principal). `operations` are coordination verbs: put | take | query | read_one. An optional
   *  `pattern` narrows read/take to `grant ∧ request` (pattern-scoped grant). */
  async grant(
    principal: string,
    kind: string,
    operations: string[],
    pattern?: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const body = pattern ? { principal, kind, operations, pattern } : { principal, kind, operations };
    // CONTENT-KEYED, so re-assigning an unchanged grant writes nothing rather than appending a
    // duplicate on every run. But a grant that was RETIRED (by a revocation, or by a definition
    // superseding it with a different pattern) cannot be revived under that same key: the write
    // replays the retirement, so nothing is written while this reports success and the principal
    // still holds nothing. Key the revival on the record it supersedes, the shape
    // `Space.createAgentDefinition` uses.
    let key = `grant:${principal}:${kind}:${[...operations].sort().join(",")}:${pattern ? JSON.stringify(pattern) : ""}`;
    const identity = grantKey(body);
    if (identity !== undefined) {
      try {
        const rows = await this.query({ kind: "grant", match: { principal, kind } }, 500, { dir: "desc" });
        // Anchor on the NEWEST RETIREMENT of this identity, not on whether the newest record
        // happens to be retired. That keeps the key stable across repeats: once revived, calling
        // again reuses the revival's key and writes nothing, where anchoring on "newest is
        // retired" would fall back to the plain key that the original record already consumed. A
        // later retirement moves the anchor, so the next revival is a fresh write.
        const supersedes = rows.find((r) => grantKey(r.body) === identity && isRetired(r.body));
        if (supersedes) key += `:after:${supersedes.id}`;
      } catch {
        // A caller that may write grants but not read them cannot tell a retirement from a fresh
        // key. Best effort: fall back to the plain key, which is the pre-existing behaviour.
      }
    }
    return this.put({ kind: "grant", body }, key);
  }

  /**
   * Declare what this run is listening for, as a record.
   *
   * Standing interest is otherwise invisible: a worker polls `take` with a pattern the space never
   * retains, so nothing can answer "who would receive this record?". Publishing it makes the
   * prospective topology queryable. It is DESCRIPTIVE and grants nothing; the grant records still
   * decide what may be claimed.
   *
   * Content-keyed, so republishing an unchanged interest writes nothing. Retiring and re-declaring
   * works because the key anchors on the retirement it supersedes, the same shape `grant()` uses.
   */
  async publishInterest(pattern: Pattern, opts: { retired?: boolean } = {}): Promise<{ id: string }> {
    const body: Record<string, unknown> = { kind: pattern.kind };
    if (pattern.match && Object.keys(pattern.match).length > 0) body.match = pattern.match;
    if (opts.retired) body.retired = true;
    const identity = `${pattern.kind}|${JSON.stringify(pattern.match ?? null)}`;
    let key = `interest:${opts.retired ? "retire:" : ""}${identity}`;
    try {
      const rows = await this.queryAll({ kind: "interest", match: { kind: pattern.kind } });
      const mine = rows.filter((r) => {
        const b = r.body as { kind?: string; match?: unknown };
        return b.kind === pattern.kind && JSON.stringify(b.match ?? null) === JSON.stringify(pattern.match ?? null);
      });
      const supersedes = mine.find((r) => isRetired(r.body) !== !!opts.retired);
      if (supersedes) key += `:after:${supersedes.id}`;
    } catch {
      // No grant to read the registry: fall back to the plain key rather than failing the loop.
    }
    return this.put({ kind: "interest", body }, key);
  }

  /** One read that orients an investigator: kinds and their indexed paths, record counts, who is
   *  listening, and what this caller may do. Generated from records, so it cannot drift. */
  digest(): Promise<{
    api: string;
    kinds: { kind: string; indexedPaths: string[]; sortablePaths?: string[]; claimable: boolean; reserved: boolean }[];
    counts: { kind: string; state: string; count: number }[];
    /** Routing topology as an edge list: one row per (kind, agent). */
    interests: { kind: string; agent: string; runs: number; patterns: number }[];
    interestsWithheld?: number;
    interestsNote?: string;
    permissions: unknown;
    complete: boolean;
  }> {
    return this.req("GET", "/v0/ops/digest");
  }

  /** The causally ordered story around a record: its lineage root, then everything descended from
   *  it. A composition of lineage and children, so no caller re-implements the walk or its paging. */
  thread(recordId: string): Promise<{ root: string; records: RadiaRecord[]; truncated: boolean; note?: string }> {
    return this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/thread`);
  }

  /** Which registered interests would receive a record of this shape? Operator-gated: it reports
   *  what every principal is listening for, not a self-scoped fact. */
  dryRun(kind: string, body?: unknown): Promise<{
    kind: string;
    interests: { run: string; agent?: string; match?: Record<string, unknown> }[];
    complete?: false;
    note?: string;
  }> {
    return this.req("POST", "/v0/ops/dry-run", { kind, body });
  }

  // ---- bootstrap chain (see design-auth.md) ----

  /** Operator: create an agent definition, optionally assigning its grants. Returns the
   *  definition token (shown once) used to mint runs. */
  createAgentDefinition(
    agent: string,
    grants: { principal: string; kind: string; operations: string[] }[] = [],
  ): Promise<{ agent: string; definitionToken: string }> {
    return this.req("POST", "/v0/agent-definitions", { agent, grants });
  }

  /** Mint a short-lived run token from a definition token. */
  createRun(definitionToken: string): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    return this.req("POST", "/v0/agent-runs", {}, { "Authorization": `Bearer ${definitionToken}` });
  }

  /**
   * Extend this client's run before it lapses. Returns the new expiry.
   *
   * Renew at HALF-LIFE, never on failure: an expired token is rejected before the renew handler
   * sees it, so a client that waits for a 401 has already lost the session. `keepAlive` below does
   * the scheduling; call this directly only if you own the timer.
   */
  renewRun(run: string): Promise<{ run: string; agent: string; expiresAt: string; maxLifetimeAt: string }> {
    return this.req("POST", `/v0/agent-runs/${encodeURIComponent(run)}/renew`);
  }

  /**
   * Keep this client's credential alive until `signal` aborts, renewing at half-life.
   *
   * Run tokens are short (15 min) so a leaked one stops working, which is right, and left every
   * long-running process dying mid-sentence, which is not. A run may renew until its absolute
   * lifetime; after that, and after a stop, the door is CLOSED (409) and `onLost` fires so the
   * caller can re-authenticate rather than retry forever.
   *
   * Failures that are not 409 are transient (a restarting space, a blip) and are retried, because
   * giving up on a network error would end a session that is still perfectly valid.
   */
  keepAlive(signal: AbortSignal, onLost?: (reason: string) => void): void {
    const tick = async () => {
      if (signal.aborted) return;
      let delayMs = 60_000;
      try {
        const who = await this.health();
        if (!who.principal.startsWith("run:")) return; // an operator token does not expire
        const { expiresAt } = await this.renewRun(who.principal);
        // Half of what is left, floored so a short window still gets a retry before it lapses.
        delayMs = Math.max(15_000, (Date.parse(expiresAt) - Date.now()) / 2);
      } catch (e) {
        if (e instanceof RadiaClientError && e.status === 409) {
          onLost?.(e.message);
          return;
        }
        delayMs = 30_000;
      }
      const t = setTimeout(tick, delayMs);
      signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    };
    void tick();
  }

  /**
   * Destroy an artifact's bytes, keeping the record, its lineage and the event log. Operator only.
   *
   * Irreversible, and by CONTENT: identical payloads are one blob, so every artifact record
   * referencing it loses the bytes. That case refuses unless `acknowledgeShared` is set.
   */
  shredArtifact(recordId: string, opts: { reason?: string; acknowledgeShared?: boolean } = {}): Promise<unknown> {
    return this.req("POST", `/v0/ops/records/${encodeURIComponent(recordId)}/shred`, opts);
  }

  /** Stop a run (operator, or the run's own definition/run token if this client carries it). */
  stopRun(run: string): Promise<{ run: string; status: string; applied: boolean }> {
    return this.req("POST", `/v0/agent-runs/${encodeURIComponent(run)}/stop`);
  }

  readOne(pattern: Pattern): Promise<RadiaRecord | null> {
    return this.req("POST", "/v0/records/read-one", pattern);
  }

  async query(pattern: Pattern, limit = 100, page?: Page): Promise<RadiaRecord[]> {
    const r = await this.req("POST", "/v0/records/query", { ...pattern, limit, ...page });
    return r.records;
  }

  /** A query that also reports the traps it walked into: a full page mistaken for a population, a
   *  default order that returns the OLDEST rows, an undeclared kind, an unindexed match path. The
   *  notes never change the result. */
  async queryExplained(
    pattern: Pattern,
    limit = 100,
    page?: Page,
  ): Promise<{ records: RadiaRecord[]; explain: string[]; nextAfter?: string }> {
    const r = await this.req("POST", "/v0/records/query", { ...pattern, limit, ...page, explain: true });
    return { records: r.records, explain: r.explain ?? [], nextAfter: r.nextAfter };
  }

  /**
   * One page, plus the cursor for the next one. `nextAfter` is undefined on the last page.
   *
   * Use this over `query` when walking a whole kind: a keyset cursor stays correct while records
   * are being written, where an offset would skip or repeat rows as the space grows underneath it.
   * `dir: "desc"` walks newest-first, which a plain `query` cannot express: its deterministic
   * order is ascending id, so a limit there always returns the OLDEST matches.
   */
  /** Present when a grant narrowed the read: what it was narrowed BY. An answer that does not say
   *  it is a slice gets reported as the whole kind. */
  async queryPage(
    pattern: Pattern,
    limit = 100,
    page?: Page,
    opts: { explain?: boolean } = {},
  ): Promise<{ records: RadiaRecord[]; nextAfter?: string; scope?: ReadScope; explain?: string[] }> {
    const r = await this.req("POST", "/v0/records/query", { ...pattern, limit, ...page, ...(opts.explain ? { explain: true } : {}) });
    return { records: r.records, nextAfter: r.nextAfter, scope: r.scope, explain: r.explain };
  }

  take(sel: TakeSelector, opts: { leaseSeconds?: number; allowTaint?: string[] } = {}): Promise<TakeResult | null> {
    return this.req("POST", "/v0/takes", { ...sel, leaseSeconds: opts.leaseSeconds, allowTaint: opts.allowTaint });
  }

  ack(lease: Lease, result?: PutRequest, idempotencyKey?: string): Promise<AckResult> {
    return this.req("POST", "/v0/leases/ack", { lease, result }, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
  }

  nack(lease: Lease, opts: { backoffSeconds?: number } = {}, idempotencyKey?: string): Promise<SettleResult> {
    return this.req("POST", "/v0/leases/nack", { lease, ...opts }, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
  }

  release(lease: Lease): Promise<SettleResult> {
    return this.req("POST", "/v0/leases/release", { lease });
  }

  renew(lease: Lease, opts: { leaseSeconds?: number } = {}): Promise<RenewResult> {
    return this.req("POST", "/v0/leases/renew", { lease, ...opts });
  }

  /**
   * One page of the event log plus the cursor to continue from.
   *
   * Prefer this over `getEvents` when paging: for a SCOPED caller the server withholds events it
   * may not see, so a page can be empty (or short) while the log continues. `nextAfter` is then
   * the only way to advance past what was withheld. `undefined` means the end.
   */
  async getEventsPage(
    after = "0",
    limit = 200,
  ): Promise<{ events: SpaceEvent[]; nextAfter?: string; scope?: unknown; withheld?: number; withheldNote?: string }> {
    const r = await this.req("GET", `/v0/ops/events?after=${encodeURIComponent(after)}&limit=${limit}`);
    return { events: r.events, nextAfter: r.nextAfter, scope: r.scope, withheld: r.withheld, withheldNote: r.withheldNote };
  }

  async getEvents(after = "0", limit = 200): Promise<SpaceEvent[]> {
    const r = await this.req("GET", `/v0/ops/events?after=${encodeURIComponent(after)}&limit=${limit}`);
    return r.events;
  }

  /** What a principal can actually do: the fold over its grants, computed and shown. Operator
   *  only. Use it before and after changing grants: the difference is whether the change did what
   *  was promised. */
  permissions(principal: string): Promise<unknown> {
    return this.req("GET", `/v0/ops/permissions?principal=${encodeURIComponent(principal)}`);
  }

  /** Stats plus, for a SCOPED caller, what the answer was narrowed to. Prefer this when the result
   *  will be shown to someone (or something) that could read an empty list as an empty space. */
  async getStatsReport(): Promise<{ stats: KindStateCount[]; scope?: { self: boolean; kinds: string[]; note: string } }> {
    const r = await this.req("GET", "/v0/ops/stats");
    return { stats: r.stats, scope: r.scope };
  }

  async getStats(): Promise<KindStateCount[]> {
    const r = await this.req("GET", "/v0/ops/stats");
    return r.stats;
  }

  /** All declared kinds: the latest kind_def record per kind name (a redeclaration is a
   *  successor record). Discovery through the substrate: a plain query, no kinds endpoint. */
  /**
   * Every record matching `pattern`, newest-first, paged to EXHAUSTION.
   *
   * Registry-shaped reads (capabilities, models, kinds, procedures, grants) must never be a
   * single bounded page. The server clamps `limit` (500), so asking for more returns a silent
   * prefix, and because a registry is read newest-first the records that fall off are exactly the
   * ones that matter: a retirement, a redeclaration, the tool published a minute ago. Both failure
   * directions are silent: an entry that should be gone stays live, one that should be live goes
   * missing.
   *
   * Throws rather than returning a plausible prefix when even the page budget is exhausted: a
   * caller projecting a registry cannot tell a truncated answer from a complete one.
   */
  async queryAll(pattern: Pattern, maxPages = 40): Promise<RadiaRecord[]> {
    const out: RadiaRecord[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.query(pattern, 500, { dir: "desc", after });
      out.push(...rows);
      if (rows.length < 500) return out;
      after = rows[rows.length - 1].id;
    }
    throw new Error(
      `queryAll: more than ${maxPages * 500} records match ${JSON.stringify(pattern)}. Refusing to ` +
        `return a partial registry view`,
    );
  }

  async listKinds(): Promise<KindDef[]> {
    // Paged to exhaustion: a superseded declaration would otherwise win (see `queryAll`).
    const records = await this.queryAll({ kind: KIND_DEF });
    const latest = activeByKey<KindDef>(records, (def) => (typeof def?.kind === "string" ? def.kind : undefined));
    return [...latest.values()].map((r) => r.body as KindDef);
  }

  /** Ops-plane envelope query: records filtered by runtime state (leased/available/…), optional
   *  `expired` (lapsed lease) / `stale` (seconds sat available). Returns records with envelopes. */
  async queryEnvelopes(
    q: { state: string; expired?: boolean; stale?: number; limit?: number },
  ): Promise<{ record: RadiaRecord | null; envelope: unknown }[]> {
    const p = new URLSearchParams({ state: q.state });
    if (q.expired) p.set("expired", "1");
    if (q.stale !== undefined) p.set("stale", String(q.stale));
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    const r = await this.req("GET", `/v0/ops/records?${p}`);
    return r.records;
  }

  async getRecord(recordId: string): Promise<RadiaRecord | null> {
    try {
      return await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}`);
    } catch (e) {
      if (e instanceof RadiaClientError && e.status === 404) return null;
      throw e;
    }
  }

  diagnostics(): Promise<unknown> {
    return this.req("GET", "/v0/ops/diagnostics");
  }

  /** Control-plane remediation: 'reclaim' | 'dead-letter' | 'requeue'. Returns {applied}. */
  async admin(action: "reclaim" | "dead-letter" | "requeue", recordId: string): Promise<{ applied: boolean }> {
    return await this.req("POST", `/v0/ops/records/${encodeURIComponent(recordId)}/${action}`);
  }

  /** Remediate every record matching an envelope selector. It takes the same selector
   *  `queryEnvelopes` does, so diagnosing and fixing use one vocabulary. Returns how many
   *  matched and were applied, and `more` when the page was full (loop until it is false to
   *  drain a backlog). */
  remediate(
    action: "reclaim" | "dead-letter" | "requeue",
    selector: { state: string; expired?: boolean; stale?: number; limit?: number },
  ): Promise<{ action: string; matched: number; applied: number; more: boolean; sample: string[] }> {
    return this.req("POST", "/v0/ops/remediate", { action, ...selector });
  }

  /** Privileged declassify (operator): emit a clean (untainted) successor of a tainted record. */
  declassify(recordId: string): Promise<{ declassifiedFrom: string; id: string }> {
    return this.req("POST", `/v0/ops/records/${encodeURIComponent(recordId)}/declassify`);
  }

  async getLineage(recordId: string): Promise<{ record: RadiaRecord; depth: number }[]> {
    const r = await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/lineage`);
    return r.lineage;
  }

  /** Records that reference this one via parent_ids: its children (the reverse of lineage).
   *  BOUNDED: fan-out is unbounded in principle, so this is a page. Use `getChildrenPage` to walk. */
  async getChildren(recordId: string, limit = 100): Promise<RadiaRecord[]> {
    return (await this.getChildrenPage(recordId, limit)).children;
  }

  /** One page of children plus the cursor for the next; `nextAfter` is undefined on the last. */
  async getChildrenPage(
    recordId: string,
    limit = 100,
    after?: string,
  ): Promise<{ children: RadiaRecord[]; nextAfter?: string }> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set("after", after);
    const r = await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/children?${q}`);
    return { children: r.children, nextAfter: r.nextAfter };
  }

  // ---- artifacts (design-data-model §2.4) ----

  /** Store bytes and get back the `artifact` record that references them. The payload never
   *  travels inside a record body; the record carries {digest, mediaType, size} and routes. */
  async putArtifact(
    bytes: Uint8Array,
    opts: {
      mediaType?: string;
      filename?: string;
      parentIds?: string[];
      taint?: string[];
      idempotencyKey?: string;
      /** Application fields merged into the artifact's record body, so an app can route and SCOPE
       *  artifacts it owns. A grant pattern matches the body, and the rest of the body is
       *  runtime-computed. Values must be scalars; the whole object travels in a header, so it must
       *  be ASCII. */
      meta?: Record<string, string | number | boolean | null>;
    } = {},
  ): Promise<{ id: string; digest: string; size: number }> {
    const headers: Record<string, string> = { "content-type": opts.mediaType ?? "application/octet-stream" };
    if (opts.filename) headers["x-radia-filename"] = opts.filename;
    if (opts.meta) {
      const json = JSON.stringify(opts.meta);
      // Fail here rather than at `fetch`, which throws an opaque ByteString error naming neither
      // the header nor the offending value.
      // deno-lint-ignore no-control-regex
      if (/[^\x00-\x7f]/.test(json)) throw new Error("artifact meta must be ASCII: it travels in a header");
      headers["x-radia-meta"] = json;
    }
    if (opts.parentIds?.length) headers["x-radia-parent-ids"] = opts.parentIds.join(",");
    // A comma list of labels, because a header can only carry a string. An EMPTY array is not the
    // same as absent (it is an explicit "no labels"), but on this path both mean the same thing:
    // raise nothing. Sending "true" here was the boolean's shape and is now an unknown label.
    if (opts.taint && opts.taint.length > 0) headers["x-radia-taint"] = opts.taint.join(",");
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (this.auth.token) headers["Authorization"] = `Bearer ${this.auth.token}`;
    // The cast works around a Deno lib typing quirk: `Uint8Array<ArrayBufferLike>` is a valid
    // request body at runtime but does not match the `BodyInit` union as declared.
    const res = await fetch(`${this.base}/v0/artifacts`, { method: "POST", headers, body: bytes as unknown as BodyInit });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new RadiaClientError(res.status, data?.title ?? "error", data?.detail ?? text);
    return data as { id: string; digest: string; size: number };
  }

  /** An artifact's bytes by record id. */
  async getArtifact(recordId: string): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (this.auth.token) headers["Authorization"] = `Bearer ${this.auth.token}`;
    const res = await fetch(`${this.base}/v0/artifacts/${encodeURIComponent(recordId)}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      let data: { title?: string; detail?: string } | null = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch { /* not a problem document */ }
      throw new RadiaClientError(res.status, data?.title ?? "error", data?.detail ?? text);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A short-lived, single-artifact download capability. Use it for contexts that cannot send an
   *  Authorization header (an `<img src>`). The returned `url` is relative to the space. */
  artifactCapability(recordId: string): Promise<{ capability: string; expiresAt: string; url: string }> {
    return this.req("POST", `/v0/artifacts/${encodeURIComponent(recordId)}/capability`);
  }

  /**
   * Watch a pattern: an async stream of wakeups (`{seq, recordId, kind}`) for matching
   * records that become available. Reconnects with a cursor on drop; on 410 cursor_expired
   * it restarts from the beginning (a real client would catch-up-query first). Ends when
   * `signal` aborts. M0/M1: use a kind-only pattern for wakeup-by-kind.
   */
  async *watch(pattern: Pattern, signal?: AbortSignal): AsyncGenerator<Wakeup> {
    const { watchId } = await this.req("POST", "/v0/watches", pattern) as { watchId: string };
    let cursor: string | undefined; // opaque resume token (Last-Event-ID), never parsed
    while (!signal?.aborted) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/v0/watches/${watchId}/events`, {
          headers: cursor !== undefined ? { "Last-Event-ID": cursor } : {},
          signal,
        });
      } catch {
        if (signal?.aborted) return;
        await sleep(300);
        continue;
      }
      if (res.status === 410) {
        cursor = "0"; // cursor_expired: restart (a real client catches up via query first)
        continue;
      }
      if (!res.ok || !res.body) {
        await sleep(300);
        continue;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let id: string | undefined;
            let data: string | undefined;
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = line.slice(3).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
            }
            if (id !== undefined) cursor = id; // opaque; echo back verbatim on reconnect
            if (data) yield JSON.parse(data) as Wakeup;
          }
        }
      } catch {
        // stream dropped; reconnect below
      }
      if (signal?.aborted) return;
      await sleep(200);
    }
  }
}

export interface Wakeup {
  seq: number;
  recordId: string;
  kind: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
