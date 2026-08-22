// RadiaClient: the TS SDK. Thin fetch wrappers over the public /v0 API. This is exactly what an
// external agent uses. No privileged access.
//
// SELF-CONTAINED, which it was not. This file used to import the wire types AND runtime values from
// `../../src/`, with a note saying a standalone type surface would be extracted later. It was not,
// and the consequence was not stylistic: `scripts/build-release.sh` stages `sdk/` and `extensions/`
// into the npm package and no `src/`, so the package's own entry point imported paths that are not
// in it. `sdk/ts/wire.ts` now owns the contract vocabulary and `src/` re-exports from it, so the
// dependency runs one way and the staged package resolves. `test/layering.test.ts` keeps it
// that way.

import type {
  AckResult,
  DelegatedRun,
  KindDef,
  Lease,
  Page,
  Pattern,
  PutRequest,
  RadiaRecord,
  RenewResult,
  SettleResult,
  SpaceEvent,
  TakeResult,
} from "./wire.ts";
import { type GraphNode, KIND_DEF, kindDefKey, RESERVED_KINDS } from "./wire.ts";
export type { GraphNode };
import { activeByKey, grantKey, isRetired, newestByKey } from "./registry.ts";
export { RESERVED_KINDS };
// Re-exported because every client that reads a registry (capabilities, models, kinds, an app's
// own kinds) needs the SAME latest-wins-minus-retired rule the runtime uses. Six hand-rolled
// copies of this loop existed before it was shared, and the failure mode is silent.
export { activeByKey, activeSet, grantKey, isRetired, newestByKey, readRegistry, RETIRED } from "./registry.ts";
export type { RegistryView } from "./registry.ts";
// Waiting for another agent's answer: the other half every client re-implements, and the one where
// a timeout is an ordinary outcome rather than an exception.
export { awaitResult } from "./await.ts";
export type { AwaitOptions, AwaitOutcome } from "./await.ts";

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

/**
 * Did this fail because the credential is over, as opposed to insufficient?
 *
 * The space distinguishes them and so must this: `token_expired` and `run_stopped` mean mint
 * another, `forbidden` means the principal may not do this and never will by trying again. A bare
 * 401 counts too, since a space that has forgotten a run answers that way.
 */
function expired(e: unknown): boolean {
  if (!(e instanceof RadiaClientError)) return false;
  return e.status === 401 || e.code === "token_expired" || e.code === "run_stopped";
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
  /**
   * The DURABLE half of the credential, exchanged for a run token whenever the short one stops
   * working. Never sent as the credential for an ordinary call: the space refuses it with
   * "a definition token does not authorize coordination; mint a run first", which is the property
   * that makes it safe to keep on disk. It can only mint.
   *
   * With one of these a client never needs re-authenticating by hand. Without one, an expired
   * token is the end of the session, which is what every consumer here used to live with: a run
   * token lives 15 minutes, renews until a 12-hour ceiling, and then the process is finished.
   */
  definitionToken?: string;
  /**
   * Ask each exchange for the run this credential already holds, instead of a new one
   * (`POST /v0/agent-runs {reuse: true}`).
   *
   * For a SHORT-LIVED process this is the difference between inspecting a space and growing it: a
   * run is a permanent record, and a CLI verb that exchanges once per invocation appends one every
   * time. Leave it off for a worker fleet, where two processes sharing a run principal would make
   * their records indistinguishable by author and `runs --stop` stop both.
   */
  reuseRun?: boolean;
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
    return await this.authorized(() => this.rawReq(method, path, body, headers));
  }

  /** One request, no retry. The exchange itself uses this: routing it through `req` made a FAILING
   *  exchange re-enter `authorized`, which awaited the in-flight exchange it was already inside and
   *  deadlocked. A revoked definition hung the caller instead of reporting itself. */
  private async rawReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
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

  // ---- the credential, kept alive without anybody re-authenticating ----

  /** One exchange at a time. Ten concurrent calls hitting an expired token must produce ONE new
   *  run, not ten: each `agent_runs` POST writes a record, and a fleet waking together would mint
   *  a burst of them and then discard all but the last. */
  private exchanging: Promise<void> | null = null;

  /**
   * Run `call`, and if the credential has expired, mint a fresh run and try once more.
   *
   * REACTIVE, not scheduled, and that is the point. `keepAlive` renews ahead of expiry, which works
   * only for a process that is awake: a laptop that sleeps through the window comes back holding a
   * token that cannot renew itself, and a browser tab or a `git` invocation never had a timer at
   * all. Exchanging on the failure covers every case a schedule cannot.
   *
   * ONCE. A second failure is a real one, and looping would turn an unauthorized client into a
   * request generator.
   *
   * ONLY ON EXPIRY. A 403 is a GRANT problem: the credential is fine and the principal may not do
   * this. Retrying it would spend a mint and hide the actual answer.
   */
  private async authorized<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (!this.auth.definitionToken || !expired(e)) throw e;
      await this.exchange();
      return await call();
    }
  }

  /** Swap the definition token for a fresh run token, in place. Never through `req`: see `rawReq`. */
  private exchange(): Promise<void> {
    this.exchanging ??= (async () => {
      try {
        const { run, runToken } = await this.rawReq("POST", "/v0/agent-runs", { reuse: this.auth.reuseRun === true }, {
          "Authorization": `Bearer ${this.auth.definitionToken}`,
        }) as { run: string; runToken: string };
        this.auth.token = runToken;
        this.runId = run;
      } finally {
        this.exchanging = null;
      }
    })();
    return this.exchanging;
  }

  /** The run this client is acting as, learned from its own exchange. Undefined for a client built
   *  on a plain token (an operator, or a run token minted elsewhere), which never exchanges. */
  private runId?: string;

  /**
   * Make sure this client holds a usable run token, minting one if it has only the durable half.
   *
   * Called for its effect at startup by anything that would rather fail at boot than on its first
   * real request, and by `watch()`, whose SSE connect is a raw fetch that never passes through
   * `req`. That stream is exactly where a credential fix gets forgotten: it did not carry
   * `Authorization` at all once, and every connect 401'd into a silent poll fallback.
   */
  async ensureCredential(): Promise<void> {
    if (this.auth.definitionToken && !this.auth.token) await this.exchange();
  }

  /**
   * The run token this client is using RIGHT NOW, which is not necessarily the one it was built
   * with: an exchange replaces it in place the first time the short half lapses.
   *
   * Exists for launchers that hand a credential to a child process. Passing the value you
   * constructed the client with is the bug this accessor is here to prevent: the parent recovers
   * silently through its definition token while the child, which has no durable half, is handed a
   * token that is already dead and can never mint another.
   */
  get bearerToken(): string | undefined {
    return this.auth.token;
  }

  /** `instance` changes on every restart and `persistent` says whether anything survived one, so a
   *  reconnecting client can tell "same space" from "same port". Both are absent from a space too
   *  old to report them. */
  health(): Promise<
    { storage: string; now: string; version: string; principal: string; instance?: string; startedAt?: string; persistent?: boolean }
  > {
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
        // PAGED TO EXHAUSTION, not one bounded page. The anchor is the newest RETIREMENT of this
        // identity, and past 500 records for one (principal, kind) a single page could miss it: the
        // write then dedupes against the original record, and this call reports success while the
        // principal holds nothing. It fails CLOSED, which is why it went unnoticed (audit W4).
        const rows = await this.queryAll({ kind: "grant", match: { principal, kind } });
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
   * THE KEY IS SCOPED TO THE RUN, not only to the content. Idempotency keys scope to the AGENT
   * behind a run, so a content-only key made a restarted worker's publish REPLAY its dead
   * predecessor's write: no record existed under the new run, and the registry — which keys entries
   * by author and drops dead runs — showed no listener for anything the fleet re-announced. Every
   * routing view of a lived-in space went empty on the first restart inside the idempotency window,
   * and no suite saw it, because suites run on fresh spaces with nothing to replay against. A
   * run-scoped key writes once per run and pattern, which is the registry's own granularity, and it
   * makes revival across restarts free: a new run's key is new, so no revive anchor (and no
   * registry-wide read to compute one) is needed.
   *
   * Within ONE run, publish → retire → publish leaves the interest retired: the second publish
   * replays the first, and the tombstone stays newest. No shipped caller does this; one that needs
   * it can `put` the record with its own key.
   */
  async publishInterest(pattern: Pattern, opts: { retired?: boolean } = {}): Promise<{ id: string }> {
    const body: Record<string, unknown> = { kind: pattern.kind };
    if (pattern.match && Object.keys(pattern.match).length > 0) body.match = pattern.match;
    if (opts.retired) body.retired = true;
    // Exchange BEFORE computing the key, or the first publish of a fresh client would key itself
    // to no run and then write under one. "self" covers callers with no run to name: an operator's
    // author never rolls, so a content-stable key is correct for them.
    await this.ensureCredential();
    const scope = this.runId ?? "self";
    const identity = `${pattern.kind}|${JSON.stringify(pattern.match ?? null)}`;
    return this.put({ kind: "interest", body }, `interest:${opts.retired ? "retire:" : ""}${scope}:${identity}`);
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

  /** Recompute the event chain. `signed:false` means the chain detects corruption and careless
   *  edits but not a deliberate rewrite, since whoever can write rows can recompute the hashes. */
  integrity(): Promise<{
    ok: boolean;
    checked: number;
    sealed: number;
    unsealed: number;
    signed: boolean;
    head?: { idx: number; hash: string };
    /** Present when the chain begins past genesis (event-log GC's anchor state). `attested`
     *  means a sealed horizon statement covers the truncation; unattested truncation fails. */
    truncated?: { anchorIdx: number; swept: number; attested: boolean };
    failure?: { idx: number; eventId: string; reason: string; detail: string };
    note?: string;
    truncatedNote?: string;
  }> {
    return this.req("GET", "/v0/ops/integrity");
  }

  /** Recurring shapes of work, mined from lineage. Nothing declares a topology here, so the shape
   *  is recovered from what happened; partial shapes are reported beside complete ones, since
   *  "starts often, rarely finishes" is the signal. */
  flows(opts: {
    granularity?: "kind" | "kind+agent";
    counts?: "bucketed" | "exact";
    maxRecords?: number;
    minOccurrences?: number;
    includeReserved?: boolean;
    includeSingletons?: boolean;
    hubDegree?: number;
    /** Body paths (max 4) summed per shape, e.g. `["usage.cost"]`: where the metric goes, by shape. */
    sum?: string[];
  } = {}): Promise<{
    granularity: string;
    counts: string;
    flows: {
      signature: string;
      occurrences: number;
      outcomes: { complete: number; open: number; failed: number };
      successRate: number;
      medianDurationMs: number;
      totalDurationMs: number;
      medianRecords: number;
      sums?: Record<string, { total: number; records: number }>;
      exemplars: string[];
    }[];
    scanned: { records: number; kinds: string[]; subgraphs: number };
    fragments: number;
    singletons: number;
    hubs: number;
    complete: boolean;
    notes?: string[];
    note?: string;
  }> {
    const q = new URLSearchParams();
    if (opts.granularity) q.set("granularity", opts.granularity);
    if (opts.counts) q.set("counts", opts.counts);
    if (opts.maxRecords !== undefined) q.set("max_records", String(opts.maxRecords));
    if (opts.minOccurrences !== undefined) q.set("min_occurrences", String(opts.minOccurrences));
    if (opts.includeReserved) q.set("include_reserved", "true");
    if (opts.includeSingletons) q.set("include_singletons", "true");
    if (opts.hubDegree !== undefined) q.set("hub_degree", String(opts.hubDegree));
    if (opts.sum?.length) q.set("sum", opts.sum.join(","));
    const qs = q.toString();
    return this.req("GET", `/v0/ops/flows${qs ? `?${qs}` : ""}`);
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

  /** Mint a short-lived run token from a definition token. `reuse` returns the run this credential
   *  already holds when there is a live one; see `ClientAuth.reuseRun`. */
  createRun(
    definitionToken: string,
    opts: { reuse?: boolean } = {},
  ): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    return this.req("POST", "/v0/agent-runs", { reuse: opts.reuse === true }, { "Authorization": `Bearer ${definitionToken}` });
  }

  /**
   * Mint a DELEGATED run: this client's own capability, bounded by the reach of whoever the record
   * `forRecordId` is acting for. Returns a token to hold BESIDE this one, never instead of it.
   *
   * Use `delegatedClient` unless you want the raw response. The caller is resolved server-side from
   * the record's author, so nothing here asserts an identity.
   */
  createDelegatedRun(forRecordId: string): Promise<DelegatedRun> {
    return this.req("POST", "/v0/agent-runs/delegated", { for: forRecordId });
  }

  /**
   * The same mint, as a second client ready to use.
   *
   * Deliberately holds NO definition token, so it cannot re-mint itself when the run lapses: a
   * delegated run is scoped to a piece of work, and one that renewed itself indefinitely would
   * outlive the request it was minted for. Mint a new one per claim, or per (worker, caller) pair
   * and reuse until it expires.
   */
  async delegatedClient(forRecordId: string): Promise<{ client: RadiaClient; actingFor: string; expiresAt: string }> {
    const out = await this.createDelegatedRun(forRecordId);
    return { client: new RadiaClient(this.base, { token: out.runToken }), actingFor: out.actingFor, expiresAt: out.expiresAt };
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
  /** Kill a definition token, permanently. Operator only; existing RUNS are untouched and are
   *  separately revocable with `stopRun`. Idempotent: `alreadyRevoked` says which it was. */
  revokeDefinition(agent: string, opts: { reason?: string } = {}): Promise<
    { agent: string; status: string; applied: boolean; alreadyRevoked: boolean }
  > {
    return this.req("POST", `/v0/agent-definitions/${encodeURIComponent(agent)}/revoke`, opts.reason ? { reason: opts.reason } : {});
  }

  stopRun(run: string): Promise<{ run: string; status: string; applied: boolean }> {
    return this.req("POST", `/v0/agent-runs/${encodeURIComponent(run)}/stop`);
  }

  /**
   * ONE matching record, and it is the OLDEST one.
   *
   * With no `orderBy` the order is the oracle's `id` tie-break, so a pattern matching several
   * records answers with the first ever written. For anything that accumulates SUCCESSORS — a
   * registry entry, a versioned record, key material a later write extends — that is the stale
   * answer, and it is stale silently. Use `readNewest`.
   */
  readOne(pattern: Pattern): Promise<RadiaRecord | null> {
    return this.req("POST", "/v0/records/read-one", pattern);
  }

  /**
   * The NEWEST record matching `pattern`, or null.
   *
   * The safe half of the pair above, and the one to reach for by default: anything written as a
   * successor (latest-wins registries, key material, any record whose "current value" is the last
   * one) is read with this. It exists because reading the oldest match is the single most repeated
   * mistake against this API and `readOne` was the obvious-looking call.
   *
   * NOTE THE GRANT. This is a `query`, not a `read_one`, so a principal holding only `read_one` on
   * the kind gets `forbidden` here. That is not a bug to route around: ordering IS a query.
   */
  async readNewest(pattern: Pattern): Promise<RadiaRecord | null> {
    return (await this.query(pattern, 1, { dir: "desc" }))[0] ?? null;
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
    /** `tail: N` returns the newest N events ascending instead of paging forward from `after`,
     *  with `nextAfter` always usable for following — the way a live view starts. */
    opts: { tail?: number } = {},
  ): Promise<
    {
      events: SpaceEvent[];
      nextAfter?: string;
      scope?: unknown;
      withheld?: number;
      withheldNote?: string;
      /** Present when the page started below the event-GC horizon: the log is complete only
       *  after this cursor; `sweptBefore` events were removed below it. */
      logBeginsAfter?: string;
      sweptBefore?: number;
    }
  > {
    const q = opts.tail !== undefined ? `tail=${opts.tail}` : `after=${encodeURIComponent(after)}&limit=${limit}`;
    const r = await this.req("GET", `/v0/ops/events?${q}`);
    return {
      events: r.events,
      nextAfter: r.nextAfter,
      scope: r.scope,
      withheld: r.withheld,
      withheldNote: r.withheldNote,
      logBeginsAfter: r.logBeginsAfter,
      sweptBefore: r.sweptBefore,
    };
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
   *  successor record). Discovery through the space: a plain query, no kinds endpoint. */
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
  /** Envelopes in a state, narrowed. `kind` restricts the ANSWER, not merely the page: every
   *  predicate is applied before the cap, so `limit` bounds rows MATCHED. It is ANDed with whatever
   *  the caller's grants already scope this read to, so it can only narrow. */
  async queryEnvelopes(
    q: { state: string; expired?: boolean; stale?: number; limit?: number; kind?: string | string[] },
  ): Promise<{ record: RadiaRecord | null; envelope: unknown }[]> {
    const p = new URLSearchParams({ state: q.state });
    if (q.expired) p.set("expired", "1");
    if (q.stale !== undefined) p.set("stale", String(q.stale));
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    for (const k of q.kind === undefined ? [] : Array.isArray(q.kind) ? q.kind : [q.kind]) p.append("kind", k);
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

  /** Every erasure and whether it STILL HOLDS: a shred destroys the runtime's copy, not the ability
   *  to store those bytes again, so a payload can return to the same content address. `undone`
   *  narrows to the ones that were reversed. */
  erasures(opts: { undone?: boolean } = {}): Promise<unknown> {
    return this.req("GET", `/v0/ops/erasures${opts.undone ? "?undone=true" : ""}`);
  }

  /** The retention sweep (operator): delete records whose `retention_until` has passed — stamped
   *  explicitly, or materialized from the kind_def's `defaultRetentionSeconds`; a record with
   *  neither is permanent. Nothing runs on a timer: the space amortizes small batches onto its own
   *  write path, and this verb drains backlogs and runs compaction.
   *  `diagnostics().sweepable` says whether it is worth calling; `dryRun` counts without deleting. */
  gc(opts: { limit?: number; dryRun?: boolean; compact?: boolean } = {}): Promise<{
    swept: number;
    eligible: number;
    idempotency: number;
    byKind: Record<string, number>;
    more: boolean;
    passes: number;
    /** Registry compaction (superseded latest-wins successors, dead runs' interests), unless
     *  `compact: false`. Kinds opt in by declaring a `contentKey` on their kind_def. */
    compaction?: { compacted: number; superseded: number; byKind: Record<string, number>; more: boolean };
    /** Event-log retention (present when the space configures `eventRetentionSeconds`): the log
     *  truncated to the window ∩ the sealed head, anchored and attested so integrity can tell
     *  honest GC from tampering. `unsealed: 1` means a seal-first debt remains (reported as N+). */
    events?: {
      enabled: boolean;
      sealed: number;
      unsealed: number;
      swept: number;
      eligible: number;
      anchorIdx?: number;
      attested?: boolean;
      more: boolean;
    };
    /** Reference-aware blob GC, on LIVE runs only (a dry pass would walk the whole store to predict
     *  what a live one reports anyway). `foreign` counts payloads KEPT because they were sealed
     *  under a key this space does not hold, which is a rotation missing its retired key rather
     *  than bytes to reclaim: see `rewrapBlobs`. */
    blobs?: { scanned: number; deleted: number; bytes: number; foreign?: number };
  }> {
    return this.req("POST", "/v0/ops/gc", opts);
  }

  /**
   * Re-seal referenced artifact payloads under the current blob key, which is what finishes a KEK
   * rotation: until it runs, reads depend on the retired key and destroying it destroys data.
   *
   * `already === scanned` with `foreign === 0` is the state in which the retired key can be
   * dropped. Anything else means it is still load-bearing.
   */
  rewrapBlobs(opts: { dryRun?: boolean } = {}): Promise<{
    scanned: number;
    rewrapped: number;
    already: number;
    foreign: number;
    missing: number;
    bytes: number;
  }> {
    return this.req("POST", "/v0/ops/rewrap", opts);
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
    selector: { state: string; expired?: boolean; stale?: number; limit?: number; kind?: string | string[] },
  ): Promise<{ action: string; matched: number; applied: number; more: boolean; sample: string[] }> {
    return this.req("POST", "/v0/ops/remediate", { action, ...selector });
  }

  /**
   * Privileged declassify (operator): emit a successor carrying the labels that were NOT cleared.
   *
   * `labels` names which to clear; omitted, it clears all of them. Per-label is the point — a
   * clearance that cannot say what it was FOR is the blanket the label vocabulary replaced — and
   * the answer reports `cleared` and `remaining` so the caller sees what still stands.
   */
  declassify(
    recordId: string,
    labels?: string[],
  ): Promise<{ declassifiedFrom: string; id: string; cleared: string[]; remaining: string[] }> {
    return this.req(
      "POST",
      `/v0/ops/records/${encodeURIComponent(recordId)}/declassify`,
      labels ? { labels } : undefined,
    );
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

  /**
   * The relationship graph around a record: nodes plus parent→child edges.
   *
   * `direction: "down"` walks children ONLY, which is how one thread is separated from the siblings
   * it shares a hub record with — seeded anywhere inside a thread, the default walk climbs to the
   * hub and comes back down into all of them. BOUNDED: `truncated` says more exists than is shown.
   */
  async graph(
    recordId: string,
    opts: { direction?: "both" | "down"; excludeKinds?: string[] } = {},
  ): Promise<{ nodes: GraphNode[]; edges: { from: string; to: string }[]; truncated: boolean }> {
    const q = new URLSearchParams();
    if (opts.excludeKinds?.length) q.set("exclude", opts.excludeKinds.join(","));
    if (opts.direction === "down") q.set("direction", "down");
    return await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/graph?${q}`);
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
  /**
   * An artifact's digest, media type and size, WITHOUT downloading it.
   *
   * On the coordination plane, so an ordinary worker holding `artifact: read_one` can reference an
   * artifact it is allowed to read. `getRecord` answers the same question from `/v0/ops/records`,
   * which is the operator plane: code that reached for it worked under an operator client and
   * failed for every worker, which is exactly how attaching an artifact to a workspace shipped
   * broken.
   */
  async artifactMeta(recordId: string): Promise<{ digest: string; mediaType: string; size: number } | null> {
    return await this.authorized(async () => {
    const headers: Record<string, string> = {};
    if (this.auth.token) headers["Authorization"] = `Bearer ${this.auth.token}`;
    const res = await fetch(`${this.base}/v0/artifacts/${encodeURIComponent(recordId)}`, { method: "HEAD", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new RadiaClientError(res.status, "error", `HEAD /v0/artifacts/${recordId} failed`);
    // The digest rides the ETag, which is what it already was: content-addressed bytes never change,
    // so the content address is a perfect validator.
    const digest = (res.headers.get("etag") ?? "").replace(/"/g, "");
    return {
      digest,
      mediaType: res.headers.get("content-type") ?? "application/octet-stream",
      size: Number(res.headers.get("content-length") ?? 0),
    };
    });
  }

  async getArtifact(recordId: string): Promise<Uint8Array> {
    return await this.authorized(async () => {
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
    });
  }

  /** A short-lived, single-artifact download capability. Use it for contexts that cannot send an
   *  Authorization header (an `<img src>`). The returned `url` is relative to the space. */
  /** Mint one capability over a SET of artifacts addressed by path, for serving a tree. Every
   *  entry is authorized against this caller's read grant at mint, so the served URL needs none. */
  pathCapability(
    entries: { path: string; artifactId: string }[],
  ): Promise<{ capability: string; expiresAt: string; entries: number; url: string }> {
    return this.req("POST", "/v0/capabilities", { entries }) as Promise<
      { capability: string; expiresAt: string; entries: number; url: string }
    >;
  }

  artifactCapability(recordId: string): Promise<{ capability: string; expiresAt: string; url: string }> {
    return this.req("POST", `/v0/artifacts/${encodeURIComponent(recordId)}/capability`);
  }

  /**
   * Watch a pattern: an async stream of wakeups (`{seq, recordId, kind}`) for matching
   * records that become available. Reconnects with a cursor on drop; on 410 cursor_expired
   * it restarts from the beginning (a real client would catch-up-query first). Ends when
   * `signal` aborts. M0/M1: use a kind-only pattern for wakeup-by-kind.
   *
   * THROWS when the space revokes the stream: a 401/403 on reconnect, or a `revoked` frame on a
   * live one. Both are terminal, because the server re-checks the credential and the grants for as
   * long as the stream runs and only ends it when they no longer permit the watch. Retrying cannot
   * fix either, and the reconnect loop below would otherwise turn a revocation into a silent stall
   * that looks exactly like an idle space.
   */
  async *watch(pattern: Pattern, signal?: AbortSignal): AsyncGenerator<Wakeup> {
    await this.ensureCredential(); // a client holding only the durable half has nothing to send yet
    let watchId = (await this.req("POST", "/v0/watches", pattern) as { watchId: string }).watchId;
    let cursor: string | undefined; // opaque resume token (Last-Event-ID), never parsed
    let reconnected = false; // one credential exchange per authorization failure, not a loop
    while (!signal?.aborted) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/v0/watches/${watchId}/events`, {
          // The SSE connect is a raw `fetch`, so it does NOT inherit `req`'s Authorization. Without
          // this line every connect 401s in an authenticated space and the caller silently
          // degrades to its poll fallback, which is slow rather than broken and so goes unnoticed.
          headers: {
            ...(this.auth.token ? { "Authorization": `Bearer ${this.auth.token}` } : {}),
            ...(cursor !== undefined ? { "Last-Event-ID": cursor } : {}),
          },
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
      if (res.status === 404) {
        // Watches live in the server's memory, so a restart makes this id gone for good; retrying
        // it forever is the one failure that never heals. Re-create and start from the new watch's
        // own cursor: events during the gap are missed by construction, which is what the caller's
        // poll fallback is for.
        await res.body?.cancel();
        try {
          watchId = (await this.req("POST", "/v0/watches", pattern) as { watchId: string }).watchId;
          cursor = undefined;
        } catch (e) {
          if (e instanceof RadiaClientError && (e.status === 401 || e.status === 403)) throw e;
          await sleep(300);
        }
        continue;
      }
      if (res.status === 401 && this.auth.definitionToken && !reconnected) {
        // The stream outlives the token that opened it. A watch held for hours across a token's
        // 15-minute life is the LONGEST-running thing any client does, so it meets expiry first and
        // the raw connect never passes through `req`, where the exchange lives. Mint and reconnect
        // once; a second 401 is a real refusal.
        await res.body?.cancel();
        await this.exchange();
        reconnected = true;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // Typed, not a bare Error: `agentLoop` distinguishes a permanent authorization failure from
        // a transient drop by `status`, and an untyped throw there is retried as a hiccup.
        throw new RadiaClientError(res.status, "forbidden", `watch ${watchId} refused: ${(await res.text()).slice(0, 200)}`);
      }
      reconnected = false; // a connect that got past auth clears the one-shot
      if (!res.ok || !res.body) {
        await sleep(300);
        continue;
      }
      const reader = res.body.getReader();
      // CANCEL ON ABORT, explicitly. Over a socket the abort errors the body and the read below
      // rejects, but a transport that hands back a Response DIRECTLY (a browser space calling
      // `makeHandler`, agent_docs/plan-browser-space.md) has no socket to break: the server ends
      // its stream from the reader's `cancel()` and nothing else, so without this the read parks
      // forever, the stream is never closed, and a caller that aborted still waits on it. Found
      // exactly that way, as a shutdown that never returned.
      const cancelOnAbort = () => reader.cancel().catch(() => {});
      signal?.addEventListener("abort", cancelOnAbort, { once: true });
      const dec = new TextDecoder();
      let buf = "";
      let revoked: string | undefined;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || revoked) break;
          buf += dec.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let id: string | undefined;
            let data: string | undefined;
            let event: string | undefined;
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = line.slice(3).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
              else if (line.startsWith("event:")) event = line.slice(6).trim();
            }
            if (id !== undefined) cursor = id; // opaque; echo back verbatim on reconnect
            // A named frame is control, never a wakeup. Without this branch `revoked` parses as a
            // Wakeup and is yielded as if a record had matched. Recorded rather than thrown here:
            // the `catch` below treats any throw as a dropped stream and reconnects, which is
            // exactly the loop a revocation must not enter.
            if (event === "revoked") revoked = data ?? "no reason given";
            else if (event === undefined && data) yield JSON.parse(data) as Wakeup;
            if (revoked) break;
          }
        }
      } catch {
        // stream dropped; reconnect below
      } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        reader.cancel().catch(() => {});
      }
      if (revoked) {
        // The REASON matters, and conflating the two cost a live session. `credential_invalid` means
        // the run this watch belonged to ended, which a client holding the durable half recovers
        // from by minting another and watching again; anything else means the authorization itself
        // changed, which retrying cannot fix. Surfaced as the code so a caller can tell them apart
        // without parsing a message.
        let reason = "forbidden";
        try {
          reason = (JSON.parse(revoked) as { reason?: string }).reason ?? "forbidden";
        } catch { /* not JSON: treat as a plain forbidden */ }
        throw new RadiaClientError(403, reason, `watch ${watchId} revoked: ${revoked}`);
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
