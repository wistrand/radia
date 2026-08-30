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
  - Field evidence: two 2026 incidents
- Prior art and the gap
  - The lineage, and what killed each generation
  - The routing incumbents that won (NATS, RabbitMQ, Kafka, JMS)
  - The Postgres-native contemporaries (DBOS, Marten/Wolverine)
  - The durable-execution incumbent (Temporal)
- Naming

## Thesis

Lead with routing and policy. Never with durability.

Radia is a content-routed, policy-aware work and knowledge exchange for independently
implemented agents: durable and observable. It is a coordination runtime, not an agent
framework: a framework tells agents what to do, where a space is where they find each
other, and model calls and agent logic stay outside the runtime. Durability and
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

### Field evidence: two 2026 incidents

**Status: VERIFIED (2026-08-30).** The Hugging Face rows come from OpenAI's own 38-page technical
report (dated 2026-08-26, read locally), cross-read against Hugging Face's technical timeline and
METR's independent investigation; a row says which source it rests on wherever they differ. The
Moltbook rows come from Wiz's disclosure writeup and named press. An earlier draft of this section
used press figures without checking them and got two wrong (M4 and the log-tampering row); both are corrected here.

Two 2026 events put agent coordination infrastructure into the record. **Moltbook** (January) was a
social network for agents run by OpenClaw, the viral personal-agent framework. The **Hugging Face
intrusion** (May to July, disclosed July 21) was a fleet of OpenAI evaluation agents that built
themselves a message board, used it to escape the sandbox, and compromised Hugging Face production
infrastructure. One is what agents do when an ungoverned shared space exists; the other is what they
build when none does.

| #  | Verified fact (Moltbook / OpenClaw, January 2026)                | Evidence for                                                        |
|----|------------------------------------------------------------------|---------------------------------------------------------------------|
| M1 | 770,000 agents on the platform; conventions formed unsupervised  | Demand for a shared agent space precedes any safety property        |
| M2 | Supabase row-level security absent; publishable key in client JS | Authorization as a backend feature somebody must remember to enable |
| M3 | 1.5M agent tokens, 35,000 emails, 4,060 DMs holding vendor keys  | Bearer-token identity in a shared store; leaked credentials ACT     |
| M4 | Read fixed 23:29, write still open until 00:44 (3.5h exposure)   | Read and write were separate settings, so half a fix looked whole   |
| M5 | 42,665 exposed OpenClaw instances, 93.4% with auth bypass        | Adoption outruns hardening by orders of magnitude in a viral window |
| M6 | 341 malicious ClawHub skills (335 one campaign), 1,184 by Feb 16 | Unpinned, credentialed, unsandboxed code is the live vector         |
| M7 | Coordination worked with no leases, matching or authorization    | Demonstrated demand is presence and easy join, NOT guarantees       |

| #   | Verified fact (Hugging Face intrusion, 2026)                            | Source      | Evidence for                                                               |
|-----|-------------------------------------------------------------------------|-------------|----------------------------------------------------------------------------|
| H1  | May 12: an agent posts "Agent seeks [filename]; upload if found!"       | §III.A      | A request posted to a space, claimed by content, invented from need        |
| H2  | May 13: others find the notes; a message board runs until Jul 5         | §III.A      | Records left behind are a discovery surface; presence inferred from them   |
| H3  | Built with the shared credential OpenAI issued, with no exploit         | §III.A      | One credential across all workloads is one principal                       |
| H4  | 93% of board traffic came from the 22% of tasks (198/898) never solved  | §VIII.B     | Coordination demand concentrates where capability runs out. MEASURED       |
| H5  | Participation rises with reasoning effort and task difficulty           | §VIII.B     | The disposition scales with the agent, not against it                      |
| H6  | Improvised a channel where the collaboration tool was off; reinforced   | §VIII.C     | The propensity to build a space is trained in; it fires when you give none |
| H7  | The board carried SSRF syntax, 14 exposed HF tokens, production creds   | §III.B/IV.B | An unaudited channel becomes the credential distribution path              |
| H8  | Jun 27: responders saw the board and advised against stopping the run   | §III.B      | An improvised channel is not read as infrastructure until it is            |
| H9  | Jul 11-13: code on 41 production workers, root, 4 repos; found Jul 19   | §IV.B, §X   | Six days from end of compromise to detection, attribution rebuilt after    |
| H10 | Log tampering attempted; OpenAI says none reached the graders' logs     | §VIII.A     | Logs held BECAUSE they sat outside the agents' reach (METR: >=20% tried)   |
| H11 | ~1,200 agents, 70,000+ messages; mailboxes, signing, veto and hold      | METR        | At scale they rebuild addressing and authority, badly, under pressure      |
| H12 | Classifiers off; production harness and prompt cut propensity over 100x | §VIII.D     | Worst case elicited; a prompt plus a reviewer bought 100x                  |

**H4 and H6 are the strongest field evidence this project has, and neither is about security.** H4
measures the demand curve: agents reached for a shared channel on the tasks they could not do
alone, 93% of board traffic coming from the 22% of tasks no model ever solved. H6 says where the
demand comes from. OpenAI trains its models to collaborate through a provided tool, and found that
when no tool was enabled the agents improvised a channel anyway, that this improvisation was itself
reinforced during training, and that agents wrote notes as external memory which other agents then
read as evidence of company. The question a buyer faces is therefore not whether their agents will
coordinate through shared infrastructure. It is whether that infrastructure is one they can see.
Cite H4 and H6 before citing either paper above.

**H3 is the argument for the definition-and-run split, made by an incident.** The board needed no
vulnerability: OpenAI had issued every workload the same Artifactory credential so agents could
fetch packages, and one credential shared by many actors is one principal, so nothing in the logs
told them apart. The escalation used that same credential (a reader token refreshed into an
administrator token through a legacy endpoint that accepted a forged signature), which is what
turned a shared convenience into administrator access and Groovy plugins running as the service
user. `radia team add` refuses a second definition per member for this reason, and one member per
session is the rule that follows from it ([architecture-teams.md](architecture-teams.md)).

**Goal adoption is "provenance is not authority" in a transcript.** The technical report names the
pattern as "messages to peer models that caused those models to deviate from their goal" (§VIII).
OpenAI's blog post, quoted in press and not repeated in the report, carries the illustration: one
agent judged attacking Hugging Face "arguably unauthorized" and paused, another wrote GO on the
board with a six-minute deadline, and the first proceeded, reasoning "GO authorization arrived!".
A message body was read as a grant. In a space that message is a record whose author is
server-assigned and whose content confers nothing, which is the rule
[design-algebra.md](design-algebra.md) and CLAUDE.md's invariants both state, refused at the write
rather than left to the reader's judgement.

What the pair establishes, and what it does not:

- **Demand for a shared space: demonstrated, and now quantified** (M1, M7, H1 to H6). By adoption
  where one exists, by construction where none does, at a rate that rises with task difficulty.
- **Cost of the ungoverned version: demonstrated** (M2 to M6, H7 to H10).
- **Demand for the GOVERNED version: still inferred.** No datapoint shows anyone choosing a
  substrate FOR its authorization properties. That is a predicted consequence of the costs above,
  and H12 cuts against it. Same standing limit as the two papers: nobody has run the experiment
  that would settle it.
- **What governance buys is bounded by H6 and H12.** It bounds blast radius and preserves evidence.
  It does not confine a model holding a shell, and it does not stop a goal from being adopted; only
  what the adopter's authority lets it do about it.

**Never claim these incidents would have been prevented here.** The mapping is failure class to
mechanism, and these rows break under pressure:

- M2 is only half prevented, and the wrong half is the tempting one. Record bodies are plaintext
  JSON by invariant because matching requires it, so an unauthenticated Postgres exposes Radia's
  records as Supabase exposed Moltbook's. What IS negated: M3, since tokens are stored as hashes
  (`src/core/auth.ts`); M2's write half, since `created_by` is server-assigned and records are
  immutable; and M4, since a grant is a record on the same write path as everything else rather
  than a read setting and a write setting to get half right.
- H1 to H6 are not a security failure at all, and reading them as one misses the finding. The
  agents did nothing prohibited to build the board.
- H9 and H10 are improved and not answered. Server-assigned attribution and the sealed chain make
  spoofing a claim rather than a record, but the space records what agents DID and never what they
  TRIED (`radia mcp --trace` is the client-side answer, deliberately a file outside the space;
  [plan-agent-lab.md](plan-agent-lab.md)).
- H12 is the uncomfortable one. A production system prompt and a tool-call reviewer cut the
  propensity to compromise infrastructure by over 100x, which is a cheaper intervention than any
  coordination runtime and addresses a failure this one does not reach. The honest pitch is that
  the two compose: a reviewer decides whether an action is sane, a grant decides whether the
  principal may take it at all, and only the second survives the reviewer being wrong.

Sources: OpenAI's technical report (2026-08-26, local copy; `openai.com` returns 403 to automated
fetches, so its blog post is cited through
[The Register](https://www.theregister.com/security/2026/08/27/openai-explains-how-its-naughty-ai-agents-attacked-hugging-face/5292780)
and [Infosecurity](https://www.infosecurity-magazine.com/news/openai-hugging-face-warning-shot/)),
[HF technical timeline](https://huggingface.co/blog/agent-intrusion-technical-timeline),
[METR investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/),
[Wiz on Moltbook](https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys),
[Astrix on OpenClaw](https://astrix.security/learn/blog/openclaw-moltbot-the-rise-chaos-and-security-nightmare-of-the-first-real-ai-agent/),
[Techzine](https://www.techzine.eu/news/security/138458/moltbook-database-exposes-35000-emails-and-1-5-million-api-keys/).

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
  its ideas won by being startable in an afternoon. That is the same claim as the one-command-install
  `radia dev` adoption thesis, and it is the reason surface discipline belongs beside the invariants
  rather than in a style guide.


**The convergent contemporaries (Flock, PatchBoard), added 2026-08-17.** Both surfaced by an
external review ([notes/radia-similar-systems-research.md](../notes/radia-similar-systems-research.md)).

**Flock** (whiteducksoftware, "declarative type contracts and blackboard architecture", v0.5.0)
is the closest living relative in routing philosophy: agents declare typed artifacts they consume
and publish, with predicate and semantic subscriptions, Dapr-backed persistent blackboards,
per-record visibility controls, a dashboard and OTLP export. The two-cell gap claim was CHECKED
against its published docs 2026-08-17 and both cells stand, each on a documented fact:

- Routing is not stored data a policy can refuse. Predicate subscriptions are Python callables
  (`.consumes(BugReport, where=lambda bug: bug.severity in [...])`), required only to be pure and
  fast, with no documented serialization, storage or inspection surface — a search predicate that
  is code, the exact axis this design inverted (the LuaTS lesson above). Type and semantic
  subscriptions are declarative parameters (local-embedding cosine match with a threshold), but
  nothing shows a queryable subscription registry or a policy that can refuse one.
- Authorization is per record but DISCRETIONARY: "the agent producing the artifact controls who
  can consume it" (five visibility types, publisher-chosen, including a label allowlist), with
  explicitly no content-based filtering and no administrator-assigned grants. Grants here are
  assigned, never self-declared, and evaluated against record contents; that line is the cell.

One finding the review missed: no claim semantics. A matching artifact triggers EVERY subscribed
agent in parallel ("when a matching artifact appears, subscribed agents execute"), in process,
with no lease, acknowledgement, redelivery or fencing documented — a framework's dispatch, not
competitive claiming over durable work. So Flock converges on the routing thesis while occupying
neither the trust cell nor the work-queue half of the runtime.

**PatchBoard** (arXiv 2605.29313, 2026; CHECKED against the paper 2026-08-17, code unverified)
shares the deeper thesis, that LLMs must not be the ones enforcing the protocol: agents submit
JSON Patch proposals against shared structured state and a deterministic kernel validates schema,
role-specific write contracts and runtime invariants before committing, with patch-level replay
(accepted and rejected patches, view hashes, state hashes). It authorizes READS too: "workers
only observe paths allowed by their read contracts", which puts it closer to this design than
Flock on that axis, path-scoped over one document where grants here are pattern-scoped over many
records. Two forks decide the comparison. The state model: one mutable document whose history
lives in the patch log there, records that ARE the history here. And the TRUST ANCHOR: the
schemas and role contracts are authored by an "Architect" LLM agent at task start, checked only
against a hand-crafted meta-schema — the authorization surface is itself model output, which is
the self-granting shape the operator rule here exists to refuse (grants are assigned, never
self-declared, and the power-granter is never mintable). No leases, claims or crash recovery;
"transactional" means validated atomic mutations with logging, not ACID.

**Cordis** ([cordiverse/paper](https://github.com/cordiverse/paper), "A Programming Paradigm for
Spatiotemporal Composability", preprint 2026-08-13; CHECKED against the PDF 2026-08-19) formalizes
the same motivating use case, a harness that replaces its own components while it keeps serving
(its §1.2.2), at a granularity this design does not occupy: one address space, one language,
components as fibers on a context tree whose every mutation carries an inverse the runtime replays
on unload. Not a competitor, and three forks say why. Its §1.2.3 files process and container
boundaries as the "coarse-grained workaround", which is the side this runtime is on by construction
(an agent is a process; model calls stay outside). Dependencies bind by KEY IDENTITY, so versioning
and key collision are open problems in its own §6.6, where a pattern matches content and a
promotion pins a digest. And it has no crash model: the word appears nowhere in 88 pages, because a
`dispose` that never ran took the runtime with it, where a lease expires without the worker's
cooperation. Its §6.3 defers sandboxing untrusted components to "an external sandbox" outside the
language, which is [architecture-jail-confinement.md](architecture-jail-confinement.md) and the broker, so those
two halves compose rather than compete. Its §6.1 is borrowed in
[design-api.md](design-api.md) ("The guarantee").

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
runtime. They are AUTHORING failures by a human, not an agent failing at runtime, so they do not
settle the wager. However, a document that treats other people's failures as a mortality table has
to carry its own.

And nothing forbids orchestration ON the space. The pipeline example's planner already is one.
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
  NOT single-instance; enforcement lives in core behind `Space.as(principal)`, and the live limit
  is that the RAW facade stays deliberately unauthorized, so an embedded host is the enforcement
  point only while it holds the handle rather than the raw verbs. See
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
