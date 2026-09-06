# market

Five scripted bidders compete for jobs none of them was assigned. There is no orchestrator, no
routing table and no model: a buyer puts work out to bid, whoever wants it bids, and the buyer
picks by a policy the space knows nothing about.

```bash
radia dev --db &
deno run -A examples/market/market.ts --rounds 8      # watch one market
deno task test:market                                  # the same thing, asserted, on its own space
```

**What a round looks like.** The buyer opens an auction, the bidders that want the job price it,
the window closes, and the buyer awards:

```
round 3  size 7  offers [cheap 28, bulk 24, greedy 27, picky 25, burst 21]  ->  burst at 21
round 5  size 7  offers [cheap 28, bulk 24, greedy 27, picky 25]           ->  bulk at 24
round 7  size 3  offers [cheap 12, bulk 16, greedy 15]                     ->  cheap at 12
```

**The strategies cross over, which is the whole design of this example.** `cheap` is linear and
beats `bulk` below size five; `bulk` carries a setup cost and wins above it; they tie exactly at
five. `greedy` prices by what it already holds, so it leads early and fades. `picky` declines small
work and `burst` stops bidding after two jobs. No strategy dominates, so which one leads depends on
the sequence of jobs and on what has already been won. A first draft had one bidder undercut every
other by a fixed amount, which made every run identical, and the smoke's "a different seed is a
different market" check is what caught it.

**What the space provides, and what it does not.** The convention is
`extensions/ts/marketplace.ts` and the reasoning is
[design-marketplace.md](../../agent_docs/design-marketplace.md). Three built primitives carry it,
and the runtime is asked for nothing:

| the protocol needs | what it actually is |
|---|---|
| a bidding window | `availableAt` on the request: readable throughout, claimable only at the close |
| one winner, decided once | `take` on the request, which is the exclusive right to award it |
| the award, atomically | the `ack`, which consumes the request and emits the assigned task together |

The award is not a record. It is the assigned task, parented to the request and to the bid that
won it, carrying `assignee` and `request`, so "who won, and on what terms" reads back from records
with nothing stored twice. **The runtime ranks nothing**: `cheapestFairest` in `market.ts` is the
buyer's policy and lives entirely in the example, which is why a bid's body is opaque to the space.

**Reading a finished market.**

```bash
radia query task --url http://127.0.0.1:7788      # every award, with its assignee
radia query bid --url http://127.0.0.1:7788       # every offer, winners and losers alike
radia lineage <task-id> --url http://127.0.0.1:7788   # the request and the bid it was awarded on
```

Losing bids are kept, which is what lets a failed winner be re-awarded from the same auction
instead of running a new one (`reawardFailed`). The smoke checks that: no bid is ever consumed.

**Cost.** Nothing. No model calls, no API key, and a run of eight auctions takes about five
seconds, most of it waiting for bidding windows to close.
