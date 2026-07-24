// The Space service: the storage-agnostic runtime logic behind the HTTP surface. It owns
// server-side policy (metadata assignment, template compilation) and delegates atomic
// storage transitions to a StorageAdapter. One Space wraps one adapter.

import type {
  AckResult,
  CompiledMatch,
  Envelope,
  IdempotencyKey,
  KindStateCount,
  Lease,
  LeaseRef,
  LeaseSpec,
  PutInput,
  RadiaRecord,
  RecordState,
  RenewResult,
  SettleResult,
  SpaceEvent,
  StorageAdapter,
  TakeResult,
  TakeSelector,
} from "../storage/adapter.ts";
import { addSeconds } from "./time.ts";
import { buildRecord, type PutRequest } from "./record.ts";
import { compileTemplate, matchesRecord, type Template } from "./matching.ts";
import { KIND_DEF, type KindDef, kindDefKey, KindRegistry, META_KIND_DEF, validateKindDef } from "./kinds.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
import { Notifier } from "./notifier.ts";

export interface SpaceContext {
  principal: string;
  schemaVersion: number;
  runId: string;
  defaultLeaseSeconds: number;
  defaultBackoffSeconds: number;
  maxAttempts: number;
  maxCumulativeSeconds: number;
}

const DEFAULT_CONTEXT: SpaceContext = {
  principal: "local:dev", // auto-provisioned locally; real principals land in Phase 7
  schemaVersion: 1,
  runId: "run:local",
  defaultLeaseSeconds: 30,
  defaultBackoffSeconds: 5,
  maxAttempts: 5,
  maxCumulativeSeconds: 300,
};

/** How a caller selects work to take. */
export type TakeInput =
  | { template: Template }
  | { recordId: string; template?: Template };

export interface TakeOptions {
  leaseSeconds?: number;
}

export interface Watch {
  match: CompiledMatch;
  cursor0: number; // event seq at creation; the stream starts here unless resumed
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
}

export interface Diagnostics {
  now: string;
  counts: Record<string, number>;
  deadLetter: { count: number; sample: unknown[] };
  stuckLeases: { count: number; sampledFrom: number; sample: unknown[] };
  staleAvailable: { count: number; thresholdSeconds: number; sample: unknown[] };
}

/** A short, generic label for a graph node — kind plus a common discriminating field. */
function labelFor(rec: RadiaRecord): string {
  const b = (rec.body ?? {}) as Record<string, unknown>;
  const hint = b.role ?? b.op ?? b.tool ?? "";
  return hint ? `${rec.kind}:${hint}` : rec.kind;
}

export class Space {
  private readonly kinds = new KindRegistry();
  private readonly ctx: SpaceContext;
  private readonly notifier = new Notifier();
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly storage: StorageAdapter,
    ctx: Partial<SpaceContext> = {},
  ) {
    this.ctx = { ...DEFAULT_CONTEXT, ...ctx };
    // Bootstrap: the meta-kind is defined in code so a query for kind_def records compiles.
    // Every other kind is a kind_def record, loaded into this registry by loadKinds().
    this.kinds.register(META_KIND_DEF);
  }

  get storageName(): string {
    return this.storage.name;
  }

  /** Declare a kind (validate + cache in memory only). Throws RadiaError on an invalid def.
   *  Synchronous so direct callers see it immediately; use persistKind to store it durably
   *  (as a kind_def record). Most in-process callers (tests, examples) only need this. */
  registerKind(def: KindDef): void {
    this.kinds.register(def);
  }

  /** Durably store a kind declaration as a kind_def record (and cache it). Idempotent per
   *  declaration content, so re-declaring the same def across restarts does not grow records. */
  async persistKind(def: KindDef): Promise<void> {
    validateKindDef(def);
    await this.put({ kind: KIND_DEF, body: def }, kindDefKey(def));
  }

  /** Rebuild the registry from kind_def records (call once at startup). A kind's latest
   *  declaration wins (records are immutable; a redeclaration is a successor, not a mutation). */
  async loadKinds(): Promise<void> {
    const records = await this.storage.query({ kind: KIND_DEF }, 1000);
    const latest = new Map<string, RadiaRecord>();
    for (const rec of records) {
      const kind = (rec.body as { kind?: unknown } | null)?.kind;
      if (typeof kind !== "string") continue;
      const prev = latest.get(kind);
      if (!prev || prev.id < rec.id) latest.set(kind, rec); // ULID id is monotonic ~ recency
    }
    for (const rec of latest.values()) {
      try {
        this.kinds.register(rec.body as KindDef);
      } catch {
        // skip a malformed persisted declaration rather than fail startup
      }
    }
  }

  /** Validate a kind_def record body as a KindDef. Rejects redefining the built-in meta-kind. */
  private kindDefFromBody(body: unknown): KindDef {
    if (body === null || typeof body !== "object") {
      throw new RadiaError("invalid_kind", "a kind_def record body must be a KindDef object");
    }
    const def = body as KindDef;
    if (def.kind === KIND_DEF) {
      throw new RadiaError("reserved_kind", `'${KIND_DEF}' is the built-in meta-kind and cannot be redeclared`);
    }
    validateKindDef(def);
    return def;
  }

  /** DB clock passthrough (health, diagnostics). */
  now(): Promise<string> {
    return this.storage.now();
  }

  async put(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }> {
    // A kind_def record IS a kind declaration: validate its body as a KindDef before commit,
    // so the substrate coordinates its own schema through the normal write path (no side table).
    if (req.kind === KIND_DEF) {
      const def = this.kindDefFromBody(req.body); // throws RadiaError on an invalid declaration
      const id = await this.putRaw(req, idempotencyKey);
      this.kinds.register(def); // reflect it in this process's registry (also on idempotent replay)
      return id;
    }
    return this.putRaw(req, idempotencyKey);
  }

  private async putRaw(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }> {
    const now = await this.storage.now(); // INVARIANT: timestamps come from the DB clock
    const { record, bodyJson } = await buildRecord(req, {
      principal: this.ctx.principal,
      schemaVersion: this.ctx.schemaVersion,
      now,
    });
    const idempotency = await this.idem("put", idempotencyKey, {
      kind: req.kind,
      body: req.body,
      parentIds: req.parentIds ?? [],
    });
    const result = await this.storage.put({
      record,
      bodyJson,
      idempotency,
      envelope: {
        kind: record.kind,
        availableAt: now,
        claimUntil: undefined,
        deadlineAt: record.deadlineAt,
        effectivePriority: 0, // server-computed; scheduler sets this for real in M3
      },
    });
    this.notifier.notify(); // wake any watch streams
    return { id: result.id };
  }

  readOne(template: Template): Promise<RadiaRecord | null> {
    return this.storage.readOne(this.compile(template));
  }

  /** Matching records ordered by the template, capped at `limit` (dev UI list; keyset query is M1). */
  query(template: Template, limit = 100): Promise<RadiaRecord[]> {
    return this.storage.query(this.compile(template), limit);
  }

  /** Record counts by kind and state (dev UI overview). */
  stats(): Promise<KindStateCount[]> {
    return this.storage.stats();
  }

  /** Registered kind declarations (dev UI). */
  listKinds(): KindDef[] {
    return this.kinds.list();
  }

  /** Claim work under a fenced lease. Returns the record + lease, or null if none is claimable. */
  take(sel: TakeInput, opts: TakeOptions = {}): Promise<TakeResult | null> {
    const spec: LeaseSpec = {
      leaseId: newUlid(),
      ownerRun: this.ctx.runId,
      leaseSeconds: opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds,
      maxCumulativeSeconds: this.ctx.maxCumulativeSeconds,
      maxAttempts: this.ctx.maxAttempts,
    };
    const selector: TakeSelector = "recordId" in sel
      ? { recordId: sel.recordId, template: sel.template ? this.compile(sel.template) : undefined }
      : { template: this.compile(sel.template) };
    return this.storage.take(selector, spec).then((r) => {
      this.notifier.notify(); // a claim changes state; a nack/release elsewhere may reopen work
      return r;
    });
  }

  async renew(lease: Lease, opts: TakeOptions = {}, idempotencyKey?: string): Promise<RenewResult> {
    const idem = await this.idem("renew", idempotencyKey, this.ref(lease));
    return this.storage.renew(this.ref(lease), opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds, idem);
  }

  /** Consume the leased record, optionally emitting a result record linked to it. */
  async ack(lease: Lease, result?: PutRequest, idempotencyKey?: string): Promise<AckResult> {
    let resultInput: PutInput | undefined;
    if (result) {
      const now = await this.storage.now();
      const parentIds = [
        lease.recordId,
        ...(result.parentIds ?? []).filter((p) => p !== lease.recordId),
      ];
      const { record, bodyJson } = await buildRecord({ ...result, parentIds }, {
        principal: this.ctx.principal,
        schemaVersion: this.ctx.schemaVersion,
        now,
      });
      resultInput = {
        record,
        bodyJson,
        envelope: {
          kind: record.kind,
          availableAt: now,
          claimUntil: undefined,
          deadlineAt: record.deadlineAt,
          effectivePriority: 0,
        },
      };
    }
    const idem = await this.idem("ack", idempotencyKey, {
      ...this.ref(lease),
      result: result ? { kind: result.kind, body: result.body } : null,
    });
    const r = await this.storage.ack(this.ref(lease), resultInput, idem);
    this.notifier.notify(); // an emitted result is a new available record to wake on
    return r;
  }

  async nack(lease: Lease, opts: { backoffSeconds?: number } = {}, idempotencyKey?: string): Promise<SettleResult> {
    const idem = await this.idem("nack", idempotencyKey, this.ref(lease));
    const r = await this.storage.nack(
      this.ref(lease),
      opts.backoffSeconds ?? this.ctx.defaultBackoffSeconds,
      this.ctx.maxAttempts,
      idem,
    );
    this.notifier.notify(); // record back to available
    return r;
  }

  async release(lease: Lease, idempotencyKey?: string): Promise<SettleResult> {
    const idem = await this.idem("release", idempotencyKey, this.ref(lease));
    const r = await this.storage.release(this.ref(lease), idem);
    this.notifier.notify(); // record back to available
    return r;
  }

  /** The mutable envelope for a record (diagnostics / inspector / tests). */
  getEnvelope(recordId: string): Promise<Envelope | null> {
    return this.storage.getEnvelope(recordId);
  }

  /** A single record by id. */
  getRecord(recordId: string): Promise<RadiaRecord | null> {
    return this.storage.getRecord(recordId);
  }

  /**
   * The relationship graph around a record: BFS over parents (lineage up) and children
   * (records that reference it), returning nodes + parent→child edges for a diagram.
   * `excludeKinds` skips noisy kinds (e.g. llm_chunk streaming records).
   */
  async getGraph(
    recordId: string,
    opts: { maxNodes?: number; excludeKinds?: Set<string> } = {},
  ): Promise<{ nodes: GraphNode[]; edges: { from: string; to: string }[] }> {
    const maxNodes = opts.maxNodes ?? 150;
    const exclude = opts.excludeKinds ?? new Set<string>();
    const nodes = new Map<string, RadiaRecord>();
    const edges: { from: string; to: string }[] = [];
    const edgeSeen = new Set<string>();
    const addEdge = (from: string, to: string) => {
      const k = `${from}|${to}`;
      if (!edgeSeen.has(k)) {
        edgeSeen.add(k);
        edges.push({ from, to });
      }
    };
    const seen = new Set<string>();
    const queue = [recordId];
    while (queue.length > 0 && nodes.size < maxNodes) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = await this.storage.getRecord(id);
      if (!rec || exclude.has(rec.kind)) continue;
      nodes.set(id, rec);
      for (const pid of rec.runtimeMeta.parentIds) {
        addEdge(pid, id);
        if (!seen.has(pid)) queue.push(pid);
      }
      for (const child of await this.storage.childrenOf(id)) {
        if (exclude.has(child.kind)) continue;
        addEdge(id, child.id);
        if (!seen.has(child.id)) queue.push(child.id);
      }
    }
    const nodeIds = new Set(nodes.keys());
    return {
      nodes: [...nodes.values()].map((r) => ({
        id: r.id,
        kind: r.kind,
        label: labelFor(r),
        createdAt: r.runtimeMeta.createdAt,
      })),
      edges: edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
    };
  }

  /** Append-only event log after `afterSeq` (0 = from the start). */
  getEvents(afterSeq = 0, limit = 200): Promise<SpaceEvent[]> {
    return this.storage.getEvents(afterSeq, limit);
  }

  /**
   * A record and its ancestry via parent_ids (BFS, `depth` 0 = the record itself). The
   * lineage DAG is acyclic by construction, but `seen` and a node cap guard anyway.
   */
  async getLineage(recordId: string, maxNodes = 200): Promise<{ record: RadiaRecord; depth: number }[]> {
    const out: { record: RadiaRecord; depth: number }[] = [];
    const seen = new Set<string>();
    let frontier: { id: string; depth: number }[] = [{ id: recordId, depth: 0 }];
    while (frontier.length > 0 && out.length < maxNodes) {
      const next: { id: string; depth: number }[] = [];
      for (const { id, depth } of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const rec = await this.storage.getRecord(id);
        if (!rec) continue;
        out.push({ record: rec, depth });
        for (const pid of rec.runtimeMeta.parentIds) next.push({ id: pid, depth: depth + 1 });
      }
      frontier = next;
    }
    return out;
  }

  // ---- watches (M1) ----

  /** Create an ephemeral watch. The stream starts from the current event seq. */
  async createWatch(template: Template): Promise<{ watchId: string }> {
    const match = this.compile(template); // validates the template
    const cursor0 = await this.storage.latestEventSeq();
    const watchId = newUlid();
    this.watches.set(watchId, { match, cursor0 });
    return { watchId };
  }

  getWatch(watchId: string): Watch | undefined {
    return this.watches.get(watchId);
  }

  /** Does this event signal a record matching the watch that is now claimable/available? */
  async matchesEvent(match: CompiledMatch, event: SpaceEvent): Promise<boolean> {
    if (event.state !== "available") return false; // wakeups are for claimable/available records
    if (!event.recordId || event.kind !== match.kind) return false;
    if (!match.where) return true; // kind-only wakeup — no record fetch needed
    const rec = await this.storage.getRecord(event.recordId);
    return rec ? matchesRecord(rec, match) : false;
  }

  /** Resolve when a mutation occurs (a watch wakeup) or after timeoutMs (keepalive). */
  waitForEvents(timeoutMs: number): Promise<void> {
    return this.notifier.wait(timeoutMs);
  }

  // ---- envelope query + diagnostics + remediation (ops plane; would be grant-gated) ----

  /**
   * Query records by their runtime ENVELOPE state — the dimension the content-routing query
   * language deliberately omits (it matches record bodies, for routing). This is the ops-plane
   * substrate primitive: `expired` keeps only leased rows whose lease has lapsed; `staleSeconds`
   * keeps only first-attempt rows that have sat available longer than that. Diagnostics composes
   * it rather than hand-rolling the same scans. All time math uses the DB clock.
   */
  async queryEnvelopes(
    q: { state: RecordState; expired?: boolean; staleSeconds?: number; limit?: number },
  ): Promise<{ record: RadiaRecord | null; envelope: Envelope }[]> {
    const now = await this.storage.now();
    let envs = await this.storage.envelopesInState(q.state, q.limit ?? 100);
    if (q.expired) envs = envs.filter((e) => e.leasedUntil !== undefined && e.leasedUntil < now);
    if (q.staleSeconds !== undefined) {
      const before = addSeconds(now, -q.staleSeconds);
      envs = envs.filter((e) => e.attempt === 0 && e.availableAt < before);
    }
    const rows: { record: RadiaRecord | null; envelope: Envelope }[] = [];
    for (const e of envs) rows.push({ record: await this.storage.getRecord(e.recordId), envelope: e });
    return rows;
  }

  /** A derived health report, composed from queryEnvelopes + stats: counts by state,
   *  dead-letters, expired-but-stuck leases, and available records that have sat unclaimed. */
  async diagnostics(): Promise<Diagnostics> {
    const now = await this.storage.now();
    const stats = await this.storage.stats();
    const total = (state: string) => stats.filter((s) => s.state === state).reduce((a, s) => a + s.count, 0);
    const SAMPLE = 500;
    const STALE_S = 60;

    const deadLetter = await this.queryEnvelopes({ state: "dead_letter", limit: 50 });
    const stuck = await this.queryEnvelopes({ state: "leased", expired: true, limit: SAMPLE });
    const stale = await this.queryEnvelopes({ state: "available", staleSeconds: STALE_S, limit: SAMPLE });
    const env = (r: { envelope: Envelope }) => r.envelope;

    return {
      now,
      counts: {
        available: total("available"),
        leased: total("leased"),
        consumed: total("consumed"),
        dead_letter: total("dead_letter"),
        expired: total("expired"),
      },
      deadLetter: { count: total("dead_letter"), sample: deadLetter.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, attempt: env(r).attempt })) },
      stuckLeases: {
        count: stuck.length,
        sampledFrom: Math.min(total("leased"), SAMPLE),
        sample: stuck.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, leaseId: env(r).leaseId, leasedUntil: env(r).leasedUntil, attempt: env(r).attempt })),
      },
      staleAvailable: { count: stale.length, thresholdSeconds: STALE_S, sample: stale.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, availableAt: env(r).availableAt })) },
    };
  }

  /** Un-stick an expired lease: force it back to available (attempt +1). Only if the lease
   *  has actually expired — never disturbs a valid lease. Returns whether it applied. */
  async reclaim(recordId: string): Promise<boolean> {
    const now = await this.storage.now();
    const applied = await this.storage.adminTransition(recordId, ["leased"] as RecordState[], "available", { now, bumpAttempt: true, onlyExpired: true });
    if (applied) this.notifier.notify();
    return applied;
  }

  /** Give up on a record: force it to dead_letter (from available or leased). */
  async forceDeadLetter(recordId: string): Promise<boolean> {
    const now = await this.storage.now();
    const applied = await this.storage.adminTransition(recordId, ["available", "leased"] as RecordState[], "dead_letter", { now });
    if (applied) this.notifier.notify();
    return applied;
  }

  /** Retry a dead-lettered record: force it back to available. */
  async requeue(recordId: string): Promise<boolean> {
    const now = await this.storage.now();
    const applied = await this.storage.adminTransition(recordId, ["dead_letter"] as RecordState[], "available", { now });
    if (applied) this.notifier.notify();
    return applied;
  }

  private compile(template: Template): CompiledMatch {
    // Validates predicate/order_by paths against the kind's declaration; throws RadiaError
    // (undeclared_path, unknown_kind, unsortable_path, ...).
    return compileTemplate(template, this.kinds.get(template.kind));
  }

  private ref(lease: Lease): LeaseRef {
    return { recordId: lease.recordId, leaseId: lease.leaseId, epoch: lease.epoch };
  }

  /** Build an idempotency key with a request hash, or undefined when no key was supplied. */
  private async idem(
    operation: string,
    key: string | undefined,
    request: unknown,
  ): Promise<IdempotencyKey | undefined> {
    if (!key) return undefined;
    return {
      principal: this.ctx.principal,
      operation,
      key,
      requestHash: await sha256Hex(JSON.stringify(request)),
    };
  }
}
