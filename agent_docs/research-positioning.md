# Positioning (research)

Thesis, evidence, prior art, and the defensible gap. Origin: outline §1. Mostly static;
update when the competitive landscape or evidence base changes.

## Contents
- Thesis
- Evidence (stated carefully)
- Prior art and the gap
  - The lineage, and what killed each generation
  - The Postgres-native contemporaries (DBOS, Marten/Wolverine)
  - The durable-execution incumbent (Temporal)
- Naming

## Thesis

Radia is a content-routed, policy-aware work and knowledge exchange for independently
implemented agents: durable and observable, with optional cost-aware admission control. It
is a coordination substrate, not an agent framework: model calls and agent logic stay outside
the runtime. Durability and observability are properties it has, not the pitch it leads with;
the differentiators are content-based routing and record-scoped policy (see the gap below).

## Evidence (stated carefully)

Recent experiments suggest blackboard-style coordination can improve success or token
efficiency on selected multi-agent reasoning and data-discovery workloads:

- Salemi et al. 2025: 13–57% relative improvement on three data-discovery benchmarks.
- Han & Zhang 2025: competitive performance at lower token cost on selected evals.

Encouraging and workload-specific, but not proof of general superiority. State it this way;
do not overclaim.

## Prior art and the gap

Prior art: JavaSpaces (pattern matching, read/take, leases, notifications,
transactions), GigaSpaces, LangGraph (durable execution, shared state). The full lineage, and the
reason its repeated failures are evidence FOR this design rather than against it, is below.

The defensible gap: **no prominent LLM-native runtime combines JSON content matching,
competitive leased claims, agent-scoped authorization, lineage, cost-aware activation,
and MCP integration behind a language-neutral protocol.** The distinction from graph
orchestrators is topology-free, content-based coordination rather than durability.

### The lineage, and what killed each generation

Two ancestries meet here, and neither is cited casually: the coordination verbs come from the
tuple-space line, the capability half from OSGi's service registry. Both are thirty-year-old ideas
with long production records and well-documented failure modes, and the failure modes are the
argument.

**The tuple-space line (Linda, 1985 → JavaSpaces → TSpaces, GigaSpaces, Klaim, Tupleware).**
Buravlev, De Nicola and Mezzina's survey (*Tuple Spaces Implementations and Their Efficiency*,
COORDINATION 2016) benchmarks nine of them and is the strongest single citation available here,
because it states the paradox in its own abstract: Linda is "intuitive, easy to understand and to
use" and simultaneously "the least used paradigm". Three findings transfer directly:

- **Matching quality decided everything, and nobody made it the database's problem.** The survey
  measured Klaim's local read at 10× Tupleware's and could only conjecture why; profiling stopped
  at the library boundary. Radia's equivalent regression (`read_one` 102 ms → 29 µs) was diagnosed
  with `EXPLAIN`, GIN indexes and planner statistics, because matching is SQL here. Of the nine
  systems only Grinda reached for real indexing, and it was the least maintained.
- **Security was absent.** Of nine systems, two had any access control at all (TSpaces
  permissions, Klaim's type-based access). The lineage treated it as an optional feature; here it
  is the product, and that single difference explains most of the architecture.
- **Code mobility was a selection criterion, and is now a liability.** The authors chose systems
  to study partly for it; LuaTS ships Lua to the server for "flexible search". "Patterns are data,
  not code" is a deliberate inversion, and a decade of security experience since sides against a
  search predicate that is code — far more so in a space shared by mutually untrusting agents.

Only GigaSpaces ever got fast, by partitioning on a routing field and colocating worker code inside
partitions. That is the road not taken: model calls stay outside the runtime by invariant, so
colocation is foreclosed, and one-space-one-Postgres forecloses partitioning. For fine-grained
compute, where coordination throughput IS the product, that ceiling was fatal. For agents whose work
units cost seconds of model latency, it is headroom.

**The capability half: OSGi (1999 → today).** The service registry is the most fully developed prior
art for content-scoped discovery: services registered with arbitrary properties, discovered by
LDAP-style filters, with the *whiteboard pattern* ("Listeners Considered Harmful") inverting listener
registration exactly the way `capability` records do. `ServiceTracker` is `agentLoop` with the
lifecycle race handled by hand; a bundle's departure is a `retired: true` successor. Three of its
outcomes are load-bearing here:

- **In-process trust boundaries did not hold.** OSGi tried seriously for two decades (per-bundle
  permissions, ConditionalPermissionAdmin, signed bundles); almost nobody deployed it, and Java's
  SecurityManager deprecation removed the foundation. The boundary that works is a process and a
  protocol with a mediator, which is where the runtime sits.
- **The registry did not survive the network.** Remote Services specified nearly this shape and
  never saw real adoption, because a model built on live references leaks over a network. Records
  instead of references is the fix: a provider's departure is an ordinary data condition.
- **It lost the mainstream to simpler things, not to better ones.** Resolver errors, classloader
  isolation and a compendium spec of thousands of pages did the damage; the systems that absorbed
  its ideas won by being startable in an afternoon. That is the same claim as the `npx radia dev`
  adoption thesis, and it is the reason surface discipline belongs beside the invariants rather
  than in a style guide.


**The adoption risk this lineage actually names.** Both ancestries were technically sound and both
lost to orchestration — Spring beat OSGi by offering the registry's benefits with the dynamism
removed; Declarative Services succeeded by hiding it; Temporal and DBOS thrive today on "write your
coordination as ordinary imperative code with a call stack". Choreography keeps losing not because
it is worse but because people think in narratives. **So the wager is specific and should be stated
as one: LLM agents may be the first population that does not carry the handicap** — an agent reads
the capabilities present now, matches on what is in front of it, and tolerates topology changing
between turns, which is what OSGi asked of humans and mostly did not get.

Two honest qualifications. First, models fail at it too, and `gotchas.md` is substantially a
catalogue of such incidents; but on inspection most are LEGIBILITY failures rather than cognitive
ones (a listing that returned a count where the question was "which files", a tool scoped tighter
than the grant that issued it, an erased payload that hung instead of explaining). Fabrication is
what fills a missing read path, so those are properties of the medium. Second, humans do not leave
the loop even if agents adapt: they still have to trust, debug and audit what emerged, which is why
[design-inspection.md](design-inspection.md) is aimed at the failure mode that actually killed the
predecessors.

And nothing forbids orchestration ON the substrate — the pipeline example's planner already is one.
OSGi's own history suggests that is not a betrayal of the model but the thing that makes it
survivable for people who cannot love it raw.

### The Postgres-native contemporaries (DBOS, Marten/Wolverine)

DBOS is the closest living relative: the same three bets (Postgres as sole arbiter, stateless
processes over it, durable facts at operation granularity rather than event-sourced history) and a
near-identical write budget per unit of work. Its published numbers are the best available evidence
for this architecture's ceiling — ~144K checkpoint writes/sec WAL-bound, and ~12.1K queued
workflows/sec where the bottleneck was **lock contention at the head of the queue**, the same wall
as a single-winner claim gate and as JavaSpaces' contended take. Three systems, three decades, one
invariant.

The divergence is trust topology, not performance. In DBOS every app process is a direct Postgres
client — one trust domain holding database credentials — and routing is static (function name, queue
name). Radia inserts exactly one server to create a boundary between many mutually untrusting
principals, and pays an HTTP hop plus authorization per operation for it. **DBOS is what this
architecture looks like with zero spent on trust and routing; those two cells are the entire
difference.** (The .NET analogue is Marten + Wolverine, which mirrors the storage philosophy —
Postgres jsonb documents, an append-only event store, projections — and likewise has neither content
routing nor a trust boundary.)

One caution against over-reading DBOS's numbers as this project's headroom: they come from a
saturation test on a tuned Postgres with app processes writing directly, while every operation here
additionally compiles a pattern, ranks candidates, authorizes, and appends an event behind an HTTP
hop. Same wall, same shape, unknown distance from it.

### The durable-execution incumbent (Temporal)

Temporal (and its Cadence-at-Uber lineage) is the incumbent for durable execution:
deterministic replay reconstructs in-process workflow state from a persisted event history,
side effects are quarantined into activities with retries/heartbeats/timeouts, and it ships
timers, cron, signals, queries, child workflows, and continue-as-new across many language SDKs
and a managed cloud. That is a decade of production hardening, actively marketed into agent
use cases (Series D at a ~$5B valuation, a16z, 2026). **Radia does not compete on durability,
and any pitch that leads with it invites "so why not just use Temporal, which my platform team
already runs."** Name the incumbent, and state precisely where the models don't overlap:

- **Content routing vs. addressed dispatch.** Temporal invokes an activity by type name on a
  named task queue; adding a capability edits the calling workflow, and its agent story puts
  the routing choice inside the model, where it can't be inspected or denied. Radia's patterns
  make dispatch a stored, queryable artifact: routing you can inspect, authorize, and refuse.
- **Record-scoped authority vs. namespace-scoped.** Temporal's security is mTLS + namespace
  isolation + a pluggable authorizer gating API calls; within a namespace a workflow may touch
  any activity on its queues, and payloads are opaque blobs with no per-record classification.
  Radia's taint LABELS (`file`/`net`/`foreign`, allowlisted per grant) and lease-derived
  `delegation_context` answer "may *this
  payload* reach *this step*", a question Temporal's architecture has no place to ask. This is
  Radia's design center, stated with the same care as the evidence above: real in design,
  early in maturity. Credentials and grants resolve from records per request, so authorization is
  NOT single-instance; the live limit is that `Space.put` authorizes only at the HTTP boundary, so
  an embedded host calling it directly writes past every grant. See
  [design-auth.md](design-auth.md), [gotchas.md](gotchas.md), and the claim ledger in
  [research-applications.md](research-applications.md) §8, which carries the current status.
- **Data plane vs. execution log.** Temporal caps payload/history size and tells you to keep
  large data out and pass references. The history is an execution log, not a knowledge store.
  Radia's records *are* the shared knowledge; "what does the system currently know about X" is
  a first-class content query, essentially unanswerable in Temporal without an external store.

**Compose, don't compete.** These stack: Temporal workflows whose activities are Radia
participants, or Radia as the exchange between workflows owned by teams that can't edit each
other's code. Temporal keeps the resumable in-process continuation Radia deliberately leaves
outside the runtime. That boundary is the composition seam, not a Radia deficiency. The
defensible sentence is "we are the classification and containment layer that durable-execution
engines don't have," not "a better Temporal." Composition also dissolves the adoption problem
(additive to an existing ecosystem, not dependent on a greenfield one).

## Naming

*Radia* honors Radia Perlman (Spanning Tree Protocol; announced as a poem, "Algorhyme").
In the tradition of Linda, the name is a lineage homage.

Naming actions (status from outline v0.3):

- npm `radia` claimed (verified free at decision time).
- PyPI bare name is occupied by an unrelated physics package, so the PyPI distribution is
  `radia-space` (import name `radia`).
- Trademark screen before public launch.
- Courtesy note to Perlman before any public use of the homage.
- Watch Radia Inc. (aerospace) for category drift.
