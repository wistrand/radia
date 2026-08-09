# Plan: the chat turn as a chain of records

DESIGNED, not built (2026-08-09, revised same day after a recheck reversed one decision). Removing
the tool-call loop from the chat client, by letting the substrate route a conversation instead of
re-encoding the loop somewhere else.

Read this before changing `examples/chat/client/turn.ts` or `thread.ts`, before adding a state
record to sequence anything, and before making `message` claimable.

PREREQUISITE: Package U in [plan-audit-remediation.md](plan-audit-remediation.md), CLOSED
2026-08-09: idempotency keys now scope to the agent behind a run. The reason it mattered is in
"The two missing links". Nothing blocks the build.

## Contents
- The problem
- Rejected: a turn state token
- Rejected: claimable messages
- The design, and its two halves
- The rules
- Verified against the code
- Decisions
- Costs
- Build order
- Rejected: rules as records

## The problem

`turn.ts` runs the conversation in a `for` loop: put an `llm_call`, await it, append the assistant
message, then per requested tool put a `tool_call`, await it, append a tool message, repeat until
the model asks for nothing or a round cap trips.

It is the only part of the example that does not follow the model the rest of it teaches. By the
time a reader reaches this file they have accepted six workers claiming records by pattern; the
inconsistency sits in the one file where a reader looks for "how does control flow work here".

Six shipped properties have no demo, for the same reason:

| property      | today                                     | under this design                          |
|---------------|-------------------------------------------|--------------------------------------------|
| durability    | kill the REPL mid-turn, the turn is lost  | the chain continues, `--conversation last` shows it |
| resumability  | an interrupted turn is abandoned          | the next emission is keyed off the last fact |
| multi-client  | two REPLs collide on `index`              | both watch; keys and fences dedupe          |
| cancel        | Escape cannot stop work already claimed   | a `cancel` record read before each emission |
| flow mining   | the flagship flow is invisible to `radia flows` | the turn is the flagship mined shape  |
| the waterfall | rounds are not records                    | "why was this turn slow" is a picture      |

## Rejected: a turn state token

The first design: a claimable `turn{phase, pending, nextIndex}` record, every transition claiming
it and acking a successor. Kept here because it looks correct, uses only existing mechanisms, and
is wrong. A state token is a PROGRAM COUNTER: the loop taken out of the process and stored in the
space, which then needs machinery to make a stored program counter safe. `phase` was the tell:
every value was a fact derivable from records that already exist, so the field cached a predicate
and the lease existed to protect the cache.

Never introduce a record whose job is to remember where a computation had got to. Claimability does
not cure it.

## Rejected: claimable messages

The second design: make `message` claimable and drive every step by claiming the newest one. One
mechanism, fully fenced, and the recheck killed it three ways:

- It reverses a decision this codebase wrote down. Reference kinds are `claimable:false`
  specifically so they do not trip the starvation diagnostic (`examples/chat/space/kinds.ts:15`,
  `src/core/inspection.ts:58`), and the pipeline aggregator states the idiom: results are
  knowledge, not work (`examples/pipeline/aggregator.ts:1`).
- Uncovered roles alarm forever. `role:"system"` messages match no rule, and a claimable record
  nobody claims is exactly what `staleAvailable` flags. Every conversation would leave permanent
  orphans in `radia doctor`.
- MIGRATION REPLAYS HISTORY. Claimability is per KIND, so flipping it makes every message already
  in the space available work: a fresh turn worker would claim months of old user messages and
  fire an `llm_call` for each dead conversation.

The transcript stays what it is today: facts, `claimable:false`, unchanged.

## The design, and its two halves

A conversation is ALREADY a chain of records; the loop is nobody performing two of its links. The
chain has two different shapes of link, and the codebase already ships a worked example of each:

**Fenced links: work already claimable.** An ack's result kind is free (an ack IS a put,
`src/core/space.ts:1744`), and the router ALREADY acks new work as its result: it claims an
untiered `llm_call` and acks a tiered one (`examples/chat/workers/router.ts:147`). Escalation is
the same move (`workers/inference.ts:190` acks a higher-tier `llm_call`). So the workers change
only in WHAT they ack: the inference worker acks the assistant `message` itself, the exec worker
acks the tool `message`. The transcript entry stops being written beside the result and becomes the
result, fenced: a reclaimed worker's message is never written, so exactly one assistant message per
call, structurally. `llm_result` and `tool_result` dissolve into `message`.

**Keyed links: the aggregator pattern.** The two missing links (user message → `llm_call`;
assistant/tool message → next `tool_call` or next round) trigger on FACTS, and facts are not
claimed. The turn worker is aggregator-shaped: it WATCHES messages and emits the next work record
with a content-derived idempotency key (`turn:<triggerMessageId>`), exactly as the aggregator emits
`summary:<jobId>`. This is why Package U had to land first: run-scoped keys deduped nothing across
a restart, since the retry arrives under a fresh `run:*`. Keys now scope to the agent behind the
run, so the emission is exactly-once across restarts AND across two REPLs, whose turn workers share
one identity.

## The rules

| trigger (watched fact or claimed work)          | emits / acks (one record)                  | via    |
|--------------------------------------------------|--------------------------------------------|--------|
| `message{role:"user"}`                            | `llm_call{upToIndex, round:0}` (untiered)  | key    |
| `llm_call` untiered                               | `llm_call{tier}` (exists: the router)      | fence  |
| `llm_call{tier}`                                  | `message{role:"assistant", tool_calls?}`   | fence  |
| `message{role:"assistant"}` with `tool_calls`     | `tool_call{i:0, of:n, assistantId}`        | key    |
| `tool_call`                                       | `message{role:"tool", i, of, assistantId}` | fence  |
| `message{role:"tool"}`, `i+1 < of`                | `tool_call{i+1}`                           | key    |
| `message{role:"tool"}`, `i+1 === of`, round < cap | `llm_call{round+1}` (untiered)             | key    |
| `message{role:"assistant"}` no `tool_calls`, or round cap | `turn_complete` (a fact)           | key    |

Each record carries what the next step needs (`i`, `of`, `assistantId`, `round`, `upToIndex`), so
no step recomputes from a scan. The client becomes: put the user message, watch, render until
`turn_complete`.

Indices need no counter and no lease: each writer derives its index from the record it reacted to
(assistant = `upToIndex + 1`, tool `i` = `upToIndex + 2 + i`). The only read-then-write left is the
client picking the user message's index, and two REPLs colliding there is two people typing at
once, not corruption.

`round` rides on `llm_call`, so a crashed REPL cannot leave an unbounded chain running.
`turn_complete` is `claimable:false`; it exists so the client has a terminus to watch and the mined
flow a visible end. Termination purely by absence was rejected: with claimable triggers it leaves a
permanent starvation alarm, and without them it leaves the client watching for silence.

## Verified against the code

Checked 2026-08-09, second pass:

| claim                                                               | where                                   |
|----------------------------------------------------------------------|-----------------------------------------|
| an ack's result kind is free, authorized as an ordinary put           | `src/core/space.ts:1744`                |
| an ack result gets the claimed record prepended to `parentIds`, extra parents allowed | `src/core/space.ts` settle: `parentIds = [lease.recordId, …]` |
| ack-result-as-next-work already ships: the router acks a tiered `llm_call` | `examples/chat/workers/router.ts:147` |
| escalation acks a higher-tier `llm_call` the same way                 | `examples/chat/workers/inference.ts:190` |
| `staleAvailable` excludes only `claimable:false` KINDS, so any uncovered claimable record alarms | `src/core/inspection.ts:58` |
| results-are-knowledge idiom, and the keyed-emit precedent             | `examples/pipeline/aggregator.ts:1`     |
| idempotency keys are run-scoped today (the prerequisite)              | `src/storage/adapter.ts:285`, `src/core/space.ts:2863`, `src/server/http.ts:198` |
| the runtime already resolves `run:*` to its agent (the U fix's seam)  | `src/core/space.ts:497`, `src/core/flows.ts:140` |
| tool calls are sequential today, so no join is needed                 | `examples/chat/client/turn.ts:114`      |
| streaming flows through records and does not move                     | `examples/chat/space/kinds.ts:98`       |

## Decisions

| question                          | decided                                       | why                                                     |
|-----------------------------------|-----------------------------------------------|----------------------------------------------------------|
| The shape                         | a chain: fenced links + keyed links           | both halves have shipped precedent (router; aggregator)  |
| Is `message` claimable?           | NO — reversed on recheck                      | starvation noise, uncovered roles, and migration replays history |
| Where transcript entries come from | the ack's RESULT is the message               | one fenced write; a reclaimed worker's message is never written |
| `llm_result` / `tool_result`      | folded into `message`                         | one transcript kind, one query                           |
| The two missing links             | watch + emit with content-derived keys        | the aggregator pattern; claiming facts was rejected above |
| Prerequisite                      | Package U (agent-scoped keys)                 | run-scoped keys make keyed emission unable to survive a restart |
| The cursor                        | derived from the trigger record               | no counter, no lease                                     |
| Parallel tool calls               | NO, stay sequential                           | a chain needs no join; parallel needs a join and a counter |
| Cancel                            | `cancel{conversationId, afterIndex}` read before each keyed emission | the turn worker is already a reader |
| Concurrent chains                 | client refuses to send while a turn is live   | current behaviour; the one job the loop did that nothing else does |

## Costs

- DEPENDED ON PACKAGE U, now closed: keys are agent-scoped, so a turn-worker restart inside a
  turn replays its emission instead of double-paying a model call. The contract case is in
  `conformance/exchange.test.ts` ("survives a re-mint").
- The turn's shape lives in a table and the Flows tab, not one readable file. The state table
  belongs in [examples/chat/README.md](../examples/chat/README.md) beside the existing diagram.
- `assembleContext` and the renderer must read assistant/tool content from `message` records that
  arrived as ack results; resume and the bricked-conversation repair need re-verification against
  the folded kind.
- Escalation and the router are untouched, and that is a claim to TEST, not assume: both already
  ack `llm_call`s, and the only change around them is who consumes the final assistant message.

## Build order

1. ~~Package U~~ DONE 2026-08-09 (`Space.idem`, `src/core/space.ts`).
2. Inference worker acks `message{role:"assistant"}`; exec worker acks `message{role:"tool"}`.
   Delete `llm_result`/`tool_result`; `assembleContext` reads one kind.
3. The turn worker: watch messages, emit keyed work per the table. One process, one identity.
4. The client reduced to put, watch, render until `turn_complete`.
5. Cancel.
6. Delete the loop and the round counter.

## Rejected: rules as records

Making the routing table itself records (`rule{match, emit}`) with a generic engine. The `match`
half is legitimate (patterns are data), but `emit` would be a template, and that slides toward the
`$where` the query language exists to forbid. Three rules do not need an engine.
