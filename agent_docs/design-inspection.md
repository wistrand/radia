# Inspecting emergent flows (design)

Why inspection is a distinct problem in a content-routed substrate, who needs it, and what shape
each mechanism has to take. Sequence and status live in
[plan-inspection.md](plan-inspection.md); this file holds the reasoning that outlives the backlog.

> **M1 status: built so far** are the interest registry and dry-run matcher (`INTEREST` in
> `src/core/kinds.ts`, `Space.matchingInterests`, `POST /v0/ops/dry-run`, published automatically by
> `agentLoop`), and the three inspector affordances: `explain` on query, `GET /v0/ops/digest`, and
> `GET /v0/ops/records/{id}/thread`. Everything else below is unbuilt. The console's Feed, Graph and Space views exist
> and work; the rest is what they cannot answer. Claims about current behavior were verified against
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

**Claim interest is a record.** The reserved `interest` kind carries `{kind, match?}`: what a run is
listening for, content-keyed so republishing writes nothing, withdrawn by a `retired: true`
successor. `agentLoop` publishes and retires it, so no agent author does anything.

Three properties are what make it safe rather than merely convenient:

- **Descriptive, never authorization.** Publishing an interest grants nothing; the grant records
  still decide what may be claimed. That is why the kind is not write-protected: a run publishes its
  own. The author is the server-assigned `created_by`, so the body never claims whose it is.
- **Liveness comes from the RUN.** A clean shutdown retires an interest, but a crash cannot, so
  `matchingInterests` drops any interest whose run has stopped. Never read the presence of the
  record as proof that anyone is listening.
- **One entry per (author, kind, pattern).** A worker listening for two patterns can withdraw one
  and keep the other.

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

It is a linear pass over the interests targeting that kind, O(interests on the kind). That is fine
while interests are per-worker. Never assume it holds if interests ever become per-record; it is not
the deferred inverted-index work.

`POST /v0/ops/dry-run` is operator-gated and deliberately absent from the self-scoped read
allowlist: it reports what every principal is listening for, which is the routing table rather than
a self-scoped fact. A principal reading its OWN interests uses an ordinary self-scoped query on the
kind.

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

### The taint overlay is now mostly rendering, like the delegation one

`delegation_context` is recorded and server-derived, so colouring the authority chain is rendering
work. Taint is now a closed set of labels rather than one bit (see
[design-taint.md](design-taint.md)), so an overlay can at least colour BY LABEL and say which
classification a record carries. It still records nothing about WHICH parent contributed one, and
that is deliberate: provenance is a lineage walk, cheap once and ruinous on the claim path.
Under the boolean it produced a field of red nodes with no explanation, and the labels remove most
of that: colouring by label distinguishes a file read from a network fetch, which is the question an
operator was actually asking. What remains unbuilt is the JOIN to the lineage graph — "which
ancestor introduced `net`" — and the labels make that a PRUNED walk rather than an unbounded one,
so it is cheaper than it was.

### Flows is mining, and its acceptance test already exists

**BUILT (2026-08-04):** `Space.flows` in `src/core/space.ts`, `GET /v0/ops/flows`, `radia flows`,
the chat's `space_flows`, and the console's Flows tab.

[research-self-modeling.md](research-self-modeling.md) specifies signature mining: abstract completed
subgraphs to `(kind, agent)` sequences, group, count, score. Recurring shapes with occurrence counts,
success rates, durations and exemplars, with partial shapes ("starts often, rarely finishes") ranked
beside complete ones.

This is the emergent process documentation people keep asking for: the workflow diagram nobody wrote.
Its acceptance test is specified in that doc, which is that it recovers the pipeline example's shape
unprompted; `conformance/flows.test.ts` is that test, and it passes.

**A HUB RECORD defeats the flow unit, and the cut has to be structural.** First run against a real
corpus (3905 records of accumulated chat history on Postgres) mined eleven conversation-rooted
shapes occurring exactly once each, up to 467 characters long, one of them 930 records spanning 26
hours. The cause is not granularity in the sense the two token knobs cover: a flow is a
weakly-connected component, and a long-lived `conversation` links every turn to every other, so one
component is a whole multi-day chat rather than a turn. [research-self-modeling.md](research-self-modeling.md)'s
own worked example is a TURN. The pipeline example has no hub, which is exactly why it looked
perfect and this did not.

**Fixed by cutting at hubs, and the test is REMOVAL, not degree.** Degree alone cannot tell a
conversation from a wide fan-out, because a job with twelve tasks is just as high-degree. What
separates them is that the tasks reconverge on a summary: delete the job and one piece remains,
delete the conversation and every turn falls apart. So a hub is a node whose removal leaves
`FLOW_HUB_PIECES` independent pieces, tested only on the widest few nodes of a component and only
above `hubDegree` children (a query parameter; `0` leaves every component whole, which is the
pre-fix behaviour and how the two are compared). The hub's own kind stays in the signature as
`conversation ⇒ …`, or the turns of a chat and the steps of a job would merge on the strength of
looking alike. **Never cap component size instead**: that hides a shape rather than decomposing it.

Measured on the same corpus, conversation-derived work: **11 shapes over 17 units, 1 recurring →
27 shapes over 290 units, 13 recurring covering 276 of them**, largest shape 930 records → 61. The
turn is now first-class: `conversation + llm_call ⇒ llm_call → llm_call + message + progress×2-3 →
llm_result + progress` at 104 occurrences, and the tool-call turn at 73.

What remains is a **successor CHAIN**, not a star: a `workspace` records each version with the
previous as parent, so consecutive turns stay linked through it. Three units out of 476, they are
genuinely causally connected, and a degree test cannot see a chain. Left alone deliberately.

Three things the build settled that the spec left open:

- **Fan-out is bucketed, and that IS the aggregation.** A four-word job and a five-word one are one
  flow only because `×4-7` covers both; exact counts file them apart and report every run as unique.
  Both stay reachable, because the bucket is a guess about which differences matter.
- **Depth comes free from the ids.** ULIDs are monotonic and minted by the space at commit, so a
  parent always sorts before its child and ascending id is a topological order. Signature depth is
  one pass over the sorted component, not a walk per node.
- **"Available" is not "unfinished".** A `claimable:false` kind (facts, summaries, the registries)
  sits available forever by design, so the outcome rule keys on the kind's claimability. Without
  that, every terminated pipeline in the space reports as still running.
- **A record linked to nothing is not a flow of one, and the real corpus is mostly those.** 1131 of
  1334 subgraphs were parentless registry writes, and listing them put `capability`×861 and
  `model`×215 above every actual shape. They are counted (`singletons`) rather than dropped, because
  that number is itself a finding about registry churn; they are just not an answer to "what does
  this space do".

### "Who can see this record" is the inverse nobody asks for and everybody needs

The dry-run matcher answers who would *receive* a record. The inverse is which principals can
currently *read* it. `effectivePermissions` computes the per-principal side; running it the other way
is the question an operator asks before declassifying and an auditor asks afterward. For a substrate
whose selling point is per-record policy, it is the more important of the two.

### The LLM inspector needs the traps moved into the API, not documented

Freeform queries walk into every documented trap: oldest-first default limits, latest-wins
projections, and bounded reads treated as populations. Prose does not help, because the model reads
the response, not the doc. The fix is to put the answer where the mistake happens.

- **`explain` on a query.** Opt-in, and it never changes the result. Every note answers a case where
  the request SUCCEEDED, which is why an error cannot carry the warning: a full page mistaken for a
  population, a default order that returns the OLDEST rows, a `claimable:false` kind whose records
  sit available by design, an undeclared kind, a match on an unindexed path. It extends a convention
  that already shipped, since query responses carry `scope` with `narrowedBy`.
- **A space digest.** One read returning kinds with their indexed paths and `claimable` flag, record
  counts, the interest registry, and the caller's own permissions. Generated from records so it
  cannot drift. Every registry read behind it pages to exhaustion and reports `complete: false`,
  because the artifact an inspector trusts most is the worst place to return a prefix. A scoped
  caller sees only its own interests: the full list is the routing table.
- **High-level verbs for the compositions models get wrong.** `thread(recordId)` walks UP to the
  lineage root and back down, which is the part callers get wrong by walking one direction, and it
  reports `truncated` rather than letting a partial story read as a whole one.
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
