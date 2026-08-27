// A TEAM: several agent harnesses (Claude Code, Codex, anything that speaks MCP) sharing one
// space so they can pass work between them. The convention is two kinds of its own (`task`, `note`),
// two it extends with the team field (`artifact`, `capability`), and one grant set;
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
import { CAPABILITY, CAPABILITY_KIND, retireProviderCapabilities } from "./capability.ts";
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
 * its result. `to` makes a mailbox (`match: {to: "agent:codex"}`), `topic` makes a thread. A NAME
 * belongs here and not on `task`: a note is mail, addressed by the one who knows the recipient,
 * while a claimable record's performer is what the claim decides.
 *
 * `capability` is how a member says what it can do, so `task.tags` has something to match against.
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
    // work here. `tags` is the routing field, stating what the work NEEDS so a claimant can match
    // it. `assignee` is indexed too, but it names a performer rather than a property, which is the
    // writer answering the question the claim exists to answer: it binds nothing (no grant reads
    // it), and a task addressed to a member who leaves is claimable forever, since retention GC
    // never sweeps unclaimed claimable work. Hence the usage string below: tag it as well, always.
    indexedPaths: [
      { path: TEAM_FIELD, type: "keyword" },
      { path: "assignee", type: "keyword" },
      { path: "tags", type: "array" },
    ],
    usage: "Work for whoever can do it. body: {title, detail?, tags?, assignee?}. " +
      "ROUTE WITH `tags` (string[]): they say what the work needs, and a claimant matches them " +
      "({tags: {$any: 'review'}}; scalars do not distribute over arrays). `assignee` is a " +
      "PREFERENCE: nothing enforces it, anyone may claim a task addressed to someone else, so tag " +
      "every task. Settle with space_ack (resultKind 'note'), never a separate put: only the ack " +
      "is fenced. No status field, and a SETTLED task still comes back from space_query looking " +
      "open: to tell, read space_children for its result note.",
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
  {
    // The other direction from `tags`. A task's tags are the WRITER's claim about the work; this is
    // a member's claim about ITSELF, which is what lets "who should do this" be answered at claim
    // time instead of by whoever wrote the record. Without it a team has no channel for a member to
    // say what it can do, and `assignee` is what people reach for in its absence.
    ...CAPABILITY_KIND,
    // Extended with `team` for the same reason `artifact` is: the grant pattern IS the isolation,
    // and a kind carrying no `team` path can hold no pattern that compiles.
    indexedPaths: [...CAPABILITY_KIND.indexedPaths, { path: TEAM_FIELD, type: "keyword" }],
    // `team` JOINS the key. Under (provider, tool) alone, one member advertising one tool in two
    // teams is ONE registry entry: compaction keeps the newer and the other team's copy disappears
    // with nothing reporting it. Absence is a value in the key (`keyOf`, src/core/gc.ts), so
    // records written without a team (the chat's workers) keep grouping exactly as they did.
    contentKey: [...(CAPABILITY_KIND.contentKey ?? []), TEAM_FIELD],
    usage: "What YOU can do, so work reaches you by content rather than by name. body: " +
      "{tool, provider, def}, where `provider` is your own principal and `def` is the " +
      "function-calling shape {type:'function', function:{name, description, parameters}}. " +
      "Publish one per thing you can do; re-publishing an unchanged one is free. Read the team's " +
      "with {kind: 'capability'} before deciding a task is yours or nobody's.",
  },
];

/** The operations a member holds per kind. The TEAM is what bounds them, and it is applied as a
 *  grant pattern rather than left to each write to respect. `put` on `note` is what lets a member
 *  ack a task with its result.
 *
 *  `query` on `capability` is not a nicety beside the `put`: `publishCapability` reads before
 *  writing, and a publisher that cannot read republishes an unchanged definition under the key it
 *  already used, so a RETIRED advertisement never revives and the member serves a tool nothing can
 *  discover (`capability.ts`). */
export const MEMBER_GRANTS: { kind: string; operations: string[] }[] = [
  { kind: TASK, operations: ["put", "take", "query", "read_one"] },
  { kind: NOTE, operations: ["put", "query", "read_one"] },
  { kind: ARTIFACT, operations: ["put", "query", "read_one"] },
  { kind: CAPABILITY, operations: ["put", "query", "read_one"] },
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
   *  count, since anything that stores bytes holds it, and neither does `capability`, which every
   *  tool worker on the space publishes. */
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

/**
 * Declare the team's kinds. Idempotent: a `kind_def` is content-keyed, so re-running writes nothing.
 * Returns the kind names, so a caller can report what a space now understands.
 *
 * A REDECLARATION REPLACES, so a SHARED kind must be extended rather than restated. `artifact` is
 * reserved and three things extend it: the chat adds `conversationId`/`owner`/`workspace`, the
 * analysis pipeline adds `owner`, and this adds `team`. The runtime guards only ITS OWN paths
 * (`assertReservedCompatible` keeps `digest`/`mediaType`/`claimable`), so it cannot tell one app's
 * addition from another's, and declaring the list flat dropped whichever app got there first:
 * measured, `radia team add` on a space running the chat left `artifact` indexed on
 * `[digest, mediaType, team]`, after which every chat query and every new chat grant naming
 * `conversationId` was refused as an undeclared path. That is somebody else's authorization
 * scoping, broken by a verb that never mentions them.
 *
 * So the paths are UNIONED with whatever is already declared. A path this build does not know is
 * kept rather than dropped, which is the direction that cannot break an app that is not running
 * right now.
 */
export async function declareTeamKinds(admin: RadiaClient): Promise<string[]> {
  const live = await liveKinds(admin);
  for (const def of TEAM_KINDS) await admin.registerKind(mergeKind(live.get(def.kind), def));
  return TEAM_KINDS.map((d) => d.kind);
}

/** The newest declaration per kind name, which is what the registry projects and what a merge has
 *  to extend. Retirements included: reviving a retired kind is a redeclaration like any other. */
async function liveKinds(admin: RadiaClient): Promise<Map<string, KindDef>> {
  const rows = await admin.queryAll<KindDef>({ kind: KIND_DEF });
  const out = new Map<string, KindDef>();
  for (const [name, rec] of newestByKey<KindDef>(rows, (b) => b.kind)) out.set(name, rec.body);
  return out;
}

/**
 * `declared` extended with every indexed path the space already carries for that kind.
 *
 * ADDITIVE ON PATHS ONLY. Everything else (`claimable`, `contentKey`, `usage`) is this build's
 * opinion and is stated, because those are single-valued: merging them would mean picking a winner
 * with no basis. Paths are a set, so a union is the one merge that is always safe.
 */
export function mergeKind(existing: KindDef | undefined, declared: KindDef): KindDef {
  if (!existing?.indexedPaths?.length) return declared;
  const paths = [...declared.indexedPaths];
  const seen = new Set(paths.map((p) => p.path));
  for (const p of existing.indexedPaths) {
    // The TYPE this build declares wins on a genuine conflict: it is the one compiled against here,
    // and a path declared twice with two types is a conflict no merge can resolve silently.
    if (!seen.has(p.path)) paths.push(p);
  }
  return { ...declared, indexedPaths: paths };
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
  return (await readDefinition(admin, agent)).state;
}

/** The same read, plus the RECORD ID the answer rests on, which is what makes acting on it atomic:
 *  `createAgentDefinition({supersedes})` keys the write to this id, so a caller that decided on a
 *  state somebody else has since changed loses rather than adding a second live definition. */
export async function readDefinition(
  admin: RadiaClient,
  agent: string,
): Promise<{ state: "none" | "active" | "revoked"; id: string | null }> {
  const rows = await admin.queryAll<DefinitionBody>({ kind: AGENT_DEFINITION, match: { agent } });
  const newest = newestByKey<DefinitionBody>(rows, (b) => b.agent).get(agent);
  if (!newest) return { state: "none", id: null };
  return { state: newest.body.status === "revoked" ? "revoked" : "active", id: newest.id };
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
  opts: {
    teams?: string[];
    observe?: boolean;
    extra?: { kind: string; operations: string[] }[];
    /** The definition record this create replaces, from `readDefinition`. Passing it makes the
     *  read-then-create atomic; omitting it keeps the unconditional write. */
    supersedes?: string | null;
  } = {},
): Promise<TeamMember & { observe: ObserveChange }> {
  const teams = opts.teams?.length ? opts.teams : [DEFAULT_TEAM];
  // An `extra` grant is scoped the same way, per team: a grant handed out beside the standard set
  // must not be the one unscoped hole that reads across every team.
  const extra = teams.flatMap((team) =>
    (opts.extra ?? []).map((g) => ({ principal: agent, ...g, pattern: { [TEAM_FIELD]: team } }))
  );
  const def = await admin.createAgentDefinition(
    agent,
    [...memberGrants(agent, teams), ...extra],
    "supersedes" in opts ? { supersedes: opts.supersedes ?? null } : {},
  );
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
  const newest = [...newestByKey<DefinitionBody>(rows, (b) => b.agent)];
  const out = await mapWithConcurrency(newest, ROSTER_CONCURRENCY, async ([agent, rec]) => {
    const perms = await admin.permissions(agent);
    const onTeamKinds = perms.kinds.filter((k) => k.kind === TASK || k.kind === NOTE);
    return {
      agent,
      active: rec.body.status !== "revoked",
      member: onTeamKinds.length > 0,
      unscoped: onTeamKinds.length > 0 && onTeamKinds.some((k) => k.patterns.length === 0),
      teams: teamsOf(perms),
      kinds: perms.kinds,
      opsPowers: perms.opsPowers ?? [],
    };
  });
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

/**
 * How many `permissions` reads the roster has in flight.
 *
 * ONE READ PER DEFINITION IS THE DESIGN, not an oversight to optimise away. The roster's whole
 * value is that it reports ENFORCEMENT rather than what a setup command once assigned, and every
 * grant bug in this codebase so far was a promise that did not match enforcement. Folding the raw
 * `grant` registry here instead would be a second implementation of `authorize`'s pattern and
 * operation logic, which is the bug class the verb exists to catch.
 *
 * So what is bounded is WALL CLOCK, not cost: the space still does the same work, and each call is
 * O(that principal's grant history), measured at 93ms against 5,000 grant records
 * (agent_docs/plan-registry-cost.md), capped per principal since then. Serial, a space with fifty
 * definitions spent fifty round trips end to end for a table nobody paginates.
 */
const ROSTER_CONCURRENCY = 8;

/** `Promise.all` with a ceiling, so a roster does not open one connection per definition. Order is
 *  preserved, because the caller sorts and a shuffled intermediate would hide that. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** What offboarding actually closed. Every field is a COUNT of work done, not an intention, so the
 *  verb can report the cascade rather than assert it. */
export interface MemberRemoval {
  agent: string;
  /** False when the definition was already revoked: the door was shut before this ran. */
  revoked: boolean;
  grantsRetired: number;
  /** Every ops power withdrawn, sorted. EVERY one, not just `observe`: removal means removal, and
   *  a `remediate` left standing comes back with the principal on the next `team add`. */
  opsPowersRetired: string[];
  /** Advertisements withdrawn. A capability record is what makes work reach a member BY CONTENT, so
   *  one left standing routes tasks to a principal that can no longer authenticate. Retiring the
   *  grant does not retire the record: the projection reads what was written, not who may write. */
  capabilitiesRetired: number;
  /** Run ids actually stopped, split by the two classes a principal acts through. */
  stoppedOwn: string[];
  stoppedDelegated: string[];
}

/**
 * Withdraw EVERY ops power a principal holds, and report what went.
 *
 * Separate from `reconcileObserve`, which deliberately refuses to touch a grant carrying `observe`
 * alongside another power: on a ROTATION, silently dropping somebody's `remediate` would be a
 * narrowing nobody asked for. On REMOVAL there is no such tension, because taking everything back
 * is what the verb means.
 */
async function retireOpsGrants(admin: RadiaClient, agent: string): Promise<string[]> {
  const rows = await admin.queryAll<OpsGrantBody>({ kind: "ops_grant", match: { principal: agent } });
  const gone = new Set<string>();
  for (const rec of activeByKey<OpsGrantBody>(rows, opsGrantKey).values()) {
    await admin.put(
      { kind: "ops_grant", body: { ...rec.body, retired: true } },
      `${opsGrantKey(rec.body)}:remove:after:${rec.id}`,
    );
    for (const op of rec.body.operations ?? []) gone.add(op);
  }
  return [...gone].sort();
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
  //
  // BOTH PRINCIPALS. Authority an agent may exercise only through a delegated run is held under
  // `delegable:<agent>`, a separate principal, so a query for `agent` alone does not see it. It is
  // unreachable while the definition stays revoked, and that is not the failure: a later
  // `team add` of the same name RESTORES it, silently, having been granted by nobody.
  let grantsRetired = 0;
  for (const principal of [agent, `delegable:${agent}`]) {
    const rows = await admin.queryAll<GrantBody>({ kind: "grant", match: { principal } });
    for (const rec of activeByKey<GrantBody>(rows, grantKey).values()) {
      await admin.put(
        { kind: "grant", body: { ...rec.body, retired: true } },
        `${grantKey(rec.body)}:remove:after:${rec.id}`,
      );
      grantsRetired++;
    }
  }
  const opsPowersRetired = await retireOpsGrants(admin, agent);
  // AFTER the grants, for the same reason the runs come last: this is a withdrawal of a claim, not
  // of authority, and it is best-effort by construction (`retireProviderCapabilities` swallows a
  // failed read). The provider a member publishes under is its own principal.
  const capabilitiesRetired = await retireProviderCapabilities(admin, [agent]);

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
  return { agent, revoked, grantsRetired, opsPowersRetired, capabilitiesRetired, stoppedOwn, stoppedDelegated };
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
