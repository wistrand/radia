# Radia

A durable, policy-aware, content-routed work and knowledge exchange for independently
implemented LLM agents, with optional cost-aware admission control.

Radia is a coordination substrate, not an agent framework. Agents post work and facts
to a shared space and claim work by describing what they can handle, rather than by
being wired to each other. Model calls and agent logic stay outside the runtime; Radia
owns durability, matching, leasing, authorization, lineage, and scheduling.

The name honors Radia Perlman, whose Spanning Tree Protocol showed independent nodes
building a shared structure with no central controller. In the tradition of Linda, it
is a lineage homage.

> Status: M0 kernel built (Phases 0–6) plus a growing M1 slice — put/take/ack/nack/release/renew,
> record+envelope split, fencing, idempotency, matching, transactional event log +
> lineage, dead-letter, and SSE watches, plus the **authorization stack**: kind- and
> template-scoped grants (as records), the run-token bootstrap chain, per-run leases with
> stop/quarantine, `delegation_context`, and `taint` + declassify — running on two storage
> adapters (embedded PGlite and SQLite) behind the frozen wire contract, with a web console
> and runnable agent examples (including a CLI chatbot that runs with real auth roles). Not
> production-ready. See `agent_docs/` for the structured design and
> [notes/radia-runtime-outline-v0.3.md](notes/radia-runtime-outline-v0.3.md) for the origin
> outline (v0.3).

## Why it exists

Multi-agent systems usually coordinate through preconfigured routing tables: agent A
knows to call agent B. That is brittle and topology-bound. Radia replaces it with
content-based coordination: an agent publishes a record (a task, a fact, a request),
and any agent whose registered template matches can claim it. Work flows by what it
is, not by who is wired to whom.

Recent experiments suggest blackboard-style coordination can improve success or token
efficiency on selected multi-agent reasoning and data-discovery workloads. The results
are encouraging and workload-specific, not proof of general superiority. See
[agent_docs/research-positioning.md](agent_docs/research-positioning.md).

## Core ideas

- **Content-routed:** JSON records matched by templates (a Mongo-inspired query
  language with its own strict semantics), not by explicit addressing.
- **Durable and leased:** work is claimed under a fenced, renewable lease with
  at-least-once execution; crashed agents don't lose work.
- **Policy-aware:** agent-scoped grants, provenance lineage, taint tracking, and an
  optional cost-aware scheduler decide what runs and what it may touch.
- **Language-neutral:** one HTTP + JSON protocol (OpenAPI-first) behind SDKs, an MCP
  adapter, and a CLI. Agents can be implemented in any stack.
- **Zero-setup start:** `npx radia dev` is intended to bring up a space, a web
  inspector, and a bundled MCP adapter in under a minute.

## Quick start

Requires [Deno](https://deno.com). No build step.

```bash
deno task dev          # embedded space + web console at http://localhost:7788
deno task demo         # a coordination demo (planner + workers + aggregator) against it
deno task chat         # a CLI LLM chatbot (needs OPENROUTER_API_KEY) — thinking and tools
                       # are both records; watch it in the console Feed tab
deno task conformance  # the storage-adapter contract suite (both adapters)
```

Storage is in-memory by default. To persist across restarts, pass `--db`:

```bash
deno task dev --storage sqlite --db ./.radia/radia.db   # SQLite file (WAL)
deno task dev --storage pglite --db ./.radia/radia-pg   # PGlite data directory
```

Records, envelopes, events, idempotency, and kind declarations all persist and reload on
restart. (Leases held by processes that crashed expire on their own clocks, as designed.)

Open the console and watch records and events stream through the **Feed** tab, use the
**Graph** tab to see how records relate (`parent_ids` DAG — a conversation's messages, a
job fanning out into tasks and back), and open a record for its body + lineage. See
[examples/README.md](examples/README.md) for the agents and the SDK.

The design target for distribution is `npx radia dev` / `pipx run` (a single wrapped
binary bundling the MCP adapter); that packaging is Phase 7.

## How it works

A record is immutable content; a separate runtime envelope holds its mutable claim
state (available, leased, consumed, dead-letter). Agents register templates; matching
routes records to interested agents. A `take` returns a fenced lease; the agent does
its work and `ack`s a result record, which itself becomes new content others can match.
Storage is Postgres (or embedded SQLite/PGlite for local dev) behind a single runtime
process that owns all concurrency guarantees.

For the full architecture, start with [CLAUDE.md](CLAUDE.md) and the design docs it
links.

## License

TBD.
