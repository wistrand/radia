# Technical Architecture Review: Radia

This is an **architecture-level review based on Radia’s published documentation and stated wire/storage model**, rather than a line-by-line source-code audit. Radia itself says the repository is authoritative and the site summarizes it. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

## Executive assessment

Radia has a genuinely coherent architecture. The design is not “agents plus a database”; it has a clear kernel:

```text
                     RADIA SPACE
              ┌───────────────────────┐
              │                       │
 producers ──►│ immutable records     │
              │                       │
              │ matching              │◄── interests
              │ authorization         │◄── grants
              │ leasing + fencing     │
              │ lineage               │
              │ event log             │
              │                       │
 workers ◄────│ competitive claims    │
              └──────────┬────────────┘
                         │
                     Postgres
                  SQLite / PGlite
```

Records have an immutable content half and mutable claim envelope; workers competitively claim records using data-only patterns; claims use renewable fenced leases; mutations and their event-log entries occur transactionally; results become records themselves. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

My assessment:

| Area | Assessment |
|---|---|
| Core abstraction | **Excellent** |
| Concurrency model | **Strong** |
| Authorization architecture | **Very strong** |
| Auditability / provenance | **Excellent** |
| Failure model | **Good, with one major caveat** |
| Routing model | **Strong but potentially expensive** |
| Data-model ergonomics | **Risky at scale** |
| Horizontal scaling | **Unproven** |
| Production operations / HA | **Incomplete** |
| Agent-code isolation | **Thoughtful** |
| Production maturity | **Early** |

The key distinction is:

> **I like the architecture considerably more than I trust its current production maturity.**

Radia itself currently describes the implementation as not production-ready, with unpublished npm/pip packaging and no second user. ([wistrand.github.io](https://wistrand.github.io/radia/))

---

# 1. The fundamental abstraction is sound

Most orchestration systems model computation:

```text
invoke(A)
  → invoke(B)
    → invoke(C)
```

Radia models **facts and work**:

```text
put(record)
     ↓
match(record, interests, permissions)
     ↓
take(record)
     ↓
produce(new_record)
```

That changes an important dependency.

In a conventional orchestration graph:

```text
producer depends on consumer identity
```

In Radia:

```text
producer depends on record schema
consumer depends on record schema
```

Neither needs the other's identity.

Radia explicitly removes destination, queue, and worker identifiers from records; workers describe the record shape they handle instead. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

I would classify this architecturally as a **durable tuple-space/blackboard-style coordination substrate with authorization and work-queue semantics**.

That is a strong abstraction for independently evolving capabilities.

### The resulting dependency structure is much healthier

Instead of:

```text
           ┌─ OCRAgent
Document ──┼─ PDFParser
           ├─ Extractor
           └─ Summarizer
```

where the caller knows all four, you get:

```text
                   ┌── OCRAgent
                   │
Document → SPACE ──┼── PDFParser
                   │
                   ├── Extractor
                   │
                   └── Summarizer
```

Adding the fifth capability does not require modifying the document producer. That is precisely the late-binding behavior Radia is designed around. ([wistrand.github.io](https://wistrand.github.io/radia/))

**Architecture verdict: keep this. It is the heart of the system.**

---

# 2. Separating immutable records from mutable envelopes is an excellent decision

The data model is essentially:

```text
Record
├── kind
├── body
├── parents
├── content hash
└── server metadata
       immutable

Envelope
├── available
├── leased
├── consumed
└── dead_letter
       mutable
```

Radia explicitly describes those as separate concepts. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

This is one of the best parts of the architecture.

It avoids turning application data itself into a distributed state machine.

A document isn't mutated:

```text
document.status = "processed"
document.summary = ...
```

Instead:

```text
document
    │
    └────► summary
               │
               └────► classification
```

This provides:

- natural provenance;
- deterministic historical inspection;
- causal lineage;
- fan-out;
- fan-in;
- easy auditing;
- fewer concurrency conflicts on application objects.

Radia also records mutations in an event log in the same transaction as the underlying change, avoiding the classic dual-write problem between operational state and audit state. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That is the correct transaction boundary.

---

# 3. But the append-only model creates a projection problem

This is one of the biggest architectural issues I would address.

Because records don't mutate, something like:

```text
current configuration
current conversation state
current workspace
current grant
current binding
```

is actually:

```text
derive current state from a set of records
```

Radia's documentation explicitly warns that “current” state is a view over history and says application bugs have arisen from reading the oldest match instead of the newest, or treating one result page as the complete population. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That is significant.

It means Radia has pushed some consistency complexity from:

```text
writes
```

into:

```text
reads
```

### I would not leave this primarily to application code.

I'd introduce first-class projection semantics.

For example:

```text
GET /records/latest
    ?kind=agent_binding
    &groupBy=agent
    &orderBy=version
```

or explicitly modeled projections:

```text
Projection<AgentBinding> {
    key: agent
    winner: max(created_at)
}
```

The server should guarantee:

- page completeness;
- deterministic winner semantics;
- stable cursors;
- snapshot consistency;
- explicit handling of withdrawal/tombstone records.

Otherwise every Radia application eventually implements a tiny, slightly different event projection engine.

**Priority: high.**

---

# 4. Competitive claims + fencing are the right concurrency primitive

The worker lifecycle is well designed:

```text
AVAILABLE
    │
    │ take
    ▼
LEASED
    │
    ├──── ack ────► CONSUMED
    │
    ├──── fail ───► AVAILABLE
    │
    └──── expiry ─► AVAILABLE
```

The critical part is fencing.

If worker A's lease expires:

```text
A gets fence=7

        lease expires

B gets fence=8
```

then A's eventual response using `7` is rejected. Radia explicitly describes this mechanism. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That's correct distributed-systems engineering.

Without fencing:

```text
slow worker
     +
retry worker
     =
last writer accidentally wins
```

With fencing:

```text
only current lease holder can commit
```

### Internal exactly-once-like commit semantics are achievable.

But external exactly-once effects are not.

And Radia correctly acknowledges that.

---

# 5. External side effects are the biggest correctness hole

Suppose a worker does:

```text
take(send_invoice_email)
       ↓
call SendGrid
       ↓
process crashes
       ↓
lease expires
       ↓
another worker takes record
       ↓
call SendGrid again
```

Fencing cannot undo:

```text
email already sent
```

Radia explicitly says this must be handled by the application. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That is technically correct, but for an agent coordination runtime I think it deserves a more opinionated architectural solution.

## I would add an Effect pattern

Rather than arbitrary agents directly performing irreversible effects:

```text
Agent
  ↓
external API
```

prefer:

```text
Agent
  ↓
effect_request record
  ↓
dedicated effect worker
  ↓
external service
  ↓
effect_result record
```

Give each request a stable idempotency key:

```text
idempotency_key = hash(effect_record_id)
```

For providers supporting idempotency:

```text
Stripe / payment API
            ↑
stable key ─┘
```

Retries become safe.

For providers that don't support idempotency, Radia can't manufacture exactly-once semantics—but concentrating those effects into audited workers makes the risk visible.

I would make this a **first-class recommended pattern**, possibly even an SDK abstraction.

---

# 6. Authorization is Radia's strongest architectural differentiator

This part is substantially better than most agent architectures.

Typical agent authorization looks like:

```text
model
 ↓
agent code
 ↓
if authorized:
    tool(data)
```

Radia moves the decision here:

```text
worker asks for data
        │
        ▼
 ┌─────────────┐
 │ RADIA SPACE │
 │             │
 │ identity    │
 │ grant       │
 │ pattern     │
 │ labels      │
 └──────┬──────┘
        │
     allowed?
       / \
     yes  no
```

The model never receives forbidden content.

Grants can restrict not merely a record kind but the contents of that particular record. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

For example:

```json
{
  "principal": "agent:summarizer",
  "kind": "document",
  "operations": ["take", "query"],
  "pattern": {
    "classification": "public"
  }
}
```

That is a substantially stronger security boundary than asking the summarizer to self-police.

### Very good separation

Radia also deliberately distinguishes:

```text
data lineage
    ≠
authority lineage
```

Reading privileged data does not grant the reader privileged authority. Delegated authority instead becomes the intersection of the worker's permissions and the caller's permissions. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

That's excellent.

A common capability-system mistake would be:

```text
record came from admin
        ↓
therefore child operation has admin authority
```

Radia specifically avoids that.

---

# 7. Taint propagation is promising, but three labels may eventually be too small

Radia currently propagates:

```text
file
net
foreign
```

through derived records; labels can be added but not removed by ordinary processes, and grants declare which labels they tolerate. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

This gives you a lightweight information-flow model:

```text
private file
    ↓
summary
    ↓
another transformation
    ↓
still carries "file"
```

That is exactly the sort of invariant agent systems need.

### But I would expect pressure to expand the lattice.

Real deployments will eventually ask for things like:

```text
customer:acme
pii
hipaa
export_controlled
internal
restricted
secret
source:github
source:internet
license:gpl
untrusted
```

Making labels completely arbitrary is dangerous because policies become impossible to reason about.

But fixing the universe forever at three may prove too restrictive.

I would consider:

```text
system labels
    file
    net
    foreign

application labels
    namespace + policy definition
```

with monotonic propagation rules still enforced by the server.

---

# 8. One security default worries me

The documentation says the model connected over MCP gets the **`observe` power by default**, which means it can inspect everything while being unable to modify anything. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

I would reverse that default in production.

Read access is the primary security concern in many agent environments.

```text
can't mutate secret
```

is much less important than:

```text
can't see secret
```

My preferred default would be:

```text
MCP model
    grants: none

explicitly grant:
    observe selected kinds/patterns
```

A global observability credential is excellent for an operator console.

It is an unusually broad default for an LLM-facing interface.

---

# 9. Pattern restrictions are excellent security architecture

Radia does **not** permit:

```javascript
record => arbitraryJavascript(record)
```

Patterns are data using a deliberately restricted matcher with operations such as equality, ranges, `$in`, `$exists`, `$any`, and `$or`. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

That's the correct call.

It produces three major benefits.

### Security

No user-supplied executable matcher runs inside your coordination server.

### Introspection

You can inspect:

```json
{
  "kind": "document",
  "match": {
    "type": "pdf"
  }
}
```

and understand what it means.

### Optimization

A database can theoretically translate restricted patterns into indexed queries.

Arbitrary predicates kill that possibility.

---

# 10. Declared routing fields are effectively Radia's schema language

Radia requires kinds to declare which fields may participate in matching, and rejects patterns using undeclared fields. The docs explicitly argue this is application architecture rather than mere index configuration. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

I agree.

For example:

```text
document
├── type              MATCHABLE
├── classification    MATCHABLE
├── customer          MATCHABLE
└── prose             opaque/encrypted
```

This determines:

```text
what agents can discover
+
what permissions can express
+
what queries can efficiently ask
```

### I would therefore formalize kind schemas much more aggressively.

I'd want:

```text
kind: document.v2

matchable:
  type: enum
  classification: enum
  customer: string

opaque:
  content: encrypted

compatibility:
  document.v1 -> document.v2
```

because once dozens of independently deployed workers consume those fields, renaming:

```text
customer
```

to:

```text
tenant
```

is a distributed schema migration.

Radia's late binding reduces code coupling while increasing **schema coupling**.

That's not a flaw, but it should be treated explicitly.

---

# 11. Routing performance is the area I would benchmark first

A claim conceptually has to do:

```text
incoming TAKE pattern
        ↓
find available candidates
        ↓
record matcher
        ↓
grant matcher
        ↓
candidate ranking
        ↓
lease acquisition
        ↓
fencing
        ↓
event append
        ↓
commit
```

Radia itself notes that its database-backed single-winner claim likely encounters the same contention wall as similar database queues, while Radia additionally performs matching, ranking, permission checks and logging. It explicitly says its own performance headroom is unknown because it has no Radia benchmark yet. ([wistrand.github.io](https://wistrand.github.io/radia/why.html))

### The dangerous workload isn't 10,000 unrelated jobs.

It's:

```text
500 workers
       ↓
all want
       ↓
kind=document,type=pdf
       ↓
one hot available set
```

That causes contention around candidate selection.

I would benchmark at least:

```text
1. many kinds / low contention
2. one kind / heavy contention
3. heavily overlapping patterns
4. non-overlapping patterns
5. thousands of grants per principal
6. thousands of live interests
7. long backlog
8. tiny empty backlog with many pollers
9. lease-expiry storm
10. dead-letter/retry storm
```

And measure:

```text
takes/sec
p50 / p95 / p99 claim latency
DB locks
rows examined per claim
authorization evaluation time
event-log amplification
CPU per claim
```

Before production adoption, these numbers matter more than model-call benchmarks.

---

# 12. The central-server boundary is good for correctness—but needs an HA story

The documentation says the runtime server owns coordination and clients talk to it over HTTP, so authorization, claims and fencing remain centralized rather than reimplemented in workers. It also describes Postgres as the backend to use for more than one instance. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

The architectural choice is good:

```text
       Worker A
          │
Worker B ─┼──► trusted coordination server
          │              │
       Worker C           ▼
                       Postgres
```

rather than:

```text
Worker A ──┐
Worker B ──┼──► Postgres
Worker C ──┘

every worker contains security logic
```

But there is a production question I would want answered precisely:

> **What are the semantics when multiple Radia server instances concurrently serve the same Postgres database?**

In particular:

```text
server A ──┐
           ├──► Postgres
server B ──┘
```

I would verify that:

- claim atomicity is DB-enforced;
- fencing sequences are DB-enforced;
- grant changes cannot race claims incorrectly;
- session/token revocation is immediately coherent across nodes;
- event ordering does not rely on process-local state;
- sealing/finality has a single-writer or distributed coordination mechanism.

The docs mention real Postgres concurrency testing and say bugs have already been found that embedded backends did not expose, which is encouraging. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

But **HA is an area where I'd insist on a source-level audit and failure-injection tests.**

---

# 13. Event log + causal lineage is excellent observability

This part is very well aligned with agent systems.

Rather than trying to reconstruct:

```text
why did the model do this?
```

from application logs, Radia has explicit causal records:

```text
user request
      ↓
model request
      ↓
tool call
      ↓
tool result
      ↓
model reply
```

Parents are first-class data, and mutation events are written transactionally. Radia can export these relationships into OpenTelemetry traces. ([wistrand.github.io](https://wistrand.github.io/radia/inspection.html))

I particularly like the distinction between:

```text
historical behavior → mined flows
```

and:

```text
current capability → live interests
```

A system that only has historical traces cannot answer:

> “What would happen if I posted this now?”

Radia's dry-run can evaluate live interests and authorization without writing the record. ([wistrand.github.io](https://wistrand.github.io/radia/inspection.html))

That's unusually useful.

---

# 14. Mined workflows are powerful but cannot replace intended invariants

Radia intentionally has no authoritative workflow graph; recurring flows are inferred from lineage after execution. ([wistrand.github.io](https://wistrand.github.io/radia/inspection.html))

That's fine for discovery:

```text
what normally happens?
```

But production systems also need:

```text
what must happen?
```

Imagine payments:

```text
order
  ↓
payment authorization
  ↓
inventory reservation
  ↓
shipment
```

If the observed graph suddenly becomes:

```text
order
  ↓
shipment
```

it's helpful that Radia will eventually show a new flow.

It would be better to reject or alarm on it.

### I would add optional non-routing flow contracts

Something like:

```yaml
expectation:
  when: order
  eventually:
    - payment_authorized
    - inventory_reserved
  before:
    shipment: payment_authorized
```

Crucially, this does **not** become orchestration.

It is an invariant/monitor:

```text
routing remains emergent
expected safety properties are declarative
```

That would complement Radia's philosophy rather than undermine it.

---

# 15. `doctor` is the right kind of operational abstraction

Radia distinguishes stale work where:

```text
orphaned
= no live interest matches
```

from:

```text
starving
= matching listener exists but isn't claiming
```

rather than reporting only “47 stuck jobs.” ([wistrand.github.io](https://wistrand.github.io/radia/inspection.html))

That's excellent operational design.

These demand completely different responses:

```text
ORPHANED
→ deploy capability / fix routing

STARVING
→ inspect worker health / permissions / capacity
```

This tells me the project is thinking about **operator questions**, not merely runtime primitives.

That's important.

---

# 16. Tamper-evident logging is useful but easy to oversell

Finalized events are chained cryptographically. Radia explicitly notes that an unsigned hash chain catches corruption or accidental modification but does not stop a determined database administrator from rewriting the history and recomputing the chain; signing with a key outside the database strengthens that guarantee. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That is exactly the correct threat-model statement.

I'd extend it with:

```text
seal signing key
      ↓
external KMS/HSM
      ↓
periodically publish signed head
      ↓
independent storage
```

For high-assurance deployments:

```text
Radia DB compromises
      ↓
attacker recomputes history
      ↓
cannot recreate previously published signed checkpoint
```

The checkpoint matters because even a signing key does little if the attacker eventually obtains it and there is no externally witnessed historical head.

---

# 17. Content-addressed artifacts are elegant, but deletion is nuanced

Large content lives outside records and is addressed by hash. Records preserve its hash and metadata even if the payload bytes are destroyed. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

That gives a nice property:

```text
delete 5GB file
    ↓
history still exists
lineage still exists
record ids still exist
```

But Radia correctly points out that this is unsuitable for short low-entropy secrets because someone can guess the original value, hash it, and determine whether it was the deleted content. ([wistrand.github.io](https://wistrand.github.io/radia/how-it-works.html))

For example:

```text
record says SHA256(secret)
```

If secret was:

```text
hunter2
```

the hash leaks confirmation.

### Operational implication

I'd classify artifact content into:

```text
high-entropy / large object
    → deletion reasonably effective

small secret / credential
    → encrypt first
      delete encryption key
```

Radia already describes the encryption-key-as-destroyable-payload approach for encrypted conversations. ([wistrand.github.io](https://wistrand.github.io/radia/examples.html))

That's the right design.

---

# 18. Workspaces show excellent layering discipline

Workspaces are deliberately **not a core Radia primitive**. They are represented as normal records plus artifacts and live in an extension/library layer. ([wistrand.github.io](https://wistrand.github.io/radia/workspaces.html))

This architecture:

```text
CORE
  record
  matcher
  claim
  grant
  artifact

EXTENSION
  workspace

APPLICATION
  coding agent
```

is preferable to:

```text
core
  record
  workflow
  filesystem
  git
  python
  javascript
  websites
  ...
```

Radia even enforces the dependency direction in its build/tests. ([wistrand.github.io](https://wistrand.github.io/radia/workspaces.html))

That is exactly how you prevent an infrastructure kernel from becoming an application framework.

---

# 19. Workspace promotion should bind the environment, not only the code

Radia has an interesting concept where production permissions can be pinned to a workspace tree digest, effectively making:

```text
deployment authorization
```

and:

```text
code authorization
```

the same decision. ([wistrand.github.io](https://wistrand.github.io/radia/workspaces.html))

I like this a lot.

But a source-tree digest does not completely define execution.

You also have:

```text
workspace digest
+
interpreter version
+
OS image
+
native libraries
+
package resolver
+
environment variables
+
sandbox implementation
=
actual program
```

So I would evolve:

```text
treeDigest
```

toward:

```text
executionDigest =
    hash(
        workspaceDigest,
        runtimeImageDigest,
        interpreterDigest,
        dependencyDigest,
        sandboxPolicyDigest
    )
```

Then:

```text
prod grant → executionDigest
```

not merely:

```text
prod grant → codeDigest
```

That gives materially stronger reproducibility and supply-chain attestation.

---

# 20. The sandbox design is thoughtful

The workspace runner deliberately separates:

```text
privileged host
       │
       │ limited protocol
       ▼
uncredentialed child
```

The executed code does not receive the Radia credential itself. The docs also describe capability probing rather than trusting a declared sandbox configuration and note a discovered Deno module-loading caveat that required a filesystem isolation layer underneath the language-level permission model. ([wistrand.github.io](https://wistrand.github.io/radia/workspaces.html))

Those are very good instincts.

In particular:

> Don't trust the sandbox because configuration says it is secure; actively test whether the claimed boundary holds.

For agent-generated code, that's exactly the correct posture.

---

# 21. The API/conformance strategy looks strong

The docs describe:

- a frozen wire contract;
- an OpenAPI specification;
- backend conformance tests;
- the same behavioral model over SQLite, PGlite and Postgres. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

That's a good portability architecture.

The server boundary means SDKs should remain relatively thin:

```text
Python SDK ───┐
TypeScript ───┼── HTTP contract ── Radia
CLI ──────────┤
Console ──────┤
MCP ──────────┘
```

The documentation explicitly says the CLI and other clients use the same public API rather than privileged internal routes. ([wistrand.github.io](https://wistrand.github.io/radia/))

That's excellent because:

```text
if CLI can do X
```

doesn't secretly mean:

```text
CLI knows internal implementation detail Y
```

---

# 22. Resource governance is conspicuously missing

Radia's authorization documentation explicitly says it currently has no spending limits. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

For LLM agents, authorization without resource governance is incomplete.

An agent could legitimately have permission to:

```text
take document
```

but then legitimately do it:

```text
1,000,000 times
```

and generate enormous compute/model costs.

I would eventually expect grants to support:

```text
rate
budget
concurrency
storage
token spend
CPU time
artifact bytes
```

For example:

```yaml
principal: agent:summarizer

limits:
  concurrent_claims: 10
  claims_per_minute: 100
  model_cost_per_hour: 20 USD
  artifact_storage: 5 GB
```

This is especially important because Radia turns deployment into capability discovery. A new badly behaved worker can create economic failure without violating traditional access control.

---

# 23. Multi-tenancy needs particularly aggressive testing

The authorization primitives appear capable of tenant isolation—for example, Radia describes grants scoped to record contents and “own records only” restrictions. ([wistrand.github.io](https://wistrand.github.io/radia/authorization.html))

But multi-tenant security failures are likely to occur in the interaction among:

```text
query pattern
∩
grant pattern
∩
delegated authority
∩
taint labels
∩
ownership
∩
operator powers
```

I would build property-based tests around this.

For every randomly generated combination:

```text
principal
grant
record
requested pattern
delegation
labels
```

assert:

```text
if server returns record:
    permission proof(record, principal) == true
```

The matcher/permission intersection code is one part I'd treat almost like cryptographic code:

**small, isolated, heavily fuzzed, and boring.**

---

# 24. The architecture needs explicit backpressure semantics

There are leases and retries, but large autonomous fleets also need to reason about demand.

Imagine:

```text
producer rate = 10,000 records/min
consumer rate = 2,000 records/min
```

A durable system correctly preserves the remaining 8,000.

But after an hour:

```text
backlog = 480,000
```

Durability has converted overload into storage.

I'd want first-class answers for:

```text
backlog per kind/pattern
oldest available age
claim latency
arrival rate
completion rate
retry rate
dead-letter rate
```

and potentially admission controls.

The existing `doctor`, live interests, event log and mined flows are a strong basis for this, but production environments will need SLO-oriented capacity metrics around them. ([wistrand.github.io](https://wistrand.github.io/radia/inspection.html))

---

# 25. My proposed production architecture

If I were deploying the underlying idea seriously, I would aim for:

```text
                      ┌──────────────┐
Human / Service ─────►│ API Gateway  │
                      └──────┬───────┘
                             │
                    ┌────────▼────────┐
                    │   Radia nodes   │
                    │                 │
                    │ auth            │
                    │ pattern planner │
                    │ leasing         │
                    │ fencing         │
                    └───────┬─────────┘
                            │
                      ┌─────▼─────┐
                      │ Postgres  │
                      │ primary   │
                      └─────┬─────┘
                            │
            ┌───────────────┴──────────────┐
            │                              │
      artifact store                  event export
       S3 / blob                        OTLP
            │                              │
        encryption                    observability
            │
            ▼
           KMS


Worker fleet
────────────

OCR       Summarizer      Tool Runner      Effect Worker
 │            │                │                 │
 └────────────┴──── Radia API ─┴─────────────────┘

Tool Runner:
    host process
         ↓
    sandbox/jail
         ↓
    NO Radia credentials

Effect Worker:
    stable idempotency keys
         ↓
    email/payment/etc.
```

And separate:

```text
seal signing key
      │
      ▼
external KMS
      │
      └── periodic external checkpoints
```

---

# 26. What I'd require before calling Radia production-ready

My priority order would be:

1. **Contention benchmarks.** Prove claim-path behavior under skewed, overlapping workloads.
2. **Multi-node failure testing.** Kill Radia servers, Postgres sessions and workers during every transaction boundary.
3. **Formalize HA semantics.** Document exactly what happens with multiple runtime servers against one database.
4. **First-class side-effect/idempotency pattern.** Do not leave every application to rediscover it.
5. **Projection/read abstractions.** Reduce “newest record / full result set / withdrawal” bugs.
6. **Authorization fuzzing and independent security audit.**
7. **Quotas and budgets.** Particularly model spend, rate, storage and concurrent work.
8. **Versioned kind/schema evolution.**
9. **Backup/restore and disaster-recovery tests**, including hash-chain integrity and external sealing keys.
10. **Production telemetry and SLOs** for backlog, claim latency, retries, permission denials and contention.
11. **Execution-environment pinning** in addition to workspace digest pinning.
12. **Change the MCP global-observe default** to explicit least-privilege access for non-operator deployments.

---

# Final verdict

I would **not redesign Radia around workflows, queues or direct agent calls**.

That would destroy the interesting part.

The core:

```text
immutable records
      +
content matching
      +
competitive fenced claims
      +
record-level authorization
      +
separate authority/data lineage
      +
transactional audit
```

is coherent and unusually well suited to an environment where mutually distrusting autonomous processes need to discover each other dynamically. ([wistrand.github.io](https://wistrand.github.io/radia/llms.txt))

The architecture's biggest weaknesses are around the consequences of that model:

```text
dynamic routing
    → query/matching contention

append-only data
    → projection complexity

at-least-once execution
    → unsafe external effects

emergent workflows
    → intended behavior isn't explicit

shared space
    → HA + multi-tenant security become critical

autonomous workers
    → resource governance becomes necessary
```

Those are **solvable engineering problems**, but they're exactly the problems I would concentrate on now rather than adding more agent-framework features.

My technical rating would be roughly **8.5/10 for the architecture concept, 5/10 for demonstrated production infrastructure, and 3/10 for current production maturity**. The gap between those scores is normal for a young infrastructure project—and, importantly, the foundation is strong enough that closing the gap looks worthwhile.
