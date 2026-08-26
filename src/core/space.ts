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
import { type CompactionResult, compactRegistries, keyOf, RUNTIME_KEYS } from "./gc.ts";
import { type BlobGcResult, type BlobStore, MemoryBlobStore, type RewrapResult } from "../storage/blobs.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
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
export type { EventGcResult, GcReport };

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

/** Every grant in force for one principal, and where they came from. The single answer behind
 *  `authorize`, `readAccess`, `authorScope`, `taintBarrier`, `authorizeWatch`, `opsScope` and
 *  `effectivePermissions`, so a delegated run cannot be attenuated in some of them. */
/**
 * The principal holding an agent's DELEGABLE grants: authority it may exercise only through a
 * delegated run (plan-delegation.md phase 3).
 *
 * A prefix no credential can ever resolve to, which is the whole mechanism. `grantSubject` answers
 * `agent:`, `human:` or `run:`; `createAgentDefinition` refuses anything but the first two; OIDC
 * mints `human:` only. So these grants are unreachable by authentication and readable only by the
 * mint, and a space running an older build sees a principal that never authenticates rather than a
 * flag it does not understand.
 */
export const DELEGABLE_PREFIX = "delegable:";

export function delegablePrincipal(agent: string): string {
  return `${DELEGABLE_PREFIX}${agent}`;
}

/** What a delegated mint returns. Mirrors `createAgentRun`, plus who it is bounded by. */
export interface DelegatedRunMint {
  run: string;
  agent: string;
  runToken: string;
  expiresAt: string;
  actingFor: string;
}

/** The cross product of two pattern disjunctions is paid ONCE, at mint. This is where an explosion
 *  fails, with a message naming the fix, instead of silently making every later read expensive. */
const MAX_DELEGATED_GRANTS = 64;

/**
 * `grants(worker) INTERSECT grants(caller)`, per kind and per operation.
 *
 * The result is a SUBSET of the worker's authority on every axis, which is the property the whole
 * mechanism rests on: an operation neither side holds is absent, and a pattern either side imposes
 * is applied. An unpatterned grant means "the whole kind", so it contributes the other side's
 * patterns unchanged rather than widening to nothing.
 *
 * A `scope.createdBy: "self"` grant on EITHER side is dropped. "Self" is relative to the holder,
 * and a delegated run's writer is the worker, so materializing it would invert the caller's
 * intent — the one narrowing that cannot be carried across a change of author. Dropping is
 * fail-closed: the delegated run simply cannot use that grant.
 */
export function intersectGrants(worker: GrantDef[], caller: GrantDef[]): DelegatedGrant[] {
  const usable = (defs: GrantDef[]) =>
    defs.filter((g) =>
      typeof g?.kind === "string" && Array.isArray(g.operations) &&
      (g as GrantDef & { scope?: { createdBy?: string } }).scope?.createdBy !== "self"
    );
  const w = usable(worker);
  const c = usable(caller);
  const out: DelegatedGrant[] = [];
  const kinds = [...new Set(w.map((g) => g.kind))].filter((k) => c.some((g) => g.kind === k)).sort();
  for (const kind of kinds) {
    const wk = w.filter((g) => g.kind === kind);
    const ck = c.filter((g) => g.kind === kind);
    const ops = [...new Set(wk.flatMap((g) => g.operations))]
      .filter((op) => ck.some((g) => g.operations.includes(op)))
      .sort();
    for (const op of ops) {
      const wp = patternsOf(wk, op);
      const cp = patternsOf(ck, op);
      const taint = intersectTaint(allowlistOf(wk, op), allowlistOf(ck, op));
      const scope = taint === undefined ? {} : { scope: { taint: taint.length === 0 ? "none" : taint.join(",") } };
      const patterns = wp === null ? cp : cp === null ? wp : wp.flatMap((a) => cp.map((b) => intersectPattern(a, b)));
      if (patterns === null) {
        out.push({ kind, operations: [op], ...scope });
        continue;
      }
      for (const pattern of patterns) out.push({ kind, operations: [op], pattern, ...scope });
    }
  }
  // CANONICAL ORDER, because this array is hashed into the delegated run's token so that an
  // unchanged delegation reuses its run instead of writing a permanent record. Kinds and ops are
  // already sorted above, but the PATTERNS for one (kind, op) come out in grant-registry iteration
  // order — stable in practice and an unguarded assumption otherwise, and if it ever varied the
  // digest would differ per call, every mint would write a fresh run, and no test would notice
  // because they all mint back to back against an unchanged registry.
  return out.sort((a, b) =>
    a.kind !== b.kind
      ? (a.kind < b.kind ? -1 : 1)
      : a.operations[0] !== b.operations[0]
      ? (a.operations[0] < b.operations[0] ? -1 : 1)
      : JSON.stringify(a.pattern ?? null) < JSON.stringify(b.pattern ?? null)
      ? -1
      : 1
  );
}

/** The patterns grants permitting `op` impose, or `null` when one of them is unrestricted (which
 *  widens to the whole kind, exactly as `constraintFrom` reads it). */
function patternsOf(grants: GrantDef[], op: GrantOp): Record<string, unknown>[] | null {
  const applicable = grants.filter((g) => g.operations.includes(op));
  const patterns: Record<string, unknown>[] = [];
  for (const g of applicable) {
    if (!g.pattern || Object.keys(g.pattern).length === 0) return null;
    patterns.push(g.pattern);
  }
  return patterns.length > 0 ? patterns : null;
}

/** The taint allowlist grants permitting `op` impose, or `undefined` for no barrier. Mirrors
 *  `barrierFrom`: every applicable grant must state one, and together they UNION. */
function allowlistOf(grants: GrantDef[], op: GrantOp): string[] | undefined {
  const applicable = (grants as (GrantDef & { scope?: Record<string, string> })[])
    .filter((g) => g.operations.includes(op));
  if (applicable.length === 0 || !applicable.every((g) => typeof g.scope?.taint === "string")) return undefined;
  const allowed = new Set<string>();
  for (const g of applicable) for (const l of parseTaintAllowlist(g.scope!.taint!)) allowed.add(l);
  return [...allowed].sort();
}

/** Two barriers compose as the NARROWER of the two: a label must be allowed by both sides to
 *  survive. Absence is "no barrier", so it yields to whichever side states one. */
function intersectTaint(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((l) => b.includes(l));
}

/** Both patterns must hold. Merged FLAT when they can be, because the result is stored and then
 *  AND-ed into every request (`combineMatch`), and nesting compounds against the compiler's
 *  depth-3 limit. A key both sides constrain differently cannot merge, so it falls back to `$and`
 *  and the compiler decides. */
function intersectPattern(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!(k in merged)) {
      merged[k] = v;
      continue;
    }
    if (JSON.stringify(merged[k]) !== JSON.stringify(v)) return { $and: [a, b] };
  }
  return merged;
}

/** An `agent_run` body, as the mint and its successors write it. */
interface RunBody {
  run?: string;
  agent?: string;
  tokenHash?: string;
  status?: string;
  expiresAt?: string;
  mintedAt?: string;
  /** Delegated runs only: the caller this run is bounded by, and the intersection it was minted
   *  with. Indexed (`actingFor`) so `radia runs --acting-for` is one query. */
  actingFor?: string;
  delegated?: { grants?: unknown };
}

/** A run's current state, folded over its successors. */
interface RunState {
  agent?: string;
  tokenHash?: string;
  status?: string;
  delegation?: Delegation;
}

/** The attenuation an `agent_run` body carries, or `undefined`. Defensive about the shape because
 *  a malformed one must read as NO delegation on a run that claims one, which `access` then
 *  treats as an empty grant set rather than as the worker's. */
function delegationOfBody(body: RunBody | undefined): Delegation | undefined {
  if (!body || typeof body.actingFor !== "string" || body.actingFor.length === 0) return undefined;
  const raw = body.delegated?.grants;
  const grants = Array.isArray(raw)
    ? raw.filter((g): g is DelegatedGrant =>
      !!g && typeof (g as DelegatedGrant).kind === "string" && Array.isArray((g as DelegatedGrant).operations)
    )
    : [];
  return { actingFor: body.actingFor, grants };
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

export interface EffectivePermissions {
  principal: string;
  /** The agent a run resolves to. Grants are held by agents, not by individual runs. */
  subject: string;
  privileged: boolean;
  /** Set for a DELEGATED run: the caller whose reach bounds it. `kinds` below is then the
   *  intersection it was minted with, not `subject`'s own grants, so the two lines have to be read
   *  together. See agent_docs/plan-delegation.md. */
  actingFor?: string;
  /** Authority this agent can reach ONLY by minting a delegated run (`delegable:<agent>` grants).
   *  Absent from `kinds` on purpose: its own token cannot use these. */
  delegable?: { kind: string; operations: GrantOp[] }[];
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

/**
 * A grant's identity where one is REQUIRED, as opposed to projected.
 *
 * `grantKey` returns undefined for a shape this build cannot read (a legacy `template` field, a
 * missing principal or kind), and that sentinel is fail-CLOSED: a projection drops the record
 * rather than guess what it permits. On the WRITE path there is nothing to drop, and the two
 * callers here coerced it to `""` instead, which is the same sentinel read the opposite way: every
 * unreadable grant collapses into ONE identity, so a supersede sees them as each other and skips,
 * and a retirement replays under a shared key. A fail-open fallback under a fail-closed signal.
 *
 * Unreachable today, and stopping is the only safe answer if it ever is reached: declared grants
 * pass `validateGrantDef` (which refuses an unknown field and demands both strings) and stored ones
 * arrive through a projection that already dropped the undefined keys.
 */
function requireGrantKey(body: unknown): string {
  const key = grantKey(body);
  if (key === undefined) {
    throw new RadiaError(
      "invalid_grant",
      "this grant's identity is unreadable in this build, so it cannot be written or superseded " +
        "without guessing what it permits",
    );
  }
  return key;
}

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
  private async registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
    scope?: StatsScope,
  ): Promise<RegistryView> {
    const { records, complete, scanned } = await readExhaustively(
      (page) => this.query({ kind, match }, page.limit, page, scope),
    );
    return { entries: activeByKey<T>(records, keyOf), newest: newestByKey<T>(records, keyOf), complete, scanned };
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
   * The attenuation a DELEGATED run carries, or `undefined` for every other principal.
   *
   * FAIL-CLOSED is the whole contract here: if this answers `undefined` for a run that IS
   * delegated, `access` falls through to `grantSubject`, which resolves to the WORKER's agent, and
   * the run silently gains the worker's full authority. So absence from the memo means UNKNOWN and
   * costs a record read, never "not delegated".
   *
   * The memo is warm for every authenticated request, because `resolveCredential` reads the run
   * body anyway and remembers what it found. The cold path is real: `ack` authorizes the LEASE
   * OWNER, which may be a run minted by another instance or before a restart.
   */
  private async delegationOf(principal: string): Promise<Delegation | undefined> {
    if (!principal.startsWith("run:")) return undefined; // agents and humans are never delegated
    const known = this.creds.runFacts(principal);
    if (known) return known.delegation;
    const rec = await this.runRecord(principal);
    if (!rec?.agent) return undefined; // not a run this space knows; it holds no grants either way
    this.creds.rememberRun(principal, rec.agent, rec.delegation);
    return rec.delegation;
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
    const access = await this.access(principal, kind);
    // BEFORE both shortcuts below, because both return `null` (unrestricted) without reading a
    // grant, and a delegated run's whole authority is the attenuation they would skip. The mint
    // refuses a privileged or supervisor agent outright, so this is the second wall rather than
    // the only one; it is here because `isPrivileged` and the carve-out both resolve
    // `grantSubject`, which for a delegated run answers with the WORKER's agent.
    if (access.delegated) {
      if ((op === "put" || op === "take") && WRITE_PROTECTED_KINDS.has(kind)) {
        throw new RadiaError("forbidden", `a delegated run may not write '${kind}' records`);
      }
      return this.constraintFrom(access.defs, principal, op, kind);
    }
    if (access.privileged) return null;
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
    this.warnIfIncomplete(access, principal, op, kind);
    return this.constraintFrom(access.defs, principal, op, kind);
  }

  /**
   * THE authorization read: every grant in force for `principal` (on `kind`, or on every kind when
   * omitted), plus whether the read saw everything.
   *
   * One seam, because there are six entry points (`authorize`, `readAccess`, `authorScope`,
   * `taintBarrier`, `authorizeWatch`, `effectivePermissions`) and a delegated run must be attenuated
   * in ALL of them. Adding the branch per call site is how five of them would keep reading the
   * worker's grants.
   *
   * Grants are records: for an ordinary principal this queries the ones for this (subject, kind).
   * ADDITIVE, not latest-wins: a principal may hold several grants on one kind (different
   * operations, different pattern scopes) and they coexist. So a revocation targets one GRANT,
   * identified by its content (`grantKey`), and `activeSet` drops exactly that entry while leaving
   * the others in force. Projecting by (principal, kind) instead would let a single revocation
   * silently take every grant on the kind with it.
   */
  private async access(principal: string, kind?: string): Promise<GrantAccess> {
    const delegated = await this.delegationOf(principal);
    if (delegated) {
      // A delegated run reads NO grant record. Its authority was computed at mint and lives on its
      // own `agent_run` body, so it cannot widen when the worker's grants do, and `complete` is
      // true by construction (nothing was paged).
      const defs = delegated.grants
        .filter((g) => kind === undefined || g.kind === kind)
        .map((g) => ({ ...g, principal }) as GrantDef);
      return { privileged: false, delegated, defs, complete: true, scanned: defs.length };
    }
    if (this.isPrivileged(principal)) return { privileged: true, defs: [], complete: true, scanned: 0 };
    const subject = this.grantSubject(principal);
    const view = await this.registry(GRANT, grantKey, kind === undefined ? { principal: subject } : { principal: subject, kind });
    return {
      privileged: false,
      defs: [...view.entries.values()].map((r) => r.body as GrantDef),
      complete: view.complete,
      scanned: view.scanned,
    };
  }

  /**
   * The refusal every "you hold nothing here" path throws, and it SAYS WHEN THE KIND DOES NOT EXIST.
   *
   * Authorization runs before pattern compilation, so a caller naming a kind nobody ever declared
   * is told it lacks a GRANT — and acts on that, because it is the only thing it was told. A live
   * session asked for `file` (a kind this space has never had), read "no 'query' grant for kind
   * 'file'" as a permissions problem, and spent its next two calls guessing around it. The
   * information to say so was right here: `this.kinds` is what authorization is standing next to.
   *
   * The status and the code do NOT change (403 `forbidden`), because they are wire contract and
   * because an undeclared kind is still a refusal. Only the sentence gets longer.
   *
   * The tradeoff, stated rather than assumed: the extra clause lets a caller with no grants tell a
   * declared kind from an undeclared one, so kind names are enumerable by probing. That is
   * acceptable here because kind names are SCHEMA, not data — the console lists them, `space_kinds`
   * serves them to any session holding `kind_def: query`, and nothing in design-auth.md treats
   * their existence as secret. Revisit if a space ever needs its vocabulary hidden.
   */
  private noGrant(principal: string, what: string, kind: string): RadiaError {
    // The remedy is in the SPACE's vocabulary, not a surface's. The first version said "list
    // them with 'radia kinds'", which is useless to the reader that actually hits this — a model
    // holding tools, not a shell — and is `src/core` naming a CLI verb it should not know exists.
    // "Query kind_def" is true through every surface and directly actionable by anything holding
    // the read, because kinds ARE records.
    const undeclared = this.kinds.get(kind)
      ? ""
      : `; '${kind}' is not a declared kind on this space, so no grant would help — query 'kind_def' for the ones that are`;
    return new RadiaError("forbidden", `principal '${principal}' has no ${what} kind '${kind}'${undeclared}`);
  }

  /** The pattern constraint an already-read grant set imposes. Split from the read so `readAccess`
   *  can answer three questions from ONE view; the rule is unchanged. */
  private constraintFrom(
    grants: GrantDef[],
    principal: string,
    op: GrantOp,
    kind: string,
  ): Record<string, unknown>[] | null {
    const applicable = grants.filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
    if (applicable.length === 0) throw this.noGrant(principal, `'${op}' grant for`, kind);
    const patterns: Record<string, unknown>[] = [];
    for (const g of applicable) {
      const t = g.pattern;
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
    // Only grants that permit THIS operation are relevant. A `put`-only grant says nothing about
    // reads, and counting it as "an unscoped grant on this kind" lifts the read restriction the
    // moment a read grant is narrowed while the write grant stays as it was.
    const access = await this.access(principal, kind);
    if (access.privileged || !this.selfScoped(access.defs, op)) return undefined;
    // A delegated run's self scope is its CALLER's, which is what the caller's own grant meant.
    // The mint refuses self-scoped grants today (plan-delegation.md 1d), so this is unreachable
    // until it stops doing so; resolving it to the worker would be the inversion that rule exists
    // to prevent.
    const subject = access.delegated ? this.grantSubject(access.delegated.actingFor) : this.grantSubject(principal);
    return await this.runPrincipalsOf(subject, access.delegated ? access.delegated.actingFor : principal);
  }

  /** Do ALL the grants permitting `op` carry `scope: {createdBy: "self"}`? Split from the read so
   *  `readAccess` can answer from one view. */
  private selfScoped(grants: GrantDef[], op: GrantOp): boolean {
    const applicable = (grants as (GrantDef & { scope?: { createdBy?: string } })[])
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
    const access = await this.access(principal, kind);
    if (access.privileged) return undefined; // no grants to read, so no barrier to impose
    return this.barrierFrom(access.defs, op);
  }

  /** The allowlist an already-read grant set imposes. Split from the read so `readAccess` can
   *  answer from one view. */
  private barrierFrom(grants: GrantDef[], op: GrantOp): string[] | undefined {
    const applicable = (grants as (GrantDef & { scope?: Record<string, string> })[])
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
    const access = await this.access(principal, kind);
    if (access.privileged) return { constraint: null, createdBy: undefined, allowTaint: undefined };
    this.warnIfIncomplete(access, principal, op, kind);
    const constraint = this.constraintFrom(access.defs, principal, op, kind);
    // Still one read: `authorScope` would repeat it. A delegated run's "self" is its CALLER (see
    // there), which is unreachable today because the mint refuses self-scoped grants.
    const who = access.delegated ? access.delegated.actingFor : principal;
    const createdBy = this.selfScoped(access.defs, op)
      ? await this.runPrincipalsOf(this.grantSubject(who), who)
      : undefined;
    return { constraint, createdBy, allowTaint: this.barrierFrom(access.defs, op) };
  }

  /**
   * A truncated grant view decided this. Say so.
   *
   * `readExhaustively` reports `complete: false` when it hits its page budget rather than returning a
   * plausible prefix, and every authorization path took `.entries` and never looked. Truncation is
   * fail-CLOSED here — reads are newest-first, so a retirement is inside the window while what it
   * retires may be outside, and the entry drops out either way — so the cost is silence rather than
   * misauthorization: a principal is denied and nothing says the answer was computed from part of
   * its grants. Content-keyed grant writes make >20k records for one (principal, kind) implausible,
   * which is why this warns rather than throws.
   */
  private warnIfIncomplete(view: { complete: boolean; scanned: number }, principal: string, op: GrantOp, kind: string): void {
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
    const access = await this.access(principal);
    if (access.privileged) {
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
    const byKind = new Map<string, { kind: string; operations: GrantOp[]; scoped: boolean; unscoped: boolean; opsEligible: boolean; patterns: Record<string, unknown>[] }>();
    for (const g of access.defs as (GrantDef & { scope?: { createdBy?: string } })[]) {
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
      // A delegated run answers about the intersection it was minted with, and says whose reach
      // bounds it. Without this the list looks like an ordinary agent's and the second half of the
      // answer ("bounded by whom") is invisible in the one view built for checking.
      ...(access.delegated ? { actingFor: access.delegated.actingFor } : {}),
      // And an agent's own answer names what it can reach ONLY by delegating. Omitting it would
      // make this view under-report a worker's reach, which is the same failure as over-reporting:
      // the point of the page is that it matches enforcement.
      ...(access.delegated ? {} : await this.delegableSection(subject)),
      kinds,
      ops: { reachable: opsKinds.length > 0, kinds: opsKinds.sort() },
      opsPowers: [...await this.opsPowers(principal)].sort(),
      complete: access.complete,
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
    // Retracted grants are subtracted here too. A watch observes records, so a revocation that
    // stopped `query` but left `watch` standing would revoke nothing that matters.
    const access = await this.access(principal, kind);
    if (access.privileged) return { constraint: null };
    const grants = access.defs as (GrantDef & { scope?: { createdBy?: string } })[];
    const subject = access.delegated ? this.grantSubject(access.delegated.actingFor) : this.grantSubject(principal);
    if (grants.length === 0) throw this.noGrant(principal, "grant to watch", kind);
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
    // is a minting credential for privilege. Refused here rather than handled downstream: an
    // operator's authority is not expressed as grants, so nothing later in the chain narrows what
    // such a run could do.
    //
    // The SUPERVISOR is deliberately NOT refused, and the message used to claim it was: it is
    // mintable since ops-tiers phase 5, which is what makes the role usable at all. Its carve-out
    // is `grant`/`signal` writes and nothing else. What that costs is recorded in
    // plan-delegation.md phase 0: `authorize` short-circuits for it before any attenuation, so
    // `mintDelegatedRun` refuses it there rather than here.
    if (this.isPrivileged(agent)) {
      throw new RadiaError(
        "invalid_principal",
        `'${agent}' is a privileged principal (an operator, or the space itself); a definition for it ` +
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
      const key = requireGrantKey(g);
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
    const declaredKeys = new Set(declared.map(requireGrantKey));
    // Collected by record id, so a triple declared twice retires each stale record once.
    const stale = new Map<string, RadiaRecord>();
    for (const g of declared) {
      for (const rec of views.get(g.principal)?.entries.values() ?? []) {
        const body = rec.body as GrantDef;
        if (body.kind !== g.kind || !sameOps(body.operations, g.operations)) continue;
        if (declaredKeys.has(requireGrantKey(body))) continue;
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
        `grant-retire:${await sha256Hex(requireGrantKey(body))}:after:${rec.id}`,
      );
    }
  }

  /**
   * Mint a short-lived run token for the agent behind `definitionToken`. Records an `agent_run`
   * and returns the run principal + token (once). Fails if the token is not a definition token.
   *
   * `reuse` is for a credential that is exchanged over and over by SHORT-LIVED processes: every CLI
   * verb is a fresh process, so inspecting a space grew it by one permanent `agent_run` per command
   * (766 rows in four days, `radia events --tail` showing the reader their own reads). It derives
   * the token instead of randomising it, exactly as `mintDelegatedRun` does, so the same
   * (definition token, 12h bucket) finds its own run and writes nothing while that run is live.
   *
   * OPT-IN, because reuse collapses run identity: two processes holding one definition token would
   * share a run principal, and `runs --stop` would stop both. That is right for a person's CLI and
   * wrong for a worker fleet, so the caller says which it is. A stopped run stays stopped until the
   * bucket rolls, the same rule delegation keeps and for the same reason.
   */
  async mintRun(
    definitionToken: string,
    opts: { reuse?: boolean } = {},
  ): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    const now = await this.storage.now();
    const resolved = await this.resolveCredential(definitionToken, now); // hydrates a cross-instance def token
    if (!resolved.ok || resolved.kind !== "def") {
      throw new RadiaError("invalid_credential", "a valid agent-definition token is required to mint a run");
    }
    const agent = resolved.agent;
    // Derived from the PRESENTED token and never from its hash: the hash is in a record anyone with
    // read access can see, and would otherwise be enough to compute a live credential.
    const bucket = Math.floor(Date.parse(now) / (this.ctx.runMaxLifetimeSeconds * 1000));
    const derived = opts.reuse ? (await sha256Hex(`radia-run\n${definitionToken}\n${bucket}`)).slice(0, 48) : undefined;
    const { token, hash } = derived ? { token: derived, hash: await hashToken(derived) } : await mintCredential();
    if (derived) {
      const reused = await this.reuseRun(hash, now, agent, {}, (run) => this.creds.rememberRun(run, agent));
      if (reused) return { run: reused.run, agent, runToken: token, expiresAt: reused.expiresAt };
    }
    const run = `run:${newUlid()}`;
    const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
    // `mintedAt` is what bounds renewal: it is copied onto every successor, so the absolute deadline
    // is a property of the RUN and cannot be pushed forward by renewing.
    await this.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now } });
    this.creds.rememberRun(run, agent);
    this.notifier.notify();
    return { run, agent, runToken: token, expiresAt };
  }

  /**
   * Keep alive the run a DERIVED token already names, or report that there is none to keep.
   *
   * Both derived mints need the same three answers and must not drift apart on any of them: a
   * stopped run stays stopped (or the deprovisioning cascade is undone by the holder's next call),
   * a live one is returned with NO write, and one expired inside its ceiling is EXTENDED in place
   * (the `renewRun` successor shape, so compaction still keeps exactly one row per run).
   *
   * Undefined means past the ceiling. The caller then mints a fresh run under the same derived
   * token, which cannot collide: the bucket is the ceiling, so a run whose ceiling has passed was
   * derived in an earlier bucket and the next derivation differs.
   */
  private async reuseRun(
    hash: string,
    now: string,
    agent: string,
    bodyExtra: Record<string, unknown>,
    remember: (run: string) => void,
  ): Promise<{ run: string; expiresAt: string } | undefined> {
    const prior = await this.newestByHash(AGENT_RUN, hash) as RunBody | undefined;
    if (!prior?.run) return undefined;
    if (prior.status === "stopped") throw new RadiaError("run_stopped", `run ${prior.run} was stopped`);
    if ((prior.expiresAt ?? "") > now) {
      remember(prior.run);
      return { run: prior.run, expiresAt: prior.expiresAt! };
    }
    const mintedAt = prior.mintedAt ?? now;
    if (addSeconds(mintedAt, this.ctx.runMaxLifetimeSeconds) > now) {
      const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
      await this.putRaw({
        kind: AGENT_RUN,
        body: { run: prior.run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt, ...bodyExtra },
      });
      remember(prior.run);
      this.notifier.notify();
      return { run: prior.run, expiresAt };
    }
    return undefined;
  }

  /**
   * Mint a DELEGATED run: act with my own capability, under my caller's reach
   * (agent_docs/plan-delegation.md).
   *
   * `worker` is the authenticated caller. `recordId` names a record it may read, and the CALLER is
   * resolved from that record rather than asserted: `created_by` names a RUN, and a run is a
   * record, so `actingFor` on the run behind it composes transitively. Never `body.owner` (an
   * unconstrained body value) and never the record's author (in the chat that is another worker).
   *
   * The returned run's authority is `grants(worker) INTERSECT grants(caller)`, computed once and
   * stored on its own `agent_run` body. It is therefore a SUBSET of what the worker already holds,
   * which is why naming a readable record is enough entitlement: the mint can gain the worker
   * nothing it could not already do.
   *
   * `presentedToken` is the caller's own bearer credential, used to DERIVE this run's token so an
   * unchanged delegation reuses its run instead of appending a permanent record per call. Optional
   * only for in-process callers that have no token to present; see the derivation below.
   */
  async mintDelegatedRun(worker: string, recordId: string, presentedToken?: string): Promise<DelegatedRunMint> {
    // No re-delegation. A delegated run is already bounded by somebody; letting it mint again
    // makes the chain unbounded and gives `actingFor` two meanings. The worker mints with its OWN
    // credential, which is the credential it holds anyway.
    if (await this.delegationOf(worker)) {
      throw new RadiaError("forbidden", "a delegated run may not delegate again; mint with the worker's own credential");
    }
    // The wall createAgentDefinition holds, at the other place a run can come into existence.
    // `isPrivileged` and the supervisor carve-out both short-circuit `authorize` before any
    // attenuation is consulted, so an attenuated run of either would be unattenuated in practice.
    const agent = this.grantSubject(worker);
    if (this.isPrivileged(worker)) {
      throw new RadiaError("forbidden", `'${agent}' is privileged; a delegated run of it would not be attenuated at all`);
    }
    if (agent === this.ctx.supervisor) {
      throw new RadiaError("forbidden", `'${agent}' is the supervisor; its grant/signal carve-out ignores attenuation`);
    }

    const record = await this.storage.getRecord(recordId);
    if (!record) throw new RadiaError("not_found", `no record ${recordId}`);
    // A worker holding DELEGABLE grants must prove a LEASE, not merely a read. Read access is
    // enough for a pure narrowing because the result is a subset of what the worker already holds;
    // a delegable grant breaks that, so the caller's request has to be one this worker actually
    // claimed rather than one it happened to see.
    const delegable = await this.delegableGrants(agent);
    if (!await this.mayActOn(worker, record, { requireLease: delegable.length > 0 })) {
      throw new RadiaError(
        "forbidden",
        delegable.length > 0
          ? `'${worker}' holds no lease on ${recordId}, and '${agent}' has delegable grants, which need one`
          : `'${worker}' neither holds a lease on ${recordId} nor may read it`,
      );
    }

    const actingFor = await this.callerOf(record);
    if (!actingFor) {
      throw new RadiaError("invalid_request", `record ${recordId} has no resolvable caller to act for`);
    }
    // A privileged caller has no grants to intersect WITH: authority it holds is not expressed as
    // grants at all. Reading that as "unrestricted" would hand the worker's full ambient reach to
    // anything an operator happens to trigger, and reading it as "empty" would break their session
    // silently. Refuse, and say which one it is.
    if (this.isPrivileged(actingFor)) {
      throw new RadiaError(
        "forbidden",
        `'${actingFor}' is privileged, so there is no grant set to narrow to; a delegated run cannot bound it`,
      );
    }

    // The worker side is its OWN grants plus its DELEGABLE ones. Both are needed and they answer
    // different halves: without the own grants a worker could not delegate what it already uses,
    // and without the delegable ones there is no way to narrow the worker at all, because an
    // intersection is a subset of what it holds (plan-delegation.md phase 3).
    const workerGrants = [...(await this.access(worker)).defs, ...delegable];
    const callerGrants = (await this.access(actingFor)).defs;
    const grants = intersectGrants(workerGrants, callerGrants);
    if (grants.length === 0) {
      throw new RadiaError(
        "empty_delegation",
        `'${agent}' and '${actingFor}' share no grant, so a delegated run could do nothing; ` +
          `check that the worker holds the kinds it needs to serve this caller`,
      );
    }
    if (grants.length > MAX_DELEGATED_GRANTS) {
      throw new RadiaError(
        "delegation_too_large",
        `the intersection expands to ${grants.length} grants (limit ${MAX_DELEGATED_GRANTS}); ` +
          `narrow the patterns on one side rather than paying this per request`,
      );
    }

    const now = await this.storage.now();
    const delegation: Delegation = { actingFor, grants };

    // REUSE, or a worker's delegated runs accumulate forever. `agent_run` is reserved, so the
    // retention sweep never touches it; compaction keeps newest-per-`run`, so every distinct run
    // is one permanent row. A worker re-mints whenever its cached credential lapses (the run token
    // is short and a delegated run deliberately cannot renew itself), which made the growth
    // proportional to CONVERSATION-MINUTES rather than to how many callers there actually are, and
    // it lands in the one table `runPrincipalsOf` pages to exhaustion.
    //
    // So the token is DERIVED, exactly as the OIDC mint derives one from an id_token: the same
    // (worker credential, caller, grant set) yields the same token, finds its own run through the
    // indexed `tokenHash` lookup resolution already performs, and writes NOTHING while it is live.
    // Growth is now one row per distinct delegation, not per mint call.
    //
    // The GRANT SET is in the derivation, which is what keeps a run's authority IMMUTABLE (the
    // property `CredentialStore` memoizes on): a changed intersection cannot mutate an existing
    // run, it derives a different token and becomes a different run. Deriving from the presented
    // token and never from its hash matters — the hash is in a record anyone with read access can
    // see, and would let them compute a live credential.
    const bucket = Math.floor(Date.parse(now) / (this.ctx.runMaxLifetimeSeconds * 1000));
    const derived = presentedToken
      ? (await sha256Hex(
        `radia-delegated-run\n${presentedToken}\n${actingFor}\n${await sha256Hex(JSON.stringify(grants))}\n${bucket}`,
      )).slice(0, 48)
      : undefined;

    if (derived) {
      // `reuseRun` holds the three rules this shares with `mintRun`'s reuse: stopped stays stopped
      // (or `radia runs --acting-for … --stop` is undone by the worker's next call), live returns
      // with no write, and expired-inside-the-ceiling extends the same run.
      const reused = await this.reuseRun(
        await hashToken(derived),
        now,
        agent,
        { actingFor, delegated: { grants } },
        (run) => this.creds.rememberRun(run, agent, delegation),
      );
      if (reused) return { run: reused.run, agent, runToken: derived, expiresAt: reused.expiresAt, actingFor };
    }

    const run = `run:${newUlid()}`;
    const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
    // No presented credential (an in-process caller, e.g. a test) means nothing to derive from, so
    // this mints a fresh random token and forgoes reuse rather than deriving from something
    // guessable.
    const token = derived ?? (await mintCredential()).token;
    const hash = await hashToken(token);
    await this.putRaw({
      kind: AGENT_RUN,
      body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now, actingFor, delegated: { grants } },
    });
    this.creds.rememberRun(run, agent, delegation);
    this.notifier.notify();
    return { run, agent, runToken: token, expiresAt, actingFor };
  }

  /** The `delegable` block of `effectivePermissions`, or nothing when the agent holds none. */
  private async delegableSection(agent: string): Promise<{ delegable?: { kind: string; operations: GrantOp[] }[] }> {
    if (agent.startsWith(DELEGABLE_PREFIX)) return {}; // asking about the holder itself: it IS the list
    let defs: GrantDef[];
    try {
      defs = await this.delegableGrants(agent);
    } catch {
      return {}; // an incomplete read refuses a MINT; it must not break the inspection page
    }
    if (defs.length === 0) return {};
    const byKind = new Map<string, Set<GrantOp>>();
    for (const g of defs) {
      const ops = byKind.get(g.kind) ?? new Set<GrantOp>();
      for (const op of g.operations) ops.add(op);
      byKind.set(g.kind, ops);
    }
    return {
      delegable: [...byKind.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([kind, ops]) => ({ kind, operations: [...ops].sort() })),
    };
  }

  /**
   * Grants an agent may exercise ONLY through a delegated run, held under the principal
   * `delegable:<agent>`.
   *
   * This is what removes the ambient authority, and it is a principal rather than a flag on the
   * grant for one reason: nothing can authenticate as it. `grantSubject` answers `agent:`/`human:`/
   * `run:`, `createAgentDefinition` requires the first two, OIDC requires `human:`. So the worker's
   * own token cannot reach these grants by any path, including one written before this existed,
   * while `radia permissions delegable:agent:x` inspects them with the verb that already exists.
   *
   * A `delegable: true` FIELD was the alternative and is worse three ways: it would have to enter
   * `grantKey` (or a delegable and an ordinary grant on the same triple collapse into one entry,
   * latest-wins, silently), it changes nothing for a build that predates it, so such a grant reads
   * as an ordinary one and WIDENS, and every existing read path would need the branch.
   */
  private async delegableGrants(agent: string): Promise<GrantDef[]> {
    const view = await this.registry(GRANT, grantKey, { principal: delegablePrincipal(agent) });
    if (!view.complete) {
      // Fail CLOSED: a truncated view here silently drops authority the delegated run then lacks,
      // which reads as a broken worker rather than as a partial read.
      throw new RadiaError(
        "registry_incomplete",
        `could not read all delegable grants of '${agent}'; refusing to mint from a partial set`,
      );
    }
    return [...view.entries.values()].map((r) => r.body as GrantDef);
  }

  /**
   * May `principal` mint a delegated run from this record? Two proofs, and the weaker one is
   * sufficient because a phase-1 intersection can only NARROW the worker.
   *
   * A live LEASE it owns is the strong proof, and the one the real path uses: a tool worker holds
   * `take` on the kind it serves and often no read grant at all, so requiring `read_one` would
   * refuse exactly the caller this exists for. Read access is the weak proof, kept for workers that
   * react to facts rather than claim work (the turn worker, which cannot hold a lease because
   * `message` is deliberately not claimable).
   *
   * When a delegable grant exists (plan-delegation.md phase 3) the weak proof stops being
   * sufficient, because the mint would then yield authority the worker cannot exercise alone. That
   * is why `intersectGrants` is fed the worker's OWN grants here.
   */
  private async mayActOn(principal: string, record: RadiaRecord, opts: { requireLease?: boolean } = {}): Promise<boolean> {
    const env = await this.storage.getEnvelope(record.id);
    // The STATE, not `leasedUntil > now`, and the difference is deliberate: expiry is lazy here, so
    // a just-expired lease still reads `leased` and its holder can still mint. That window is
    // harmless — the caller resolved from the record is the same person either way, and the moment
    // another worker reclaims it the owner no longer matches — and closing it would cost a clock
    // round trip on the one path that is otherwise read-only.
    if (env?.state === "leased" && env.leaseOwner === principal) return true;
    if (opts.requireLease) return false;
    // EITHER read op, because they are separate grants and a worker commonly holds one. Asking only
    // about `read_one` refused a worker that reaches its records by `query`, which is most of them.
    for (const op of ["query", "read_one"] as const) {
      try {
        const { constraint, createdBy } = await this.readAccess(principal, op, record.kind);
        if (!this.authorAllows(createdBy, record)) continue;
        if (!constraint || this.bodyMatchesGrant(record.kind, record.body, constraint)) return true;
      } catch (e) {
        if (!(e instanceof RadiaError && e.code === "forbidden")) throw e;
      }
    }
    return false;
  }

  /**
   * Who a record is ultimately acting for: its author, or — when its author is itself a delegated
   * run — the caller that run was bounded by.
   *
   * One read and no walk: `actingFor` holds a RESOLVED principal, never another run, so a chain of
   * workers relaying a session collapses to the person at its head in a single hop.
   */
  private async callerOf(record: RadiaRecord): Promise<string | undefined> {
    const author = record.runtimeMeta.createdBy;
    if (!author) return undefined;
    const delegation = await this.delegationOf(author);
    return delegation ? delegation.actingFor : this.grantSubject(author);
  }

  /** The fetcher behind OIDC's JWKS/discovery reads. A field so tests point it at an in-repo
   *  issuer or a stub; the default is the platform seam's one outbound-HTTP function. */
  oidcFetch: (url: string) => Promise<unknown> = httpGetJson;
  #oidcVerifier: OidcVerifier | null = null;

  /**
   * Mint a run from a verified OIDC id_token (design-auth.md "OIDC"). A new way to MINT into the
   * existing chain, never a parallel auth model: everything downstream (leases, idempotency
   * scope, stopRun, audit, grants) sees an ordinary run whose agent happens to be a `human:`.
   * No durable half is created — past the 12h ceiling the holder re-authenticates at the IdP,
   * which is how deprovisioning takes effect.
   *
   * The run token is DERIVED from the id_token (domain-separated hash), which is what bounds
   * replay: the same id_token POSTed again finds the already-minted run by tokenHash (the
   * indexed lookup credential resolution already does) and writes NOTHING. Deriving is sound
   * because holding the id_token already mints; H(id_token) is exactly as secret. Two racing
   * first-POSTs can both write; the newest wins resolution and the orphan expires inert.
   */
  async mintOidcRun(idToken: string): Promise<{ run: string; agent: string; runToken: string; expiresAt: string }> {
    const cfg = this.ctx.oidc;
    if (!cfg) throw new RadiaError("oidc_not_configured", "this space has no OIDC issuer configured (dev: --oidc-issuer + --oidc-audience)");
    // The DB clock is fetched LAZILY, through the verifier: this is the unauthenticated path,
    // and on Postgres `storage.now()` is a round trip, so a flood of garbage tokens must die on
    // string compares before the space pays any I/O for them (measured in bench/suites/oidc.ts).
    let nowIso: string | undefined;
    const nowMs = async () => Date.parse(nowIso ??= await this.storage.now());
    this.#oidcVerifier ??= new OidcVerifier(cfg, (url) => this.oidcFetch(url));
    const v = await this.#oidcVerifier.verify(idToken, nowMs);
    if (!v.ok) throw new RadiaError("invalid_credential", `id_token rejected: ${v.reason}`);
    const now = nowIso ?? (nowIso = await this.storage.now());

    // Who is this? The mapping registry decides; a raw claim never does. Fail CLOSED on an
    // incomplete view — an absent mapping changes who the caller IS, not just what they may do.
    const view = await this.registry(OIDC_IDENTITY, oidcIdentityKey, { iss: v.iss, sub: v.sub });
    if (!view.complete) throw new RadiaError("oidc_unavailable", "identity registry read incomplete; refusing to guess");
    const key = oidcIdentityKey({ iss: v.iss, sub: v.sub })!;
    const newest = view.newest.get(key);
    // RETIRE IS A BAN. `activeByKey` drops tombstones, so "unmapped ⇒ auto-admit" would silently
    // re-admit an offboarded identity under its old derived principal, grants and all.
    if (newest && isRetired(newest.body)) {
      throw new RadiaError("invalid_credential", "this identity's mapping was retired; sign-in is refused");
    }
    // Mapped ⇒ the operator's name for this person. Absent ⇒ auto-admit under a principal
    // derived from (iss, sub) alone: stable, and never from email/username, which are mutable
    // and reassignable. 32 hex = 128 bits, because grants bind to this string.
    const agent = newest
      ? (newest.body as { principal: string }).principal
      : `human:oidc-${(await sha256Hex(`${v.iss}\n${v.sub}`)).slice(0, 32)}`;
    // The same wall createAgentDefinition holds, re-checked at mint time: a mapping written
    // before its principal entered `operators` must not become an operator-minting oracle.
    if (this.isPrivileged(agent)) {
      throw new RadiaError("invalid_credential", `'${agent}' is a privileged principal; OIDC never mints one`);
    }
    // FIRST login enrolls: write the mapping record the operator would otherwise have to build
    // by hand from the IdP's user screen. Renaming is now a successor of a visible record and a
    // ban needs no archaeology. LATER logins refresh the display claims when they changed at the
    // IdP, as a successor keyed `:after:` its predecessor (the grant-retire pattern) so one
    // change is one write. This can never resurrect a ban: a retired mapping refused above,
    // before any write, so a tombstone stays newest forever.
    //
    // The claims themselves live in an ARTIFACT the mapping references, never in the mapping
    // body: `oidc_identity` never compacts and a record body has no erasure path, so a name or
    // email written inline would be PERMANENT — the exact shape the erasure invariant exists to
    // prevent. The artifact is shreddable (`radia shred <profile id>` is the deletion-request
    // runbook), and its JSON carries a random NONCE because {name, email} is low-entropy: the
    // plaintext sha256 survives a shred in the artifact record's body, and without the nonce
    // anyone holding a candidate name could confirm it had been here.
    const display: Record<string, string> = {
      ...(v.username ? { username: v.username } : {}),
      ...(v.name ? { name: v.name } : {}),
      ...(v.email ? { email: v.email } : {}),
    };
    const writeProfile = async (claims: Record<string, string>): Promise<string> => {
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const bytes = new TextEncoder().encode(JSON.stringify({ nonce, ...claims }));
      return (await this.putArtifact(bytes, { mediaType: "application/json", filename: "oidc-profile.json" })).id;
    };
    if (!newest) {
      await this.putRaw(
        {
          kind: OIDC_IDENTITY,
          body: {
            iss: v.iss,
            sub: v.sub,
            principal: agent,
            auto: true,
            ...(Object.keys(display).length ? { profile: await writeProfile(display) } : {}),
          },
        },
        `oidc-enroll:${await sha256Hex(key)}`,
      );
    } else if (Object.keys(display).length > 0) {
      // What is currently known: the referenced profile artifact, or — for a record enrolled
      // before claims moved out of line — legacy inline fields, which the successor STRIPS (the
      // migration path; the legacy body itself stays in history, which is why this design was
      // worth fixing early). A withheld claim never strips a stored one: comparison and the new
      // artifact both merge over what is known. A SHREDDED profile reads as unknown, so an
      // active user's next changed claim re-enrolls one; erasing someone who keeps signing in
      // is not offboarding — retire the mapping first.
      const prev = newest.body as Record<string, unknown>;
      const known: Record<string, string> = {};
      if (typeof prev.profile === "string") {
        try {
          const got = await this.readArtifact(prev.profile);
          if (got) {
            const chunks: Uint8Array[] = [];
            for await (const c of got.stream) chunks.push(c);
            const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
            let at = 0;
            for (const c of chunks) {
              all.set(c, at);
              at += c.byteLength;
            }
            const parsed = JSON.parse(new TextDecoder().decode(all)) as Record<string, unknown>;
            for (const k of ["username", "name", "email"]) if (typeof parsed[k] === "string") known[k] = parsed[k] as string;
          }
        } catch { /* unreadable profile: treated as unknown, re-enrolled below if claims differ */ }
      } else {
        for (const k of ["username", "name", "email"]) if (typeof prev[k] === "string") known[k] = prev[k] as string;
      }
      if (Object.entries(display).some(([k, val]) => known[k] !== val)) {
        const { username: _u, name: _n, email: _e, ...rest } = prev;
        await this.putRaw(
          { kind: OIDC_IDENTITY, body: { ...rest, profile: await writeProfile({ ...known, ...display }) } },
          `oidc-enroll:${await sha256Hex(key)}:after:${newest.id}`,
        );
      }
    }

    // Replay: the derived token's run may already exist. Newest record wins, same as resolution.
    const token = (await sha256Hex(`radia-oidc-run\n${idToken}`)).slice(0, 48);
    const hash = await hashToken(token);
    const prior = await this.newestByHash(AGENT_RUN, hash) as
      | { run?: string; agent?: string; status?: string; expiresAt?: string }
      | undefined;
    if (prior?.run) {
      if (prior.status === "stopped") throw new RadiaError("run_stopped", `run ${prior.run} was stopped`);
      if ((prior.expiresAt ?? "") <= now) throw new RadiaError("token_expired", "this id_token's run has expired; sign in again for a fresh token");
      this.creds.rememberRun(prior.run, prior.agent ?? agent);
      return { run: prior.run, agent: prior.agent ?? agent, runToken: token, expiresAt: prior.expiresAt! };
    }

    // The ceiling on ACTIVE runs per subject: the one write this endpoint can be made to do is a
    // permanent record, so it gets a per-principal bound like watches and interests. Newest row
    // per run decides its state; the page cap failing CLOSED is deliberate — a subject with
    // thousands of live agent_run rows is who the ceiling is for.
    let active = 0;
    let after: string | undefined;
    const seenRuns = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const rows = await this.query({ kind: AGENT_RUN, match: { agent } }, 500, { dir: "desc", after });
      for (const r of rows) {
        const b = r.body as { run?: string; status?: string; expiresAt?: string };
        if (!b.run || seenRuns.has(b.run)) continue;
        seenRuns.add(b.run);
        if (b.status === "active" && (b.expiresAt ?? "") > now) active++;
      }
      if (rows.length < 500) break;
      after = rows[rows.length - 1].id;
      if (page === 3) active = Number.MAX_SAFE_INTEGER; // cap hit: refuse rather than guess
    }
    if (active >= this.ctx.maxOidcRunsPerSubject) {
      throw new RadiaError(
        "too_many_runs",
        `'${agent}' already holds ${this.ctx.maxOidcRunsPerSubject} active runs; wait for one to expire or stop one`,
      );
    }

    const run = `run:${newUlid()}`;
    const expiresAt = addSeconds(now, this.ctx.runTokenSeconds);
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
    const bodies = rows.map((r) => r.body as RunBody);
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
    // The attenuation is COPIED, for the same reason `mintedAt` is: `resolveCredential` reads the
    // NEWEST body for a token hash, so a renewal that dropped these fields would hand back a run
    // that resolves as an ordinary one holding the worker's full grants.
    const carried = bodies.find((b) => b.actingFor);
    await this.putRaw({
      kind: AGENT_RUN,
      body: {
        run,
        agent,
        tokenHash,
        status: "active",
        expiresAt,
        mintedAt,
        ...(carried ? { actingFor: carried.actingFor, delegated: carried.delegated } : {}),
      },
    });
    this.notifier.notify();
    return { run, agent, expiresAt, maxLifetimeAt };
  }

  /**
   * Stop a run: emit a successor `agent_run` record (status stopped) and invalidate its token so
   * no new operations resolve. Default (graceful) revocation leaves held leases to expire on
   * their own clocks. `quarantine: true` is emergency revocation: it additionally force-releases
   * the run's in-flight leases now (epoch-bumped, so a late ack/renew fences out as `lease_lost`).
   */
  async stopRun(
    run: string,
    /** `by` is WHO stopped it, and it lands in the quarantine events. Absent means the space's own
     *  identity: an in-process caller is the runtime itself, not an anonymous "admin". */
    opts: { quarantine?: boolean; by?: string } = {},
  ): Promise<{ applied: boolean; quarantined: number }> {
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
        // Carried like `renewRun` does. A stopped run resolves no further, so this is for the
        // AUDIT rather than for enforcement: the terminal record of a delegated run still says
        // whose reach it held.
        ...(mint.delegation ? { actingFor: mint.delegation.actingFor, delegated: { grants: mint.delegation.grants } } : {}),
      },
    });
    let quarantined = 0;
    if (opts.quarantine) {
      const now = await this.storage.now();
      quarantined = await this.storage.quarantineLeasesOf(run, now, opts.by ?? this.ctx.principal);
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
      const b = run as RunBody;
      if (!b.run || !b.agent) return { ok: false, reason: "invalid_token" };
      // Both facts are immutable for the life of the run, so both are safe to memo. Recording the
      // delegation HERE is what keeps `delegationOf` warm on every authenticated request; a memo
      // holding only the agent would assert "not delegated" and hand the run its worker's grants.
      // Successors copy the fields, so the newest body always carries them.
      this.creds.rememberRun(b.run, b.agent, delegationOfBody(b));
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

  private async runRecord(run: string): Promise<RunState | undefined> {
    const rows = await this.query({ kind: AGENT_RUN, match: { run } }, 5, { dir: "desc" });
    // The stop successor omits nothing, but an older mint carries the hash if a caller wrote one
    // without it; take the newest non-empty value for each field.
    const bodies = rows.map((r) => r.body as RunBody);
    if (bodies.length === 0) return undefined;
    return {
      agent: bodies.find((b) => b.agent)?.agent,
      tokenHash: bodies.find((b) => b.tokenHash)?.tokenHash,
      status: bodies[0]?.status,
      // Folded like the rest, so a successor that omits it does not un-delegate the run. Successors
      // COPY it as well (`renewRun`, `stopRun`), because `resolveCredential` reads only the newest
      // body: a renewal that dropped the attenuation would resolve to an unattenuated run.
      delegation: delegationOfBody(bodies.find((b) => b.actingFor)),
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
    // so the space coordinates its own schema through the normal write path (no side table).
    // WRITE PATH ONLY, and deliberately here rather than inside `kindDefFromBody`. BOTH readers of
    // that function swallow a validation failure and keep what they have: `loadKinds` at startup
    // and `refreshKind` on a stale projection. Strictness there would make a stored declaration
    // carrying an unknown field an unloadable kind, and through `refreshKind` a kind declared on
    // ANOTHER INSTANCE would never register on this one.
    if (req.kind === KIND_DEF) {
      assertKnownKindDefFields(req.body);
      return this.kindDefFromBody(req.body);
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
  private async checkGrantBudget(req: PutRequest): Promise<{ satisfiedBy: string } | undefined> {
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
  private async checkOpsGrantBudget(req: PutRequest): Promise<{ satisfiedBy: string } | undefined> {
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
    if (live && live.bodySha256 === await sha256Hex(JSON.stringify(req.body ?? null))) {
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

  /** Reflect a committed declaration in THIS process's registry (other instances re-read it
   *  through `compileFresh`). */
  private async adoptKind(def: KindDef): Promise<void> {
    this.kinds.register(def);
    await this.prepareStorageFor(def);
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

  /** Kinds whose write pays a budget check first. In `putRaw` rather than `put`, so the
   *  definition path (`createAgentDefinition` -> `putRaw`) cannot grow a registry the client path
   *  is bounded on: a second write path that skipped the first one's rule is a shape this codebase
   *  has already been bitten by twice (`kind_def` via ack, `clientMeta` past the body guards). */
  /** The id of an existing record this write is redundant with, when a budget says so. Writing
   *  anyway is what the ceiling exists to prevent; refusing would break a fleet restart. */
  /**
   * The three uncompactable LATEST-WINS registries, before anything is written.
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
    // Before anything is written, and on every write path. A budget may answer that this write is
    // redundant with a record that already exists, in which case the postcondition the caller cares
    // about ("the grant is in force") already holds and writing would only grow the history the
    // ceiling exists to bound.
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
    /** Authorization of the emitted result, run by storage only when this is not a replay (W5). */
    let authorizeResult: (() => Promise<void>) | undefined;
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
      // agent needs only its own grant. A pattern-scoped grant also constrains the result body, and
      // it still throws before anything is consumed. DEFERRED to storage, which runs it only when this is not an idempotent replay (audit
      // package W5). Run here, a retry of an already-succeeded ack threw `forbidden` whenever the
      // worker's put grant had narrowed in between, instead of replaying the stored response. The
      // FOREIGN branch above already had this right and says so; this is the same rule.
      authorizeResult = owner
        ? async () => {
          const constraint = await this.authorize(owner, "put", result.kind);
          if (constraint && !this.bodyMatchesGrant(result.kind, result.body, constraint)) {
            throw new RadiaError("forbidden", `result body is outside the pattern scope of the put grant for '${result.kind}'`);
          }
        }
        : undefined;
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
        if (!this.authorAllows(opts.createdBy, rec)) continue;
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
  async gc(opts: { limit?: number; dryRun?: boolean; compact?: boolean; principal?: string } = {}): Promise<GcReport> {
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
    let compaction: CompactionResult | undefined;
    if (opts.compact !== false) {
      compaction = await compactRegistries(
        this.compactionHost(),
        { dryRun: opts.dryRun, runId: opts.principal ?? this.ctx.runId },
      );
    }
    // Reference-aware blob GC rides the verb LAST (phase 4, plan-gc.md): the record sweep above
    // is what turns an expired artifact into an unreferenced digest, so its bytes reclaim in the
    // same call. The live set is every digest any surviving artifact record carries, paged to
    // exhaustion; the store deletes what is absent from it AND untouched past the grace window
    // (the whole race answer — see `blobGcGraceSeconds` and `BlobStore.retainOnly`). LIVE sweeps
    // only: `doctor` runs this dry on every diagnostics, and a dry blob pass would walk every
    // artifact record and the whole blob directory to report a number the live sweep reports
    // anyway.
    let blobs: BlobGcResult | undefined;
    if (!opts.dryRun) {
      blobs = await this.blobs.retainOnly(await this.referencedDigests(), { graceMs: this.ctx.blobGcGraceSeconds * 1000 });
    }
    // Assembled into a typed value rather than spread into the return, so a sweep that grows a
    // field `GcReport` does not declare is a compile error. Conditional spreads widen to `{}` and
    // check nothing (see `handleIntegrity`).
    const out: GcReport = { ...totals };
    if (compaction) out.compaction = compaction;
    if (events) out.events = events;
    if (blobs) out.blobs = blobs;
    return out;
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
      // `artifact` is reference data like any other claimable-false kind (it sits `available`
      // forever), so once its writer declared retention it sweeps from any state. It left
      // `neverKinds` when reference-aware blob GC arrived (plan-gc.md phase 4): before that,
      // sweeping the record stranded its bytes with no path to them but `erasures`.
      anyStateKinds: this.kinds.list()
        .filter((d) => !isClaimable(d) && (!RESERVED_KINDS.includes(d.kind) || d.kind === ARTIFACT))
        .map((d) => d.kind),
      neverKinds: RESERVED_KINDS.filter((k) => k !== ARTIFACT),
      limit,
      dryRun,
    };
  }

  /** What compaction reads and the one destructive member it calls. Shared by the `gc` verb and
   *  the amortized per-kind trigger, so the two cannot come to disagree about what a registry is. */
  private compactionHost() {
    return {
      listKinds: () => this.kinds.list(),
      pageDesc: (kind: string, limit: number, after?: string) => this.query({ kind }, limit, { dir: "desc" as const, after }),
      sweepIds: (ids: string[], runId: string) => this.storage.sweepIds(ids, runId),
      runIsLive: (run: string) => this.runIsLive(run),
    };
  }

  /** Commits since the last amortized sweep. Instance state, like the notifier: two instances over
   *  one database each keep their own count, which only means the housekeeping runs a bit oftener. */
  private writesSinceSweep = 0;
  private amortizedSweepRunning = false;
  /** Writes per KEYED kind since that kind was last compacted. Only keyed kinds are counted, so a
   *  space streaming an unkeyed kind never triggers a walk. */
  private readonly writesSinceCompact = new Map<string, number>();
  private compactingKind = new Set<string>();

  /**
   * Compact ONE registry inline, every `compactEveryWritesPerKind` writes of that kind.
   *
   * The measurement is the whole argument (agent_docs/plan-registry-cost.md): a registry read is
   * linear in history, and compaction makes it EXACTLY FLAT, so leaving it to a verb nobody runs
   * means every reader pays for litter forever. Amortizing it puts the cost on the writer producing
   * the litter, which is where the interest budget and the retention sweep already put theirs.
   *
   * PER KIND rather than on `gcEveryWrites`, and that distinction is the reason this is separate
   * machinery: registry litter grows per write of a KEYED kind, so a global counter would walk
   * every registry in the space because somebody streamed a million chunks. What runs here is a
   * walk of the registry that just grew.
   *
   * Same shape as the retention sweep otherwise: no timer, awaited so it is deterministic and
   * bounded, guarded against stacking, and a failure is swallowed because housekeeping must never
   * fail the write that happened to trigger it.
   */
  private async maybeCompactKind(kind: string): Promise<void> {
    if (this.ctx.compactEveryWritesPerKind <= 0) return;
    // Only kinds a compaction pass would actually walk. `NEVER_COMPACT` and unkeyed kinds are
    // asked about once per write and answered from the in-process registry, never the database.
    const def = this.kinds.get(kind);
    const keyed = kind === INTEREST || (def !== undefined && (def.contentKey?.length ?? 0) > 0);
    if (!keyed) return;
    const n = (this.writesSinceCompact.get(kind) ?? 0) + 1;
    if (n < this.ctx.compactEveryWritesPerKind) {
      this.writesSinceCompact.set(kind, n);
      return;
    }
    this.writesSinceCompact.set(kind, 0);
    if (this.compactingKind.has(kind)) return;
    this.compactingKind.add(kind);
    try {
      await compactRegistries(this.compactionHost(), { runId: this.ctx.runId, only: kind });
    } catch { /* the litter waits for the next trigger or the verb */ } finally {
      this.compactingKind.delete(kind);
    }
  }

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
   * Verify the event chain, reporting the FIRST divergence.
   *
   * "The chain is invalid" is not an answer anyone can act on. The position, the event it covers,
   * and which of the four ways it failed are, and they are what distinguishes a truncated restore
   * from an edited row.
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
          const verdict = await this.sealKey.verify(seal.hash, seal.sig);
          // A link signed under a RETIRED key that nobody supplied is un-checkable, not forged.
          // Calling it a bad signature would report a rotation as tampering, which is the one
          // verdict this report exists to be trusted on.
          if (verdict === "unknown_key") {
            return fail(
              seal.idx,
              seal.eventId,
              "unknown_key",
              "this link was signed under a seal key this space does not hold; supply it (RADIA_SEAL_KEY_RETIRED) to check links from before the rotation",
            );
          }
          if (verdict === "bad") {
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

  /** Every digest a surviving `artifact` record carries, paged to EXHAUSTION: a bounded read would
   *  present a prefix as the population, and both callers act on this set (one deletes what is
   *  absent from it, the other re-seals what is in it). */
  private async referencedDigests(): Promise<Set<string>> {
    const live = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const rows = await this.query({ kind: ARTIFACT }, 500, { dir: "desc", after });
      for (const rec of rows) {
        const d = (rec.body as { digest?: unknown }).digest;
        if (typeof d === "string") live.add(d);
      }
      if (rows.length < 500) break;
      after = rows[rows.length - 1].id;
    }
    return live;
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
