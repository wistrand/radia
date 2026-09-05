# teams

Each directory here is a TEAM: agent harnesses (Claude Code, Codex) working together through a
space, run as workers by `radia team up`, with everything the team is in one folder:

| file | what |
|------|------|
| `team.json` | the members (name, harness, model, what each claims, extra `grants`), the team label, `kinds` the team declares, the seed records that start the work, and `done`, the pattern a final answer matches; a `service` member is a process spawned once rather than a harness per claim |
| `prompts/*.md` | the RULES of the game, and nothing else: the launcher wraps every prompt in a frame that says who the harness is, which record it holds, and the exact calls to read, answer and hand on; a `-resume` variant for a session that already holds the earlier moves |
| `README.md` | the game and how to run it |

Bootstrap and run is two commands, from the repo root, with a space up (`radia dev --db`):

```bash
radia team up examples/teams/<name> --init --seed    # first time: mint the members, seed, run
radia team up examples/teams/<name> --seed --fresh   # a new game: retire the last one's open tasks, seed again
radia team up examples/teams/<name>                  # later: run
```

`--init` mints each member that has no token on this machine and stores it, and re-mints one
whose stored token lacks a grant the file names, so editing a member's grants is a matter of
running it again (setup, the one
privileged step); `--seed` writes the file's starting records under the team's label; `--fresh`
dead-letters the team's open tasks from earlier runs first, since unclaimed work is never swept and
would be claimed beside the new seed (a run without it says how many it found). All three are
idempotent enough to leave on. The workers run until the file's `done` pattern matches a record
written after the start (the verb prints that record as the answer and exits 0), or until Ctrl-C,
and cost nothing while idle: a harness is launched only when a record is claimed for it. Every team
here ends on a `note` with `topic: "final"`, which the last move's prompt asks for.

A team shares its space with whatever else runs there: a claimable record cannot say who may claim
it, so an app's worker holding an unscoped take on a kind the team uses (the chat fleet's exec
worker on `tool_call`) claims the team's records too. A tool worker's reply carries the call's
`team` label, so that case answers inside the team; a claimant that answers without the label (or
consumes a `task`) leaves the team waiting, and `team up` names every such listener at start. A
space of its own is
`RADIA_DIR=~/.radia/<name> radia dev --db --port 7790 &` plus `--url http://127.0.0.1:7790` on
every `team up`.

Start with `twenty-questions/`. `go-fish/` is a STRESS TEST that happens to be a game, and reads
like one.

| team | what it shows |
|------|---------------|
| `twenty-questions/` | the introduction: two players, every move a task for the other, routed by `tags`, the match one lineage |
| `story-relay/` | a fixed number of rounds with one shared prompt: the baton names who writes next |
| `go-fish/` | six members exercising workspace agents, the broker, a team-declared kind under pattern-scoped grants, two harnesses, a service beside five per-claim launches, and repair of model-written code as ordinary coordination. Not a first example; its README opens with what it puts under load |

Every team runs WARM SESSIONS (`"resume": true`): one harness session per member across moves,
so a later move starts with the game in context and reads only the other side's newest answer
(the `-resume` prompt), instead of the whole lineage each time. The worker owns the session id
(`claude --session-id` then `--resume`; Codex's `exec resume <thread>`), keeps it in
`~/.radia/team/<member>.harness-session`, and drops it after a failed run so a poisoned session
does not follow the member (a Ctrl-C or a timeout keeps it). Set `resume` to false for a fresh process per move.

To make your own, copy a directory, change the prompts and the seed. A prompt is written in the
game's own words: what to read, what your ANSWER is (the body of the note that settles your claim)
and what to HAND ON (the next task: its title, `tags` naming who is next, any fields the game
counts by). The frame turns those into tool calls, parents every task on the one before so the
exchange reads as one thread, and stops the harness claiming anything else. `"frame": false` on a
member drops the frame for a prompt that wants to state the mechanics itself (`{{recordId}}`,
`{{body}}`, `{{claimId}}` are filled in either way). A harness is a new process per move and remembers nothing between
them: the space is its memory, and its own directory (`~/.radia/team/<member>/`) holds what the
other side must not see. The runtime learns nothing about any game; the prompts are the rules.
Design and limits: [agent_docs/architecture-teams.md](../../agent_docs/architecture-teams.md),
"Members as workers".
