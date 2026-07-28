# Plan: inspecting emergent flows

> Status: backlog, nothing scheduled. Nothing here is built.

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

One prerequisite is still open and is not tracked in the remediation plan: **watch lifecycle**. The
watches map is never pruned and `Notifier` waiters accumulate, and an inspection console is the
workload that opens many short-lived watches. Fix it before shipping anything watch-driven.

## Order

Dependency first, then payoff per unit of work. The audience column is what to check before
resequencing: shipping the top three serves agents and newcomers and does nothing new for operators.

| # | Item                                                    | For       | Why here                                                                 |
|---|---------------------------------------------------------|-----------|--------------------------------------------------------------------------|
| 1 | `explain` on query, evidence-linked narrative           | Agent     | Nearly free; extends a convention that already shipped                    |
| 2 | Flows tab                                               | Newcomer  | Deepest payoff, and its blocker turned out to be imaginary                 |
| 3 | Interest-as-records, dry-run matcher                    | All three | Biggest unlock: routing diagram, precise diagnostics, "who gets this"      |
| 4 | Thread grouping, `thread()`, shape-aware collapsing     | Agent     | Cheap: lineage traversal is already indexed                               |
| 5 | Waterfall, OTLP export                                  | Newcomer  | Adoption work: meets engineers inside tools they already trust             |
| 6 | Space digest                                            | Agent     | High value, but must page to exhaustion; settle registry discipline first  |
| 7 | "Who can see this record"                               | Operator  | The read-side twin of the dry-run matcher; same machinery                  |
| 8 | Replay with an explicit horizon                         | Operator  | A dividend already earned; the window closes when retention GC lands       |
| 9 | Taint provenance, then the taint overlay                | Operator  | Substrate change, shared with the containment application                  |

Items 1 and 2 are independent of everything else and of each other. Item 3 is the one whose absence
explains why the newcomer's question has no answer today, so treat a slip there as a slip in adoption
rather than in tooling.

## Not scheduled, and why

- **Density mode and thread highlight** on the Space view are small and depend on nothing. They are
  absent from the order only because they improve a view that is already usable.
- **The delegation overlay** is rendering work with no prerequisite, but it will display an
  unattributed node wherever a declassify occurred until package J's attribution is in a space's
  history rather than only in the code.
