# Plan: presence, ephemeral liveness as an extension convention

**Status: ALL FOUR PHASES BUILT 2026-08-30** (`extensions/ts/presence.ts`, plus
`liveAdvertisements` and a fail-closed `collapseByTool` in `extensions/ts/capability.ts`; eighteen
conformance cases, five proved red by planting: the incomplete-view guard, the relevance-bounded
walk, the per-window beat key, the presence bit in the capability content key and the withholding
default. The chat beats as `chat_presence`, hides the tools of a fleet that stopped, and offers a
contested name to nobody). Actions 7 and 8 of
[research-app-lessons.md](research-app-lessons.md), planned here. Claims about current behaviour
were verified against source the same day.

## The problem

A capability advertisement is a claim of intent, never evidence of liveness:
`retireProviderCapabilities` (`extensions/ts/capability.ts`) says so in its own doc, only a clean
shutdown withdraws one, and the advertisements have no TTL. The chat bounds the last-one-out
withdrawal VOTE with `chat_fleet` records (`examples/chat/client/fleet.ts`, `FLEET_TTL_MS` 15m,
refresh 5m), but when the SOLE fleet crashes nothing ever withdraws: its tools stay advertised
until a person cleans up. Every caller of an advertised tool therefore carries its own timeout,
and `collapseByTool` cannot tell a live disagreement from a stale advertisement, which is what
blocks failing closed on a name conflict (action 8): without liveness, one stale advertisement from
a crashed process would take a working tool offline indefinitely.

Three mechanisms already answer "is the other side alive", each differently:

| Mechanism                                       | Scope               | Liveness test                                            | Stays as is?                                                          |
|-------------------------------------------------|---------------------|----------------------------------------------------------|-----------------------------------------------------------------------|
| `chat_fleet` (`examples/chat/client/fleet.ts`)  | process (launcher)  | newest beat within `FLEET_TTL_MS`                        | CONVERTED 2026-08-30, as the `chat_presence` kind                     |
| `interest` (`liveInterests`, `src/core/gc.ts`)  | run                 | the RUN is live                                          | yes: runtime routing state, liveness delegated to credential machinery |
| `progress` (`extensions/ts/progress.ts`)        | one call            | absence = unclaimed; recency drives the stall diagnosis  | yes: per-call, retention-swept, already a convention                  |

The MUD's `presence` kind is NOT an instance: it is latest-wins location state with no TTL, and an
actor who disconnects deliberately stays where it stood.

## The convention

A module `presence.ts` under `extensions/ts/`, importing the SDK and never `src/` like every
extension.

**The kind.** The app names it; the helper declares it: `indexedPaths` = subject, `claimable:
false`, `defaultRetentionSeconds` = 4x the TTL, and NO `contentKey`. The last two are one
decision: the newest record per registry key is never swept (the GC invariant), so a keyed
presence kind leaves one permanent record per dead instance id, forever. Unkeyed plus retention,
every beat carries its own expiry stamp (materialized at commit), and a dead instance disappears
entirely once its last beat ages out.

**Write side.** `announcePresence(client, {kind, subject, instance, refreshMs, signal})`: a beat
is `{subject, instance}`, idempotency-keyed per refresh WINDOW (`floor(now / refreshMs)`, the
chat's `markFleet` shape), so a long-lived instance costs one retention window of records rather
than one per beat. Clean shutdown writes `{retired: true}` under its own key.

- The refresh is at most a third of the TTL; assert it. That margin is what absorbs clock skew
  and a slow tick.
- Heartbeat timers are always client-side. The space never fires one.

**Read side.** `livePresence(client, {kind, ttlMs, subject?})` returns subject to live instances.
Newest-first, dedupe per (subject, instance) on first sight, a `retired` newest is dead, and the
walk STOPS at the first record older than the TTL. That stop is a bound by RELEVANCE, not page
size, and it is exhaustive over the live set by construction: every live instance has a beat
younger than the TTL and the read is newest-first, so nothing live sits past the stopping point.
Say so at the call site ([plan-bounded-reads.md](plan-bounded-reads.md)). The walk still carries
a scan ceiling against a flooded kind and REPORTS stopping early, never answering a plausible
prefix. Ages compare `createdAt` (the database clock) against the reader's own clock, the trust
`liveFleets` already documents; the refresh margin is the tolerance.

**Last one out.** `retireIfLast(client, {kind, subject, instance}, onLast)`: retire own presence,
count OTHER live instances, run `onLast` only at zero. Two instances exiting at once can each see
the other and both skip. That fails toward stale-visible, never live-invisible, the direction
`examples/chat/client/fleet.ts` already documents.

**Resolved in phase 1: one beat per SUBJECT, never a `subjects` array.** A plain keyword match does
not distribute over array elements (`getPath` in `src/core/matching.ts` demands a numeric index on
an array, and `evalNode` refuses to distribute: "no silent distribution over non-arrays"), so an
array would put every reader on `$any` to answer "is this provider alive".

## The capability join, and fail-closed conflicts

Phase 3: `collapseByTool` (`extensions/ts/capability.ts`) takes an optional live-provider set
(from `livePresence` with subject = provider name). An advertisement whose provider announced
presence and has no live instance is STALE: excluded from the conflict computation and reported
on the entry. A provider that never announced is outside the convention and counts live, so mixed
fleets keep working and the fail direction stays stale-visible.

Phase 4 is action 8, and it is BUILT. With staleness distinguishable, a conflict between two LIVE
providers fails closed: the entry is withheld and reported, instead of the newest definition
winning silently (which let a `capability: put` holder substitute a tool's definition rather than
merely break it). A conflict where every rival but one is stale resolves to the live one, which is
the ordering the two phases exist in: `liveAdvertisements` runs first, so a crashed worker's stale
definition can no longer withhold a tool its live peer serves unambiguously. Newest-wins survives
as `onConflict: "newest"`; extensions sit outside the frozen wire contract, so the default could
flip at all.

Once consumers filter by presence, the last-one-out withdrawal is hygiene rather than
correctness: a stale advertisement is invisible to a presence-aware reader whether or not
anything withdrew it. `retireProviderCapabilities` stays for readers outside the convention.

## What this is not for

- Claimed work. A lease is already a fenced, renewable liveness signal for exactly one record;
  never rebuild lease semantics out of presence beats.
- State registries. The MUD's `presence` (location) is latest-wins state; a TTL there would evict
  a quiet player from the room.
- Per-call activity. `progress` covers it, absence included.
- Watches. The runtime sweeps idle watches itself (`watchIdleSeconds`).

## Rejected alternatives

- **A TTL on `capability` records** (`defaultRetentionSeconds`). Inert: `capability` declares a
  `contentKey`, and the newest record per registry key is never swept, whatever its stamp says.
  Dropping the key to make it sweepable breaks refresh instead: a re-put of identical content
  inside the idempotency window (7 days) is answered with the EXISTING record, so a live worker's
  refresh appends nothing and extends nothing.
- **Run-tied liveness, like `interest`.** A provider is a NAME that outlives any run (the 12h
  ceiling), served across restarts and possibly several processes; and `runIsLive` is the
  runtime's own read over its credential registry, not an app surface.
- **Presence as a held lease** (claim a claimable presence record and renew it forever). The read
  side lands on the ops plane (envelope state is `GET /v0/ops/records?state=...`), which
  pattern-scoped app consumers deliberately lack; a lease owner is a RUN, not a subject; and it
  parks non-work in the claim machinery, where `doctor` and `remediate` report it forever.
- **A server sweep that expires presence.** Never a timer; and a sweep lags by construction, so
  liveness is computed at read time anyway. Retention already sweeps the litter on the amortized
  write counter.

## Phases

1. **The module and its contract. BUILT 2026-08-30.** `extensions/ts/presence.ts` (`presenceSpec`,
   `presenceKind`, `announcePresence`, `livePresence`, `retireIfLast`) and seven cases in
   `extensions/conformance/presence.test.ts`. Two things the build settled:
   - The conformance fixture is a live instance hidden behind a full page of TOMBSTONES, not
     merely behind fresher beats. The first draft used live ones, and the incomplete-view test
     passed with the guard deleted: a truncated page of 200 live instances still answers "somebody
     else is serving", so the assertion never reached the guard it was written for. Only a
     truncation that looks like an EMPTY WORLD isolates it.
   - `retireIfLast` treats `complete: false` as "somebody is out there". Withdrawing on a prefix is
     the live-invisible direction, and nothing downstream could tell it had happened.
2. **Convert the chat. BUILT 2026-08-30** (`examples/chat/client/fleet.ts` is now announce plus
   `retireIfLast`, ~60 lines of projection deleted; `FLEET_PRESENCE` lives in
   `examples/chat/space/kinds.ts` so the writer and the reader share one spec). A session hides
   the tools of a fleet that stopped beating: the first withdrawal here that works after a CRASH
   rather than only after a clean shutdown. Three corrections to what this entry planned:
   - **A NEW KIND (`chat_presence`), not a redeclared `chat_fleet`.** The plan called for an
     acknowledged break. Reading `incompatibleChanges` (`src/core/kinds.ts`) settled it the other
     way: the redeclaration drops an indexed path AND changes `contentKey`, so an existing space
     refuses it at setup unless the app passes `supersedes`, which means shipping migration
     machinery in an example's boot path forever, for a one-time change. Worse, it leaves the
     old-shape records INSIDE the kind every presence read pages over, while a new name leaves them
     in a kind nothing reads. The body shape changed (`fleetId` became `subject` + `instance`), and
     a kind is a routing contract, so a changed contract earns a new name.
   - **`announceFleet` now awaits its first beat.** The hand-rolled version was fire-and-forget, so
     a launcher was invisible to another launcher's withdrawal check until its first put landed.
   - **`retireIfLast` returns a `RetireResult`, not a boolean.** The two declines are different
     facts and the chat prints them differently: others still serving is ordinary, an incomplete
     view means nothing could tell.

   A mixed-version window is the one thing this does not cover, and it is inherent rather than
   chosen: an old fleet writing `chat_fleet` records is invisible to a new fleet, whichever way the
   kind is handled, so a new fleet can read itself as alone and withdraw. Bounded to an upgrade
   with two launchers running.
3. **The capability join. BUILT 2026-08-30** (`liveAdvertisements` in `extensions/ts/capability.ts`,
   four conformance cases, six smoke checks; the chat's launcher beats per provider and the session
   filters). Three decisions the build made:
   - **A FILTER over records, not an argument to `collapseByTool`.** Applied before the collapse, so
     a dead provider can neither win a tool name nor manufacture a conflict against a live one. It
     also keeps `capability.ts` importing nothing from `presence.ts`; the app wires them.
   - **Participation is a flag ON THE RECORD (`CapabilityBody.presence`), not a list the reader
     holds.** A reader cannot otherwise tell "announced and died" from "never announced": presence
     records age out at the retention horizon, which is exactly when the answer is needed. The flag
     joins the content key and the unchanged-check, or a provider that STARTS beating re-puts an
     identical body under an identical key, the write dedups, and it stays unpoliceable forever.
   - **The claim is made by the LAUNCHER, through the spawn.** `spawn` passes `--presence` to every
     worker it starts (`examples/chat/client/fleet.ts`), because the claim is about who beats, not
     about the worker: a worker started by hand is covered by nothing and must not claim it.

   Two subjects now, answering questions that correlate here and are not the same: `fleet` decides
   the withdrawal, each PROVIDER decides whether its tools are offered. Residual gap, unfixed: one
   worker crashing under a live launcher keeps beating, so its tools stay listed. Per-worker beats
   would close it and would need each worker to hold a presence `put` grant.
4. **Fail closed (action 8). BUILT 2026-08-30.** `collapseByTool` returns a `ToolCatalog`
   (`tools` and the withheld `conflicts`, disjoint) and withholds a contested name by default;
   `onConflict: "newest"` is the opt-out and keeps the old behaviour with `conflicted: true`. The
   chat's notice changed from "using the newest" to "withholding it until they agree".

   **Withholding changes what a model is TOLD, never who may claim a `tool_call`.** That is the
   limit of the mechanism and it decided two call sites in `examples/chat/client/turn.ts`: a
   contested name blocks a saved PROCEDURE from taking it, and it blocks the session's own LOCAL
   definition too. The local case was written the other way first, on the reasoning that the
   session's implementation is unambiguous, and that is wrong: session tools are served through
   `serveTools`, so they are claimed like any other call, and offering one for a name two workers
   are still listening on races them for it. A contested name is offered by nobody.

## Review pass, 2026-08-30

Adversarial review of the four phases, immediately after building them. Eight defects, all in the
new code, all fixed with a guard proved red by planting. They sort into three classes, and the
classes are worth more than the list.

**A read that could not answer must not be reported as an answer.** Four of the eight.
`livePresence` took the absence of `nextCursor` as exhaustion, which the SDK's own `queryAll`
refuses to do ("it says where to continue, never that it is safe to stop"); termination is decided
from the PAGE SIZE now. It also dropped `page.scope`, so a reader holding a pattern-scoped presence
grant would report `complete: true` over a set a grant had narrowed, and `retireIfLast` reads that
flag as permission to withdraw. The chat then threw the same information away twice: a failed
presence read became an EMPTY SET, which says "everyone tracked is dead" and would have stripped
every fleet tool from a working space, and a truncated walk was used as if complete, which would
drop a live worker's tools and announce that it had stopped. `liveProviders` is now
`Set | undefined` with the distinction documented as the whole safety of the function.

**A constant idempotency key silently writes nothing, and this file knew that.**
`retireCapability` already carries the scar and answers it with an anchor; presence reintroduced it
in two places. A repeat of a beat's window key after a BACKWARD clock step (an NTP correction, a
resumed VM) appended nothing while `put` reported success, so an instance beating perfectly well
read as dead once the step passed the TTL. The tombstone key was constant outright, so an instance
id that came back could never be retired a second time. And in `publishCapability`, `presence` only
picked between two constant keys, so a worker restarted by hand after running under a launcher was
left advertising `presence: true` with nothing beating for it, hiding the tool it was serving.

**A lifecycle listener registered after an await is a listener that may never fire.**
`addEventListener("abort")` on an already-aborted signal never fires, so a fleet aborted during
startup kept beating for the life of the process and read LIVE forever, blocking every other
launcher's withdrawal. Separately, a beat already in flight committed AFTER the tombstone, leaving
the instance a ghost for a whole TTL; `retire` waits for it now.

The eighth was the composition the whole feature exists for, inverted: `examples/chat/workers/images.ts`
published its two tools directly WITH the presence flag and then again through `serveTools` without
it, so every boot superseded its own advertisement with an untracked one. The images worker was the
one provider a crashed fleet never stopped offering. `serveTools` is the single publisher now, and
`examples/chat/smoke-fleet.ts` checks every publish in every launched worker carries the flag.

**What presence bought beyond the tool list.** A joining session starts no workers by design, so a
space whose fleet has stopped looks healthy until a turn sits for thirty seconds and reports that
nobody claimed the call. The session already reads presence to filter advertisements, so the banner
asks the same question at BOOT and prints `fleet NOT RUNNING` with the command that starts one
(`examples/chat/chat.ts`). Silent when it cannot tell, and silent in solo mode, where this process
just launched the fleet it would be warning about.

**Second review pass, after first real use.** Running it found four more, none reachable from a
test. A HEARTBEAT MUST NOT STOP THE THING IT DESCRIBES: `announceFleet` awaited its first beat and
sat one line above `launchFleet` with no catch, so a failed beat meant no fleet at all. Its fix is
the coupling, not the catch: `--presence` is a promise that the launcher beats, so a launcher that
cannot beat runs an UNPOLICED fleet rather than one whose every tool a session hides. A dead fleet
also printed one notice per hidden tool, twenty for a single event, so the report is per PROVIDER.
The banner's fleet check spelled the subject a second time, where a rename would have reported a
healthy fleet as missing. And the Python SDK carried the same pre-envelope `read_one` defect as the
TypeScript one, where the silent half is worse: a found record read back as absent.

**Known and accepted, with the reasoning:**
- An SSO deployment's EXISTING people never receive the `chat_presence` grant, because
  `sweepEnrolments` skips anyone already holding something. That is the trap CLAUDE.md names for
  `enrolment.ts`. Back-filling is the wrong fix: a blind re-assign revives grants an operator
  deliberately narrowed. The feature is simply off for them (fail-open), and `grant-user.ts` is the
  operator's remedy. Solo mode re-assigns on every start and is unaffected.
- Presence-unknown plus fail-closed conflicts can lose a tool that newest-wins would have served: a
  dead provider's rival definition still counts, so the name is withheld. Rare (it needs a genuine
  conflict AND an unreadable presence set) and it is the honest answer to an ambiguous question.
- `livePresence` pages by ULID id and stops on `createdAt`. The two agree unless instances are
  skewed by minutes (`newer` in `sdk/ts/registry.ts` documents the difference), and the walk
  reports `complete` either way.
- An instance whose FIRST beat lands mid-walk is invisible to that walk. Inherent to a keyset read
  descending from the newest; the window is one walk.

Read before adding a heartbeat, a TTL, a liveness check, or anything that asks whether another
process is still there.
