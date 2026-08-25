# Plan: what a registry read costs

**Status: items 1-3 BUILT (1 on 2026-08-22, 2-3 on 2026-08-23); item 4 open and probably unnecessary.** Every number here was measured the same
day, in-process, against both embedded adapters and a throwaway `postgres:16`. Opened by asking where the "bounded read as
population" disease should be fixed (audit package W4 fixed one site; this is the class).

The disease and the cost turned out to be the same problem seen from two ends, and the fix is not
where the first analysis put it.

## What was measured

**A registry read is linear in HISTORY, not in the number of entries.** 20 capabilities behind a
growing tail of superseded successors, read to exhaustion the way `readAll` does:

| history | read | pages | transferred | to learn |
|---------|------|-------|-------------|----------|
| 20      | 2ms  | 1     | 10 KiB      | 20 entries |
| 2,000   | 8ms  | 5     | 976 KiB     | 20 entries |
| 10,000  | 34ms | 21    | 4.9 MiB     | 20 entries |

**Compaction makes it exactly flat.** After `gc` at 10,000 history: 1 page, 10 KiB, 0ms, the same 20
entries, byte-identical to the 20-record case. So the expensive shape is an UNSWEPT SPACE, not a
design property. Compaction costs 98ms at 10,000 and reclaims 9,980 records.

**The exception is authorization, and it is the hot path.** `Space.access()` reads the grant
registry per authorized request, unmemoized, and `GRANT` is in `NEVER_COMPACT`, so its history can
never be swept. `authorize()` against history for one (principal, kind):

| grant records | SQLite   | Postgres 16 | vs baseline |
|---------------|----------|-------------|-------------|
| 1             | 2.37ms   | 1.72ms      | 1.0x        |
| 100           | 2.67ms   | 2.90ms      | 1.7x        |
| 1,000         | 5.67ms   | 16.18ms     | 9.4x        |
| 5,000         | 17.12ms  | 93.57ms     | **54.4x**   |

Postgres is 5.5x worse than SQLite at the tail, which is the direction that matters: the conformance
suite runs mostly on embedded, so this curve is invisible to it. At 5,000 the read is ten pages of
500, about 9.3ms per page, so it is fetching and projecting bodies rather than paying latency.

**The second axis is mild and was cleared.** A principal holding ONE grant, as the space's total
grant count grows: 1.04ms at 1, 1.46ms at 500, 1.47ms at 5,000, 2.35ms at 20,000. Ordinary index
growth; the index on `principal` does its job. The dominant term is per-(principal, kind) history.

## What that means

The realistic path to a large history is not slow decay. Content-keying dedupes a re-assignment
inside the idempotency window, so ordinary operation adds about one record per (principal, kind) per
week. The path that matters is a fleet REPUBLISHING grants in a loop, which
[gotchas.md](gotchas.md) records happening once already, and from which there is no recovery: grants
cannot be compacted, so the space is permanently slower and nothing reports it.

## Rejected: a server-side registry read (REOPENED 2026-08-24, see below)

The first analysis proposed exposing the projection the runtime already does for itself
(`Space.registry`), so a client transfers O(entries) instead of O(history). REJECTED, for the reason
the measurement makes plain: it hides an O(history) walk behind an endpoint where the caller cannot
see it, and it removes the pressure to sweep, so the symptom disappears while the cause grows. A
read whose cost the caller cannot see is acceptable only when that cost is FLAT. Make it flat first,
and the existing `queryAll` is already one round trip and 10 KiB.

**THIS REJECTION EXPIRED WHEN ITEMS 1 AND 3 SHIPPED, and the reason is recorded rather than quietly
dropped.** Both objections were about the state of the space at the time: automatic per-kind
compaction (item 3) made registries flat, so the hidden cost is now a FLAT hidden cost, which is the
bar this paragraph itself sets; and nothing has to remember to sweep any more, so there is no
pressure left to remove. What it still needs first is the invariant the reopening turns on, "a
registry is either compactable or capped, never neither", because `ops_grant` is currently neither
and is read per principal on EVERY ops-plane request. See
[plan-bounded-reads.md](plan-bounded-reads.md), findings 3 and 4.

## The plan, in order

**1. Cap grant history per (principal, kind). BUILT 2026-08-22.**
`SpaceContext.maxGrantRecordsPerPrincipalKind` (256), enforced by `Space.checkGrantBudget` from
`putRaw` so the definition path cannot bypass what the client path is bounded on, refused as
`429 too_many_grants`. Counted in RECORDS via `RegistryView.scanned`, not live entries, because one
live grant behind 4,999 retirements costs the reader the same as 5,000 live ones. A withdrawal is exempt, or a
fleet at the ceiling could not shrink.

AT THE CEILING, A RE-PUT OF A LIVE IDENTICAL GRANT IS ANSWERED WITH THE RECORD THAT ALREADY CARRIES
IT, rather than written. The first version simply EXEMPTED such a re-put, and that left the ceiling
unable to bound the case it was built for: content-keying dedupes only inside the idempotency window
(7 days), so a fleet restarting weekly appends one record per pair forever, and measured, 40 re-puts
of one identity sailed past a ceiling of 10. Answering with the existing record keeps the restart
working and stops the growth, and it is the same answer idempotency already gives inside the window.
Below the ceiling nothing changes. Guards in `test/conformance/suites/limits.ts`, both halves proved
red (the ceiling by disabling the hook, the no-growth half against the exempting version).

One existing test now opts out explicitly (`suites/authhistory.ts` builds 1,200 grant records to
prove the READ reports incompleteness), which is the honest shape: the ceiling bites a real path,
and the test that needs the forbidden state says so.

THE CURVE SET THE NUMBER: 100 records keeps `authorize()` at 2.90ms (1.7x baseline) while 1,000
costs 16ms. 256 sits above any plausible honest churn and still holds the hot path near baseline,
which is the trade a ceiling is for. `maxInterestsPerPrincipal` (64) is the precedent and
`checkInterestBudget` was the template.

THE ONE THING TO KNOW BEFORE RAISING IT: a refusal is one-way for that pair, because grants never
compact. That is deliberate (the alternative is a space that silently gets slower forever) and it is
the strongest argument for revisiting grant compaction, which is why the section below says what
would have to be solved first.

**2. The guard for the disease itself. BUILT 2026-08-23.** `test/registrycost.test.ts`, in
`test:quick`. A `query()` result feeding `activeByKey` / `newestByKey` / `activeSet` is definitionally
a population built from a page, which is the one form of this bug where the intent is written down;
the general form is not checkable, because `query(kind, 500)` looks careful either way. Proved red
twice: the defect it found, and a fresh one planted in another tier in the inline form.

IT FOUND TWO REAL DEFECTS, both in the chat's procedure lookup, and both worse than the shape
suggests. `query` with a limit and no `dir` returns the OLDEST matches, so a procedure re-saved past
the limit resolved to a stale version while looking correct: 51 saves answered with the 50th. Both
now page to exhaustion, because the history is per NAME and there is no honest number to bound it
with.

**3. Automatic compaction for keyed kinds. BUILT 2026-08-23.**
`SpaceContext.compactEveryWritesPerKind` (200), enforced by `Space.maybeCompactKind` on both commit
paths, `0` to disable. This is what makes the flat case the DEFAULT rather than a property of
well-tended spaces.

PER KIND, and that is the machinery rather than a detail: registry litter grows per write of a KEYED
kind, so riding `gcEveryWrites` would walk every registry in the space because somebody streamed a
million chunks. The counter is per kind, only keyed kinds count (answered from the in-process
registry, never the database), and `compactRegistries` takes `only` so the pass walks the one
registry that just grew. Guards in `suites/gc.ts`; the isolation half is proved red by removing both
the keyed check and the scope.

A TYPO USED TO DISABLE IT SILENTLY. `contentKey` is optional and absence means "not a registry", so
`contentKeys` declared a kind that simply never compacted, with nothing to see and this whole
document's cost curve as the result. Refused since 2026-08-25 (`assertKnownKindDefFields`), on the
WRITE path only: `loadKinds` skips what its validator rejects, so a stored declaration must keep
loading. See [gotchas.md](gotchas.md).

ONE CONSEQUENCE, recorded in [gotchas.md](gotchas.md): compaction deletes superseded entries AND
their edges, so a record parented onto a registry entry now dangles by default rather than only
after somebody ran the verb. Nothing in-repo does that, and the retention sweep already behaved the
same way, but the rule is now load-bearing: reference a registry entry by its content key.

MEASURED, and it is not a trade: 1,000 writes of a keyed kind with 20 keys took 177ms with the
trigger off and 77ms with it on, because a table with 20 rows is cheaper to insert into than one
with 1,000. The reader went from 1.66ms to 0.07ms. The writer pays nothing and the reader stops
paying for litter.

Two existing tests now opt out explicitly (`suites/gc.ts`'s page-boundary walk needs 512 records of
one kind to still exist when the verb runs). Same shape as the ceiling's opt-out: the automation
bites a real path, and the test that needs the un-swept state says so.

**4. Memoize `access()` per (principal, kind). OPEN, and probably unnecessary.** Deliberately last.
With the ceiling from item 1, `authorize()` is bounded near 2.9ms and cannot grow, which already
satisfies "flat and the default". A cache on the authorization path buys the remaining milliseconds
at the price of an invalidation bug being silent misauthorization, the worst failure class in this
codebase. Do not build it without a measurement from a real deployment saying the 2.9ms matters.

## Not to be done

**Making `GRANT` compactable.** Keep-newest-per-key would preserve tombstones, but it interacts with
`RadiaClient.grant`'s revival protocol, which keys a revival on the id of the retirement it
supersedes: sweep the retirement and the anchor is gone. That is a correctness change on an
authorization path to buy what item 4 gives for free.

## How the numbers were taken, and what they do not cover

In-process against each adapter, 50 samples per point, warmed, small bodies, one kind, a container
on loopback with cold caches. Good for the SHAPE and the ratios; not a production latency budget.
Over HTTP adds per-page serialization on top, so the tail is worse than shown, never better.
