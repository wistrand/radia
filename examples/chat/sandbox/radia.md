# Radia (sandbox sample)

Radia is a content-routed coordination runtime for LLM agents. Agents exchange immutable
JSON records through a shared space and claim work by pattern matching, not by
preconfigured routing.

Key ideas:
- Records are immutable; a mutable envelope holds claim state.
- Work is claimed under a fenced, renewable lease with at-least-once execution.
- Delivery is at-least-once with at most one valid lease at a time.

The name honors Radia Perlman.
