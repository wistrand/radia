# Plan: a MUD-like graphical adventure as an example

**Status: PHASE 1 BUILT 2026-08-21** (`examples/mud/`, `deno task mud`, `deno task test:mud`): the
kinds, a four-room scripted world, the narrator, two NPC workers that act on a player's words AND on
their own deferred clock, a terminal client, and a smoke test that runs with no API key. Building it corrected three things in the design below, each marked
BUILT-CORRECTION where it appears. Phases 2 to 6 remain planned; analysis 2026-08-21, claims
verified against source the same day.

A shared world with several players and NPCs, rendered in a browser with plain DOM and JS, built on
`examples/melkrox` (an LLM text adventure in the melker repo) as the content model and on
`examples/analysis/` as the web-app shape. NPCs are Radia workers holding their own principals.

Nothing in the repo demonstrates CONTENTION between independent principals over a scarce thing,
which is what leases and fencing exist for. `pipeline` shows fan-out, `analysis` shows
content-keyed staleness, `chat` shows an LLM agent. Two players reaching for one sword is the
most legible demo of the remaining primitive, and it is the reason to build this rather than a
fourth variation on the first three.

## What changes when melkrox moves onto a space

melkrox is single-player and single-process: the world is one JSON blob in a cache, the model call
is an inline `fetch`, and NPCs are prose the model reinvents each turn. The parts that do not
survive are the parts worth losing.

| melkrox                         | on Radia                                                        |
|---------------------------------|-----------------------------------------------------------------|
| `GameState` blob in cache       | records; the indexed paths are the whole design                 |
| `facts` dict (long-term memory) | `fact` kind with `contentKey: [worldId, key]`, compacted by `gc` |
| inline `callOpenRouter`         | `llm_call` claimed by the inference fleet (`extensions/ts/inference.ts`) |
| image data URL in cache         | artifact bytes; the record carries `{digest, mediaType}`        |
| NPCs as prose                   | NPCs as principals with grants, run tokens and workers          |
| single player                   | multi-player by construction: the world IS the shared space     |
| no conflict model               | `take` under a fenced lease decides who gets the sword          |

## Kinds and indexed paths

The design is entirely in what is declared. Prose stays unindexed, which is also what would let
[plan-encryption.md](plan-encryption.md)'s convention apply later without re-deciding anything.

| kind          | claimable | indexed                             | contentKey            | role                                      |
|---------------|-----------|-------------------------------------|-----------------------|-------------------------------------------|
| `world`       | no        | `worldId`                           | `[worldId]`           | title, setting, style, image constraints  |
| `room`        | no        | `worldId`, `roomId`                 | `[worldId, roomId]`   | description, exits, scene prompt          |
| `presence`    | no        | `worldId`, `actor`, `roomId`        | `[worldId, actor]`    | where an actor is; latest wins            |
| `fact`        | no        | `worldId`, `key`                    | `[worldId, key]`      | melkrox's `facts`, one record per key (phase 4) |
| `command`     | yes       | `worldId`, `actor`                  |                       | a player's freeform input                 |
| `event`       | no        | `worldId`, `roomId`, `actor`, `verb`, `audience`, `causedBy` | | what happened; the room's feed |
| `npc`         | no        | `worldId`, `npc`, `roomId`          | `[worldId, npc]`      | an NPC's definition and disposition       |
| `npc_turn`    | yes       | `worldId`, `npc`, `roomId`, `trigger`, `tick` |             | an NPC's cue to act, from a player or its own clock |
| `contest`     | yes       | `worldId`, `roomId`, `target`       |                       | a scarce thing; `take` decides who gets it |
| `scene_image` | no        | `worldId`, `roomId`, `promptDigest` |                       | the memo that stops regenerating a picture |

**`scene_image` is the analysis memo, reused.** The room description hashes to a `promptDigest`; a
query for `scene_image{roomId, promptDigest}` either finds the artifact or does not, so an
unchanged room costs nothing and an edited one re-renders with no invalidation pass. It is a
QUERY, never an idempotency key: content-keyed idempotency expires with
`idempotencyRetentionSeconds` (7 days), and a memo that quietly stops memoizing is worse than none
(`examples/analysis/README.md`, "Operational constraints").

**BUILT-CORRECTION: there is no `event.index`, and a feed is ordered by RECORD ID.** The plan said
to claim each slot the way `Thread.append` does (`evt:<roomId>:<index>`,
`examples/chat/client/thread.ts`). That does not work here: an idempotency key is scoped to the
AGENT behind the caller (audit package U), so the narrator and an NPC would both write index N and
neither would see a conflict. The chat gets away with it because one session writes its own
transcript. Ordering is `{dir: "asc", after: lastId}` instead, which is a total, gap-free cursor
because one runtime process mints monotonic ULIDs (`src/core/ids.ts`); the honest limit is several
instances over one database, where ids tie inside a millisecond.

**BUILT-CORRECTION: `event` carries `causedBy`, and `command` carries no `roomId`.** A key derived
from the claimed record dedupes an exact repeat, and it is not enough for the narrator: a redelivery
re-reads `presence`, which the first attempt may already have moved, so the second attempt walks a
different branch and collides with the first under the same keys. `causedBy` (indexed) makes "have I
already narrated this command" a coordination-plane query; `parent_ids` holds the same fact and is
reachable only through lineage, which is the ops plane and no worker holds it. `command.roomId` is
gone for the opposite reason: a room named by a client is a claim, and `presence` is the authority.

**BUILT-CORRECTION: an NPC's `event: put` pin names the ACTOR as well as the room.** The room stops
it speaking where it is not standing; the actor stops it writing a line attributed to a player. Both
are refused by `bodyMatchesGrant`, and the smoke test plants all three writes.

**Every registry kind declares a `contentKey`.** A per-move `presence` successor is an append-only
log; `gc` compaction keeps newest-per-key and sweeps the surplus (`src/core/gc.ts`). Without the
key they accumulate forever.

## NPCs as workers

Three tiers, and the plan builds all three because they are the ladder the repo already documents.

1. **Scripted.** `agentLoop` with `patterns: [{kind: "npc_turn", match: {npc: "gatekeeper"}}]`, a
   pure handler, no model. The `examples/pipeline/worker.ts` shape verbatim, and what makes the
   smoke test runnable with NO API KEY, the discipline `deno task test:chat` already holds.
2. **LLM-backed.** Same loop; the handler puts an `llm_call` and reads the result rather than
   calling a provider. The NPC holds no API key and picks no model: tier selection is a router
   worker's decision, which is the "discover, don't hardcode" rule in CLAUDE.md.
3. **Workspace agent.** The NPC's behaviour is a workspace tree, promoted, pinned, and run by the
   generic host (`extensions/ts/host.ts`) under the NPC's own run token, brokered so jailed code
   gets `(record, space)` and no credential
   ([architecture-workspace-agents.md](architecture-workspace-agents.md)). The model writes an NPC
   during play and it runs as a named principal whose code digest is pinned by grant. Misbehaviour
   is `radia runs --for agent:npc-gatekeeper --stop`; a bad version is `radia rollback`.

The grant story is the demo. An NPC scoped
`{kind: "event", operations: ["put"], pattern: {roomId: "tavern"}}` is refused by
`bodyMatchesGrant` at the write when it tries to speak in another room. That is enforcement, not a
check the game performs.

**Ambient NPC behaviour got runtime support on 2026-08-21, and this plan is why it was looked at.
BUILT in phase 1** (`AMBIENT` in `examples/mud/npc.ts`, `seedAmbient` in `world.ts`): an NPC acks
each ambient cue with the next one, deferred by `PutRequest.availableAt`, so a wandering guard is a
chain of records and no process holds an interval. That is what makes it reach a phase-6 workspace
NPC, which is a pure function of the record it claimed and then exits.

Three things the build settled. The hop is safe because `ack` is consume-and-emit ATOMICALLY, so
the chain cannot end up with a cue consumed and no successor. The chain still dies if a cue
DEAD-LETTERS, and the repair is `radia remediate requeue` rather than restarting anything, because
a launcher that re-seeded would leave one NPC with two self-perpetuating clocks. And seeding asks
whether a cue EXISTS rather than relying on a content key, since idempotency expires at 7 days and
a re-run past that would start the second clock by itself.

Still true: nothing FIRES at the instant, so somebody must be polling that kind, which every
`agentLoop` already is. Never invent a timer kind for it.

## The browser client

`examples/analysis/ui.html` is the template, not `examples/chat/web/`: that one is TS bundled to
`app.js` by `deno task bundle-chat-web`, and this example uses plain JS with no build step. Serve a
static `app.js` beside `ui.html` rather than an inline script, so the page keeps a sane CSP and
stays editable while it runs.

- **`serve.ts` is a copy of `examples/analysis/serve.ts`**: serve the page, relay `/v0/*`
  forwarding the caller's `Authorization`, hold no credential. The relay exists only because the
  space sends no CORS headers.
- **Take the CHAT's header allowlist, not the analysis one.** It relays `last-event-id` (a watch
  resumes with it) and passes `content-security-policy` + `x-content-type-options` back, which a
  page painting artifact bytes needs and the analysis app does not.
- **Live updates are a tick, not streams.** A browser allows six connections per origin over
  HTTP/1.1, shared across tabs ([plan-chat-web-ui.md](plan-chat-web-ui.md)). Poll
  `query({kind: "event", match: {worldId, roomId}}, 50, {dir: "asc", after: lastEventId})` every
  ~300ms. `after` is an exclusive keyset cursor and one runtime process mints monotonic ULIDs, so
  this is a correct incremental tail. At most ONE SSE watch as a wakeup hint, over `fetch`
  streaming rather than `EventSource` (which cannot set an `Authorization` header);
  `handleCreateWatch` refuses a kindless pattern.
- **Rendering** is DOM for the room view, exits, entity list and inventory. Generated scene images
  follow the three-lane rule from [plan-chat-web-ui.md](plan-chat-web-ui.md): raster painted
  in-page from a blob URL through the relay, anything navigable opened on the artifact origin under
  a capability minted at click time, never relayed onto the page's own origin where the run token
  lives.

## Auth and deployment

Follow the chat's `--serve` split: setup is privileged and happens once (register kinds, mint NPC
definitions and grants, start the fleet), and a player session holds nothing but its own SSO login.
Join mode is selected by the ABSENCE of an operator credential, never a flag.

Players enrol through `POST /v0/sessions/oidc` holding zero grants;
`extensions/ts/enrolment.ts` (`sweepEnrolments`, `watchEnrolments`) is the shared "everyone the IdP
vouches for may play" policy, parameterised by this app's grant set.

**Fog of war: read-side room scoping is inexpressible; fog of war itself is not.** The distinction
is the finding, and the shipped example blurs it. A grant matches record CONTENT against a static
pattern, so which side of an operation the discriminator lives on decides everything:

- **WRITE works.** An NPC's `event: put` is pinned to `{roomId, actor}` (`examples/mud/roles.ts`),
  so speaking elsewhere or in another's name is refused by `bodyMatchesGrant` with nothing in the
  app checking. It works because the room is IN THE RECORD being written.
- **READ fails.** "Events of the room I am standing in" binds the read to the READER'S mutable
  position, which is not in the record and not a constant. `{roomId}` on `event: query` would have
  to be rewritten every move.

Grant rotation per move is not a nuisance, it is a HARD STOP. Per-room read grants count against
`maxGrantRecordsPerPrincipalKind` (256, `src/core/space.ts`) for the (player, `event`) pair, and
`GRANT` is `NEVER_COMPACT` (`src/core/gc.ts`), so the count is HISTORY no sweep clears. An identical
revisit ABSORBS (`grantKey` includes the pattern, body compared by hash), but correct fog must
RETIRE the old room's grant on leave, and a retirement is another uncompactable record, so a few
hundred room-changes wedge the player at `too_many_grants` (429), permanently. The runtime's own
hint for this reads "a changing pattern, most likely".

**The better way is not a grant trick: push the position-dependence to the WRITE side, where the
runtime already works, and give the reader a grant that never changes.**

- Player grant: `event: query` scoped `{worldId, recipient: <player principal>}`, STATIC, issued
  once at enrolment. No 256, because MOVEMENT CHANGES THE WRITER'S BEHAVIOUR, NEVER THE READER'S
  GRANT. The `audience` field already on `event` (today a DISPLAY convention, "room" or a
  principal) becomes the enforced `recipient`.
- The narrator writes one `event{recipient}` per current occupant. Occupancy is NOT a per-event
  read: it watches `presence` (the `{worldId, actor}` content-keyed registry) as a reactor loop and
  holds room -> occupants in memory, reconciled on the tick, so the per-event cost is N WRITES and
  no read.
- Room STATE (who and what is here) has the SAME fog: a `presence` read scoped to `{worldId}` leaks
  other rooms. So it is fan-out too, or a per-player `view{recipient}` record (content-keyed, one
  per player, compacted) read under the same static self-scope. View for "what is here", the event
  feed for "what just happened".

Three constraints keep fan-out honest, and "enforceable" alone hides them:

- **ONE trusted author.** An NPC's grant pins `{roomId, actor}` but cannot pin `recipient`, which
  is dynamic, so a recipient-addressed event from an NPC could reach a player in another room.
  Constraining the writer's recipient set is the SAME unexpressible dynamic-membership problem one
  level up, so all event emission funnels through a single trusted author (the narrator) and NPCs
  emit INTENTS. That changes the phase-1 "an NPC writes `event` directly" contract.
- **The guarantee is TWO layers.** The grant HARD-enforces "a player reads only what is addressed
  to them"; WHO the narrator addresses is eventually-consistent off its presence-watch, so a player
  who just left may receive a beat or two more until the watch catches up. The hard half is the one
  that matters (no player can bypass it to read another's stream); the soft half is only the
  narrator's accuracy.
- **Idempotency is per RECIPIENT.** Fan-out from one command writes N events, so the key is
  `evt:<causedBy>:<recipient>`; a per-command key would write the first recipient and conflict the
  rest on redelivery. The player's `presence: query {worldId}` grant is part of the same leak and
  goes too, replaced by the `view` fan-out.

Cost is not the objection it reads as: room events are human-paced and occupancy is small, so a
50-player room is 50 writes per utterance at typing speed, nothing for a runtime benched in
thousands/sec. It is all kinds, patterns, grants and a worker: an ELEMENT, not a new generator
([design-algebra.md](design-algebra.md)), expressible today with no kernel change.

**Never bind position to the credential.** The shortcut is `roomId` on the `agent_run` body and a
scope reading it back (zero extra reads, the run is already resolved). Reject it for a rule that
generalises past this app: visibility-gating reader state (position, inventory, faction, health) is
HIGH-CHURN, and the auth path is the one place high-churn state must not live. It is the hot read
that must stay flat, and a re-put OUTRANKS a `retired: true` tombstone, so a move-write would revive
a stopped run and blow a hole in offboarding. Position is world state; the credential is authority.

**Never scope a player's grants with `createdBy: "self"`** either. Events are authored by narrator
and NPC workers, so self-scope hides exactly what the player needs to see, which is why the
`recipient` fan-out above scopes on an addressed field rather than on authorship. This is the gap
[research-app-lessons.md](research-app-lessons.md) records both existing apps hitting independently.

**Keycloak needs an edit for a new port.** `docker/keycloak/realm-radia.json` registers redirect
URIs and web origins for 7788, 8081 and 8082 only, and the import runs once per fresh Keycloak
database, so anyone with an existing local instance must reset it. Reusing 8082 avoids the edit and
collides with the chat's web UI.

## What the runtime gives you free

Worth stating in the README, because it is the pitch: lease-fenced contention over scarce items,
at-least-once redelivery so a crashed NPC's turn is re-run, the tamper-evident event chain as a
game log, `radia flows` mining the shape of play from lineage with nobody declaring it, the
console's Graph and waterfall views for following a turn, `gc` compacting the position and fact
registries to newest-per-key, and offboarding a player or an NPC as `radia runs --for <principal>
--stop`.

## Walls, checked against source

| Item                                              | Status                                                                 |
|---------------------------------------------------|------------------------------------------------------------------------|
| Nothing FIRES at a time                           | `availableAt` defers claimability (2026-08-21); a poller must still exist. No sweeper, by decision. |
| No `$ne`, `$nin`, `$not`, `$prefix`, `$regex`     | `src/core/matching.ts`. "Everyone in the room except me" is not expressible; filter client-side or model positively. |
| `readOne(pattern)` matches BODIES, not ids        | `sdk/ts/client.ts`. Every entity carries its identity in its own body. |
| Record bodies have no erasure path                | Player prose is user content. Declare `defaultRetentionSeconds` on `command`/`event` or the world is permanent. |
| Per-move / per-room READ scope                     | Not expressible: it binds a read to mutable READER state (position), not to record content. Push it to the WRITE side, a static `{recipient}` grant plus narrator fan-out (see Fog of war). The ops read tiers (`observe` / self / grant PATTERN, architecture-ops-tiers.md) are world-scoped for the same reason. |
| Browser connection budget                         | Six per origin, shared across tabs. One stream maximum.                |
| Registry growth                                   | `contentKey` on `presence`/`fact`/`room` is what bounds a per-move log. |

## Phases

1. **Kinds and a scripted world, no model.** Narrator worker claims `command`, writes `event`,
   updates `presence`. Two scripted NPCs. Smoke test with no API key. BUILT: `examples/mud/`, plus
   a terminal client (`play.ts`) so the world can be walked by hand before the page exists, and
   AMBIENT NPCs on a chain of deferred cues once `availableAt` landed.
2. **The page.** Relay, `ui.html` + `app.js`, SSO gate, the `after`-cursor tick. Two tabs in one
   room seeing each other is the point at which the example justifies itself.
3. **Contention.** `contest` records, `take` under a lease, two players racing for one item.
4. **LLM narration and LLM NPCs.** `llm_call` into the existing fleet. melkrox's `TURN_RULES`, its
   `<STATE>`/`<FACTS>` prompt structure and `stateUpdates` port over almost unchanged, with `facts`
   becoming records.
5. **Scene images.** The `scene_image` memo and artifacts, reusing
   `examples/chat/provider/imagegen.ts`.
6. **Workspace-agent NPCs.** Model-written NPC behaviour, promoted, pinned, brokered.

Phases 1 to 3 need no API key and no model, so the coordination content ships before any provider
dependency does.
