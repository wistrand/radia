// Authorization: who may do what, and what a grant narrows an answer to.
//
// Every decision here is a READ of the `grant` registry plus pure logic over what it returned. The
// port below holds no writer for the same reason `inspection.ts`'s does not: a module that cannot
// `put` cannot grow a cache of its own verdicts, and a cached authorization decision is a
// revocation that keeps working (see the credential index in agent_docs/plan-bounded-reads.md).
//
// ONE SEAM, and it is `access`. There are six entry points into authorization and five of them
// would otherwise read the worker's own grants directly, which is what a delegated run must never
// get (agent_docs/plan-delegation.md). Everything that needs grants goes through `access`, so the
// attenuation is applied in one place rather than remembered in five.
//
// Extracted from `space.ts` unchanged, where it was 515 lines of a 4,400-line file.

import type { CompiledMatch, DelegationContext, RadiaRecord } from "../storage/adapter.ts";
import type { GrantDef, GrantOp, KindDef } from "./kinds.ts";
import type { CredentialStore, Delegation } from "./auth.ts";
import { AGENT_RUN, GRANT, normalizeTaint, OPS_POWERS, parseTaintAllowlist, SIGNAL, WRITE_PROTECTED_KINDS } from "./kinds.ts";
import type { Pattern } from "./matching.ts";
import { combineMatch, matchesRecord } from "./matching.ts";
import { activeSet, grantKey } from "./registry.ts";
import { RadiaError } from "./errors.ts";
import type { EffectivePermissions, OpsPower } from "../../sdk/ts/wire.ts";
import { getLogger } from "../log.ts";

/**
 * What authorization needs from the space, and nothing more.
 *
 * Every member is a READ or immutable config. `registry` is the grant projection; `runRecord` is
 * the cold path behind `delegationOf`; `delegableSection` and `opsPowers` belong to the credential
 * and ops clusters and are asked, never reimplemented here.
 */
export interface AuthorizationHost {
  /** Immutable run→agent facts and the delegation memo. Never a grant cache. */
  creds: CredentialStore;
  /** The principals this space NAMES as operators, plus the supervisor carve-out. */
  ctx: { operators: string[]; principal: string; runId: string; supervisor?: string };
  kinds: { get(kind: string): KindDef | undefined };
  storage: { getRecord(id: string): Promise<RadiaRecord | null> };
  /** The grant registry, projected latest-wins. Read per decision, never memoized. */
  registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
    scope?: unknown,
  ): Promise<{ entries: Map<string, RadiaRecord>; newest: Map<string, RadiaRecord>; complete: boolean; scanned: number }>;
  /** The run's record, narrowed to what a delegation check reads. The credential cluster owns
   *  the full shape; asking for only these two is what keeps this port from widening into it. */
  runRecord(run: string): Promise<{ agent?: string; delegation?: Delegation } | undefined>;
  opsPowers(principal: string): Promise<Set<OpsPower>>;
  delegableSection(agent: string): Promise<{ delegable?: { kind: string; operations: GrantOp[] }[] }>;
  compile(pattern: Pattern): CompiledMatch;
}

/** Every grant in force for one principal, and where they came from. The single answer behind
 *  `authorize`, `readAccess`, `authorScope`, `authorizeWatch`, `opsScope` and
 *  `effectivePermissions`, so a delegated run cannot be attenuated in some of them. */
export interface GrantAccess {
  /** Operator or the space itself: no grant is read and nothing constrains it. Never true for a
   *  delegated run, whose mint refuses a privileged agent. */
  privileged: boolean;
  /** Set when the principal is a delegated run; `defs` then came from its own `agent_run` body. */
  delegated?: Delegation;
  defs: GrantDef[];
  complete: boolean;
  scanned: number;
}

/** Everything a READ is allowed to see: the pattern constraint AND the author restriction. */
export interface ReadAccess {
  /** Patterns the request must additionally satisfy (`null` = unrestricted). */
  constraint: Record<string, unknown>[] | null;
  /** Principals whose records are readable, or `undefined` for no author restriction. */
  createdBy?: string[];
  /** The allowlist the GRANTS impose, if they all impose one. Distinct from the caller's own
   *  `allowTaint`: this one the principal cannot decline. */
  allowTaint?: string[];
}

/** The subject grants are checked against: a `run:*` principal inherits its agent definition's
 *  grants (grants flow down the chain), so it authorizes as `agent:<name>`. Everything else
 *  authorizes as itself.
 *
 *  Public because the HTTP layer needs it to answer "is this principal asking about itself?"
 *  A run token asking for its AGENT's permissions is asking about itself, and refusing that is
 *  what left a scoped agent unable to tell an approved grant from a pending one. */
export function grantSubject(h: AuthorizationHost, principal: string): string {
  // Memo only, deliberately, so this stays synchronous on the hot path. Safe because the fact is
  // IMMUTABLE (a run's agent never changes) and because authentication populates it: every
  // request presenting a run token resolves that token first, from records. A miss falls back to
  // the run itself, which holds no grants (fail-closed, never fail-open).
  if (principal.startsWith("run:")) return h.creds.agentForRun(principal) ?? principal;
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
export async function delegationOf(h: AuthorizationHost, principal: string): Promise<Delegation | undefined> {
  if (!principal.startsWith("run:")) return undefined; // agents and humans are never delegated
  const known = h.creds.runFacts(principal);
  if (known) return known.delegation;
  const rec = await h.runRecord(principal);
  if (!rec?.agent) return undefined; // not a run this space knows; it holds no grants either way
  h.creds.rememberRun(principal, rec.agent, rec.delegation);
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
export function isPrivileged(h: AuthorizationHost, principal: string): boolean {
  const subject = grantSubject(h, principal);
  return h.ctx.operators.includes(subject) ||
    subject === h.ctx.runId || subject === h.ctx.principal;
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
export async function authorize(h: AuthorizationHost, principal: string, op: GrantOp, kind: string): Promise<Record<string, unknown>[] | null> {
  const acc = await access(h, principal, kind);
  // BEFORE both shortcuts below, because both return `null` (unrestricted) without reading a
  // grant, and a delegated run's whole authority is the attenuation they would skip. The mint
  // refuses a privileged or supervisor agent outright, so this is the second wall rather than
  // the only one; it is here because `isPrivileged` and the carve-out both resolve
  // `grantSubject`, which for a delegated run answers with the WORKER's agent.
  if (acc.delegated) {
    if ((op === "put" || op === "take") && WRITE_PROTECTED_KINDS.has(kind)) {
      throw new RadiaError("forbidden", `a delegated run may not write '${kind}' records`);
    }
    return constraintFrom(h, acc.defs, principal, op, kind);
  }
  if (acc.privileged) return null;
  const subject = grantSubject(h, principal);
  if ((op === "put" || op === "take") && WRITE_PROTECTED_KINDS.has(kind)) {
    // The supervisor's ENTIRE remaining privilege (architecture-ops-tiers.md phase 5): it assigns
    // grants and writes signals, which is the role's designed purpose, and nothing else rides
    // along. Never `ops_grant` (a power-granter can grant itself powers), never `agent_*`
    // (identity), never `shred`. Its grant-writes remain escalation-adjacent by design, and
    // every one is a RECORD in the audit trail, which is the difference from the bit it lost.
    if (op === "put" && (kind === GRANT || kind === SIGNAL) && subject === h.ctx.supervisor) {
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
  warnIfIncomplete(h, acc, principal, op, kind);
  return constraintFrom(h, acc.defs, principal, op, kind);
}

/**
 * THE authorization read: every grant in force for `principal` (on `kind`, or on every kind when
 * omitted), plus whether the read saw everything.
 *
 * One seam, because there are five entry points (`authorize`, `readAccess`, `authorScope`,
 * `authorizeWatch`, `effectivePermissions`) and a delegated run must be attenuated in ALL of
 * them. Adding the branch per call site is how four of them would keep reading the
 * worker's grants.
 *
 * Grants are records: for an ordinary principal this queries the ones for this (subject, kind).
 * ADDITIVE, not latest-wins: a principal may hold several grants on one kind (different
 * operations, different pattern scopes) and they coexist. So a revocation targets one GRANT,
 * identified by its content (`grantKey`), and `activeSet` drops exactly that entry while leaving
 * the others in force. Projecting by (principal, kind) instead would let a single revocation
 * silently take every grant on the kind with it.
 */
export async function access(h: AuthorizationHost, principal: string, kind?: string): Promise<GrantAccess> {
  const delegated = await delegationOf(h, principal);
  if (delegated) {
    // A delegated run reads NO grant record. Its authority was computed at mint and lives on its
    // own `agent_run` body, so it cannot widen when the worker's grants do, and `complete` is
    // true by construction (nothing was paged).
    const defs = delegated.grants
      .filter((g) => kind === undefined || g.kind === kind)
      .map((g) => ({ ...g, principal }) as GrantDef);
    return { privileged: false, delegated, defs, complete: true, scanned: defs.length };
  }
  if (isPrivileged(h, principal)) return { privileged: true, defs: [], complete: true, scanned: 0 };
  const subject = grantSubject(h, principal);
  const view = await h.registry(GRANT, grantKey, kind === undefined ? { principal: subject } : { principal: subject, kind });
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
 * information to say so was right here: `h.kinds` is what authorization is standing next to.
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
function noGrant(h: AuthorizationHost, principal: string, what: string, kind: string): RadiaError {
  // The remedy is in the SPACE's vocabulary, not a surface's. The first version said "list
  // them with 'radia kinds'", which is useless to the reader that actually hits this — a model
  // holding tools, not a shell — and is `src/core` naming a CLI verb it should not know exists.
  // "Query kind_def" is true through every surface and directly actionable by anything holding
  // the read, because kinds ARE records.
  const undeclared = h.kinds.get(kind)
    ? ""
    : `; '${kind}' is not a declared kind on this space, so no grant would help — query 'kind_def' for the ones that are`;
  // NAME THE SUBJECT A GRANT WOULD BE WRITTEN AGAINST, not only the principal that asked. A run
  // inherits its definition's grants, so `run:01M…` is the wrong half of the answer for the two
  // readers of this sentence: a model deciding what to ask for, and a person reading a trace. Both
  // need `agent:<name>`, which is what a `grant` record's `principal` holds. Measured in the lab:
  // a session was told a run id had no `tool_call: put` grant and had no way to name itself.
  const subject = grantSubject(h, principal);
  const who = subject === principal ? `'${principal}'` : `'${subject}' (acting as ${principal})`;
  return new RadiaError("forbidden", `principal ${who} has no ${what} kind '${kind}'${undeclared}`);
}

/** The pattern constraint an already-read grant set imposes. Split from the read so `readAccess`
 *  can answer three questions from ONE view; the rule is unchanged. */
function constraintFrom(h: AuthorizationHost, 
  grants: GrantDef[],
  principal: string,
  op: GrantOp,
  kind: string,
): Record<string, unknown>[] | null {
  const applicable = grants.filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
  if (applicable.length === 0) throw noGrant(h, principal, `'${op}' grant for`, kind);
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
export async function authorScope(h: AuthorizationHost, principal: string, op: GrantOp, kind: string): Promise<string[] | undefined> {
  // Only grants that permit THIS operation are relevant. A `put`-only grant says nothing about
  // reads, and counting it as "an unscoped grant on this kind" lifts the read restriction the
  // moment a read grant is narrowed while the write grant stays as it was.
  const acc = await access(h, principal, kind);
  if (acc.privileged || !selfScoped(h, acc.defs, op)) return undefined;
  // A delegated run's self scope is its CALLER's, which is what the caller's own grant meant.
  // The mint refuses self-scoped grants today (plan-delegation.md 1d), so this is unreachable
  // until it stops doing so; resolving it to the worker would be the inversion that rule exists
  // to prevent.
  const subject = acc.delegated ? grantSubject(h, acc.delegated.actingFor) : grantSubject(h, principal);
  return await runPrincipalsOf(h, subject, acc.delegated ? acc.delegated.actingFor : principal);
}

/** Do ALL the grants permitting `op` carry `scope: {createdBy: "self"}`? Split from the read so
 *  `readAccess` can answer from one view. */
function selfScoped(h: AuthorizationHost, grants: GrantDef[], op: GrantOp): boolean {
  const applicable = (grants as (GrantDef & { scope?: { createdBy?: string } })[])
    .filter((g) => Array.isArray(g.operations) && g.operations.includes(op));
  return applicable.length > 0 && applicable.every((g) => g.scope?.createdBy === "self");
}

/** The taint allowlist an already-read grant set imposes on `op`, or `undefined` for none. A
 *  grant carrying `scope: {taint: …}` moves the barrier to the side that assigns authority, where
 *  an operator can impose it; `take`'s `allowTaint` is the claimant's own opt-in and is a
 *  convention, not a control. Applied only when EVERY applicable grant carries it, the rule
 *  `authorScope` uses: grants UNION, so one grant without the barrier already permits tainted
 *  work. Reached through `readAccess` only (a standalone entry point was dead code, 2026-09-05). */
function barrierFrom(h: AuthorizationHost, grants: GrantDef[], op: GrantOp): string[] | undefined {
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
export async function readAccess(h: AuthorizationHost, principal: string, op: GrantOp, kind: string): Promise<ReadAccess> {
  // ONE registry read for all three answers. Asking separately cost four storage reads per
  // coordination verb — the `grant` registry paged to exhaustion three times over, once per
  // question, plus the `agent_run` read behind a self scope — for three views of the same set.
  const acc = await access(h, principal, kind);
  if (acc.privileged) return { constraint: null, createdBy: undefined, allowTaint: undefined };
  warnIfIncomplete(h, acc, principal, op, kind);
  const constraint = constraintFrom(h, acc.defs, principal, op, kind);
  // Still one read: `authorScope` would repeat it. A delegated run's "self" is its CALLER (see
  // there), which is unreachable today because the mint refuses self-scoped grants.
  const who = acc.delegated ? acc.delegated.actingFor : principal;
  const createdBy = selfScoped(h, acc.defs, op)
    ? await runPrincipalsOf(h, grantSubject(h, who), who)
    : undefined;
  return { constraint, createdBy, allowTaint: barrierFrom(h, acc.defs, op) };
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
function warnIfIncomplete(h: AuthorizationHost, view: { complete: boolean; scanned: number }, principal: string, op: GrantOp, kind: string): void {
  if (view.complete) return;
  getLogger("core.authz").warn(
    "grant view is INCOMPLETE; this decision was computed from part of its grants",
    { principal, op, kind, scanned: view.scanned },
  );
}

/** Does `record` fall inside an author restriction? `undefined` restriction means unrestricted. */
export function authorAllows(h: AuthorizationHost, createdBy: string[] | undefined, record: { runtimeMeta: { createdBy: string } }): boolean {
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
export async function runPrincipalsOf(h: AuthorizationHost, subject: string, principal: string): Promise<string[]> {
  // PAGED TO EXHAUSTION, never a bounded `query(kind, N)`. `agent_run` grows by one record per
  // mint plus one per stop, and a live run re-mints before expiry, so a long-lived agent passes
  // any fixed limit, and the records that fall off a newest-first page are its OLDEST runs. This
  // list is what `take`, lineage, graph, artifact bytes and watch wakeups narrow to, so a
  // truncated one does not merely hide old history: the agent's own older records become
  // unclaimable, and `rankClaimable` skips them silently, indistinguishable from an empty queue.
  //
  // One entry per run (a stop is a successor carrying the same `run`), so the projection key is
  // the run id.
  const view = await h.registry<{ run?: unknown }>(
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
export async function effectivePermissions(h: AuthorizationHost, principal: string): Promise<EffectivePermissions> {
  const subject = grantSubject(h, principal);
  const acc = await access(h, principal);
  if (acc.privileged) {
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
  for (const g of acc.defs as (GrantDef & { scope?: { createdBy?: string } })[]) {
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
      // scope line as evidence of acc it did not have. The grant is honoured as written (kinds
      // may be declared later), and said to be empty.
      ...(h.kinds.get(r.kind) ? {} : { kindNotDeclared: true as const }),
      // Asked of `authorScope` rather than recomputed here. Never restate the rule: a
      // restatement aggregates scoped/unscoped across ALL grants on the kind, while enforcement
      // considers only grants permitting THAT OPERATION, so a scoped `query` beside an unscoped
      // `put` reads as unscoped. A view that can drift from the decision is worse than no view,
      // because it is believed.
      readsScopedToSelf: (await authorScope(h, principal, "query", r.kind)) !== undefined,
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
    ...(acc.delegated ? { actingFor: acc.delegated.actingFor } : {}),
    // And an agent's own answer names what it can reach ONLY by delegating. Omitting it would
    // make this view under-report a worker's reach, which is the same failure as over-reporting:
    // the point of the page is that it matches enforcement.
    ...(acc.delegated ? {} : await h.delegableSection(subject)),
    kinds,
    ops: { reachable: opsKinds.length > 0, kinds: opsKinds.sort() },
    opsPowers: [...await h.opsPowers(principal)].sort(),
    complete: acc.complete,
  };
}

/** The operations under which a principal observes records, so a grant carrying any of them
 *  qualifies its holder to watch the kind. `put` is not one: a writer is told nothing. */
const WATCH_OPS: GrantOp[] = ["query", "take", "read_one"];

/**
 * Authorize a watch on `kind`. A watch OBSERVES matching records (its SSE payload is record
 * existence + ids + kind + timing), so it is allowed if the principal holds a grant carrying any
 * OBSERVING op on the kind (`WATCH_OPS`: a watcher may hold only `take`, like the agentLoop, or
 * only `read_one`, like a result consumer). Returns the UNION of those grants' patterns to AND
 * into the watch match (`null` = unrestricted / privileged), so a watcher only wakes on records
 * inside its grant scope, the same content-scoping `query`/`take` get. Throws `forbidden` if the
 * principal has no grant for the kind (closing the last unguarded coordination verb).
 */
export async function authorizeWatch(h: AuthorizationHost, principal: string, kind: string): Promise<ReadAccess> {
  // Retracted grants are subtracted here too. A watch observes records, so a revocation that
  // stopped `query` but left `watch` standing would revoke nothing that matters.
  const acc = await access(h, principal, kind);
  if (acc.privileged) return { constraint: null };
  // Only grants that let the principal OBSERVE records count, and only their patterns union. A
  // put-only grant is not participation in the reads, and a put grant's pattern is a bound on what
  // may be WRITTEN, so folding it in let an unscoped put widen a pattern-scoped query to the whole
  // kind's ids and timing (2026-09-05). `readAccess` filters by one op; a watch serves every
  // observing op at once, which is why it takes the union of the three.
  const grants = (acc.defs as (GrantDef & { scope?: { createdBy?: string } })[])
    .filter((g) => Array.isArray(g.operations) && WATCH_OPS.some((op) => g.operations.includes(op)));
  const subject = acc.delegated ? grantSubject(h, acc.delegated.actingFor) : grantSubject(h, principal);
  if (grants.length === 0) throw noGrant(h, principal, "grant to watch", kind);
  // A self scope narrows a watch for the same reason it narrows `query`: otherwise approving
  // "its own records" streams every author's record ids, kinds and activity timing on the kind.
  // Applied only when EVERY grant on the kind is self-scoped, matching `authorScope`. Grants
  // union, so one unscoped grant already permits observing other authors.
  const createdBy = grants.every((g) => g.scope?.createdBy === "self")
    ? await runPrincipalsOf(h, subject, principal)
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
export function bodyMatchesGrant(h: AuthorizationHost, kind: string, body: unknown, patterns: Record<string, unknown>[]): boolean {
  return patterns.some((t) => {
    try {
      return matchesRecord({ kind, body } as RadiaRecord, h.compile({ kind, match: t }));
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
export async function deriveDelegation(h: AuthorizationHost, owner: string, leasedRecordId: string): Promise<DelegationContext | undefined> {
  if (isPrivileged(h, owner)) return undefined; // root/operator work is not delegated
  const actor = grantSubject(h, owner); // the agent behind the run; grants live here
  const parent = await h.storage.getRecord(leasedRecordId);
  const parentChain = parent?.runtimeMeta.delegationContext?.chain ?? [];
  return { chain: [...parentChain, actor], origin: leasedRecordId };
}

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
export async function computeTaint(h: AuthorizationHost, 
  parentIds: string[],
  clientRaise: string[] | undefined,
  writer: string,
): Promise<string[]> {
  // A RAISE may name the reserved label (see `clientTaint`): it only restricts the writer's
  // own record. The allowlist direction is where it is refused.
  const labels = new Set<string>(normalizeTaint(clientRaise, { reserved: true }));
  for (const pid of parentIds) {
    const p = await h.storage.getRecord(pid);
    if (!p) continue;
    for (const l of p.runtimeMeta.taint) labels.add(l);
    // Derived from another principal's record. Compared on the grant SUBJECT, so a run and the
    // agent it instantiates are the same author and a worker does not taint its own lineage.
    if (grantSubject(h, p.runtimeMeta.createdBy) !== grantSubject(h, writer)) labels.add("foreign");
  }
  return [...labels].sort();
}