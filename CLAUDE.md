Guidance for agents working in this repo. Read this first, then the relevant file in
`agent_docs/`.

## What this is

Radia is a content-routed coordination runtime for LLM agents. **M0 (Phases 0–6) plus a
growing M1 slice are built** — watches (SSE), and the **authorization stack**: kind- and
template-scoped grants (as records), the bootstrap chain + run tokens, per-run lease ownership
with stop/quarantine, `delegation_context`, and `taint` + declassify (Deno + TypeScript;
embedded PGlite and SQLite adapters; web console; runnable agent examples incl. a CLI LLM
chatbot that runs with real auth roles). The authoritative design lives in
`agent_docs/` (structured by topic) and originates from
[notes/radia-runtime-outline-v0.3.md](notes/radia-runtime-outline-v0.3.md), the v0.3
functional design outline. The `design-*` docs are spec + rationale; built ones carry an
"M0/M1 status" note pointing into `src/`. Build/run below; phase-by-phase status in
[agent_docs/plan-m0-implementation.md](agent_docs/plan-m0-implementation.md).

The runtime is a coordination substrate: agents exchange immutable JSON **records**
(tasks, facts, requests, results) through a shared space and claim work by **template
matching**, not by preconfigured routing. Each record has an immutable content half and
a mutable **runtime envelope** holding claim state. Work is claimed under a fenced,
renewable **lease** with at-least-once execution. Storage is Postgres (or embedded
SQLite/PGlite for local dev) behind a single runtime process that owns all concurrency
guarantees. Model calls and agent logic stay outside the runtime.

```mermaid
flowchart LR
    A[Agent A] -->|put record| S[(Space)]
    S -->|match template| B[Agent B]
    B -->|take, get fenced lease| S
    B -->|ack result record| S
    S -->|result matches| C[Agent C]
```

The result an agent `ack`s is itself a new record others can match, so work flows by
content, not by addressing.

## Layout

| Path                                    | Role                                                       |
|-----------------------------------------|------------------------------------------------------------|
| `deno.json`                             | tasks (`dev`/`check`/`conformance`/`compile`) + import map |
| `src/main.ts`                           | `radia` CLI entry; `radia dev` boots an embedded space + dev UI |
| `src/ui/index.html`                     | self-contained dev web console served at `GET /` (no build, public API only) |
| `src/server/`                           | HTTP surface: `http.ts` (`startServer`, routes, `resolveAuth` Bearer, ops-plane gate, operator-token injection), `problem.ts` (RFC 9457), `handlers/` (`records.ts` + authorize, `leases.ts`, `agents.ts` = bootstrap chain, `dev.ts` = ops plane: stats/events/lineage/graph/envelope-query/diagnostics/admin/declassify, `watches.ts` SSE) |
| `src/storage/`                          | `adapter.ts` (the `StorageAdapter` port: records/leases/idempotency/events/graph + compiled-match AST; kinds are records, not a port concern), `row.ts` (shared row/value mapping) + `pglite.ts`, `sqlite.ts` |
| `src/core/`                             | storage-agnostic logic: `space.ts` (service: put/take/settle, watches, lineage + graph, kinds-as-records, envelope query, `authorize`/grants, delegation, taint, bootstrap chain), `record.ts` (`buildRecord`, metadata split), `matching.ts` (compile + oracle + order + `combineMatch`), `kinds.ts` (indexing contract + `kind_def`/`grant`/`signal`/`agent_*` reserved kinds), `auth.ts` (`CredentialStore`, token mint/hash), `take.ts` (claim ranking), `notifier.ts` (watch wakeup), `time.ts`, `ids.ts`, `errors.ts` |
| `sdk/ts/`                               | TS SDK stub: `client.ts` (`RadiaClient` over `/v0`, incl. `watch()` SSE), `loop.ts` (`agentLoop`, event-driven, design §5) |
| `examples/`                             | demo agents + `demo.ts`, and `chat/` — a CLI LLM chatbot (full symmetry: llm + tool calls are records); see `examples/README.md` |
| `conformance/`                          | storage-adapter contract suite (`run.test.ts`, `harness.ts`) |
| `openapi/radia.yaml`                    | the frozen wire contract (source of truth)                 |
| `agent_docs/`                           | design deep dives, one topic per file (linked below)       |
| `notes/radia-runtime-outline-v0.3.md`   | origin design outline; provenance, not maintained doc      |

Build/run: `deno task dev` (no build step; `--db <path>` persists — SQLite file / PGlite
dir, in-memory otherwise), `deno task conformance` (both adapters), `deno task demo`
(end-to-end agent demo over HTTP), `deno task compile` (release binary). Implementation is
following
[agent_docs/plan-m0-implementation.md](agent_docs/plan-m0-implementation.md) phase by
phase; that plan's proposed layout is the map for code not yet written.

## Docs

Design docs (spec + rationale for subsystems not yet built):

- [agent_docs/design-data-model.md](agent_docs/design-data-model.md): records vs. runtime envelope, kinds, timing fields, provenance vs. authority, resource limits, artifacts (§2).
- [agent_docs/design-matching.md](agent_docs/design-matching.md): the template query language, its divergences from Mongo, per-kind indexing contract, semantic matching (§3).
- [agent_docs/design-api.md](agent_docs/design-api.md): delivery guarantee, leases + fencing, idempotency ordering, the ten operations, wire protocol, agent loop (§4–5).
- [agent_docs/design-scheduler.md](agent_docs/design-scheduler.md): optional cost-aware admission control, atomic admission-to-claim, server-computed priority (§6).
- [agent_docs/design-marketplace.md](agent_docs/design-marketplace.md): request/bid/award capability marketplace and durable timers (§7).
- [agent_docs/design-auth.md](agent_docs/design-auth.md): principals, grants, delegation, taint, revocation, budgets (§8).
- [agent_docs/design-observability.md](agent_docs/design-observability.md): event log, audit, re-execution, livelock detection, integrity and confidentiality architecture (§9).
- [agent_docs/design-storage.md](agent_docs/design-storage.md): Postgres mapping, deployment modes, distribution strategy (§10).

Research and planning:

- [agent_docs/research-positioning.md](agent_docs/research-positioning.md): thesis, evidence, prior art, the defensible gap (§1).
- [agent_docs/plan-milestones.md](agent_docs/plan-milestones.md): M0–M3 delivery plan, milestone scope (§11).
- [agent_docs/plan-m0-implementation.md](agent_docs/plan-m0-implementation.md): the buildable M0 plan — Deno + TS runtime, storage decisions, phase-by-phase build with verify steps.
- [agent_docs/plan-validation.md](agent_docs/plan-validation.md): baselines, metrics, fault-injection matrix (§12).
- [agent_docs/gotchas.md](agent_docs/gotchas.md): rejected approaches, the risk register, and non-obvious "why is it like this" decisions. Skim before proposing a change to signing, encryption, idempotency ordering, or storage backends.

## Design principle: express features through the substrate, not beside it

Before adding a bespoke endpoint, a hard-coded list, or out-of-band config, ask whether the
feature can be a **record, a query, or content-routed dispatch** — Radia's own primitives.
Radia is a coordination substrate; it should coordinate its *own* capabilities and
operations through itself (dogfooding). Symptoms of violating this: a growing flat API of
one-off endpoints, static tool/route tables, features that only the operator can reach
out-of-band. Four applications already made:

- **Kinds are records, not a side table.** A kind declaration is a `kind_def` record
  (body = the indexing contract), written via `put` and discovered by `query {kind:kind_def}`
  — no `kinds` table, no `/v0/kinds` endpoint. The registry is a cache/projection rebuilt from
  those records at startup; a redeclaration is a successor record (latest wins), not a mutation.
  One bootstrap: the `kind_def` meta-kind is defined in code so its own records can compile.
  See `src/core/kinds.ts` (`KIND_DEF`, `META_KIND_DEF`) and `Space.put`/`loadKinds`.
- **Observability/control is a coherent, grant-gated plane, not scattered endpoints.** The
  coordination verbs are frozen under `/v0/*`; observe-and-operate (stats, events,
  diagnostics, record + envelope introspection, remediation) lives under `/v0/ops/*`, one
  prefix that is also the (future) auth boundary. Push what *can* be a query onto a query:
  the envelope (runtime state) is queryable at `GET /v0/ops/records?state=…`, and diagnostics
  is a *composition* of those queries, not hand-rolled scans. What genuinely can't be a
  body-match query stays a derived capability by design — the content-routing query language
  matches record *bodies* (for routing), so aggregation (stats), DAG-traversal (lineage/graph),
  and get-by-id are legitimately first-class, not endpoints pretending to be queries.
- **Capabilities are records the substrate routes and the agent discovers.** Tool-workers
  publish `capability` records ({tool, schema}); an agent *watches/queries* them to build its
  tool list and dispatches by content (`tool_call{tool}` → whichever worker registered it) — no
  preconfigured routing table (§7). Add a worker → the agent gains the tool, no code change.
- **Grants are records the runtime reads, not a config table.** A kind-scoped grant is a
  reserved `grant` record ({principal, kind, operations}); a human/supervisor `put`s one and
  `Space.authorize` discovers it by `query`. Authorization state gets the same immutability,
  event-log visibility, and watchability as any record. `signal`/`grant` writes and `/v0/ops/*`
  are the grant-gated boundary — see [agent_docs/design-auth.md](agent_docs/design-auth.md).

## Invariants

Cross-cutting rules that must hold across the whole design. Subsystem-local invariants
live at the top of the relevant `agent_docs/` file, not here.

- **Records are immutable after commit.** No field is ever rewritten. A content
  "update" is consume-plus-emit-successor, never mutation. Only the runtime envelope
  (`record_runtime`) changes.
- **Client-submitted vs. runtime-authoritative metadata is a hard API split.** Clients
  submit *claims* (`confidence`, `requested_priority`); the runtime decides what they
  are worth. `created_by`, `delegation_context`, `created_at`, `schema_version`,
  `taint`, `effective_priority`, and all lease fields are server-assigned and never
  client-editable. See [agent_docs/design-data-model.md](agent_docs/design-data-model.md).
- **Provenance is not authority.** `parent_ids` is data/causality lineage only;
  `delegation_context` is the single authorization chain, server-derived from the
  claimed lease. Deriving data from a privileged record grants nothing. Never intersect
  authority across data parents.
- **Delivery is at-least-once with at most one valid lease at a time.** Physical
  execution may overlap after lease expiry (a fenced worker runs until it observes
  `lease_lost`). Side-effecting agents need idempotency at the effect boundary.
- **Idempotency is checked before lease validation.** Reordering these falsely returns
  `lease_lost` for an operation that already succeeded. See
  [agent_docs/design-api.md](agent_docs/design-api.md).
- **Templates are data, not code.** No `$regex`, `$where`, `$expr`, ever. The query
  language is analyzable and storable.
- **All time comparisons use the database clock.** Never a client or app-server clock.
- **Timing fields are never overloaded.** `available_at`, `claim_until`, `deadline_at`,
  `retention_until`, and `leased_until` are distinct concepts. Retention GC never
  discards a valid in-flight lease's completed work.
- **Grants are kind-scoped, never wildcard, and assigned, never self-declared.** Manifest
  capability claims are descriptive, not authorization. `signal` and grant management are
  writable only by `human:*` and one supervisor agent.
- **Taint clears only via privileged declassify.** Ordinary agents cannot write
  `taint: false`.
- **Embedded mode is never a semantically weaker cousin of Postgres.** The full
  conformance + fault-injection suite runs against every storage adapter in CI from day
  one. This is the only guard against storage-adapter drift.
- **The wire contract is what's frozen, not the implementation.** OpenAPI-first;
  implementation language and storage backend can change behind the stable protocol.
- **Minimal dependencies, maximal platform independence, zero or near-zero build steps.**
  When implementation starts: prefer the standard library and a small, audited dependency
  set over pulling in a framework; keep the code portable across OSes and runtimes rather
  than binding to platform specifics; and keep the build trivial (ideally run-from-source
  or a single bundling step). This is what keeps `npx radia dev` under a minute and lets
  the one server binary wrap for both npm and pip (see
  [agent_docs/design-storage.md](agent_docs/design-storage.md) "Distribution"). A new
  dependency or build step is a cost to justify, not a default.

## Doc lifecycle

Subsystem docs are `design-*` (spec + rationale). Built ones now open with an "M0/M1
status" note pointing into `src/`; **auth is substantially built (M1)** and its doc carries a
status note (OIDC, budgets, and the chain-intersection policy stay deferred). Still pure design:
scheduler (M3), marketplace (M2). Full rename to `architecture-*` is deferred to avoid link
churn — the status note + source pointers serve the same purpose for now. `plan-*` docs
track milestone progress; `plan-m0-implementation.md` is the phase-by-phase record.

## Conventions

- No implementation in this pass. Design docs only until the milestone plan says
  otherwise.
- When code exists, docs point into the source: file path plus key symbol, not restated
  logic. Code wins over docs on any conflict about current behavior; fix the doc.
- Update the relevant doc in the same change that alters a design decision. After a
  large or cross-cutting change, ask the agent to "update the docs" for a reconciliation
  pass.
- Keep this file the routing entry point. Move subsystem detail into `agent_docs/` and
  link it.

## Documentation Style

- Markdown links for docs an agent should follow; backticks for source paths and inline
  code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just X but
  Y"). No emojis in project copy. State the point directly.
- Concise; assume a competent agent. Add only what it can't infer: names, rules,
  constraints, and the why. Cut explanations of general concepts.
- State each rule on its own line as always/never; a rule buried mid-paragraph gets
  skipped.
- Mark inferred claims and open questions; don't present a guess as a fact.
