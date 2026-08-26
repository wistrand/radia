// A TEAM: several agent harnesses (Claude Code, Codex, anything that speaks MCP) sharing one
// space so they can pass work between them. The convention is two kinds and one grant set;
// everything that makes it work (claiming, fencing, at-least-once delivery, lineage) is the
// runtime's own coordination and is not restated here.
//
// It lives in `extensions/` for the usual reason: the runtime has no business knowing what a
// "task" is. `radia team` is an ordinary client that writes these records.
//
// WHY A MEMBER IS AN AGENT DEFINITION, NOT A RUN. A run is what `created_by` names, and a run
// dies at the 12h ceiling, so attribution resting on one lasts a day. A definition is durable and
// mint-only: every run it ever mints resolves back to the same `agent:` name, so "who wrote this"
// answers the same next year, across restarts and across machines. `radia revoke` is its off
// switch, and `radia runs --for` stops what it minted.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { AGENT_DEFINITION, ARTIFACT, KIND_DEF, type KindDef } from "../../sdk/ts/wire.ts";
import { activeByKey, grantKey, isRetired, newestByKey, opsGrantKey } from "../../sdk/ts/registry.ts";

export const TASK = "task";
export const NOTE = "note";

/** The body field that says which team a record belongs to, and the whole isolation mechanism.
 *  Named once here because it appears in three places that must agree: the kinds' indexed paths,
 *  every grant's pattern, and every write's body. */
export const TEAM_FIELD = "team";

/** Where a member lands when nobody says otherwise. A name rather than an absence: a record with
 *  NO team matches no pattern, so it is invisible to every member, and "unlabelled" would be a
 *  lane nobody could read rather than a shared one. */
export const DEFAULT_TEAM = "default";

/**
 * The kinds a team shares, and the field that separates teams within them.
 *
 * `task` is CLAIMABLE, so a lease is what stops two agents doing the same work twice. There is
 * deliberately no `status` field: state lives in the envelope (available / leased / acked), which
 * is the one copy nothing can disagree with, and a body field beside it is a second answer that
 * goes stale the moment a lease lapses.
 *
 * `note` is not claimable: it is what agents say to each other, and what a finished task acks as
 * its result. `to` makes a mailbox (`match: {to: "agent:codex"}`), `topic` makes a thread.
 *
 * `artifact` is RESERVED and redeclared here to add `team` alone. A reserved kind may be extended
 * and never shrunk (`src/core/kinds.ts`), and this extension is load-bearing rather than tidy: an
 * unscoped `artifact` grant is a documented way out of a compartment (`compartment.ts`), so bytes
 * would cross between teams while records did not.
 */
export const TEAM_KINDS: KindDef[] = [
  {
    kind: TASK,
    // `title` and `detail` are free text and index nothing: matching on prose is not what routes
    // work here. `tags` is how an agent claims what it is good at, `assignee` how a task names one.
    indexedPaths: [
      { path: TEAM_FIELD, type: "keyword" },
      { path: "assignee", type: "keyword" },
      { path: "tags", type: "array" },
    ],
    usage: "Work for whoever can do it. body: {title, detail?, tags?: string[], assignee?}. " +
      "Claim with space_take, then settle with space_ack (resultKind 'note') so the answer links " +
      "back to the request. There is no status field: the claim state IS the status. Match one tag " +
      "with {tags: {$any: 'review'}}; a scalar does not distribute over an array here.",
  },
  {
    kind: NOTE,
    indexedPaths: [
      { path: TEAM_FIELD, type: "keyword" },
      { path: "topic", type: "keyword" },
      { path: "to", type: "keyword" },
    ],
    claimable: false,
    usage: "What agents say to each other, and what a finished task acks as its result. " +
      "body: {to, message, topic?}. `to` is a member principal ('agent:name') or the literal 'all' " +
      "for the whole team. READ YOUR MAILBOX AS {to: {$in: ['<your principal>', 'all']}}: a keyword " +
      "match is exact, so watching your own name alone silently misses every broadcast. Use " +
      "`message` for the prose; nothing indexes it, but readers look for that name.",
  },
  {
    kind: ARTIFACT,
    // The reserved paths are REPEATED, not replaced: a redeclaration that dropped them would be a
    // shrink, which the runtime refuses, and rightly: `digest` is how an artifact is found at all.
    indexedPaths: [
      { path: "digest", type: "keyword" },
      { path: "mediaType", type: "keyword" },
      { path: TEAM_FIELD, type: "keyword" },
    ],
    claimable: false,
  },
];

/** The operations a member holds per kind. The TEAM is what bounds them, and it is applied as a
 *  grant pattern rather than left to each write to respect. `put` on `note` is what lets a member
 *  ack a task with its result. */
export const MEMBER_GRANTS: { kind: string; operations: string[] }[] = [
  { kind: TASK, operations: ["put", "take", "query", "read_one"] },
  { kind: NOTE, operations: ["put", "query", "read_one"] },
  { kind: ARTIFACT, operations: ["put", "query", "read_one"] },
];

/**
 * Grants that must NOT be team-scoped, because what they read has no team.
 *
 * `kind_def: query` is what `space_kinds` calls, and it is the FIRST thing an agent does: the
 * corollary to expressing features through the space is that an agent DISCOVERS its vocabulary
 * rather than being taught it, and a member that cannot list kinds has no way in. It was missing,
 * and the failure surfaced as `no 'query' grant for kind 'kind_def'` on a harness's opening call.
 *
 * UNSCOPED DELIBERATELY, and this is the trap: a `kind_def` body carries no `team` field, so a
 * pattern-scoped grant here would match NOTHING and refuse every declaration. The team pattern
 * belongs on the kinds that carry data, never on the ones that describe them.
 *
 * It reveals kind NAMES space-wide, not content. That is the same access `agent:local-observer`
 * holds, and the console's own note for it applies: the kind list is not a secret, since a scoped
 * principal already learns kinds by being refused one.
 */
export const DISCOVERY_GRANTS: { kind: string; operations: string[] }[] = [
  { kind: KIND_DEF, operations: ["query"] },
];

/** The half of an `agent_definition` body this file reads. */
interface DefinitionBody {
  agent?: string;
  /** "revoked" once `radia revoke` has run; absent otherwise. */
  status?: string;
}

/** A member's durable credential. The token is returned ONCE, at creation; nothing can read it
 *  back, so a lost one is rotated rather than recovered. */
export interface TeamMember {
  agent: string;
  definitionToken: string;
}

export interface RosterEntry {
  agent: string;
  /** False once `radia revoke` has run: the definition mints nothing further. */
  active: boolean;
  /** Holds a grant on `task` or `note`: this principal is on the team. Every OTHER definition on a
   *  space (an app's workers, a person's login) is not, and listing them all was the roster's
   *  first bug: a real space has dozens and the team was buried in them. `artifact` alone does not
   *  count, since anything that stores bytes holds it. */
  member: boolean;
  /** A member whose team-kind grants carry NO pattern, so it reads EVERY team. The state a member
   *  created before teams existed is in, and the one worth shouting about: adding teams around it
   *  changes nothing until it is rotated. Detectable only in the clear case, because an UNSCOPED
   *  grant contributes no entry to `patterns`, so one sitting beside a scoped grant is invisible
   *  here exactly as it is in `radia permissions`. */
  unscoped: boolean;
  /** The teams this principal can reach, read from the patterns on its grants. More than one is a
   *  CROSSER: the way work moves between teams, and one of the two things `radia team` reports. */
  teams: string[];
  /** Coordination grants, as the enforcement path reports them. */
  kinds: { kind: string; operations: string[] }[];
  /** Ops-plane powers. `observe` here means this member reads EVERY team, whatever its grants say. */
  opsPowers: string[];
}

/** Declare the team's kinds. Idempotent: a `kind_def` is content-keyed, so re-running writes
 *  nothing. Returns the kind names, so a caller can report what a space now understands. */
export async function declareTeamKinds(admin: RadiaClient): Promise<string[]> {
  for (const def of TEAM_KINDS) await admin.registerKind(def);
  return TEAM_KINDS.map((d) => d.kind);
}

/**
 * One grant per (kind, team), each PATTERN-SCOPED to its team.
 *
 * The pattern is what makes isolation default-deny rather than a convention every member has to
 * respect: `bodyMatchesGrant` refuses a write whose body carries another team's label OR NO LABEL
 * AT ALL, so there is no unlabelled lane to fall into, and a read is `grant ∧ request`, so an
 * unscoped `query {kind: "task"}` returns this team's records and nothing tells the caller there
 * were others.
 *
 * Several teams means several grants, which UNION: a member holding two reaches both, which is how
 * work crosses between teams. `teamsOf` reads that back off the enforcement path and `radia team`
 * reports it, together with the other door: `observe`. NOT `radia compartment`, which answers a
 * KIND-compartment question and calls every member a crosser for reading `task` and writing
 * `artifact`.
 */
export function memberGrants(
  agent: string,
  teams: string[] = [DEFAULT_TEAM],
): { principal: string; kind: string; operations: string[]; pattern?: Record<string, unknown> }[] {
  return [
    ...teams.flatMap((team) => MEMBER_GRANTS.map((g) => ({ principal: agent, ...g, pattern: { [TEAM_FIELD]: team } }))),
    ...DISCOVERY_GRANTS.map((g) => ({ principal: agent, ...g })),
  ];
}

/** The teams a principal can reach, read from the grant patterns that enforce it rather than from
 *  what a setup command once passed. */
export function teamsOf(perms: { kinds: { patterns: Record<string, unknown>[] }[] }): string[] {
  const out = new Set<string>();
  for (const k of perms.kinds) {
    for (const p of k.patterns) {
      const t = p[TEAM_FIELD];
      if (typeof t === "string") out.add(t);
    }
  }
  return [...out].sort();
}

/**
 * Does this principal already hold a definition, and does it still mint?
 *
 * Read before creating one, because a SECOND definition for one agent is not a rotation and looks
 * like one: both tokens keep minting, while `radia revoke` reaches only the newest
 * (`Space.definitionRecord` takes the newest record's status). Rotating means revoke, then create.
 */
export async function definitionState(admin: RadiaClient, agent: string): Promise<"none" | "active" | "revoked"> {
  const rows = await admin.queryAll<DefinitionBody>({ kind: AGENT_DEFINITION, match: { agent } });
  const newest = newestByKey<DefinitionBody>(rows, (b) => b.agent).get(agent);
  if (!newest) return "none";
  return newest.body.status === "revoked" ? "revoked" : "active";
}

/**
 * Add a member: a durable principal holding exactly its teams' grants.
 *
 * `observe` DEFEATS team isolation and is therefore off unless asked for. It is the one power that
 * opens `space_get`, `space_lineage`, `space_children`, `space_stats` and `space_events`, and it
 * opens them UNSCOPED: measured, a member whose coordination grants are scoped to one team, and
 * whose `query` correctly returns only that team's records, reads another team's record by id off
 * the ops plane anyway. There is no tier between the two, because the scoped one is
 * `createdBy: "self"` and a teammate's record is not yours.
 */
export async function addMember(
  admin: RadiaClient,
  agent: string,
  opts: { teams?: string[]; observe?: boolean; extra?: { kind: string; operations: string[] }[] } = {},
): Promise<TeamMember & { observe: ObserveChange }> {
  const teams = opts.teams?.length ? opts.teams : [DEFAULT_TEAM];
  // An `extra` grant is scoped the same way, per team: a grant handed out beside the standard set
  // must not be the one unscoped hole that reads across every team.
  const extra = teams.flatMap((team) =>
    (opts.extra ?? []).map((g) => ({ principal: agent, ...g, pattern: { [TEAM_FIELD]: team } }))
  );
  const def = await admin.createAgentDefinition(agent, [...memberGrants(agent, teams), ...extra]);
  // The DECLARED state, so an omitted `observe` takes the power back rather than leaving it. That
  // is the same rule `createAgentDefinition` already applies to grants (it supersedes what it
  // declares), and without it the power had no removal path at all: rotation revokes the
  // definition, `ops_grant` is keyed to the PRINCIPAL, and rotation does not change that.
  const observe = await reconcileObserve(admin, agent, opts.observe === true);
  // REPORTED, never re-derived by the caller: what was asked for and what happened differ whenever
  // the power was already in the requested state, and a caller that assumes prints the wrong line.
  return { ...def, observe };
}

/** What `reconcileObserve` did, for a caller that has to report it rather than assume it. */
export type ObserveChange = "granted" | "retired" | "unchanged";

/** An `ops_grant` body, as this verb writes it and as an operator may have written one. */
interface OpsGrantBody {
  principal?: string;
  operations?: string[];
  retired?: boolean;
}

/**
 * Bring `observe` to the state asked for, by READING what is in force first.
 *
 * Conditional on the current state rather than unconditional, which is what keeps the re-put trap
 * closed: an `ops_grant` never compacts and a plain re-put OUTRANKS a `retired: true` tombstone, so
 * asserting the power on any schedule would silently undo an operator's withdrawal. Reading first
 * makes the healthy case a no-op.
 *
 * Both writes ANCHOR on the record they supersede (`:after:<id>`). A constant key would let a power
 * be taken back exactly once, ever: the second retirement would be an idempotent replay of the
 * first and the power would stay live. Same rule, and the same reason, as `supersedeGrantsFor`.
 *
 * A record granting `observe` ALONGSIDE other powers is REFUSED rather than retired. This verb
 * wrote `["observe"]` and speaks for that; dropping somebody's `remediate` as a side effect of
 * taking back `observe` is not a thing to do quietly.
 */
export async function reconcileObserve(admin: RadiaClient, agent: string, want: boolean): Promise<ObserveChange> {
  const power = { principal: agent, operations: ["observe"] };
  const key = opsGrantKey(power)!;
  const rows = await admin.queryAll<OpsGrantBody>({ kind: "ops_grant", match: { principal: agent } });
  // Newest per identity, TOMBSTONES INCLUDED: a retirement is the record a revive has to anchor on,
  // so this cannot be `activeByKey`, which drops exactly those.
  const newest = newestByKey<OpsGrantBody>(rows, opsGrantKey);
  const live = [...newest.values()].filter((r) => !isRetired(r.body) && (r.body.operations ?? []).includes("observe"));

  if (want) {
    if (live.length) return "unchanged";
    const prior = newest.get(key);
    await admin.put({ kind: "ops_grant", body: power }, prior ? `${key}:after:${prior.id}` : key);
    return "granted";
  }
  if (live.length === 0) return "unchanged";
  const mixed = live.filter((r) => (r.body.operations ?? []).some((op) => op !== "observe"));
  if (mixed.length) {
    throw new Error(
      `'${agent}' holds observe as part of a wider power (${
        mixed.map((r) => (r.body.operations ?? []).join(",")).join("; ")
      }), which this verb did not write and will not silently narrow. ` +
        `Retire that ops_grant deliberately, or leave it.`,
    );
  }
  for (const rec of live) {
    await admin.put(
      { kind: "ops_grant", body: { ...rec.body, retired: true } },
      `${opsGrantKey(rec.body)}:retire:after:${rec.id}`,
    );
  }
  return "retired";
}

/**
 * Who is on the team, and what each one can actually do.
 *
 * Read from `effectivePermissions` rather than from what a setup command once assigned: every
 * grant bug in this codebase so far was a promise that did not match enforcement, and the roster
 * is the thing a person checks before believing one.
 */
export async function teamRoster(admin: RadiaClient): Promise<RosterEntry[]> {
  const rows = await admin.queryAll<DefinitionBody>({ kind: AGENT_DEFINITION });
  const newest = newestByKey<DefinitionBody>(rows, (b) => b.agent);
  const out: RosterEntry[] = [];
  for (const [agent, rec] of newest) {
    const perms = await admin.permissions(agent);
    const onTeamKinds = perms.kinds.filter((k) => k.kind === TASK || k.kind === NOTE);
    out.push({
      agent,
      active: rec.body.status !== "revoked",
      member: onTeamKinds.length > 0,
      unscoped: onTeamKinds.length > 0 && onTeamKinds.some((k) => k.patterns.length === 0),
      teams: teamsOf(perms),
      kinds: perms.kinds,
      opsPowers: perms.opsPowers ?? [],
    });
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

/** What offboarding actually closed. Every field is a COUNT of work done, not an intention, so the
 *  verb can report the cascade rather than assert it. */
export interface MemberRemoval {
  agent: string;
  /** False when the definition was already revoked: the door was shut before this ran. */
  revoked: boolean;
  grantsRetired: number;
  observe: ObserveChange;
  /** Run ids actually stopped, split by the two classes a principal acts through. */
  stoppedOwn: string[];
  stoppedDelegated: string[];
}

/**
 * Remove a member: close every door membership opened, in the order that keeps them closed.
 *
 * REVOKE FIRST so nothing new can be minted, then withdraw authority, then stop what is already
 * running. The other order leaves a window in which the definition mints a replacement for the run
 * just stopped.
 *
 * The two RUN CLASSES both count, and this is the half that is easy to miss: `agent_run{agent: X}`
 * is the member's own sessions, and `agent_run{actingFor: X}` is a run some WORKER holds on their
 * behalf. `radia runs --for` covers both because it shipped covering only one and left the other
 * live for up to the run ceiling; the same mistake is available here and is why the query is two.
 *
 * GRANTS ARE RETIRED, not left. A revoked definition cannot authenticate, but `mintDelegatedRun`
 * resolves its caller from a RECORD's author and intersects with that principal's live grants
 * without consulting whether the definition still mints. Leaving them standing means a worker
 * processing one of the member's leftover records can still act on their behalf.
 */
export async function removeMember(admin: RadiaClient, agent: string): Promise<MemberRemoval> {
  const revocation = await admin.revokeDefinition(agent);
  const revoked = revocation.applied && !revocation.alreadyRevoked;

  // Live grants, retired as successors ANCHORED on the record each supersedes, the same rule
  // `supersedeGrantsFor` keeps: a constant key retires an identity once ever, so a later re-grant
  // of the same content would outlive the next removal.
  const grantRows = await admin.queryAll<GrantBody>({ kind: "grant", match: { principal: agent } });
  let grantsRetired = 0;
  for (const rec of activeByKey<GrantBody>(grantRows, grantKey).values()) {
    await admin.put(
      { kind: "grant", body: { ...rec.body, retired: true } },
      `${grantKey(rec.body)}:remove:after:${rec.id}`,
    );
    grantsRetired++;
  }
  const observe = await reconcileObserve(admin, agent, false);

  // The DATABASE clock, never this process's: `expiresAt` is stamped by the space, and a local
  // clock running fast reads a live run as expired and skips stopping it. That run then RENEWS
  // itself up to the 12h ceiling, because `renewRun` checks the run's own status and never the
  // definition behind it (CLAUDE.md, "All time comparisons use the database clock").
  const now = (await admin.health()).now;
  const stoppedOwn: string[] = [];
  const stoppedDelegated: string[] = [];
  for (const [field, out] of [["agent", stoppedOwn], ["actingFor", stoppedDelegated]] as const) {
    const rows = await admin.queryAll<RunBody>({ kind: "agent_run", match: { [field]: agent } });
    // Newest per run, RETIREMENTS INCLUDED: a stop is a successor, and this caller must see it
    // rather than have it projected away and stop the run a second time.
    for (const rec of newestByKey<RunBody>(rows, (b) => b.run).values()) {
      const b = rec.body;
      if (!b.run || b.status === "stopped" || !((b.expiresAt ?? "") > now)) continue;
      if ((await admin.stopRun(b.run)).applied) out.push(b.run);
    }
  }
  return { agent, revoked, grantsRetired, observe, stoppedOwn, stoppedDelegated };
}

/** The half of a `grant` body this file rewrites. */
interface GrantBody {
  principal?: string;
  kind?: string;
  operations?: string[];
  retired?: boolean;
}

/** The half of an `agent_run` body offboarding reads. */
interface RunBody {
  run?: string;
  status?: string;
  expiresAt?: string;
}
