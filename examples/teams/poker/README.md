# poker (team)

Four harness players at a fixed-limit hold'em table, with a dealer service holding the deck. The
rules and the hand evaluator are [`examples/poker/`](../../poker/); this directory is the team
wiring and the prompts.

```bash
radia dev --db &
radia team up examples/teams/poker --init --fresh
```

```bash
deno task test:poker-team    # the same wiring with scripted seats, no model and no API key
```

## Two ordering rules this team had to learn

**The kinds are in `team.json`, and they must be.** `--init` declares a team's kinds before it
mints any member, and a member's grant pattern does not compile until the path it narrows on is a
declared indexed path. Leave them out and minting fails with `invalid_grant: path 'team' is not a
declared indexed path of kind 'poker_board'`, which nothing later in the run can repair, because a
member holds no `kind_def: put`. They are a copy of `KINDS` in
[`examples/poker/poker.ts`](../../poker/poker.ts); [`provision.ts`](provision.ts) reads them back
out of the file, so the smoke runs against whichever copy `--init` would declare.

**Declaring a kind twice needs `declareKind`, not `registerKind`.** `--init` canonicalises path
order before writing; a plain `registerKind` afterwards writes the same key with a different byte
order and gets `idempotency_conflict`. `declarePokerKinds` uses the same helper `--init` does, so
running it before or after makes no difference.

**A service's `{{token}}` is the DURABLE half.** `radia team up` hands a service member its
definition token, which cannot coordinate: passing it as `token` is an immediate `invalid_token: a
definition token does not authorize coordination; mint a run first`. `dealer.ts` passes it as
`definitionToken` and the SDK mints and re-mints, which is also what lets the dealer outlive the
15-minute run token and the 12-hour ceiling.

**A member needs a READ grant on the kind it claims, not just `take`.** `radia team up` builds the
adapter's claim id from the claimed record's ENVELOPE, which is an ops-plane read. A pattern-scoped
grant opens that plane, but only one carrying a read verb. With `take` alone the envelope read is
refused, the worker fails soft, and the harness is launched with an EMPTY claim id: the model then
cannot settle the turn it was started for, burns a launch and the turn comes straight back. Hence
`take,query,read_one` on `poker_action_request`.

**A narrow write beside a wide read used to be refused as ambiguous.** The MCP adapter fills the
fields a caller's grant requires by retrying a refused write (`scope.fill`), and it learned them
from the kind's `patterns`, which is the union over every grant whatever verb it permits. A player
holds `poker_action: put` scoped to itself beside `poker_action: query` scoped to the team, so the
union said two scopes and the adapter refused to guess. It now asks per operation, where exactly
one grant carries `put`. Pinned by `test/team.test.ts`.

**The players turn the frame OFF.** The default frame tells a harness to answer with
`space_ack {resultKind: "note"}` and that "nothing else in the space needs discovering", which is
right for a team whose moves are tagged tasks and wrong here: an action is a `poker_action`, and
the one thing a player must look up (its hole cards) is not reachable by lineage from the turn it
claimed. Like `song-creator/`, each player prompt carries its own three calls, including the exact
`space_ack`. What it does NOT carry is the player's own name or the team label: `scope.fill` puts
both in from the grant, so the prompt cannot get them wrong and the model cannot forge them.

## A real run

Three hands, four harnesses (two Claude Code, two Codex), seven minutes, 2026-09-20:

```
42 runs: 42 settled, 0 failed, 0 timeout, 0 fenced
standings: ada 527, ben 484, cy 494, dee 495
```

2000 chips in, 2000 out. Nothing fenced: the dealer finished and was not restarted, and the one
harness still mid-turn when `done` landed was left to settle rather than killed (two seconds, not
the sixty-second grace period).

The play was real poker, not moves that merely parsed. The last hand: a pocket pair called a
preflop raise for set value, checked an overcard flop, picked up a flush draw on the turn and
called, rivered trips and bet them, and was called in two places. Elsewhere top pair with an ace
kicker bet into two checks and was called down; a pair of eights folded the turn to a third
barrel. No player saw another's cards at any point, and every action record carries the author the
space resolved, not one the model typed.

Cost grows with a warm session, because `resume: true` keeps the table in context: one player's
turns ran $0.069, $0.107, $0.151, $0.220, $0.302, $0.382, $0.470, $0.563, $0.663, $0.778, and a
Codex player's last turn sent 712k input tokens. Roughly two dollars for three hands, most of it
context rather than reasoning. That is the trade the flag makes, and it is worth knowing before
raising `--hands`.

## How long a run takes, and how to stop it

The dealer deals `--hands` hands (3 in `team.json`) and then writes the `done` record, at which
point `radia team up` prints it and exits. Nothing else ends the run: there is no hand limit in the
space and no clock.

A turn is one harness launch, measured at 8 to 30 seconds against Claude Code and Codex, and a
four-handed hand takes eight to twelve turns. So three hands is roughly 5 to 15 minutes and a few
dollars. Raise it with `--hands` in the dealer's command; the cost is linear.

A timeout fold is WRITTEN, parented on the request it answers and marked `by: "timeout"`, so a
seat that was asked and never answered reads differently from one that was never asked. Without
it the betting history simply skipped a seat. The request itself still stays `available`.

Ctrl-C stops `radia team up` at any point. The hand in flight is abandoned, its `action_request`
stays `available`, and the next run starts a new session rather than resuming that hand.

## Do not run this team and `examples/poker/` on one space

The scripted example assigns its own grants (`playerGrants`), which carry no team label: an
unpatterned `poker_action: query` and a `poker_action: put` scoped to `{player}` alone. Both union
with the team's, which widens the reads and leaves the write with TWO candidate scopes. The
adapter then refuses to guess which one a write belongs to, and every player spends an extra model
turn discovering that. Use a separate space for each, or a fresh one.

## The cast

`dealer` is a `service: true` member: spawned once and supervised, never looped over claims,
because it is the one participant that is not answering a turn. It deals, writes each street, asks
one player at a time and settles the pot, all through the public API. `ada`, `ben`, `cy` and `dee`
are harness members (two Claude Code, two Codex) whose loop claims `poker_action_request` matching
their own name.

A hand is one launch per betting decision, so a four-handed hand costs six to twelve launches. The
dealer's action timeout is four minutes by default for that reason, against four seconds in the
scripted smoke.

## Isolation WITHIN a team

A team compartment separates one team from another: every grant `addMember` assigns is scoped to
`{team: <label>}`. That is the right default and it is not what poker needs, because ada and ben
are on the same team and must not see each other's cards.

`team.json` says so directly. A grant written as an object narrows further, and `"self"` becomes
the member's own principal, so one line serves all four players:

```json
{"kind": "poker_hole", "operations": ["query", "read_one"], "pattern": {"owner": "self"}}
```

| grant | resulting pattern |
|------------------------------|--------------------------------|
| `poker_hole: query,read_one` | `{team, owner: agent:<name>}` |
| `poker_action_request: take,query,read_one` | `{team, player: agent:<name>}` |
| `poker_action: put` | `{team, player: agent:<name>}` |

The team label is applied first and `pattern` may not name it: an extra grant must never be the
one hole that reads across teams. The public reads (`poker_board`, `poker_action`,
`poker_hand_result`) stay in the string form, where team-scoped is the right scope.

This form did not exist until this example needed it. Before 2026-09-20 those three grants had to
be assigned by a separate operator script after `--init`, and the window in between was a member
holding no take grant and idling. [`provision.ts`](provision.ts) is what remains: it reads
`team.json` and calls the same `declareKind` and `addMember` the verb calls, so the smoke mints
exactly what a real run mints.

`radia permissions` used to
print the union of a kind's operations beside the union of its patterns, so ada's two
`poker_action` grants rendered as one line promising a bounded put and an unbounded one at once.
`EffectivePermissions.byOperation` now carries the constraint per verb, computed by the rule
`authorize` uses, and the view prints one line per constraint:

```
poker_action         put   scoped to [{"team":"poker","player":"agent:ada"}]
                     query,read_one   scoped to [{"team":"poker"}]
```

`test/teamfile.test.ts` parses this team along with the others, so the file cannot rot silently.
The gap itself is worth a decision: a per-member pattern in `team.json` would remove the second
command, at the cost of a grant syntax that is no longer one string.

## What a player never has to remember

The MCP adapter fills in whatever the caller's own grant requires, after the runtime refuses a
write for scope (`scope.fill`, `src/surfaces/mcp/`). So a harness player writes its action without
a `team` label and without naming itself, and gets both filled from its grant. It cannot fill them
with anybody else's values, because they come from the grant rather than from the model.

A scripted client has no such retry. `runPlayer` in [`examples/poker/poker.ts`](../../poker/poker.ts)
copies the label off the request it claimed, and the first version of this example wrote 0 actions
until it did: every ack was refused by the player's own grant, which is the mechanism working.

## What the smoke asserts

`smoke.ts` provisions exactly what the two commands above provision, then plays three hands with
scripted seats:

- a member of the **same team** still cannot read a teammate's hand
- an unfiltered query returns only its own
- ada cannot read her own cards at a table she is not seated at, so the team half of the pattern is
  load-bearing too
- she cannot fold a teammate (`403`)
- she cannot write a record with **no** team label at all (`403`)
- every action written carries the label, and the dealer's `done` record ends the run

## Prompts

`prompts/player.md` carries a disposition and nothing about the space: what fixed-limit betting
allows, that the amount is `toCall + betSize` and no other number, and that a hand is something to
look up rather than recall. Which kind holds the cards is in that kind's `usage` string, which is
where a model discovers it. `prompts/player-resume.md` is the shorter one for a resumed session,
which already has the earlier hands in context.
