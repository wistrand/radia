// The Space service: the storage-agnostic runtime logic behind the HTTP surface. It owns
// server-side policy (metadata assignment, template compilation) and delegates atomic
// storage transitions to a StorageAdapter. One Space wraps one adapter.

import type {
  AckResult,
  CompiledMatch,
  DelegationContext,
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
import {
  AGENT_DEFINITION,
  AGENT_RUN,
  GRANT,
  type GrantDef,
  type GrantOp,
  isClaimable,
  KIND_DEF,
  type KindDef,
  kindDefKey,
  KindRegistry,
  META_RESERVED,
  validateGrantDef,
  validateKindDef,
  WRITE_PROTECTED_KINDS,
} from "./kinds.ts";
import { CredentialStore, mintCredential, type ResolvedToken } from "./auth.ts";
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
  /** The one supervisor agent that, like `human:*`, may write grants/signal and reach `/ops/*`. */
  supervisor: string;
  /** How long a minted run token stays valid (short-lived; the run refreshes by re-minting). */
  runTokenSeconds: number;
  /** Age past which an unclaimed *claimable* record counts as stale in diagnostics (starvation). */
  diagnosticsStaleSeconds: number;
}

const DEFAULT_CONTEXT: SpaceContext = {
  principal: "local:dev", // auto-provisioned locally; real principals land in Phase 7
  schemaVersion: 1,
  runId: "run:local",
  defaultLeaseSeconds: 30,
  defaultBackoffSeconds: 5,
  maxAttempts: 5,
  maxCumulativeSeconds: 300,
  supervisor: "agent:supervisor",
  runTokenSeconds: 900, // 15 min; a live run re-mints before expiry
  diagnosticsStaleSeconds: 60,
};

/** How a caller selects work to take. */
export type TakeInput =
  | { template: Template }
  | { recordId: string; template?: Template };

export interface TakeOptions {
  leaseSeconds?: number;
  /** Sensitive consumer: skip tainted candidates (taint barrier). */
  requireUntainted?: boolean;
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
  taint: boolean; // untrusted data lineage (see design-data-model)
  delegated: number; // delegation-chain length (0 = root/operator work)
}

export interface Diagnostics {
  now: string;
  counts: Record<string, number>;
  deadLetter: { count: number; sample: unknown[] };
  stuckLeases: { count: number; sampledFrom: number; sample: unknown[] };
  /** Unclaimed *claimable* (work) records older than the threshold — a starvation signal.
   *  Reference kinds (`claimable:false`: facts, config, grants, history) are excluded: they sit
   *  available forever by design and are not stale. */
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
  private readonly creds = new CredentialStore();
  private readonly ctx: SpaceContext;
  private readonly notifier = new Notifier();
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly storage: StorageAdapter,
    ctx: Partial<SpaceContext> = {},
  ) {
    this.ctx = { ...DEFAULT_CONTEXT, ...ctx };
    // Bootstrap: the reserved control kinds (kind_def, grant, signal) are defined in code so
    // queries for their records compile. Every other kind is a kind_def record, loaded by
    // loadKinds(); grants are grant records, read by authorize().
    for (const def of META_RESERVED) this.kinds.register(def);
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

  private grantDefFromBody(body: unknown): GrantDef {
    if (body === null || typeof body !== "object") {
      throw new RadiaError("invalid_grant", "a grant record body must be a GrantDef object");
    }
    return body as GrantDef;
  }

  // ---- authorization + the bootstrap chain (M1 slice; taint + delegation still deferred) ----

  /** The subject grants are checked against: a `run:*` principal inherits its agent definition's
   *  grants (grants flow down the chain), so it authorizes as `agent:<name>`. Everything else
   *  authorizes as itself. */
  private grantSubject(principal: string): string {
    if (principal.startsWith("run:")) return this.creds.agentForRun(principal) ?? principal;
    return principal;
  }

  /** A privileged principal has operator access: `/ops/*`, grant/signal writes, and any op
   *  without a grant. That is `human:*`, the one supervisor agent (reached directly or via a run
   *  of it), and the space's OWN configured runtime identity (`ctx.principal`/`ctx.runId`) — the
   *  trusted in-process/operator plane that unauthenticated dev requests resolve to. */
  isPrivileged(principal: string): boolean {
    const subject = this.grantSubject(principal);
    return subject.startsWith("human:") || subject === this.ctx.supervisor ||
      subject === this.ctx.runId || subject === this.ctx.principal;
  }

  /**
   * Authorize `principal` to run coordination `op` on records of `kind`. Throws
   * RadiaError("forbidden") if denied. Writing a reserved control kind (grant/signal/agent_*)
   * requires privilege (assigned, never self-declared). Any other principal needs a matching
   * **grant record** (kind-scoped, op-scoped) — a run inherits its agent definition's grants.
   *
   * Returns the **template constraint** for template-scoped grants: `null` when unrestricted
   * (privileged, or at least one matching grant has no template), or the list of grant templates
   * (their union) the request must additionally satisfy. For read/take, callers AND it into the
   * query via `combineMatch` (`grant ∧ request`); for `put`, callers check the record body against
   * it with `bodyMatchesGrant` (write-side scoping — the principal may only write records inside
   * the grant's template).
   */
  async authorize(principal: string, op: GrantOp, kind: string): Promise<Record<string, unknown>[] | null> {
    if (this.isPrivileged(principal)) return null;
    if ((op === "put" || op === "take") && WRITE_PROTECTED_KINDS.has(kind)) {
      throw new RadiaError("forbidden", `writing '${kind}' records requires a human or supervisor principal`);
    }
    const subject = this.grantSubject(principal);
    // Grants are records: query the ones for this (subject, kind) and check the op.
    const grants = await this.query({ kind: GRANT, match: { principal: subject, kind } }, 100);
    const applicable = grants.filter((g) => {
      const ops = (g.body as Partial<GrantDef>)?.operations;
      return Array.isArray(ops) && ops.includes(op);
    });
    if (applicable.length === 0) {
      throw new RadiaError("forbidden", `principal '${principal}' has no '${op}' grant for kind '${kind}'`);
    }
    const templates: Record<string, unknown>[] = [];
    for (const g of applicable) {
      const t = (g.body as GrantDef).template;
      if (!t || Object.keys(t).length === 0) return null; // an unrestricted grant widens to the whole kind
      templates.push(t);
    }
    return templates; // constrained: request must additionally match one of these
  }

  /** Write-side template scoping: does `body` (of `kind`) satisfy at least one grant `template`?
   *  A template-scoped `put` grant lets a principal write only records inside its template (the
   *  union across grants). Compiles each template against the kind (so its paths must be declared
   *  indexed, same as read-side) and evaluates the body with the matching oracle. */
  bodyMatchesGrant(kind: string, body: unknown, templates: Record<string, unknown>[]): boolean {
    return templates.some((t) => {
      try {
        return matchesRecord({ kind, body } as RadiaRecord, this.compile({ kind, match: t }));
      } catch {
        return false; // an uncompilable grant template (e.g. undeclared path) grants nothing
      }
    });
  }

  /**
   * Derive the `delegation_context` for work emitted under a lease owned by `owner`. The authority
   * comes from the CLAIMED LEASE — `owner` (the record's authoritative `lease_owner`) → its agent
   * (`grantSubject`) — extending the leased record's own chain. INVARIANT: never derived from
   * `parent_ids` (data parents grant nothing). Returns undefined for operator/root-owned leases
   * (privileged): such work carries full authority and no delegation record. The chain is an
   * audit/authority record; full chain-intersection enforcement composes with taint (M3).
   */
  private async deriveDelegation(owner: string, leasedRecordId: string): Promise<DelegationContext | undefined> {
    if (this.isPrivileged(owner)) return undefined; // root/operator work is not delegated
    const actor = this.grantSubject(owner); // the agent behind the run — grants live here
    const parent = await this.storage.getRecord(leasedRecordId);
    const parentChain = parent?.runtimeMeta.delegationContext?.chain ?? [];
    return { chain: [...parentChain, actor], origin: leasedRecordId };
  }

  /** Server-computed taint for a new record: `true` if the client raised it (source attestation)
   *  or ANY data parent is tainted. Taint propagates along data lineage only; clearing needs a
   *  privileged declassify (`Space.declassify`). Never lowered by a client. */
  private async computeTaint(parentIds: string[], clientRaise?: boolean): Promise<boolean> {
    if (clientRaise === true) return true;
    for (const pid of parentIds) {
      const p = await this.storage.getRecord(pid);
      if (p?.runtimeMeta.taint) return true;
    }
    return false;
  }

  /**
   * Create an agent definition (operator action): store an `agent_definition` record holding the
   * sha256 of a freshly minted **definition token**, optionally assign its grants, and return the
   * token once. The definition token mints runs (`mintRun`); it is never stored in plaintext.
   */
  async createAgentDefinition(agent: string, grants: GrantDef[] = []): Promise<{ agent: string; definitionToken: string }> {
    if (!agent.startsWith("agent:")) {
      throw new RadiaError("invalid_principal", "an agent definition principal must start with 'agent:'");
    }
    const { token, hash } = await mintCredential();
    await this.putRaw({ kind: AGENT_DEFINITION, body: { agent, tokenHash: hash } });
    for (const g of grants) {
      validateGrantDef(g);
      await this.putRaw({ kind: GRANT, body: g });
    }
    this.creds.addDefinition(hash, agent);
    this.notifier.notify();
    return { agent, definitionToken: token };
  }

  /** Mint a short-lived run token for the agent behind `definitionToken`. Records an `agent_run`
   *  and returns the run principal + token (once). Fails if the token is not a definition token. */
  async mintRun(definitionToken: string): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    const now = await this.storage.now();
    const resolved = await this.creds.resolve(definitionToken, now);
    if (!resolved.ok || resolved.kind !== "def") {
      throw new RadiaError("invalid_credential", "a valid agent-definition token is required to mint a run");
    }
    const agent = resolved.agent;
    const run = `run:${newUlid()}`;
    const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
    const { token, hash } = await mintCredential();
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt } });
    this.creds.addRun(hash, run, agent, expiresAt);
    this.notifier.notify();
    return { run, agent, runToken: token, expiresAt };
  }

  /**
   * Stop a run: emit a successor `agent_run` record (status stopped) and invalidate its token so
   * no new operations resolve. Default (graceful) revocation leaves held leases to expire on
   * their own clocks. `quarantine: true` is emergency revocation — it additionally force-releases
   * the run's in-flight leases now (epoch-bumped, so a late ack/renew fences out as `lease_lost`).
   */
  async stopRun(run: string, opts: { quarantine?: boolean } = {}): Promise<{ applied: boolean; quarantined: number }> {
    const agent = this.creds.agentForRun(run);
    if (agent === undefined) return { applied: false, quarantined: 0 };
    let quarantined = 0;
    if (opts.quarantine) {
      const now = await this.storage.now();
      quarantined = await this.storage.quarantineLeasesOf(run, now);
    }
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, status: "stopped", quarantined: opts.quarantine ?? false } });
    this.creds.stopRun(run);
    this.notifier.notify();
    return { applied: true, quarantined };
  }

  /** Mint an operator token (resolves to the privileged `human:local`, no expiry) for the bundled
   *  dev console. Not a record — a server-lifetime bootstrap credential; the server re-mints one
   *  at startup and injects it into the served UI so the console authenticates like any client. */
  async mintOperatorToken(): Promise<string> {
    const { token, hash } = await mintCredential();
    this.creds.addOperator(hash);
    return token;
  }

  /** Resolve a presented bearer token to a principal (DB clock for expiry). */
  resolveToken(token: string): Promise<ResolvedToken> {
    return this.storage.now().then((now) => this.creds.resolve(token, now));
  }

  /** The agent definition a run instantiates, or undefined (for ownership checks). */
  agentOfRun(run: string): string | undefined {
    return this.creds.agentForRun(run);
  }

  /** Rebuild the credential index from agent_definition/agent_run records (call once at startup,
   *  after loadKinds). Mirrors loadKinds: records are the source of truth, this index is a cache. */
  async loadCredentials(): Promise<void> {
    this.creds.clear();
    for (const rec of await this.storage.query({ kind: AGENT_DEFINITION }, 5000)) {
      const b = rec.body as { agent?: string; tokenHash?: string } | null;
      if (b?.agent && b.tokenHash) this.creds.addDefinition(b.tokenHash, b.agent);
    }
    // agent_run records in id order: a later (stop) successor overrides the earlier (mint) one.
    const runs = await this.storage.query({ kind: AGENT_RUN }, 5000);
    runs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const rec of runs) {
      const b = rec.body as { run?: string; agent?: string; tokenHash?: string; status?: string; expiresAt?: string } | null;
      if (!b?.run || !b.agent) continue;
      if (b.status === "stopped") {
        this.creds.stopRun(b.run);
      } else if (b.tokenHash && b.expiresAt) {
        this.creds.addRun(b.tokenHash, b.run, b.agent, b.expiresAt);
      }
    }
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
    // A grant record IS an authorization grant: validate its body before commit (write-protection
    // — that only a privileged principal may put one — is enforced at the API boundary).
    if (req.kind === GRANT) {
      validateGrantDef(this.grantDefFromBody(req.body));
    }
    return this.putRaw(req, idempotencyKey);
  }

  private async putRaw(
    req: PutRequest,
    idempotencyKey?: string,
    opts: { taint?: boolean } = {},
  ): Promise<{ id: string }> {
    const now = await this.storage.now(); // INVARIANT: timestamps come from the DB clock
    // Taint is server-computed data lineage: forced by opts (declassify), else client-raise OR
    // any data parent tainted. A client can only RAISE taint; clearing needs a privileged declassify.
    const taint = opts.taint !== undefined ? opts.taint : await this.computeTaint(req.parentIds ?? [], req.taint);
    const { record, bodyJson } = await buildRecord(req, {
      principal: this.ctx.principal,
      schemaVersion: this.ctx.schemaVersion,
      now,
      taint,
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

  /** Claim work under a fenced lease. Returns the record + lease, or null if none is claimable.
   *  The lease is owned by the claiming `principal` (a `run:*`, so a stopped run's leases can be
   *  quarantined); defaults to the space's run id for in-process/operator callers. */
  take(sel: TakeInput, opts: TakeOptions = {}, principal?: string): Promise<TakeResult | null> {
    const spec: LeaseSpec = {
      leaseId: newUlid(),
      ownerRun: principal ?? this.ctx.runId,
      leaseSeconds: opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds,
      maxCumulativeSeconds: this.ctx.maxCumulativeSeconds,
      maxAttempts: this.ctx.maxAttempts,
      requireUntainted: opts.requireUntainted,
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
      // The authoritative lease owner (from the envelope, not the client-presented lease).
      const owner = (await this.storage.getEnvelope(lease.recordId))?.leaseOwner;
      // Emitting a result IS a put: authorize the ACTING principal to put this kind (this closes
      // the gap where ack-emitted records bypassed put-authorization). Pipeline-friendly — each
      // agent needs only its own grant. A template-scoped grant also constrains the result body.
      // Throws forbidden before anything is consumed.
      if (owner) {
        const constraint = await this.authorize(owner, "put", result.kind);
        if (constraint && !this.bodyMatchesGrant(result.kind, result.body, constraint)) {
          throw new RadiaError("forbidden", `result body is outside the template scope of the put grant for '${result.kind}'`);
        }
      }
      // Derive the audit authority chain from the lease (undefined for operator/root owners).
      const delegationContext = owner ? await this.deriveDelegation(owner, lease.recordId) : undefined;
      // Taint propagates along data lineage: the leased record is a parent, so a tainted task
      // yields a tainted result (client may also raise it; never lower it).
      const taint = await this.computeTaint(parentIds, result.taint);
      const { record, bodyJson } = await buildRecord({ ...result, parentIds }, {
        principal: this.ctx.principal,
        schemaVersion: this.ctx.schemaVersion,
        now,
        delegationContext,
        taint,
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
        taint: r.runtimeMeta.taint,
        delegated: r.runtimeMeta.delegationContext?.chain.length ?? 0,
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

  /** Records that reference this record via `parent_ids` — its direct **children** (the reverse of
   *  lineage). E.g. a conversation's messages/llm_calls, an llm_call's chunks + result, a task's
   *  results. Lineage goes up (ancestors); this goes down. */
  getChildren(recordId: string): Promise<RadiaRecord[]> {
    return this.storage.childrenOf(recordId);
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
    q: { state: RecordState; expired?: boolean; staleSeconds?: number; limit?: number; excludeKinds?: string[] },
  ): Promise<{ record: RadiaRecord | null; envelope: Envelope }[]> {
    const now = await this.storage.now();
    let envs = await this.storage.envelopesInState(q.state, q.limit ?? 100, q.excludeKinds);
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
    const STALE_S = this.ctx.diagnosticsStaleSeconds;
    // Starvation is only meaningful for CLAIMABLE (work) kinds: reference records (facts, config,
    // grants, kind_defs, history) sit `available` forever by design — not stale, so exclude them
    // (filtered in the query, before the sample cap, so real stale work is never crowded out).
    const referenceKinds = this.kinds.list().filter((d) => !isClaimable(d)).map((d) => d.kind);

    const deadLetter = await this.queryEnvelopes({ state: "dead_letter", limit: 50 });
    const stuck = await this.queryEnvelopes({ state: "leased", expired: true, limit: SAMPLE });
    const stale = await this.queryEnvelopes({ state: "available", staleSeconds: STALE_S, limit: SAMPLE, excludeKinds: referenceKinds });
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

  /**
   * Privileged declassify: the only way to clear taint. Records are immutable, so this emits a
   * **clean successor** — same kind + body, taint forced `false` (overriding propagation), with the
   * tainted original as its data parent (audit trail). Downstream work should consume the successor.
   * Grant-gated to operators via the `/ops/*` boundary. Returns the successor id, or null if absent.
   */
  async declassify(recordId: string): Promise<{ id: string } | null> {
    const rec = await this.storage.getRecord(recordId);
    if (!rec) return null;
    return await this.putRaw({ kind: rec.kind, body: rec.body, parentIds: [recordId] }, undefined, { taint: false });
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
