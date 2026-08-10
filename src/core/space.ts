// The Space service: the storage-agnostic runtime logic behind the HTTP surface. It owns
// server-side policy (metadata assignment, pattern compilation) and delegates atomic
// storage transitions to a StorageAdapter. One Space wraps one adapter.

import type {
  AckResult,
  CompiledMatch,
  DelegationContext,
  Envelope,
  EventHorizonCheck,
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
import { combineMatch, compilePattern, matchesRecord, type Pattern } from "./matching.ts";
import {
  AGENT_DEFINITION,
  AGENT_RUN,
  INTEREST,
  normalizeTaint,
  parseTaintAllowlist,
  SHRED,
  type ArtifactDef,
  assertReservedCompatible,
  GRANT,
  type GrantDef,
  type GrantOp,
  isClaimable,
  KIND_DEF,
  type KindDef,
  kindDefKey,
  KindRegistry,
  META_RESERVED,
  OPS_GRANT,
  OPS_POWERS,
  type OpsGrantDef,
  type OpsPower,
  SIGNAL,
  validateGrantDef,
  validateKindDef,
  validateOpsGrantDef,
  WRITE_PROTECTED_KINDS,
} from "./kinds.ts";
import { CredentialStore, hashToken, mintCredential, type ResolvedToken } from "./auth.ts";
import { type CompactionResult, compactRegistries } from "./gc.ts";
import { type BlobStore, MemoryBlobStore } from "../storage/blobs.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
import { activeSet, grantKey, isRetired, opsGrantKey, readRegistry, type RegistryView } from "./registry.ts";
import { Notifier } from "./notifier.ts";
import { type FlowReport, type FlowShape, mineFlows } from "./flows.ts";
import {
  type ArtifactHost,
  type ArtifactMeta,
  CapabilityStore,
  putArtifact,
  readArtifact,
  shredArtifact,
  shredOf,
} from "./artifacts.ts";
import {
  type Diagnostics,
  diagnostics,
  digest,
  explainQuery,
  GRAPH_FANOUT,
  type InspectionHost,
  type LiveInterest,
  type SpaceDigest,
  type StaleSplit,
  thread,
} from "./inspection.ts";
import {
  attestedAnchorIdx,
  chainedEvent,
  horizonStatement,
  type IntegrityReport,
  linkEvents,
  SEAL_BATCH,
  type SealKey,
} from "./seal.ts";
import { CHAIN_GENESIS, eventHash, type GraphNode, RESERVED_KINDS } from "../../sdk/ts/wire.ts";
export type { GraphNode };

export interface SpaceContext {
  principal: string;
  schemaVersion: number;
  /** Largest serialized record body, in bytes. Deliberately far below `maxArtifactBytes`: a body
   *  approaching artifact size is a payload in the wrong place, and unlike an artifact it can
   *  never be erased. */
  maxRecordBytes: number;
  runId: string;
  defaultLeaseSeconds: number;
  defaultBackoffSeconds: number;
  maxAttempts: number;
  maxCumulativeSeconds: number;
  /** The one supervisor agent that, like an operator, may write grants/signal and reach `/ops/*`. */
  supervisor: string;
  /**
   * The human principals with operator authority, named one by one.
   *
   * `human:*` used to confer it by PREFIX, which made every person an operator and left no way to
   * express a person with ordinary grants. A space with real users needs both, so membership is
   * explicit: `human:local` is here because unauthenticated dev requests resolve to it, and any
   * other person is an ordinary principal until someone puts them in this set.
   */
  operators: string[];
  /** How long a minted run token stays valid (short-lived; the run refreshes by re-minting). */
  runTokenSeconds: number;
  /** How long a run may keep renewing before it must be re-minted. */
  runMaxLifetimeSeconds: number;
  /** Age past which an unclaimed *claimable* record counts as stale in diagnostics (starvation). */
  diagnosticsStaleSeconds: number;
  /** Hard ceiling on one artifact's bytes (design-data-model §2 resource limits). */
  maxArtifactBytes: number;
  /** Lifetime of a download capability: the short-lived, single-artifact grant that lets a
   *  browser fetch bytes it cannot attach an Authorization header to. */
  downloadCapabilitySeconds: number;
  /** How long a watch survives with nothing attached. Generous relative to a reconnect (the SSE
   *  keepalive is 15s), because dropping one early costs a client its cursor and the events in the
   *  gap; the point is to bound abandoned watches, not to be prompt. */
  watchIdleSeconds: number;
  /** Distinct interests one principal may register per kind. The registry is read per candidate by
   *  the dry-run matcher and per kind by the starvation split, so its size is somebody else's cost. */
  maxInterestsPerPrincipal: number;
  /** Live watches one principal may hold. A watch is an authenticated call that allocates memory,
   *  so it needs a ceiling like any other resource; an agent loop opens one per KIND it claims, and
   *  an inspection console a handful, so this is far above ordinary use and only stops a leak. */
  maxWatchesPerPrincipal: number;
  /** Candidate rows ONE read may push through the oracle (`CompiledMatch.scanBudget`). The only
   *  limit here that bounds a cost the caller cannot see in its own request: a pattern SQL cannot
   *  decide is cheap to send and linear in the size of the kind to answer. `0` disables it
   *  (`radia dev --max-scan-rows 0`), which is the pre-budget behaviour and not a shared-space setting. */
  maxScanRows: number;
  /** How long a stored idempotency response outlives its write. Far beyond any honest retry loop:
   *  a replay after this window re-executes, which is the ordinary at-least-once posture. */
  idempotencyRetentionSeconds: number;
  /** Every this-many record commits, the WRITING call runs one small retention batch inline —
   *  the lazy-lease-expiry shape, so an active space pays for its own housekeeping and an idle one
   *  runs nothing, with no timer. `0` disables it; the `gc` verb still owns compaction and backlogs. */
  gcEveryWrites: number;
  /** Event-log retention (plan-gc.md phase 3). `null` (the default) means events are never swept
   *  and the evidence promise stays unqualified. When set, the `gc` verb truncates the log to
   *  this window ∩ the sealed head, anchored and attested so verify can tell it from tampering.
   *  Weeks, not hours: it must dwarf any watch reconnect gap, since a client sleeping past it
   *  gets a 410 and re-syncs by query. Verb-only, never amortized. */
  eventRetentionSeconds: number | null;
}

/** Rows one amortized sweep pass may delete: small enough that the write paying for it feels a few
 *  milliseconds, not a collection. A backlog bigger than this drains across later triggers. */
const AMORTIZED_BATCH = 256;

const DEFAULT_CONTEXT: SpaceContext = {
  principal: "local:dev", // auto-provisioned locally; real principals land in Phase 7
  schemaVersion: 1,
  runId: "run:local",
  defaultLeaseSeconds: 30,
  defaultBackoffSeconds: 5,
  maxAttempts: 5,
  maxCumulativeSeconds: 300,
  supervisor: "agent:supervisor",
  operators: ["human:local"], // the no-header dev identity; add people deliberately
  runTokenSeconds: 900, // 15 min; a live run RENEWS before expiry (`renewRun`)
  // The ceiling on renewal. Short-lived run tokens exist so a LEAKED one stops working, and a token
  // that renews forever is a long-lived one with extra steps. So renewal extends the window and
  // never the run: past this, the holder has to authenticate again, which a leaked token cannot do.
  runMaxLifetimeSeconds: 12 * 3600,
  diagnosticsStaleSeconds: 60,
  maxArtifactBytes: 32 * 1024 * 1024,
  // 1 MiB. Generous for anything that is genuinely routing content (the chat's largest bodies are
  // kilobytes, since stdout over 4 KiB already becomes an artifact) and far below the artifact cap,
  // so the gap between them is the signal that a payload belongs out of line.
  maxRecordBytes: 1024 * 1024,
  downloadCapabilitySeconds: 300,
  watchIdleSeconds: 300,
  maxWatchesPerPrincipal: 64,
  // 64, raised from 32 with one worker already at 31: a tool worker registers one interest per
  // tool NAME (the documented design, extensions/ts/tool-worker.ts), so the chat's tools worker sat
  // one tool from the cliff — and `agentLoop` treats a refused publish as "no grant" and silently
  // skips the remaining patterns. The ceiling exists to bound the registry's read cost, and the
  // reads that pay it are author-scoped or memoized now, so headroom is cheap.
  maxInterestsPerPrincipal: 64,
  // 200k rows, about 2.8s of oracle at the measured cost (`bench/deployment.ts`: 13.6s per million).
  // High enough that no space reaches it by growing normally, since every pushable predicate returns
  // matches rather than candidates and never counts against it. What it stops is the shape that has
  // no ceiling at all: an unpushable pattern over an unbounded kind.
  maxScanRows: 200_000,
  idempotencyRetentionSeconds: 7 * 24 * 3600,
  gcEveryWrites: 1000,
  eventRetentionSeconds: null, // opt-in: an unconfigured space never truncates its log
};

/** What one event-log retention pass did (`Space.gcEvents`; rides the `gc` verb). */
export interface EventGcResult {
  /** False when `eventRetentionSeconds` is unset: the log is never truncated. */
  enabled: boolean;
  /** Links sealed by the seal-first pass this call ran. */
  sealed: number;
  /** Seal-first debt after the budget: 0 = fully sealed, 1 = at least one unsealed (a probe,
   *  like `IntegrityReport.unsealed`; report it as "N+"). Unsealed events can never sweep. */
  unsealed: number;
  /** Events deleted (0 on a dry run). */
  swept: number;
  /** Events at or below the anchor (dry run: what would go). */
  eligible: number;
  /** The chosen anchor: the newest sealed event outside the retention window, cursor-group safe. */
  anchorIdx?: number;
  /** Whether the horizon statement sealed; false aborts the sweep with `more: true`. */
  attested?: boolean;
  /** Work remains: a seal backlog, an unsealed statement, or pairs past this call's limit. */
  more: boolean;
}

/** How a caller selects work to take. */
export type TakeInput =
  | { pattern: Pattern }
  | { recordId: string; pattern?: Pattern };

export interface TakeOptions {
  leaseSeconds?: number;
  /** Sensitive consumer: the labels a candidate may carry. Undefined = no barrier of the caller's
   *  own; the grant-side barrier applies regardless. */
  allowTaint?: string[];
  /** Author restriction from a self-scoped grant: skip candidates authored by anyone else.
   *  Enforced in the claim, not by the caller. A claim returns the record BODY, so a take that
   *  ignores the scope reads everything a scoped `query` correctly refuses. */
  createdBy?: string[];
}

export interface Watch {
  /** The client's ORIGINAL pattern, before any grant constraint was ANDed in. Kept because a
   *  compiled match cannot be un-narrowed: re-deriving the scope means recombining THIS with a
   *  freshly-read grant set, and recombining the already-narrowed one would ratchet the scope
   *  tighter on every check. */
  request: Pattern;
  match: CompiledMatch;
  cursor0: string; // opaque high-water cursor at creation; the stream starts here unless resumed
  /** The principal that created it. A watch is scoped by ITS creator's grants, so attaching must
   *  be restricted to that creator. Otherwise the scope belongs to somebody else. */
  owner: string;
  /** Author restriction from a self-scoped grant, applied to wakeups as well as to reads. */
  createdBy?: string[];
  /** Wall clock (ms) of the last time a client touched this watch: created it, attached to it, or
   *  ran a lap of its stream. What makes an ABANDONED watch distinguishable from a live one, which
   *  is the whole difference between an idle sweep and breaking open connections. Process-local
   *  ephemeral state, so wall clock rather than the DB clock — the same call the download
   *  capabilities make. */
  lastSeenAt: number;
}

/** What a read verb is allowed to see: pattern constraint plus author restriction. */
export interface ReadAccess {
  /** Patterns the request must additionally satisfy (`null` = unrestricted). */
  constraint: Record<string, unknown>[] | null;
  /** Principals whose records are readable, or `undefined` for no author restriction. */
  createdBy?: string[];
  /** The allowlist the GRANTS impose, if they all impose one. Distinct from the caller's own
   *  `allowTaint`: this one the principal cannot decline. */
  allowTaint?: string[];
}

export interface EffectivePermissions {
  principal: string;
  /** The agent a run resolves to. Grants are held by agents, not by individual runs. */
  subject: string;
  privileged: boolean;
  kinds: {
    kind: string;
    operations: GrantOp[];
    readsScopedToSelf: boolean;
    patterns: Record<string, unknown>[];
    /** Set when NO such kind is declared on this space, so the grant authorizes nothing. A grant
     *  may legitimately precede its kind (an operator bootstraps an agent before the fleet declares
     *  its kinds), so this is a flag rather than an error. But an agent that guessed a kind name
     *  and got it approved otherwise reads this row as working access. */
    kindNotDeclared?: true;
  }[];
  ops: { reachable: boolean; kinds: string[] };
  /** Ops-plane powers held via `ops_grant` records (all of them for a privileged principal).
   *  Reported through the same resolution the gate enforces (`Space.opsPowers`), so this line IS
   *  the enforcement, not a restatement of it. Distinct from `ops` above, which is the
   *  self-scoped read tier (own records of granted kinds). */
  opsPowers: OpsPower[];
  /** False if the grant scan could not be exhausted. The picture may be missing entries. */
  complete: boolean;
}

/** One shred, and whether it still means anything. */
export interface ErasureStatus {
  shredId: string;
  artifactId: string;
  digest: string;
  reason: string;
  at: string;
  method: string;
  /** False when the payload is present again, which is a REVERSED erasure and the only interesting
   *  value here. */
  holds: boolean;
}

/** A short, generic label for a graph node: kind plus a common discriminating field. */
function labelFor(rec: RadiaRecord): string {
  const b = (rec.body ?? {}) as Record<string, unknown>;
  const hint = b.role ?? b.op ?? b.tool ?? "";
  return hint ? `${rec.kind}:${hint}` : rec.kind;
}

export type { Diagnostics, FlowReport, FlowShape, LiveInterest, StaleSplit };

export class Space {
  private readonly kinds = new KindRegistry();
  private readonly creds = new CredentialStore();
  private readonly ctx: SpaceContext;
  private readonly notifier = new Notifier(() => this.pollForForeignChanges());
  /** How far the cross-instance poll has read the event log. `undefined` until the first poll,
   *  which is why that first one always reports a change (see `pollForForeignChanges`). */
  private changeCursor?: string;
  private readonly watches = new Map<string, Watch>();
  /** Live download capabilities: token -> the one artifact it opens, and when it lapses. In
   *  memory and short-lived by design. A capability is a delegation of a read the caller already
   *  held, not a credential, and it must not outlive the process that issued it. */
  /** Short-lived download capabilities (`core/artifacts.ts`). Process-local by design. */
  private readonly caps: CapabilityStore;

  constructor(
    private readonly storage: StorageAdapter,
    ctx: Partial<SpaceContext> = {},
    /** Where artifact BYTES live. Defaults to memory, so an ephemeral space stays ephemeral;
     *  a persisted space passes a FileBlobStore (see main.ts). */
    private readonly blobs: BlobStore = new MemoryBlobStore(),
  ) {
    this.ctx = { ...DEFAULT_CONTEXT, ...ctx };
    this.caps = new CapabilityStore(this.ctx.downloadCapabilitySeconds);
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
    validateKindDef(def);
    assertReservedCompatible(def); // in-process is not a licence to shrink a reserved kind either
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
   * needs to plan predicates on them (`StorageAdapter.prepareKind`, optional: Postgres creates
   * planner statistics, SQLite implements nothing).
   *
   * Advisory in both directions: an adapter without the hook is skipped, and a failure inside it
   * is swallowed. A kind declaration must not fail because an optimization could not be applied.
   * The difference is how fast the answer comes back, never what it is.
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
   * Read one registry kind completely and project it. This is the ONE place limit and direction
   * are decided, rather than at each call site.
   */
  private registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
    scope?: StatsScope,
  ): Promise<RegistryView> {
    return readRegistry<T>(
      (limit: number, after?: string) => this.query({ kind, match }, limit, { dir: "desc", after }, scope),
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
      let def: KindDef;
      try {
        // Validated, not cast. A declaration that a live `put` would refuse must not be adopted
        // just because it is already in the log: a redeclaration of a reserved kind written before
        // that rule existed would otherwise reinstate itself on every restart.
        def = this.kindDefFromBody(rec.body);
      } catch {
        // skip a malformed or reserved-incompatible persisted declaration rather than fail startup
        continue;
      }
      this.kinds.register(def);
      await this.prepareStorageFor(def);
    }
  }

  /** Validate a kind_def record body as a KindDef. Rejects redefining the built-in meta-kind, and
   *  any redeclaration that drops what a reserved kind's own machinery compiles against. */
  private kindDefFromBody(body: unknown): KindDef {
    if (body === null || typeof body !== "object") {
      throw new RadiaError("invalid_kind", "a kind_def record body must be a KindDef object");
    }
    const def = body as KindDef;
    if (def.kind === KIND_DEF) {
      throw new RadiaError("reserved_kind", `'${KIND_DEF}' is the built-in meta-kind and cannot be redeclared`);
    }
    validateKindDef(def);
    assertReservedCompatible(def);
    return def;
  }

  private grantDefFromBody(body: unknown): GrantDef {
    if (body === null || typeof body !== "object") {
      throw new RadiaError("invalid_grant", "a grant record body must be a GrantDef object");
    }
    return body as GrantDef;
  }

  /**
   * Reject a grant whose `pattern` could never compile (while the kind is known).
   *
   * A grant pattern is otherwise validated only when it COMPILES AT USE, which is late in a way
   * that matters: a pattern naming a path the kind does not declare is accepted, looks assigned in
   * every listing, and then denies or 400s at the first read. Authorization that appears granted
   * and does nothing is worse than a rejected write.
   *
   * It stays conditional on the kind being registered, because it legitimately may not be: grants
   * are routinely assigned before the kinds they scope exist (an operator bootstraps an agent, the
   * fleet declares its kinds at startup). An unknown kind is therefore not an error here. This
   * catches the mistake it can catch and leaves the rest to use, as before.
   */
  private checkGrantPattern(def: GrantDef): void {
    if (!def.pattern || !this.kinds.get(def.kind)) return;
    try {
      compilePattern({ kind: def.kind, match: def.pattern }, this.kinds.get(def.kind));
    } catch (e) {
      const why = e instanceof RadiaError ? e.message : String(e);
      throw new RadiaError("invalid_grant", `grant pattern does not compile against kind '${def.kind}': ${why}`);
    }
  }

  // ---- authorization + the bootstrap chain (M1 slice; taint + delegation still deferred) ----

  /** The subject grants are checked against: a `run:*` principal inherits its agent definition's
   *  grants (grants flow down the chain), so it authorizes as `agent:<name>`. Everything else
   *  authorizes as itself.
   *
   *  Public because the HTTP layer needs it to answer "is this principal asking about itself?"
   *  A run token asking for its AGENT's permissions is asking about itself, and refusing that is
   *  what left a scoped agent unable to tell an approved grant from a pending one. */
  grantSubject(principal: string): string {
    // Memo only, deliberately, so this stays synchronous on the hot path. Safe because the fact is
    // IMMUTABLE (a run's agent never changes) and because authentication populates it: every
    // request presenting a run token resolves that token first, from records. A miss falls back to
    // the run itself, which holds no grants (fail-closed, never fail-open).
    if (principal.startsWith("run:")) return this.creds.agentForRun(principal) ?? principal;
    return principal;
  }

  /**
   * A privileged principal has operator access: `/ops/*` with every power, grant and signal
   * writes, minting, and any operation without a grant.
   *
   * Membership is a NAMED SET, never a prefix. `human:*` conferred operator authority by name
   * shape, so there was no way to have a person who was merely a user: logging someone in made
   * them an operator, and a console holding their credential held everything. `ctx.operators` says
   * who, and everyone else is ordinary however they are named. The space's own runtime identity
   * stays privileged: it is the in-process plane that unauthenticated dev requests resolve to.
   *
   * The SUPERVISOR is deliberately NOT here (architecture-ops-tiers.md phase 5). It keeps exactly one
   * carve-out, `grant`/`signal` writes in `authorize`, and is otherwise an ordinary principal:
   * grantable ops powers, mintable definitions, no coordination bypass, no purge/declassify. It
   * held the whole bit while ALSO being unmintable (a definition may not name a privileged
   * principal), which made it a fully-privileged principal nobody could authenticate as: the
   * demotion is what makes the role usable at all.
   */
  isPrivileged(principal: string): boolean {
    const subject = this.grantSubject(principal);
    return this.ctx.operators.includes(subject) ||
      subject === this.ctx.runId || subject === this.ctx.principal;
  }

  /**
   * Authorize `principal` to run coordination `op` on records of `kind`. Throws
   * RadiaError("forbidden") if denied. Writing a reserved control kind (grant/signal/agent_*)
   * requires privilege, which means an OPERATOR or the supervisor, not a `human:` name (assigned,
   * never self-declared). Any other principal needs a matching
   * **grant record** (kind-scoped, op-scoped); a run inherits its agent definition's grants.
   *
   * Returns the **pattern constraint** for pattern-scoped grants: `null` when unrestricted
   * (privileged, or at least one matching grant has no pattern), or the list of grant patterns
   * (their union) the request must additionally satisfy. For read/take, callers AND it into the
   * query via `combineMatch` (`grant ∧ request`); for `put`, callers check the record body against
   * it with `bodyMatchesGrant` (write-side scoping: the principal may only write records inside
   * the grant's pattern).
   */
  async authorize(principal: string, op: GrantOp, kind: string): Promise<Record<string, unknown>[] | null> {
    if (this.isPrivileged(principal)) return null;
    const subject = this.grantSubject(principal);
    if ((op === "put" || op === "take") && WRITE_PROTECTED_KINDS.has(kind)) {
      // The supervisor's ENTIRE remaining privilege (architecture-ops-tiers.md phase 5): it assigns
      // grants and writes signals, which is the role's designed purpose, and nothing else rides
      // along. Never `ops_grant` (a power-granter can grant itself powers), never `agent_*`
      // (identity), never `shred`. Its grant-writes remain escalation-adjacent by design, and
      // every one is a RECORD in the audit trail, which is the difference from the bit it lost.
      if (op === "put" && (kind === GRANT || kind === SIGNAL) && subject === this.ctx.supervisor) {
        return null;
      }
      // Name the rule that actually applies. "requires a human principal" was true when every
      // `human:*` was privileged by NAME SHAPE; now an operator is a NAMED principal
      // (`ctx.operators`), so `human:alice` hits this too and being told to be a human is advice
      // that cannot be followed.
      throw new RadiaError(
        "forbidden",
        `writing '${kind}' records requires an operator${kind === GRANT || kind === SIGNAL ? " or the supervisor" : ""}: it is assigned, never self-declared`,
      );
    }
    // Grants are records: query the ones for this (subject, kind) and check the op.
    //
    // ADDITIVE, not latest-wins: a principal may hold several grants on one kind (different
    // operations, different pattern scopes) and they coexist. So a revocation targets one GRANT,
    // identified by its content (`grantKey`), and `activeSet` drops exactly that entry while
    // leaving the others in force. Projecting by (principal, kind) instead would let a single
    // revocation silently take every grant on the kind with it.
    const view = await this.registry(GRANT, grantKey, { principal: subject, kind });
    this.warnIfIncomplete(view, principal, op, kind);
    return this.constraintFrom([...view.entries.values()], principal, op, kind);
  }

  /** The pattern constraint a already-read grant set imposes. Split from the read so `readAccess`
   *  can answer three questions from ONE view; the rule is unchanged. */
  private constraintFrom(
    grants: RadiaRecord[],
    principal: string,
    op: GrantOp,
    kind: string,
  ): Record<string, unknown>[] | null {
    const applicable = grants.filter((g) => {
      const ops = (g.body as Partial<GrantDef>)?.operations;
      return Array.isArray(ops) && ops.includes(op);
    });
    if (applicable.length === 0) {
      throw new RadiaError("forbidden", `principal '${principal}' has no '${op}' grant for kind '${kind}'`);
    }
    const patterns: Record<string, unknown>[] = [];
    for (const g of applicable) {
      const t = (g.body as GrantDef).pattern;
      if (!t || Object.keys(t).length === 0) return null; // an unrestricted grant widens to the whole kind
      patterns.push(t);
    }
    return patterns; // constrained: request must additionally match one of these
  }

  /**
   * The author restriction a principal's grants impose on READS of `kind`, or `undefined` for none.
   *
   * A self-scoped grant (`scope: {createdBy: "self"}`) has to narrow the coordination plane too,
   * not only the ops plane. Otherwise approving "its own records of that kind" hands over every
   * record of that kind through `query`, which is the plane an agent actually reads records
   * through. The gap is not hypothetical: a session granted self-scoped `message` access sees its
   * own records in `ops/stats` and every author's through `query`.
   *
   * Applied only when EVERY applicable grant is self-scoped. Grants union (a record is readable if
   * any grant permits it), so one unscoped grant already permits other authors' records, and
   * filtering by author would then deny something granted. Mixed sets therefore keep today's
   * behaviour, which is the permissive-but-consistent reading of a union.
   */
  async authorScope(principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
    if (this.isPrivileged(principal)) return undefined;
    const subject = this.grantSubject(principal);
    // Only grants that permit THIS operation are relevant. A `put`-only grant says nothing about
    // reads, and counting it as "an unscoped grant on this kind" lifts the read restriction the
    // moment a read grant is narrowed while the write grant stays as it was.
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject, kind })).entries.values()];
    if (!this.selfScoped(grants, op)) return undefined;
    return await this.runPrincipalsOf(subject, principal);
  }

  /** Do ALL the grants permitting `op` carry `scope: {createdBy: "self"}`? Split from the read so
   *  `readAccess` can answer from one view. */
  private selfScoped(grants: RadiaRecord[], op: GrantOp): boolean {
    const applicable = (grants.map((g) => g.body as GrantDef & { scope?: { createdBy?: string } }))
      .filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
    return applicable.length > 0 && applicable.every((g) => g.scope?.createdBy === "self");
  }

  /**
   * Does this principal's own grants bar it from claiming TAINTED records of `kind`?
   *
   * A caller's own `allowTaint` is a courtesy the worker pays: a worker that omits it receives
   * tainted work normally, so containment depended on every claimant opting in. That is a
   * convention, not a control. A grant carrying `scope: {taint: …}` moves the barrier to the
   * side that assigns authority, where an operator can impose it.
   *
   * Applied only when EVERY applicable grant carries it, the same rule `authorScope` uses and for
   * the same reason: grants UNION, so one grant without the barrier already permits tainted work,
   * and enforcing it anyway would deny something that was granted.
   */
  async taintBarrier(principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
    if (this.isPrivileged(principal)) return undefined; // no grants to read, so no barrier to impose
    const subject = this.grantSubject(principal);
    const view = await this.registry(GRANT, grantKey, { principal: subject, kind });
    return this.barrierFrom([...view.entries.values()], op);
  }

  /** The allowlist an already-read grant set imposes. Split from the read so `readAccess` can
   *  answer from one view. */
  private barrierFrom(grants: RadiaRecord[], op: GrantOp): string[] | undefined {
    const applicable = (grants.map((g) => g.body as GrantDef & { scope?: Record<string, string> }))
      .filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
    // Every applicable grant must state a barrier, or one that does not already permits the claim
    // (grants UNION). When they all do, the effective allowlist is their UNION for the same reason:
    // "these grants together permit" is a widening, and reading it as an intersection would make
    // adding a grant narrow a principal's reach, which is not what a grant is.
    if (applicable.length === 0 || !applicable.every((g) => typeof g.scope?.taint === "string")) return undefined;
    const allowed = new Set<string>();
    for (const g of applicable) for (const l of parseTaintAllowlist(g.scope!.taint!)) allowed.add(l);
    return [...allowed].sort();
  }

  /**
   * Everything a READ of `kind` is allowed to see: the pattern constraint AND the author
   * restriction, in one answer.
   *
   * Both halves are needed on every read verb, and asking for them separately is how they drift.
   * `take`, lineage, graph and the artifact reads each authorized on the pattern and silently
   * skipped the author scope, so a self-scoped grant returned other principals' records through
   * them while `query` correctly returned none. Never call `authorize` alone on a read path; call
   * this, and apply both fields.
   */
  async readAccess(principal: string, op: GrantOp, kind: string): Promise<ReadAccess> {
    // ONE registry read for all three answers. Asking separately cost four storage reads per
    // coordination verb — the `grant` registry paged to exhaustion three times over, once per
    // question, plus the `agent_run` read behind a self scope — for three views of the same set.
    if (this.isPrivileged(principal)) return { constraint: null, createdBy: undefined, allowTaint: undefined };
    const subject = this.grantSubject(principal);
    const view = await this.registry(GRANT, grantKey, { principal: subject, kind });
    this.warnIfIncomplete(view, principal, op, kind);
    const grants = [...view.entries.values()];
    const constraint = this.constraintFrom(grants, principal, op, kind);
    const createdBy = this.selfScoped(grants, op) ? await this.runPrincipalsOf(subject, principal) : undefined;
    return { constraint, createdBy, allowTaint: this.barrierFrom(grants, op) };
  }

  /**
   * A truncated grant view decided this. Say so.
   *
   * `readRegistry` reports `complete: false` when it hits its page budget rather than returning a
   * plausible prefix, and every authorization path took `.entries` and never looked. Truncation is
   * fail-CLOSED here — reads are newest-first, so a retirement is inside the window while what it
   * retires may be outside, and the entry drops out either way — so the cost is silence rather than
   * misauthorization: a principal is denied and nothing says the answer was computed from part of
   * its grants. Content-keyed grant writes make >20k records for one (principal, kind) implausible,
   * which is why this warns rather than throws.
   */
  private warnIfIncomplete(view: RegistryView, principal: string, op: GrantOp, kind: string): void {
    if (view.complete) return;
    console.warn(
      `[radia] grant view for '${principal}' (${op} on '${kind}') is INCOMPLETE after ${view.scanned} records; ` +
        `this decision was computed from part of its grants`,
    );
  }

  /** Does `record` fall inside an author restriction? `undefined` restriction means unrestricted. */
  authorAllows(createdBy: string[] | undefined, record: { runtimeMeta: { createdBy: string } }): boolean {
    return !createdBy || createdBy.includes(record.runtimeMeta.createdBy);
  }

  /**
   * Every principal whose records count as "mine": the agent itself, the presented principal, and
   * the agent's RUNS (all of them, including runs that have since stopped or expired).
   *
   * This is deliberately a different question from authentication, which asks only about
   * credentials that can still be PRESENTED. A self scope needs the opposite: the historical run
   * principals an agent wrote records under, or "what did I create" silently shrinks as the space
   * ages and old runs stop mattering to the auth path. `agent` is a declared
   * indexed path on `agent_run`, so this is one indexed query per authorization rather than a scan.
   */
  private async runPrincipalsOf(subject: string, principal: string): Promise<string[]> {
    // PAGED TO EXHAUSTION, never a bounded `query(kind, N)`. `agent_run` grows by one record per
    // mint plus one per stop, and a live run re-mints before expiry, so a long-lived agent passes
    // any fixed limit, and the records that fall off a newest-first page are its OLDEST runs. This
    // list is what `take`, lineage, graph, artifact bytes and watch wakeups narrow to, so a
    // truncated one does not merely hide old history: the agent's own older records become
    // unclaimable, and `rankClaimable` skips them silently, indistinguishable from an empty queue.
    //
    // One entry per run (a stop is a successor carrying the same `run`), so the projection key is
    // the run id.
    const view = await this.registry<{ run?: unknown }>(
      AGENT_RUN,
      (b) => (typeof b?.run === "string" ? b.run : undefined),
      { agent: subject },
    );
    if (!view.complete) {
      // Refusing loudly beats narrowing silently: an incomplete list denies the agent its own
      // records, which reads as work vanishing rather than as an authorization fault.
      throw new RadiaError(
        "registry_incomplete",
        `could not read all runs of '${subject}' (${view.scanned} scanned); refusing to compute a ` +
          `self scope from a partial list, which would silently hide the agent's own records`,
      );
    }
    return [...new Set([...view.entries.keys(), subject, principal])];
  }

  /**
   * What a principal can actually do, computed once and shown, rather than only ever recomputed
   * inside a decision nobody can see.
   *
   * Effective permission here is a FOLD over an unbounded record set: union across grants, per
   * operation, self-scope only when every applicable grant is scoped, retirement applied after
   * newest-per-key. That is four rules interacting, and every grant bug so far has been the same
   * shape: the promise made to a human did not match the enforcement, and there was no way to look.
   * This is the way to look. Use it before and after changing a principal's grants; the difference
   * is the answer to "did that do what I said it would".
   */
  async effectivePermissions(principal: string): Promise<EffectivePermissions> {
    const subject = this.grantSubject(principal);
    if (this.isPrivileged(principal)) {
      return {
        principal,
        subject,
        privileged: true,
        kinds: [],
        ops: { reachable: true, kinds: [] },
        opsPowers: [...OPS_POWERS],
        complete: true,
      };
    }
    const view = await this.registry(GRANT, grantKey, { principal: subject });
    const byKind = new Map<string, { kind: string; operations: GrantOp[]; scoped: boolean; unscoped: boolean; opsEligible: boolean; patterns: Record<string, unknown>[] }>();
    for (const rec of view.entries.values()) {
      const g = rec.body as GrantDef & { scope?: { createdBy?: string } };
      if (typeof g.kind !== "string" || !Array.isArray(g.operations)) continue;
      const row = byKind.get(g.kind) ??
        { kind: g.kind, operations: [], scoped: false, unscoped: false, opsEligible: false, patterns: [] };
      for (const op of g.operations) if (!row.operations.includes(op)) row.operations.push(op);
      if (g.scope?.createdBy === "self") row.scoped = true;
      else row.unscoped = true;
      // Ops reachability is a property of a SINGLE grant carrying both the read op and the self
      // scope, never of the union across grants. `opsScope` asks it that way, so asking it any
      // other way here reports a plane the caller is then refused.
      if (g.scope?.createdBy === "self" && g.operations.includes("query")) row.opsEligible = true;
      if (g.pattern && Object.keys(g.pattern).length > 0) row.patterns.push(g.pattern);
      byKind.set(g.kind, row);
    }
    // The ops plane is reachable for kinds holding ONE grant that is both a `query` grant and
    // self-scoped, which is the rule `opsScope` enforces. ORing `scoped` against the union of
    // operations instead reports `{put, self-scoped}` beside `{query, unscoped}` as reachable, and
    // `opsScope` then throws `forbidden` for it.
    const opsKinds = [...byKind.values()].filter((r) => r.opsEligible).map((r) => r.kind);
    const kinds = [];
    for (const r of [...byKind.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1))) {
      kinds.push({
        kind: r.kind,
        operations: [...r.operations].sort(),
        // A grant naming a kind that does not exist is the shape a guessing agent produces: one
        // asked for `space_event` (the name of a TOOL), had it approved, and then read its own
        // scope line as evidence of access it did not have. The grant is honoured as written (kinds
        // may be declared later), and said to be empty.
        ...(this.kinds.get(r.kind) ? {} : { kindNotDeclared: true as const }),
        // Asked of `authorScope` rather than recomputed here. Never restate the rule: a
        // restatement aggregates scoped/unscoped across ALL grants on the kind, while enforcement
        // considers only grants permitting THAT OPERATION, so a scoped `query` beside an unscoped
        // `put` reads as unscoped. A view that can drift from the decision is worse than no view,
        // because it is believed.
        readsScopedToSelf: (await this.authorScope(principal, "query", r.kind)) !== undefined,
        patterns: r.patterns,
      });
    }
    return {
      principal,
      subject,
      privileged: false,
      kinds,
      ops: { reachable: opsKinds.length > 0, kinds: opsKinds.sort() },
      opsPowers: [...await this.opsPowers(principal)].sort(),
      complete: view.complete,
    };
  }

  /**
   * Authorize a watch on `kind`. A watch OBSERVES matching records (its SSE payload is record
   * existence + ids + kind + timing), so it is allowed if the principal holds ANY grant on the kind
   * (it is a participant), regardless of op (a watcher may hold only `take`, like the agentLoop, or
   * only `read_one`, like a result consumer). Returns the UNION of those grants' patterns to AND
   * into the watch match (`null` = unrestricted / privileged), so a watcher only wakes on records
   * inside its grant scope, the same content-scoping `query`/`take` get. Throws `forbidden` if the
   * principal has no grant for the kind (closing the last unguarded coordination verb).
   */
  async authorizeWatch(principal: string, kind: string): Promise<ReadAccess> {
    if (this.isPrivileged(principal)) return { constraint: null };
    const subject = this.grantSubject(principal);
    // Retracted grants are subtracted here too. A watch observes records, so a revocation that
    // stopped `query` but left `watch` standing would revoke nothing that matters.
    const grants = [...(await this.registry(GRANT, grantKey, { principal: subject, kind })).entries.values()]
      .map((g) => g.body as GrantDef & { scope?: { createdBy?: string } });
    if (grants.length === 0) {
      throw new RadiaError("forbidden", `principal '${principal}' has no grant to watch kind '${kind}'`);
    }
    // A self scope narrows a watch for the same reason it narrows `query`: otherwise approving
    // "its own records" streams every author's record ids, kinds and activity timing on the kind.
    // Applied only when EVERY grant on the kind is self-scoped, matching `authorScope`. Grants
    // union, so one unscoped grant already permits observing other authors.
    const createdBy = grants.every((g) => g.scope?.createdBy === "self")
      ? await this.runPrincipalsOf(subject, principal)
      : undefined;
    const patterns: Record<string, unknown>[] = [];
    for (const g of grants) {
      const t = g.pattern;
      if (!t || Object.keys(t).length === 0) return { constraint: null, createdBy }; // unrestricted widens to the kind
      patterns.push(t);
    }
    return { constraint: patterns, createdBy };
  }

  /** Write-side pattern scoping: does `body` (of `kind`) satisfy at least one grant `pattern`?
   *  A pattern-scoped `put` grant lets a principal write only records inside its pattern (the
   *  union across grants). Compiles each pattern against the kind (so its paths must be declared
   *  indexed, same as read-side) and evaluates the body with the matching oracle. */
  bodyMatchesGrant(kind: string, body: unknown, patterns: Record<string, unknown>[]): boolean {
    return patterns.some((t) => {
      try {
        return matchesRecord({ kind, body } as RadiaRecord, this.compile({ kind, match: t }));
      } catch {
        return false; // an uncompilable grant pattern (e.g. undeclared path) grants nothing
      }
    });
  }

  /**
   * Derive the `delegation_context` for work emitted under a lease owned by `owner`. The authority
   * comes from the CLAIMED LEASE: `owner` (the record's authoritative `lease_owner`) → its agent
   * (`grantSubject`), extending the leased record's own chain. INVARIANT: never derived from
   * `parent_ids` (data parents grant nothing). Returns undefined for operator/root-owned leases
   * (privileged): such work carries full authority and no delegation record. The chain is an
   * audit/authority record; full chain-intersection enforcement composes with taint (M3).
   */
  private async deriveDelegation(owner: string, leasedRecordId: string): Promise<DelegationContext | undefined> {
    if (this.isPrivileged(owner)) return undefined; // root/operator work is not delegated
    const actor = this.grantSubject(owner); // the agent behind the run; grants live here
    const parent = await this.storage.getRecord(leasedRecordId);
    const parentChain = parent?.runtimeMeta.delegationContext?.chain ?? [];
    return { chain: [...parentChain, actor], origin: leasedRecordId };
  }

  /** Server-computed taint for a new record: `true` if the client raised it (source attestation)
   *  or ANY data parent is tainted. Taint propagates along data lineage only; clearing needs a
   *  privileged declassify (`Space.declassify`). Never lowered by a client. */
  /**
   * The labels a new record carries: the UNION of every data parent's, plus whatever the client
   * raised, plus `foreign` when a parent was written by somebody else.
   *
   * Union rather than OR, which is the whole point of labels: a barrier tests WHICH classification
   * a record carries, and an OR collapses every source into one bit that saturates after the first
   * tool call. The laundering caveat is unchanged and unchangeable here: a caller that omits a
   * parent edge omits its labels, because this reads the edges it was given.
   *
   * `foreign` costs nothing extra: the parents are already being fetched to read their labels.
   */
  private async computeTaint(
    parentIds: string[],
    clientRaise: string[] | undefined,
    writer: string,
  ): Promise<string[]> {
    // A RAISE may name the reserved label (see `clientTaint`): it only restricts the writer's
    // own record. The allowlist direction is where it is refused.
    const labels = new Set<string>(normalizeTaint(clientRaise, { reserved: true }));
    for (const pid of parentIds) {
      const p = await this.storage.getRecord(pid);
      if (!p) continue;
      for (const l of p.runtimeMeta.taint) labels.add(l);
      // Derived from another principal's record. Compared on the grant SUBJECT, so a run and the
      // agent it instantiates are the same author and a worker does not taint its own lineage.
      if (this.grantSubject(p.runtimeMeta.createdBy) !== this.grantSubject(writer)) labels.add("foreign");
    }
    return [...labels].sort();
  }

  /**
   * Create an agent definition (operator action): store an `agent_definition` record holding the
   * sha256 of a freshly minted **definition token**, optionally assign its grants, and return the
   * token once. The definition token mints runs (`mintRun`); it is never stored in plaintext.
   */
  async createAgentDefinition(agent: string, grants: GrantDef[] = []): Promise<{ agent: string; definitionToken: string }> {
    // `human:` is allowed so a PERSON can hold ordinary scoped grants and log in as themselves.
    // They are not an operator unless `ctx.operators` names them; see `isPrivileged`.
    if (!agent.startsWith("agent:") && !agent.startsWith("human:")) {
      throw new RadiaError("invalid_principal", "a definition principal must start with 'agent:' or 'human:'");
    }
    // A definition mints run tokens for its subject, so a definition NAMING a privileged principal
    // is a minting credential for privilege. Refused here rather than handled downstream: the
    // operator set and the supervisor are the two identities whose authority is not expressed as
    // grants, so nothing later in the chain narrows what such a run could do.
    if (this.isPrivileged(agent)) {
      throw new RadiaError(
        "invalid_principal",
        `'${agent}' is a privileged principal (an operator or the supervisor); a definition for it ` +
          `would be a permanent way to mint privileged runs. Name an ordinary principal and grant it ` +
          `what it needs.`,
      );
    }
    const { token, hash } = await mintCredential();
    await this.putRaw({ kind: AGENT_DEFINITION, body: { agent, tokenHash: hash } });
    for (const g of grants) {
      validateGrantDef(g);
      this.checkGrantPattern(g);
    }
    // One registry read per principal named here, taken BEFORE any write and reused for both the
    // revival check and the supersede. Never read it per grant inside the loop: superseding as
    // each grant lands makes grant N retire grant N-1 of the same (principal, kind, operations),
    // so a definition silently cannot declare two scopes at once.
    const views = new Map<string, RegistryView>();
    for (const p of new Set(grants.map((g) => g.principal))) {
      const view = await this.registry(GRANT, grantKey, { principal: p });
      if (!view.complete) {
        throw new RadiaError(
          "registry_incomplete",
          `could not read all grants for '${p}'; refusing to supersede on a partial view`,
        );
      }
      views.set(p, view);
    }
    for (const g of grants) {
      const key = grantKey(g) ?? "";
      // CONTENT-KEYED, so re-defining an agent with the same grants writes nothing new. Without
      // this, every bootstrap appended a fresh record per grant and a long-lived principal
      // accumulated hundreds. Those then outran the bounded page every authorization read takes,
      // silently. Unlike a worker republishing a capability, this key does dedup across restarts:
      // agent definitions are an OPERATOR action, and an idempotency key is scoped to the durable
      // identity behind the acting principal, which here is the operator itself.
      //
      // REVIVING a retired grant therefore needs a key that differs from the record being revived,
      // or the write is an idempotent replay of it and the retirement stays newest. That is a
      // LOCKOUT, not a lost update: the supersede below still retires whatever is live, so the
      // principal ends with no grant at all and `createAgentDefinition` reports success.
      const prior = views.get(g.principal)?.newest.get(key);
      const revives = prior !== undefined && isRetired(prior.body);
      const idem = `grant:${await sha256Hex(key)}${revives ? `:after:${prior.id}` : ""}`;
      await this.putRaw({ kind: GRANT, body: g }, idem);
    }
    await this.supersedeGrantsFor(grants, views);
    this.notifier.notify();
    return { agent, definitionToken: token };
  }

  /**
   * Make an agent definition AUTHORITATIVE for the exact grants it declares.
   *
   * A grant's identity includes its pattern, so declaring a differently-scoped version of an
   * existing grant creates a SECOND grant rather than replacing the first, and grants union, so
   * the new one changes nothing. Every live grant on the same (principal, kind, operations) whose
   * pattern differs from the declared one is therefore retired here.
   *
   * This covers both ways it bites: adding a pattern beside an unpatterned grant (tightening an
   * existing space), and REPLACING one pattern with another (switching a session's scope from one
   * binding to another). Without the retire, both silently do nothing: the two grants union and
   * the wider view wins.
   *
   * Bounded to the triple it declares, deliberately. Different operations or a different kind are
   * left alone, because an agent definition speaks for the grants IT declares and not for every
   * grant the principal holds. Otherwise each restart would quietly revoke what a person approved.
   * Note `scope` is absent from `grantKey` on purpose, so a self-scoped grant already replaces its
   * unscoped twin in place. Never include it in the filter below: the declared grant shares a key
   * with the live one, so it would retire the grant it just wrote.
   *
   * Takes the WHOLE declared set, never one grant at a time, so grants declared together do not
   * retire each other. A definition may legitimately declare two patterns on one triple, and
   * `authorize` unions them.
   */
  private async supersedeGrantsFor(declared: GrantDef[], views: Map<string, RegistryView>): Promise<void> {
    const sameOps = (a: unknown[] = [], b: unknown[] = []) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const declaredKeys = new Set(declared.map((g) => grantKey(g)));
    // Collected by record id, so a triple declared twice retires each stale record once.
    const stale = new Map<string, RadiaRecord>();
    for (const g of declared) {
      for (const rec of views.get(g.principal)?.entries.values() ?? []) {
        const body = rec.body as GrantDef;
        if (body.kind !== g.kind || !sameOps(body.operations, g.operations)) continue;
        if (declaredKeys.has(grantKey(body))) continue;
        stale.set(rec.id, rec);
      }
    }
    for (const rec of stale.values()) {
      const body = rec.body as GrantDef;
      // Keyed on the RECORD being retired, not on the grant identity alone: one key per identity
      // means a grant can be retired only ONCE, ever, so a later re-grant of the same content
      // would survive the next supersede and stay live: silent misauthorization, widening.
      await this.putRaw(
        { kind: GRANT, body: { ...body, retired: true } },
        `grant-retire:${await sha256Hex(grantKey(body) ?? "")}:after:${rec.id}`,
      );
    }
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
    // `mintedAt` is what bounds renewal: it is copied onto every successor, so the absolute deadline
    // is a property of the RUN and cannot be pushed forward by renewing.
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now } });
    this.creds.rememberRun(run, agent);
    this.notifier.notify();
    return { run, agent, runToken: token, expiresAt };
  }

  /**
   * Extend a live run's expiry, presenting its own token.
   *
   * Run tokens are deliberately short (15 min), which is right for a leaked one and wrong for a
   * session someone is sitting in front of: the chat simply died mid-conversation, and the worker
   * fleet died with it. Renewal is the same successor-record shape as `stopRun`: a new `agent_run`
   * carrying the SAME tokenHash and a later `expiresAt`, so resolution (newest record per hash)
   * picks it up through the one indexed lookup it already does, and the token in the holder's hand
   * keeps working.
   *
   * Three things bound it, and all three matter:
   *   - a STOPPED run cannot be revived, so revocation still wins;
   *   - renewal never extends past `mintedAt + runMaxLifetimeSeconds`, so a leaked token still dies
   *     on a fixed schedule and the holder has to authenticate again to get past it;
   *   - it renews the run it is CALLED WITH, so a token cannot extend somebody else's session.
   */
  async renewRun(run: string): Promise<{ run: string; agent: string; expiresAt: string; maxLifetimeAt: string }> {
    const now = await this.storage.now();
    const rows = await this.query({ kind: AGENT_RUN, match: { run } }, 5, { dir: "desc" });
    const bodies = rows.map((r) => r.body as { agent?: string; tokenHash?: string; status?: string; mintedAt?: string });
    if (bodies.length === 0) throw new RadiaError("not_found", `no run ${run}`);
    if (bodies[0]?.status === "stopped") throw new RadiaError("run_stopped", `run ${run} was stopped`);
    const agent = bodies.find((b) => b.agent)?.agent;
    const tokenHash = bodies.find((b) => b.tokenHash)?.tokenHash;
    if (!agent || !tokenHash) throw new RadiaError("not_found", `no run ${run}`);
    // A run minted before `mintedAt` existed has no recorded start. Treat NOW as the start rather
    // than as unbounded: an unknown age must not read as a fresh one.
    const mintedAt = bodies.find((b) => b.mintedAt)?.mintedAt ?? now;
    const maxLifetimeAt = addSeconds(mintedAt, this.ctx.runMaxLifetimeSeconds);
    if (maxLifetimeAt <= now) {
      throw new RadiaError(
        "run_lifetime_exceeded",
        `run ${run} reached its maximum lifetime at ${maxLifetimeAt}; mint a new run`,
      );
    }
    // Never past the ceiling: the last renewal before it lands exactly on it.
    const window = addSeconds(now, this.ctx.runTokenSeconds);
    const expiresAt = window > maxLifetimeAt ? maxLifetimeAt : window;
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash, status: "active", expiresAt, mintedAt } });
    this.notifier.notify();
    return { run, agent, expiresAt, maxLifetimeAt };
  }

  /**
   * Stop a run: emit a successor `agent_run` record (status stopped) and invalidate its token so
   * no new operations resolve. Default (graceful) revocation leaves held leases to expire on
   * their own clocks. `quarantine: true` is emergency revocation: it additionally force-releases
   * the run's in-flight leases now (epoch-bumped, so a late ack/renew fences out as `lease_lost`).
   */
  async stopRun(run: string, opts: { quarantine?: boolean } = {}): Promise<{ applied: boolean; quarantined: number }> {
    // Looked up in the SPACE, never in a cache. Consulting an in-memory index here makes stopping
    // a run this process has not seen (another instance's run, or one written before a restart)
    // silently report `applied: false` and leave the token working.
    const mint = await this.runRecord(run);
    if (!mint?.agent) return { applied: false, quarantined: 0 };
    // The successor carries the SAME tokenHash as the mint, so resolving that token finds the stop
    // in the one indexed lookup it already does. Without it, a token-hash lookup could only ever
    // see the mint, and revocation depended on a second lookup nobody was guaranteed to make.
    //
    // WRITTEN FIRST, before any quarantine. The reverse order left a window where the run's leases
    // were force-released while its token still resolved, so it could claim fresh work on its way
    // out — and if the write then threw, that window never closed. Ordered this way the partial
    // failure is the SAFE one: the token is dead and the leases expire on their own clocks, which
    // is exactly what a graceful stop already does.
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
    let quarantined = 0;
    if (opts.quarantine) {
      const now = await this.storage.now();
      quarantined = await this.storage.quarantineLeasesOf(run, now);
    }
    this.notifier.notify();
    return { applied: true, quarantined };
  }

  /** Mint an operator token: no expiry, and it resolves to the SPACE'S OWN principal
   *  (`SpaceContext.principal`, `local:dev` by default), which `isPrivileged` covers. Not
   *  `human:local` — that is the named operator in `ctx.operators`, a different principal that a
   *  person can hold. Not a record either: a server-lifetime bootstrap credential, re-minted at
   *  startup, which is why it cannot be revoked and does not need to be. */
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
   * so this is an indexed lookup, not a scan. And because a stop successor carries the same hash,
   * the newest record for that hash IS the current state of the credential.
   */
  private async resolveCredential(token: string, now: string): Promise<ResolvedToken> {
    const hash = await hashToken(token);
    // Operator tokens are process-lifetime and never records (a credential is needed before any
    // agent exists), so they are the one thing answered from memory. They resolve to the space's
    // own principal: presenting the provisioned credential is exactly as authorized as presenting
    // no header at all in open mode. Never resolve one as `def`: that would let it mint a run,
    // turning a leaked operator token into a durable one.
    if (this.creds.isOperator(hash)) return { ok: true, kind: "operator", principal: this.ctx.principal };
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

    // Symmetric with the run branch above, and it was not: a definition used to authenticate on the
    // existence of a record alone. `newestByHash` already returns the newest record carrying this
    // hash, so a revocation successor lands here with no extra read.
    const def = await this.newestByHash(AGENT_DEFINITION, hash) as
      | { agent?: string; status?: string }
      | undefined;
    if (!def?.agent) return { ok: false, reason: "invalid_token" };
    if (def.status === "revoked") return { ok: false, reason: "definition_revoked" };
    return { ok: true, kind: "def", agent: def.agent };
  }

  /** The newest record of `kind` carrying this token hash. That is the current state of that
   *  credential, because a stop is written as a successor with the same hash. */
  private async newestByHash(kind: string, tokenHash: string): Promise<unknown | undefined> {
    const rows = await this.query({ kind, match: { tokenHash } }, 1, { dir: "desc" });
    return rows[0]?.body;
  }

  /** The mint record for a run (newest wins, so a stopped run reports its stop). */
  /**
   * Revoke a definition: its token stops minting runs, permanently.
   *
   * The one credential that had no off switch. `agent_run` has carried `status: "stopped"` since
   * the bootstrap chain shipped and `resolveCredential` checks it, but the definition branch two
   * lines below returned `{ok: true}` on the mere EXISTENCE of a record — no status, no expiry, no
   * retirement — so a leaked definition token minted fresh run tokens forever. Rotating the subject
   * was not a remedy either: the old definition kept working alongside the new one.
   *
   * Deliberately identical in shape to `stopRun`, because the property that makes that one correct
   * is the one that matters here: the successor carries the SAME `tokenHash` as the mint, so
   * resolving the token finds the revocation in the single indexed lookup it already performs.
   * A revocation recorded anywhere else depends on a second lookup nobody is guaranteed to make.
   *
   * Existing RUNS are untouched. They are separately revocable (`stopRun`), they expire on their
   * own, and conflating the two would make "stop handing out new authority" mean "kill the work in
   * flight" — different decisions with different blast radii. Revoke, then stop the runs that
   * matter, in that order.
   */
  async revokeDefinition(agent: string, opts: { reason?: string } = {}): Promise<{ applied: boolean; alreadyRevoked: boolean }> {
    // Read from the SPACE, never a cache: revoking a definition this process has not seen (another
    // instance's, or one written before a restart) must not silently report `applied: false` and
    // leave the token minting.
    const def = await this.definitionRecord(agent);
    if (!def?.tokenHash) return { applied: false, alreadyRevoked: false };
    if (def.status === "revoked") return { applied: true, alreadyRevoked: true };
    await this.putRaw({
      kind: AGENT_DEFINITION,
      body: {
        agent,
        tokenHash: def.tokenHash,
        status: "revoked",
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });
    this.notifier.notify();
    return { applied: true, alreadyRevoked: false };
  }

  /** The current state of a definition, folded over its successors the way `runRecord` folds a run's. */
  private async definitionRecord(agent: string): Promise<{ tokenHash?: string; status?: string } | undefined> {
    const rows = await this.query({ kind: AGENT_DEFINITION, match: { agent } }, 5, { dir: "desc" });
    const bodies = rows.map((r) => r.body as { tokenHash?: string; status?: string });
    if (bodies.length === 0) return undefined;
    return { tokenHash: bodies.find((b) => b.tokenHash)?.tokenHash, status: bodies[0]?.status };
  }

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
    const declared = this.validateReservedBody(req); // throws RadiaError before anything commits
    if (req.kind === INTEREST) await this.checkInterestBudget(req, principal);
    const id = await this.putRaw(req, idempotencyKey, { principal });
    if (declared) await this.adoptKind(declared); // also on idempotent replay
    return id;
  }

  /**
   * Pre-commit validation of a body the RUNTIME reads back, shared by the two ways a record enters
   * the space: `put` and an `ack` result. Returns the declaration when the write IS a kind
   * declaration, so the caller adopts it only once the commit succeeded.
   *
   * Shared rather than duplicated because it was duplicated in exactly one of the two places. An
   * `ack` emitting `kind_def` skipped every check here, so a result body could register a kind the
   * same body would be refused for on `put`. The general shape of this class of bug is a second
   * write path that grew after the first one learned a rule.
   */
  private validateReservedBody(req: PutRequest): KindDef | undefined {
    // A kind_def record IS a kind declaration: validate its body as a KindDef before commit,
    // so the substrate coordinates its own schema through the normal write path (no side table).
    if (req.kind === KIND_DEF) return this.kindDefFromBody(req.body);
    // A grant record IS an authorization grant: validate its body before commit. Write-protection
    // (that only a privileged principal may put one) is enforced at the API boundary.
    if (req.kind === GRANT) {
      const def = this.grantDefFromBody(req.body);
      validateGrantDef(def);
      this.checkGrantPattern(def);
    }
    // An ops_grant IS an ops-plane power assignment (architecture-ops-tiers.md). Two refusals beyond the
    // shape check: a privileged principal already holds every power, so granting it one only
    // manufactures a record that looks load-bearing and is not; and the vocabulary is closed at
    // validate (identity and grant writes are never a power).
    if (req.kind === OPS_GRANT) {
      const def = req.body as OpsGrantDef;
      validateOpsGrantDef(def);
      if (this.isPrivileged(def.principal)) {
        throw new RadiaError(
          "invalid_ops_grant",
          `'${def.principal}' is privileged and already holds every ops power; an ops_grant may not name it`,
        );
      }
    }
    return undefined;
  }

  /**
   * Cap how many DISTINCT interests one principal may register.
   *
   * The interest registry is read per candidate in the dry-run matcher and per kind in the
   * orphan/starving split, so an unbounded one turns two inspection reads into a scan of somebody
   * else's mistake. Content-keyed, so a worker republishing the same pattern on every restart costs
   * nothing; what this bounds is a worker generating a NEW pattern each time, which is the shape
   * that grows without limit.
   *
   * Counted per kind, since that is the granularity the registry is read at.
   */
  private async checkInterestBudget(req: PutRequest, principal?: string): Promise<void> {
    const b = (req.body ?? {}) as { kind?: unknown; match?: unknown; retired?: unknown };
    if (typeof b.kind !== "string" || b.retired === true) return; // withdrawal always allowed
    const who = principal ?? this.ctx.principal;
    // AUTHOR-SCOPED at the storage layer (`created_by` is a column), because only the caller's own
    // entries decide its ceiling. This used to project every interest in the space and ask each
    // one's run whether it was alive — seconds per publish on a lived-in space, paid once per
    // pattern by every starting worker, to compute a filter that keeps at most 32 rows. Sound
    // because the projection key BEGINS with the author, so restricting the read to one author can
    // neither merge nor split entries; and the caller's own liveness needs no lookup — it is
    // performing this write.
    const view = await this.registry<{ kind?: unknown; match?: unknown }>(
      INTEREST,
      (ib, rec) =>
        typeof ib?.kind === "string" ? `${rec.runtimeMeta.createdBy}|${ib.kind}|${JSON.stringify(ib.match ?? null)}` : undefined,
      { kind: b.kind },
      { createdBy: [who] },
    );
    if (!view.complete) {
      // Cannot happen for a set the ceiling itself bounds, unless the ceiling was already blown by
      // another path — in which case enforcing over a prefix would be the bounded-read trap at the
      // one site that exists to prevent registry blowup.
      throw new RadiaError("registry_incomplete", `interest registry read for '${who}' did not complete`);
    }
    const mine = [...view.entries.values()];
    if (mine.length < this.ctx.maxInterestsPerPrincipal) return;
    // Already registered? Re-publishing is a no-op at the registry, so it must not be refused: a
    // worker at the ceiling would otherwise fail to restart.
    const wanted = JSON.stringify(b.match ?? null);
    if (mine.some((r) => JSON.stringify((r.body as { match?: unknown }).match ?? null) === wanted)) return;
    throw new RadiaError(
      "too_many_interests",
      `principal '${who}' already registers ${mine.length} interests on kind '${b.kind}' (limit ` +
        `${this.ctx.maxInterestsPerPrincipal}). Retire the ones it no longer listens for; a worker ` +
        `that needs a new pattern per record is describing a query, not an interest`,
    );
  }

  /** Reflect a committed declaration in THIS process's registry (other instances re-read it
   *  through `compileFresh`). */
  private async adoptKind(def: KindDef): Promise<void> {
    this.kinds.register(def);
    await this.prepareStorageFor(def);
  }

  private async putRaw(
    req: PutRequest,
    idempotencyKey?: string,
    opts: { taint?: string[]; principal?: string; event?: { operation?: string; detail?: Record<string, unknown> } } = {},
  ): Promise<{ id: string }> {
    const now = await this.storage.now(); // INVARIANT: timestamps come from the DB clock
    // Taint is server-computed data lineage: forced by opts (declassify), else client-raise OR
    // any data parent tainted. A client can only RAISE taint; clearing needs a privileged declassify.
    const writer = opts.principal ?? this.ctx.principal;
    const taint = opts.taint !== undefined
      ? normalizeTaint(opts.taint, { reserved: true }) // declassify's remainder: server-computed
      : await this.computeTaint(req.parentIds ?? [], req.taint, writer);
    // The kind's default retention, MATERIALIZED here at commit — never evaluated at sweep time.
    // Materializing keeps every record self-describing and makes a later redeclaration change only
    // future records' fate; a default consulted at sweep time would turn a kind_def redeclare into
    // a mass-deletion instrument over records already written. An explicit stamp always wins.
    let retentionUntil = req.retentionUntil;
    if (retentionUntil === undefined) {
      const seconds = this.kinds.get(req.kind)?.defaultRetentionSeconds;
      if (seconds) retentionUntil = addSeconds(now, seconds);
    }
    const { record, bodyJson } = await buildRecord({ ...req, retentionUntil }, {
      principal: opts.principal ?? this.ctx.principal, // created_by = the resolved caller
      schemaVersion: this.ctx.schemaVersion,
      maxRecordBytes: this.ctx.maxRecordBytes,
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
      ...(opts.event ? { event: opts.event } : {}),
      envelope: {
        kind: record.kind,
        availableAt: now,
        claimUntil: undefined,
        deadlineAt: record.deadlineAt,
        effectivePriority: 0, // server-computed; scheduler sets this for real in M3
      },
    });
    this.notifier.notify(); // wake any watch streams
    await this.maybeAmortizedSweep(); // the write that crossed the threshold pays for the batch
    return { id: result.id };
  }

  // ---- artifacts (design-data-model §2.4) --------------------------------------------------
  //
  // The verbs live in `core/artifacts.ts` and reach back through a narrow host port; the download
  // capabilities are a store of their own. What stays here is the wiring, because only the service
  // knows the blob store, the byte ceiling and how a record is committed.

  get maxArtifactBytes(): number {
    return this.ctx.maxArtifactBytes;
  }

  get downloadCapabilitySeconds(): number {
    return this.ctx.downloadCapabilitySeconds;
  }

  get blobStoreName(): string {
    return this.blobs.name;
  }

  private get artifactHost(): ArtifactHost {
    return {
      blobs: this.blobs,
      maxArtifactBytes: this.ctx.maxArtifactBytes,
      getRecord: (id) => this.storage.getRecord(id),
      now: () => this.storage.now(),
      put: (req, idem, principal) => this.put(req, idem, principal),
      putRaw: (req, idem, opts) => this.putRaw(req, idem, opts),
      query: (pattern, limit, page, scope) => this.query(pattern, limit, page, scope),
    };
  }

  putArtifact(
    bytes: Uint8Array,
    meta: ArtifactMeta,
    idempotencyKey?: string,
    principal?: string,
  ): Promise<{ id: string; digest: string; size: number }> {
    return putArtifact(this.artifactHost, bytes, meta, idempotencyKey, principal);
  }

  readArtifact(
    recordId: string,
  ): Promise<{ record: RadiaRecord; def: ArtifactDef; stream: ReadableStream<Uint8Array> } | null> {
    return readArtifact(this.artifactHost, recordId);
  }

  shredArtifact(
    recordId: string,
    opts: { principal?: string; reason?: string; acknowledgeShared?: boolean } = {},
  ): Promise<{ digest: string; references: number; encrypted: boolean; alreadyGone: boolean }> {
    return shredArtifact(this.artifactHost, recordId, opts);
  }

  shredOf(digest: string): Promise<Record<string, unknown> | null> {
    return shredOf(this.artifactHost, digest);
  }

  mintPathCapability(entries: { path: string; artifactId: string }[]): { capability: string; expiresAt: string } {
    return this.caps.mintPathCapability(entries);
  }

  resolveCapabilityPath(capability: string, path: string): string | null {
    return this.caps.resolveCapabilityPath(capability, path);
  }

  mintDownloadCapability(recordId: string): { capability: string; expiresAt: string } {
    return this.caps.mintDownloadCapability(recordId);
  }

  resolveDownloadCapability(capability: string): string | null {
    return this.caps.resolveDownloadCapability(capability);
  }

  checkDownloadCapability(capability: string, recordId: string): boolean {
    return this.caps.checkDownloadCapability(capability, recordId);
  }

  async readOne(pattern: Pattern, scope?: StatsScope): Promise<RadiaRecord | null> {
    return await this.storage.readOne(await this.compileFresh(pattern), scope);
  }

  /**
   * Matching records ordered by the pattern, capped at `limit`.
   *
   * `page` is a KEYSET cursor over record id (`after` exclusive, `dir` to walk backwards): the
   * stable way to paginate a space that is still being written to, and the only way to ask for the
   * NEWEST records rather than the oldest. It is defined for the natural id order only: an
   * explicit `order_by` already answers "in what order", and a cursor over a body field would need
   * the whole sort key plus the oracle's type rules, so combining them is rejected rather than
   * silently resolved one way.
   */
  async query(pattern: Pattern, limit = 100, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]> {
    const compiled = await this.compileFresh(pattern);
    if (page && (page.after || page.dir) && compiled.orderBy?.length) {
      throw new RadiaError(
        "invalid_pattern",
        "a keyset page (after/dir) is only defined for the natural id order; drop order_by, or page without a cursor",
      );
    }
    return await this.storage.query(compiled, limit, page, scope);
  }

  /** Record counts by kind and state (dev UI overview). `scope` makes it a genuine self-aggregate,
   *  computed over the subset, never a whole-space total filtered afterwards. */
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
   * the same agent's earlier work. Throws `forbidden` when nothing is scoped to it.
   */
  /**
   * The ops-plane powers a principal holds (architecture-ops-tiers.md): the union of its active
   * `ops_grant` records' operations. Privileged principals hold every power; everyone else holds
   * exactly what an operator assigned, resolved per request and never cached (the same rule as
   * credentials: a revocation is discovered, not remembered). FAIL-CLOSED twice over: no records
   * means no powers, and an INCOMPLETE registry read also means no powers, because a picture that
   * may be missing a retirement must never open anything. `effectivePermissions` reports through
   * this same function, so the promise cannot drift from the enforcement.
   */
  async opsPowers(principal: string): Promise<Set<OpsPower>> {
    if (this.isPrivileged(principal)) return new Set<OpsPower>(OPS_POWERS);
    const subject = this.grantSubject(principal);
    const view = await this.registry<OpsGrantDef>(OPS_GRANT, opsGrantKey, { principal: subject });
    if (!view.complete) return new Set();
    const powers = new Set<OpsPower>();
    for (const rec of view.entries.values()) {
      const ops = (rec.body as OpsGrantDef).operations;
      if (!Array.isArray(ops)) continue;
      for (const op of ops) if ((OPS_POWERS as readonly string[]).includes(op)) powers.add(op as OpsPower);
    }
    return powers;
  }

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
    // Which of those kinds are actually NARROWED is asked of `authorScope` (the same function the
    // read path uses) and never restated here. A restatement filters on "has a self-scoped
    // grant", while a read is narrowed only when EVERY grant permitting it is self-scoped. The two
    // disagree for a principal holding an unscoped `{put, query}` beside a self-scoped `{query}` on
    // one kind (different operation sets, so different grant identities, so both live), which can
    // LIST every record of that kind while `ops/stats` counts only its own. And a number that
    // disagrees with the caller's own query is believed.
    const kinds = [...new Set(grants.filter((g) => g.scope?.createdBy === "self").map((g) => g.kind))];
    // …and which of those the caller can actually read MORE of. This does not widen the aggregate
    // (the ops plane stays self-scoped on purpose); it makes the aggregate able to say so. A read is
    // narrowed only when EVERY grant permitting it is self-scoped, so a principal holding an
    // unscoped `{put, query}` beside a self-scoped `{query}` (different operation sets, different
    // grant identities, both live) can LIST every record of the kind while these counts cover only
    // its own. That is a legitimate state, and a count that quietly disagrees with the caller's own
    // query gets read as the space's total.
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

  /**
   * The derived reads, all of them compositions over the verbs above (`core/inspection.ts`).
   *
   * They live outside this class for the reason the design doc gives: an inspection feature that
   * accumulates state of its own can disagree with the space it describes. The port they take is
   * every read they use and no write, which is what keeps that true by construction.
   */
  private get inspectionHost(): InspectionHost {
    return {
      listKinds: () => this.kinds.list(),
      kindDef: (kind) => this.kinds.get(kind),
      now: () => this.storage.now(),
      stats: (scope) => this.storage.stats(scope),
      staleSeconds: this.ctx.diagnosticsStaleSeconds,
      queryEnvelopes: (opts) => this.queryEnvelopes(opts as Parameters<Space["queryEnvelopes"]>[0]),
      liveInterests: (kind) => this.liveInterests(kind),
      interestMatches: (i, kind, body) => this.interestMatches(i, kind, body),
      matchingInterests: (kind) => this.matchingInterests(kind),
      effectivePermissions: (principal) => this.effectivePermissions(principal),
      erasures: (opts) => this.erasures(opts),
      // Retention only: the doctor's backlog number should not pay for a registry walk on every
      // diagnostics call, and a superseded successor is bookkeeping, not a finding.
      gcBacklog: () => this.gc({ dryRun: true, compact: false }),
      verifyIntegrity: (tail?: number) => this.verifyIntegrity(tail === undefined ? {} : { tail }),
      getLineage: (id, max, createdBy) => this.getLineage(id, max, createdBy),
      getChildren: (id, limit) => this.getChildren(id, limit),
      authorAllows: (createdBy, record) => this.authorAllows(createdBy, record),
    };
  }

  explainQuery(
    pattern: Pattern,
    returned: number,
    limit: number,
    page?: { after?: string; dir?: "asc" | "desc" },
  ): string[] {
    return explainQuery(this.inspectionHost, pattern, returned, limit, page);
  }

  digest(principal: string, scope?: { createdBy?: string[] } | null): Promise<SpaceDigest> {
    return digest(this.inspectionHost, principal, scope);
  }

  thread(
    recordId: string,
    opts: { maxNodes?: number; createdBy?: string[] } = {},
  ): Promise<{ root: string; records: RadiaRecord[]; truncated: boolean }> {
    return thread(this.inspectionHost, recordId, opts);
  }

  diagnostics(scope?: StatsScope): Promise<Diagnostics> {
    return diagnostics(this.inspectionHost, scope);
  }

  /**
   * Mined flows: the shapes of work this space actually ran (`core/flows.ts`).
   *
   * The mining itself is a reader over lineage, so it lives outside this class and reaches back
   * through a narrow port. What stays here is the port, because only the service knows how a kind
   * compiles, how a stale registry is refreshed, and which agent is behind a run.
   */
  flows(opts: Parameters<typeof mineFlows>[1] = {}): Promise<FlowReport> {
    return mineFlows({
      listKinds: () => this.kinds.list(),
      compile: (kind) => this.compileFresh({ kind }),
      query: (match, limit, page, scope) => this.storage.query(match, limit, page, scope),
      envelopesInState: (state, limit, exclude, scope) => this.storage.envelopesInState(state, limit, exclude, scope),
      agentForRun: (run) => this.agentForRun(run),
    }, opts);
  }

  /** Signs each chain link under a key held OUTSIDE the database. Absent means the chain detects
   *  corruption and naive edits but not a rewrite, and `verifyIntegrity` reports which it is. */
  sealKey?: SealKey;

  /** Public base URL of the isolated artifact origin, when one is running. Capability URLs are
   *  built against it so a browser opens artifact bytes somewhere that shares no origin with the
   *  console. Empty means artifacts are served only from the main origin, as downloads. */
  artifactOrigin = "";

  /** Registered kind declarations (dev UI). */
  listKinds(): KindDef[] {
    return this.kinds.list();
  }

  /** Claim work under a fenced lease. Returns the record + lease, or null if none is claimable.
   *  The lease is owned by the claiming `principal` (a `run:*`, so a stopped run's leases can be
   *  quarantined); defaults to the space's run id for in-process/operator callers. */
  async take(sel: TakeInput, opts: TakeOptions = {}, principal?: string): Promise<TakeResult | null> {
    const spec: LeaseSpec = {
      leaseId: newUlid(),
      ownerRun: principal ?? this.ctx.runId,
      leaseSeconds: opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds,
      maxCumulativeSeconds: this.ctx.maxCumulativeSeconds,
      maxAttempts: this.ctx.maxAttempts,
      // Validated HERE, not only at the HTTP boundary: the SDK, the MCP adapter and in-process
      // callers never pass through a handler, the same reason `compilePattern` validates its own
      // input. An allowlist is the widening direction, so the reserved label is refused.
      allowTaint: opts.allowTaint ? normalizeTaint(opts.allowTaint) : undefined,
      createdBy: opts.createdBy,
    };
    const selector: TakeSelector = "recordId" in sel
      ? { recordId: sel.recordId, pattern: sel.pattern ? await this.compileFresh(sel.pattern) : undefined }
      : { pattern: await this.compileFresh(sel.pattern) };
    return this.storage.take(selector, spec).then((r) => {
      this.notifier.notify(); // a claim changes state; a nack/release elsewhere may reopen work
      return r;
    });
  }

  async renew(lease: Lease, opts: TakeOptions = {}, idempotencyKey?: string, principal?: string): Promise<RenewResult> {
    const ref = this.ref(lease, principal);
    const idem = await this.idem("renew", idempotencyKey, this.ref(lease), principal);
    const r = await this.storage.renew(ref, opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds, idem);
    if (r.status === "lease_lost") await this.explainLeaseLost(ref, "renew");
    return r;
  }

  /** Consume the leased record, optionally emitting a result record linked to it. `principal` is
   *  the RESOLVED caller (server-assigned `created_by` on the result + idempotency scope + lease
   *  ownership check). */
  async ack(lease: Lease, result?: PutRequest, idempotencyKey?: string, principal?: string): Promise<AckResult> {
    // The authoritative lease owner, from the envelope: `ack` needs it to authorize the emitted
    // result and to derive the delegation chain, so this read is not the owner CHECK. That check
    // travels to the adapter on the ref (see `Space.ref`), which is what keeps it behind the
    // idempotency replay.
    const owner = (await this.storage.getEnvelope(lease.recordId))?.leaseOwner;
    const foreign = !!principal && !this.isPrivileged(principal) && !!owner && principal !== owner;
    if (foreign) {
      // Settling somebody else's lease. Do NOT build or authorize the result: the work would be
      // authorized as the OWNER, so a stranger could learn what that principal may write. Storage
      // still decides, so a stored response for this key replays instead of being fenced.
      this.warnOwnerMismatch(lease.recordId, principal!, owner!, "ack");
      const key = await this.idem("ack", idempotencyKey, {
        ...this.ref(lease),
        result: result ? { kind: result.kind, body: result.body } : null,
      }, principal);
      return await this.storage.ack(this.ref(lease, principal), undefined, key);
    }
    let resultInput: PutInput | undefined;
    let declared: KindDef | undefined;
    if (result) {
      // A result body the runtime reads back is validated exactly as a `put` body is, before
      // anything is consumed: emitting a record through a lease is not a way around the rule.
      declared = this.validateReservedBody(result);
      const now = await this.storage.now();
      const parentIds = [
        lease.recordId,
        ...(result.parentIds ?? []).filter((p) => p !== lease.recordId),
      ];
      // Emitting a result IS a put: authorize the ACTING principal to put this kind (this closes
      // the gap where ack-emitted records bypassed put-authorization). Pipeline-friendly: each
      // agent needs only its own grant. A pattern-scoped grant also constrains the result body.
      // Throws forbidden before anything is consumed.
      if (owner) {
        const constraint = await this.authorize(owner, "put", result.kind);
        if (constraint && !this.bodyMatchesGrant(result.kind, result.body, constraint)) {
          throw new RadiaError("forbidden", `result body is outside the pattern scope of the put grant for '${result.kind}'`);
        }
      }
      // Derive the audit authority chain from the lease (undefined for operator/root owners).
      const delegationContext = owner ? await this.deriveDelegation(owner, lease.recordId) : undefined;
      // Taint propagates along data lineage: the leased record is a parent, so a tainted task
      // yields a tainted result (client may also raise it; never lower it).
      // The writer is whoever `created_by` will name, NOT the lease owner. They are the same actor
      // under two names (a claim is owned by `run:…`, a record is authored by the resolved caller),
      // and comparing the wrong one made a worker's own ack read as `foreign` against the task it
      // had just claimed. That is precisely the saturation labels exist to avoid.
      const taint = await this.computeTaint(parentIds, result.taint, principal ?? this.ctx.principal);
      // The kind default, same as putRaw: an ack-emitted result is a put with a lease attached,
      // and a default that skipped this path would make every worker-written record of an
      // ephemera kind permanent — the exact records the default exists for.
      let retentionUntil = result.retentionUntil;
      if (retentionUntil === undefined) {
        const seconds = this.kinds.get(result.kind)?.defaultRetentionSeconds;
        if (seconds) retentionUntil = addSeconds(now, seconds);
      }
      const { record, bodyJson } = await buildRecord({ ...result, parentIds, retentionUntil }, {
        principal: principal ?? this.ctx.principal, // created_by = the acking caller
        schemaVersion: this.ctx.schemaVersion,
        maxRecordBytes: this.ctx.maxRecordBytes,
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
    const r = await this.storage.ack(this.ref(lease, principal), resultInput, idem);
    if (declared && r.status === "ok") await this.adoptKind(declared);
    this.notifier.notify(); // an emitted result is a new available record to wake on
    // The result record committed inside storage.ack, not through putRaw, so it counts here or the
    // amortized clock undercounts exactly the worker fleet's writes.
    await this.maybeAmortizedSweep();
    return r;
  }

  async nack(lease: Lease, opts: { backoffSeconds?: number } = {}, idempotencyKey?: string, principal?: string): Promise<SettleResult> {
    const ref = this.ref(lease, principal);
    const idem = await this.idem("nack", idempotencyKey, this.ref(lease), principal);
    const r = await this.storage.nack(
      ref,
      opts.backoffSeconds ?? this.ctx.defaultBackoffSeconds,
      this.ctx.maxAttempts,
      idem,
    );
    if (r.status === "lease_lost") await this.explainLeaseLost(ref, "nack");
    this.notifier.notify(); // record back to available
    return r;
  }

  async release(lease: Lease, idempotencyKey?: string, principal?: string): Promise<SettleResult> {
    const ref = this.ref(lease, principal);
    const idem = await this.idem("release", idempotencyKey, this.ref(lease), principal);
    const r = await this.storage.release(ref, idem);
    if (r.status === "lease_lost") await this.explainLeaseLost(ref, "release");
    this.notifier.notify(); // record back to available
    return r;
  }

  /**
   * Lease settlement is OWNER-BOUND: a non-operator principal may settle only a lease it owns,
   * which is defense-in-depth on top of fencing. It closes lease-leak IMPERSONATION (an ack whose
   * emitted result would carry the owner's authority and delegation chain) and lease-leak DoS
   * (nack/release/renew driving someone else's task to available/dead-letter). A stranger gets the
   * same opaque `lease_lost` fencing returns, never a distinguishable error.
   *
   * The check itself lives in the ADAPTER, reached through `LeaseRef.expectOwner`, so that it runs
   * inside the settle's transaction after any stored idempotent response has replayed. It used to
   * run here, ahead of storage, and that turned a legitimate owner's retry of an op that ALREADY
   * SUCCEEDED into `lease_lost` as soon as the record had been reclaimed by somebody else —
   * reproduced with a nack whose response was lost. The old comment argued it was safe because
   * `lease_owner` is not cleared on settle; that covers the record staying put and misses
   * REASSIGNMENT.
   *
   * These two are what remains here: the reason a settle failed is only visible from the envelope,
   * and the caller is told nothing (by design), so a misconfigured agent presenting the wrong
   * identity would otherwise retry forever in silence. Read on the FAILURE path only.
   */
  private async explainLeaseLost(ref: LeaseRef, op: string): Promise<void> {
    if (!ref.expectOwner) return;
    const owner = (await this.storage.getEnvelope(ref.recordId))?.leaseOwner;
    if (owner && owner !== ref.expectOwner) this.warnOwnerMismatch(ref.recordId, ref.expectOwner, owner, op);
  }

  private warnOwnerMismatch(recordId: string, principal: string, owner: string, op: string): void {
    console.warn(`[radia] owner-match: ${op} on ${recordId} by '${principal}' rejected (lease owned by '${owner}') -> lease_lost`);
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
   *
   * `direction: "down"` walks children ONLY, which is what makes a sub-thread separable: from a hub
   * record every member of every sibling thread is two hops away, so the default both-ways walk
   * returns the hub's whole component whichever member you seed it with.
   *
   * `truncated` says the node cap was hit. A capped graph rendered without it reads as the whole
   * story: a live 346-record conversation displayed as 150 nodes with nothing saying so.
   */
  async getGraph(
    recordId: string,
    opts: { maxNodes?: number; excludeKinds?: Set<string>; createdBy?: string[]; direction?: "both" | "down" } = {},
  ): Promise<{ nodes: GraphNode[]; edges: { from: string; to: string }[]; truncated: boolean }> {
    const maxNodes = opts.maxNodes ?? 150;
    const down = opts.direction === "down";
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
      // A foreign node is a wall, not a skip. Traversing through it would still expose the shape
      // of what hangs off it, and the node's own id and label are enough to feed a lineage probe.
      if (!this.authorAllows(opts.createdBy, rec)) continue;
      nodes.set(id, rec);
      for (const pid of rec.runtimeMeta.parentIds) {
        // The edge is recorded either way — it is dropped below unless both ends are in view — so a
        // descendants-only walk still draws the seed's own inbound edge rather than orphaning it.
        addEdge(pid, id);
        if (!down && !seen.has(pid)) queue.push(pid);
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
      // Hitting the cap is the honest signal; an empty queue means the walk finished.
      truncated: nodes.size >= maxNodes && queue.length > 0,
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

  /** The newest `limit` final events, ascending: the tail a live view starts from. */
  latestEvents(limit: number): Promise<SpaceEvent[]> {
    return this.storage.latestEvents(limit);
  }

  /** The current high-water cursor: following from it delivers only future events. */
  latestCursor(): Promise<string> {
    return this.storage.latestCursor();
  }

  /** The event log's truncation floor, and whether `after` resumes below it (see
   *  `StorageAdapter.eventHorizon` for the contract, including sentinel policy). */
  eventHorizon(after: string): Promise<EventHorizonCheck> {
    return this.storage.eventHorizon(after);
  }

  /**
   * A record and its ancestry via parent_ids (BFS, `depth` 0 = the record itself). The
   * lineage DAG is acyclic by construction, but `seen` and a node cap guard anyway.
   */
  async getLineage(
    recordId: string,
    maxNodes = 200,
    createdBy?: string[],
  ): Promise<{ record: RadiaRecord; depth: number }[]> {
    const out: { record: RadiaRecord; depth: number }[] = [];
    const seen = new Set<string>();
    let frontier: string[] = [recordId];
    // One round trip per DEPTH LEVEL, not per node: a level's records are fetched together, and
    // only then does the walk decide what the next level is. Walking node by node costs a
    // sequential round trip per ancestor, which on a networked Postgres is latency, not work.
    for (let depth = 0; frontier.length > 0 && out.length < maxNodes; depth++) {
      const fresh = frontier.filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      const records = await this.storage.getRecords(fresh);
      // getRecords does not promise an order, and lineage output should not depend on one. A
      // single-record level (every level of a plain chain) is already sorted.
      if (records.length > 1) records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const next: string[] = [];
      for (const rec of records) {
        // A self-scoped reader walks only its OWN lineage. Stop at a foreign ancestor rather than
        // skipping past it: `put` never checks that a parent is readable, so a scoped principal can
        // name any id as a parent of its own record, and an unfiltered walk then hands back that
        // record's whole upstream, bodies included.
        if (!this.authorAllows(createdBy, rec)) continue;
        out.push({ record: rec, depth });
        next.push(...rec.runtimeMeta.parentIds);
      }
      frontier = next;
    }
    return out;
  }

  /** Records that reference this record via `parent_ids`: its direct **children** (the reverse of
   *  lineage). E.g. a conversation's messages/llm_calls, an llm_call's chunks + result, a task's
   *  results. Lineage goes up (ancestors); this goes down. */
  getChildren(recordId: string, limit = 100, page?: Page): Promise<RadiaRecord[]> {
    return this.storage.childrenOf(recordId, Math.min(limit, 500), page);
  }

  // ---- watches (M1) ----

  /** Create an ephemeral watch. The stream starts from the current high-water cursor. Throws
   *  `forbidden` if the owner holds no grant on the kind. */
  async createWatch(request: Pattern, owner: string): Promise<{ watchId: string }> {
    // Swept HERE rather than on a timer: an idle space should hold no background work, the lesson
    // `Notifier` learned the same week. Creation is the only operation that grows the map, so it is
    // also the only one that has to pay for it.
    this.sweepWatches();
    const mine = [...this.watches.values()].filter((w) => w.owner === owner).length;
    if (mine >= this.ctx.maxWatchesPerPrincipal) {
      // Refused, never evicted. Dropping somebody's oldest watch to make room would kill a live
      // stream to serve a new one, and the caller who loses it is told nothing.
      throw new RadiaError(
        "too_many_watches",
        `principal '${owner}' already holds ${mine} watches (limit ${this.ctx.maxWatchesPerPrincipal}). ` +
          `A watch is dropped after ${this.ctx.watchIdleSeconds}s with nothing attached; close streams ` +
          `you are done with, or reuse one watch across reconnects with Last-Event-ID.`,
      );
    }
    const cursor0 = await this.storage.latestCursor();
    const watchId = newUlid();
    this.watches.set(watchId, await this.scopeWatch(request, owner, cursor0));
    return { watchId };
  }

  /**
   * Drop watches nobody has touched for `watchIdleSeconds`.
   *
   * The map was never pruned: a watch is created by an authenticated call, lives in memory, and
   * stayed for the process's lifetime whether or not anyone ever attached — unbounded growth from a
   * cheap request, and the reason the inspection backlog (whose console opens many short-lived
   * watches) named watch lifecycle as its one prerequisite.
   *
   * Idle, not disconnected. Deleting on stream close would break RESUMPTION, which is the point of
   * the cursor: a client that drops reconnects to the same id with `Last-Event-ID` and continues.
   * So the window is "nothing attached for a while", and a live stream keeps its watch alive by
   * touching it every lap (at most one keepalive apart).
   */
  private sweepWatches(): void {
    const deadline = Date.now() - this.ctx.watchIdleSeconds * 1000;
    for (const [id, w] of this.watches) if (w.lastSeenAt < deadline) this.watches.delete(id);
  }

  /** Watches currently held, after a sweep. Diagnostic, and what the guard asserts against. */
  liveWatches(): number {
    this.sweepWatches();
    return this.watches.size;
  }

  /**
   * Authorize `request` for `owner` and compile the scoped pattern. The ONE place a watch's scope
   * is derived, called both at creation and at every revalidation.
   *
   * It lives here rather than in the handler because the handler used to do the authorize-and-
   * combine itself. That was fine while a watch was scoped once; the moment the scope has to be
   * re-derived, two implementations of the same policy is how one of them drifts and the stale one
   * is the one still streaming.
   */
  private async scopeWatch(request: Pattern, owner: string, cursor0: string): Promise<Watch> {
    const { constraint, createdBy } = await this.authorizeWatch(owner, request.kind);
    const scoped: Pattern = { ...request, match: constraint ? combineMatch(request.match, constraint) : request.match };
    const match = await this.compileFresh(scoped); // validates the pattern, refreshing a stale kind
    return { request, match, cursor0, owner, createdBy, lastSeenAt: Date.now() };
  }

  /**
   * Re-derive a live watch's scope from the grants that exist NOW, and replace it.
   *
   * A watch compiled its scope once and then streamed under it for as long as the connection
   * lasted, so a revoked or narrowed grant took effect only when the client happened to
   * disconnect. That contradicts the rule the credential design already states for tokens: hold
   * only what cannot be revoked, and resolve the rest per request. A stream is a request that
   * never ends, so it has to re-resolve rather than never resolve.
   *
   * Throws `forbidden` when the grant is gone (the caller ends the stream) and `not_found` when
   * the watch is not the principal's. Scoped by the watch's OWNER, never by the caller: an
   * operator attaching to somebody else's watch must not widen it to operator scope.
   */
  async revalidateWatch(watchId: string, principal: string): Promise<Watch> {
    const current = this.getWatch(watchId, principal);
    if (!current) throw new RadiaError("not_found", `no watch ${watchId}`);
    const fresh = await this.scopeWatch(current.request, current.owner, current.cursor0);
    this.watches.set(watchId, fresh);
    return fresh;
  }

  /**
   * The watch, but only for the principal that created it.
   *
   * A watch carries a compiled scope derived from its creator's grants, so handing the stream to
   * anyone who knows the id hands them that scope. Ids come from the same monotonic ULID generator
   * as record ids, so they are guessable from an adjacent record. Never treat the id as the
   * secret. Returns undefined for a non-owner, which the caller reports as 404 rather than 403 so
   * the id is not confirmed.
   */
  getWatch(watchId: string, principal: string): Watch | undefined {
    const watch = this.watches.get(watchId);
    if (!watch) return undefined;
    if (watch.owner !== principal && !this.isPrivileged(principal)) return undefined;
    // TOUCHED on every successful read, which is what keeps a live stream out of the sweep: the SSE
    // loop calls this on attach and revalidates each lap, at most one keepalive (15s) apart. An
    // idle watch is one no client is asking about, and only that.
    watch.lastSeenAt = Date.now();
    return watch;
  }

  /**
   * Which registered interests would receive a record of `kind` with this `body`?
   *
   * This runs the matching direction BACKWARDS. Normal operation evaluates one pattern against many
   * records; this evaluates many registered patterns against one candidate body, so it is a linear
   * pass over the interests targeting that kind, O(interests on the kind). That is fine while
   * interests are per-worker. It is not the deferred inverted-index work, and it will not hold if
   * interests ever become per-record.
   *
   * `body` need not be a record that exists. Answering before the write is the point: it turns
   * "who would receive this?" into a question you can ask of a draft.
   *
   * An interest whose run is no longer live is dropped. A clean shutdown retires its interests, but
   * a crashed worker cannot, so presence of the record is never taken as proof anyone is listening.
   */
  async matchingInterests(
    kind: string,
    body?: unknown,
  ): Promise<{ interests: LiveInterest[]; complete: boolean }> {
    const live = await this.liveInterests(kind);
    if (body === undefined) return { interests: live.interests, complete: live.complete };
    return { interests: live.interests.filter((i) => this.interestMatches(i, kind, body)), complete: live.complete };
  }

  /** Does this interest's pattern accept that body? An interest whose pattern no longer compiles
   *  matches nothing, which is the safe direction: it cannot claim to be listening. */
  private interestMatches(i: LiveInterest, kind: string, body: unknown): boolean {
    if (!i.match || Object.keys(i.match).length === 0) return true; // the whole kind
    try {
      return matchesRecord({ kind, body } as RadiaRecord, this.compile({ kind, match: i.match }));
    } catch {
      return false;
    }
  }

  /**
   * Every LIVE interest on a kind, read once.
   *
   * Split out because the caller that needs it most reads it per RECORD: classifying a hundred
   * stale records used to mean a hundred registry reads paged to exhaustion. The registry read is
   * the expensive half and the pattern test is the cheap one, so the two are separable.
   */
  private async liveInterests(kind: string): Promise<{ interests: LiveInterest[]; complete: boolean; published: number }> {
    const view = await this.registry<{ kind?: unknown; match?: unknown }>(
      INTEREST,
      // One entry per (author, target kind, pattern): a run re-publishing the same interest is the
      // same entry, and a retirement withdraws exactly it.
      (b, rec) => (typeof b?.kind === "string" ? `${rec.runtimeMeta.createdBy}|${b.kind}|${JSON.stringify(b.match ?? null)}` : undefined),
      { kind },
    );
    const out: LiveInterest[] = [];
    // Memoized PER CALL: liveness is asked at a single point in time within one projection, so the
    // memo is pure, and a lived-in space has far fewer runs than entries (measured 178 runs behind
    // 1966 entries — this loop was 1966 sequential agent_run lookups without it). Deliberately not
    // cached across calls: a run stopping is the event this exists to notice.
    const liveMemo = new Map<string, boolean>();
    const isLive = async (run: string) => {
      const hit = liveMemo.get(run);
      if (hit !== undefined) return hit;
      const v = await this.runIsLive(run);
      liveMemo.set(run, v);
      return v;
    };
    for (const rec of view.entries.values()) {
      const b = rec.body as { kind?: string; match?: Record<string, unknown> };
      if (b.kind !== kind) continue;
      const run = rec.runtimeMeta.createdBy;
      if (!(await isLive(run))) continue;
      out.push({ run, agent: await this.agentForRun(run), ...(b.match ? { match: b.match } : {}) });
    }
    // `published` counts what was DECLARED, before liveness. The difference between it and
    // `interests` is the difference between "nobody ever said what they listen for" and "the
    // workers that did have all stopped", and only the second is a finding.
    let published = 0;
    for (const rec of view.entries.values()) {
      if ((rec.body as { kind?: string }).kind === kind) published++;
    }
    return { interests: out, complete: view.complete, published };
  }

  /** Is this run still able to claim work? Interests outlive the process that published them when
   *  it crashes, so liveness is asked of the `agent_run` record rather than of the interest. */
  private async runIsLive(run: string): Promise<boolean> {
    if (!run.startsWith("run:")) return true; // operator/in-process authorship has no run record
    const rec = await this.runRecord(run);
    if (!rec) return false;
    if (rec.status === "stopped") return false;
    return true;
  }

  /** Does this event signal a record matching the watch that is now claimable/available? */
  async matchesEvent(watch: Watch, event: SpaceEvent): Promise<boolean> {
    if (event.state !== "available") return false; // wakeups are for claimable/available records
    if (!event.recordId || event.kind !== watch.match.kind) return false;
    // A kind-only watch still needs the record when an author restriction applies: the event's
    // `runId` is who performed the operation, not who authored the record, so a nack or release by
    // another principal would otherwise wake a self-scoped watcher on a record it cannot read.
    if (!watch.match.where && !watch.createdBy) return true;
    const rec = await this.storage.getRecord(event.recordId);
    if (!rec) return false;
    if (!this.authorAllows(watch.createdBy, rec)) return false;
    return watch.match.where ? matchesRecord(rec, watch.match) : true;
  }

  /** Resolve when a mutation occurs (a watch wakeup) or after timeoutMs (keepalive). A mutation
   *  made by another instance counts: see `pollForForeignChanges`. */
  waitForEvents(timeoutMs: number): Promise<void> {
    return this.notifier.wait(timeoutMs);
  }

  /**
   * Has anything been committed to the event log that this process did not do?
   *
   * `Notifier` knows only this Space's own mutations, so with two instances over one database a
   * watch slept until its caller's keepalive (~15s per cross-instance hop). Not LISTEN/NOTIFY:
   * deno-postgres 0.19 exposes no asynchronous notification API, so polling the shared log is the
   * only cross-instance signal available. Reads ONE event, because the answer is a boolean; the
   * streams re-read from their own cursors. It does not distinguish this instance's own writes, so
   * a local mutation can cost one extra loop iteration — the cheap direction of the trade.
   */
  private async pollForForeignChanges(): Promise<boolean> {
    if (this.changeCursor === undefined) {
      // First poll of this space's life. Take the baseline and report a change anyway: a record
      // written between the caller's last read and this baseline is already below the cursor, so
      // reporting "nothing" here would be the one wakeup this whole mechanism exists to deliver.
      this.changeCursor = await this.storage.latestCursor();
      return true;
    }
    const events = await this.storage.getEvents(this.changeCursor, 1);
    if (events.length === 0) return false;
    this.changeCursor = events[events.length - 1].cursor;
    return true;
  }

  // ---- envelope query + diagnostics + remediation (ops plane; would be grant-gated) ----

  /**
   * Query records by their runtime ENVELOPE state, the dimension the content-routing query
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
   * The retention sweep: delete records whose writer-declared `retention_until` has passed.
   *
   * The second deliberate carve-out from immutability, after artifact erasure, and shaped by the
   * same rule: destroy the content, keep the evidence (the event log keeps id, kind, digest and
   * every transition; the sweep adds one recordless `gc` event per kind per batch). See
   * agent_docs/plan-gc.md for eligibility and for what is deliberately NOT swept.
   *
   * The kind classes come from the REGISTRY, which is why this lives here and not in the adapter:
   * only the registry knows which kinds are reference data (`claimable: false`, sweepable from any
   * state because they sit `available` forever by design) and which are reserved. A kind this
   * process has never loaded defaults to the strict class (consumed/dead_letter only), which is
   * the conservative side.
   *
   * ON DEMAND, never on a timer, like sealing and for the same reason: an idle space should hold
   * no background work. `radia doctor` reports the backlog; `POST /v0/ops/gc` runs the sweep.
   */
  async gc(opts: { limit?: number; dryRun?: boolean; compact?: boolean; principal?: string } = {}): Promise<{
    swept: number;
    eligible: number;
    idempotency: number;
    byKind: Record<string, number>;
    more: boolean;
    passes: number;
    compaction?: CompactionResult;
    events?: EventGcResult;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
    const totals = { swept: 0, eligible: 0, idempotency: 0, byKind: {} as Record<string, number>, more: false, passes: 0 };
    // Bounded batches rather than one unbounded delete: each pass is one transaction, so a crash
    // loses at most a batch's progress and a concurrent reader never sees a half-swept batch. The
    // pass cap bounds one CALL; `more` says a backlog remains and the caller decides.
    const MAX_PASSES = 50;
    // The idempotency cutoff rides the FIRST pass only: after it those rows are gone, and a dry
    // run would count the same rows once per pass.
    const idempotencyBefore = addSeconds(await this.storage.now(), -this.ctx.idempotencyRetentionSeconds);
    for (;;) {
      const r = await this.storage.sweepExpired({
        ...this.sweepSelector(limit, opts.dryRun),
        runId: opts.principal ?? this.ctx.runId,
        ...(totals.passes === 0 ? { idempotencyBefore } : {}),
      });
      totals.eligible += r.eligible;
      totals.swept += r.swept;
      totals.idempotency += r.idempotency;
      for (const [k, n] of Object.entries(r.byKind)) totals.byKind[k] = (totals.byKind[k] ?? 0) + n;
      totals.passes++;
      totals.more = r.more;
      // A dry run never loops: its count is a capped sample, and looping would re-count the same
      // rows forever, since nothing was deleted.
      if (opts.dryRun || !r.more || totals.passes >= MAX_PASSES) break;
    }
    // An explicit LIVE gc restarts the amortized clock. Not a dry run: doctor calls this dry on
    // every diagnostics, and a backlog report must not keep postponing the sweep it reports on.
    if (!opts.dryRun) this.writesSinceSweep = 0;
    // Event-log retention rides the verb too (phase 3, plan-gc.md) and ONLY the verb: sealing on
    // the write path is exactly the background work the on-demand rule refuses.
    const events = this.ctx.eventRetentionSeconds != null
      ? await this.gcEvents({ dryRun: opts.dryRun, runId: opts.principal })
      : undefined;
    // Registry compaction rides the same verb (phase 2, plan-gc.md): superseded successors of
    // latest-wins registries, plus interests whose run is over. `core/gc.ts` owns the keep-newest
    // logic and its resurrection guard; this only wires the reads and the one destructive member.
    if (opts.compact !== false) {
      const compaction = await compactRegistries({
        listKinds: () => this.kinds.list(),
        pageDesc: (kind, limit, after) => this.query({ kind }, limit, { dir: "desc", after }),
        sweepIds: (ids, runId) => this.storage.sweepIds(ids, runId),
        runIsLive: (run) => this.runIsLive(run),
      }, { dryRun: opts.dryRun, runId: opts.principal ?? this.ctx.runId });
      return { ...totals, compaction, ...(events ? { events } : {}) };
    }
    return { ...totals, ...(events ? { events } : {}) };
  }

  /**
   * Event-log retention: truncate the log to `eventRetentionSeconds` ∩ the sealed head
   * (plan-gc.md phase 3). The order is the contract, each step for a reason the plants pin:
   * seal FIRST (a never-sealed space must not sweep nothing forever, and only sealed events are
   * ever candidates); pick the anchor through the seals, never splitting events that share a
   * cursor (an xid groups siblings, and a split would strand retained events below the horizon);
   * attest and SEE `attested: true` before the first delete (an honest crash must not read as
   * tampering); then delete pairs oldest-first so every observable state is a clean prefix
   * truncation. Refusing to proceed (statement not sealed yet) reports `more: true` rather than
   * weakening any step.
   */
  async gcEvents(
    opts: { dryRun?: boolean; limit?: number; sealBudget?: number; runId?: string } = {},
  ): Promise<EventGcResult> {
    const retention = this.ctx.eventRetentionSeconds;
    const out: EventGcResult = { enabled: retention != null, sealed: 0, unsealed: 0, swept: 0, eligible: 0, more: false };
    if (retention == null) return out;
    // A dry run reports the seal-first debt instead of paying it: doctor runs this on every
    // diagnostics, and "what would sweep" must not quietly become "seal 5000 links".
    out.sealed = (await this.sealEvents(opts.sealBudget ?? (opts.dryRun ? 0 : 10 * SEAL_BATCH))).sealed;
    const head = await this.storage.sealHead();
    out.unsealed = (await this.storage.sealableEvents(head ? { cursor: head.cursor, seq: head.seq } : null, 1)).length;
    out.more = out.unsealed > 0; // a seal backlog is work this call did not finish
    if (!head) return out;

    const cutoff = addSeconds(await this.storage.now(), -retention);
    let anchor = await this.storage.latestSealBefore(cutoff);
    const [oldest] = await this.storage.getSeals(-1, 1);
    // Never split a cursor group: if the next seal shares the candidate's cursor, the window
    // boundary falls inside one transaction's events; step down and sweep less instead.
    while (anchor) {
      const [next] = await this.storage.getSeals(anchor.idx, 1);
      if (!next || next.cursor !== anchor.cursor) break;
      if (anchor.idx - 1 < oldest.idx) {
        anchor = null;
        break;
      }
      [anchor] = await this.storage.getSeals(anchor.idx - 2, 1);
    }
    if (!anchor) return out;
    out.anchorIdx = anchor.idx;

    if (opts.dryRun) {
      out.eligible = (await this.storage.sweepSealedEvents({ idx: anchor.idx, seq: anchor.seq }, 0, true)).events;
      return out;
    }
    const { attested } = await this.attestEventTruncation(anchor, opts.runId ?? this.ctx.runId);
    out.attested = attested;
    if (!attested) {
      // The statement is committed but the chain has not sealed through it (finality watermark
      // behind, or the seal backlog outran the budget). Deleting now would manufacture the
      // unattested state verify rightly calls tampering, so nothing is deleted.
      out.more = true;
      return out;
    }
    const r = await this.storage.sweepSealedEvents(
      { idx: anchor.idx, seq: anchor.seq },
      Math.min(Math.max(opts.limit ?? 10_000, 1), 100_000),
    );
    out.swept = r.events;
    out.eligible = r.events;
    if (!r.done) out.more = true;
    return out;
  }

  /** The eligibility classes the sweep needs, computed from the registry (only it knows which
   *  kinds are reference data and which are reserved). Shared by the verb and the amortized pass. */
  private sweepSelector(limit: number, dryRun?: boolean) {
    return {
      anyStateKinds: this.kinds.list()
        .filter((d) => !isClaimable(d) && !RESERVED_KINDS.includes(d.kind))
        .map((d) => d.kind),
      neverKinds: [...RESERVED_KINDS],
      limit,
      dryRun,
    };
  }

  /** Commits since the last amortized sweep. Instance state, like the notifier: two instances over
   *  one database each keep their own count, which only means the housekeeping runs a bit oftener. */
  private writesSinceSweep = 0;
  private amortizedSweepRunning = false;

  /**
   * The amortized half of GC: every `gcEveryWrites` record commits, the WRITING call runs one small
   * retention batch inline.
   *
   * The lazy-lease-expiry shape, deliberately: no timer (an idle space runs nothing and does not
   * grow), and the cost lands on the principal generating the litter, which is the fair place for
   * it. Awaited rather than fire-and-forget, so the Nth writer pays a bounded few milliseconds
   * and tests are deterministic; the guard keeps a slow sweep from stacking. Measured (plan-gc.md
   * carries the table): an empty trigger costs 0.36ms (sqlite) / 1.7ms (pglite), a full 256-row
   * batch 5–9ms, which amortizes to under 1% of a put and lands at p99.9, not p99.
   * Retention only — compaction walks whole registries and stays with the explicit verb, because
   * registry litter grows per session, not per write.
   *
   * A failed pass is swallowed: housekeeping must never fail the write that happened to trigger it.
   */
  private async maybeAmortizedSweep(): Promise<void> {
    if (this.ctx.gcEveryWrites <= 0) return;
    if (++this.writesSinceSweep < this.ctx.gcEveryWrites) return;
    this.writesSinceSweep = 0;
    if (this.amortizedSweepRunning) return;
    this.amortizedSweepRunning = true;
    try {
      await this.storage.sweepExpired({
        ...this.sweepSelector(AMORTIZED_BATCH),
        runId: this.ctx.runId,
        idempotencyBefore: addSeconds(await this.storage.now(), -this.ctx.idempotencyRetentionSeconds),
      });
    } catch { /* the backlog waits for the next trigger or the verb */ } finally {
      this.amortizedSweepRunning = false;
    }
  }

  /**
   * Remediate every record matching an envelope SELECTOR, not one id at a time.
   *
   * Per-record remediation (`POST /v0/ops/records/{id}/{action}`) makes draining 500 stuck leases
   * 500 calls, preceded by diagnostics calls just to learn the ids, and the diagnostics report
   * only samples ten. The selector here is deliberately the SAME shape `queryEnvelopes` accepts, so
   * "what is wrong" and "fix it" are one query language rather than two: `{state:"leased",
   * expired:true}` is the stuck-lease set in both.
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
    // Remediation acts on WORK. A `claimable:false` kind (kind_def, grant, agent_run, facts,
    // history) sits `available` forever by design, so a broad `{state:"available"}` selector would
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

  /**
   * Extend the event chain over everything that has become final since the last pass.
   *
   * ON DEMAND, never on a timer: an idle space should hold no background work, the same lesson
   * `Notifier` and `sweepWatches` learned. Verification seals first, so the answer covers
   * everything sealable at the moment it is asked rather than whatever a timer last got to.
   *
   * Idempotent and safe to run concurrently with another instance: seals are content-derived, so
   * two sealers over one database compute identical rows, and the loser's insert is skipped rather
   * than overwriting a link.
   */
  async sealEvents(limit = SEAL_BATCH): Promise<{ sealed: number; head?: { idx: number; hash: string } }> {
    let head = await this.storage.sealHead();
    let sealed = 0;
    for (;;) {
      const after = head ? { cursor: head.cursor, seq: head.seq } : null;
      const events = await this.storage.sealableEvents(after, Math.min(limit - sealed, SEAL_BATCH));
      if (events.length === 0) break;
      const links = await linkEvents(head, events, this.sealKey);
      const written = await this.storage.appendSeals(links);
      sealed += written;
      // A short write means another sealer claimed those positions. Re-read the head and continue
      // from wherever the chain actually reached, rather than assuming this process's view.
      head = await this.storage.sealHead();
      if (written < links.length || sealed >= limit) break;
    }
    return { sealed, ...(head ? { head: { idx: head.idx, hash: head.hash } } : {}) };
  }

  /**
   * Recompute the chain and report the FIRST divergence.
   *
   * "The chain is invalid" is not an answer anyone can act on. The position, the event it covers,
   * and which of the four ways it failed are, and they are what distinguishes a truncated restore
   * from an edited row.
   */
  /**
   * Verify the event chain.
   *
   * `tail` verifies only the newest N links, from the hash of the one below them. A full walk is
   * O(the whole history) and `radia doctor` embedded one, so a routine health check re-verified
   * every link ever written on every run: measured at 1.7s over 20k links on a fresh space and 60s
   * on a working one, and unbounded from there. A spot check answers what a health report is
   * actually asking (has the recent log been altered) and says so in `spotCheckedFrom`; the full
   * audit stays `radia integrity`, which is where an unbounded walk belongs.
   */
  async verifyIntegrity(opts: { seal?: boolean; limit?: number; tail?: number } = {}): Promise<IntegrityReport> {
    if (opts.seal !== false) await this.sealEvents();
    const head = await this.storage.sealHead();
    const signed = !!this.sealKey;
    const report: IntegrityReport = {
      ok: true,
      checked: 0,
      sealed: head ? head.idx + 1 : 0,
      unsealed: (await this.storage.sealableEvents(head ? { cursor: head.cursor, seq: head.seq } : null, 1)).length,
      signed,
      ...(head ? { head: { idx: head.idx, hash: head.hash } } : {}),
    };
    type Reason = NonNullable<IntegrityReport["failure"]>["reason"];
    const fail = (idx: number, eventId: string, reason: Reason, detail: string) => {
      report.ok = false;
      report.failure = { idx, eventId, reason, detail };
      return report;
    };

    let prev = CHAIN_GENESIS;
    let expectIdx = 0;
    let afterIdx = -1;
    let first = true;
    // Start from the hash BELOW the tail rather than from genesis. Not the anchor path below: that
    // one exists for event GC and demands an attestation, because a chain that begins late without
    // one is indistinguishable from a truncated log. A spot check makes no claim about the links it
    // skipped, so it must not judge them either.
    if (opts.tail !== undefined && head && head.idx + 1 > opts.tail) {
      const from = head.idx + 1 - opts.tail;
      const [below] = await this.storage.getSeals(from - 1, 1);
      if (below) {
        afterIdx = below.idx;
        prev = below.hash;
        expectIdx = below.idx + 1;
        first = false;
        report.spotCheckedFrom = expectIdx;
      }
    }
    // Event GC leaves a chain that begins past genesis (the anchor state: links below the anchor
    // deleted, the anchor's own event swept once the sweep completes). Those facts are collected
    // during the walk and judged AFTER it, because the horizon statement that makes the
    // truncation honest is sealed above it in the retained suffix.
    let truncated: NonNullable<IntegrityReport["truncated"]> | undefined;
    let anchorEventId = "";
    let attested = -1; // newest sealed horizon statement's anchorIdx; the walk ascends, last wins
    for (;;) {
      const seals = await this.storage.getSeals(afterIdx, Math.min(opts.limit ?? SEAL_BATCH, SEAL_BATCH));
      if (seals.length === 0) break;
      // ONE read per PAGE, not one per link. Each link's event was fetched with its own windowed
      // read, which is cheap against a warm cache (0.085ms) and is not what an audit meets: on a
      // freshly started space the same 20k-link walk took 135 SECONDS at ~6.7ms a link. Measured
      // both ways, because the hot-cache number says the opposite and is the one easy to get.
      // Seals are contiguous and ascending, so a page's events are one window; a gap (event GC
      // swept a link) falls back to the single read, which is also the anchor's path.
      const lead = seals[0];
      const window = await this.storage.sealableEvents(
        lead.seq > 0 ? { cursor: lead.cursor, seq: lead.seq - 1 } : null,
        seals.length,
      );
      const byId = new Map(window.map((e) => [e.id, e]));
      for (const seal of seals) {
        const event = byId.get(seal.eventId) ?? await this.eventById(seal.eventId, seal.cursor, seal.seq);
        if (first) {
          first = false;
          if (seal.idx > 0 || !event) {
            // The anchor. Its prev_hash points at a deleted link, so the chain is accepted FROM
            // its hash; what stands behind that hash is the signature (on a signed chain) plus
            // the attestation judged below. A chain that merely STARTS late without either stays
            // a tamper verdict.
            truncated = { anchorIdx: seal.idx, swept: seal.idx + (event ? 0 : 1), attested: false };
            anchorEventId = seal.eventId;
            expectIdx = seal.idx;
            if (seal.idx > 0) prev = seal.prevHash;
          }
        }
        // A missing position is a DELETED link. Without this check a truncated chain verifies
        // perfectly, which is the failure an audit most needs to catch.
        if (seal.idx !== expectIdx) {
          return fail(expectIdx, seal.eventId, "gap", `chain jumps from ${expectIdx - 1} to ${seal.idx}`);
        }
        if (seal.prevHash !== prev) {
          return fail(seal.idx, seal.eventId, "broken_link", `prev_hash does not match the hash at ${seal.idx - 1}`);
        }
        if (!event) {
          // Tolerated at the anchor alone, pending attestation; anywhere else it is tampering.
          if (!(truncated && seal.idx === truncated.anchorIdx)) {
            return fail(seal.idx, seal.eventId, "missing_event", "the sealed event is no longer in the log");
          }
        } else {
          const hash = await eventHash(seal.prevHash, chainedEvent(seal.idx, event));
          if (hash !== seal.hash) {
            return fail(seal.idx, seal.eventId, "hash_mismatch", "the event does not hash to its seal; it was altered after sealing");
          }
          const a = attestedAnchorIdx(event);
          if (a !== null) attested = a;
          report.checked++;
        }
        if (this.sealKey) {
          if (!seal.sig) return fail(seal.idx, seal.eventId, "bad_signature", "the link carries no signature on a signed chain");
          if (!await this.sealKey.verify(seal.hash, seal.sig)) {
            return fail(seal.idx, seal.eventId, "bad_signature", "the signature does not verify; the chain was rebuilt without the key");
          }
        }
        prev = seal.hash;
        expectIdx++;
        afterIdx = seal.idx;
      }
    }
    if (truncated) {
      // Honest states have the chain beginning AT or BELOW the attested anchor: mid-sweep the
      // oldest surviving pair sits below it, at completion exactly on it. Deeper is dishonest.
      truncated.attested = attested >= truncated.anchorIdx;
      report.truncated = truncated;
      if (!truncated.attested) {
        return fail(
          truncated.anchorIdx,
          anchorEventId,
          "unattested_truncation",
          attested < 0
            ? `the chain begins at idx ${truncated.anchorIdx} with no sealed horizon statement; honest event GC seals its horizon before deleting`
            : `the chain begins at idx ${truncated.anchorIdx} but the newest sealed horizon statement attests only idx ${attested}: the log was truncated deeper than GC declared`,
        );
      }
    }
    return report;
  }

  /**
   * Write and seal the horizon statement that makes an event-log truncation attributable to GC
   * rather than to tampering. The M2 event sweep MUST call this and see `attested: true` BEFORE
   * it deletes anything: a crash after deletion but before the statement leaves an anchor with no
   * attestation, which verify reports as tampering, and would be right to. `attested: false`
   * means the statement is committed but the finality watermark has not let the chain seal
   * through it yet; the sweep must not proceed until a later attempt seals it.
   */
  async attestEventTruncation(
    anchor: { idx: number; cursor: string; seq: number },
    runId = "gc:events",
  ): Promise<{ attested: boolean }> {
    const at = await this.storage.appendGcEvent(horizonStatement(anchor, runId));
    await this.sealEvents();
    const head = await this.storage.sealHead();
    const attested = !!head &&
      (BigInt(head.cursor) > BigInt(at.cursor) || (head.cursor === at.cursor && head.seq >= at.seq));
    return { attested };
  }

  /** The sealed event, read back for verification. Positioned by its cursor rather than scanned:
   *  a verify must not become a full log scan per link. */
  private async eventById(id: string, cursor: string, seq: number): Promise<SpaceEvent | undefined> {
    const before = seq > 0 ? { cursor, seq: seq - 1 } : null;
    const window = await this.storage.sealableEvents(before, 4);
    return window.find((e) => e.id === id);
  }

  /**
   * Every erasure and whether it STILL HOLDS.
   *
   * Shredding destroys the runtime's copy, not the ability to store those bytes: the content address
   * stays valid, so anyone holding the payload can write it again and every record referencing it
   * reads once more. Nothing in the system noticed. `shredOf` had exactly one caller, inside the
   * branch that runs after a read has already failed, so a reversed erasure was not merely a no-op,
   * it was INVISIBLE.
   *
   * Detection rather than enforcement, and that is the design rather than a compromise:
   *
   *   - Refusing to STORE a payload whose digest was once shredded poisons a content address for
   *     the whole space, and breaks a program that legitimately recomputes the same output.
   *   - Refusing to SERVE the shredded record while identical bytes are readable through a newer
   *     one protects the paper trail rather than the person, and makes a broken guarantee look
   *     intact, the failure this codebase names in the sandbox design.
   *
   * So the honest move is to report the true fact ("this erasure was undone") instead of the
   * misleading one ("this record is erased"), and to put it where an operator asks rather than on
   * the read path, which costs one `stat` per shred instead of a query per artifact read.
   *
   * Pages to exhaustion and reports `complete`, because a partial list of erasures read as a
   * population would say "all erasures hold" about a space nobody finished scanning.
   */
  async erasures(opts: { onlyUndone?: boolean } = {}): Promise<{
    erasures: ErasureStatus[];
    checked: number;
    complete: boolean;
  }> {
    const view = await readRegistry<Record<string, unknown>>(
      (limit, after) => this.query({ kind: SHRED }, limit, { dir: "desc", after }),
      (_body, r) => r.id,
    );
    const out: ErasureStatus[] = [];
    for (const [shredId, rec] of view.entries) {
      const b = rec.body as Record<string, unknown>;
      const digest = typeof b.digest === "string" ? b.digest : "";
      if (!digest) continue;
      // The whole check: a marker plus present bytes means the erasure was reversed. Derived, so it
      // cannot drift from the thing it describes and nothing has to be kept up to date.
      const holds = (await this.blobs.stat(digest)) === null;
      if (opts.onlyUndone && holds) continue;
      out.push({
        shredId,
        artifactId: String(b.artifactId ?? ""),
        digest,
        reason: String(b.reason ?? ""),
        at: String(b.at ?? ""),
        method: String(b.method ?? ""),
        holds,
      });
    }
    return { erasures: out, checked: view.entries.size, complete: view.complete };
  }

  /** Un-stick an expired lease: force it back to available (attempt +1). Only if the lease
   *  has actually expired; never disturbs a valid lease. Returns whether it applied. */
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
   * **clean successor**: same kind + body, taint forced `false` (overriding propagation), with the
   * tainted original as its data parent (audit trail). Downstream work should consume the successor.
   * Grant-gated to operators via the `/ops/*` boundary. Returns the successor id, or null if absent.
   */
  async declassify(
    recordId: string,
    principal?: string,
    opts: { labels?: string[] } = {},
  ): Promise<{ id: string; cleared: string[]; remaining: string[] } | null> {
    const rec = await this.storage.getRecord(recordId);
    if (!rec) return null;
    // PER LABEL. Clearing everything was the only option while taint was one bit, and it made a
    // clearance say "this is fine now" without saying what it was fine FOR. Naming the labels lets
    // an operator clear the one they reviewed and leave the rest standing, which is the difference
    // between a decision and a blanket.
    const present = rec.runtimeMeta.taint;
    // `reserved: true`: an operator may name `unknown` here. Refusing it would leave a pre-labels
    // record permanently unclaimable by anything that states a barrier, with no remedy.
    const cleared = opts.labels
      ? normalizeTaint(opts.labels, { reserved: true }).filter((l) => present.includes(l))
      : present;
    const remaining = present.filter((l) => !cleared.includes(l));
    // ATTRIBUTED. Declassify is the one operation whose whole purpose is accountability (it is
    // the human decision that lets untrusted data reach a side-effecting worker), so it must name
    // who made it. Writing it with no principal made `created_by` (and the event's `runId`) the
    // space's own identity, leaving the clearance anonymous: the successor said what was cleared
    // and never who cleared it. A tamper-evident event log over that record would have protected
    // the wrong fact.
    //
    // Recorded as its own operation rather than an ordinary `put`, so a clearance is greppable in
    // the event log instead of hiding among every other write.
    const out = await this.putRaw({ kind: rec.kind, body: rec.body, parentIds: [recordId] }, undefined, {
      taint: remaining,
      principal,
      // WHICH labels were cleared, in the event itself: "cleared of what" is the question an
      // auditor asks, and a clearance that only says "declassified" cannot answer it.
      event: { operation: "declassify", detail: { declassifiedFrom: recordId, cleared, remaining } },
    });
    return { ...out, cleared, remaining };
  }

  private compile(pattern: Pattern): CompiledMatch {
    // Validates predicate/order_by paths against the kind's declaration; throws RadiaError
    // (undeclared_path, unknown_kind, unsortable_path, ...).
    //
    // The scan budget rides on the compiled pattern rather than on every read's signature, because
    // this is the one place every read passes through and because the adapter is where rows are
    // counted. A limit the storage port cannot see is a limit on nothing.
    //
    // 0 means UNBOUNDED, and it has to be translated here rather than passed through: the adapters
    // refuse once `examined >= scanBudget`, so a literal 0 would refuse every inexact read after its
    // first chunk — the exact opposite of what an operator disabling a limit is asking for.
    const budget = this.ctx.maxScanRows > 0 ? this.ctx.maxScanRows : undefined;
    return { ...compilePattern(pattern, this.kinds.get(pattern.kind)), scanBudget: budget };
  }

  /**
   * Compile, and if the kind registry turns out to be STALE, re-read that one kind and try again.
   *
   * The registry is a projection over `kind_def` records, and `loadKinds` runs once at startup. With
   * a single process that is complete; with N instances over one database it is not, because
   * `put` registers a declaration in the writing PROCESS's registry only. A kind declared through
   * instance A was then unknown to B until B restarted, and a kind REDECLARED on A left B compiling
   * against the old contract — so a query naming a newly indexed path failed on B and succeeded on
   * A, which is a correctness gap rather than a freshness one.
   *
   * Driven by the SYMPTOM rather than by a timer, which is what makes it cover both cases at once
   * and cost nothing when nothing is stale: `unknown_kind` and `undeclared_path` are exactly the two
   * errors a stale registry produces, and both are recoverable by re-reading one record. A periodic
   * refresh would have a staleness window by construction and would poll forever to close a gap that
   * is usually not open.
   *
   * Writes never needed this. One GIN index serves every path (`pgbase.ts`), so a record put through
   * an instance that has never heard of its kind is still fully indexed and still matchable — the
   * declaration governs COMPILATION, not physical storage. That is why this is a read-path fix.
   *
   * ONE retry, and a second failure is returned to the caller: past the refresh the error is a real
   * client error (a genuinely undeclared kind, a genuinely undeclared path), and retrying again
   * would turn a 400 into a loop. The cost of a miss is one indexed `limit 1` read on a request that
   * was going to fail anyway.
   */
  private async compileFresh(pattern: Pattern): Promise<CompiledMatch> {
    try {
      return this.compile(pattern);
    } catch (e) {
      const code = e instanceof RadiaError ? e.code : "";
      if (code !== "unknown_kind" && code !== "undeclared_path") throw e;
      if (!(await this.refreshKind(pattern.kind))) throw e;
      return this.compile(pattern);
    }
  }

  /**
   * Re-read ONE kind's declaration and adopt it if it is newer. Returns whether anything changed.
   *
   * Exact and bounded (`limit 1, dir desc` on an indexed field), which is the SAFE shape of a
   * registry read: the dangerous shape is a bounded read whose result is treated as a population,
   * and one row keyed by name is not that. `loadKinds` stays the paging read, because "every kind"
   * genuinely is a population.
   */
  private async refreshKind(kind: string): Promise<boolean> {
    if (kind === KIND_DEF) return false; // the meta-kind is defined in code; nothing to re-read
    let rows: RadiaRecord[];
    try {
      rows = await this.query({ kind: KIND_DEF, match: { kind } }, 1, { dir: "desc" });
    } catch {
      return false; // a storage error here must surface as the ORIGINAL compile error, not as this
    }
    if (rows.length === 0) return false;
    let def: KindDef;
    try {
      def = this.kindDefFromBody(rows[0].body);
    } catch {
      return false; // a malformed persisted declaration is not an improvement on what we have
    }
    const current = this.kinds.get(def.kind);
    if (current && JSON.stringify(current) === JSON.stringify(def)) return false;
    this.kinds.register(def);
    await this.prepareStorageFor(def);
    return true;
  }

  private ref(lease: Lease, principal?: string): LeaseRef {
    // `expectOwner` travels to the adapter rather than being checked here, so the comparison
    // happens inside the settle's transaction, AFTER the stored idempotent response is consulted.
    // Checked here it turned a legitimate owner's retry of a succeeded op into `lease_lost` once
    // the record had been reclaimed. Privileged/in-process callers own everything and set nothing.
    const expectOwner = principal && !this.isPrivileged(principal) ? principal : undefined;
    return { recordId: lease.recordId, leaseId: lease.leaseId, epoch: lease.epoch, expectOwner };
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
    const caller = principal ?? this.ctx.principal;
    // Scoped to the DURABLE identity behind the caller, not the caller (audit Package U). A run
    // token is re-minted on every worker restart and on expiry, so a key scoped to `run:*` dedupes
    // nothing that matters: the retry that needs the stored row is exactly the one arriving under
    // a fresh run. The agent behind a run is immutable, and `agentForRun` falls back to reading
    // the space, so the scope survives a runtime restart too. An unresolvable run scopes to
    // itself: no dedupe, never a shared scope.
    const scope = caller.startsWith("run:") ? (await this.agentForRun(caller)) ?? caller : caller;
    return {
      principal: scope,
      operation,
      key,
      requestHash: await sha256Hex(JSON.stringify(request)),
    };
  }
}
