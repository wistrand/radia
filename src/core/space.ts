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
  RenewResult,
  SettleResult,
  SpaceEvent,
  StorageAdapter,
  TakeResult,
  TakeSelector,
} from "../storage/adapter.ts";
import { buildRecord, type PutRequest } from "./record.ts";
import { compileTemplate, matchesRecord, type Template } from "./matching.ts";
import { type KindDef, KindRegistry } from "./kinds.ts";
import { newUlid, sha256Hex } from "./ids.ts";
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
  }

  get storageName(): string {
    return this.storage.name;
  }

  /** Declare a kind's indexed/sortable paths. Throws RadiaError on an invalid declaration. */
  registerKind(def: KindDef): void {
    this.kinds.register(def);
  }

  /** DB clock passthrough (health, diagnostics). */
  now(): Promise<string> {
    return this.storage.now();
  }

  async put(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }> {
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
