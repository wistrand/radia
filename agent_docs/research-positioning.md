# Positioning (research)

Thesis, evidence, prior art, and the defensible gap. Origin: outline §1. Mostly static;
update when the competitive landscape or evidence base changes.

## Contents
- Thesis
- Evidence (stated carefully)
- Prior art and the gap
- Naming

## Thesis

Radia is a content-routed, policy-aware work and knowledge exchange for independently
implemented agents — durable and observable, with optional cost-aware admission control. It
is a coordination substrate, not an agent framework: model calls and agent logic stay outside
the runtime. Durability and observability are properties it has, not the pitch it leads with;
the differentiators are content-based routing and record-scoped policy (see the gap below).

## Evidence (stated carefully)

Recent experiments suggest blackboard-style coordination can improve success or token
efficiency on selected multi-agent reasoning and data-discovery workloads:

- Salemi et al. 2025: 13–57% relative improvement on three data-discovery benchmarks.
- Han & Zhang 2025: competitive performance at lower token cost on selected evals.

Encouraging and workload-specific — not proof of general superiority. State it this way;
do not overclaim.

## Prior art and the gap

Prior art: JavaSpaces (template matching, read/take, leases, notifications,
transactions), GigaSpaces, LangGraph (durable execution, shared state).

The defensible gap: **no prominent LLM-native runtime combines JSON content matching,
competitive leased claims, agent-scoped authorization, lineage, cost-aware activation,
and MCP integration behind a language-neutral protocol.** The distinction from graph
orchestrators is topology-free, content-based coordination — not durability.

### The durable-execution incumbent (Temporal)

Temporal (and its Cadence-at-Uber lineage) is the incumbent for durable execution:
deterministic replay reconstructs in-process workflow state from a persisted event history,
side effects are quarantined into activities with retries/heartbeats/timeouts, and it ships
timers, cron, signals, queries, child workflows, and continue-as-new across many language SDKs
and a managed cloud. That is a decade of production hardening, now actively marketed into agent
use cases (Series D at a ~$5B valuation, a16z, 2026). **Radia does not compete on durability,
and any pitch that leads with it invites "so why not just use Temporal, which my platform team
already runs."** Name the incumbent, and state precisely where the models don't overlap:

- **Content routing vs. addressed dispatch.** Temporal invokes an activity by type name on a
  named task queue; adding a capability edits the calling workflow, and its agent story puts
  the routing choice inside the model, where it can't be inspected or denied. Radia's templates
  make dispatch a stored, queryable artifact — routing you can inspect, authorize, and refuse.
- **Record-scoped authority vs. namespace-scoped.** Temporal's security is mTLS + namespace
  isolation + a pluggable authorizer gating API calls; within a namespace a workflow may touch
  any activity on its queues, and payloads are opaque blobs with no per-record classification.
  Radia's `taint` / `requireUntainted` and lease-derived `delegation_context` answer "may *this
  payload* reach *this step*" — a question Temporal's architecture has no place to ask. This is
  Radia's design center, stated with the same care as the evidence above: real in design,
  early in maturity (enforcement today is HTTP-boundary-only and single-instance — see
  [design-auth.md](design-auth.md) and [gotchas.md](gotchas.md)).
- **Data plane vs. execution log.** Temporal caps payload/history size and tells you to keep
  large data out and pass references — the history is an execution log, not a knowledge store.
  Radia's records *are* the shared knowledge; "what does the system currently know about X" is
  a first-class content query, essentially unanswerable in Temporal without an external store.

**Compose, don't compete.** These stack: Temporal workflows whose activities are Radia
participants, or Radia as the exchange between workflows owned by teams that can't edit each
other's code. Temporal keeps the resumable in-process continuation Radia deliberately leaves
outside the runtime — that boundary is the composition seam, not a Radia deficiency. The
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
