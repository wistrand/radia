# poker

Fixed-limit Texas hold'em for four players, where the hidden information is enforced by grants
rather than by asking the players not to look.

```bash
deno task test:poker                                  # a throwaway space, no model, no API key
deno run -A examples/poker/smoke.ts --url http://127.0.0.1:7788   # against a space already up
```

`--url` needs an operator credential for that host, which `radia dev` writes, or `RADIA_TOKEN`.
Three things make a run against a shared space safe to repeat. The kinds are prefixed `poker_`,
because a kind declaration is a record and a redeclaration is a successor, so declaring a bare
`action` would silently change the routing contract of whatever already owned that name. Every
record carries a `session`, which is an indexed path, so the assertions count this run and not the
last one. And every idempotency key is folded with that session, since the window is 7 days and a
rerun would otherwise dedupe against the previous one and write nothing.

What it does leave behind: the `agent:dealer` and four player definitions (a rerun supersedes
them), the records of every hand, and the abandoned `action_request`s from the timeout section,
which no sweep collects. Two runs against one space left 251 records `available`.

## Why this example exists

[`examples/teams/go-fish/`](../teams/go-fish/) is the other card game here, and it names the gap
this one closes:

> Hands travel as notes any member could query, and a read leaves NO event, so a player that peeks
> at another's hand note is invisible to the space; the prompt is the only thing against it. A
> `hand` kind under per-player pattern-scoped grants is the next step if that matters.

In Go Fish peeking is rude. With a pot it decides the game, so here the hand is a `hole` kind and
every player's grant on it is scoped to `{owner: self}`. The kind names carry a `poker_` prefix
so the example can be pointed at a space that already runs something else.

## The three properties

| | mechanism | what a misbehaving player gets |
|---|---|---|
| read | `poker_hole: query` scoped to `{owner: self}` | a query naming another player returns nothing; `grant AND request` is computed server-side |
| write | `poker_action: put` scoped to `{player: self}` | `403 forbidden` on an attempt to fold somebody else |
| order | `poker_action_request: take` scoped to `{player: self}` | `null`, by pattern and by record id both |

`smoke.ts` runs each of those as a real request before a card is dealt, because a claim about
isolation that is never attempted is a claim about nothing.

Turn order deserves a note. The dealer writes one `action_request` whose body names the player to
act; only that player's take grant matches it. There is no lock, no orchestrator and no turn
counter. A player acting out of turn is not detected and reversed, it is unclaimable.

## The kinds

| kind | claimable | who can read it |
|-------------------------|-----------|----------------------------------|
| `poker_hole` | no | its owner, and the dealer |
| `poker_action_request` | yes | the one player it names |
| `poker_board` | no | everyone |
| `poker_action` | no | everyone, which is what makes the betting auditable |
| `poker_hand_result` | no | everyone |

`owner` and `player` are declared indexed paths, because a grant may only narrow on a declared
path. The isolation IS the indexing contract, which is why this example declares its own kinds
instead of reusing a generic `note`.

## What the space does not give you

**The dealer sees every hole card.** Grants hide players from each other, not from the process
dealing. A player cannot read another's cards; the dealer can read all of them, and so can an
operator. Sealing each hand under a per-player key, the shape
[plan-encryption.md](../../agent_docs/plan-encryption.md) uses for chat prose, would narrow this to
"the dealer sees what is revealed at showdown". Trustless poker needs mental-poker crypto, which is
a protocol and not a Radia feature.

**The shuffle is not verifiable.** It is a seeded PRNG in the dealer's memory, so a run repeats
from its seed and nothing more. Committing to the shuffled deck as an artifact digest before the
deal and revealing the bytes afterwards would prove the dealer did not reshuffle mid-hand. It would
still not prove the shuffle was random.

**An abandoned turn is litter, and the smoke asserts it.** Nothing in the space expires an
unclaimed record: there is no timer, and retention GC never sweeps unclaimed claimable work. When a
player never acts, the dealer folds the seat on its own clock and the `action_request` stays
`available` forever. `radia dead-letter <id>` is the operator's cleanup. The last section of the
smoke plays a hand with the players stopped and then checks that those requests are still
claimable, rather than leaving the reader to assume something collected them.

**A fold is never revealed.** That one is not a grant either. The dealer writes only the cards of
players who reached showdown, so the space holds no record of what a folder was holding. The
property comes from not writing the record, which is the only way to get it.

## Not implemented

Side pots (a short stack is capped at its stack and the pot is not split), blind rotation between
hands, and all-in protection. The betting is fixed limit with one bet and at most three raises per
street. None of these interact with the authorization story; they are missing because they are
poker, not because they are hard here.

## Turning it into a team

The players are scripted strategies in `poker.ts` so the suite runs with no model. Replacing them
with harness members is a `team.json` and four prompts, the shape
[`examples/teams/go-fish/`](../teams/go-fish/) uses. The grants do not change, which is the point:
a model player is refused exactly what a scripted one is refused.
