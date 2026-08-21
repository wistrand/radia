# A shared world

A MUD: rooms, players, and NPCs that are Radia workers rather than branches in a game loop. Phase 1
of [agent_docs/plan-mud.md](../../agent_docs/plan-mud.md) is built, which is the whole coordination
skeleton with no model anywhere.

```bash
deno task mud -- --player alice --player bob     # spawns a space if none is running
# then, in two more terminals, run the two commands it prints
```

`deno task test:mud` proves the whole thing headless. It needs no API key, and neither does
anything else here.

## What it shows that the other examples do not

Two players reaching for the same thing. `pipeline/` is fan-out, `analysis/` is content-keyed
staleness, `chat/` is an LLM agent; none of them has independent principals competing for a scarce
resource, which is what leases and fencing exist for. That contest is phase 3. Phase 1 builds the
world it happens in, and already shows the half that surprises people: **an NPC is a principal**.

The gatekeeper holds `event: put` pinned to `{roomId: "gate", actor: agent:mud-npc-gatekeeper}`. A
gatekeeper that tried to speak in the tavern, or to write a line attributed to a player, is refused
at the write by `bodyMatchesGrant`. No code in this example checks for either. Stopping an NPC is
`radia runs --for agent:mud-npc-gatekeeper --stop`, which is the same mechanism from the other end.

## Files

| File | Role |
|--------------|-----------------------------------------------------------------------|
| `kinds.ts`   | the record kinds, and the indexed paths the design rests on           |
| `world.ts`   | four rooms and two NPCs, as data, written into the space              |
| `roles.ts`   | the principals: what a narrator, an NPC and a player may each do      |
| `feed.ts`    | writing an event, and reading one room's stream                       |
| `narrator.ts`| claims what a player typed, decides what happened, writes it down     |
| `npc.ts`     | `agentLoop` plus a pure function; the behaviour a model replaces later |
| `play.ts`    | a terminal client: writes `command`, reads three kinds                |
| `run.ts`     | brings it all up                                                     |
| `smoke.ts`   | the proof: `deno task test:mud`                                      |

## An NPC has its own clock

Ambient behaviour is a chain of deferred cues, and it is what `PutRequest.availableAt` was added
for (agent_docs/plan-milestones.md, "delayed visibility"):

```
npc_turn{trigger: ambient, tick: N}   claimed when its availableAt passes
  -> event                            the beat, if this one is visible
  -> ack: npc_turn{tick: N+1}         availableAt = now + 30s
```

No process holds an interval. That is not tidiness: a phase-6 workspace NPC is a pure function of
the record it claimed and then exits, so an interval was never available to it, and this is.

The chain cannot break at the hop, because `ack` is consume-and-emit atomically: either the cue is
still claimable and gets redelivered, or it is consumed and its successor exists. It CAN die if a
cue dead-letters after its attempts, and the repair is `radia remediate requeue`, never restarting
the launcher. `seedAmbient` starts a chain only when the NPC has none, because two self-perpetuating
chains for one NPC is two clocks with nothing to notice or stop them.

`deno task mud -- --ambient-seconds 3` makes it visible while you watch.

## How a turn works

```
player types "north"
  -> command{worldId, actor}          claimed by the narrator under a fenced lease
     -> event{roomId: gate}           "alice goes north."
     -> presence{actor, roomId}       the authoritative move
     -> event{roomId: courtyard}      "alice arrives from the south."
     -> npc_turn{npc}                 one cue per NPC standing where it happened
        -> event                      the NPC's line, under the NPC's own principal
```

Every arrow is a record. `radia children <command id>` walks it, and the console's Graph tab draws
it without anything having declared the shape.

## Rules worth knowing before changing this

**Where somebody is standing comes from `presence`, never from the command.** A room named by a
client is a claim, and a stale tab would otherwise act in a room it has already left.

**An occupant list is a projection, not a query.** `presence` is append-only, so
`query {worldId, roomId}` returns everyone who was EVER in that room. Project latest-wins per actor
first (`readRegistry`), then filter. The smoke test asserts both halves, including that the naive
query still says otherwise.

**A feed is ordered and tailed by RECORD ID.** There is no `index` field, because an idempotency key
is scoped to the agent behind the caller: the slot-claiming trick that orders the chat's transcript
(`msg:<conv>:<i>`) does not work across principals, and a narrator and an NPC would both write index
N without either seeing a conflict. One runtime process mints monotonic ULIDs, so
`{dir: "asc", after: lastId}` is a total, gap-free cursor. Several instances over one database would
tie inside a millisecond; this example runs one.

**At-least-once needs two defences here, not one.** Every event is written under a key derived from
the claimed record, which dedupes an exact repeat. That is not enough for the narrator: a redelivery
re-reads `presence`, which the first attempt may already have moved, so the second attempt walks a
different branch and collides with the first under the same keys. The `causedBy` guard covers that.
The NPC needs no guard, because its handler is a pure function of the cue it claimed.

**Only a player-caused event cues an NPC.** An NPC's line is an event in the same room, so cueing on
any event at all would make two NPCs sharing a room answer each other forever. An ambient beat is
not a cue either, for the same reason: it comes from the NPC's own chain and provokes nobody.

## What is deliberately not enforced

**Fog of war.** A player's reads are scoped to the world, not the room, so a curious player can query
a room they are not standing in. A grant pattern is static and a player's room changes every move, so
`{roomId}` would have to be rewritten on every step. The enforceable alternative is per-recipient
event fan-out, at N records per room event; see `roles.ts` and the plan.

**A half-narrated turn.** A crash between two of the narrator's writes leaves the move done and the
arrival line missing, or the other way round. Radia offers no transaction across records and this
example does not pretend otherwise: the guard makes the redelivery safe, not the interruption
invisible.

## Next

Phase 2 is the page (plain DOM and JS, an SSO gate, the same tick this terminal client uses). Phase
3 is the contest. Phases 4 to 6 add the model, scene images, and NPCs whose behaviour is a promoted
workspace tree. The order is in [the plan](../../agent_docs/plan-mud.md), and phases 1 to 3 all run
without a provider.
