# Inspecting emergent flows (design)

Why inspection is a distinct problem in a content-routed substrate, who needs it, and what shape
each mechanism has to take. Sequence and status live in
[plan-inspection.md](plan-inspection.md); this file holds the reasoning that outlives the backlog.

> **M1 status: none of this is built.** The console's Feed, Graph and Space views exist and work;
> everything below is what they cannot answer. Claims about current behavior were verified against
> `src/` (see "Verified ground" at the end), which is how one prerequisite in an earlier draft was
> found to be imaginary.

## Contents
- Why this is hard here
- Who is asking, and what they ask
- The root gap: standing interest is invisible
- What each mechanism has to be
- Constraints that stay true
- Verified ground

## Why this is hard here

An orchestrated system documents itself: the workflow is a file somebody wrote, and inspecting it
means reading that file. Radia routes by content, so there is no orchestrator and no DAG to render
from source. A worker declares a pattern, the substrate matches it, and the shape of the system is
whatever those independent declarations add up to at runtime.

That is the design working as intended, and it is also the cost. The system's actual shape exists
in two places only: what happened, and who is currently listening. Today the console can show the
first and almost none of the second.

Never solve this by asking agents to declare a topology. A declared topology is a routing table, and
the substrate exists to not have one. The shape has to be **mined from evidence**, or it will drift
from the running system the way every hand-maintained architecture diagram does.

## Who is asking, and what they ask

Three audiences, three different questions. A feature that serves one may do nothing for another,
so say which one each is for.

| Audience            | The question                                            | What answers it                                      |
|---------------------|---------------------------------------------------------|------------------------------------------------------|
| **Operator**        | Is the space healthy? What is stuck, and why?           | Diagnostics, stats, events, remediation, starvation   |
| **Newcomer**        | Where is the workflow? What does this system do?        | Routing diagram, Flows, waterfall, OTLP export        |
| **Agent/LLM**       | What happened? What may I do? What is in this space?    | `explain`, space digest, `thread()`, saved lenses     |

The newcomer's question is the one with a deadline attached. A content-routed model has to convert
someone in the first ten minutes, unaided, and "where is the workflow?" is the first thing they ask.
Anything that answers it is adoption work, not polish, and it should be ranked that way.

The agent's question is the one that compounds. Every inspection affordance an agent can reach is
one a human does not have to perform, and the substrate already routes and authorizes agents. The
inspector is a participant, not an operator console.

## The root gap: standing interest is invisible

Emergent flow has two halves. **What happened** (records, events, lineage) is covered. **What would
happen** (who is listening for what) is almost entirely absent.

Workers express interest by polling `take` with a pattern the space never retains. Watches are worse
than ephemeral: they live in an in-memory map, die with the runtime, are not queryable, and are never
pruned. The chat's `capability` records solve this at application level, for one application.

So the console can show every past hop and cannot draw the prospective topology. That single absence
is why the newcomer's question has no answer.

**Claim interest should be a record.** A reserved `interest` kind (or fields on `agent_run`) carrying
the patterns a run is actively claiming, content-keyed like `capability` and `kind_def`, withdrawn by
a `retired: true` successor. `agentLoop` publishes it, so no agent author does anything.

That one change unlocks a cascade, which is the reason it ranks above features that look bigger:

- **"Who would receive this record?" becomes a query**, answerable before the record is written.
- **Starvation and orphan diagnostics become precise.** Today they use age and state heuristics
  because the substrate does not know the pattern population. With a registry, "matches no
  registered interest" and "interest that has not matched in an hour" are facts.
- **The routing diagram becomes possible**: kinds as nodes, interests as edges to agents, mined from
  evidence and continuously true, with dead edges dropping off as workers retire.

## What each mechanism has to be

The shape of each of these is constrained by something in the substrate. That is what makes them
design decisions rather than UI choices.

### The dry-run matcher runs the matching direction backwards

Normal operation evaluates one pattern against many records. "Who would receive this?" evaluates
many registered patterns against one candidate body. The reusable pieces are `compile` and
`matchesRecord`, not `matchesEvent`, which is watch-specific and only fires on
`state === "available"`.

It is a linear pass over the interest registry, O(registered interests). That is fine while
interests are per-worker. Say so plainly wherever it is exposed, so nobody assumes it holds if
interests ever become per-record. It is not the deferred inverted-index work.

### The graph's ceiling is fan-out, not scan cost

`childrenOf` is an indexed lookup through the `record_edges` reverse table with keyset paging, so
lineage traversal is cheap and mining needs no new index. The limit is `GRAPH_FANOUT` per node in
the BFS, with `childrenOf` separately capped. The fix is progressive expansion or a per-level budget
in the UI. Never reach for an index here; that prerequisite was already met, and an earlier draft of
this plan carried it as a phantom blocker and ranked its deepest feature last because of it.

### A record is not a span

A lineage subgraph maps onto a distributed trace, which is what makes OTLP export the cheapest way
to meet engineers inside tools they already trust. But the mapping needs care: a record has no
duration. The **span is the lease or attempt interval**, with the record as span attributes,
`parent_ids` as links, and run identity as the service. Emit OTLP over HTTP/JSON so no dependency is
added.

### The three views each fail in a different way

- **Feed** is arrival-ordered, so it interleaves every concurrent flow into noise exactly when the
  space gets interesting. It wants grouping by lineage root and collapsing of same-kind, same-parent
  runs into a count. Its filter box should take the same match object the API takes, which is
  dogfooding and doubles as the cheapest way to learn the query language.
- **Graph** renders one record's neighbourhood. It wants time as an axis (that is a waterfall, the
  most legible artifact distributed tracing produces) and it wants the other two lineages a record
  carries: `delegation_context` and `taint`.
- **Space** is a vibe instrument, good at "is this healthy" and weak at "what is this flow". It
  wants density at scale, thread highlight to connect it to the causal views, and replay.

**Replay is a dividend already earned.** An append-only event log plus immutable records means
"show me the space at 14:32" and replay at speed are pure reads. Time-travel debugging is the payoff
append-only architectures usually never cash in, and this one can. Build it with an explicit horizon,
because retention GC does not exist yet and replay depth is currently unbounded by accident; when
retention lands the window closes silently.

### The taint overlay needs a substrate change; the delegation overlay does not

`delegation_context` is recorded and server-derived, so colouring the authority chain is rendering
work. Taint is one bit, lives outside the body, and records nothing about which parent caused it.
Rendered today it produces a field of red nodes with no explanation. It is useful only once taint
provenance exists, which is the same missing primitive the containment application needs. Do it once
for both.

### Flows is mining, and its acceptance test already exists

[research-self-modeling.md](research-self-modeling.md) specifies signature mining: abstract completed
subgraphs to `(kind, agent)` sequences, group, count, score. Recurring shapes with occurrence counts,
success rates, durations and exemplars, with partial shapes ("starts often, rarely finishes") ranked
beside complete ones.

This is the emergent process documentation people keep asking for: the workflow diagram nobody wrote.
Its acceptance test is specified in that doc, which is that it recovers the pipeline example's shape
unprompted.

### "Who can see this record" is the inverse nobody asks for and everybody needs

The dry-run matcher answers who would *receive* a record. The inverse is which principals can
currently *read* it. `effectivePermissions` computes the per-principal side; running it the other way
is the question an operator asks before declassifying and an auditor asks afterward. For a substrate
whose selling point is per-record policy, it is the more important of the two.

### The LLM inspector needs the traps moved into the API, not documented

Freeform queries walk into every documented trap: oldest-first default limits, latest-wins
projections, and bounded reads treated as populations. Prose does not help, because the model reads
the response, not the doc. The fix is to put the answer where the mistake happens.

- **`explain` on a query.** Patterns are data, so the server can say "path not declared on this kind",
  "no `orderBy`, so this is the oldest N", "results hit the limit, so this is a page and not a
  population". This extends a convention that already shipped: query responses carry `scope` with
  `narrowedBy`, and the events endpoint carries `withheldNote`.
- **A space digest.** One grant-gated read returning what an investigator needs to orient: active
  kinds with indexed paths, capabilities, models, the interest registry, a grant summary, stats. It
  becomes the system prompt for any inspection agent, generated from records so it cannot drift.
- **High-level verbs for the compositions models get wrong**, such as `thread(recordId)` for the
  causally ordered story around a lineage root, and registry reads exposed as reads with the
  projection applied server-side.
- **Saved lenses as records.** A useful investigation query, saved with its description, discovered
  like a capability, retired by successor. The space accumulates its own inspection vocabulary and
  every investigator inherits every prior investigator's good questions.
- **Evidence-linked narrative.** Any generated answer about the space carries the record ids it rests
  on. This is the calibration principle applied to the inspector itself: a story about the space is a
  claim, and the linked records are the measurement.

## Constraints that stay true

These hold regardless of which features get built, and violating one is how an inspection feature
becomes a defect.

- **Every view is a read amplifier.** Route every new read through `Space.readAccess` and add a row
  to the table-driven guard in `conformance/http.test.ts`. A verb with no row is a verb nobody
  checked. Per-handler scoping leaked through lineage, graph, `take` and the artifact reads before
  anyone noticed.
- **A registry write must be able to revive.** Content-keyed writes need the `:after:<recordId>`
  idempotency suffix, or a re-declaration after a retirement replays the retirement and reports
  success while writing nothing. This applies to the interest registry and to saved lenses.
- **Registry reads page to exhaustion.** Use `readRegistry` and surface `complete: false`. The space
  digest is the worst possible place to reintroduce the bounded-read-as-population bug, because it is
  the most trusted artifact an inspector has.
- **Patterns match bodies only.** They cannot express taint or envelope state, so any filter over
  those needs the envelope selector as a separate input.
- **A watch per view leaks.** The watches map is never pruned and `Notifier` waiters accumulate.
  Inspection UIs are precisely the workload that opens many short-lived watches.
- **Never let an inspection feature declare topology.** The shape is mined, never asserted.

## Verified ground

Checked against `src/` rather than inherited. Recorded because one earlier draft carried a
prerequisite that did not exist, ranked its best feature last because of it, and nothing in the prose
revealed the error.

| Claim                                                              | Reality                                                                 |
|--------------------------------------------------------------------|-------------------------------------------------------------------------|
| `childrenOf` needs a reverse edge index built                       | Already indexed through `record_edges`, keyset-paged, backfilled under a conformance test |
| `matchesEvent` is the dry-run machinery                             | Watch-specific, fires only on `state === "available"`; use `compile` + `matchesRecord` |
| Watches leave a queryable trace                                     | In-memory only, die with the runtime, never pruned                      |
| Replay depth is durable                                             | Unbounded only because retention GC does not exist; `retention_until` is written and never consulted |
| Taint can be filtered or explained                                  | One bit, outside the body, no provenance recorded                       |
| `delegation_context` needs work before it can be shown              | Recorded and server-derived; rendering only                             |
