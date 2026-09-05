# Teams: several agent harnesses on one space (architecture)

> Status: BUILT 2026-08-26; members as WORKERS (`radia team up`, team directories, warm sessions,
> `done`) BUILT 2026-09-05 and run end to end with real harnesses. Source: [extensions/ts/team.ts](../extensions/ts/team.ts) (the
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
codex-alpha:  space_put  {kind:"capability", body:{tool:"compute", provider:"agent:codex-alpha",
                                                   def:{...}}}     -> what it can do, published once
claude-alpha: space_put  {kind:"task", body:{title:"sum the first 1000 primes", tags:["compute"]}}
codex-alpha:  space_take {kind:"task", match:{tags:{$any:"compute"}}} -> claimId, lease held for it
codex-alpha:  space_ack  {claimId, resultKind:"note", resultBody:{answer:3682913}}
claude-alpha: space_watch {kind:"note", newOnly:true}              -> the answer, parented on the task
```

**A name belongs on a fact, never in the routing position of a claimable record.** `note.to` is a
mailbox and is right: mail is addressed by whoever knows the recipient. `task.assignee` exists and
is a PREFERENCE only. Nothing enforces it (no grant reads it, so any member may claim a task
addressed to someone else), and a task addressed to a member who leaves is claimable forever,
because retention GC never sweeps unclaimed claimable work. `tags` is the routing field, and
`capability` is what a member matches them against: the writer states what the work needs, the
claimant states what it is, and `removeMember` withdraws the departing member's advertisements so
the routing goes with it.

**`workspace` is a team kind, so a member can author CODE rather than only bytes.** Four MCP tools
(`space_save_workspace`, `space_edit_workspace`, `space_read_workspace`, `space_list_workspaces`)
cover `extensions/ts/workspace.ts`, and they exist because a manifest carries a `treeDigest`, a
normative sha256 over sorted `path\0mode\0digest` lines that no prose lets a model compute. Two
consequences. The kind is redeclared with `team` for the same reason `artifact` is, and it is the
SAME DOOR: a tree is this team's code plus the artifact ids to fetch the rest, so an unscoped
`workspace` grant carries a compartment's payload out and `auditCompartment` reports it beside the
artifact case. And a tree could not be authored in a compartment at all until `WriteInput.meta`
existed: every file lands as an artifact, each one was refused for carrying no label, which is the
`capability` hole in a second place. The adapter LEARNS that label from a refusal (nested
`ScopeFiller.fill` over both kinds), never by pre-stamping, since pre-stamping narrows a tree
written under an unscoped grant. Nothing joins a content key, unlike `capability`, because
`workspace` declares none: dedup is a read-before-write plus a per-agent idempotency key.

**A workspace lookup is by NAME, so a member of two teams has to SAY which tree it means.**
`readWorkspace` matches on name, bounded by the caller's pattern-scoped grant: the whole answer for
a member of one team, and not for a member of several, whose read spans both. The head it lands on
then decides three things wrongly: a save supersedes the other team's tree, an identical one dedups
into it and writes NOTHING, and two same-named trees read as one FORKED workspace. FIXED 2026-08-29
by asking. `WorkspaceScope` narrows every lookup by name (`extensions/ts/workspace.ts`), and the four
workspace tools take a `scope` argument, REFUSING a call that names none with the choices named when
the caller's grants scope the kind several ways (`ScopeFiller.choose`, the read-side twin of the
write fill's `discover`). Only that case changed: with one scope or none the grant still bounds
the read alone, since a caller holding an unscoped grant beside a scoped one may legitimately read
past the pattern. It could not be INFERRED, which is what kept it open: a label is learned from a
refusal, and this read happens before any write.

**Work that cannot be done is ANSWERED, never nacked, and the answer says so.** `note.ok` is the
marker (optional, indexed, absent means the note is mail rather than an answer). Two reasons it is
not a nack. The state machine cannot express permanent failure: `nack` reaches dead-letter only
after `maxAttempts`, and a dead-lettered record emits NO result, so the member that asked learns
nothing and waits out its deadline. And the rule is already the tool layer's
(`extensions/ts/tool-worker.ts`: a failed call is an answer, whose envelope carries `ok`), so this
is that rule reaching the kind that shipped without it. Measured: a member answered impossible work
correctly in prose and the result was indistinguishable from four successes to anything but a
reader. The `space_ack` description carries the disposition, since that is what is being read at
the moment of the decision; the kind's usage carries the mechanism. Flow mining is deliberately not
taught about it: its `failed` means the RUNTIME gave up, and lineage cannot interpret an app's
semantics.

## What is core, what is the extension, what is the surface

This is the repo's admission rule (`extensions/README.md`) applied to one feature, and it is worth
reading as the worked example: almost nothing here is runtime.

| Tier | What teams put there | Why there |
|--------------------------|----------------------------------------------|--------------------------------|
| **Core** (`src/core`, `server`, `storage`) | the ops-plane PATTERN tier, and nothing else | authorization is enforcement; a convention cannot add a read tier |
| **Extension** (`extensions/ts/team.ts`) | `task`/`note`, the `artifact`, `capability` and `workspace` redeclarations, the grant sets, the roster projection | two apps would want the same shape; the runtime has no business knowing what a "task" is |
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
| Work is routed by CONTENT, not addressed | neither agent names the other: the claimant advertises what it does, the writer states what the work needs, and the `task` goes to whoever matches |
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

## Members as workers: `team.json` and `radia team up`

A harness on MCP acts only while a session is open, and nothing wakes one that is not running
(below). `radia team up` (2026-09-05) removes that limit without touching the protocol: each member
in a `team.json` becomes a WORKER, an `agentLoop` on the member's patterns holding a real watch
stream and a fenced lease, whose handler launches the harness once per claim, non-interactively,
with the claimed record in its prompt and the member's MCP config in its hands. An idle team costs
no tokens; a harness exists only while there is work. Source: `extensions/ts/harness-worker.ts` (the
loop and the spawn, a client like `host.ts`), `src/surfaces/teamfile.ts` (the file and the harness
command templates), the verb in `src/surfaces/cli.ts`.

```json
{
  "members": [
    { "name": "claude-alpha", "harness": "claude", "model": "opus",
      "patterns": [{ "kind": "task", "match": { "tags": { "$any": "javascript" } } }] },
    { "name": "codex-alpha", "harness": "codex", "model": "gpt-5.6-luna" }
  ]
}
```

```bash
radia team add claude-alpha codex-alpha --team alpha   # once: mints each member, stores its token here
radia team up                                          # runs both as workers until Ctrl-C
radia team up --once --member claude-alpha             # one claim, then stop
```

A team is one DIRECTORY (`examples/teams/<name>/`: `team.json`, `prompts/`, a README), and
`radia team up <dir> --init --seed` is the whole bootstrap: `--init` mints the members the file
names under its `team` label and stores their tokens, re-minting one whose stored token lacks a
grant the file names (held grants are read from `permissions`, so the file converges the space
rather than being skipped as "already minted"), `--seed` writes the file's starting records
with the label added, and a member's `promptFile` resolves beside the file. The two examples,
`twenty-questions` and `story-relay`, are games whose rules are the prompts: a member claims by a
tag of its own, hands the turn on by writing the next task with the other's tag, and parents it on
the previous one so the match is one thread.

Rules the design rests on:

- **A member may announce what it claims.** `DISCOVERY_GRANTS` carries `interest: put`, unscoped
  like `kind_def: query` and for the same reason (an interest names a kind and no team): the first
  lab run had the worker's loop refused on its announcement, and the scenario's readiness check
  waits for exactly that record. Members minted before 2026-09-05 need `radia team add <name>
  --rotate` to gain it.
- **Setup stays the privileged step.** `team add` mints and, since this shipped, also stores each
  member's durable half on the machine it ran on (`#member:` in the credentials file). `team up`
  reads that and mints nothing, so it holds only what the members hold. A file written elsewhere
  may carry `definitionToken` per member.
- **The claim is SHARED with the harness.** The loop claims under the member's named session run
  (`storedSession`, saved before every spawn), and the harness's adapter resumes the same session
  (`radia mcp --session <name>`), so the claim id in the prompt, `claim-<record>-<epoch>` in the
  adapter's own format, is one the harness may settle with its answer riding the ack, the way a
  member on MCP answers. `recoverClaim` gates on the run, which is why the run must be shared.
  The session lives in the credentials file, and a harness hands its MCP server only the env in
  its config, so that config carries `RADIA_CREDENTIALS` and `RADIA_DIR` as well as the token:
  the first lab run omitted them, the adapter minted a run of its own, and Codex's `space_ack`
  was refused as an unknown claim after it had done the work.
- **Every way a harness ends is one settlement.** Settled by the harness: the loop's own settle
  loses the lease on purpose and the log says so. Clean exit without settling: the loop acks with
  no result. Non-zero exit: nack. Past `timeoutSeconds` (default 600): killed and nacked. Lease lost
  mid-run: the child is killed, since a fenced worker stops at the fence, UNLESS the record is
  consumed, which under an owner-bound settle means the harness acked it and is still printing its
  summary (the heartbeat's next renewal reports that as lease_lost); the handler then returns
  `SETTLED` and the loop neither acks nor nacks.
  "Settled by the harness" is decided by the LEASE ID, not the epoch: a nack hands the record back
  under the same epoch, so only a changed or cleared lease id says the claim is no longer ours.
  A child that ignores SIGTERM gets SIGKILL five seconds later, and a warm session refuses
  `concurrency > 1`, since it is one harness session.
- **The FRAME carries the mechanics; a team's prompt is only its game.** `FRAME` (and
  `RESUME_FRAME` for a warm session) is wrapped around every prompt by `framePrompt`: who the
  harness is, the record, the claim id, and the three moves as exact calls (read with
  `space_lineage`/`space_children`, answer with `space_ack`, hand on with `space_put` parented on
  the record, give back with `space_nack`), plus the one-record rule. So a game's prompt says what
  to read, what its answer is and what to hand on, in the game's words, and
  `test/teamfile.test.ts` refuses a shipped prompt that names a tool or a claim id. `frame: false`
  hands a prompt over as written, for a team that states the mechanics itself.
- **The command templates are somebody else's release.** `BUILTIN_HARNESSES` carries the
  invocations the agent lab has run real harnesses with (Claude Code's `-p --mcp-config
  --strict-mcp-config --allowedTools mcp__radia`, Codex's `exec -` with the adapter configured on
  its command line); a file may override them under `harnesses`, or a member may bring `command`.
  `{{model}}` drops its flag when no model is set, `{{prompt}}` in argv means the prompt travels
  there, otherwise it goes in on stdin, which both harnesses read.
- **Warm sessions are the worker's, not the harness's.** `resume: true` keeps one harness session
  per member across claims (the analysis's method B): the worker mints a UUID before the first
  launch (`claude --session-id`, later `--resume`) or learns it from Codex's `thread.started` and
  passes it to `codex exec resume <id> -`, stores it in `~/.radia/team/<member>.harness-session`,
  and DROPS it after a failed run; a fence (a Ctrl-C, a stop) or a timeout keeps it, being the
  loop's doing rather than the session's. `resumePrompt` is what a session that already
  holds the earlier moves is told, which is where the speed comes from: a resumed move reads one
  child note instead of the whole lineage. Templates: `BUILTIN_HARNESSES["<harness>-first"]` and
  `"<harness>-resume"`, `harnessTemplates` choosing. Contract: the two warm-session cases in
  `extensions/conformance/harness-worker.test.ts`.
- **A team may carry SERVICES, its own kinds and per-member grants.** A member with
  `service: true` is a process spawned once with its token in the environment and supervised
  (restarted after a growing pause if it exits while the run lives, killed when the run ends),
  never looped over claims: what a model-free worker is, the lab's exec worker advertising
  `run_javascript` being the case in hand. `kinds` are `kind_def` bodies `--init` declares before
  any member is minted, since a member holds no `kind_def: put`, MERGED over whatever the space
  already declares under that name (`declareKind`): a raw registration of the go-fish team's
  `tool_call` on a dev space where the chat had declared it with more paths was refused as an
  incompatible redeclaration, rightly, since it would have stopped the chat's live grants
  compiling, and a merge only adds paths; a member's `grants` are extra
  team-scoped grants and `unscopedGrants` the reference-kind ones (`sandbox`, `interest`), the
  lab's two shapes. `--once` ends the run when every LOOP member has handled a claim, which is
  what stops the services too. Spawning goes through the platform seam (`spawnProcess`).
- **`go-fish` is the STRESS TEST, not the introduction, and its dealer is a WORKSPACE AGENT.** It
  puts workspace agents, the broker, a team-declared kind under pattern-scoped grants, two
  harnesses, a service beside five per-claim launches and the repair of model-written code under
  load at once, which is why it reads as it does; `twenty-questions` is the team to read first, and
  the example's README opens by saying so. Four
  players, every one a model, and a dealer that is a program one model (`author`) wrote into a
  workspace: `dealer-host.ts` beside the team file, run as the `dealer` service member, claims
  `task{tags: dealer}` under the dealer's own run, materialises the newest version of that
  workspace into the jail, and runs it through the broker (architecture-workspace-agents.md,
  minus the two operator writes: the binding lives in the host's memory and follows the author's
  newest version, so a fix is live on the next move, and there is no promotion pin). The program
  reads the table (a `table` kind only the dealer holds), writes hands as private notes, books as
  public ones, the next turn as a task, and returns the reply; the host stamps the team on all of
  it. A move is one jail spawn (about 200ms) instead of a model turn (40s, $0.2): 21 moves in
  4.8s in `examples/teams/go-fish/smoke.ts`, which plays the game model-free against the
  reference program in `smoke/`. When the program throws, the host hands the error to the author
  as a `fix` task and nacks the move, so the model is in the loop for the code and never for a
  move. Hands stay private by prompt only, and a READ LEAVES NO EVENT; the table is now closed
  to players by grant, which a first version left open as a workspace every member could read.
- **Leftovers are named, and `--fresh` retires them.** Unclaimed claimable work is never swept,
  so every earlier run's open tasks are claimed beside the next seed: three games once ran
  interleaved, one guesser asking one question of three keepers. `team up` counts the team's open
  tasks at start and names them; `--fresh` dead-letters them before seeding.
- **A run with an end ends itself.** The file's `done` (or `--done <json>`) is a pattern the
  verb watches with the CLI's own credential, the team label added: a matching record written
  after the start is printed as the answer and the verb exits 0, after up to 60s for a harness in
  flight to finish. The games end on a `note` with `topic: "final"`, an indexed path, which the
  last move's prompt asks for; a pattern cannot read prose, so the ending must be a field.
- **Each harness runs in a directory of its own OUTSIDE every project**, `~/.radia/team/<member>/`
  beside the credentials file: Claude Code applies a project's `disabledMcpServers` by name to a
  `--mcp-config` server for any cwd inside the project, and this repo's entry disables `radia`
  (gotchas.md). Its output is
  digested to one line per event (`digestLine`), `--verbose` for the stream.
- **Cost is bounded by the lease, the timeout and `concurrency`** (default 1 per member), never
  by the model. Contract: `extensions/conformance/harness-worker.test.ts`, every outcome driven
  with a harness that has no model.
- **The first real run is a lab scenario**, `scripts/agent-lab/scenarios/team-up.json`: a Claude
  Code session asks for a program, and the Codex member is a worker that launches `codex exec` only
  when the task is claimed. The scenario writes the worker's `team.json` through the runner's new
  `files` field, and its `trace` names the lab's trace file so the launched harness is observed
  like any other. Unrun as of 2026-09-05; findings belong in research-agent-sessions.md.

## What it is NOT for

**Nothing external wakes a harness that is not running, unless a worker runs it.** A task can sit
in the space indefinitely; the runtime fires at no deadline, by decision (`availableAt` defers
claimability, there is no sweeper, and an idle space runs nothing). Somebody has to start the agent,
and `radia team up` (above) is that somebody: a worker on `agentLoop` that starts the harness per
claim.

**Once one IS running, it can watch without being poked each time.** A harness that can spawn a
subagent (Claude Code's is one) can hand it a loop of `space_watch {newOnly: true}` calls and let it
react to what arrives; each call blocks up to 120 seconds, so the loop is what spans a working
session. That is the practical shape for "tell me when the other agent answers", and it costs one
instruction rather than a code change. It is bounded by the SESSION, not by the space: the watcher
dies with the harness, and it is polling, so it spends tokens while it waits.

For work that must be picked up with no session alive at all, the answer is a worker on `agentLoop`
(the SDK's event-driven loop, which holds a real watch stream), not a harness on MCP; `radia team
up` is that worker with a harness as its handler.

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
than implying parity. agy (the third harness `radia team add` knows, `src/surfaces/mcp/config.ts`)
takes the same `mcpServers` shape at a FIXED path with no flag to move it, so two agy members on
one machine need `HOME` moved.

**`observe` still crosses teams**, which is why it is opt-in. A member holding it reads every other
team off the ops plane while its own coordination query correctly answers empty.

**It is now the DECLARED state, not a create-time flag** (`reconcileObserve`, `extensions/ts/team.ts`).
Re-declaring a member without `--observe` takes the power back, which is what the roster already
advertised and did not do: rotation revokes the DEFINITION, while an `ops_grant` is keyed to the
PRINCIPAL and rotation does not change that, so the advice looped forever. Both writes are
conditional on a read of what is in force and ANCHORED on the record they supersede
(`:after:<id>`), which is what keeps the two traps closed: an unconditional re-put would outrank an
operator's `retired: true` tombstone (`ops_grant` never compacts), and a constant retire key would
make the second withdrawal an idempotent replay of the first, leaving the power live. A grant
carrying `observe` alongside another power is REFUSED rather than narrowed.

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

Teams are ISOLATED BY DEFAULT, and the isolation is the grant pattern rather than a convention: a
write carrying another team's label OR NO LABEL is refused by `bodyMatchesGrant`, so there is no
unlabelled lane.

| kind | claimable | separated by |
|------------|-----------|-------------------------------|
| `task` | yes | `pattern: {team: …}` on the grant |
| `note` | no | same |
| `artifact` | no | same, via a redeclaration adding `team` |
| `capability` | no | same; `team` joins its `contentKey` too, or one member advertising one tool in two teams is one registry entry and compaction keeps only the newer |

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

## Four ways isolation ends: `radia team` reports three, `radia team up` the fourth

1. **An UNSCOPED member.** Grants on the team kinds with no pattern: it reads every team, and adding
   teams around it changes nothing until it is rotated. Shown as `TEAMS: ANY`, because a dash reads
   as "none", the opposite of what it means.
2. **A CROSSER.** Two `--team` values on one member, which is how work moves between teams.
3. **`observe`.** Unscoped by definition, so a member holding it reads every OTHER team.
4. **A FOREIGN CLAIMANT on a shared kind.** A claimable record cannot say who may claim it, so
   another app's worker holding an UNSCOPED take on a kind the team also uses can win the race.
   The chat fleet's exec worker took the go-fish dealer's `tool_call` on a shared dev space
   (2026-09-05); its `tool_result` carried no `team`, so the scoped dealer watched three minutes
   for an answer that existed, and the log showed an ordinary take. The reply now lands WHERE THE
   CALL WAS: `toolResult` (`extensions/ts/tool-worker.ts`) copies `team` from the call as it does
   `conversationId` and `owner`, `ToolContext.team` hands it to the tool, and the exec tool labels
   the artifact an oversized output becomes with it (`artifactMeta`), so any `serveTools` worker
   serves any team, whatever the output's size. What stays is a
   claimant that does not echo (a generic `task` worker: the task is simply gone), which
   `radia team up` names from the live interests `dryRun` lists, and only where a listener's match
   can overlap a claim of this team's (the chat's image worker listens on `tool_call` for its own
   tool name and is not named): kinds the loop members claim are checked before launch against
   their patterns, kinds a service claims two seconds after, against the members' live interests.
   A listener scoped to another team cannot claim and is not reported.

`radia compartment` is NOT this audit and reads as though it is: it answers a kind-compartment
question, so it calls every member a crosser for reading `task` and writing `artifact`.

**Declaring the kinds EXTENDS `artifact`, never restates it** (`mergeKind`). A redeclaration
replaces, and three apps extend that reserved kind: the chat adds `conversationId`/`owner`/
`workspace`, the analysis pipeline adds `owner`, this adds `team`. The runtime guards only its own
paths, so it cannot tell one app's addition from another's. Declared flat, `radia team add` on a
space running the chat left `artifact` on `[digest, mediaType, team]`, after which every chat query
and every new chat grant naming `conversationId` was refused as an undeclared path: another app's
authorization scoping, broken by a verb that never mentions it. The declaration now unions with
what is already there, keeping paths this build does not know.

**`team add` is a compare-and-set, not a read-then-write.** Two of them racing on one name both saw
one active definition, both revoked it and both created, leaving the agent TWO live tokens minting
where `revokeDefinition` reaches only the newest: the hazard the CLI's own refusal exists to
prevent, reachable around it. `createAgentDefinition` now takes an optional `supersedes` (the id of
the record the caller read as newest, or null), which keys the write to the state it was decided on,
so the loser gets `definition_conflict` instead of a second credential. OPT-IN, because re-creating
a definition for a live agent is legitimate: the chat fleet mints its workers' on every start
(plan-startup-ergonomics item 8), and a blanket refusal would break that rather than fix anything.

**The roster reports a REVOKED principal's ops powers** rather than filtering them out. `radia
revoke` stops minting and nothing else, deliberately, so an `ops_grant` outlives it, keyed to the
PRINCIPAL. Nothing can use it while the name cannot authenticate; filtering it from every warning
made it invisible to the one verb an operator reads to believe a power is gone.

**One `permissions` read per definition is the DESIGN, and what is bounded is wall clock**
(`ROSTER_CONCURRENCY`). The roster's value is that it reports enforcement rather than what a setup
command once assigned; folding the raw `grant` registry here instead would be a second
implementation of `authorize`'s pattern and operation logic, which is the bug class the verb exists
to catch. So the reads run 8 at a time rather than serially, and the space does the same work.

**Removal is a cascade, and the definition is the smallest part of it** (`removeMember`). Revoke
first so nothing new mints, then retire the grants, then the ops powers, then stop the runs.
Grants are retired rather than left: a revoked definition cannot authenticate, but `mintDelegatedRun`
resolves its caller from a RECORD's author and intersects with that principal's LIVE grants without
consulting whether the definition still mints, so a worker holding one of their leftover records
could still act on their behalf. Two principals are swept, not one: authority usable only through a
delegated run lives under `delegable:<agent>`. And EVERY ops power goes, not just the `observe` this
verb grants. Both were unreachable while the definition stayed revoked, which is not the failure:
re-adding the name RESTORED them, granted by nobody. Both RUN CLASSES are stopped: `agent_run{agent: X}` is their own
sessions and `agent_run{actingFor: X}` is a run a worker holds for them, and the count for each is
printed even at zero, since a silent zero reads as "there were none to check".

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
