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
import { newestByKey, opsGrantKey } from "../../sdk/ts/registry.ts";

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
  },
  {
    kind: NOTE,
    indexedPaths: [
      { path: TEAM_FIELD, type: "keyword" },
      { path: "topic", type: "keyword" },
      { path: "to", type: "keyword" },
    ],
    claimable: false,
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
): Promise<TeamMember> {
  const teams = opts.teams?.length ? opts.teams : [DEFAULT_TEAM];
  // An `extra` grant is scoped the same way, per team: a grant handed out beside the standard set
  // must not be the one unscoped hole that reads across every team.
  const extra = teams.flatMap((team) =>
    (opts.extra ?? []).map((g) => ({ principal: agent, ...g, pattern: { [TEAM_FIELD]: team } }))
  );
  const def = await admin.createAgentDefinition(agent, [...memberGrants(agent, teams), ...extra]);
  if (opts.observe) {
    const power = { principal: agent, operations: ["observe"] };
    // Content-keyed, and written only when a member is CREATED. An `ops_grant` never compacts and
    // a re-put outranks a `retired: true` tombstone, so re-asserting one on any schedule would
    // silently undo an operator's deliberate withdrawal (CLAUDE.md, registry writes).
    await admin.put({ kind: "ops_grant", body: power }, opsGrantKey(power));
  }
  return def;
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
