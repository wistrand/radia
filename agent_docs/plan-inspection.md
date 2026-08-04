# Plan: inspecting emergent flows

> Status: backlog. Items 1, 3 and part of 4 are built (see design-inspection.md); the rest is not.

Sequence, status and dependencies. The reasoning lives in
[design-inspection.md](design-inspection.md): why inspection is a distinct problem in a
content-routed substrate, who each feature is for, what shape each mechanism has to take, and the
constraints that make an inspection feature a defect if violated. Read that first; this file assumes
it.

## Dependencies

Two remediation packages gated this work and are now closed
([plan-audit-remediation.md](plan-audit-remediation.md)):

- **B (scoped reads)** gave every read verb a shared path, `Space.readAccess`. Every item below adds
  a way to serve records, so each must use it and add a row to the guard table in
  `conformance/http.test.ts`.
- **D (registry revive)** made a churning registry safe to write. The interest registry and saved
  lenses both need the `:after:<recordId>` idempotency suffix.

The last prerequisite, **watch lifecycle**, closed on 2026-08-04. Both halves: `Notifier` waiters
remove themselves on timeout (package O), and the watches map is swept of anything untouched for
`watchIdleSeconds` (default 300s), with `maxWatchesPerPrincipal` (64) as a ceiling. The sweep runs
on CREATE, so an idle space does no background work, and the window is idle-based rather than
disconnect-based because a dropped client reconnects to the same id with `Last-Event-ID` — deleting
on disconnect would have cost it the cursor. **Nothing gates this backlog now.** A console that
opens many short-lived watches is the workload it was measured against; one that holds more than 64
at once per principal is a leak, and gets a 429 saying so.

## Order

Dependency first, then payoff per unit of work. The audience column is what to check before
resequencing: shipping the top three serves agents and newcomers and does nothing new for operators.

| # | Item                                                    | For       | Why here                                                                 |
|---|---------------------------------------------------------|-----------|--------------------------------------------------------------------------|
| 1 | `explain` on query, evidence-linked narrative           | Agent     | **`explain` DONE.** Evidence-linked narrative is a console concern, still open |
| 2 | Flows tab                                               | Newcomer  | Deepest payoff, and its blocker turned out to be imaginary                 |
| 3 | Interest-as-records, dry-run matcher                    | All three | **DONE.** Unblocks the routing diagram and precise starvation diagnostics, neither of which is built |
| 4 | Thread grouping, `thread()`, shape-aware collapsing     | Agent     | **`thread()` DONE.** Feed grouping and collapsing are console work, still open |
| 5 | Waterfall, OTLP export                                  | Newcomer  | Adoption work: meets engineers inside tools they already trust             |
| 6 | Space digest                                            | Agent     | **DONE.** Pages to exhaustion and reports `complete: false`                |
| 7 | "Who can see this record"                               | Operator  | The read-side twin of the dry-run matcher; same machinery                  |
| 8 | Replay with an explicit horizon                         | Operator  | A dividend already earned; the window closes when retention GC lands       |
| 9 | Taint overlay (colour by label), then provenance         | Operator  | The substrate change LANDED (labels, not one bit), so the overlay is rendering; provenance is a pruned lineage walk |
| — | Erasures that no longer hold                             | Operator  | **DONE, unplanned.** Arrived from a live incident rather than this list; see below |

Items 1 and 2 are independent of everything else and of each other. Item 3 is the one whose absence
explains why the newcomer's question has no answer today, so treat a slip there as a slip in adoption
rather than in tooling.

### The one that arrived from an incident

`GET /v0/ops/erasures` and the `radia doctor` finding were not on this list and would not have been:
nobody asks for a view of erasures until one stops holding. A shred destroys the runtime's copy and
not the ability to store those bytes, so a payload can return to the same content address, and
`shredOf` had exactly one caller, inside the branch that runs AFTER a read has already failed —
which made a reversed erasure invisible rather than merely ineffective.

It belongs in this document because it is the shape [design-inspection.md](design-inspection.md)
argues for and the order above does not predict. The question is an operator's, the answer is
DERIVED from present state rather than recorded (a marker plus a present blob), and it costs one
`stat` per shred asked at ask-time instead of a check on every read. The general lesson for the
backlog: an inspection item whose absence is only felt during an incident will never surface from
reasoning about audiences, so incidents deserve a place in how this list is resequenced.

## Not scheduled, and why

- **Density mode and thread highlight** on the Space view are small and depend on nothing. They are
  absent from the order only because they improve a view that is already usable.
- **The delegation overlay** is rendering work with no prerequisite, but it will display an
  unattributed node wherever a declassify occurred until package J's attribution is in a space's
  history rather than only in the code.
