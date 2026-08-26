# Teams: several agent harnesses on one space (architecture)

> Status: BUILT 2026-08-26. Source: [extensions/ts/team.ts](../extensions/ts/team.ts) (the
> convention), `src/surfaces/cli.ts` `case "team"` (the verb),
> [src/surfaces/mcp/config.ts](../src/surfaces/mcp/config.ts) (the harness config it prints) and
> [src/surfaces/mcp/scope.ts](../src/surfaces/mcp/scope.ts) (the write fill). Guards:
> `test/team.test.ts`. It sits on the ops-plane PATTERN tier, which it is the founding consumer of
> ([architecture-ops-tiers.md](architecture-ops-tiers.md)).

**What it is.** `radia team add claude-alpha claude-beta --team work` declares three kinds, mints one
durable principal per name, and prints the MCP block that points that harness at this space as that
principal. The point is that several agent harnesses (Claude Code, Codex, anything speaking MCP)
pass work between them through a space rather than through a shared filesystem, and that each one's
work is attributable and stoppable on its own.

## A member is an agent definition, not a run

A run is what `created_by` names, and a run dies at the 12h ceiling, so attribution resting on one
lasts a day. A definition is durable and mint-only: every run it ever mints resolves back to the
same `agent:` name, across restarts and across machines. `radia revoke` is its off switch and
`radia runs --for … --stop` ends what it minted.

ONE MEMBER PER SESSION, not per harness. One credential in two windows is one principal, so nothing
tells their work apart and stopping one stops both.

`radia mcp --session <name>` is the weaker alternative and is not what this uses: it keeps the same
RUN across restarts, which is continuity within a working day rather than an identity.

## Isolation is the grant pattern

| kind | claimable | separated by |
|------------|-----------|-------------------------------|
| `task` | yes | `pattern: {team: …}` on the grant |
| `note` | no | same |
| `artifact` | no | same, via a redeclaration adding `team` |

There is deliberately **no `status` field** on `task`: state lives in the envelope (available /
leased / acked), which is the one copy nothing can disagree with, and a body field beside it goes
stale the moment a lease lapses.

`artifact` is RESERVED and redeclared to add `team` alone (a reserved kind may be extended, never
shrunk). That is load-bearing rather than tidy: an unscoped `artifact` grant is a documented way out
of a compartment, so bytes would cross between teams while records did not.

**Default-deny by construction, verified end to end:**

```
alpha puts {team:"alpha", …}   → written
alpha puts {team:"beta",  …}   → refused   (forging another team)
alpha puts {…} with no team    → refused   (so there is no unlabelled lane)
alpha queries {kind:"task"}    → its own team, with no hint there were others
beta  takes  {kind:"task"}     → never alpha's
```

The refused UNLABELLED write is what makes it total. A body must carry the field its grant pattern
names and nothing server-side will add it, because a body is the client's claim.

## Three ways isolation ends, and `radia team` reports all of them

1. **An UNSCOPED member.** Grants on the team kinds with no pattern: it reads every team, and adding
   teams around it changes nothing until it is rotated. Shown as `TEAMS: ANY`, because a dash reads
   as "none", the opposite of what it means.
2. **A CROSSER.** Two `--team` values on one member, which is how work moves between teams.
3. **`observe`.** Unscoped by definition, so a member holding it reads every OTHER team off the ops
   plane while its own coordination query correctly answers empty. Opt-in for that reason.

`radia compartment` is NOT this audit and reads as though it is: it answers a kind-compartment
question, so it calls every member a crosser for reading `task` and writing `artifact`.

Detection has one stated limit: an unscoped grant contributes no entry to
`EffectivePermissions.kinds[].patterns`, so one sitting beside a scoped grant is invisible here
exactly as it is in `radia permissions`. The clear case is caught.

## The label is not the model's to remember

`src/surfaces/mcp/scope.ts` fills it in from the caller's own grant, on `space_put`, on
`space_ack`'s result body and on `space_put_artifact`'s meta.

**LEARNED FROM A REFUSAL, never stamped up front.** `patterns` unions the patterns of every grant on
a kind whatever operation it permits, so pre-stamping would add a label to a record written under an
UNSCOPED put grant, narrowing who may read it afterwards. Only a refusal proves the field is
required. One refusal per kind per process teaches it; everything after is a single round trip.

Ambiguity is asked about, never guessed: a crosser gets both team names back and must name one.

## `space_watch` answers two questions, and one of them needs `newOnly`

The default RECONCILES FIRST: a matching record that already exists comes back at once. That is
right for CLAIMABLE work, where taking the record is what removes it from the next answer, and it
is what makes "is there anything for me?" and "tell me when there is" the same call.

On a FACT kind nothing consumes anything, so the read behind it returns the same record for ever.
An agent asked to watch for new messages was handed a two-minute-old broadcast, twice, and
narrowing the pattern did not help because the pattern was not the problem. `newOnly: true` takes a
BASELINE at call time and reports only something written after it; the reply says which you got
(`existing`). The baseline is compared by `created_at`, the database clock, never by id: a ULID
carries the WRITING process's clock, so two agents' records can order backwards.

The result also stopped telling a model to `space_take` a record of a `claimable: false` kind. That
advice reads as authoritative because it comes from the tool rather than a prompt, and it sends the
model after an operation the space will never satisfy.

## Two grant sets, and mixing them is a trap

`MEMBER_GRANTS` carry the team pattern; `DISCOVERY_GRANTS` must not. `kind_def: query` is what
`space_kinds` calls and is the FIRST thing an agent does: an agent discovers its vocabulary rather
than being taught it. Adding it to the scoped set fails exactly as omitting it did: a `kind_def`
body has no `team`, so the pattern matches nothing and refuses every declaration.

**The team pattern belongs on kinds that carry data, never on the ones that describe them.**

## What a member cannot do

`space_stats`, `space_events` and `space_doctor` return nothing for pattern-scoped kinds. The
aggregates push to SQL, and the pushdown pre-filter is a sound OVER-approximation the oracle narrows
afterwards, so a `COUNT(*)` over it would report more rows than the caller may see. The kinds are
left out of the counts and NAMED in `OpsScope.patternScoped`, because a silent zero reads as "the
space is empty". Exact counts need oracle-evaluated counting under a scan budget; `events` needs
more still, since a log row carries no body. Both open.

`space_get`, `space_lineage`, `space_children`, `space_graph` and `space_thread` DO work per-team,
which is what the PATTERN tier bought and what stopped `observe` being handed to every member.

## The generated config names the binary that wrote it

Absolute, because `"command": "radia"` works only if the harness's PATH has it, which is the one
thing a generated config cannot check. A PATH scan is the mirror mistake and was rejected: it can
name a different build than the one writing the block. `--scope local` is spelled out in the
`claude mcp add` line, since the `user` scope writes one config for every project and collapses two
members into one principal.

Codex has no per-directory config (`~/.codex/config.toml` is user-level), so per-session principals
there rest on separate server names or on environment inheritance. Neither is enforcement; say so
rather than implying parity with Claude Code's local scope.

## Read before

Adding a grant to the member set (is it data or discovery?), assuming `radia compartment` audits a
team, relying on `space_stats` for a total, or proposing that the runtime stamp a body field.
