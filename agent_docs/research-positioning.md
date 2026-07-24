# Positioning (research)

Thesis, evidence, prior art, and the defensible gap. Origin: outline §1. Mostly static;
update when the competitive landscape or evidence base changes.

## Contents
- Thesis
- Evidence (stated carefully)
- Prior art and the gap
- Naming

## Thesis

Radia is a durable, policy-aware, content-routed work and knowledge exchange for
independently implemented agents, with optional cost-aware admission control. It is a
coordination substrate, not an agent framework: model calls and agent logic stay outside
the runtime.

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
