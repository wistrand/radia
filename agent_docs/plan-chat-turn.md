# Plan: the chat turn as a chain of records

BUILT (designed 2026-08-09, revised the same day after a recheck reversed one decision; every step
shipped the same day). Removing the tool-call loop from the chat client, by letting the space route a conversation instead of
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
- What the worker reacts to, today
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
| cancel        | Escape cannot stop work already claimed   | BUILT: a `cancel` record read before each emission |
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
call, structurally. BUILT for inference (step 2a, `smoke-turnlink.ts`).

Building 2a corrected the plan on one point: `llm_result` does NOT die, and `tool_result` will not
either. Both call kinds have a DUAL USE the fold missed: an `llm_call` is usually a conversation
link, but the router's classifier is an `llm_call` with `messages` inline and no conversation, and
its answer must never enter a transcript. Same for `tool_call`: the smoke harness and procedures
drive bare calls with no turn slot. So the rule is: **a call that names its conversation slot acks
the transcript entry; an inline call is an RPC and acks a result record.** The distinguisher is
structural (`conversationId` present or not), not a flag.

**Keyed links: the aggregator pattern.** The two missing links (user message → `llm_call`;
assistant/tool message → next `tool_call` or next round) trigger on FACTS, and facts are not
claimed. The turn worker is aggregator-shaped: it WATCHES messages and emits the next work record
with a content-derived idempotency key (`turn:<triggerMessageId>`), exactly as the aggregator emits
`summary:<jobId>`. This is why Package U had to land first: run-scoped keys deduped nothing across
a restart, since the retry arrives under a fresh `run:*`. Keys now scope to the agent behind the
run, so the emission is exactly-once across restarts AND across two REPLs, whose turn workers share
one identity.

**Every link parents to the record that CAUSED it, never to the conversation.** The conversation is
a hub: parented to it, each round is a stub hanging off one node, so a turn has no subtree to open
and `getGraph` from any member returns every turn in the thread. Measured before the fix at 83 of
185 records naming the conversation directly. Now the seed `llm_call` parents to the user message,
a `tool_call` to the assistant message that asked for it, the next round to the tool reply that
completed the last, and `turn_complete` to the message that ended it. So `graph?direction=down` on
a turn's seed is exactly that turn. Guard: `smoke-turnlink.ts`, "a turn's every record is reachable
from its seed" (planted red: 6-8 of every turn's records unreachable).

## What the worker reacts to, today

NOT A CONTRACT, and worth saying because the table below looks like one. Nothing enforces it, no
conformance suite covers it, and it was edited three times in the day it was written as the code
moved under it. It is a sketch of how `extensions/ts/turn.ts` currently behaves, kept because a
reader needs somewhere to start.

The AUTHORITY on what a turn actually was is the MINED flow: `radia flows`, or the Graph tab on a
conversation. That is not a technicality. This runtime's claim is that a shape emerges from
content-routed reactions and is discovered afterwards
([design-inspection.md](design-inspection.md)), so a state machine written down in prose is the
thing that claim rejects, and it goes stale the moment a reaction changes.

| trigger (watched fact or claimed work)          | emits / acks (one record)                  | via    |
|--------------------------------------------------|--------------------------------------------|--------|
| `message{role:"user"}`                            | `llm_call{upToIndex, round:0}` (untiered)  | CLIENT |
| `llm_call` untiered                               | `llm_call{tier}` (exists: the router)      | fence  |
| `llm_call{tier}`                                  | `message{role:"assistant", tool_calls?}`   | fence  |
| `message{role:"assistant"}` with `tool_calls`     | `tool_call{i:0, of:n, assistantId}`        | key    |
| `tool_call`                                       | `message{role:"tool", i, of, assistantId}` | fence  |
| `message{role:"tool"}`, `i+1 < of`                | `tool_call{i+1}`                           | key    |
| `message{role:"tool"}`, `i+1 === of`, round < cap | `llm_call{round+1}` (untiered)             | key    |
| `message{role:"assistant"}` no `tool_calls`, or round cap | `turn_complete` (a fact)           | key    |

The first row is the CLIENT's, not the worker's: see build step 3. Each record carries what the
next step needs (`i`, `of`, `assistantId`, `round`, `upToIndex`), so
no step recomputes from a scan. The client becomes: put the user message, watch, render until
`turn_complete`.

ADDRESSING IS BY IDENTITY, ordering is by index, and conflating the two was a mistake worth naming.
A reply is found by the provider call id it answers (`{conversationId, tool_call_id}`); a round's
assistant message by `{conversationId, turnAt, round, role}`. `index` still orders the transcript and
bounds the context window, but nobody PREDICTS one in order to read a record. That prediction was a
hand-rolled allocator shared by three writers, and its failure mode was not "not found" but "found
the WRONG record": when a round's position field went missing, the client read assistant messages out
of the slots it was waiting on and rendered the model's prose as a tool's output. The constraint that
made addressing awkward in the first place is real and worth remembering: a scoped client cannot
fetch by id at all, because `getRecord`, `lineage` and `children` are ops-plane, so anything used as
an address has to be an indexed BODY field.

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

What was chosen and why: design history, not a specification of behaviour. Where a row names a
field the CODE is the authority — `afterIndex` sat in the cancel row here for a day after the
implementation had settled on `turnAt`, which is the drift any doc restating an implementation gets.

| question                          | decided                                       | why                                                     |
|-----------------------------------|-----------------------------------------------|----------------------------------------------------------|
| The shape                         | a chain: fenced links + keyed links           | both halves have shipped precedent (router; aggregator)  |
| Is `message` claimable?           | NO — reversed on recheck                      | starvation noise, uncovered roles, and migration replays history |
| Where transcript entries come from | the ack's RESULT is the message               | one fenced write; a reclaimed worker's message is never written |
| `llm_result` / `tool_result`      | conversation answers fold into `message`; the kinds survive for INLINE calls | both call kinds have a dual use (the classifier, bare tool RPCs); an answer with no transcript slot needs a non-transcript shape |
| The two missing links             | watch + emit with content-derived keys        | the aggregator pattern; claiming facts was rejected above |
| Prerequisite                      | Package U (agent-scoped keys)                 | run-scoped keys make keyed emission unable to survive a restart |
| The cursor                        | derived from the trigger record               | no counter, no lease                                     |
| Parallel tool calls               | NO, stay sequential                           | a chain needs no join; parallel needs a join and a counter |
| Cancel                            | `cancel{conversationId, turnAt}` read at the same gate as the deadline | both ask "is anyone still waiting"; keyed to the TURN, or it silences every later one |
| Concurrent chains                 | client refuses to send while a turn is live   | current behaviour; the one job the loop did that nothing else does |

## Costs

- DEPENDED ON PACKAGE U, now closed: keys are agent-scoped, so a turn-worker restart inside a
  turn replays its emission instead of double-paying a model call. The contract case is in
  `conformance/exchange.test.ts` ("survives a re-mint").
- The turn's shape is no longer readable in one file. The honest replacement is the MINED one
  (`radia flows`, or the Graph tab on a conversation), not a state table copied into a README:
  a table is a second source of truth that nothing checks, and this plan's own went stale within a
  day. Point a reader at the tooling that reads the real thing.
- `assembleContext` and the renderer must read assistant/tool content from `message` records that
  arrived as ack results; resume and the bricked-conversation repair need re-verification against
  the folded kind.
- Escalation and the router are untouched, and that is a claim to TEST, not assume: both already
  ack `llm_call`s, and the only change around them is who consumes the final assistant message.

## Build order

1. ~~Package U~~ DONE 2026-08-09 (`Space.idem`, `src/core/space.ts`).
2. a. ~~Inference worker acks `message{role:"assistant"}`~~ DONE 2026-08-09: `finished()` in
      `workers/inference.ts` picks the shape by `conversationId`; the client observes the index
      (`Thread.noteExternal`) instead of appending; `message` gained a `callId` index and the
      session grant gained `read_one` (awaiting by call is a readOne, and `chat-test` cannot see a
      scoped-live 403). Suite: `smoke-turnlink.ts`, the only one that runs the REAL inference
      worker (fake OpenRouter via `RADIA_CHAT_API_BASE`); proved to fail against the pre-plan ack.
   b. ~~Exec/tools/images workers ack `message{role:"tool"}`~~ DONE 2026-08-09, and it landed
      ALONE after all: the client supplies the slot itself (`tool_call_id` + `replyIndex` on the
      `tool_call`), so step 3 shrinks to just the two keyed links. One wrapper (`workers/reply.ts`,
      `asTurnReply`) at each worker's `handle` rather than a branch at exec's ten result sites,
      because the shape is the CALL's property, not the result's. The client parses the reply's
      `content` back for rendering, so the record carries the payload ONCE where before it was
      written twice (tool_result + the client's copy). Found and fixed on the way: `pairToolCalls`
      dropped ORPHAN replies but not DUPLICATES, which 2b makes reachable (a synthetic
      timeout/cancel reply plus the worker's late real ack at the same slot); FIRST reply per id
      now wins, so the transcript the model already acted on does not change under it
      (`smoke-context.ts` pins both halves). Suite: `smoke-turnlink.ts` tool cases, proved to fail
      against the pre-2b shape. The reply must carry `i`/`of`/`round` FORWARD from the call: dropping
      them is silent (a round of eight calls becomes eight rounds, and the client reads assistant
      messages out of the reply slots it is waiting on), and only a multi-call round shows it.
3. ~~The turn worker~~ DONE 2026-08-09 (`workers/turn.ts`, `agent:chat-turn`). Watches `message`,
   reacts to four facts, writes every emission under `turn:<triggerId>`. NOT yet in `fleet.ts`: the
   REPL still drives, and two drivers would double every call, so wiring it in is step 4's atomic
   flip. Proved headless in `smoke-turnlink.ts`: seed a conversation, walk away, and
   user → assistant(tool_calls) → tool → assistant → `turn_complete` runs with no client.
   Corrections the build forced:
   - THE CLIENT SEEDS, and link 1 of the table is not the worker's. The first `llm_call` carries
     the session's tool list, which is session state (a scoped view plus conversation-scoped
     procedures), so no worker can invent it. Later rounds copy it from the conversation's newest
     `llm_call`, one bounded read of an indexed path.
   - `getRecord` IS OPS-PLANE, so a scoped worker cannot follow an id. Everything the next reaction
     needs is carried on the record (`i`, `of`, `round`, `replyIndex`) or reachable by an indexed
     match; the one lookup left derives the assistant message's index arithmetically from slots
     `dispatch` itself assigned.
   - A wakeup carries only an id, so the worker SWEEPS the newest messages and skips a `seen` set,
     which is the aggregator's shape exactly. `seen` is a cache; the key is the correctness.
   - RECONCILIATION NEEDS TWO BOUNDS, both found on a real space and neither by the suite. The boot
     sweep walked history and dispatched 47 stale tool calls into two dead threads, so the live turn
     timed out behind them. Acting only on a conversation's HEAD is necessary and insufficient: an
     abandoned multi-call turn's head legitimately means "dispatch the next call", so it resumed a
     corpse one reply at a time. The second bound is the turn's own `deadlineAt`, stamped by the
     CLIENT on the seed (it is the one waiting) and compared against the DB clock: an age cutoff was
     tried first and rejected, since a clock cannot separate an abandoned turn from a slow one and a
     `request_grant` legitimately waits five minutes on a person. A call with no deadline is never
     resumed, which is every record written before this existed. Being keyed makes an emission
     idempotent, not appropriate.
   - The round-2 call is emitted UNTIERED, so the ROUTER is part of the chain. Missed at first, and
     the turn stalled with an unclaimed call: a later round is judged on the work done so far.
4. ~~The client reduced to seed, follow, render~~ DONE 2026-08-09, and the turn worker is in
   `fleet.ts`. `runTurn` writes ONE record per turn (the seed `llm_call`, which carries the tool
   list) and then only waits and prints: `showToolReply` renders a call the worker dispatched,
   `nextCall` waits for the round the worker emits. What remains in the client is a RENDER loop,
   which decides nothing; the control flow is gone. `MAX_ROUNDS` went with it (the worker holds the
   bound now), and so did the synthetic reply the client appended on timeout or cancel: the real
   reply arrives whether anyone is watching. Two seams moved: the progress waiter matches on
   `{conversationId}` because the client no longer knows the tool call's id, and a tool reply is
   awaited BY SLOT for the same reason.
   Found by a live session, not by the suite: the flip needs `llm_call: query` on the SESSION, which
   the client never needed while it wrote every call itself. The suite missed it because its client
   case ran as the operator, who bypasses grants; it now mints a scoped session, and planting the
   grant back reproduces the live failure.
5. Cancel that actually cancels: a `cancel` record the worker reads before each emission. Today
   Escape stops this process rendering and the chain runs on, which is the inversion accepted above.
6. ~~Delete the loop and the round counter~~ done as part of 4.

## Rejected: rules as records

Making the routing table itself records (`rule{match, emit}`) with a generic engine. The `match`
half is legitimate (patterns are data), but `emit` would be a template, and that slides toward the
`$where` the query language exists to forbid. Three rules do not need an engine.
