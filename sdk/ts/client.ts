// RadiaClient — the TS SDK stub (seeded here; Phase 7 polishes it and adds Python parity).
// Thin fetch wrappers over the public /v0 API — exactly what an external agent uses. No
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
import type { Template } from "../../src/core/matching.ts";
import type { PutRequest } from "../../src/core/record.ts";
import { KIND_DEF, type KindDef, kindDefKey } from "../../src/core/kinds.ts";

export type { AckResult, KindDef, Lease, PutRequest, RadiaRecord, SpaceEvent, Template };

export interface KindStateCount {
  kind: string;
  state: string;
  count: number;
}

export type TakeSelector = { template: Template } | { recordId: string; template?: Template };

export class RadiaClientError extends Error {
  constructor(public status: number, public code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RadiaClientError";
  }
}

/** Read RADIA_URL if env access is permitted; a no --allow-env worker falls back to the default. */
function defaultBase(): string {
  try {
    return globalThis.Deno?.env.get("RADIA_URL") ?? "http://localhost:7788";
  } catch {
    return "http://localhost:7788";
  }
}

export interface ClientAuth {
  /** A run token (or definition token, for minting) sent as `Authorization: Bearer`. */
  token?: string;
}

export class RadiaClient {
  private readonly auth: ClientAuth;
  /** @param auth a run token — `{token}` or a bare token string. Omit for the default operator
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
   *  not a side endpoint — discover them with `listKinds()` (a query for kind_def records). */
  async registerKind(def: KindDef): Promise<{ kind: string }> {
    await this.put({ kind: KIND_DEF, body: def }, kindDefKey(def));
    return { kind: def.kind };
  }

  put(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }> {
    return this.req("POST", "/v0/records", req, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
  }

  /** Assign a kind-scoped grant (a `grant` record — writable only by a human/supervisor
   *  principal). `operations` are coordination verbs: put | take | query | read_one. An optional
   *  `template` narrows read/take to `grant ∧ request` (template-scoped grant). */
  grant(
    principal: string,
    kind: string,
    operations: string[],
    template?: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const body = template ? { principal, kind, operations, template } : { principal, kind, operations };
    const key = `grant:${principal}:${kind}:${[...operations].sort().join(",")}:${template ? JSON.stringify(template) : ""}`;
    return this.put({ kind: "grant", body }, key);
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

  /** Stop a run (operator, or the run's own definition/run token if this client carries it). */
  stopRun(run: string): Promise<{ run: string; status: string; applied: boolean }> {
    return this.req("POST", `/v0/agent-runs/${encodeURIComponent(run)}/stop`);
  }

  readOne(template: Template): Promise<RadiaRecord | null> {
    return this.req("POST", "/v0/records/read-one", template);
  }

  async query(template: Template, limit = 100): Promise<RadiaRecord[]> {
    const r = await this.req("POST", "/v0/records/query", { ...template, limit });
    return r.records;
  }

  take(sel: TakeSelector, opts: { leaseSeconds?: number; requireUntainted?: boolean } = {}): Promise<TakeResult | null> {
    return this.req("POST", "/v0/takes", { ...sel, leaseSeconds: opts.leaseSeconds, requireUntainted: opts.requireUntainted });
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

  async getEvents(after = "0", limit = 200): Promise<SpaceEvent[]> {
    const r = await this.req("GET", `/v0/ops/events?after=${encodeURIComponent(after)}&limit=${limit}`);
    return r.events;
  }

  async getStats(): Promise<KindStateCount[]> {
    const r = await this.req("GET", "/v0/ops/stats");
    return r.stats;
  }

  /** All declared kinds — the latest kind_def record per kind name (a redeclaration is a
   *  successor record). Discovery through the substrate: a plain query, no kinds endpoint. */
  async listKinds(): Promise<KindDef[]> {
    const records = await this.query({ kind: KIND_DEF }, 1000);
    const latest = new Map<string, { id: string; def: KindDef }>();
    for (const rec of records) {
      const def = rec.body as KindDef;
      if (!def || typeof def.kind !== "string") continue;
      const prev = latest.get(def.kind);
      if (!prev || prev.id < rec.id) latest.set(def.kind, { id: rec.id, def });
    }
    return [...latest.values()].map((v) => v.def);
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

  /** Privileged declassify (operator): emit a clean (untainted) successor of a tainted record. */
  declassify(recordId: string): Promise<{ declassifiedFrom: string; id: string }> {
    return this.req("POST", `/v0/ops/records/${encodeURIComponent(recordId)}/declassify`);
  }

  async getLineage(recordId: string): Promise<{ record: RadiaRecord; depth: number }[]> {
    const r = await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/lineage`);
    return r.lineage;
  }

  /** Records that reference this one via parent_ids — its children (the reverse of lineage). */
  async getChildren(recordId: string): Promise<RadiaRecord[]> {
    const r = await this.req("GET", `/v0/ops/records/${encodeURIComponent(recordId)}/children`);
    return r.children;
  }

  // ---- artifacts (design-data-model §2.4) ----

  /** Store bytes and get back the `artifact` record that references them. The payload never
   *  travels inside a record body; the record carries {digest, mediaType, size} and routes. */
  async putArtifact(
    bytes: Uint8Array,
    opts: { mediaType?: string; filename?: string; parentIds?: string[]; taint?: boolean; idempotencyKey?: string } = {},
  ): Promise<{ id: string; digest: string; size: number }> {
    const headers: Record<string, string> = { "content-type": opts.mediaType ?? "application/octet-stream" };
    if (opts.filename) headers["x-radia-filename"] = opts.filename;
    if (opts.parentIds?.length) headers["x-radia-parent-ids"] = opts.parentIds.join(",");
    if (opts.taint) headers["x-radia-taint"] = "true";
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

  /** A short-lived, single-artifact download capability — for contexts that cannot send an
   *  Authorization header (an `<img src>`). The returned `url` is relative to the space. */
  artifactCapability(recordId: string): Promise<{ capability: string; expiresAt: string; url: string }> {
    return this.req("POST", `/v0/artifacts/${encodeURIComponent(recordId)}/capability`);
  }

  /**
   * Watch a template: an async stream of wakeups (`{seq, recordId, kind}`) for matching
   * records that become available. Reconnects with a cursor on drop; on 410 cursor_expired
   * it restarts from the beginning (a real client would catch-up-query first). Ends when
   * `signal` aborts. M0/M1: use a kind-only template for wakeup-by-kind.
   */
  async *watch(template: Template, signal?: AbortSignal): AsyncGenerator<Wakeup> {
    const { watchId } = await this.req("POST", "/v0/watches", template) as { watchId: string };
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
