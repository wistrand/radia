// Identity: who a principal is, and the credentials that let it act.
//
// The bootstrap chain, end to end. An operator creates an agent DEFINITION holding the hash of a
// durable, mint-only token; that token mints short-lived RUN tokens; a run is what acts, and it
// dies at a fixed ceiling. OIDC is a third way to mint into the same chain rather than a parallel
// auth model, and delegation mints a run whose authority is an intersection. Everything downstream
// (leases, idempotency scope, audit, grants) sees an ordinary run whatever minted it.
//
// UNLIKE `authorization.ts`, this module WRITES, and it has to: a credential comes into existence
// as a record. The port below is therefore wider, and the discipline moves to what it does NOT
// hold. There is no credential cache here and must not be: a stopped run, an expired token and a
// token minted on another instance are all discovered by reading records per request. The one memo
// (`CredentialStore`) holds only facts that are immutable for the life of a run, which is why a
// revocation cannot be outrun by it (agent_docs/plan-bounded-reads.md).
//
// Every read here is a NARROW one: `newestByHash` matches a single `tokenHash` and takes the
// newest 1, and a stop or revocation is written as a SUCCESSOR CARRYING THE SAME HASH, so the
// current state of a credential is one indexed lookup and never a projection over a page.
//
// Extracted from `space.ts` unchanged, where it was 1,073 lines of a 4,022-line file. `space.ts` is 3,036 after.

import type { Delegation, DelegatedGrant, ResolvedToken } from "./auth.ts";
import { hashToken, mintCredential } from "./auth.ts";
import type { CredentialStore } from "./auth.ts";
import type { Page, RadiaRecord, StorageAdapter } from "../storage/adapter.ts";
import type { ArtifactDef, GrantDef, GrantOp } from "./kinds.ts";
import { AGENT_DEFINITION, AGENT_RUN, GRANT, OIDC_IDENTITY, parseTaintAllowlist, validateGrantDef } from "./kinds.ts";
import type { Pattern } from "./matching.ts";
import type { PutRequest } from "./record.ts";
import { grantKey, isRetired, oidcIdentityKey, type RegistryView } from "./registry.ts";
import { OidcVerifier, type OidcConfig } from "./oidc.ts";
import { addSeconds } from "./time.ts";
import { newUlid, sha256Hex } from "./ids.ts";
import { RadiaError } from "./errors.ts";
import type { EffectivePermissions, MintedRun, RunRenewal } from "../../sdk/ts/wire.ts";
import type * as authz from "./authorization.ts";

/**
 * What the credential chain needs from a space.
 *
 * Wider than `AuthorizationHost` because minting is a WRITE, and narrow where it counts: the
 * authorization members are ASKED (`access`, `readAccess`, `isPrivileged`, `grantSubject`), never
 * reimplemented, so a delegated run cannot be attenuated here and not there.
 */
export interface IdentityHost {
  readonly creds: CredentialStore;
  readonly ctx: {
    principal: string;
    supervisor?: string;
    runTokenSeconds: number;
    runMaxLifetimeSeconds: number;
    maxOidcRunsPerSubject: number;
    oidc?: OidcConfig | null;
  };
  readonly storage: Pick<StorageAdapter, "now" | "getRecord" | "getEnvelope" | "quarantineLeasesOf">;
  readonly notifier: { notify(): void };
  /** The OIDC verifier memo, owned by the space because its lifetime is the space's. */
  readonly oidcState: { verifier: OidcVerifier | null };
  /** The one outbound-HTTP function, behind a field so a test can point it at an in-repo issuer. */
  oidcFetch(url: string): Promise<unknown>;

  /** The unauthorized write path: these records ARE the authorization state, so they cannot be
   *  written through a check that would read them. */
  putRaw(req: PutRequest, idempotencyKey?: string, opts?: { taint?: string[]; principal?: string }): Promise<{ id: string }>;
  putArtifact(bytes: Uint8Array, meta: { mediaType: string; filename?: string; parentIds?: string[]; meta?: Record<string, string | number | boolean | null> }, idempotencyKey?: string, principal?: string): Promise<{ id: string }>;
  readArtifact(recordId: string): Promise<{ record: RadiaRecord; def: ArtifactDef; stream: ReadableStream<Uint8Array> } | null>;
  query(pattern: Pattern, limit?: number, page?: Page): Promise<RadiaRecord[]>;
  registry<T = unknown>(
    kind: string,
    keyOf: (body: T, rec: RadiaRecord) => string | undefined,
    match?: Record<string, unknown>,
  ): Promise<RegistryView>;

  // Authorization, asked rather than reimplemented.
  isPrivileged(principal: string): boolean;
  grantSubject(principal: string): string;
  delegationOf(principal: string): Promise<Delegation | undefined>;
  access(principal: string, kind?: string): Promise<authz.GrantAccess>;
  readAccess(principal: string, op: GrantOp, kind: string): Promise<authz.ReadAccess>;
  authorAllows(createdBy: string[] | undefined, record: RadiaRecord): boolean;
  bodyMatchesGrant(kind: string, body: unknown, constraint: Record<string, unknown>[]): boolean;
  checkGrantPattern(def: GrantDef): void;
}
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
export interface RunState {
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
}/**
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
/**
 * Create an agent definition (operator action): store an `agent_definition` record holding the
 * sha256 of a freshly minted **definition token**, optionally assign its grants, and return the
 * token once. The definition token mints runs (`mintRun`); it is never stored in plaintext.
 */
export async function createAgentDefinition(host: IdentityHost, agent: string, grants: GrantDef[] = []): Promise<{ agent: string; definitionToken: string }> {
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
  if (host.isPrivileged(agent)) {
    throw new RadiaError(
      "invalid_principal",
      `'${agent}' is a privileged principal (an operator, or the space itself); a definition for it ` +
        `would be a permanent way to mint privileged runs. Name an ordinary principal and grant it ` +
        `what it needs.`,
    );
  }
  const { token, hash } = await mintCredential();
  await host.putRaw({ kind: AGENT_DEFINITION, body: { agent, tokenHash: hash } });
  for (const g of grants) {
    validateGrantDef(g);
    host.checkGrantPattern(g);
  }
  // One registry read per principal named here, taken BEFORE any write and reused for both the
  // revival check and the supersede. Never read it per grant inside the loop: superseding as
  // each grant lands makes grant N retire grant N-1 of the same (principal, kind, operations),
  // so a definition silently cannot declare two scopes at once.
  const views = new Map<string, RegistryView>();
  for (const p of new Set(grants.map((g) => g.principal))) {
    const view = await host.registry(GRANT, grantKey, { principal: p });
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
    await host.putRaw({ kind: GRANT, body: g }, idem);
  }
  await supersedeGrantsFor(host, grants, views);
  host.notifier.notify();
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
export async function supersedeGrantsFor(host: IdentityHost, declared: GrantDef[], views: Map<string, RegistryView>): Promise<void> {
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
    await host.putRaw(
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
export async function mintRun(host: IdentityHost, 
  definitionToken: string,
  opts: { reuse?: boolean } = {},
): Promise<MintedRun> {
  const now = await host.storage.now();
  const resolved = await resolveCredential(host, definitionToken, now); // hydrates a cross-instance def token
  if (!resolved.ok || resolved.kind !== "def") {
    throw new RadiaError("invalid_credential", "a valid agent-definition token is required to mint a run");
  }
  const agent = resolved.agent;
  // Derived from the PRESENTED token and never from its hash: the hash is in a record anyone with
  // read access can see, and would otherwise be enough to compute a live credential.
  const bucket = Math.floor(Date.parse(now) / (host.ctx.runMaxLifetimeSeconds * 1000));
  const derived = opts.reuse ? (await sha256Hex(`radia-run\n${definitionToken}\n${bucket}`)).slice(0, 48) : undefined;
  const { token, hash } = derived ? { token: derived, hash: await hashToken(derived) } : await mintCredential();
  if (derived) {
    const reused = await reuseRun(host, hash, now, agent, {}, (run) => host.creds.rememberRun(run, agent));
    if (reused) return { run: reused.run, agent, runToken: token, expiresAt: reused.expiresAt };
  }
  const run = `run:${newUlid()}`;
  const expiresAt = addSeconds(now, host.ctx.runTokenSeconds);
  // `mintedAt` is what bounds renewal: it is copied onto every successor, so the absolute deadline
  // is a property of the RUN and cannot be pushed forward by renewing.
  await host.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now } });
  host.creds.rememberRun(run, agent);
  host.notifier.notify();
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
export async function reuseRun(host: IdentityHost, 
  hash: string,
  now: string,
  agent: string,
  bodyExtra: Record<string, unknown>,
  remember: (run: string) => void,
): Promise<{ run: string; expiresAt: string } | undefined> {
  const prior = await newestByHash(host, AGENT_RUN, hash) as RunBody | undefined;
  if (!prior?.run) return undefined;
  if (prior.status === "stopped") throw new RadiaError("run_stopped", `run ${prior.run} was stopped`);
  if ((prior.expiresAt ?? "") > now) {
    remember(prior.run);
    return { run: prior.run, expiresAt: prior.expiresAt! };
  }
  const mintedAt = prior.mintedAt ?? now;
  if (addSeconds(mintedAt, host.ctx.runMaxLifetimeSeconds) > now) {
    const expiresAt = addSeconds(now, host.ctx.runTokenSeconds);
    await host.putRaw({
      kind: AGENT_RUN,
      body: { run: prior.run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt, ...bodyExtra },
    });
    remember(prior.run);
    host.notifier.notify();
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
export async function mintDelegatedRun(host: IdentityHost, worker: string, recordId: string, presentedToken?: string): Promise<DelegatedRunMint> {
  // No re-delegation. A delegated run is already bounded by somebody; letting it mint again
  // makes the chain unbounded and gives `actingFor` two meanings. The worker mints with its OWN
  // credential, which is the credential it holds anyway.
  if (await host.delegationOf(worker)) {
    throw new RadiaError("forbidden", "a delegated run may not delegate again; mint with the worker's own credential");
  }
  // The wall createAgentDefinition holds, at the other place a run can come into existence.
  // `isPrivileged` and the supervisor carve-out both short-circuit `authorize` before any
  // attenuation is consulted, so an attenuated run of either would be unattenuated in practice.
  const agent = host.grantSubject(worker);
  if (host.isPrivileged(worker)) {
    throw new RadiaError("forbidden", `'${agent}' is privileged; a delegated run of it would not be attenuated at all`);
  }
  if (agent === host.ctx.supervisor) {
    throw new RadiaError("forbidden", `'${agent}' is the supervisor; its grant/signal carve-out ignores attenuation`);
  }

  const record = await host.storage.getRecord(recordId);
  if (!record) throw new RadiaError("not_found", `no record ${recordId}`);
  // A worker holding DELEGABLE grants must prove a LEASE, not merely a read. Read access is
  // enough for a pure narrowing because the result is a subset of what the worker already holds;
  // a delegable grant breaks that, so the caller's request has to be one this worker actually
  // claimed rather than one it happened to see.
  const delegable = await delegableGrants(host, agent);
  if (!await mayActOn(host, worker, record, { requireLease: delegable.length > 0 })) {
    throw new RadiaError(
      "forbidden",
      delegable.length > 0
        ? `'${worker}' holds no lease on ${recordId}, and '${agent}' has delegable grants, which need one`
        : `'${worker}' neither holds a lease on ${recordId} nor may read it`,
    );
  }

  const actingFor = await callerOf(host, record);
  if (!actingFor) {
    throw new RadiaError("invalid_request", `record ${recordId} has no resolvable caller to act for`);
  }
  // A privileged caller has no grants to intersect WITH: authority it holds is not expressed as
  // grants at all. Reading that as "unrestricted" would hand the worker's full ambient reach to
  // anything an operator happens to trigger, and reading it as "empty" would break their session
  // silently. Refuse, and say which one it is.
  if (host.isPrivileged(actingFor)) {
    throw new RadiaError(
      "forbidden",
      `'${actingFor}' is privileged, so there is no grant set to narrow to; a delegated run cannot bound it`,
    );
  }

  // The worker side is its OWN grants plus its DELEGABLE ones. Both are needed and they answer
  // different halves: without the own grants a worker could not delegate what it already uses,
  // and without the delegable ones there is no way to narrow the worker at all, because an
  // intersection is a subset of what it holds (plan-delegation.md phase 3).
  const workerGrants = [...(await host.access(worker)).defs, ...delegable];
  const callerGrants = (await host.access(actingFor)).defs;
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

  const now = await host.storage.now();
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
  const bucket = Math.floor(Date.parse(now) / (host.ctx.runMaxLifetimeSeconds * 1000));
  const derived = presentedToken
    ? (await sha256Hex(
      `radia-delegated-run\n${presentedToken}\n${actingFor}\n${await sha256Hex(JSON.stringify(grants))}\n${bucket}`,
    )).slice(0, 48)
    : undefined;

  if (derived) {
    // `reuseRun` holds the three rules this shares with `mintRun`'s reuse: stopped stays stopped
    // (or `radia runs --acting-for … --stop` is undone by the worker's next call), live returns
    // with no write, and expired-inside-the-ceiling extends the same run.
    const reused = await reuseRun(host, 
      await hashToken(derived),
      now,
      agent,
      { actingFor, delegated: { grants } },
      (run) => host.creds.rememberRun(run, agent, delegation),
    );
    if (reused) return { run: reused.run, agent, runToken: derived, expiresAt: reused.expiresAt, actingFor };
  }

  const run = `run:${newUlid()}`;
  const expiresAt = addSeconds(now, host.ctx.runTokenSeconds);
  // No presented credential (an in-process caller, e.g. a test) means nothing to derive from, so
  // this mints a fresh random token and forgoes reuse rather than deriving from something
  // guessable.
  const token = derived ?? (await mintCredential()).token;
  const hash = await hashToken(token);
  await host.putRaw({
    kind: AGENT_RUN,
    body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now, actingFor, delegated: { grants } },
  });
  host.creds.rememberRun(run, agent, delegation);
  host.notifier.notify();
  return { run, agent, runToken: token, expiresAt, actingFor };
}

/** The `delegable` block of `effectivePermissions`, or nothing when the agent holds none. */
export async function delegableSection(host: IdentityHost, agent: string): Promise<{ delegable?: { kind: string; operations: GrantOp[] }[] }> {
  if (agent.startsWith(DELEGABLE_PREFIX)) return {}; // asking about the holder itself: it IS the list
  let defs: GrantDef[];
  try {
    defs = await delegableGrants(host, agent);
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
export async function delegableGrants(host: IdentityHost, agent: string): Promise<GrantDef[]> {
  const view = await host.registry(GRANT, grantKey, { principal: delegablePrincipal(agent) });
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
export async function mayActOn(host: IdentityHost, principal: string, record: RadiaRecord, opts: { requireLease?: boolean } = {}): Promise<boolean> {
  const env = await host.storage.getEnvelope(record.id);
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
      const { constraint, createdBy } = await host.readAccess(principal, op, record.kind);
      if (!host.authorAllows(createdBy, record)) continue;
      if (!constraint || host.bodyMatchesGrant(record.kind, record.body, constraint)) return true;
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
export async function callerOf(host: IdentityHost, record: RadiaRecord): Promise<string | undefined> {
  const author = record.runtimeMeta.createdBy;
  if (!author) return undefined;
  const delegation = await host.delegationOf(author);
  return delegation ? delegation.actingFor : host.grantSubject(author);
}

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
export async function mintOidcRun(host: IdentityHost, idToken: string): Promise<MintedRun> {
  const cfg = host.ctx.oidc;
  if (!cfg) throw new RadiaError("oidc_not_configured", "this space has no OIDC issuer configured (dev: --oidc-issuer + --oidc-audience)");
  // The DB clock is fetched LAZILY, through the verifier: this is the unauthenticated path,
  // and on Postgres `storage.now()` is a round trip, so a flood of garbage tokens must die on
  // string compares before the space pays any I/O for them (measured in bench/suites/oidc.ts).
  let nowIso: string | undefined;
  const nowMs = async () => Date.parse(nowIso ??= await host.storage.now());
  host.oidcState.verifier ??= new OidcVerifier(cfg, (url) => host.oidcFetch(url));
  const v = await host.oidcState.verifier.verify(idToken, nowMs);
  if (!v.ok) throw new RadiaError("invalid_credential", `id_token rejected: ${v.reason}`);
  const now = nowIso ?? (nowIso = await host.storage.now());

  // Who is this? The mapping registry decides; a raw claim never does. Fail CLOSED on an
  // incomplete view — an absent mapping changes who the caller IS, not just what they may do.
  const view = await host.registry(OIDC_IDENTITY, oidcIdentityKey, { iss: v.iss, sub: v.sub });
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
  if (host.isPrivileged(agent)) {
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
    return (await host.putArtifact(bytes, { mediaType: "application/json", filename: "oidc-profile.json" })).id;
  };
  if (!newest) {
    await host.putRaw(
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
        const got = await host.readArtifact(prev.profile);
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
      await host.putRaw(
        { kind: OIDC_IDENTITY, body: { ...rest, profile: await writeProfile({ ...known, ...display }) } },
        `oidc-enroll:${await sha256Hex(key)}:after:${newest.id}`,
      );
    }
  }

  // Replay: the derived token's run may already exist. Newest record wins, same as resolution.
  const token = (await sha256Hex(`radia-oidc-run\n${idToken}`)).slice(0, 48);
  const hash = await hashToken(token);
  const prior = await newestByHash(host, AGENT_RUN, hash) as
    | { run?: string; agent?: string; status?: string; expiresAt?: string }
    | undefined;
  if (prior?.run) {
    if (prior.status === "stopped") throw new RadiaError("run_stopped", `run ${prior.run} was stopped`);
    if ((prior.expiresAt ?? "") <= now) throw new RadiaError("token_expired", "this id_token's run has expired; sign in again for a fresh token");
    host.creds.rememberRun(prior.run, prior.agent ?? agent);
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
    const rows = await host.query({ kind: AGENT_RUN, match: { agent } }, 500, { dir: "desc", after });
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
  if (active >= host.ctx.maxOidcRunsPerSubject) {
    throw new RadiaError(
      "too_many_runs",
      `'${agent}' already holds ${host.ctx.maxOidcRunsPerSubject} active runs; wait for one to expire or stop one`,
    );
  }

  const run = `run:${newUlid()}`;
  const expiresAt = addSeconds(now, host.ctx.runTokenSeconds);
  await host.putRaw({ kind: AGENT_RUN, body: { run, agent, tokenHash: hash, status: "active", expiresAt, mintedAt: now } });
  host.creds.rememberRun(run, agent);
  host.notifier.notify();
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
export async function renewRun(host: IdentityHost, run: string): Promise<RunRenewal> {
  const now = await host.storage.now();
  const rows = await host.query({ kind: AGENT_RUN, match: { run } }, 5, { dir: "desc" });
  const bodies = rows.map((r) => r.body as RunBody);
  if (bodies.length === 0) throw new RadiaError("not_found", `no run ${run}`);
  if (bodies[0]?.status === "stopped") throw new RadiaError("run_stopped", `run ${run} was stopped`);
  const agent = bodies.find((b) => b.agent)?.agent;
  const tokenHash = bodies.find((b) => b.tokenHash)?.tokenHash;
  if (!agent || !tokenHash) throw new RadiaError("not_found", `no run ${run}`);
  // A run minted before `mintedAt` existed has no recorded start. Treat NOW as the start rather
  // than as unbounded: an unknown age must not read as a fresh one.
  const mintedAt = bodies.find((b) => b.mintedAt)?.mintedAt ?? now;
  const maxLifetimeAt = addSeconds(mintedAt, host.ctx.runMaxLifetimeSeconds);
  if (maxLifetimeAt <= now) {
    throw new RadiaError(
      "run_lifetime_exceeded",
      `run ${run} reached its maximum lifetime at ${maxLifetimeAt}; mint a new run`,
    );
  }
  // Never past the ceiling: the last renewal before it lands exactly on it.
  const window = addSeconds(now, host.ctx.runTokenSeconds);
  const expiresAt = window > maxLifetimeAt ? maxLifetimeAt : window;
  // The attenuation is COPIED, for the same reason `mintedAt` is: `resolveCredential` reads the
  // NEWEST body for a token hash, so a renewal that dropped these fields would hand back a run
  // that resolves as an ordinary one holding the worker's full grants.
  const carried = bodies.find((b) => b.actingFor);
  await host.putRaw({
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
  host.notifier.notify();
  return { run, agent, expiresAt, maxLifetimeAt };
}

/**
 * Stop a run: emit a successor `agent_run` record (status stopped) and invalidate its token so
 * no new operations resolve. Default (graceful) revocation leaves held leases to expire on
 * their own clocks. `quarantine: true` is emergency revocation: it additionally force-releases
 * the run's in-flight leases now (epoch-bumped, so a late ack/renew fences out as `lease_lost`).
 */
export async function stopRun(host: IdentityHost, 
  run: string,
  /** `by` is WHO stopped it, and it lands in the quarantine events. Absent means the space's own
   *  identity: an in-process caller is the runtime itself, not an anonymous "admin". */
  opts: { quarantine?: boolean; by?: string } = {},
): Promise<{ applied: boolean; quarantined: number }> {
  // Looked up in the SPACE, never in a cache. Consulting an in-memory index here makes stopping
  // a run this process has not seen (another instance's run, or one written before a restart)
  // silently report `applied: false` and leave the token working.
  const mint = await runRecord(host, run);
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
  await host.putRaw({
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
    const now = await host.storage.now();
    quarantined = await host.storage.quarantineLeasesOf(run, now, opts.by ?? host.ctx.principal);
  }
  host.notifier.notify();
  return { applied: true, quarantined };
}

/** Mint an operator token: no expiry, and it resolves to the SPACE'S OWN principal
 *  (`SpaceContext.principal`, `local:dev` by default), which `isPrivileged` covers. Not
 *  `human:local` — that is the named operator in `ctx.operators`, a different principal that a
 *  person can hold. Not a record either: a server-lifetime bootstrap credential, re-minted at
 *  startup, which is why it cannot be revoked and does not need to be. */
export async function mintOperatorToken(host: IdentityHost): Promise<string> {
  const { token, hash } = await mintCredential();
  host.creds.addOperator(hash);
  return token;
}

/** Resolve a presented bearer token to a principal, using the DB clock for expiry. */
export async function resolveToken(host: IdentityHost, token: string): Promise<ResolvedToken> {
  return await resolveCredential(host, token, await host.storage.now());
}

/**
 * Resolve a presented bearer token to a principal, from the RECORDS, on every request.
 *
 * There is no credential cache to go stale: a stopped run, an expired token and a token minted on
 * another instance are all discovered here rather than remembered. Both kinds index `tokenHash`,
 * so this is an indexed lookup, not a scan. And because a stop successor carries the same hash,
 * the newest record for that hash IS the current state of the credential.
 */
export async function resolveCredential(host: IdentityHost, token: string, now: string): Promise<ResolvedToken> {
  const hash = await hashToken(token);
  // Operator tokens are process-lifetime and never records (a credential is needed before any
  // agent exists), so they are the one thing answered from memory. They resolve to the space's
  // own principal: presenting the provisioned credential is exactly as authorized as presenting
  // no header at all in open mode. Never resolve one as `def`: that would let it mint a run,
  // turning a leaked operator token into a durable one.
  if (host.creds.isOperator(hash)) return { ok: true, kind: "operator", principal: host.ctx.principal };
  if (!/^[0-9a-f]{48}$/.test(token)) return { ok: false, reason: "invalid_token" };

  const run = await newestByHash(host, AGENT_RUN, hash);
  if (run) {
    const b = run as RunBody;
    if (!b.run || !b.agent) return { ok: false, reason: "invalid_token" };
    // Both facts are immutable for the life of the run, so both are safe to memo. Recording the
    // delegation HERE is what keeps `delegationOf` warm on every authenticated request; a memo
    // holding only the agent would assert "not delegated" and hand the run its worker's grants.
    // Successors copy the fields, so the newest body always carries them.
    host.creds.rememberRun(b.run, b.agent, delegationOfBody(b));
    if (b.status === "stopped") return { ok: false, reason: "run_stopped" };
    if (!b.expiresAt || b.expiresAt <= now) return { ok: false, reason: "token_expired" };
    return { ok: true, kind: "run", principal: b.run, agent: b.agent };
  }

  // Symmetric with the run branch above, and it was not: a definition used to authenticate on the
  // existence of a record alone. `newestByHash` already returns the newest record carrying this
  // hash, so a revocation successor lands here with no extra read.
  const def = await newestByHash(host, AGENT_DEFINITION, hash) as
    | { agent?: string; status?: string }
    | undefined;
  if (!def?.agent) return { ok: false, reason: "invalid_token" };
  if (def.status === "revoked") return { ok: false, reason: "definition_revoked" };
  return { ok: true, kind: "def", agent: def.agent };
}

/** The newest record of `kind` carrying this token hash. That is the current state of that
 *  credential, because a stop is written as a successor with the same hash. */
export async function newestByHash(host: IdentityHost, kind: string, tokenHash: string): Promise<unknown | undefined> {
  const rows = await host.query({ kind, match: { tokenHash } }, 1, { dir: "desc" });
  return rows[0]?.body;
}

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
export async function revokeDefinition(host: IdentityHost, agent: string, opts: { reason?: string } = {}): Promise<{ applied: boolean; alreadyRevoked: boolean }> {
  // Read from the SPACE, never a cache: revoking a definition this process has not seen (another
  // instance's, or one written before a restart) must not silently report `applied: false` and
  // leave the token minting.
  const def = await definitionRecord(host, agent);
  if (!def?.tokenHash) return { applied: false, alreadyRevoked: false };
  if (def.status === "revoked") return { applied: true, alreadyRevoked: true };
  await host.putRaw({
    kind: AGENT_DEFINITION,
    body: {
      agent,
      tokenHash: def.tokenHash,
      status: "revoked",
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  });
  host.notifier.notify();
  return { applied: true, alreadyRevoked: false };
}

/** The current state of a definition, folded over its successors the way `runRecord` folds a run's. */
export async function definitionRecord(host: IdentityHost, agent: string): Promise<{ tokenHash?: string; status?: string } | undefined> {
  const rows = await host.query({ kind: AGENT_DEFINITION, match: { agent } }, 5, { dir: "desc" });
  const bodies = rows.map((r) => r.body as { tokenHash?: string; status?: string });
  if (bodies.length === 0) return undefined;
  return { tokenHash: bodies.find((b) => b.tokenHash)?.tokenHash, status: bodies[0]?.status };
}

/** The mint record for a run (newest wins, so a stopped run reports its stop). */
export async function runRecord(host: IdentityHost, run: string): Promise<RunState | undefined> {
  const rows = await host.query({ kind: AGENT_RUN, match: { run } }, 5, { dir: "desc" });
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
export async function agentForRun(host: IdentityHost, run: string): Promise<string | undefined> {
  const memo = host.creds.agentForRun(run);
  if (memo) return memo;
  const rec = await runRecord(host, run);
  if (rec?.agent) host.creds.rememberRun(run, rec.agent);
  return rec?.agent;
}