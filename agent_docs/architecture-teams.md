# Teams: several agent harnesses on one space (architecture)

> Status: BUILT 2026-08-26. Source: [extensions/ts/team.ts](../extensions/ts/team.ts) (the
> convention), `src/surfaces/cli.ts` `case "team"` (the verb),
> [src/surfaces/mcp/config.ts](../src/surfaces/mcp/config.ts) (the harness config it prints) and
> [src/surfaces/mcp/scope.ts](../src/surfaces/mcp/scope.ts) (the write fill). Guards:
> `test/team.test.ts`. It is the founding consumer of the ops-plane PATTERN tier
> ([architecture-ops-tiers.md](architecture-ops-tiers.md)).

`radia team add claude-alpha codex-alpha --team work` puts MCP-capable agent harnesses (Claude
Code, Codex, anything speaking the protocol) on one space so they pass work between them. It
declares the kinds they share, mints one durable principal per name, and prints the config block
that points that harness here as that principal. No application code is written.

```
claude-alpha: space_put  {kind:"task", body:{title:"sum the first 1000 primes", assignee:"codex"}}
codex-alpha:  space_take {kind:"task", match:{assignee:"codex"}}   -> claimId, lease held for it
codex-alpha:  space_ack  {claimId, resultKind:"note", resultBody:{answer:3682913}}
claude-alpha: space_watch {kind:"note", newOnly:true}              -> the answer, parented on the task
```

## What is core, what is the extension, what is the surface

This is the repo's admission rule (`extensions/README.md`) applied to one feature, and it is worth
reading as the worked example: almost nothing here is runtime.

| Tier | What teams put there | Why there |
|--------------------------|----------------------------------------------|--------------------------------|
| **Core** (`src/core`, `server`, `storage`) | the ops-plane PATTERN tier, and nothing else | authorization is enforcement; a convention cannot add a read tier |
| **Extension** (`extensions/ts/team.ts`) | `task`/`note`, the `artifact` redeclaration, the grant sets, the roster projection | two apps would want the same shape; the runtime has no business knowing what a "task" is |
| **Surface** (`src/surfaces/`) | `radia team`, the harness config, the write fill | ways to reach a space that are not raw HTTP |

**The runtime gained one thing, and only because authorization cannot live above it.** Teams need
"read what my grant pattern already covers" on the ops plane, and a read tier is enforcement, so it
had to be core. Everything else composes primitives that already existed: claiming, fencing,
at-least-once delivery, lineage, the definition/run chain, pattern-scoped grants and
`bodyMatchesGrant` are all untouched.

**The extension imports the SDK and never `src/`**, enforced by `test/layering.test.ts`. That rule
is what makes the tier real rather than a naming convention: if `team.ts` could reach into the
runtime, "teams" would quietly become a runtime concept and the next app would inherit it.

## What it demonstrates about Radia

Each row is a design claim made elsewhere in these docs, and the moment it becomes observable.

| Claim | Where you see it |
|-------------------------------------|--------------------------------------------------------------|
| Work is routed by CONTENT, not addressed | neither agent names the other; a `task` is claimed by whoever matches its pattern |
| A lease is what stops duplicate work | two agents, one task: the second `space_take` returns nothing, not a second copy |
| Authorization is by record content | a write carrying another team's label is refused at the write, with no check in any app code |
| Records are immutable, and a result is a new record | the answer is a `note` parented on the task, so the exchange is a graph rather than a mutation |
| Attribution outlives a session | `radia get <id>` names the agent a year later; the run it was written under is long gone |
| Agents DISCOVER their vocabulary | `space_kinds` is the first call; nothing about the space is in the tool list |

The four examples demonstrate the same properties and cost more to reach: `pipeline` shows fan-out,
`analysis` content-keyed staleness, `mud` contention, `chat` a full LLM agent. Each is a program
somebody wrote and a reader has to read. This is two products a reader already runs, and the code
they coordinate through is none.

## What you gain

Against the three things people reach for instead:

**A shared filesystem or a scratch directory.** Nothing refuses a bad write, nothing records who
wrote what, and two agents editing one file is a lost update. Here a wrong write is refused by the
runtime, every record carries its author, and history is append-only.

**A queue or a task file.** A queue moves a message and stops; the answer needs a second channel,
and correlating them is the caller's problem. Here the answer IS a record others match on, carrying
lineage back to the request, so `radia get`, `radia lineage` and the event chain cover the exchange
without anything being logged on purpose.

**Driving both agents yourself.** You are then the transport, and the exclusivity is your attention.
A lease is exclusivity the space enforces, and it survives you looking away.

## What it is NOT for

**Nothing external wakes a harness that is not running.** A task can sit in the space indefinitely;
the runtime fires at no deadline, by decision (`availableAt` defers claimability, there is no
sweeper, and an idle space runs nothing). Somebody has to start the agent.

**Once one IS running, it can watch without being poked each time.** A harness that can spawn a
subagent (Claude Code's is one) can hand it a loop of `space_watch {newOnly: true}` calls and let it
react to what arrives; each call blocks up to 120 seconds, so the loop is what spans a working
session. That is the practical shape for "tell me when the other agent answers", and it costs one
instruction rather than a code change. It is bounded by the SESSION, not by the space: the watcher
dies with the harness, and it is polling, so it spends tokens while it waits.

For work that must be picked up with no session alive at all, the answer is a worker on `agentLoop`
(the SDK's event-driven loop, which holds a real watch stream), not a harness on MCP.

**"MCP cannot push" is false as a statement about the PROTOCOL and true as one about the clients,
and the second is what decides whether to build anything.** Since 2026-07-28 there is a named
mechanism: `subscriptions/listen`, a client-initiated long-lived request whose response is an open
stream of notifications, working on stdio as well as HTTP (each frame carries
`io.modelcontextprotocol/subscriptionId`, so several subscriptions demultiplex on one channel).

Three things stack up, and the third is the one that settles it:

1. **This adapter sends nothing.** `write()` is a general frame writer and only reply paths call it;
   we advertise `capabilities: {tools: {listChanged: false}}`. A choice, not a wall.
2. **The notification filter is a CLOSED set**: `toolsListChanged`, `promptsListChanged`,
   `resourcesListChanged`, `resourceSubscriptions` (resource URIs). No arbitrary domain event, so
   pushing "a note arrived for you" means publishing a mailbox as a RESOURCE and letting
   `notifications/resources/updated` carry it.
3. **Nothing consumes resource subscriptions.** They are unsupported by most clients including
   Claude Desktop and Claude Code, and a server cannot even detect support, because whether a client
   subscribes was never part of capability negotiation. The evidence that matters is MCP APPS, the
   most widely adopted extension and the one whose headline case is a live dashboard: it USES
   resources (a tool declares `_meta.ui.resourceUri`, the host fetches a `ui://` resource) and
   routes its live updates around subscriptions entirely, over a postMessage app bridge.

**So do not build resources in order to get push.** Resources themselves are well adopted; the
SUBSCRIPTION half is a path the ecosystem's own flagship extension declined to walk, and today's
clients are built around a request/response prompt cycle that has nowhere to deliver an unsolicited
message into. An earlier version of this section called closing the gap "a scoped project against a
standard", which reads as encouragement; a standard nobody implements is a WEAKER reason to build
than an untested one, not a stronger.

What remains true: the subagent watch loop above already covers the case a running session cares
about, and it works today with no protocol work at all.

`sampling/createMessage` used to be listed here as the affordance that would drive model work.
**Sampling is DEPRECATED** in 2026-07-28 (with Roots and Logging, on a twelve-month support window),
so do not build on it either. Mid-flight input is now MRTR (`resultType: "input_required"`) or the
Tasks extension's `inputRequests`.

**It is not a security boundary against the agent itself.** A member's token IS its authority and it
sits in a config file the harness reads. Teams separate honest agents from each other's work; they
do not contain an agent that has been prompt-injected into using what it holds. What they DO contain
is the blast radius: a member reaches its own team's records and nothing else, so "what could this
credential touch" has a small answer.

**Per-session separation is enforced only where the harness supports it.** Claude Code's
`--scope local` keys config to a directory, so two projects are two principals and the space
enforces the difference. Codex reads one user-level `~/.codex/config.toml`, so two Codex sessions
share an entry unless given separate server names, and that is a naming convention. Say so rather
than implying parity.

**`observe` still crosses teams**, which is why it is opt-in. A member holding it reads every other
team off the ops plane while its own coordination query correctly answers empty.

**The aggregates do not cover pattern-scoped kinds.** `space_stats`, `space_events` and
`space_doctor` report nothing for `task`/`note`, because an exact count needs the oracle rather than
the SQL pre-filter, which is a sound OVER-approximation by contract. The kinds are NAMED in
`OpsScope.patternScoped` rather than silently counted as zero. Use `space_query` for totals.

**It is not chatty-cheap.** Every tool call is an HTTP round trip and a model turn. This suits
handing over units of work, not a conversation: for that, exchange fewer and larger records.

**Bytes do not travel in records, through the model, or over a shared filesystem.** Anything bigger
than a body is an artifact, and both directions are a short-lived capability URL:
`space_put_artifact {link: true}` to send, `space_get_artifact {link: true}` to receive. Neither
puts bytes in a context window and neither assumes the agents share a machine, which is what makes
this work for an agent that is not local. (`space_put_artifact {path}` also exists and is simpler
when you DO share a filesystem with the adapter.) Both gaps were found the same way: a tool that
could not do the job sent the agent looking for its own credential.

**`foreign` taint accumulates and will saturate.** Any record derived from another principal's
record is labelled `foreign` (`computeTaint`), so in a collaboration space nearly everything carries
it within a few exchanges. An agent claiming with `requireUntainted: true` therefore stops being
able to claim as threads deepen, and a grant carrying `scope.taint` would bar the same work. This is
the saturation [design-taint.md](design-taint.md) records for the old taint BOOLEAN, reappearing
under a label. Unresolved, and the reason not to reach for the taint barrier as a team mechanism.

**Teams are static.** A grant pattern is fixed, so "only what is relevant to me right now" is not
expressible, for the same reason fog of war is not in [plan-mud.md](plan-mud.md). A member's team is
a property of its grants, not of what it is currently doing.

## A member is an agent definition, not a run

A run is what `created_by` names, and a run dies at the 12h ceiling, so attribution resting on one
lasts a day. A definition is durable and mint-only: every run it ever mints resolves back to the
same `agent:` name, across restarts and across machines. `radia revoke` is its off switch and
`radia runs --for … --stop` ends what it minted.

ONE MEMBER PER SESSION, not per harness. One credential in two windows is one principal, so nothing
tells their work apart and stopping one stops both.

`radia mcp --session <name>` is the weaker alternative for IDENTITY and is not what this uses: it
keeps the same RUN across restarts, which is continuity within a working day rather than an
identity. It is load-bearing for something else, though. MCP 2026-07-28 is stateless and says a
stdio process "is not a conversation or session", so a claim must be settleable by a LATER adapter
process; a settle is owner-bound, so that only works when the run came back the same. Without a
named session the adapter releases its claims when stdin closes, because nothing later could ever
settle them; with one it keeps them and `recoverClaim` rederives the lease from the envelope.

A SECOND definition for one agent is not a rotation and looks exactly like one: both tokens keep
minting while `radia revoke` reaches only the newest. `radia team add` refuses it and names
`--rotate`, which revokes before it creates.

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
alpha puts {team:"alpha", …}   -> written
alpha puts {team:"beta",  …}   -> refused   (forging another team)
alpha puts {…} with no team    -> refused   (so there is no unlabelled lane)
alpha queries {kind:"task"}    -> its own team, with no hint there were others
beta  takes  {kind:"task"}     -> never alpha's
```

The refused UNLABELLED write is what makes it total. A body must carry the field its grant pattern
names and nothing server-side will add it, because a body is the client's claim.

## Three ways isolation ends, and `radia team` reports all of them

1. **An UNSCOPED member.** Grants on the team kinds with no pattern: it reads every team, and adding
   teams around it changes nothing until it is rotated. Shown as `TEAMS: ANY`, because a dash reads
   as "none", the opposite of what it means.
2. **A CROSSER.** Two `--team` values on one member, which is how work moves between teams.
3. **`observe`.** Unscoped by definition, so a member holding it reads every OTHER team.

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
right for CLAIMABLE work, where taking the record is what removes it from the next answer, and it is
what makes "is there anything for me?" and "tell me when there is" the same call.

On a FACT kind nothing consumes anything, so the read behind it returns the same record for ever. An
agent asked to watch for new messages was handed a two-minute-old broadcast, twice, and narrowing
the pattern did not help because the pattern was not the problem. `newOnly: true` takes a BASELINE
at call time and reports only something written after it; the reply says which you got (`existing`).
The baseline is compared by `created_at`, the database clock, never by id: a ULID carries the
WRITING process's clock, so two agents' records can order backwards.

The result also stopped telling a model to `space_take` a record of a `claimable: false` kind. That
advice reads as authoritative because it comes from the tool rather than a prompt, and it sends the
model after an operation the space will never satisfy.

## Two grant sets, and mixing them is a trap

`MEMBER_GRANTS` carry the team pattern; `DISCOVERY_GRANTS` must not. `kind_def: query` is what
`space_kinds` calls and is the FIRST thing an agent does: an agent discovers its vocabulary rather
than being taught it. Adding it to the scoped set fails exactly as omitting it did: a `kind_def`
body has no `team`, so the pattern matches nothing and refuses every declaration.

**The team pattern belongs on kinds that carry data, never on the ones that describe them.**

## The generated config names the binary that wrote it

Absolute, because `"command": "radia"` works only if the harness's PATH has it, which is the one
thing a generated config cannot check. A PATH scan is the mirror mistake and was rejected: it can
name a different build than the one writing the block, and a stale install speaks an older wire
contract while still starting cleanly. `--scope local` is spelled out in the `claude mcp add` line,
since the `user` scope writes one config for every project and collapses two members into one
principal.

## Read before

Adding a grant to the member set (is it data or discovery?), assuming `radia compartment` audits a
team, relying on `space_stats` for a total, reaching for the taint barrier to separate agents, or
proposing that the runtime stamp a body field.
