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
  Page,
  PutInput,
  RadiaRecord,
  RecordState,
  RenewResult,
  SettleResult,
  SpaceEvent,
  StatsScope,
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
  ARTIFACT,
  type ArtifactDef,
  GRANT,
  type GrantDef,
  type GrantOp,
  isClaimable,
  KIND_DEF,
  type KindDef,
  kindDefKey,
  KindRegistry,
  META_RESERVED,
  validateArtifactDef,
  validateGrantDef,
  validateKindDef,
  WRITE_PROTECTED_KINDS,
} from "./kinds.ts";
import { CredentialStore, hashToken, mintCredential, type ResolvedToken } from "./auth.ts";
import { type BlobStore, isDigest, MemoryBlobStore } from "../storage/blobs.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
import { activeSet, grantKey, readRegistry, type RegistryView } from "./registry.ts";
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
  /** Hard ceiling on one artifact's bytes (design-data-model §2 resource limits). */
  maxArtifactBytes: number;
  /** Lifetime of a download capability — the short-lived, single-artifact grant that lets a
   *  browser fetch bytes it cannot attach an Authorization header to. */
  downloadCapabilitySeconds: number;
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
  maxArtifactBytes: 32 * 1024 * 1024,
  downloadCapabilitySeconds: 300,
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
  cursor0: string; // opaque high-water cursor at creation; the stream starts here unless resumed
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  taint: boolean; // untrusted data lineage (see design-data-model)
  delegated: number; // delegation-chain length (0 = root/operator work)
}

export interface EffectivePermissions {
  principal: string;
  /** The agent a run resolves to — grants are held by agents, not by individual runs. */
  subject: string;
  privileged: boolean;
  kinds: {
    kind: string;
    operations: GrantOp[];
    readsScopedToSelf: boolean;
    templates: Record<string, unknown>[];
    /** Set when NO such kind is declared on this space, so the grant authorizes nothing. A grant
     *  may legitimately precede its kind (an operator bootstraps an agent before the fleet declares
     *  its kinds), so this is a flag rather than an error — but an agent that guessed a kind name
     *  and got it approved otherwise reads this row as working access. */
    kindNotDeclared?: true;
  }[];
  ops: { reachable: boolean; kinds: string[] };
  /** False if the grant scan could not be exhausted — the picture may be missing entries. */
  complete: boolean;
}

export interface Diagnostics {
  now: string;
  counts: Record<string, number>;
  deadLetter: { count: number; sample: unknown[] };
  stuckLeases: { count: number; atLeast: boolean; sampledFrom: number; sample: unknown[] };
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

/** How many children of ONE record a graph walk follows. The walk's node cap bounds the picture;
 *  this bounds the reading, so a record with a huge fan-out cannot dominate a single step. */
const GRAPH_FANOUT = 200;

export class Space {
  private readonly kinds = new KindRegistry();
  private readonly creds = new CredentialStore();
  private readonly ctx: SpaceContext;
  private readonly notifier = new Notifier();
  private readonly watches = new Map<string, Watch>();
  /** Live download capabilities: token -> the one artifact it opens, and when it lapses. In
   *  memory and short-lived by design — a capability is a delegation of a read the caller already
   *  held, not a credential, and it must not outlive the process that issued it. */
  private readonly downloadCaps = new Map<string, { recordId: string; expiresAt: number }>();

  constructor(
    private readonly storage: StorageAdapter,
    ctx: Partial<SpaceContext> = {},
    /** Where artifact BYTES live. Defaults to memory, so an ephemeral space stays ephemeral;
     *  a persisted space passes a FileBlobStore (see main.ts). */
    private readonly blobs: BlobStore = new MemoryBlobStore(),
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

  /**
   * Tell the adapter which body paths this kind declares, so it can do whatever it physically
   * needs to plan predicates on them (`StorageAdapter.prepareKind`, optional — Postgres creates
   * planner statistics, SQLite implements nothing).
   *
   * Advisory in both directions: an adapter without the hook is skipped, and a failure inside it
   * is swallowed. A kind declaration must not fail because an optimization could not be applied —
   * the difference is how fast the answer comes back, never what it is.
   *
   * Only the DURABLE declaration paths call this. `registerKind` is synchronous by contract (its
   * callers rely on the kind being usable on the next line), and an in-memory declaration is a
   * test/example convenience where planning does not matter.
   */
  private async prepareStorageFor(def: KindDef): Promise<void> {
    const paths = (def.indexedPaths ?? []).map((p) => p.path);
    if (paths.length === 0 || !this.storage.prepareKind) return;
    try {
      await this.storage.prepareKind(def.kind, paths);
    } catch { /* advisory */ }
  }

  /**
   * Read one registry kind completely and project it — the ONE place limit and direction are
   * decided, instead of at each of the call sites that used to guess.
   */
  private registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
  ): Promise<RegistryView> {
    return readRegistry<T>(
      (limit: number, after?: string) => this.query({ kind, match }, limit, { dir: "desc", after }),
      keyOf,
    );
  }

  /** Rebuild the registry from kind_def records (call once at startup). A kind's latest
   *  declaration wins (records are immutable; a redeclaration is a successor, not a mutation). */
  async loadKinds(): Promise<void> {
    const view = await this.registry<{ kind?: unknown }>(
      KIND_DEF,
      (b) => (typeof b?.kind === "string" ? b.kind : undefined),
    );
    for (const rec of view.entries.values()) {
      try {
        this.kinds.register(rec.body as KindDef);
      } catch {
        // skip a malformed persisted declaration rather than fail startup
        continue;
      }
      await this.prepareStorageFor(rec.body as KindDef);
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

  /**
   * Reject a grant whose `template` could never compile — while the kind is known.
   *
   * A grant template is otherwise validated only when it COMPILES AT USE, which is late in a way
   * that matters: a template naming a path the kind does not declare is accepted, looks assigned in
   * every listing, and then denies or 400s at the first read. Authorization that appears granted
   * and does nothing is worse than a rejected write.
   *
   * It stays conditional on the kind being registered, because it legitimately may not be: grants
   * are routinely assigned before the kinds they scope exist (an operator bootstraps an agent, the
   * fleet declares its kinds at startup). An unknown kind is therefore not an error here — this
   * catches the mistake it can catch and leaves the rest to use, as before.
   */
  private checkGrantTemplate(def: GrantDef): void {
    if (!def.template || !this.kinds.get(def.kind)) return;
    try {
      compileTemplate({ kind: def.kind, match: def.template }, this.kinds.get(def.kind));
    } catch (e) {
      const why = e instanceof RadiaError ? e.message : String(e);
      throw new RadiaError("invalid_grant", `grant template does not compile against kind '${def.kind}': ${why}`);
    }
  }

  // ---- authorization + the bootstrap chain (M1 slice; taint + delegation still deferred) ----

  /** The subject grants are checked against: a `run:*` principal inherits its agent definition's
   *  grants (grants flow down the chain), so it authorizes as `agent:<name>`. Everything else
   *  authorizes as itself.
   *
   *  Public because the HTTP layer needs it to answer "is this principal asking about itself?" —
   *  a run token asking for its AGENT's permissions is asking about itself, and refusing that is
   *  what left a scoped agent unable to tell an approved grant from a pending one. */
  grantSubject(principal: string): string {
    // Memo only, deliberately, so this stays synchronous on the hot path. Safe because the fact is
    // IMMUTABLE (a run's agent never changes) and because authentication populates it: every
    // request presenting a run token resolves that token first, from records. A miss falls back to
    // the run itself, which holds no grants — fail-closed, never fail-open.
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
    //
    // ADDITIVE, not latest-wins: a principal may hold several grants on one kind (different
    // operations, different template scopes) and they coexist. So a revocation targets one GRANT,
    // identified by its content (`grantKey`), and `activeSet` drops exactly that entry while
    // leaving the others in force. Projecting by (principal, kind) instead would let a single
    // revocation silently take every grant on the kind with it.
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject, kind })).entries.values()];
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

  /**
   * The author restriction a principal's grants impose on READS of `kind`, or `undefined` for none.
   *
   * A self-scoped grant (`scope: {createdBy: "self"}`) has to narrow the coordination plane too,
   * not only the ops plane — otherwise approving "its own records of that kind" hands over every
   * record of that kind through `query`, which is the plane an agent actually reads records
   * through. That gap was live: a session granted self-scoped `message` access saw its own 98
   * records in `ops/stats` and all 308 through `query`.
   *
   * Applied only when EVERY applicable grant is self-scoped. Grants union — a record is readable if
   * any grant permits it — so one unscoped grant already permits other authors' records, and
   * filtering by author would then deny something granted. Mixed sets therefore keep today's
   * behaviour, which is the permissive-but-consistent reading of a union.
   */
  async authorScope(principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
    if (this.isPrivileged(principal)) return undefined;
    const subject = this.grantSubject(principal);
    // Only grants that permit THIS operation are relevant. A `put`-only grant says nothing about
    // reads, and counting it as "an unscoped grant on this kind" lifted the read restriction —
    // which happened the moment narrowing a read grant left the write grant behind, exactly as
    // intended.
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject, kind })).entries.values()]
      .map((g) => g.body as GrantDef & { scope?: { createdBy?: string } })
      .filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
    if (grants.length === 0 || !grants.every((g) => g.scope?.createdBy === "self")) return undefined;
    return await this.runPrincipalsOf(subject, principal);
  }

  /**
   * Every principal whose records count as "mine": the agent itself, the presented principal, and
   * the agent's RUNS — all of them, including runs that have since stopped or expired.
   *
   * This is deliberately a different question from authentication, which asks only about
   * credentials that can still be PRESENTED. A self scope needs the opposite: the historical run
   * principals an agent wrote records under, or "what did I create" silently shrinks as the space
   * ages and old runs stop mattering to the auth path. `agent` is a declared
   * indexed path on `agent_run`, so this is one indexed query per authorization rather than a scan.
   */
  private async runPrincipalsOf(subject: string, principal: string): Promise<string[]> {
    const runs = await this.query({ kind: AGENT_RUN, match: { agent: subject } }, 1000, { dir: "desc" });
    const ids = runs.map((r) => (r.body as { run?: string }).run).filter((r): r is string => typeof r === "string");
    return [...new Set([...ids, subject, principal])];
  }

  /**
   * What a principal can actually do — computed once and shown, rather than only ever recomputed
   * inside a decision nobody can see.
   *
   * Effective permission here is a FOLD over an unbounded record set: union across grants, per
   * operation, self-scope only when every applicable grant is scoped, retirement applied after
   * newest-per-key. That is four rules interacting, and every grant bug so far has been the same
   * shape — the promise made to a human did not match the enforcement, and there was no way to look.
   * This is the way to look. Use it before and after changing a principal's grants; the difference
   * is the answer to "did that do what I said it would".
   */
  async effectivePermissions(principal: string): Promise<EffectivePermissions> {
    const subject = this.grantSubject(principal);
    if (this.isPrivileged(principal)) {
      return { principal, subject, privileged: true, kinds: [], ops: { reachable: true, kinds: [] }, complete: true };
    }
    const view = await this.registry(GRANT, grantKey, { principal: subject });
    const byKind = new Map<string, { kind: string; operations: GrantOp[]; scoped: boolean; unscoped: boolean; templates: Record<string, unknown>[] }>();
    for (const rec of view.entries.values()) {
      const g = rec.body as GrantDef & { scope?: { createdBy?: string } };
      if (typeof g.kind !== "string" || !Array.isArray(g.operations)) continue;
      const row = byKind.get(g.kind) ??
        { kind: g.kind, operations: [], scoped: false, unscoped: false, templates: [] };
      for (const op of g.operations) if (!row.operations.includes(op)) row.operations.push(op);
      if (g.scope?.createdBy === "self") row.scoped = true;
      else row.unscoped = true;
      if (g.template && Object.keys(g.template).length > 0) row.templates.push(g.template);
      byKind.set(g.kind, row);
    }
    // The ops plane is reachable for the kinds carrying a self-scoped READ grant — the same rule
    // `opsScope` enforces, stated once here so the two cannot drift.
    const opsKinds = [...byKind.values()]
      .filter((r) => r.scoped && r.operations.includes("query"))
      .map((r) => r.kind);
    const kinds = [];
    for (const r of [...byKind.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))) {
      kinds.push({
        kind: r.kind,
        operations: [...r.operations].sort(),
        // A grant naming a kind that does not exist is the shape a guessing agent produces: one
        // asked for `space_event` — the name of a TOOL — had it approved, and then read its own
        // scope line as evidence of access it did not have. The grant is honoured as written (kinds
        // may be declared later), and said to be empty.
        ...(this.kinds.get(r.kind) ? {} : { kindNotDeclared: true as const }),
        // Asked of `authorScope` rather than recomputed here. Restating the rule produced a view
        // that disagreed with the enforcement — it aggregated scoped/unscoped across ALL grants on
        // the kind, while the enforcement considers only grants permitting THAT OPERATION, so a
        // scoped `query` beside an unscoped `put` was reported as unscoped. A view that can drift
        // from the decision is worse than no view, because it is believed.
        readsScopedToSelf: (await this.authorScope(principal, "query", r.kind)) !== undefined,
        templates: r.templates,
      });
    }
    return {
      principal,
      subject,
      privileged: false,
      kinds,
      ops: { reachable: opsKinds.length > 0, kinds: opsKinds.sort() },
      complete: view.complete,
    };
  }

  /**
   * Authorize a watch on `kind`. A watch OBSERVES matching records (its SSE payload is record
   * existence + ids + kind + timing), so it is allowed if the principal holds ANY grant on the kind
   * — it is a participant — regardless of op (a watcher may hold only `take`, like the agentLoop, or
   * only `read_one`, like a result consumer). Returns the UNION of those grants' templates to AND
   * into the watch match (`null` = unrestricted / privileged), so a watcher only wakes on records
   * inside its grant scope — the same content-scoping `query`/`take` get. Throws `forbidden` if the
   * principal has no grant for the kind (closing the last unguarded coordination verb).
   */
  async authorizeWatch(principal: string, kind: string): Promise<Record<string, unknown>[] | null> {
    if (this.isPrivileged(principal)) return null;
    const subject = this.grantSubject(principal);
    // Retracted grants are subtracted here too. A watch observes records, so a revocation that
    // stopped `query` but left `watch` standing would revoke nothing that matters.
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject, kind })).entries.values()];
    if (grants.length === 0) {
      throw new RadiaError("forbidden", `principal '${principal}' has no grant to watch kind '${kind}'`);
    }
    const templates: Record<string, unknown>[] = [];
    for (const g of grants) {
      const t = (g.body as GrantDef).template;
      if (!t || Object.keys(t).length === 0) return null; // an unrestricted grant widens to the whole kind
      templates.push(t);
    }
    return templates;
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
      // CONTENT-KEYED, so re-defining an agent with the same grants writes nothing new. Without
      // this, every bootstrap appended a fresh record per grant and a long-lived principal
      // accumulated hundreds — which then outran the bounded page every authorization read takes,
      // silently. Unlike a worker republishing a capability, this key does dedup across restarts:
      // agent definitions are an OPERATOR action, and an idempotency key is scoped to the acting
      // principal, which here is stable.
      await this.putRaw({ kind: GRANT, body: g }, `grant:${await sha256Hex(grantKey(g) ?? "")}`);
    }
    this.notifier.notify();
    return { agent, definitionToken: token };
  }

  /** Mint a short-lived run token for the agent behind `definitionToken`. Records an `agent_run`
   *  and returns the run principal + token (once). Fails if the token is not a definition token. */
  async mintRun(definitionToken: string): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    const now = await this.storage.now();
    const resolved = await this.resolveCredential(definitionToken, now); // hydrates a cross-instance def token
    if (!resolved.ok || resolved.kind !== "def") {
      throw new RadiaError("invalid_credential", "a valid agent-definition token is required to mint a run");
    }
    const agent = resolved.agent;
    const run = `run:${newUlid()}`;
    const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
    const { token, hash } = await mintCredential();
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt } });
    this.creds.rememberRun(run, agent);
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
    // Looked up in the SPACE, not in a cache. Consulting an in-memory index here meant that
    // stopping a run this process had not seen — another instance's run, or one written before a
    // restart — silently reported `applied: false` and left the token working.
    const mint = await this.runRecord(run);
    if (!mint?.agent) return { applied: false, quarantined: 0 };
    let quarantined = 0;
    if (opts.quarantine) {
      const now = await this.storage.now();
      quarantined = await this.storage.quarantineLeasesOf(run, now);
    }
    // The successor carries the SAME tokenHash as the mint, so resolving that token finds the stop
    // in the one indexed lookup it already does. Without it, a token-hash lookup could only ever
    // see the mint, and revocation depended on a second lookup nobody was guaranteed to make.
    await this.putRaw({
      kind: AGENT_RUN,
      body: {
        run,
        agent: mint.agent,
        tokenHash: mint.tokenHash,
        status: "stopped",
        quarantined: opts.quarantine ?? false,
      },
    });
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

  /** Resolve a presented bearer token to a principal, using the DB clock for expiry. */
  async resolveToken(token: string): Promise<ResolvedToken> {
    return await this.resolveCredential(token, await this.storage.now());
  }

  /**
   * Resolve a presented bearer token to a principal, from the RECORDS, on every request.
   *
   * There is no credential cache to go stale: a stopped run, an expired token and a token minted on
   * another instance are all discovered here rather than remembered. Both kinds index `tokenHash`,
   * so this is an indexed lookup, not a scan — and because a stop successor carries the same hash,
   * the newest record for that hash IS the current state of the credential.
   */
  private async resolveCredential(token: string, now: string): Promise<ResolvedToken> {
    const hash = await hashToken(token);
    // Operator tokens are process-lifetime and never records (the console needs one before any
    // agent exists), so they are the one thing answered from memory.
    if (this.creds.isOperator(hash)) return { ok: true, kind: "def", agent: this.ctx.principal };
    if (!/^[0-9a-f]{48}$/.test(token)) return { ok: false, reason: "invalid_token" };

    const run = await this.newestByHash(AGENT_RUN, hash);
    if (run) {
      const b = run as { run?: string; agent?: string; status?: string; expiresAt?: string };
      if (!b.run || !b.agent) return { ok: false, reason: "invalid_token" };
      this.creds.rememberRun(b.run, b.agent); // immutable; safe to memo
      if (b.status === "stopped") return { ok: false, reason: "run_stopped" };
      if (!b.expiresAt || b.expiresAt <= now) return { ok: false, reason: "token_expired" };
      return { ok: true, kind: "run", principal: b.run, agent: b.agent };
    }

    const def = await this.newestByHash(AGENT_DEFINITION, hash);
    const agent = (def as { agent?: string } | undefined)?.agent;
    return agent ? { ok: true, kind: "def", agent } : { ok: false, reason: "invalid_token" };
  }

  /** The newest record of `kind` carrying this token hash — the current state of that credential,
   *  because a stop is written as a successor with the same hash. */
  private async newestByHash(kind: string, tokenHash: string): Promise<unknown | undefined> {
    const rows = await this.query({ kind, match: { tokenHash } }, 1, { dir: "desc" });
    return rows[0]?.body;
  }

  /** The mint record for a run (newest wins, so a stopped run reports its stop). */
  private async runRecord(run: string): Promise<{ agent?: string; tokenHash?: string; status?: string } | undefined> {
    const rows = await this.query({ kind: AGENT_RUN, match: { run } }, 5, { dir: "desc" });
    // The stop successor omits nothing, but an older mint carries the hash if a caller wrote one
    // without it; take the newest non-empty value for each field.
    const bodies = rows.map((r) => r.body as { agent?: string; tokenHash?: string; status?: string });
    if (bodies.length === 0) return undefined;
    return {
      agent: bodies.find((b) => b.agent)?.agent,
      tokenHash: bodies.find((b) => b.tokenHash)?.tokenHash,
      status: bodies[0]?.status,
    };
  }

  /** The agent a run instantiates. Immutable, so the memo is safe; a miss reads the space. */
  async agentForRun(run: string): Promise<string | undefined> {
    const memo = this.creds.agentForRun(run);
    if (memo) return memo;
    const rec = await this.runRecord(run);
    if (rec?.agent) this.creds.rememberRun(run, rec.agent);
    return rec?.agent;
  }

  /** DB clock passthrough (health, diagnostics). */
  now(): Promise<string> {
    return this.storage.now();
  }

  /** `principal` is the RESOLVED caller (server-assigned `created_by` + idempotency scope); it
   *  defaults to the space's own identity for in-process/operator callers. */
  async put(req: PutRequest, idempotencyKey?: string, principal?: string): Promise<{ id: string }> {
    // A kind_def record IS a kind declaration: validate its body as a KindDef before commit,
    // so the substrate coordinates its own schema through the normal write path (no side table).
    if (req.kind === KIND_DEF) {
      const def = this.kindDefFromBody(req.body); // throws RadiaError on an invalid declaration
      const id = await this.putRaw(req, idempotencyKey, { principal });
      this.kinds.register(def); // reflect it in this process's registry (also on idempotent replay)
      await this.prepareStorageFor(def);
      return id;
    }
    // A grant record IS an authorization grant: validate its body before commit (write-protection
    // — that only a privileged principal may put one — is enforced at the API boundary).
    if (req.kind === GRANT) {
      const def = this.grantDefFromBody(req.body);
      validateGrantDef(def);
      this.checkGrantTemplate(def);
    }
    return this.putRaw(req, idempotencyKey, { principal });
  }

  private async putRaw(
    req: PutRequest,
    idempotencyKey?: string,
    opts: { taint?: boolean; principal?: string } = {},
  ): Promise<{ id: string }> {
    const now = await this.storage.now(); // INVARIANT: timestamps come from the DB clock
    // Taint is server-computed data lineage: forced by opts (declassify), else client-raise OR
    // any data parent tainted. A client can only RAISE taint; clearing needs a privileged declassify.
    const taint = opts.taint !== undefined ? opts.taint : await this.computeTaint(req.parentIds ?? [], req.taint);
    const { record, bodyJson } = await buildRecord(req, {
      principal: opts.principal ?? this.ctx.principal, // created_by = the resolved caller
      schemaVersion: this.ctx.schemaVersion,
      now,
      taint,
    });
    const idempotency = await this.idem("put", idempotencyKey, {
      kind: req.kind,
      body: req.body,
      parentIds: req.parentIds ?? [],
    }, opts.principal);
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

  // ---- artifacts (design-data-model §2.4) --------------------------------------------------
  //
  // An artifact is a RECORD whose body describes bytes held in the blob store. Everything that
  // makes records useful — grants, taint, lineage, the event log, retention — therefore applies
  // to it with no new machinery, and only the payload sits outside. The reference clients hold is
  // the record id: stable, immutable, and never a signed URL (which would expire inside a record
  // that cannot be rewritten).

  get maxArtifactBytes(): number {
    return this.ctx.maxArtifactBytes;
  }

  get downloadCapabilitySeconds(): number {
    return this.ctx.downloadCapabilitySeconds;
  }

  get blobStoreName(): string {
    return this.blobs.name;
  }

  /** Store bytes and commit the `artifact` record that references them. The digest and size are
   *  computed here, never taken from the client — they are runtime-authoritative like any other
   *  server-assigned field. */
  async putArtifact(
    bytes: Uint8Array,
    meta: { mediaType: string; filename?: string; parentIds?: string[]; retentionUntil?: string; taint?: boolean },
    idempotencyKey?: string,
    principal?: string,
  ): Promise<{ id: string; digest: string; size: number }> {
    if (bytes.byteLength > this.ctx.maxArtifactBytes) {
      throw new RadiaError("artifact_too_large", `artifact exceeds the ${this.ctx.maxArtifactBytes}-byte limit`);
    }
    validateArtifactDef({ digest: "", mediaType: meta.mediaType, size: 0, filename: meta.filename });
    const ref = await this.blobs.put(bytes);
    const body: ArtifactDef = { digest: ref.digest, mediaType: meta.mediaType, size: ref.size };
    if (meta.filename) body.filename = meta.filename;
    const { id } = await this.put(
      {
        kind: ARTIFACT,
        body,
        parentIds: meta.parentIds,
        retentionUntil: meta.retentionUntil,
        taint: meta.taint,
      },
      idempotencyKey,
      principal,
    );
    return { id, digest: ref.digest, size: ref.size };
  }

  /** The artifact record plus a byte stream, or null if the id is not an artifact / the blob is
   *  gone. Callers authorize FIRST — this is the read itself, not the check. */
  async readArtifact(recordId: string): Promise<{ record: RadiaRecord; def: ArtifactDef; stream: ReadableStream<Uint8Array> } | null> {
    const record = await this.storage.getRecord(recordId);
    if (!record || record.kind !== ARTIFACT) return null;
    const def = record.body as ArtifactDef;
    if (!def || !isDigest(def.digest)) return null;
    const stream = await this.blobs.get(def.digest);
    return stream ? { record, def, stream } : null;
  }

  /** Mint a short-lived capability to download ONE artifact. The caller must already be authorized
   *  to read it; this delegates that read to a context that cannot send an Authorization header
   *  (an `<img src>` in the console), which is why the design specifies capabilities rather than
   *  putting a bearer token in a URL. */
  mintDownloadCapability(recordId: string): { capability: string; expiresAt: string } {
    const capability = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + this.ctx.downloadCapabilitySeconds * 1000;
    this.downloadCaps.set(capability, { recordId, expiresAt });
    this.sweepCapabilities();
    return { capability, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Does this capability open this artifact, right now? Scoped to one record on purpose: a
   *  leaked capability is one object for a few minutes, not an identity. */
  checkDownloadCapability(capability: string, recordId: string): boolean {
    const cap = this.downloadCaps.get(capability);
    if (!cap) return false;
    if (cap.expiresAt <= Date.now()) {
      this.downloadCaps.delete(capability);
      return false;
    }
    return cap.recordId === recordId;
  }

  private sweepCapabilities(): void {
    const now = Date.now();
    for (const [token, cap] of this.downloadCaps) if (cap.expiresAt <= now) this.downloadCaps.delete(token);
  }

  readOne(template: Template, scope?: StatsScope): Promise<RadiaRecord | null> {
    return this.storage.readOne(this.compile(template), scope);
  }

  /**
   * Matching records ordered by the template, capped at `limit`.
   *
   * `page` is a KEYSET cursor over record id (`after` exclusive, `dir` to walk backwards) — the
   * stable way to paginate a space that is still being written to, and the only way to ask for the
   * NEWEST records rather than the oldest. It is defined for the natural id order only: an
   * explicit `order_by` already answers "in what order", and a cursor over a body field would need
   * the whole sort key plus the oracle's type rules, so combining them is rejected rather than
   * silently resolved one way.
   */
  query(template: Template, limit = 100, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]> {
    const compiled = this.compile(template);
    if (page && (page.after || page.dir) && compiled.orderBy?.length) {
      throw new RadiaError(
        "invalid_template",
        "a keyset page (after/dir) is only defined for the natural id order — drop order_by, or page without a cursor",
      );
    }
    return this.storage.query(compiled, limit, page, scope);
  }

  /** Record counts by kind and state (dev UI overview). `scope` makes it a genuine self-aggregate
   *  — computed over the subset, never a whole-space total filtered afterwards. */
  stats(scope?: StatsScope): Promise<KindStateCount[]> {
    return this.storage.stats(scope);
  }

  /**
   * What a principal may see of the ops plane, or `null` for unrestricted (operator).
   *
   * Ops access stays KIND-SCOPED: a non-operator reaches the plane for exactly the kinds where it
   * holds a `query` grant carrying `scope.createdBy: "self"`, and only for its own records of those
   * kinds. There is no ops pseudo-kind, because that would be a wildcard wearing a different hat.
   *
   * "Its own records" resolves through the AGENT, not the presented run: `created_by` stores
   * `run:<ulid>`, run tokens are re-minted, and comparing to the current run would silently hide
   * the same agent's earlier work. Throws `forbidden` when nothing is scoped to it — the same
   * answer the plane gave before, for a principal with no such grant.
   */
  async opsScope(principal: string): Promise<StatsScope | null> {
    if (this.isPrivileged(principal)) return null;
    const subject = this.grantSubject(principal);
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject })).entries.values()]
      .map((g) => g.body as GrantDef & { scope?: { createdBy?: string } })
      .filter((g) => Array.isArray(g.operations) && g.operations.includes("query"));
    // Reachability is still opt-in: SOME kind must carry a self-scoped read grant, or the plane
    // stays shut. An ordinary query grant does not open it.
    if (!grants.some((g) => g.scope?.createdBy === "self")) {
      throw new RadiaError("forbidden", `principal '${principal}' may not access the ops plane`);
    }
    // Which of those kinds are actually NARROWED is asked of `authorScope` — the same function the
    // read path uses — rather than restated here. Restating it was wrong in a way that produced a
    // confidently incorrect number: this filtered on "has a self-scoped grant", while a read is
    // narrowed only when EVERY grant permitting it is self-scoped. A principal holding both an
    // unscoped `{put, query}` and a self-scoped `{query}` on one kind (different operation sets, so
    // different grant identities, so both live) could therefore LIST every record of that kind
    // while `ops/stats` counted only its own — 187 messages reported to a session whose own query
    // returned 578, with nothing in the aggregate to hint at it.
    const kinds = [...new Set(grants.filter((g) => g.scope?.createdBy === "self").map((g) => g.kind))];
    // …and which of those the caller can actually read MORE of. This does not widen the aggregate —
    // the ops plane stays self-scoped on purpose — it makes the aggregate able to say so. A read is
    // narrowed only when EVERY grant permitting it is self-scoped, so a principal holding an
    // unscoped `{put, query}` beside a self-scoped `{query}` (different operation sets, different
    // grant identities, both live) can LIST every record of the kind while these counts cover only
    // its own. That is a legitimate state, and a number that quietly disagrees with the caller's own
    // query is how a session came to report 187 messages as the space's total when it could see 578.
    const alsoReadable: string[] = [];
    for (const kind of kinds) {
      if (!(await this.authorScope(principal, "query", kind))) alsoReadable.push(kind);
    }
    // An agent with no runs on record would scope to the empty set and see nothing; include the
    // principal itself so a direct (non-run) principal still matches its own records.
    return {
      createdBy: await this.runPrincipalsOf(subject, principal),
      kinds: kinds.sort(),
      ...(alsoReadable.length > 0 ? { alsoReadable: alsoReadable.sort() } : {}),
    };
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

  async renew(lease: Lease, opts: TakeOptions = {}, idempotencyKey?: string, principal?: string): Promise<RenewResult> {
    if (!(await this.ownerGuard(lease.recordId, principal, "renew")).ok) return { status: "lease_lost" };
    const idem = await this.idem("renew", idempotencyKey, this.ref(lease), principal);
    return this.storage.renew(this.ref(lease), opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds, idem);
  }

  /** Consume the leased record, optionally emitting a result record linked to it. `principal` is
   *  the RESOLVED caller (server-assigned `created_by` on the result + idempotency scope + lease
   *  ownership check). */
  async ack(lease: Lease, result?: PutRequest, idempotencyKey?: string, principal?: string): Promise<AckResult> {
    const guard = await this.ownerGuard(lease.recordId, principal, "ack");
    if (!guard.ok) return { status: "lease_lost" };
    const owner = guard.owner; // authoritative lease owner (envelope), used for authority derivation
    let resultInput: PutInput | undefined;
    if (result) {
      const now = await this.storage.now();
      const parentIds = [
        lease.recordId,
        ...(result.parentIds ?? []).filter((p) => p !== lease.recordId),
      ];
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
        principal: principal ?? this.ctx.principal, // created_by = the acking caller
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
    }, principal);
    const r = await this.storage.ack(this.ref(lease), resultInput, idem);
    this.notifier.notify(); // an emitted result is a new available record to wake on
    return r;
  }

  async nack(lease: Lease, opts: { backoffSeconds?: number } = {}, idempotencyKey?: string, principal?: string): Promise<SettleResult> {
    if (!(await this.ownerGuard(lease.recordId, principal, "nack")).ok) return { status: "lease_lost" };
    const idem = await this.idem("nack", idempotencyKey, this.ref(lease), principal);
    const r = await this.storage.nack(
      this.ref(lease),
      opts.backoffSeconds ?? this.ctx.defaultBackoffSeconds,
      this.ctx.maxAttempts,
      idem,
    );
    this.notifier.notify(); // record back to available
    return r;
  }

  async release(lease: Lease, idempotencyKey?: string, principal?: string): Promise<SettleResult> {
    if (!(await this.ownerGuard(lease.recordId, principal, "release")).ok) return { status: "lease_lost" };
    const idem = await this.idem("release", idempotencyKey, this.ref(lease), principal);
    const r = await this.storage.release(this.ref(lease), idem);
    this.notifier.notify(); // record back to available
    return r;
  }

  /**
   * Owner-match guard for lease settlement (ack/nack/release/renew). A non-operator principal may
   * settle only a lease it OWNS — defense-in-depth on top of fencing. It closes lease-leak
   * IMPERSONATION (ack, whose emitted result carries the owner's authority + delegation chain) and
   * lease-leak DoS (nack/release/renew driving someone else's task to available/dead-letter). A
   * stranger presenting a leaked lease gets the SAME opaque `lease_lost` fencing returns — never a
   * distinguishable error, which would leak lease existence. In-process/operator callers (no
   * principal / privileged) skip the check. Returns the authoritative `lease_owner` on success (ack
   * needs it to derive authority).
   *
   * The mismatch is logged: the caller only ever sees `lease_lost`, which the SDK's agentLoop treats
   * as ordinary fencing ("duplicate work possible") and retries forever — so a misconfigured agent
   * presenting the wrong identity would spin silently. The server-side warn makes that diagnosable.
   *
   * Ordering: this reads `lease_owner`, NOT the `lease_id`/epoch fencing check, and runs before the
   * idempotency check inside storage. It does NOT violate the "idempotency is checked before lease
   * validation" invariant: `lease_owner` is not cleared on settle, so a legitimate owner's retry of
   * an already-succeeded op still matches here and replays via idempotency; a non-owner never had a
   * stored response to replay. No succeeded op can be turned into a false `lease_lost`.
   */
  private async ownerGuard(
    recordId: string,
    principal: string | undefined,
    op: string,
  ): Promise<{ ok: true; owner?: string } | { ok: false }> {
    const owner = (await this.storage.getEnvelope(recordId))?.leaseOwner;
    if (principal && !this.isPrivileged(principal) && owner && principal !== owner) {
      console.warn(`[radia] owner-match: ${op} on ${recordId} by '${principal}' rejected (lease owned by '${owner}') -> lease_lost`);
      return { ok: false };
    }
    return { ok: true, owner };
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
      // Bounded per node: the node cap below limits how many records the graph SHOWS, not how many
      // this reads, so an unbounded fan-out here would materialize a whole subtree to enqueue it.
      for (const child of await this.storage.childrenOf(id, GRAPH_FANOUT)) {
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

  /** Append-only event log after the opaque `afterCursor` ("0"/"" = from the start). */
  getEvents(afterCursor = "0", limit = 200): Promise<SpaceEvent[]> {
    return this.storage.getEvents(afterCursor, limit);
  }

  /**
   * A record and its ancestry via parent_ids (BFS, `depth` 0 = the record itself). The
   * lineage DAG is acyclic by construction, but `seen` and a node cap guard anyway.
   */
  async getLineage(recordId: string, maxNodes = 200): Promise<{ record: RadiaRecord; depth: number }[]> {
    const out: { record: RadiaRecord; depth: number }[] = [];
    const seen = new Set<string>();
    let frontier: string[] = [recordId];
    // One round trip per DEPTH LEVEL, not per node: a level's records are fetched together, and
    // only then does the walk decide what the next level is. A chain of 64 ancestors used to cost
    // 64 sequential round trips — which on a networked Postgres is latency, not work.
    for (let depth = 0; frontier.length > 0 && out.length < maxNodes; depth++) {
      const fresh = frontier.filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      const records = await this.storage.getRecords(fresh);
      // getRecords does not promise an order, and lineage output should not depend on one. A
      // single-record level — every level of a plain chain — is already sorted.
      if (records.length > 1) records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const next: string[] = [];
      for (const rec of records) {
        out.push({ record: rec, depth });
        next.push(...rec.runtimeMeta.parentIds);
      }
      frontier = next;
    }
    return out;
  }

  /** Records that reference this record via `parent_ids` — its direct **children** (the reverse of
   *  lineage). E.g. a conversation's messages/llm_calls, an llm_call's chunks + result, a task's
   *  results. Lineage goes up (ancestors); this goes down. */
  getChildren(recordId: string, limit = 100, page?: Page): Promise<RadiaRecord[]> {
    return this.storage.childrenOf(recordId, Math.min(limit, 500), page);
  }

  // ---- watches (M1) ----

  /** Create an ephemeral watch. The stream starts from the current high-water cursor. */
  async createWatch(template: Template): Promise<{ watchId: string }> {
    const match = this.compile(template); // validates the template
    const cursor0 = await this.storage.latestCursor();
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
    q: {
      state: RecordState;
      expired?: boolean;
      staleSeconds?: number;
      limit?: number;
      excludeKinds?: string[];
      scope?: StatsScope;
    },
  ): Promise<{ record: RadiaRecord | null; envelope: Envelope }[]> {
    const now = await this.storage.now();
    let envs = await this.storage.envelopesInState(q.state, q.limit ?? 100, q.excludeKinds, q.scope);
    if (q.expired) envs = envs.filter((e) => e.leasedUntil !== undefined && e.leasedUntil < now);
    // Ignore a non-finite window rather than computing an Invalid Date from it: in-process callers
    // bypass the HTTP validation, and `addSeconds(now, -NaN)` throws deep in date formatting.
    if (q.staleSeconds !== undefined && Number.isFinite(q.staleSeconds)) {
      const before = addSeconds(now, -q.staleSeconds);
      envs = envs.filter((e) => e.attempt === 0 && e.availableAt < before);
    }
    const rows: { record: RadiaRecord | null; envelope: Envelope }[] = [];
    for (const e of envs) rows.push({ record: await this.storage.getRecord(e.recordId), envelope: e });
    return rows;
  }

  /**
   * Remediate every record matching an envelope SELECTOR, not one id at a time.
   *
   * Remediation used to be strictly per-record (`POST /v0/ops/records/{id}/{action}`), which meant
   * draining 500 stuck leases took 500 calls preceded by 50 diagnostics calls just to learn the
   * ids — and the diagnostics report only samples ten. The selector here is deliberately the SAME
   * shape `queryEnvelopes` accepts, so "what is wrong" and "fix it" are one query language rather
   * than two: `{state:"leased", expired:true}` is the stuck-lease set in both.
   *
   * Every transition is state-guarded per record, so this is safe to re-run and safe to race with
   * a worker that comes back: a record that moved on is simply not applied. Bounded by `limit`;
   * `more` says the page was full, so a caller draining a backlog loops until it is false.
   */
  async remediate(
    action: "reclaim" | "dead-letter" | "requeue",
    selector: { state: RecordState; expired?: boolean; staleSeconds?: number; limit?: number },
  ): Promise<{ action: string; matched: number; applied: number; more: boolean; sample: string[] }> {
    const limit = Math.min(Math.max(selector.limit ?? 200, 1), 2000);
    // Remediation acts on WORK. A `claimable:false` kind — kind_def, grant, agent_run, facts,
    // history — sits `available` forever by design, so a broad `{state:"available"}` selector would
    // otherwise sweep the kind registry and the grants into dead_letter and break the space. The
    // starvation check excludes them for the same reason; here it is not a heuristic but a guard.
    // `dead_letter` is NOT filtered: that is the recovery path, and a reference record that
    // somehow landed there must stay requeueable.
    const excludeKinds = selector.state === "available"
      ? this.kinds.list().filter((d) => !isClaimable(d)).map((d) => d.kind)
      : undefined;
    const rows = await this.queryEnvelopes({ ...selector, limit, excludeKinds });
    let applied = 0;
    for (const row of rows) {
      const id = row.envelope.recordId;
      const ok = action === "reclaim"
        ? await this.reclaim(id)
        : action === "dead-letter"
        ? await this.forceDeadLetter(id)
        : await this.requeue(id);
      if (ok) applied++;
    }
    return { action, matched: rows.length, applied, more: rows.length >= limit, sample: rows.slice(0, 5).map((r) => r.envelope.recordId) };
  }

  /** A derived health report, composed from queryEnvelopes + stats: counts by state,
   *  dead-letters, expired-but-stuck leases, and available records that have sat unclaimed. */
  async diagnostics(scope?: StatsScope): Promise<Diagnostics> {
    const now = await this.storage.now();
    // Every component below carries the scope, so a scoped report is computed over that subset
    // rather than assembled from the whole space and trimmed. A count filtered after the fact is
    // the dangerous failure here: it is invisible in the output, it just looks plausible.
    const stats = await this.storage.stats(scope);
    const total = (state: string) => stats.filter((s) => s.state === state).reduce((a, s) => a + s.count, 0);
    const SAMPLE = 500;
    const STALE_S = this.ctx.diagnosticsStaleSeconds;
    // Starvation is only meaningful for CLAIMABLE (work) kinds: reference records (facts, config,
    // grants, kind_defs, history) sit `available` forever by design — not stale, so exclude them
    // (filtered in the query, before the sample cap, so real stale work is never crowded out).
    const referenceKinds = this.kinds.list().filter((d) => !isClaimable(d)).map((d) => d.kind);

    const deadLetter = await this.queryEnvelopes({ state: "dead_letter", limit: 50, scope });
    const stuck = await this.queryEnvelopes({ state: "leased", expired: true, limit: SAMPLE, scope });
    const stale = await this.queryEnvelopes({ state: "available", staleSeconds: STALE_S, limit: SAMPLE, excludeKinds: referenceKinds, scope });
    const env = (r: { envelope: Envelope }) => r.envelope;

    return {
      now,
      // No `expired` count: expiry is IMPLICIT. A lease that lapses leaves the record in state
      // `leased` (a later take reclaims it, bumping the attempt), so nothing ever writes the
      // `expired` state and reporting it would always be a confident zero next to hundreds of
      // demonstrably lapsed leases. The real number is `stuckLeases` below.
      counts: {
        available: total("available"),
        leased: total("leased"),
        consumed: total("consumed"),
        dead_letter: total("dead_letter"),
      },
      deadLetter: { count: total("dead_letter"), sample: deadLetter.slice(0, 10).map((r) => ({ recordId: env(r).recordId, kind: env(r).kind, attempt: env(r).attempt })) },
      stuckLeases: {
        count: stuck.length,
        // The scan is capped, so a full page means "at least this many" — otherwise a reader (or a
        // model) reports a cap as if it were a census.
        atLeast: stuck.length >= SAMPLE,
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

  /** Build an idempotency key with a request hash, or undefined when no key was supplied. The
   *  key is scoped to the RESOLVED caller (`principal`), so two agents reusing the same
   *  Idempotency-Key don't collide; in-process callers default to the space's own identity. */
  private async idem(
    operation: string,
    key: string | undefined,
    request: unknown,
    principal?: string,
  ): Promise<IdempotencyKey | undefined> {
    if (!key) return undefined;
    return {
      principal: principal ?? this.ctx.principal,
      operation,
      key,
      requestHash: await sha256Hex(JSON.stringify(request)),
    };
  }
}
