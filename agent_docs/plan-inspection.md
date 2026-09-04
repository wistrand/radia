# Plan: inspecting emergent flows

> Status: backlog. Items 1, 2, 3 and part of 4 are built (see design-inspection.md); the rest is not.

Sequence, status and dependencies. The reasoning lives in
[design-inspection.md](design-inspection.md): why inspection is a distinct problem in a
content-routed space, who each feature is for, what shape each mechanism has to take, and the
constraints that make an inspection feature a defect if violated. Read that first; this file assumes
it.

## Dependencies

Two remediation packages gated this work and are now closed
([plan-audit-remediation.md](plan-audit-remediation.md)):

- **B (scoped reads)** gave every read verb a shared path, `Space.readAccess`. Every item below adds
  a way to serve records, so each must use it and add a row to the guard table in
  `test/http.test.ts`.
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
| 1 | `explain` on query, evidence-linked narrative           | Agent     | **`explain` DONE**, and now RENDERED: the console's Records browser requests it and shows the notes (2026-08-06; the Query playground that also did was folded into Records on 2026-09-03). Evidence-linked findings landed the same day as the console Overview's doctor view (`loadDoctor`: `GET /v0/ops/diagnostics` as ranked findings, every sample a link into Records). Narrative for arbitrary generated answers stays open |
| 2 | Flows tab                                               | Newcomer  | **DONE** (2026-08-04). Mining + the tab; the `flow` RECORD is not written, see below |
| 3 | Interest-as-records, dry-run matcher                    | All three | **DONE**, and it paid out twice: the orphaned/starving split (2026-08-04), and the ROUTING DIAGRAM (2026-08-06, the console Kinds tab: agents ←listen— kinds from live interests, beside the per-kind digest of declaration + counts + listeners) |
| 4 | Thread grouping, `thread()`, shape-aware collapsing     | Agent     | **DONE** (2026-08-06): the Feed groups by lineage root (cached, bounded lookups), collapses same-shape runs into ×N, and its match filter is a REAL query (dogfooding); knobs travel in the hash |
| 5 | Waterfall, OTLP export                                  | Newcomer  | **Waterfall DONE** (2026-08-06): a Graph view mode, time as the x-axis, bars honest about "a record is not a span" (creation → last derived record), depth as indent, knob in the hash. It is also the DRILL-DOWN TARGET everywhere a duration raises a question: flow exemplars, feed thread headers, doctor samples ("thread"), and a button on every record detail. Each shape additionally offers a "timing" waterfall aggregated across its exemplar graphs (median offsets per depth+kind step, client-side, sample-labelled) — where the median duration goes. **OTLP export DONE** (2026-08-06, `extensions/ts/otlp.ts` + `radia otlp`): a client that pushes, per the design — trace = thread, span = attempt (take→settle, TRUE lease intervals from the event log), deterministic ids so re-export dedupes, `--trace-root <kind>` for the hub problem, follow mode seeded from the tail. HARDENED by live Jaeger use, three findings an operator's trace surfaced (the lessons are a gotchas.md entry, "Three rules the OTLP exporter learned"): services resolve run → agent through `agent_run` records, out-of-export parents Link and the follower backfills ancestry, and families emit together when an ancestor's attempt is open so record spans never freeze at zero. **Narrowed to one sub-thread (2026-08-10)**: a conversation waterfall was showing 150 of 346 records with nothing saying so, because the walk goes both ways and every turn hung off the conversation hub. `?direction=down` plus a `truncated` flag fixed the read; parenting each turn link to its cause (`extensions/ts/turn.ts`) made a turn a subtree there is something to descend. "waterfall from here" on any record detail. Contract in `extensions/conformance/otlp.test.ts`, `test/conformance/suites/graph.ts` and `examples/chat/smoke-turnlink.ts` |
| 12 | Flow totals + cost flame                                | Operator  | **DONE** (2026-08-10): every mined shape reports `totalDurationMs` (summed wall-clock, the "burns the most time" answer `count x median` gets wrong) and, when the caller passes `sum=<body paths>`, per-path `{total, records}` — caller-named so the runtime learns no app's vocabulary, extracted while the scan already holds the record. Console: sum/sort/view knobs in the hash, and a FLAME view whose width is the summed metric, never time: cost and tokens are additive so the geometry tells the truth, where wall-clock overlaps and cannot. `records: 0` and a no-data note keep an empty metric honest. `space_flows` passes `sum` through, so "which workflow costs the most" is an agent's one-call answer. Guards: `test/flows.test.ts` (planted red), `console.test.ts` knob cases |
| 6 | Space digest                                            | Agent     | **DONE.** Pages to exhaustion and reports `complete: false`                |
| 7 | "Who can see this record"                               | Operator  | The read-side twin of the dry-run matcher; same machinery                  |
| 8 | Replay with an explicit horizon                         | Operator  | A dividend already earned; the window closes when retention GC lands       |
| 9 | Taint overlay (colour by label), then provenance         | Operator  | **Colour-by-label DONE** (2026-08-06): graph and waterfall dot per label, records list names each label. Fixed in passing: `taint` is always an ARRAY on the wire, so the old truthiness check had been marking EVERY record tainted since the labels landed. Provenance ("which ancestor introduced `net`") is still the pruned lineage walk, open |
| — | Erasures that no longer hold                             | Operator  | **DONE, unplanned.** Arrived from a live incident rather than this list; see below |

Item 1 is independent of everything else. Item 3 was the one whose absence explained why the
newcomer's question had no answer, and with it and item 2 built, that question is answerable.

### What item 2 shipped, and the half it did not

`Space.flows` (mining in `src/core/flows.ts`), `GET /v0/ops/flows`, `radia flows`, the chat's `space_flows`,
and the console's **Flows** tab. Each causally connected subgraph is abstracted to the sequence of
`(kind, agent)` per depth and grouped; both granularity knobs are parameters because a mis-set one
fails silently. Acceptance test met: `test/flows.test.ts` recovers the pipeline's
`job → task×4-7 → result×4-7 → summary` unprompted, and mines the stalled shape beside it.

**The hub cut came from first real use, not from this plan.** A long-lived `conversation` made one
component out of a whole multi-day chat, and a `workspace` version spine linked the turns a second
way, so every conversation mined as a unique shape. Both are now cut by one structural test (what
splits the component when removed; a reconverging fan-out does not), which took the largest mined
shape from 930 records spanning 26 hours to 23 records spanning 5 minutes, and recurring shapes from
4 to 24. See [design-inspection.md](design-inspection.md).

**The `flow` RECORD is deliberately not written.** [research-self-modeling.md](research-self-modeling.md)
specifies emitting one whose `parent_ids` are the exemplars, so the measurement gets provenance and
successors give drift over time. That is the consolidation step, it belongs to a research track
nothing has scheduled, and it needs a reserved kind, which is a wire-contract change. The read is
useful without it; the record is not useful without a consumer.

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

**Queued, same finding one layer out:** `holds` is read from the handling instance's own blob store,
so with several instances over LOCAL blob directories both the shred and the answer are per instance
(design-storage.md, "Scaling and multi-instance operation"). The check is a `doctor` finding for
that configuration, derived the same way: shared record storage beside a non-shared `BlobStore`.

## Not scheduled, and why

- **Density mode and thread highlight** on the Space view are small and depend on nothing. They are
  absent from the order only because they improve a view that is already usable.
- **The delegation overlay** is rendering work with no prerequisite, but it will display an
  unattributed node wherever a declassify occurred until package J's attribution is in a space's
  history rather than only in the code.
