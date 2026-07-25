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

> Status: all of M0 built (Phases 0–7) plus a growing M1 slice — put/take/ack/nack/release/renew,
> record+envelope split, fencing, idempotency, matching, transactional event log +
> lineage, dead-letter, and SSE watches; the **authorization stack**: kind- and
> template-scoped grants (as records), the run-token bootstrap chain, per-run leases with
> stop/quarantine, `delegation_context`, and `taint` + declassify; and **artifacts** — a
> content-addressed blob port with `artifact` records, short-lived download capabilities, and
> optional encryption at rest (per-blob AES-GCM key wrapped under a space KEK). Running on three
> storage adapters (embedded PGlite and SQLite, plus real Postgres) behind the frozen wire
> contract, with a web console, TS and Python SDKs, a CLI, a bundled MCP adapter, and runnable
> agent examples (including a CLI chatbot with real auth roles, image generation, and code
> execution in a permissionless sandbox). Not production-ready.
> See `agent_docs/` for the structured design and
> [notes/radia-runtime-outline-v0.3.md](notes/radia-runtime-outline-v0.3.md) for the origin
> outline (v0.3).

```mermaid
flowchart LR
    A[agent A] -->|put record| S[(space)]
    S -->|matches B's template| B[agent B]
    B -->|take → fenced lease| S
    B -->|ack result| S
    S -->|matches C's template| C[agent C]
    S -.->|bytes too big for a body| BL[(blob store<br/>artifacts)]
```

Nobody addressed anyone. B claimed the work because it *described* what it can handle, and the
result B acked is itself a record C can match — so work flows by content, through one durable,
authorized, observable place.

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
- **Payload-aware:** anything too large for a JSON body (an image, an audio clip) is an
  **artifact** — a small record that routes, plus content-addressed bytes in a blob store,
  optionally encrypted at rest under a destroyable per-blob key.
- **Language-neutral:** one HTTP + JSON protocol (OpenAPI-first) behind SDKs, an MCP
  adapter, and a CLI. Agents can be implemented in any stack.
- **Zero-setup start:** `deno task dev` brings up a space, a web inspector, and a bundled
  MCP adapter in one process. The wrapped `npx radia dev` / `pipx run` packaging is built
  (`deno task release`) but not yet published to a registry.

## Quick start

Requires [Deno](https://deno.com). No build step.

```bash
deno task dev          # embedded space + web console at http://localhost:7788
deno task demo         # a coordination demo (planner + workers + aggregator) against it
deno task chat         # a CLI LLM chatbot (needs OPENROUTER_API_KEY) — thinking, tools, images
                       # and sandboxed code execution are all records; watch the Feed tab
deno task stress       # fill a space with waves of activity to watch in the Space tab
deno task conformance  # the port contract suites (storage adapters + the blob store)
```

Storage is in-memory by default. To persist across restarts, pass `--db`:

```bash
deno task dev --storage sqlite --db ./.radia/radia.db   # SQLite file (WAL)
deno task dev --storage pglite --db ./.radia/radia-pg   # PGlite data directory
```

Records, envelopes, events, idempotency, and kind declarations all persist and reload on
restart. (Leases held by processes that crashed expire on their own clocks, as designed.)

Artifact *bytes* live beside them, in a directory rather than the database — derived from `--db`,
or set explicitly with `--blobs <dir>` (which is what a Postgres deployment needs, since its
`--db` is a connection URL). Without one, blobs are in-memory and do not survive a restart.
Encryption at rest is opt-in: `--blob-kek <file>` (generated on first use) or `RADIA_BLOB_KEK`
(base64, 32 bytes). The startup line reports which you got — `blobs=file+aes-gcm (…)` versus
`blobs=memory (in-memory)`.

For a real Postgres (the multi-instance backend), the compose file under `docker/postgres/`
brings up a local server:

```bash
docker compose -f docker/postgres/compose.yaml up -d --wait   # persistent Postgres, waits until healthy
deno task dev:pg                                               # radia dev against postgres://radia:radia@localhost:5432/radia
```

Tables are created on first connect (no migration step). `docker compose down` keeps the data
(named volume); `down -v` wipes it.

The server binds loopback (`127.0.0.1`) by default — the no-header operator shortcut is only
safe locally. To expose it, pass `--host 0.0.0.0`, and harden with `--auth required` so every
request needs `Authorization: Bearer <run-token>` (no-header requests get `401`; the console at
`/` and `/v0/health` stay public, and the operator token is printed at startup for `curl`):

```bash
deno task dev --host 0.0.0.0 --auth required   # exposed + token-gated
```

Open the console and watch records and events stream through the **Feed** tab, use the
**Graph** tab to see how records relate (`parent_ids` DAG — a conversation's messages, a
job fanning out into tasks and back), the **Space** tab to see every record placed by what it
*is* rather than what it links to, and open a record for its body + lineage. See
[examples/README.md](examples/README.md) for the three examples — a keyless coordination
pipeline, a load generator, and the full LLM agent — each with its own directory and README.

### The CLI

`radia dev` provisions a real operator credential on startup (`$XDG_STATE_HOME/radia/credentials.json`,
`0600`), so every other command authenticates the same way a deployed client does — there is no
"no tokens locally" mode to grow out of. Override with `RADIA_TOKEN`, point elsewhere with
`RADIA_URL` or `--url`.

```bash
radia kinds                                   # declared kinds (a query for kind_def records)
radia put job '{"tag":"a"}'                   # write a record
radia query job --match '{"tag":"a"}'         # read by template
radia take job --lease 30 --json > claim.json # claim work
radia ack - --result-kind job_result --result '{"ok":true}' < claim.json
radia watch job                               # stream wakeups
radia doctor                                  # dead-letters, stuck leases, stale work
radia reclaim --all --drain                   # un-stick every expired lease
```

Every command goes through the public `/v0` API — the CLI has no privileged backdoor. The
list above is a taste; `radia help` prints the authoritative one.

### Joining from an MCP harness

`radia mcp` serves the space over stdio, so a model coordinates through it with no SDK:

```json
{ "mcpServers": { "radia": { "command": "radia", "args": ["mcp"] } } }
```

The adapter holds the credential and the fenced lease itself: `space_take` hands the model an
opaque `claimId`, and the lease is renewed at lease/3 in the background, so a model that spends
minutes thinking keeps its claim without ever seeing (or being able to leak) a token or a lease.
Kinds are discovered at runtime via `space_kinds` — nothing about your space is baked into the
tool list.

### Distribution

```bash
./scripts/build-release.sh          # per-OS binaries + staged npm and pip shim packages
./scripts/build-release.sh host     # just this machine, for a quick check
```

`deno compile` produces one self-contained binary (console and its vendored asset included);
the npm and pip packages are thin launchers that exec it, so `npx radia dev` and
`pipx run radia dev` need neither Deno nor a compile step.

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
