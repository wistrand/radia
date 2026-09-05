# go-fish

**A stress test, not an introduction.** Four models play Go Fish and a fifth writes the dealer as a
program, which is a game simple enough to check by eye and a run that exercises more of Radia at
once than anything else in this repo. Read `twenty-questions/` first if you want to see what a team
is; that one is two players, one kind and forty lines of prompt.

What this run puts under load, all of it at the same time:

| property | how this exercises it |
|---|---|
| workspace agents | the dealer is not a process but a workspace a model wrote, materialised into a jail per claim and run as the dealer's own identity |
| the broker | that program reaches the space only through `put`, `query` and `read_one` frames, with lineage and the team label forced host-side |
| team compartments | the team declares its own `table` kind, and a pattern-scoped grant is what stops four of the six members reading it |
| content routing | no orchestrator: a turn is a task tagged with a player, an ask is a task tagged `dealer`, an answer is a record parented on the ask |
| leases and the attempt ceiling | every move is claim, run, ack, and a move nobody can perform reaches `dead_letter` on its own |
| two harnesses on one protocol | two Claude Code players and two Codex, sharing nothing but records |
| service and harness members | one `team.json` runs a long-lived process and five per-claim launches |
| repair as coordination | a program that throws, and one that merely refuses forever, both become a `fix` task for the model that wrote it |

```bash
radia dev --db &
radia team up examples/teams/go-fish --init --seed --fresh
```

**The cast.** `author` is a model with one job: on the opening task it writes `dealer.js` into a
workspace named `go-fish-dealer` and hands the deal on. `dealer` is a service, `dealer-host.ts`
in this directory: it claims every task tagged `dealer` under the dealer's own identity, runs the
newest version of the author's program in the jail with the broker as its only way to the space,
and acks whatever the program returns. The four players (`ada`, `ben`, `cy`, `dee`; two Claude
Code, two Codex) each get a turn as a task, read their hand from the newest note addressed to
them, and hand an ask to the dealer. Books are public notes; the game ends on a `note` with
`topic: "final"`.

**What runs where.** A move is one jail spawn, about 200ms, not a model turn: the program applies
the rules, writes the next `table` record, the changed hands, any book, and the next turn task,
then returns the reply. The `table` kind is declared by this team; the dealer writes it and the
author reads it, since a model repairing the program has to see what the program sees. No PLAYER
holds a grant on it, so none can read the pile or another hand through the table. The host copies
the team label onto every record the program writes and returns; the code never sets it and
cannot.

**When the program is wrong,** which is the half worth watching. If it throws, the host writes a
`fix` task for the author carrying the error, nacks the move, and runs the new version on the
retry. A move retried past the space's attempt ceiling before the fix lands sits in `dead_letter`;
`radia requeue <id>` puts it back. A program that never throws and simply REFUSES forever is the
expensive case, since each refusal hands the turn back and costs another player launch, so the host
counts identical asks answered `ok: false`, asks for a fix at the third, and HOLDS that move until
a new version is saved rather than answering it. The game pauses for the repair instead of paying a
player to ask again. Every rule in `prompts/author.md` about refusals and turn order is there
because a run died without it.

**What the space makes honest.** Every table state is a `table` record with the dealer as author,
every move a task with its reply parented on it, every version of the program a workspace version
with the author as author, so the whole game and the code that ran it read back from records. The
dealer cannot quietly change the rules either: the program is in the tree, and a fix is a version.

**What it does not, stated plainly.** Hands travel as notes any member could query, and a read
leaves NO event (the log records what agents did, never what they looked at), so a player that
peeks at another's hand note is invisible to the space; the prompt is the only thing against it.
A `hand` kind under per-player pattern-scoped grants is the next step if that matters.

**Testing without a model.** `deno task test:teams` runs `smoke.ts`: a space, `team up` with the
dealer service alone, the reference program in `smoke/dealer.js` saved the way the author saves
it, and this process playing all four players. Two games back to back (the second is where reading
"the current table" goes wrong), a malformed ask that must still move the turn on, and a program
that refuses forever. It asserts one reply per ask, hands addressed to one player only, one table
version per move, the team stamp on everything the program wrote, and that a player holds no grant
on the table.

**Cost.** A real run is on the order of thirty moves, each one player launch (10 to 45s) plus a
jail spawn: about $3.50 of Claude turns for a six-rank game, plus the Codex halves. The author runs
once, and again only when its program needs repair. Set `ranks` in the seed for a longer game.
