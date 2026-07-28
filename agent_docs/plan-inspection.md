# Plan: inspecting emergent flows

> Status: backlog, nothing scheduled. The console's Feed, Graph and Space views work; this is what
> they cannot answer and what would fix that. Claims about current behavior were verified against
> `src/`; see [research-applications.md](research-applications.md) §8 for the ledger.
>
> Read [plan-audit-remediation.md](plan-audit-remediation.md) first: the packages that gated this
> work (B, D) are done, and §3 records what they leave you to follow.

## Goal

Make the *emergent* process visible — the workflow nobody wrote, mined from evidence. Radia routes
by content, so there is no orchestrator to read and no DAG to render from source. The system's
actual shape exists only in what happened and in who is listening, and today only the first half is
observable.

Follow the repo's design principle throughout: prefer records, queries and compositions over
bespoke endpoints. Most items below are compositions of primitives that already exist.

## 1. The root gap: standing interest is invisible

Emergent flow has two halves. **What happened** — records, events, lineage — is well covered. **What
would happen** — who is listening for what — is almost entirely absent.

Workers express interest by polling `take` with a template the space never retains. Watches are
worse than ephemeral: **verified**, they live in an in-memory map, die with the runtime, are not
queryable, and are never pruned (a leak, tracked in the remediation plan). The chat's `capability`
records solve this at application level only. So the console can show every past hop but cannot draw
the prospective topology — which is exactly the "where is the workflow?" question a newcomer asks in
the first ten minutes.

**Item: make claim interest a record.** A reserved `interest` kind (or fields on `agent_run`)
carrying the templates a run is actively claiming — content-keyed like `capability`/`kind_def`,
withdrawn by `retired: true` successor. `agentLoop` publishes it automatically so no agent author
lifts a finger.

This one change unlocks a cascade:

- **"Who would receive this record?"** becomes a query. The reusable machinery is `compile` +
  `matchesRecord` — **not** `matchesEvent`, which is watch-specific and only fires when
  `state === "available"` (verified, `src/core/space.ts:1257`). Note the direction is inverted from
  normal operation: N registered templates against one candidate body, so it is a linear pass over
  the interest registry, O(registered interests). That is fine at per-worker scale and is not the
  deferred inverted-index work — but say so plainly, so nobody expects it to hold if interests ever
  grow per-record.
- **A dry-run endpoint** — given this body, which interests match — answers the question *before* a
  record is written.
- **Starvation and orphan diagnostics get real.** Today's diagnostics use age/state heuristics
  because the substrate does not know the template population. With a registry, "record matches no
  registered interest" and "interest that has not matched in an hour" are precise, and they compose
  into diagnostics the way the ops plane says diagnostics should be composed.
- **The console gains the missing view:** a live routing diagram. Kinds as nodes, interests as edges
  to agents — the emergent workflow rendered from evidence, continuously true, with dead edges
  dropping off as workers retire.

Two constraints on the design:

- **Grant-gate it, with the self-read carve-out.** An interest registry reveals what every agent is
  listening for. Any principal may read its own; reading others' is operator-only, matching the
  existing `effectivePermissions` boundary.
- **It depends on a remediation fix.** See §3.

## 2. What DAG traversal costs

`childrenOf` is an indexed lookup through a `record_edges` reverse table with keyset paging, so
lineage traversal is cheap and the Flows view (§4.4) needs no new index.

The graph view's ceiling is fan-out, not scan cost: `GRAPH_FANOUT = 200` per node in the BFS, with
`childrenOf` separately capped at `min(limit, 500)` (`src/core/space.ts`). The fix is progressive
expansion or a per-level budget in the UI, not an index.

## 3. Prerequisites from the remediation plan

**Every item in this backlog is a read amplifier.** A Flows miner, a `thread()` verb, a space
digest, a dry-run matcher and an OTLP exporter each add a path that can serve records, and the
per-handler scoping that preceded them leaked through lineage, graph, `take` and the artifact reads
before anyone noticed. Route every new one through the shared read path.

- **Package B is done**, so the path exists: every read verb goes through `Space.readAccess`, which
  returns the template constraint and the author scope together. Any view added here must use it
  and add a row to the table-driven guard in `conformance/http.test.ts` — a verb with no row is a
  verb nobody checked. Omitting the scope is still only a convention, not a compile error.
- **Package D is done**, so a churning registry is safe: a re-declaration after a retirement
  carries an `:after:<recordId>` idempotency suffix and revives. Use that shape for the interest
  registry and for saved lenses; the plain content key alone still cannot revive.
- **Watch lifecycle.** A console that opens a watch per view leaks entries in the never-pruned
  watches map and accumulates `Notifier` waiters. Inspection UIs are precisely the workload that
  opens many short-lived watches.

## 4. The views

### 4.1 Feed — from event stream to causal threads

Arrival ordering interleaves every concurrent flow into noise exactly when the space gets
interesting.

- **Thread grouping.** Collapse by lineage root: one row per active thread (job, conversation,
  turn), expanding to its events. Cheap now that reverse edges exist; approximable today per-kind via
  app fields like `conversationId`.
- **Shape-aware collapsing.** A burst of 400 `llm_chunk` events is one fact, not 400 rows — collapse
  runs of same-kind/same-parent events into a count plus a sparkline. The `excludeKinds` hack in
  `getGraph` is the current workaround; aggregation is the answer.
- **Feed filters are templates.** Let the filter box take the same match object the API takes.
  Dogfooding, and it doubles as a teaching tool for the query language. Caveat: templates are
  body-only and cannot express taint or envelope state (verified, §2.3 of the research doc), so the
  filter needs the envelope selector as a second input.

### 4.2 Graph — from ego-network to trace

- **Time as an axis.** Lay the DAG left-to-right by creation time and overlay envelope spans
  (available → claimed → acked, with attempt marks and lease losses). That is a waterfall —
  distributed tracing's most legible artifact — derivable entirely from the event log and envelope.
- **OpenTelemetry export.** A lineage subgraph is a trace, and this meets skeptical engineers inside
  Jaeger or Grafana rather than asking them to trust a new console first. No dependency is needed if
  you emit OTLP over HTTP/JSON, which keeps the minimal-dependency invariant intact. **Sharpen the
  mapping:** a record is not a time interval, so the span is the lease/attempt interval, with the
  record as span attributes, `parent_ids` as links, and run identity as the service.
- **Overlay the other two stories — but they are not equal work.** The graph shows `parent_ids` only;
  `taint` and `delegation_context` are the other two things a record carries.
  - *Delegation overlay: rendering only.* The data exists and is server-derived. Cheap. It will,
    however, display an anonymous put at the single most important node, because `declassify` records
    no principal (remediation package J).
  - *Taint overlay: needs substrate work first.* Taint is one bit, lives in `runtimeMeta` rather than
    the body (so no template can filter it anywhere), and nothing records **which** parent caused it.
    Rendered today it produces a field of red nodes with no explanation. Useful only once taint
    provenance is recorded — the same missing primitive the containment application needs, so do it
    once for both.

### 4.3 Space — aggregate, replay, highlight

The similarity map is a vibe instrument: good at "is the space healthy", weak at "what is this flow".
Three additions keep its character while adding answers.

- **Density mode at scale.** Heat by kind/state instead of one dot per record, since the bounded,
  evicting buffer already gives up on completeness.
- **Time scrubbing and replay.** The event log carries envelope transitions and the immutable records
  carry bodies, so "show me the space at 14:32" and replay-at-10× are pure reads. **But it works
  because nothing is ever deleted** — retention GC does not exist and `retention_until` is written
  and never consulted (verified). When retention lands (M2), replay depth silently becomes bounded by
  the retention window, and the dormant `cursor_expired` path wakes at the same time. Design the
  feature with an explicit horizon now rather than discovering it later.
- **Thread highlight.** Select a record anywhere (feed, graph) and light up its lineage's path
  through the map, connecting the vibe view to the causal one.

### 4.4 Flows — the view the docs already designed

[research-self-modeling.md](research-self-modeling.md)'s signature mining — abstract completed
subgraphs to `(kind, agent)` sequences, group, count, score — is the best inspection feature on the
table independent of any research framing. A Flows tab: recurring shapes, occurrence counts, success
rates, median durations, exemplar links; partial shapes ("starts often, rarely finishes") ranked
beside complete ones; week-over-week drift.

It converts the feed's noise into the emergent process documentation people keep asking for — the
workflow diagram nobody wrote, mined from evidence. **Its stated blocker is obsolete** (§2), and its
acceptance test is already specified in that doc: recover the pipeline example's shape unprompted.

### 4.5 The view nobody listed: "who can see this record"

The dry-run matcher answers *who would receive* a record. The inverse is missing and matters more for
a substrate whose selling point is per-record policy: **which principals can currently read this
record.** `effectivePermissions` already computes the per-principal side; running it the other way —
given a record, which principals hold a grant whose template matches it — is the question an operator
asks before declassifying and an auditor asks afterward. It is the read-side twin of the dry-run
matcher and falls out of the same machinery.

## 5. Helping the LLM inspector

Freeform LLM queries currently walk barefoot across every documented trap: oldest-first default
limits, ULID same-millisecond ordering, latest-wins projections, and bounded reads treated as
populations — the bug CLAUDE.md calls the most repeated in this codebase. Help means moving the
traps' answers out of prose and into the API surface.

- **`explain` on query.** Templates are data, so the server can annotate: "path not declared on this
  kind (declared: …)", "no `orderBy` → oldest N", "this kind is `claimable:false`, available forever
  is normal", "results hit the limit — this is a page, not a population." **Cheaper than it looks,
  because the pattern already shipped:** query responses carry a `scope` object with `narrowedBy`
  listing the grant templates that narrowed the read, and `/ops/events` carries a `withheldNote`.
  `explain` extends an established convention rather than inventing one. Highest
  inspector-effectiveness per line of code on this list.
- **A space digest endpoint.** One grant-gated read returning the projections an investigator needs
  to orient: active kinds with indexed paths, capabilities, models, the interest registry once it
  exists, grant summary, stats. That digest becomes the system prompt for any inspection agent —
  generated from records, so it cannot drift. `GET /v0/ops/permissions` is already one component;
  the chat's `space_kinds` is the seed. **It must read through `readRegistry` and surface
  `complete: false`** — as the most-trusted artifact for any LLM inspector, it is the worst possible
  place to reintroduce the bounded-read-as-population bug.
- **High-level verbs for the compositions LLMs get wrong.** `thread(recordId)` — the full,
  causally-ordered story around a lineage root (cheap now that reverse edges exist). Registry reads
  exposed as reads, with `activeByKey` applied server-side, so no model re-implements paging and
  dedupe.
- **Saved lenses as records.** When an investigation query proves useful, save it — description plus
  template plus verb chain — as a content-keyed record, discovered like capabilities, retired by
  successor. The space accumulates its own inspection vocabulary, and every investigator inherits
  every prior investigator's good questions. **Use the `:after:<recordId>` idempotency-key suffix
  from `examples/chat/space/model.ts`.** The chat's `save_procedure`/`retire_procedure` is the same
  shape without it and is broken: save, retire, re-save the identical lens is a deduped no-op that
  reports success while the lens stays retired.
- **Evidence-linked narrative.** Any LLM-generated answer about the space should carry the record ids
  it rests on, rendered as console links. That keeps freeform narration honest — the calibration
  principle applied to the inspector itself: a story about the space is a claim; the linked records
  are the measurement.

## 6. Priority

Ordered by dependency first, then payoff per unit of work.

| # | Item                                                   | Why here                                                                 |
|---|--------------------------------------------------------|--------------------------------------------------------------------------|
| 0 | Scoped-read helper (remediation package B)             | Gate. Every item below is a read amplifier and lineage/graph already leak |
| 1 | `explain` + evidence-linked narrative                  | Nearly free, extends a shipped convention, improves every other inspector |
| 2 | Flows tab                                              | Deepest payoff; its blocker turned out to be imaginary                    |
| 3 | Interest-as-records + dry-run match                    | Biggest conceptual unlock (routing diagram, real diagnostics, "who gets this"); needs package D first |
| 4 | Thread grouping, `thread()`, shape-aware collapsing    | Cheap now that reverse edges exist                                        |
| 5 | Waterfall + OTLP export                                | Highest credibility per line of code with outside engineers               |
| 6 | Space digest                                           | High value, but must page to exhaustion — do it after the registry discipline is settled |
| 7 | Replay with an explicit horizon; taint provenance; declassify attribution | Substrate changes rather than views                     |
