# Plan: presence, ephemeral liveness as an extension convention

**Status: PLANNED 2026-08-30.** Nothing is implemented yet. Actions 7 and 8 of
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
blocks failing closed on a name conflict (action 8).

Three mechanisms already answer "is the other side alive", each differently:

| Mechanism                                       | Scope               | Liveness test                                            | Stays as is?                                                          |
|-------------------------------------------------|---------------------|----------------------------------------------------------|-----------------------------------------------------------------------|
| `chat_fleet` (`examples/chat/client/fleet.ts`)  | process (launcher)  | newest beat within `FLEET_TTL_MS`                        | converts to the convention (phase 2)                                  |
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

Open for phase 1: an instance serving several subjects is either N beats or one record carrying a
`subjects` array; decide after checking whether a keyword `indexedPaths` entry matches array
elements (`src/core/matching.ts`).

## The capability join, and fail-closed conflicts

Phase 3: `collapseByTool` (`extensions/ts/capability.ts`) takes an optional live-provider set
(from `livePresence` with subject = provider name). An advertisement whose provider announced
presence and has no live instance is STALE: excluded from the conflict computation and reported
on the entry. A provider that never announced is outside the convention and counts live, so mixed
fleets keep working and the fail direction stays stale-visible.

Phase 4 is action 8. With staleness distinguishable, a conflict between two LIVE providers fails
closed by default: the entry is withheld from the tool list and reported, instead of the newest
definition winning silently (which today lets a `capability: put` holder substitute a tool's
definition; the flag's one consumer outside tests is a console notice in
`examples/chat/client/turn.ts`). A conflict where every rival but one is stale resolves to the
live one. Today's newest-wins survives as an explicit opt-out; extensions sit outside the frozen
wire contract, so the default may flip, and it flips only together with phase 3 in the same
consumer.

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

1. **The module and its contract.** `presence.ts` under `extensions/ts/` (ensure-kind, announce,
   retire, livePresence, retireIfLast) and a conformance suite beside
   `extensions/conformance/capability.test.ts` (live / stale / retired; window keying dedupes;
   the relevance-bounded walk finds an instance whose beat sits just inside the TTL behind many
   fresher records of other instances; refresh past TTL/3 refused; the scan ceiling reports).
   Verify: `deno task test:extensions`.
2. **Convert the chat.** `examples/chat/client/fleet.ts` announces through the convention.
   Redeclaring `chat_fleet` removes its `contentKey` and adds retention, an ACKNOWLEDGED break
   under [plan-schema-versioning.md](plan-schema-versioning.md); the old stampless records stay,
   bounded at one per historical fleet. Verify: `deno task test:chat`
   (`examples/chat/smoke-fleet.ts`).
3. **The capability join.** The optional live-provider filter in `collapseByTool`; the chat's
   fleet announces its providers as subjects. Verify: `extensions/conformance/capability.test.ts`
   grows the stale-provider cases; `examples/chat/smoke-capability.ts`.
4. **Fail closed (action 8).** The conflict default flips for presence-aware consumers, opt-out
   named. Verify: a conformance case in each direction (a live-live conflict is withheld; a
   live-stale conflict resolves to the live provider).

Read before adding a heartbeat, a TTL, a liveness check, or anything that asks whether another
process is still there.
