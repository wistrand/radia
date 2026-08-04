# Positioning (research)

Thesis, evidence, prior art, and the defensible gap. Origin: outline §1. Mostly static;
update when the competitive landscape or evidence base changes.

> **State of the thing being positioned** (2026-08-04). All of M0 plus a growing M1 slice is built,
> on three storage backends behind a frozen wire contract that is checked in both directions. Every
> audit package is closed; no P0 or P1 is open, and what remains is a low-severity batch
> ([plan-audit-remediation.md](plan-audit-remediation.md)). It is not production ready, and there is
> no second user. Attach this to any pitch: it is the most checkable sentence here, so saying it
> costs less than being caught not saying it, and every other claim in this file spends the same
> credit. Getting it wrong in the modest direction spends it too.

## Contents
- Thesis
- Evidence (stated carefully)
- Prior art and the gap
  - The lineage, and what killed each generation
  - The routing incumbents that won (NATS, RabbitMQ, Kafka, JMS)
  - The Postgres-native contemporaries (DBOS, Marten/Wolverine)
  - The durable-execution incumbent (Temporal)
- Naming

## Thesis

Lead with routing and policy. Never with durability.

Radia is a content-routed, policy-aware work and knowledge exchange for independently
implemented agents: durable and observable. It is a coordination substrate, not an agent
framework, so model calls and agent logic stay outside the runtime. Durability and
observability are properties it has, not the pitch. The differentiators are content-based
routing and record-scoped policy (see the gap below).

The twenty-second version, both claims true today:

> Agent frameworks wire agent A to call agent B. Radia replaces the wiring with a shared
> space: agents post work, and whichever agent said it can handle that work claims it under a
> lease. Start a worker and the system gains a capability, with no code change anywhere else.
>
> Every task, fact and result is a record rather than a function call, so you can authorize
> one at a time: may this payload reach this step. Durable execution engines dispatch by
> function name and treat payloads as opaque, so they have nowhere to ask that question.

By listener. A platform engineer will say "why not Temporal, why not NATS", so answer with the
two cells and offer composition: their activities can be Radia participants. Security asks a
different question, and the answer is that when the model writes the plan the routing decision
moves inside the model where nobody can inspect or deny it; grants and labels move it back out.
An agent developer wants to know what they write: a handler and the pattern it claims, with the
lease, heartbeat and idempotency supplied.

What not to say: anything durability-first, which invites the Temporal comparison and loses it;
"blackboard architecture", which is correct and costs the room; "like Linda or JavaSpaces", true
lineage and the wrong signal, since those are remembered for not catching on; cost-aware
scheduling, which is unbuilt.

Cost-aware admission control used to appear in this sentence and has been removed from every
differentiator in this file. It is unbuilt (`effective_priority` is hardcoded `0` until the M3
scheduler), and an unbuilt cell in a list of differentiators makes the built ones read as claims
of the same kind.

## Evidence (stated carefully)

The strongest external result is not evidence for blackboards in general. It is evidence for the
one thing that differentiates this design, and it was being filed under the weaker claim.

**Salemi et al. 2025** ([arXiv:2510.01285](https://arxiv.org/abs/2510.01285)) builds a system in
which *a central agent posts requests to a shared blackboard, while subordinate agents volunteer to
respond according to their capabilities*, which *eliminates the need for the central coordinator to
possess detailed knowledge of each agent's expertise*. That is content-routed claiming by advertised
capability, which is this project's differentiator rather than its category, and the paper is the
closest thing to an independent test of it. Measured on three data-discovery benchmarks (KramaBench,
plus modified DSBench and DA-Code): **13–57% relative gains in end-to-end success, and up to 9%
relative improvement in data-discovery F1**, against strong baselines.

**Han & Zhang 2025** (bMAS): competitive performance at lower token cost on selected evals, beating
chain-of-thought and static multi-agent baselines while cutting tokens, and matching autonomous
dynamic ones.

Encouraging and workload-specific, not proof of general superiority. And the limit is worth stating
before someone else does: **two papers, neither run on Radia.**
[plan-validation.md](plan-validation.md) specifies the baselines that would produce the first
internal evidence; until one of them runs, the differentiator rests on other people's experiments on
other people's systems.

## Prior art and the gap

Prior art: JavaSpaces (pattern matching, read/take, leases, notifications,
transactions), GigaSpaces, LangGraph (durable execution, shared state). The full lineage, and the
reason its repeated failures are evidence FOR this design rather than against it, is below.

The defensible gap, stated as a SUBTRACTION rather than a conjunction: **take the nearest system in
each family and remove two cells, trust and routing, and what is left over is this.** DBOS is this
architecture with nothing spent on either (below). Temporal dispatches by function name and treats
payloads as opaque blobs. A broker routes by a key the publisher chose and authorizes a namespace.
Three different families, the same two things missing: routing that is stored data a policy can
refuse, and authorization at the granularity of one record.

The previous version of this sentence was a six-way feature conjunction, and it was defensible by
construction: add a seventh term and it stays true forever. It also listed cost-aware activation,
which is unbuilt, so the moat included a cell the project does not occupy. Two cells is weaker on
paper and worth more: it is true today, it is checkable against any named competitor, and it goes
false the moment somebody fills them.

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
  search predicate that is code, far more so in a space shared by mutually untrusting agents.

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
outcomes decided things here:

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
lost to orchestration. Spring beat OSGi by offering the registry's benefits with the dynamism
removed; Declarative Services succeeded by hiding it; Temporal and DBOS thrive today on "write your
coordination as ordinary imperative code with a call stack". Choreography keeps losing because
people think in narratives, not because it is worse. **So the wager is specific and should be stated
as one: LLM agents may be the first population that does not carry the handicap.** An agent reads
the capabilities present now, matches on what is in front of it, and tolerates topology changing
between turns. That is what OSGi asked of humans and mostly did not get.

Two honest qualifications. First, models fail at it too, and `gotchas.md` is substantially a
catalogue of such incidents; but on inspection most are LEGIBILITY failures rather than cognitive
ones (a listing that returned a count where the question was "which files", a tool scoped tighter
than the grant that issued it, an erased payload that hung instead of explaining). Fabrication is
what fills a missing read path, so those are properties of the medium. That inspection is a sample
of ONE application, written by the same person who drew the distinction from it. Second, humans do not leave
the loop even if agents adapt: they still have to trust, debug and audit what emerged, which is why
[design-inspection.md](design-inspection.md) is aimed at the failure mode that actually killed the
predecessors.

**What would settle it, and the evidence already on hand.**
[research-self-modeling.md](research-self-modeling.md) holds its own claim to "either the two halves
are in the same medium and joinable along lineage, or they are not"; a wager stated this plainly
deserves a falsifier of the same kind. Two observations would do it: **a second implementer who
builds a routing table anyway**, and **an application that needs a fifth entry on the list below.**

That list is the closest thing to relevant evidence this project has, and it points the wrong way.
[CLAUDE.md](../CLAUDE.md)'s "discover, don't hardcode" corollary records four hardcoding failures
that "all bit the chat example": a client branch encoding a decision that should have been delegated
(the model tier), a hard-coded tool list, a redeclared capability that 409s instead of superseding,
and tool usage taught in the system prompt. Every one was caught in review rather than by the
substrate. They are AUTHORING failures by a human, not an agent failing at runtime, so they do not
settle the wager. However, a document that treats other people's failures as a mortality table has
to carry its own.

And nothing forbids orchestration ON the substrate. The pipeline example's planner already is one.
OSGi's own history suggests that is not a betrayal of the model but the thing that makes it
survivable for people who cannot love it raw.

### The routing incumbents that won (NATS, RabbitMQ, Kafka, JMS)

The lineage above is a mortality table. This family is the opposite: NATS subject wildcards,
RabbitMQ topic and headers exchanges, JMS selectors, Kafka plus a stream processor. All route by
content in some sense, all are deployed everywhere, none of them lost. **"Why not a broker with a
topic exchange" is the first question a platform engineer asks, and it arrives before the Temporal
question.** It deserves four specific answers rather than a claim of novelty:

- **An ack destroys a message; here it emits a SUCCESSOR.** A broker delivers and the message is
  gone. `ack` writes a result record that is itself matchable, which is what lets fan-in work
  without the aggregator knowing its inputs, and what makes "what does the system currently know
  about X" a query instead of a replay. Nobody anticipates this one.
- **A subscription is not data.** Bindings live in broker configuration, so you cannot ask a broker
  who would receive a message before publishing it. Interests are records here, and
  `POST /v0/ops/dry-run` answers exactly that question against a draft.
- **An ACL scopes a namespace; a grant scopes a record.** A topic ACL cannot express "this agent may
  claim this payload but not that one". A pattern-scoped grant matching the body is precisely that.
- **Competitive claiming with fencing.** A queue gives at-most-one consumer. A lease gives one
  winner, a renewable hold, and a fenced epoch, so a slow worker's late write is refused rather than
  accepted after somebody else redid the work.

None of that makes a broker the wrong tool for transporting messages. It makes it the wrong tool for
a shared knowledge store that also has to authorize per payload, which is the only claim being made.
Brokers are also a composition target rather than a competitor: nothing stops a bridge writing
records from a subject or a topic.

### The Postgres-native contemporaries (DBOS, Marten/Wolverine)

DBOS is the closest living relative: the same three bets (Postgres as sole arbiter, stateless
processes over it, durable facts at operation granularity rather than event-sourced history) and a
near-identical write budget per unit of work. Its published numbers are the best available evidence
for this architecture's ceiling: ~144K checkpoint writes/sec WAL-bound, and ~12.1K queued
workflows/sec where the bottleneck was **lock contention at the head of the queue**, the same wall
as a single-winner claim gate and as JavaSpaces' contended take. Three systems, three decades, one
invariant.

The divergence is trust topology, not performance. In DBOS every app process is a direct Postgres
client (one trust domain holding database credentials), and routing is static (function name, queue
name). Radia inserts exactly one server to create a boundary between many mutually untrusting
principals, and pays an HTTP hop plus authorization per operation for it. **DBOS is what this
architecture looks like with zero spent on trust and routing; those two cells are the entire
difference.** (The .NET analogue is Marten + Wolverine, which mirrors the storage philosophy of
Postgres jsonb documents, an append-only event store and projections, and likewise has neither
content routing nor a trust boundary.)

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
