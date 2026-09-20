# Radia, explained

An orientation for a reader who has never seen this repo. Figures are Unicode line art; read
them in a monospace context. Companions: [radia-auth-explained.md](radia-auth-explained.md),
[radia-implementation-explained.md](radia-implementation-explained.md).

Radia is a content-routed coordination runtime for agent systems. Participants do not call each
other. They put immutable JSON records into a shared space and claim work by describing what they
want, not by naming who should do it.

Nothing in the runtime knows what a model is. Model calls and agent logic stay outside it, and
`examples/market/` runs its scripted bidders with no model at all. LLM agents are the motivating
case because they can read a capability description and route on it at runtime, not a
requirement.

## 1. How routing works

```
┌───────────┐                                        ┌───────────┐
│  Agent A  │                                        │  Agent C  │
└─────┬─────┘                                        └─────┬─────┘
      │  put {kind:"task", lang:"sv"}                      ▴
      ▾                           matches {kind:"result"}  │
┌────────────────────────────────────────────────────────────────┐
│                           SPACE                                │
│   immutable records, each with one mutable envelope            │
└─────┬────────────────────────────────────────────────────┬─────┘
      │  take  (fenced lease, at-least-once)               ▴
      ▾                                       ack result   │
┌─────┴────────────────────────────────────────────────────┴─────┐
│  Agent B    claims by pattern {kind:"task", lang:"sv"}         │
└────────────────────────────────────────────────────────────────┘
```

A never addressed B. B stated a pattern it can handle and the space matched. The result B `ack`s
is itself a record, so C picks it up the same way. Adding a worker changes the graph without a
code edit elsewhere.

## 2. The two halves of a record

```
┌─────────────────────────────────────┬───────────────────────────────────┐
│ CONTENT: immutable, never rewritten │ ENVELOPE: the mutable half        │
├─────────────────────────────────────┼───────────────────────────────────┤
│ id, kind, body                      │ state: available, leased,         │
│ parent_ids  (data lineage ONLY)     │        consumed, dead_letter      │
│ created_by, created_at (server-set) │ lease_owner + lease_epoch (fence) │
│ taint: file | net | foreign         │ attempt, leased_until             │
│ bodySha256 -> the event seal chain  │ available_at (deferred claim)     │
└─────────────────────────────────────┴───────────────────────────────────┘
```

Nothing on the left is ever rewritten. An update is consume-plus-emit-successor. The split does
two things: `bodySha256` ties the content into the event seal chain, and clients can only submit
claims (`confidence`, `requested_priority`) while the runtime decides what they are worth.
`created_by`, `taint`, `delegation_context` and every lease field are server-assigned.

## 3. Claiming work

```
             take                 ack
 available ─────────▸ leased ─────────────▸ consumed
     ▴                  │                      │  emits
     │                  │                      ▾
     │                  │                  successor record, matched
     │                  │                  by someone else
     └─ nack or expiry ─┤
                        ▾
                  dead_letter
                  reached when attempt passes maxAttempts
```

At most one valid lease exists at a time, but delivery is at-least-once: after expiry a fenced
worker may still be running until it observes `lease_lost`. Side-effecting agents need idempotency
at the effect boundary. Idempotency is checked before lease validation, otherwise a retry of an
operation that already succeeded returns a false `lease_lost`.

## 4. Layers

```
┌──────────────────────────────────────────────────────────────┐
│ examples/       chat, analysis, mud, market, teams           │
├──────────────────────────────────────────────────────────────┤
│ extensions/     workspaces, git, teams, presence, OTLP       │
│                 imports the SDK, never src/                  │
├──────────────────────────────────────────────────────────────┤
│ sdk/ts, sdk/py  queryNewest / queryAll / queryPage, loops    │
├──────────────────────────────────────────────────────────────┤
│ src/surfaces/   CLI, MCP adapter; reach the space over /v0   │
│ src/ui/         the console, served by src/server/           │
╞══════════════════════════════════════════════════════════════╡
│ openapi/radia.yaml    THE FROZEN WIRE CONTRACT               │
╞══════════════════════════════════════════════════════════════╡
│ src/server/     routes, resolveAuth, the /v0/ops gate        │
├──────────────────────────────────────────────────────────────┤
│ src/core/       space.ts facade, grants, leases, seals       │
├──────────────────────────────────────────────────────────────┤
│ src/storage/    PGlite | SQLite | Postgres,  blob stores     │
└──────────────────────────────────────────────────────────────┘
```

Only the wire contract is frozen; the implementation behind it is not.
`test/openapi.test.ts` checks the spec against the router in both directions, and
`test/layering.test.ts` checks the dependency directions that matter in that stack: a surface
takes no value from `src/core`, `server` or `storage`, and `extensions/ts/` never imports `src/`.
It does not check `examples/`.

## 5. The organising principle

Features are expressed through the space rather than beside it. Kinds, grants, capabilities,
models and saved procedures are all records, discovered by query, not side tables or config files.
Adding a tool-worker gives an agent a new tool with no code change on either side.

The principle has a stopping rule. A record-shaped registry means current state is a projection
over an append-only log, so reads must page correctly. A read answers one of three questions, and
answering one with another's mechanism accounts for 27 recorded incidents, at least 3 of them
security.

| Question | Meaning            | Mechanism                                                 |
|----------|--------------------|------------------------------------------------------------|
| NARROW   | one current thing  | `readNewest`, O(1), correct wherever it applies              |
| EXHAUST  | the whole set      | `registry(kind)` reports `complete:false`; `queryAll` throws |
| PAGE     | display, or a walk | `queryPage`, returns a cursor carrying its own direction     |

Neither SDK has a bare `query(pattern, limit)`. It read the oldest matches while saying nothing
about that at the call site. `Space.query(pattern, limit)` still exists inside the runtime, and
`POST /v0/records/query` still takes a `limit`.
