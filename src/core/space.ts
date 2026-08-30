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
  ARTIFACT,
  parseTaintAllowlist,
  SHRED,
  type ArtifactDef,
  assertKnownKindDefFields,
  incompatibleChanges,
  assertReservedCompatible,
  AUTHORIZATION_KINDS,
  GRANT,
  type GrantDef,
  type GrantOp,
  isClaimable,
  KIND_DEF,
  type KindDef,
  kindDefKey,
  KindRegistry,
  META_RESERVED,
  OIDC_IDENTITY,
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
import {
  CredentialStore,
  type Delegation,
  type DelegatedGrant,
  hashToken,
  mintCredential,
  type ResolvedToken,
} from "./auth.ts";
import { Coalescer } from "./coalesce.ts";
import { type CompactionResult, type GcHost, keyOf, newSweepState, RUNTIME_KEYS } from "./gc.ts";
import * as sweeps from "./gc.ts";
import { type BlobGcResult, type BlobStore, MemoryBlobStore, type RewrapResult } from "../storage/blobs.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
import * as authz from "./authorization.ts";
import type { AuthorizationHost } from "./authorization.ts";
import * as identity from "./identity.ts";
import type { DelegatedRunMint, IdentityHost } from "./identity.ts";
import { activeByKey, activeSet, grantKey, isRetired, newestByKey, oidcIdentityKey, opsGrantKey, readExhaustively, type RegistryView } from "./registry.ts";
import { type OidcConfig, OidcVerifier } from "./oidc.ts";
import { httpGetJson } from "../platform.ts";
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
  type UploadGrant,
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
import { type ChainHost, type IntegrityReport, SEAL_BATCH, type SealKey } from "./seal.ts";
import * as chain from "./seal.ts";
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
  /** OIDC trust anchors (design-auth.md "OIDC"). `null` (the default) disables the endpoint.
   *  Config, like `operators`: the issuer set cannot be a record written by the thing it
   *  authenticates. */
  oidc: OidcConfig | null;
  /** ACTIVE runs one OIDC subject may hold at once. `POST /v0/sessions/oidc` requires no
   *  credential, so without a ceiling one leaked (or self-issued-by-a-hostile-IdP) identity
   *  appends permanent `agent_run` records at network speed. Sign-ins are rare; 8 concurrent
   *  sessions per person is generous. */
  maxOidcRunsPerSubject: number;
  /** How long an UNREFERENCED blob must sit untouched before blob GC may take it (plan-gc.md
   *  phase 4). This window is the whole cross-process race answer: `putArtifact` writes bytes
   *  before committing the record, and a deduped put refreshes the blob's clock, so a blob
   *  younger than this is treated as live whatever the record store says — including a put from
   *  a SECOND process over the same blob directory. Minutes, not seconds: it has to dwarf any
   *  bytes-to-commit gap, and blobs eligible today are eligible on the next sweep too. */
  blobGcGraceSeconds: number;
  /**
   * Writes to ONE keyed registry kind before that kind is compacted inline, or `0` to leave
   * compaction to the `gc` verb.
   *
   * Separate from `gcEveryWrites`, and per KIND, because the two measure different litter. Retention
   * litter accrues per write of any kind, so a global counter tracks it; registry litter accrues per
   * write of a KEYED kind, and a space streaming chunks would otherwise trigger compaction walks
   * over registries nothing touched. Counting per kind makes the trigger proportional to the mess:
   * the walk that runs is over the registry that just grew.
   *
   * Sized against the measurement (agent_docs/plan-registry-cost.md): a registry read is linear in
   * history, and compaction makes it exactly flat, so the value of running early is the whole
   * point. 200 writes of one kind is a pass over a small history, which is milliseconds.
   */
  compactEveryWritesPerKind: number;
  /**
   * Grant RECORDS one (principal, kind) may accumulate, history included.
   *
   * `Space.access` reads that history on EVERY authorized request and `GRANT` is in `NEVER_COMPACT`,
   * so nothing ever sweeps it: measured, `authorize()` costs 1.72ms at 1 record and 93.57ms at 5,000
   * on Postgres (5.5x worse than SQLite at the tail). This is the same rule as
   * `maxInterestsPerPrincipal` and the same sentence behind it: a registry whose size is somebody
   * else's read cost needs a per-principal ceiling. See agent_docs/plan-registry-cost.md.
   *
   * Counted in RECORDS rather than live entries, because history is what the read pays for: one
   * live grant behind 4,999 retirements costs the same 93ms as 5,000 live ones.
   */
  maxGrantRecordsPerPrincipalKind: number;
  /**
   * Ops-power RECORDS one principal may accumulate, history included.
   *
   * The same rule as the grant ceiling above and for the same measured reason, on the registry the
   * OPS-PLANE GATE reads: `Space.opsPowers` walks a principal's whole `ops_grant` history on every
   * `/v0/ops/*` request, and the kind is in `NEVER_COMPACT` because a power's assignment history is
   * audit. A registry is either compactable or capped, never neither
   * (agent_docs/plan-bounded-reads.md).
   *
   * Lower than the grant ceiling because the healthy number is far smaller: an identity here is
   * (principal, sorted operations) over a CLOSED five-power vocabulary, so at most 31 exist per
   * principal and a real deployment holds one or two. Anything above this is republishing.
   */
  maxOpsGrantRecordsPerPrincipal: number;
  /** How far ahead a writer may push `availableAt` (`PutRequest.availableAt`). A ceiling rather
   *  than a preference: retention GC never sweeps unclaimed CLAIMABLE work, so a record made
   *  available in the year 2400 is litter no sweep can reach. `0` refuses any delay. */
  maxPutDelaySeconds: number;
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
  oidc: null, // opt-in: an unconfigured space refuses /v0/sessions/oidc
  maxOidcRunsPerSubject: 8,
  blobGcGraceSeconds: 900, // 15 min; see the field's comment for why this is the race bound
  // 200 writes of one keyed kind. Well under the point where a registry read starts to cost
  // (2,000 history is already 976 KiB to learn 20 entries), and each pass at that size is a
  // handful of milliseconds.
  compactEveryWritesPerKind: 200,
  // 256, from the measured curve: 100 records keeps `authorize()` at 2.90ms (1.7x baseline) and
  // 1,000 costs 16ms, so this holds the hot path near baseline while leaving years of ordinary
  // churn (content-keying dedupes a re-assignment inside the idempotency window, so normal
  // operation adds about one record per week per pair).
  maxGrantRecordsPerPrincipalKind: 256,
  // 64, well above the 31 distinct identities that can exist and far below where the read starts to
  // cost (measured: 100 records is 2.90ms, 1.7x baseline). `maxInterestsPerPrincipal` uses the same
  // number for the same reason.
  maxOpsGrantRecordsPerPrincipal: 64,
  // 7 days, the idempotency window's horizon, and picked for the same reason: past it the caller
  // is describing a schedule rather than deferring a piece of work, and Radia does not hold one
  // (plan-milestones.md, "durable timers", out of scope).
  maxPutDelaySeconds: 7 * 24 * 3600,
};

/** What one event-log retention pass did (`Space.gcEvents`; rides the `gc` verb). */
import type { EventGcResult, GcReport } from "../../sdk/ts/wire.ts";
import { getLogger } from "../log.ts";
export type { EventGcResult, GcReport };

/** How a caller selects work to take. */
export type TakeInput =
  | { pattern: Pattern }
  | { recordId: string; pattern?: Pattern };

/** A read's answer plus WHAT WAS APPLIED to produce it, so the wire can report its narrowing. */
export interface ScopedRead {
  pattern: Pattern;
  constraint: Record<string, unknown>[] | null;
  createdBy?: string[];
}

/**
 * The space bound to one principal: every verb consults that principal's grants. Obtained from
 * `Space.as(principal)`; holding one is holding the AUTHORIZED API, so a caller cannot skip a
 * check per call. The raw verbs on `Space` are the runtime's own, attribution-only counterparts.
 */
export interface ActingSpace {
  readonly principal: string;
  put(req: PutRequest, idempotencyKey?: string): Promise<{ id: string }>;
  take(sel: TakeInput, opts?: TakeOptions): Promise<TakeResult | null>;
  ack(lease: Lease, result?: PutRequest, idempotencyKey?: string): Promise<AckResult>;
  nack(lease: Lease, opts?: { backoffSeconds?: number }, idempotencyKey?: string): Promise<SettleResult>;
  release(lease: Lease, idempotencyKey?: string): Promise<SettleResult>;
  renew(lease: Lease, opts?: TakeOptions, idempotencyKey?: string): Promise<RenewResult>;
  createWatch(request: Pattern): Promise<{ watchId: string }>;
  putArtifact(bytes: Uint8Array, meta: ArtifactMeta, idempotencyKey?: string): Promise<{ id: string; digest: string; size: number }>;
  /** The pre-payload half of an artifact write: may this principal put a record shaped like `body`?
   *  Throws `forbidden` when there is no put grant at all. */
  mayPut(kind: string, body: unknown): Promise<boolean>;
  query<T = unknown>(pattern: Pattern, limit?: number, page?: Page): Promise<{ records: RadiaRecord<T>[] } & ScopedRead>;
  readOne(pattern: Pattern): Promise<{ record: RadiaRecord | null } & ScopedRead>;
  registryOf(kind: string, match?: Record<string, unknown>): Promise<{ entries: RadiaRecord[]; complete: boolean; scanned: number; constraint: Record<string, unknown>[] | null; createdBy?: string[] }>;
  artifactGate(): Promise<(rec: RadiaRecord | null | undefined) => "ok" | "not_found" | "forbidden">;
}

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


interface GrantAccess {
  /** Operator or the space itself: no grant is read and nothing constrains it. Never true for a
   *  delegated run, whose mint refuses a privileged agent. */
  privileged: boolean;
  /** Set when the principal is a delegated run; `defs` then came from its own `agent_run` body. */
  delegated?: Delegation;
  defs: GrantDef[];
  complete: boolean;
  scanned: number;
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

import type { EffectivePermissions, MintedRun, RunRenewal, TreeEntry } from "../../sdk/ts/wire.ts";
export type { EffectivePermissions, MintedRun, RunRenewal, TreeEntry };
export { DELEGABLE_PREFIX, delegablePrincipal, intersectGrants } from "./identity.ts";
export type { DelegatedRunMint };

/** One shred, and whether it still means anything. */
import type { ErasureReport, ErasureStatus, ShredResult } from "../../sdk/ts/wire.ts";
export type { ErasureReport, ErasureStatus, ShredResult };

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
  /** Collapses the identical reads a wakeup burst produces: one `notify()` resumes every parked
   *  watch stream in the same tick, and they all ask for the same events and the same record
   *  (`core/coalesce.ts`, agent_docs/plan-scaling.md). Single-flight, so nothing is ever cached
   *  past the read it belongs to. */
  private readonly reads = new Coalescer();
  /** How far the cross-instance poll has read the event log. `undefined` until the first poll,
   *  which is why that first one always reports a change (see `pollForForeignChanges`). */
  private changeCursor?: string;
  private readonly watches = new Map<string, Watch>();
  /**
   * Live download capabilities: token -> the one artifact it opens, and when it lapses. In
   * memory and short-lived by design. A capability is a delegation of a read the caller already
   * held, not a credential, and it must not outlive the process that issued it.
   *
   * Short-lived download capabilities (`core/artifacts.ts`). Process-local by design.
   */
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
    // ANCHORED on the declaration this one supersedes, the way `RadiaClient.grant` anchors a
    // revival. `kindDefKey` is content-derived, which is right for "declare the same thing twice"
    // and WRONG for restoring a declaration that was superseded: the key replays the earlier
    // identical record, so the call reports success and writes nothing, the in-memory registry
    // shows the restored def, and a restart reverts it. Measured before this: drop a path with an
    // acknowledged redeclaration, put it back, and the kind had two paths until reload and one
    // after. Phase 2 is what made drop-then-restore an ordinary thing to do
    // (agent_docs/plan-schema-versioning.md).
    //
    // The two mechanisms compose: the anchor makes a RESTORE write, and the absorb in
    // `checkKindDefBudget` still answers an identical live re-put without writing, so a fleet
    // redeclaring its kinds on every start costs nothing.
    const newest = await this.query({ kind: KIND_DEF, match: { kind: def.kind } }, 1, { dir: "desc" });
    const anchor = newest.length ? `:after:${newest[0].id}` : "";
    await this.put({ kind: KIND_DEF, body: def }, `${kindDefKey(def)}${anchor}`);
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
  private async registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
    scope?: StatsScope,
  ): Promise<RegistryView> {
    const { records, complete, scanned } = await readExhaustively(
      (page) => this.query({ kind, match }, page.limit, page, scope),
    );
    // LAZY, and that is not a micro-optimization. This function is the AUTHORIZATION HOT PATH:
    // `access` reads a principal's grants through it on every authorized request, unmemoized, and
    // that read is the one measured at 93ms against 5,000 grant records
    // (agent_docs/plan-registry-cost.md). Counting eagerly added a third pass with a `keyOf` call
    // per record to every one of those, to serve one caller (`loadKinds`) that wants a version.
    let memo: Map<string, number> | undefined;
    return {
      entries: activeByKey<T>(records, keyOf),
      newest: newestByKey<T>(records, keyOf),
      get counts() {
        if (memo) return memo;
        memo = new Map<string, number>();
        for (const r of records) {
          const k = keyOf(r.body as T, r);
          if (k !== undefined) memo.set(k, (memo.get(k) ?? 0) + 1);
        }
        return memo;
      },
      complete,
      scanned,
    };
  }

  /**
   * THE CURRENT SET of a keyed registry kind: newest per key, retirements dropped, read to
   * exhaustion, and honest when it could not exhaust.
   *
   * The point is what the caller does NOT supply. No direction, no cursor, no page size, and no key
   * function: the key comes from what the kind DECLARES (`contentKey`, or the runtime's own key for
   * a reserved kind), which is the same statement `radia gc` compacts by. Every reader otherwise
   * restated it as a `keyOf` closure, so the key existed twice per registry with nothing checking
   * they agreed, and a disagreement is silent in the worst direction: `gc` deletes by its key while
   * readers project by theirs (agent_docs/plan-bounded-reads.md).
   *
   * It also gives PYTHON a correct path at all. That SDK has `query_all` and no projection, so a
   * Python caller wanting the current set had to hand-roll latest-wins, which is the shape no guard
   * can see and which `radia runs --for` got wrong three ways at once.
   *
   * COST: one walk of the kind, which is flat because keyed registries compact themselves
   * (`compactEveryWritesPerKind`). That flatness is the whole reason this is allowed to be a
   * server-side read: a read whose cost the caller cannot see is acceptable only when that cost
   * does not grow (plan-registry-cost.md). It reports `complete: false` rather than a plausible
   * prefix if the walk is capped.
   *
   * A caller that must SEE a retirement uses `queryAll` instead: this answers what is in force.
   */
  async registryOf(
    kind: string,
    match?: Record<string, unknown>,
    scope?: StatsScope,
  ): Promise<{ entries: RadiaRecord[]; complete: boolean; scanned: number }> {
    const paths = RUNTIME_KEYS[kind] ?? this.kinds.get(kind)?.contentKey;
    if (!paths || paths.length === 0) {
      throw new RadiaError(
        "kind_not_keyed",
        `kind '${kind}' declares no contentKey, so it has no latest-wins identity to project. ` +
          `Declare one, or read it with an ordinary query.`,
      );
    }
    const view = await this.registry<unknown>(kind, (_b, rec) => keyOf(rec, paths), match, scope);
    return { entries: [...view.entries.values()], complete: view.complete, scanned: view.scanned };
  }

  /** `registryOf`, principal-driven: the third read beside `queryAs`/`readOneAs`, under the same
   *  `query` op, because a registry projection is a read like any other and a rule that binds two
   *  of the three doors is the recurring class this whole move closes. */
  async registryOfAs(
    principal: string,
    kind: string,
    match?: Record<string, unknown>,
  ): Promise<{ entries: RadiaRecord[]; complete: boolean; scanned: number; constraint: Record<string, unknown>[] | null; createdBy?: string[] }> {
    const { constraint, createdBy } = await this.readAccess(principal, "query", kind);
    const scoped = constraint ? combineMatch(match, constraint) : match;
    const out = await this.registryOf(kind, scoped, createdBy ? { createdBy } : undefined);
    return { ...out, constraint, createdBy };
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
      this.kinds.register(def, view.counts.get(def.kind) ?? 1);
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

  // ---- authorization (authorization.ts) ----
  //
  // The decisions live in `authorization.ts` behind `AuthorizationHost`, the same shape
  // `flows`/`artifacts`/`inspection` already use. These stay as the facade every handler holds.

  /** What this module needs from the space: reads and immutable config, never a writer. */
  private get authzHost(): AuthorizationHost {
    return {
      creds: this.creds,
      ctx: this.ctx,
      kinds: { get: (k) => this.kinds.get(k) },
      storage: { getRecord: (id) => this.storage.getRecord(id) },
      registry: (kind, keyOf, match, scope) => this.registry(kind as string, keyOf as never, match, scope as never),
      runRecord: (run) => this.runRecord(run),
      opsPowers: (principal) => this.opsPowers(principal),
      delegableSection: (agent) => this.delegableSection(agent),
      compile: (pattern) => this.compile(pattern),
    };
  }

  grantSubject(principal: string): string {
    return authz.grantSubject(this.authzHost, principal);
  }

  private delegationOf(principal: string): Promise<Delegation | undefined> {
    return authz.delegationOf(this.authzHost, principal);
  }

  isPrivileged(principal: string): boolean {
    return authz.isPrivileged(this.authzHost, principal);
  }

  authorize(principal: string, op: GrantOp, kind: string): Promise<Record<string, unknown>[] | null> {
    return authz.authorize(this.authzHost, principal, op, kind);
  }

  private access(principal: string, kind?: string): Promise<authz.GrantAccess> {
    return authz.access(this.authzHost, principal, kind);
  }

  authorScope(principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
    return authz.authorScope(this.authzHost, principal, op, kind);
  }

  taintBarrier(principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
    return authz.taintBarrier(this.authzHost, principal, op, kind);
  }

  readAccess(principal: string, op: GrantOp, kind: string): Promise<authz.ReadAccess> {
    return authz.readAccess(this.authzHost, principal, op, kind);
  }

  authorAllows(createdBy: string[] | undefined, record: { runtimeMeta: { createdBy: string } }): boolean {
    return authz.authorAllows(this.authzHost, createdBy, record);
  }

  private runPrincipalsOf(subject: string, principal: string): Promise<string[]> {
    return authz.runPrincipalsOf(this.authzHost, subject, principal);
  }

  effectivePermissions(principal: string): Promise<EffectivePermissions> {
    return authz.effectivePermissions(this.authzHost, principal);
  }

  authorizeWatch(principal: string, kind: string): Promise<authz.ReadAccess> {
    return authz.authorizeWatch(this.authzHost, principal, kind);
  }

  bodyMatchesGrant(kind: string, body: unknown, patterns: Record<string, unknown>[]): boolean {
    return authz.bodyMatchesGrant(this.authzHost, kind, body, patterns);
  }

  private deriveDelegation(owner: string, leasedRecordId: string): Promise<DelegationContext | undefined> {
    return authz.deriveDelegation(this.authzHost, owner, leasedRecordId);
  }

  private computeTaint(parentIds: string[], clientRaise: string[] | undefined, writer: string): Promise<string[]> {
    return authz.computeTaint(this.authzHost, parentIds, clientRaise, writer);
  }

  // ---- the credential chain (identity.ts) ------------------------------------------------
  //
  // Definitions, runs, delegation and OIDC all live in `identity.ts` behind `IdentityHost`. These
  // stay as the facade every handler and the CLI hold.

  /** The fetcher behind OIDC's JWKS/discovery reads. A field so tests point it at an in-repo
   *  issuer or a stub; the default is the platform seam's one outbound-HTTP function. */
  oidcFetch: (url: string) => Promise<unknown> = httpGetJson;
  /** The verifier memo. It lives here rather than in `identity.ts` because its lifetime is this
   *  object's; the module that uses it holds no state of its own. */
  readonly #oidcState: { verifier: OidcVerifier | null } = { verifier: null };

  private get identityHost(): IdentityHost {
    return {
      creds: this.creds,
      ctx: this.ctx,
      storage: this.storage,
      notifier: this.notifier,
      oidcState: this.#oidcState,
      oidcFetch: (url) => this.oidcFetch(url),
      putRaw: (req, key, opts) => this.putRaw(req, key, opts),
      putArtifact: (bytes, meta, key, principal) => this.putArtifact(bytes, meta, key, principal),
      readArtifact: (id) => this.readArtifact(id),
      query: (pattern, limit, page) => this.query(pattern, limit, page as never),
      registry: (kind, keyOf, match) => this.registry(kind as string, keyOf as never, match),
      isPrivileged: (p) => this.isPrivileged(p),
      grantSubject: (p) => this.grantSubject(p),
      delegationOf: (p) => this.delegationOf(p),
      access: (p, kind) => this.access(p, kind),
      readAccess: (p, op, kind) => this.readAccess(p, op, kind),
      authorAllows: (createdBy, rec) => this.authorAllows(createdBy, rec),
      bodyMatchesGrant: (kind, body, c) => this.bodyMatchesGrant(kind, body, c),
      checkGrantPattern: (def) => this.checkGrantPattern(def),
    };
  }

  createAgentDefinition(
    agent: string,
    grants: GrantDef[] = [],
    opts: { supersedes?: string | null } = {},
  ): Promise<{ agent: string; definitionToken: string }> {
    return identity.createAgentDefinition(this.identityHost, agent, grants, opts);
  }

  mintRun(definitionToken: string, opts: { reuse?: boolean } = {}): Promise<MintedRun> {
    return identity.mintRun(this.identityHost, definitionToken, opts);
  }

  mintDelegatedRun(worker: string, recordId: string, presentedToken?: string): Promise<DelegatedRunMint> {
    return identity.mintDelegatedRun(this.identityHost, worker, recordId, presentedToken);
  }

  mintOidcRun(idToken: string): Promise<MintedRun> {
    return identity.mintOidcRun(this.identityHost, idToken);
  }

  renewRun(run: string): Promise<RunRenewal> {
    return identity.renewRun(this.identityHost, run);
  }

  stopRun(run: string, opts: { quarantine?: boolean; by?: string } = {}): Promise<{ applied: boolean; quarantined: number }> {
    return identity.stopRun(this.identityHost, run, opts);
  }

  mintOperatorToken(): Promise<string> {
    return identity.mintOperatorToken(this.identityHost);
  }

  resolveToken(token: string): Promise<ResolvedToken> {
    return identity.resolveToken(this.identityHost, token);
  }

  revokeDefinition(agent: string, opts: { reason?: string } = {}): Promise<{ applied: boolean; alreadyRevoked: boolean }> {
    return identity.revokeDefinition(this.identityHost, agent, opts);
  }

  agentForRun(run: string): Promise<string | undefined> {
    return identity.agentForRun(this.identityHost, run);
  }

  private runRecord(run: string): Promise<identity.RunState | undefined> {
    return identity.runRecord(this.identityHost, run);
  }

  private delegableSection(agent: string): Promise<{ delegable?: { kind: string; operations: GrantOp[] }[] }> {
    return identity.delegableSection(this.identityHost, agent);
  }


  /**
   * A readability predicate for ONE request: "would a `query` or `read_one` reach this record?"
   *
   * This is what makes the ops plane's per-record reads agree with the coordination plane BY
   * CONSTRUCTION rather than by a second implementation of the same rules. The ops plane had only
   * two tiers, `observe` (unscoped, every body in the space) and `createdBy: "self"`, and neither
   * fits a TEAM: a pattern-scoped grant already says which records a principal may read, and a
   * teammate's record fails the self test purely because somebody else authored it. Three apps hit
   * that in turn (agent_docs/research-app-lessons.md).
   *
   * THE DECISION IS TAKEN ONCE PER KIND, not once per record. The grant registry is deliberately
   * never memoized across decisions (a cached grant is how a revocation keeps working), and it is
   * an O(history) read: measured at 93ms per call against 5,000 grant records
   * (agent_docs/plan-registry-cost.md), so a per-record check would make a 200-node graph
   * unusable. Held for the life of ONE request and never beyond, which is the same window the
   * coordination `query` path already resolves a grant for.
   */
  async readFilter(principal: string): Promise<(record: RadiaRecord) => Promise<boolean>> {
    const acc = await this.access(principal);
    if (acc.privileged) return () => Promise.resolve(true);
    // `undefined` = not yet asked, `null` = asked and there is no read grant for that kind.
    const perKind = new Map<string, { constraint: Record<string, unknown>[] | null; createdBy?: string[] }[] | null>();
    return async (record: RadiaRecord) => {
      let allowed = perKind.get(record.kind);
      if (allowed === undefined) {
        const found: { constraint: Record<string, unknown>[] | null; createdBy?: string[] }[] = [];
        // EITHER read op, because they are separate grants and a principal commonly holds one.
        for (const op of ["query", "read_one"] as const) {
          try {
            const { constraint, createdBy } = await this.readAccess(principal, op, record.kind);
            found.push({ constraint, createdBy });
          } catch (e) {
            if (!(e instanceof RadiaError && e.code === "forbidden")) throw e;
          }
        }
        allowed = found.length > 0 ? found : null;
        perKind.set(record.kind, allowed);
      }
      if (!allowed) return false;
      for (const { constraint, createdBy } of allowed) {
        if (!this.authorAllows(createdBy, record)) continue;
        if (!constraint || this.bodyMatchesGrant(record.kind, record.body, constraint)) return true;
      }
      return false;
    };
  }

  /** DB clock passthrough (health, diagnostics). */
  now(): Promise<string> {
    return this.storage.now();
  }

  /**
   * The put-grant check both write paths share: `put` runs it eagerly, `ack` defers it to storage
   * so an idempotent replay skips it (audit package W5). ONE implementation, so a body-level rule
   * added here reaches records, artifact records and ack results alike; before this, the same rule
   * lived once in the handler and once here, which is how package Y's class recurs.
   */
  private async checkPutGrant(principal: string, kind: string, body: unknown, noun: "record" | "result"): Promise<void> {
    const constraint = await this.authorize(principal, "put", kind);
    if (constraint && !this.bodyMatchesGrant(kind, body, constraint)) {
      throw new RadiaError(
        "forbidden",
        noun === "record"
          ? `record body is outside the pattern scope of your put grant for '${kind}'`
          : `result body is outside the pattern scope of the put grant for '${kind}'`,
      );
    }
  }

  /**
   * The RUNTIME's own write. No grant is consulted: authority lives on the handle `as(principal)`
   * returns, and the ledger in `test/layering.test.ts` names every raw call in `src/`. `author` is
   * ATTRIBUTION only (whose name `created_by` carries), which is what fixtures planting authorship
   * always meant and what the retired `{unchecked: "why"}` escape existed to say.
   */
  async put(
    req: PutRequest,
    idempotencyKey?: string,
    opts: { author?: string } = {},
  ): Promise<{ id: string }> {
    return await this.putEnforced(req, idempotencyKey, undefined, opts.author);
  }

  /** Both put doors: the handle passes `checkedFor` (enforced, and the author), the raw verb only
   *  `author`; with neither, `created_by` defaults to the space's own identity. EAGER, unlike
   *  ack's deferred check: a put RETRY after a narrowed grant has always answered 403 rather than
   *  replaying, and the wire behavior must not change. */
  private async putEnforced(
    req: PutRequest,
    idempotencyKey: string | undefined,
    checkedFor: string | undefined,
    author?: string,
  ): Promise<{ id: string }> {
    if (checkedFor !== undefined) await this.checkPutGrant(checkedFor, req.kind, req.body, "record");
    const principal = checkedFor ?? author;
    const declared = this.validateReservedBody(req); // throws RadiaError before anything commits
    // Refused before anything commits, and what an ACKNOWLEDGED break costs is carried onto the
    // event, since a break nobody refused is one only the log can still report.
    const broke = declared ? await this.checkRedeclaration(req.body, declared) : [];
    if (req.kind === INTEREST) await this.checkInterestBudget(req, principal);
    const id = await this.putRaw(req, idempotencyKey, {
      principal,
      ...(broke.length ? { event: { detail: { brokePatterns: broke } } } : {}),
    });
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
    // so the space coordinates its own schema through the normal write path (no side table).
    // WRITE PATH ONLY, and deliberately here rather than inside `kindDefFromBody`. BOTH readers of
    // that function swallow a validation failure and keep what they have: `loadKinds` at startup
    // and `refreshKind` on a stale projection. Strictness there would make a stored declaration
    // carrying an unknown field an unloadable kind, and through `refreshKind` a kind declared on
    // ANOTHER INSTANCE would never register on this one.
    if (req.kind === KIND_DEF) {
      assertKnownKindDefFields(req.body);
      const def = this.kindDefFromBody(req.body);
      // Phase 2 (agent_docs/plan-schema-versioning.md): a redeclaration that breaks something
      // already stored is refused unless it says it meant to. Checked HERE, on the write, and
      // deliberately not in `kindDefFromBody`: both readers of that function swallow a validation
      // failure and keep what they have, so a stored declaration that predates this rule still
      // loads at startup rather than becoming an unloadable kind. The rule bounds what is written
      // from now on; it does not retroactively refuse the log.
      // A RETIREMENT is not a redeclaration: `{retired: true}` withdraws the kind and carries no
      // contract, so it drops every indexed path by construction and would fail the check below on
      // every kind that ever had one. Exempt, and the exemption is safe because a retirement stops
      // the kind being registered at all rather than replacing what it declares.
      return def;
    }
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
    // An oidc_identity maps an IdP identity to the principal grants bind to (design-auth.md
    // "OIDC"). The privileged refusal is the same wall createAgentDefinition holds: OIDC mints
    // runs from these mappings, and a mapping naming an operator would make the IdP an
    // operator-minting oracle.
    if (req.kind === OIDC_IDENTITY) {
      const m = req.body as { iss?: unknown; sub?: unknown; principal?: unknown };
      for (const f of ["iss", "sub", "principal"] as const) {
        if (typeof m?.[f] !== "string" || (m[f] as string).length === 0) {
          throw new RadiaError("invalid_oidc_identity", `oidc_identity.${f} must be a non-empty string`);
        }
      }
      if (!(m.principal as string).startsWith("human:")) {
        throw new RadiaError("invalid_oidc_identity", "oidc_identity.principal must start with 'human:' (an IdP authenticates people)");
      }
      if (this.isPrivileged(m.principal as string)) {
        throw new RadiaError(
          "invalid_oidc_identity",
          `'${m.principal}' is a privileged principal; an OIDC mapping may not name it (OIDC must never mint an operator)`,
        );
      }
    }
    return undefined;
  }

  /**
   * Cap the grant HISTORY one (principal, kind) may accumulate.
   *
   * `Space.access` re-reads that history on every authorized request and nothing can ever sweep it
   * (`GRANT` is in `NEVER_COMPACT`, because compacting it would break the revival protocol's
   * `:after:` anchor). So an unbounded history is a permanent, unrecoverable tax on the hot path:
   * 93.57ms per `authorize()` at 5,000 records on Postgres, against 1.72ms at one.
   *
   * Counted in RECORDS, not live entries: one live grant behind 4,999 retirements costs the reader
   * exactly as much as 5,000 live ones, and `scanned` is the number the reader actually pays.
   *
   * WHAT THIS IS AIMED AT is a fleet republishing grants in a loop, which gotchas.md records
   * happening once. Ordinary operation cannot reach the ceiling: a re-assignment dedupes inside the
   * idempotency window, so it adds about one record per pair per week.
   *
   * AT THE CEILING, A RE-PUT OF A LIVE IDENTICAL GRANT IS NOT WRITTEN, and that is the difference
   * between bounding history and only bounding distinct identities. Content-keying dedupes a re-put
   * inside the idempotency window (7 days) and NOT past it, so a fleet restarting weekly appends one
   * record per pair per restart forever, and exempting it (the obvious way to keep restarts working)
   * left the ceiling unable to bound the very case it was built for: measured, 40 re-puts of one
   * identity sailed past a ceiling of 10. Answering with the record that already carries that grant
   * keeps the restart working AND stops the growth, and it is the same answer idempotency gives
   * inside the window. Below the ceiling nothing changes: every write lands, as before.
   */
  private async checkGrantBudget(req: PutRequest, o: { absorb?: boolean } = {}): Promise<{ satisfiedBy: string } | undefined> {
    const b = (req.body ?? {}) as { principal?: unknown; kind?: unknown };
    if (typeof b.principal !== "string" || typeof b.kind !== "string") return;
    return await this.checkRegistryBudget(req, {
      kind: GRANT,
      // The MATCH the expensive read uses, which is what decides the ceiling's granularity:
      // `Space.access` narrows to (principal, kind), so that pair is what accumulates.
      match: { principal: b.principal, kind: b.kind },
      identityOf: grantKey,
      ceiling: this.ctx.maxGrantRecordsPerPrincipalKind,
      code: "too_many_grants",
      subject: `'${b.principal}' on kind '${b.kind}'`,
      reader: "every authorized request",
      cause: "something is assigning NEW grant identities in a loop (a changing pattern, most likely)",
      absorb: o.absorb,
    });
  }

  /**
   * Cap the ops-power history one principal may accumulate.
   *
   * `Space.opsPowers` reads it per principal, exhaustively, on EVERY `/v0/ops/*` request (the gate in
   * `server/http.ts`), and `OPS_GRANT` is in `NEVER_COMPACT` because the assignment history of a
   * power is audit. That is the same unsweepable-hot-path shape as `grant`, measured at 1.72ms for
   * one record and 93.57ms at 5,000 on Postgres, and the grant ceiling covered `grant` alone.
   *
   * What reaches it: assigning powers ON A SCHEDULE. `examples/analysis/run.ts` calls `grantObserve`
   * for every enrolled principal on every launch, so past the idempotency window each launch appends
   * one record per person, forever. That is the shape gotchas.md already warns about, running in a
   * shipped example against the one registry with no ceiling.
   *
   * A distinct identity here is (principal, sorted operations) over a CLOSED five-power vocabulary,
   * so a principal has at most 31 of them and cannot blow the ceiling by inventing new ones. Reaching
   * it therefore means history, always.
   */
  private async checkOpsGrantBudget(req: PutRequest, o: { absorb?: boolean } = {}): Promise<{ satisfiedBy: string } | undefined> {
    const b = (req.body ?? {}) as { principal?: unknown };
    if (typeof b.principal !== "string") return;
    return await this.checkRegistryBudget(req, {
      kind: OPS_GRANT,
      match: { principal: b.principal }, // what `opsPowers` narrows to, so what accumulates
      identityOf: opsGrantKey,
      ceiling: this.ctx.maxOpsGrantRecordsPerPrincipal,
      code: "too_many_ops_grants",
      subject: `'${b.principal}'`,
      reader: "every ops-plane request",
      cause: "something is assigning powers on a schedule rather than at identity creation",
      absorb: o.absorb,
    });
  }

  /**
   * The shared ceiling for a registry that can never be compacted.
   *
   * The invariant behind it (agent_docs/plan-bounded-reads.md): **a registry is either compactable or
   * capped, never neither.** An uncompactable one is read in full forever, so its history is a
   * permanent, unrecoverable tax on whoever reads it, and the write is the only place to stop it.
   *
   * Three rules, each with a failure behind it:
   *
   * A WITHDRAWAL is never refused. It is how a caller reduces what the reader projects, and refusing
   * it would trap the state this exists to prevent.
   *
   * AT THE CEILING, a re-put of a LIVE identical entry is answered with the record that already
   * carries it, rather than written. The first version simply exempted such a re-put, and that left
   * the ceiling unable to bound the case it was built for: content-keying dedupes only inside the
   * idempotency window, so a fleet restarting weekly appends one record per entry forever, and
   * measured, 40 re-puts of one identity sailed past a ceiling of 10. Answering with the existing
   * record keeps the restart working and stops the growth. Below the ceiling nothing changes.
   *
   * An INCOMPLETE read refuses rather than guessing. Enforcing a ceiling over a prefix is the
   * bounded-read trap at the one site that exists to prevent registry blowup.
   */
  private async checkRegistryBudget(
    req: PutRequest,
    o: {
      kind: string;
      match: Record<string, unknown>;
      identityOf: (body: unknown) => string | undefined;
      ceiling: number;
      code: string;
      subject: string;
      reader: string;
      cause: string;
      /** False to run the CEILING only. The absorb answers with the record that already carries
       *  this entry, which a settle cannot use: it must name its own result. */
      absorb?: boolean;
    },
  ): Promise<{ satisfiedBy: string } | undefined> {
    if ((req.body as { retired?: unknown })?.retired === true) return;
    const view = await this.registry(o.kind, o.identityOf, o.match);
    if (!view.complete) {
      throw new RadiaError("registry_incomplete", `${o.kind} registry read for ${o.subject} did not complete`);
    }
    // `entries` rather than `newest`, so a RETIREMENT does not read as the entry still standing:
    // a re-put after a withdrawal must revive, which means it must write.
    const identity = o.identityOf(req.body);
    const live = identity === undefined ? undefined : view.entries.get(identity);

    // ABSORB an identical live re-put, ALWAYS rather than only at a ceiling. This is the whole
    // mechanism: content-keying dedupes a re-put for the idempotency window (7 days) and not past
    // it, so a fleet restarting weekly appends one record per entry forever, on kinds nothing can
    // ever sweep. Answering with the record that already carries the entry keeps the restart
    // working and stops the growth at its source, so history only grows on a REAL change, which is
    // also exactly what the audit trail these kinds are excluded from compaction FOR wants to hold.
    //
    // Compared by BODY, never by identity. `grantKey` excludes `scope` (so a self-scoped grant
    // replaces its unscoped twin in place), so one identity can carry two meanings, and absorbing
    // on identity alone dropped a grant that added `scope: {createdBy: "self"}` while reporting
    // success, leaving the wider grant standing. The hash is over the same serialization
    // `buildRecord` stores, so any difference at all writes.
    if (o.absorb !== false && live && live.bodySha256 === await sha256Hex(JSON.stringify(req.body ?? null))) {
      return { satisfiedBy: live.id };
    }

    if (view.scanned < o.ceiling) return;
    // At the ceiling with a live identity and a DIFFERENT body: write anyway. It is a replacement
    // rather than a new entry, and a ceiling must never block a write that REDUCES authority, or a
    // maxed-out pair could not be tightened.
    if (live) return;
    throw new RadiaError(
      o.code,
      `${o.subject} already has ${view.scanned} ${o.kind} records (limit ${o.ceiling}), and ` +
        `${o.reader} re-reads all of them. This kind is never compacted, so that is HISTORY rather ` +
        `than live entries: ${o.cause}.`,
    );
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

  /**
   * Which LIVE patterns a proposed declaration would stop compiling
   * (agent_docs/plan-schema-versioning.md phase 3).
   *
   * Phase 2 classifies a redeclaration STRUCTURALLY: it knows a path was dropped. This answers the
   * question that follows, and it is the one an operator actually has: dropped for whom. A grant
   * whose pattern no longer compiles stops matching, an interest stops routing, and a watch stops
   * waking, all of them silently and all of them fail-closed, which is the combination that makes
   * this worth naming at the write rather than discovering later.
   *
   * BOUNDED and read at the moment of the declaration: grants and interests for this one kind,
   * plus this instance's own watches. Watches are process-local by design, so on several instances
   * this reports the ones HERE and says so rather than implying it saw them all.
   */
  async patternsBrokenBy(def: KindDef): Promise<{ what: string; who: string; why: string }[]> {
    const broken: { what: string; who: string; why: string }[] = [];
    const check = (what: string, who: string, pattern: Pattern) => {
      try {
        compilePattern(pattern, def);
      } catch (e) {
        // Only a pattern the DECLARATION breaks. Anything else (a malformed stored pattern, a
        // limit) is not this declaration's doing and reporting it here would blame the wrong write.
        if (e instanceof RadiaError && (e.code === "undeclared_path" || e.code === "unsortable_path")) {
          broken.push({ what, who, why: e.message });
        }
      }
    };
    const grants = await this.registry<GrantDef>(GRANT, grantKey, { kind: def.kind });
    for (const rec of grants.entries.values()) {
      const g = rec.body as GrantDef;
      if (g.kind !== def.kind || !g.pattern) continue;
      check("grant", `${g.principal} (${g.operations.join(",")})`, { kind: def.kind, match: g.pattern });
    }
    const { interests } = await this.liveInterests(def.kind);
    for (const i of interests) {
      if (i.match) check("interest", i.agent ?? i.run, { kind: def.kind, match: i.match });
    }
    for (const w of this.watches.values()) {
      if (w.request.kind === def.kind) check("watch", w.owner, w.request);
    }
    return broken;
  }

  /**
   * Refuse a redeclaration that breaks something already stored, and name what it breaks
   * (agent_docs/plan-schema-versioning.md phases 2 and 3).
   *
   * Phase 2 is structural and free: it compares the two declarations. Phase 3 costs two bounded
   * reads and answers the question that follows, which is the one an operator has: broken FOR WHOM.
   * Both run on BOTH write paths, because `validateReservedBody` learned that lesson already: an
   * `ack` emitting a `kind_def` must not be a way around a rule a `put` obeys.
   *
   * Returns the live patterns this declaration breaks, for the caller to record on the event. An
   * ACKNOWLEDGED break is not refused, so the log is the only place the consequence survives.
   *
   * NOT a compare-and-set. Naming the record makes the caller read the state it is deciding on,
   * which is most of the value, but the write is not keyed to it, so two callers with DIFFERENT
   * views both land. That half is the remainder of phase 2.
   */
  private async checkRedeclaration(body: unknown, def: KindDef): Promise<{ what: string; who: string; why: string }[]> {
    // A retirement carries no contract and drops every path by construction (see `isRetired`).
    if (isRetired(body)) return [];
    // PRESENCE acknowledges, `null` included: a reserved kind is declared in code and has no
    // record to name, so requiring an id would make its (legal) extension unreachable.
    const acknowledged = typeof body === "object" && body !== null && "supersedes" in body;
    // FROM THE LOG, never from the in-memory registry, and the difference is a correctness hole
    // rather than a refinement: with several instances over one database, this process's registry
    // holds whatever it last loaded. A declaration written through instance A leaves B comparing
    // against a stale definition, so a redeclaration through B that drops a path A added reads as
    // "no change" and lands, breaking every pattern that used it. That is audit package O's class
    // (multi-instance freshness), and the read is the same bounded shape `refreshKind` uses.
    const prev = await this.newestDeclaration(def.kind);
    const structural = prev ? incompatibleChanges(prev, def) : [];
    // The live read is paid for only when something structural already says a pattern COULD break,
    // or when the declaration is going through unacknowledged. A declaration that only adds paths
    // pays nothing.
    const broken = structural.length > 0 ? await this.patternsBrokenBy(def) : [];
    if (structural.length > 0 && !acknowledged) {
      const named = broken.slice(0, 5).map((b) => `${b.what} ${b.who}`);
      const rest = broken.length > named.length ? `, and ${broken.length - named.length} more` : "";
      throw new RadiaError(
        "incompatible_redeclaration",
        `this redeclaration of '${def.kind}' ${structural.join("; and ")}. ` +
          (broken.length
            ? `Live now and stopping: ${named.join(", ")}${rest}. `
            : `Nothing live uses the dropped paths on this instance, which is not the same as nothing anywhere: a watch is process-local. `) +
          `If that is what you mean, declare it again with 'supersedes' naming the kind_def record ` +
          `it replaces (null if there is none); a redeclaration that only ADDS paths needs nothing.`,
      );
    }
    return broken;
  }

  /** Reflect a committed declaration in THIS process's registry (other instances re-read it
   *  through `compileFresh`). */
  private async adoptKind(def: KindDef): Promise<void> {
    this.kinds.register(def, await this.declarationCount(def.kind));
    await this.prepareStorageFor(def);
  }

  /**
   * The declaration in force for a kind, read from the LOG rather than from this process's
   * registry. Returns undefined when there is none or the newest is a RETIREMENT, which matches
   * what the registry does with one: a withdrawn kind has no contract to break.
   *
   * Exact and bounded (`limit 1, dir desc` on an indexed field), the SAFE shape of a registry read.
   */
  private async newestDeclaration(kind: string): Promise<KindDef | undefined> {
    if (kind === KIND_DEF) return this.kinds.get(KIND_DEF); // the meta-kind lives in code
    let rows: RadiaRecord[];
    try {
      rows = await this.query({ kind: KIND_DEF, match: { kind } }, 1, { dir: "desc" });
    } catch {
      return this.kinds.get(kind); // a storage error must not turn the check into a refusal
    }
    if (rows.length === 0 || isRetired(rows[0].body)) return undefined;
    try {
      return this.kindDefFromBody(rows[0].body);
    } catch {
      return undefined; // a stored declaration this build cannot read is not a contract to compare
    }
  }

  /**
   * How many `kind_def` records name this kind: the kind's version
   * (agent_docs/plan-schema-versioning.md phase 1).
   *
   * COUNTED FROM THE LOG, never by incrementing what is in memory. `put` calls `adoptKind` on an
   * absorbed re-put as well, which wrote no record, so incrementing would drift one version per
   * redeclaration that changed nothing. Bounded and rare: a declaration is written only on a real
   * change, and this runs only when one is adopted.
   */
  private async declarationCount(kind: string): Promise<number> {
    const { records, complete } = await readExhaustively(
      (page) => this.query({ kind: KIND_DEF, match: { kind } }, page.limit, page),
    );
    // A partial read would UNDERCOUNT, and a version that goes backwards is worse than one that
    // stands still: keep what is registered rather than stamp a number that is wrong downwards.
    if (!complete) return this.kinds.versionOf(kind) ?? 1;
    return Math.max(1, records.length);
  }

  /**
   * When a written record becomes claimable: the writer's `availableAt`, bounded.
   *
   * Two rules, and each has a failure behind it that the other does not cover.
   *
   * A value ALREADY PAST is clamped forward to `now`, never refused. The caller computed it from
   * its own clock and every comparison here is against the database's, so a client seconds behind
   * would have "defer by one second" refused as a request from the past. Clamping makes that case
   * behave exactly as it did before this field existed.
   *
   * A value beyond `maxPutDelaySeconds` IS refused. Retention GC never sweeps unclaimed claimable
   * work (`sweepSelector`: only non-claimable kinds sweep from any state), so a record deferred
   * past any horizon is litter nothing can reach, and the write is the only place to stop it.
   */
  private resolveAvailableAt(requested: string | undefined, now: string): string {
    if (requested === undefined) return now;
    const at = Date.parse(requested);
    if (Number.isNaN(at)) {
      throw new RadiaError("invalid_available_at", `availableAt '${requested}' is not an ISO-8601 timestamp`);
    }
    const delay = (at - Date.parse(now)) / 1000;
    if (delay <= 0) return now; // the caller's clock, not ours; see above
    if (delay > this.ctx.maxPutDelaySeconds) {
      throw new RadiaError(
        "invalid_available_at",
        `availableAt is ${Math.round(delay)}s ahead, over this space's ${this.ctx.maxPutDelaySeconds}s ceiling. ` +
          `An unclaimed claimable record is never swept, so a longer deferral is permanent litter; ` +
          `write it when it is due, or hold the schedule outside the space.`,
      );
    }
    return new Date(at).toISOString();
  }

  /**
   * The budget every write of an uncompactable LATEST-WINS registry pays, before anything is
   * written.
   *
   * In `putRaw` rather than `put`, so the definition path (`createAgentDefinition` -> `putRaw`)
   * cannot grow a registry the client path is bounded on: a second write path that skipped the
   * first one's rule is a shape this codebase has already been bitten by twice (`kind_def` via
   * ack, `clientMeta` past the body guards).
   *
   * `satisfiedBy` is the id of an existing record this write is redundant with. Answering with it
   * is what the ceiling exists to do; refusing instead would break a fleet restart.
   *
   * `signal` and `agent_definition` are deliberately absent although they are also uncompactable.
   * A signal is a BROADCAST, so two identical ones are two events and absorbing the second would
   * lose one; an agent definition carries a freshly minted `tokenHash`, so no two bodies are ever
   * identical and the read would buy nothing. Neither is a registry in the sense that matters here.
   */
  private async checkBudgets(req: PutRequest): Promise<{ satisfiedBy: string } | undefined> {
    if (req.kind === GRANT) return await this.checkGrantBudget(req);
    if (req.kind === OPS_GRANT) return await this.checkOpsGrantBudget(req);
    if (req.kind === KIND_DEF) return await this.checkKindDefBudget(req);
    return undefined;
  }

  /**
   * The refusing half of the budgets, for a write path that cannot use the absorbing half.
   *
   * An `ack` result is a record like any other and reached none of these, because they live in
   * `putRaw` and a result is written by the adapter's settle. Only the CEILINGS run here: the
   * absorb's answer ("here is the record that already carries this") has no meaning for a settle
   * that must name its own result.
   */
  private async checkCeilings(req: PutRequest, principal?: string): Promise<void> {
    if (req.kind === INTEREST) return await this.checkInterestBudget(req, principal);
    // `kind_def` has no ceiling by design (see `checkKindDefBudget`), so nothing to run for it.
    if (req.kind === GRANT) await this.checkGrantBudget(req, { absorb: false });
    if (req.kind === OPS_GRANT) await this.checkOpsGrantBudget(req, { absorb: false });
  }

  /**
   * Absorb an identical re-declaration, and DO NOT cap.
   *
   * `kind_def` is uncompactable like the two above, but neither ceiling shape fits it. A cap per
   * kind NAME would not bound what `loadKinds` pays, because that read is over the whole kind
   * (100 names x 64 is still 6,400 records); a cap on the TOTAL would refuse declaring a new kind,
   * which is the one thing here that legitimately grows. So the ceiling would land on variety
   * instead of history, which is backwards, and the absorb is the whole of the fix.
   *
   * That is enough because the growth has exactly one source: `registerKind` is content-keyed, so a
   * re-declaration dedupes for the idempotency window and appends past it, and a fleet declaring
   * ~20 kinds on every start appends ~20 records a week forever. A real schema change still writes,
   * which is what keeps the declaration history this kind is excluded from compaction FOR.
   *
   * The identity is the kind NAME, matching `loadKinds`' own projection, so a changed declaration
   * carries the same identity with a different body and therefore writes.
   */
  private async checkKindDefBudget(req: PutRequest): Promise<{ satisfiedBy: string } | undefined> {
    const name = (req.body as { kind?: unknown })?.kind;
    if (typeof name !== "string") return;
    return await this.checkRegistryBudget(req, {
      kind: KIND_DEF,
      match: { kind: name }, // what `refreshKind` narrows to; `loadKinds` reads the whole kind
      identityOf: (b) => {
        const k = (b as { kind?: unknown })?.kind;
        return typeof k === "string" ? k : undefined;
      },
      ceiling: Number.POSITIVE_INFINITY, // absorb only; see above for why no cap fits
      code: "too_many_kind_defs",
      subject: `kind '${name}'`,
      reader: "every startup",
      cause: "unreachable: this kind has no ceiling",
    });
  }

  private async putRaw(
    req: PutRequest,
    idempotencyKey?: string,
    opts: { taint?: string[]; principal?: string; event?: { operation?: string; detail?: Record<string, unknown> } } = {},
  ): Promise<{ id: string }> {
    // Before anything is written on THIS path. A budget may answer that this write is redundant
    // with a record that already exists, in which case the postcondition the caller cares about
    // ("the grant is in force") already holds and writing would only grow the history the ceiling
    // exists to bound.
    //
    // This comment used to say "on every write path" and was wrong: an `ack` result is built by
    // `buildRecord` in `settle` and written by the adapter, so it reached none of these, and a
    // worker could evade `maxInterestsPerPrincipal` entirely by emitting interests as results.
    // `Space.checkCeilings` is that path's half; the two are separate because only this one can
    // absorb.
    const satisfied = await this.checkBudgets(req);
    if (satisfied) return { id: satisfied.satisfiedBy };
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
      // WHICH DECLARATION this record was written under, materialized at commit exactly as
      // `retention_until` is above: a later redeclaration then changes only FUTURE records and
      // never rewrites what history says a record was written against. An undeclared kind has no
      // declaration to name, so it falls back to the space's own version.
      schemaVersion: this.kinds.versionOf(req.kind) ?? this.ctx.schemaVersion,
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
        availableAt: this.resolveAvailableAt(req.availableAt, now),
        claimUntil: undefined,
        deadlineAt: record.deadlineAt,
        effectivePriority: 0, // server-computed; scheduler sets this for real in M3
      },
    });
    // Wake only streams watching THIS kind (a watch matches only its own kind). An
    // authorization-kind write is the exception: the SSE loop re-scopes on those, so any stream
    // may need it — wake everyone. This is the fan-out fix (bench/suites/fanout.ts).
    this.notifier.notify(AUTHORIZATION_KINDS.has(record.kind) ? undefined : record.kind);
    await this.maybeAmortizedSweep(); // the write that crossed the threshold pays for the batch
    await this.maybeCompactKind(record.kind); // and for its own registry's litter
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

  /** The configured OIDC trust anchors, or null. Health advertises issuer + audience from this
   *  (public by OIDC's own design); the verifier and mint read the context directly. */
  get oidcConfig(): OidcConfig | null {
    return this.ctx.oidc;
  }

  get downloadCapabilitySeconds(): number {
    return this.ctx.downloadCapabilitySeconds;
  }

  get blobStoreName(): string {
    return this.blobs.name;
  }

  /** `checkedFor` decides which put door the artifact's RECORD write goes through: the handle's
   *  (grant-checked) or the runtime's own. The port's `principal` slot stays attribution. */
  private artifactHostFor(checkedFor?: string): ArtifactHost {
    return {
      blobs: this.blobs,
      maxArtifactBytes: this.ctx.maxArtifactBytes,
      getRecord: (id) => this.storage.getRecord(id),
      now: () => this.storage.now(),
      put: (req, idem, principal) => this.putEnforced(req, idem, checkedFor, checkedFor ?? principal),
      putRaw: (req, idem, opts) => this.putRaw(req, idem, opts),
      query: (pattern, limit, page, scope) => this.query(pattern, limit, page, scope),
    };
  }

  private get artifactHost(): ArtifactHost {
    return this.artifactHostFor();
  }

  /** The RUNTIME's own artifact write: `author` is attribution, no grant consulted. The enforced
   *  door is `as(principal).putArtifact`. */
  putArtifact(
    bytes: Uint8Array,
    meta: ArtifactMeta,
    idempotencyKey?: string,
    author?: string,
  ): Promise<{ id: string; digest: string; size: number }> {
    return putArtifact(this.artifactHost, bytes, meta, idempotencyKey, author);
  }

  readArtifact(
    recordId: string,
  ): Promise<{ record: RadiaRecord; def: ArtifactDef; stream: ReadableStream<Uint8Array> } | null> {
    return readArtifact(this.artifactHost, recordId);
  }

  shredArtifact(
    recordId: string,
    opts: { principal?: string; reason?: string; acknowledgeShared?: boolean } = {},
  ): Promise<ShredResult> {
    return shredArtifact(this.artifactHost, recordId, opts);
  }

  shredOf(digest: string): Promise<Record<string, unknown> | null> {
    return shredOf(this.artifactHost, digest);
  }

  mintPathCapability(entries: TreeEntry[]): { capability: string; expiresAt: string } {
    return this.caps.mintPathCapability(entries);
  }

  resolveCapabilityPath(capability: string, path: string): string | null {
    return this.caps.resolveCapabilityPath(capability, path);
  }

  mintDownloadCapability(recordId: string): { capability: string; expiresAt: string } {
    return this.caps.mintDownloadCapability(recordId);
  }

  mintUploadCapability(upload: UploadGrant): { capability: string; expiresAt: string } {
    return this.caps.mintUploadCapability(upload);
  }

  takeUploadCapability(capability: string): UploadGrant | null {
    return this.caps.takeUploadCapability(capability);
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
   * THE ENFORCED API. `as(principal)` binds the principal ONCE and returns a handle whose every
   * verb consults grants; the raw verbs on Space stay the runtime's own, with attribution-only
   * parameters. The split ends the per-call discipline that the retired `{unchecked: "why"}`
   * escape demanded: a caller cannot pick the wrong mode per call, because the mode is the type it
   * holds. Handlers hold a handle; the ledger in `test/layering.test.ts` keeps raw verbs out of
   * them. Same idiom as `ToolContext.caller()` and `readFilter`: bind once, use many.
   *
   * A closure factory rather than a class, so the handle reaches Space's private internals with
   * no new access surface. Reads return WHAT THEY APPLIED beside the answer, because the wire
   * reports its narrowing (a read that narrows silently makes a scoped caller confidently wrong).
   */
  as(principal: string): ActingSpace {
    return {
      principal,
      put: (req, idempotencyKey) => this.putEnforced(req, idempotencyKey, principal),
      take: (sel, opts = {}) => this.takeEnforced(sel, opts, principal),
      ack: (lease, result, idempotencyKey) => this.ack(lease, result, idempotencyKey, principal),
      nack: (lease, opts, idempotencyKey) => this.nack(lease, opts, idempotencyKey, principal),
      release: (lease, idempotencyKey) => this.release(lease, idempotencyKey, principal),
      renew: (lease, opts, idempotencyKey) => this.renew(lease, opts, idempotencyKey, principal),
      createWatch: (request) => this.createWatch(request, principal),
      putArtifact: (bytes, meta, idempotencyKey) =>
        putArtifact(this.artifactHostFor(principal), bytes, meta, idempotencyKey, principal),
      mayPut: async (kind, body) => {
        const constraint = await this.authorize(principal, "put", kind);
        return !constraint || this.bodyMatchesGrant(kind, body, constraint);
      },
      query: async <T = unknown>(pattern: Pattern, limit = 100, page?: Page) => {
        const { constraint, createdBy } = await this.readAccess(principal, "query", pattern.kind);
        const scoped = constraint ? { ...pattern, match: combineMatch(pattern.match, constraint) } : pattern;
        const records = await this.query<T>(scoped, limit, page, createdBy ? { createdBy } : undefined);
        return { records, pattern: scoped, constraint, createdBy };
      },
      readOne: async (pattern: Pattern) => {
        const { constraint, createdBy } = await this.readAccess(principal, "read_one", pattern.kind);
        const scoped = constraint ? { ...pattern, match: combineMatch(pattern.match, constraint) } : pattern;
        const record = await this.readOne(scoped, createdBy ? { createdBy } : undefined);
        return { record, pattern: scoped, constraint, createdBy };
      },
      registryOf: async (kind, match) => {
        const { constraint, createdBy } = await this.readAccess(principal, "query", kind);
        const scoped = constraint ? combineMatch(match, constraint) : match;
        const out = await this.registryOf(kind, scoped, createdBy ? { createdBy } : undefined);
        return { ...out, constraint, createdBy };
      },
      /**
       * The artifact READ rule: access read once, a verdict per record, for the three doors bytes
       * leave through (meta/download, the download capability, the path capability's entry loop).
       * `not_found` covers missing, non-artifact AND out-of-self-scope alike, because a caller not
       * entitled to a record must not learn its id exists; `forbidden` is only ever the pattern
       * scope. A capability is a bearer URL that outlives the check, so the gate runs BEFORE mint.
       */
      artifactGate: async () => {
        const { constraint, createdBy } = await this.readAccess(principal, "read_one", ARTIFACT);
        return (rec: RadiaRecord | null | undefined) => {
          if (!rec || rec.kind !== ARTIFACT || !this.authorAllows(createdBy, rec)) return "not_found";
          if (constraint && !this.bodyMatchesGrant(ARTIFACT, rec.body, constraint)) return "forbidden";
          return "ok";
        };
      },
    };
  }

  /**
   * Matching records ordered by the pattern, capped at `limit`. The RUNTIME's own read; the
   * grant-composed twin is `as(principal).query`.
   *
   * `page` is a KEYSET cursor over record id (`after` exclusive, `dir` to walk backwards): the
   * stable way to paginate a space that is still being written to, and the only way to ask for the
   * NEWEST records rather than the oldest. It is defined for the natural id order only: an
   * explicit `order_by` already answers "in what order", and a cursor over a body field would need
   * the whole sort key plus the oracle's type rules, so combining them is rejected rather than
   * silently resolved one way.
   */
  async query<T = unknown>(pattern: Pattern, limit = 100, page?: Page, scope?: StatsScope): Promise<RadiaRecord<T>[]> {
    const compiled = await this.compileFresh(pattern);
    if (page && (page.after || page.dir) && compiled.orderBy?.length) {
      throw new RadiaError(
        "invalid_pattern",
        "a keyset page (after/dir) is only defined for the natural id order; drop order_by, or page without a cursor",
      );
    }
    return await this.storage.query(compiled, limit, page, scope) as RadiaRecord<T>[];
  }

  /** Record counts by kind and state (dev UI overview). `scope` makes it a genuine self-aggregate,
   *  computed over the subset, never a whole-space total filtered afterwards. */
  stats(scope?: StatsScope): Promise<KindStateCount[]> {
    return this.storage.stats(scope);
  }

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
    // A delegated run holds NONE, whatever its worker holds. `ops_grant` is keyed by principal and
    // resolved through `grantSubject`, which answers with the WORKER's agent, so without this a
    // delegated run inherits `observe` or `remediate` and reads the whole space on a caller's
    // behalf. Delegation narrows the coordination plane; it must not widen this one.
    if (await this.delegationOf(principal)) return new Set();
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
  async opsScope(principal: string): Promise<StatsScope | null> {
    const access = await this.access(principal);
    if (access.privileged) return null;
    const subject = this.grantSubject(principal);
    const grants = (access.defs as (GrantDef & { scope?: { createdBy?: string } })[])
      .filter((g) => Array.isArray(g.operations) && g.operations.includes("query"));
    // Reachability is opt-in, and there are now TWO ways in: a self-scoped read grant, or a
    // PATTERN-scoped one. The second exists because the first cannot express a team — a colleague's
    // record fails `createdBy: "self"` purely because somebody else wrote it — so an app containing
    // data by grant pattern had to choose between `observe` (every body in the space) and an ops
    // plane that refused it. An ordinary UNSCOPED query grant still does not open the plane: that
    // would hand a participant unscoped reads of everything it is granted, which is what `observe`
    // is for and what an ops power is meant to gate.
    const patternScopedGrants = grants.filter((g) => g.pattern && Object.keys(g.pattern).length > 0);
    if (!grants.some((g) => g.scope?.createdBy === "self") && patternScopedGrants.length === 0) {
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
    // Kinds reachable ONLY by pattern are deliberately absent from `kinds`, which is what the
    // AGGREGATES filter on. Counting them would need the grant pattern applied in SQL, and the
    // pushdown contract makes that unsound for a count: the pre-filter is a sound OVER-approximation
    // that the oracle narrows afterwards, so a `COUNT(*)` over it reports more rows than the caller
    // may see. Leaving them out means the aggregates answer zero for those kinds rather than
    // leaking another team's totals; `patternScoped` is what lets the response SAY so, instead of an
    // empty answer reading as an empty space.
    const patternScoped = [...new Set(patternScopedGrants.map((g) => g.kind))].filter((k) => !kinds.includes(k));
    return {
      createdBy: await this.runPrincipalsOf(subject, principal),
      kinds: kinds.sort(),
      ...(alsoReadable.length > 0 ? { alsoReadable: alsoReadable.sort() } : {}),
      ...(patternScoped.length > 0 ? { patternScoped: patternScoped.sort() } : {}),
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
      // `compact: true` so the report is not the small number: `doctor` counted only records past
      // retention while `gc` also reported 181 superseded registry entries on the same space. The
      // dry compaction walk is bounded per kind (`MAX_WALK`, gc.ts) and diagnostics is on demand in
      // both surfaces, never polled.
      gcBacklog: () => this.gc({ dryRun: true, compact: true }),
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
      envelopesInState: (q) => this.storage.envelopesInState(q),
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

  /**
   * Identity and lifetime of THIS process's space, reported by `GET /v0/health`.
   *
   * A reconnecting client could not tell "same space, records intact" from "same port, fresh empty
   * space": the payload named the backend but not which run of it, and `storage` reads `pglite`
   * whether the data is on disk or in memory. `instance` changes on every restart, `startedAt` is
   * the DB clock (so uptime is not a cross-clock subtraction) and `persistent` is set by whoever
   * boots the space, since a `Space` is handed an adapter and cannot see where it writes.
   */
  readonly instance = newUlid();
  startedAt?: string;
  persistent?: boolean;

  /** Stamp the start instant, from the database clock. Called by the boot path once the adapter is
   *  open; an unstamped space reports no `startedAt` rather than the moment it was first asked. */
  async markStarted(): Promise<void> {
    this.startedAt ??= await this.storage.now();
  }

  /** Registered kind declarations (dev UI). */
  listKinds(): KindDef[] {
    return this.kinds.list();
  }

  /** INTERSECTION, not union: a caller may narrow what it is willing to receive and may never widen
   *  past what its grants permit, so `undefined` (no barrier) on either side falls through to the
   *  other and two lists meet in the middle. */
  private static intersectAllow(caller: string[] | undefined, grant: string[] | undefined): string[] | undefined {
    if (!caller) return grant;
    if (!grant) return caller;
    return caller.filter((l) => grant.includes(l));
  }

  /** Claim work under a fenced lease: the record + lease, or null if none is claimable. The
   *  RUNTIME's own claim, so no grant composes; authority composes on `as(principal)`'s take.
   *  `owner` is LEASE OWNERSHIP only (a `run:*`, so a stopped run's leases can be quarantined),
   *  defaulting to the space's run id. */
  async take(sel: TakeInput, opts: TakeOptions & { owner?: string } = {}): Promise<TakeResult | null> {
    return await this.takeEnforced(sel, opts, undefined, opts.owner);
  }

  /** Both take doors. For the handle, four pieces compose together, because leaving any one out
   *  binds one door: grant ∧ request into the pattern, a self scope to the caller's own records,
   *  the GRANT's taint barrier intersected with the caller's (narrow yes, widen never), and a
   *  record-id take authorized on the record's own kind with the constraint synthesized as a
   *  pattern the record must satisfy. */
  private async takeEnforced(
    sel: TakeInput,
    opts: TakeOptions,
    checkedFor: string | undefined,
    owner?: string,
  ): Promise<TakeResult | null> {
    let pattern = sel.pattern;
    let createdBy = opts.createdBy;
    let allow = opts.allowTaint;
    if (checkedFor !== undefined) {
      const recordId = "recordId" in sel ? sel.recordId : undefined;
      let kind = pattern?.kind;
      if (!kind && recordId) kind = (await this.storage.getRecord(recordId))?.kind;
      if (kind) {
        const access = await this.readAccess(checkedFor, "take", kind);
        if (access.constraint) {
          pattern = { kind, match: combineMatch(pattern?.match, access.constraint), orderBy: pattern?.orderBy };
        }
        createdBy = access.createdBy ?? createdBy;
        allow = Space.intersectAllow(allow, access.allowTaint);
      }
    }
    const principal = checkedFor ?? owner;
    const spec: LeaseSpec = {
      leaseId: newUlid(),
      ownerRun: principal ?? this.ctx.runId,
      leaseSeconds: opts.leaseSeconds ?? this.ctx.defaultLeaseSeconds,
      maxCumulativeSeconds: this.ctx.maxCumulativeSeconds,
      maxAttempts: this.ctx.maxAttempts,
      // Validated HERE, not only at the HTTP boundary: the SDK, the MCP adapter and in-process
      // callers never pass through a handler, the same reason `compilePattern` validates its own
      // input. An allowlist is the widening direction, so the reserved label is refused.
      allowTaint: allow ? normalizeTaint(allow) : undefined,
      createdBy,
    };
    const selector: TakeSelector = "recordId" in sel
      ? { recordId: sel.recordId, pattern: pattern ? await this.compileFresh(pattern) : undefined }
      : { pattern: await this.compileFresh(pattern!) };
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
    /** Authorization of the emitted result, run by storage only when this is not a replay (W5). */
    let authorizeResult: (() => Promise<void>) | undefined;
    if (result) {
      // A result body the runtime reads back is validated exactly as a `put` body is, before
      // anything is consumed: emitting a record through a lease is not a way around the rule.
      declared = this.validateReservedBody(result);
      // Same rule on this path, for the reason `validateReservedBody` states: a second write path
      // that grew after the first one learned a rule is how the rule stops holding. The REFUSAL is
      // identical; what this path cannot do is record an acknowledged break on the event, because
      // a result record is written by the adapter's settle rather than through `putRaw`. Declaring
      // a kind by acking one is exotic enough that the refusal is the part worth having.
      if (declared) await this.checkRedeclaration(result.body, declared);
      // THE REGISTRY CEILINGS, for the same reason and found the same way. They live inside
      // `putRaw`, whose comment claimed they run "on every write path"; an ack result is built by
      // `buildRecord` here and written by the adapter's settle, so it reached none of them.
      // Measured before this: `maxInterestsPerPrincipal` of 3, six interests emitted as ack
      // results, ZERO refused and nine entries standing. Any worker holding `interest: put` and a
      // claim could evade a cap that exists because somebody else pays to read that registry.
      //
      // CEILINGS ONLY, never the absorb: the absorb answers "this write is redundant, here is the
      // record that already carries it", and an ack must still settle its lease and name a result.
      // The ceiling is the guarantee; the absorb is a growth optimization whose absence on an
      // exotic path costs records rather than correctness.
      await this.checkCeilings(result, principal);
      const now = await this.storage.now();
      const parentIds = [
        lease.recordId,
        ...(result.parentIds ?? []).filter((p) => p !== lease.recordId),
      ];
      // Emitting a result IS a put: authorize the ACTING principal to put this kind (this closes
      // the gap where ack-emitted records bypassed put-authorization). Pipeline-friendly: each
      // agent needs only its own grant. A pattern-scoped grant also constrains the result body, and
      // it still throws before anything is consumed. DEFERRED to storage, which runs it only when this is not an idempotent replay (audit
      // package W5). Run here, a retry of an already-succeeded ack threw `forbidden` whenever the
      // worker's put grant had narrowed in between, instead of replaying the stored response. The
      // FOREIGN branch above already had this right and says so; this is the same rule.
      authorizeResult = owner ? () => this.checkPutGrant(owner, result.kind, result.body, "result") : undefined;
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
        schemaVersion: this.kinds.versionOf(result.kind) ?? this.ctx.schemaVersion,
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
          // An ack result is a put with a lease attached, so it may be deferred too: that is how a
          // worker says "look at this again in a minute" without holding a process open to do it.
          availableAt: this.resolveAvailableAt(result.availableAt, now),
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
    const r = await this.storage.ack(this.ref(lease, principal), resultInput, idem, authorizeResult);
    if (declared && r.status === "ok") await this.adoptKind(declared);
    // The emitted result is a new available record: wake streams watching ITS kind (the chat's
    // ack path — a worker's answer IS its ack). No result, or an authorization-kind result: wake
    // everyone, the conservative default. Same fan-out fix as putRaw.
    this.notifier.notify(result && !AUTHORIZATION_KINDS.has(result.kind) ? result.kind : undefined);
    // The result record committed inside storage.ack, not through putRaw, so it counts here or the
    // amortized clock undercounts exactly the worker fleet's writes. The same is true of registry
    // litter: a worker acking a `capability` successor is the shape that grows one.
    await this.maybeAmortizedSweep();
    if (result && r.status === "ok") await this.maybeCompactKind(result.kind);
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
    getLogger("core.space").warn("settle rejected: the lease is owned by somebody else -> lease_lost", {
      op,
      recordId,
      principal,
      owner,
    });
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
    opts: {
      maxNodes?: number;
      excludeKinds?: Set<string>;
      createdBy?: string[];
      direction?: "both" | "down";
      /** See `getLineage`: replaces the author wall for a pattern-scoped caller. */
      allow?: (record: RadiaRecord) => Promise<boolean>;
    } = {},
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
    let queue = [recordId];
    // ONE WAVE of the BFS per iteration: everything queued is fetched in a single batch and the
    // accepted nodes' children in parallel. Node by node this was two sequential round trips per
    // node — a 150-node graph cost ~300 RTTs per fetch, and the console polls it every 1.5s in
    // live mode. `getLineage` above made the same move for the same reason. Enqueueing stays in
    // the sequential walk's order (per accepted node: parents, then children), so which nodes fall
    // inside the cap does not change.
    while (queue.length > 0 && nodes.size < maxNodes) {
      const wave: string[] = [];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        wave.push(id);
      }
      if (wave.length === 0) break;
      const fetched = new Map((await this.storage.getRecords(wave)).map((r) => [r.id, r]));
      const accepted: RadiaRecord[] = [];
      for (let i = 0; i < wave.length; i++) {
        if (nodes.size >= maxNodes) {
          // Back on the queue, so `truncated` below still sees the unprocessed remainder exactly
          // as the sequential walk left it when the cap tripped mid-stream.
          queue = wave.slice(i).concat(queue);
          break;
        }
        const rec = fetched.get(wave[i]);
        if (!rec || exclude.has(rec.kind)) continue;
        // A foreign node is a wall, not a skip. Traversing through it would still expose the shape
        // of what hangs off it, and the node's own id and label are enough to feed a lineage probe.
        if (opts.allow ? !(await opts.allow(rec)) : !this.authorAllows(opts.createdBy, rec)) continue;
        nodes.set(rec.id, rec);
        accepted.push(rec);
      }
      // Bounded per node: the node cap above limits how many records the graph SHOWS, not how many
      // this reads, so an unbounded fan-out here would materialize a whole subtree to enqueue it.
      const children = await Promise.all(accepted.map((rec) => this.storage.childrenOf(rec.id, GRAPH_FANOUT)));
      accepted.forEach((rec, i) => {
        for (const pid of rec.runtimeMeta.parentIds) {
          // The edge is recorded either way — it is dropped below unless both ends are in view — so
          // a descendants-only walk still draws the seed's own inbound edge rather than orphaning it.
          addEdge(pid, rec.id);
          if (!down && !seen.has(pid)) queue.push(pid);
        }
        for (const child of children[i]) {
          if (exclude.has(child.kind)) continue;
          addEdge(rec.id, child.id);
          if (!seen.has(child.id)) queue.push(child.id);
        }
      });
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

  /**
   * Append-only event log after the opaque `afterCursor` ("0"/"" = from the start).
   *
   * COALESCED: every watch stream is woken by the same `notify()` and asks this same question in
   * the same tick, so U streams issued U identical reads for one write (bench/suites/fanout.ts).
   * Concurrent callers with the same (cursor, limit) now share one read; a sequential caller
   * always hits storage. Safe because the log below the finality watermark is append-only, so an
   * answer cannot change while it is in flight.
   */
  getEvents(afterCursor = "0", limit = 200): Promise<SpaceEvent[]> {
    // The key is JSON rather than a delimited string, and the delimiter used to be NUL. Two NUL
    // bytes made this whole FILE binary to grep, which then answers every search over it with
    // silence: the largest file in the repo, invisible to the tool anyone reaches for first.
    // Cost two wrong conclusions before it was noticed. Collision-free either way.
    return this.reads.run(JSON.stringify(["ev", afterCursor, limit]), () => this.storage.getEvents(afterCursor, limit));
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
    /** The per-request read predicate (`readFilter`), for a caller whose reads are bounded by a
     *  grant PATTERN rather than by authorship. It REPLACES the author test rather than joining
     *  it: a teammate's record is exactly what such a caller may read, and the pattern is what
     *  says so. Same wall semantics either way. */
    allow?: (record: RadiaRecord) => Promise<boolean>,
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
        if (allow ? !(await allow(rec)) : !this.authorAllows(createdBy, rec)) continue;
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
    // COALESCED, like the log read above it: every stream woken by one write fetches the SAME
    // record to run its own predicate against, so U streams made U identical fetches. Shared here
    // and still authorized per watch below (`authorAllows` + `matchesRecord`), so this changes how
    // often the record is read, never who may see it. Records are immutable, so a shared fetch
    // cannot serve one caller something another would not have seen.
    const rec = await this.reads.run(`rec ${event.recordId}`, () => this.storage.getRecord(event.recordId!));
    if (!rec) return false;
    if (!this.authorAllows(watch.createdBy, rec)) return false;
    return watch.match.where ? matchesRecord(rec, watch.match) : true;
  }

  /** Resolve when a mutation occurs (a watch wakeup) or after timeoutMs (keepalive). A mutation
   *  made by another instance counts: see `pollForForeignChanges`. `kind` scopes the wakeup to
   *  writes of that kind (plus everyone, for authorization changes and foreign polls); a watch
   *  matches only its own kind, so a stream should always pass `watch.match.kind`. */
  waitForEvents(timeoutMs: number, kind?: string): Promise<void> {
    return this.notifier.wait(timeoutMs, kind);
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
    // JUMP to the head, rather than advancing one event per poll. Reading a single event meant a
    // burst of K foreign writes took K polls at CHANGE_POLL_MS, and every one of them returned
    // "changed" and fired the kind-blind `notify()` that wakes EVERY parked stream. That turned one
    // remote burst into K full fan-outs, in exactly the multi-instance case the kind-aware wakeup
    // was built for (audit package W6). One event is still enough to answer "did anything change";
    // what the cursor must not do is crawl.
    const events = await this.storage.getEvents(this.changeCursor, 1);
    if (events.length === 0) return false;
    this.changeCursor = await this.storage.latestCursor();
    return true;
  }

  // ---- envelope query + diagnostics + remediation (ops plane; would be grant-gated) ----

  /**
   * Query records by their runtime ENVELOPE state, the dimension the content-routing query
   * language deliberately omits (it matches record bodies, for routing). This is the ops-plane
   * runtime primitive: `expired` keeps only leased rows whose lease has lapsed; `staleSeconds`
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
      /** Kinds to keep. ANDed with the grant-derived `scope.kinds` in SQL, so it can only ever
       *  narrow: a caller naming a kind outside its scope gets nothing, not a widened read. */
      kinds?: string[];
      scope?: StatsScope;
    },
  ): Promise<{ record: RadiaRecord | null; envelope: Envelope }[]> {
    // EVERY predicate goes to the adapter, so all of them are applied before the cap. They used to
    // be filtered here, after it, which made `limit` mean "rows examined" instead of "rows
    // matched": `radia reclaim --all` reported nothing to do with stuck leases behind a page of
    // live ones, and `radia doctor` reported zero on a space with 500 live leases and a lapsed one.
    // Nothing may be filtered below this line (`test/conformance/suites/admin.ts` plants it).
    //
    // A non-finite window is DROPPED rather than passed down: in-process callers bypass the HTTP
    // validation, and `addSeconds(now, -NaN)` throws deep in date formatting.
    const envs = await this.storage.envelopesInState({
      state: q.state,
      limit: q.limit ?? 100,
      excludeKinds: q.excludeKinds,
      kinds: q.kinds,
      expired: q.expired,
      staleSeconds: q.staleSeconds !== undefined && Number.isFinite(q.staleSeconds) ? q.staleSeconds : undefined,
      scope: q.scope,
    });
    // One batch, not a round trip per envelope: the default page is 100, and diagnostics composes
    // several of these per call, so the loop this replaces was the ops plane's own N+1.
    const found = new Map((await this.storage.getRecords(envs.map((e) => e.recordId))).map((r) => [r.id, r]));
    return envs.map((e) => ({ record: found.get(e.recordId) ?? null, envelope: e }));
  }

  // ---- the sweeps (gc.ts) --------------------------------------------------------------
  //
  // Retention, registry compaction and the event-log horizon, plus the two amortized triggers the
  // write path pays for. Never a timer: an idle space runs nothing.

  /** The amortization counters. Instance state, so two instances over one database each keep their
   *  own and the housekeeping merely runs a little oftener. */
  readonly #sweep = newSweepState();

  private get gcHost(): GcHost {
    return {
      storage: this.storage,
      blobs: this.blobs,
      ctx: this.ctx,
      kinds: { list: () => this.kinds.list(), get: (k) => this.kinds.get(k) },
      sweep: this.#sweep,
      query: (pattern, limit, page) => this.query(pattern, limit, page),
      runIsLive: (run) => this.runIsLive(run),
      sealEvents: (limit) => this.sealEvents(limit),
      attestEventTruncation: (anchor, runId) => this.attestEventTruncation(anchor, runId),
    };
  }

  gc(opts: { limit?: number; dryRun?: boolean; compact?: boolean; principal?: string } = {}): Promise<GcReport> {
    return sweeps.gc(this.gcHost, opts);
  }

  private maybeCompactKind(kind: string): Promise<void> {
    return sweeps.maybeCompactKind(this.gcHost, kind);
  }

  private maybeAmortizedSweep(): Promise<void> {
    return sweeps.maybeAmortizedSweep(this.gcHost);
  }

  gcEvents(opts: { dryRun?: boolean; limit?: number; sealBudget?: number; runId?: string } = {}): Promise<EventGcResult> {
    return sweeps.gcEvents(this.gcHost, opts);
  }

  private referencedDigests(): Promise<Set<string>> {
    return sweeps.referencedDigests(this.gcHost);
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
    selector: { state: RecordState; expired?: boolean; staleSeconds?: number; limit?: number; kinds?: string[] },
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
    // NAMING a reference kind is REFUSED rather than silently emptied. The guard above would
    // subtract it and answer `matched: 0`, which reads as "nothing to fix" when the truth is "that
    // is not a thing this verb may touch". A zero that means refused is the worse of the two.
    const barred = (selector.kinds ?? []).filter((k) => excludeKinds?.includes(k));
    if (barred.length > 0) {
      throw new RadiaError(
        "kind_not_remediable",
        `${barred.join(", ")} ${barred.length === 1 ? "is" : "are"} reference data (claimable:false), which ` +
          `sits 'available' by design and is never stuck work. Remediating it would dead-letter the ` +
          `registry it belongs to.`,
      );
    }
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

  // ---- the event chain (seal.ts) ------------------------------------------------------
  //
  // Sealing and verification are a walk over the log plus arithmetic over hashes: no record, no
  // grant, no kind, which is why `ChainHost` is two members wide.

  private get chainHost(): ChainHost {
    return { storage: this.storage, sealKey: this.sealKey };
  }

  sealEvents(limit = SEAL_BATCH): Promise<{ sealed: number; head?: { idx: number; hash: string } }> {
    return chain.sealEvents(this.chainHost, limit);
  }

  verifyIntegrity(opts: { seal?: boolean; limit?: number; tail?: number } = {}): Promise<IntegrityReport> {
    return chain.verifyIntegrity(this.chainHost, opts);
  }

  attestEventTruncation(
    anchor: { idx: number; cursor: string; seq: number },
    runId?: string,
  ): Promise<{ attested: boolean }> {
    return chain.attestEventTruncation(this.chainHost, anchor, runId);
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
  async erasures(opts: { onlyUndone?: boolean } = {}): Promise<ErasureReport> {
    const view = await readExhaustively((page) => this.query({ kind: SHRED }, page.limit, page));
    const out: ErasureStatus[] = [];
    for (const rec of view.records) {
      const shredId = rec.id;
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
    return { erasures: out, checked: view.records.length, complete: view.complete };
  }


  /**
   * Re-seal every referenced payload under the CURRENT blob key, which is what finishes a KEK
   * rotation: until it runs, reads depend on the retired key and destroying that key destroys data.
   *
   * Reports rather than promises. `foreign > 0` means a payload could not be opened with the keys
   * this space holds, so the retired key is still load-bearing; `already === scanned` with
   * `foreign === 0` is the state in which dropping it is safe. A store with no cipher answers
   * `undefined` rather than a row of zeroes that would read as "nothing to do".
   */
  async rewrapBlobs(opts: { dryRun?: boolean } = {}): Promise<RewrapResult | undefined> {
    if (!this.blobs.rewrap) return undefined;
    return await this.blobs.rewrap(await this.referencedDigests(), { dryRun: opts.dryRun });
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
    // A version too, since this is how a declaration written on ANOTHER INSTANCE reaches this one:
    // registering without it would leave records stamped with the version this process last saw.
    this.kinds.register(def, await this.declarationCount(def.kind));
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
