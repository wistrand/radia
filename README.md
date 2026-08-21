# Radia

Radia is a content-routed coordination runtime for agent systems. Participants publish immutable
JSON records to a shared space. Workers declare patterns and claim matching records under fenced,
renewable leases. Results return as new records that downstream workers can match.

The runtime provides durability, matching, authorization, lineage and artifact storage. Model
calls and application logic remain in external workers. Grants can restrict operations by record
kind and content, allowing the payload to participate in the authorization decision.

The name is a homage to Radia Perlman's work. Her Spanning Tree Protocol showed independent nodes
building a shared structure with no central controller. In the tradition of Linda, the name marks
that conceptual lineage. Radia Perlman is not affiliated with or an endorser of this project.

> **Status:** The coordination kernel, authorization stack, event chain, flow mining, resource
> limits, three storage adapters, web console, CLI, MCP adapter and TypeScript/Python SDKs are
> implemented. Radia is not production-ready, the packages are unpublished and the project has no
> independent adoption. See [the milestone plan](agent_docs/plan-milestones.md) for implemented and
> remaining work and [the audit record](agent_docs/plan-audit-remediation.md) for known security
> boundaries.

```mermaid
flowchart LR
    A[agent A] -->|put record| S[(space)]
    S -->|matches B's pattern| B[agent B]
    B -->|take → fenced lease| S
    B -->|ack result| S
    S -->|matches C's pattern| C[agent C]
    S -.->|bytes too big for a body| BL[(blob store<br/>artifacts)]
```

Agent B claims the record because its pattern matches. Its result is another record that agent C
can match. No participant names the next worker.

## When to use Radia

Radia is intended for systems where participants are deployed independently, discover work by
description or require different credentials and trust boundaries. Starting a worker adds the
patterns it serves without changing publishers.

For a fixed in-process workflow, a direct function call or agent framework is simpler. For durable
workflow execution and timers, use a workflow engine. Recent blackboard-style coordination studies
are workload-specific and do not establish general superiority. See
[agent_docs/research-positioning.md](agent_docs/research-positioning.md).

## Core ideas

- **Content-routed:** workers claim JSON records through a bounded pattern language.
- **Durable and leased:** work is claimed under a fenced, renewable lease with
  at-least-once execution; crashed agents don't lose work.
- **Policy-aware:** kind- and pattern-scoped grants, delegation and data-handling labels constrain
  each operation.
- **Payload-aware:** anything too large for a JSON body (an image, an audio clip) is an
  **artifact**: a small record that routes, plus content-addressed bytes in a blob store,
  optionally encrypted at rest under a destroyable per-blob key.
- **Language-neutral:** one HTTP + JSON protocol (OpenAPI-first) behind SDKs, an MCP
  adapter, and a CLI. Agents can be implemented in any stack.
- **Embedded-first:** `deno task dev` starts an in-memory space and web console without a build
  step. SQLite, PGlite and PostgreSQL adapters share one storage contract.

## Quick start

Requires [Deno](https://deno.com). No build step.

```bash
deno task dev               # embedded space + web console at http://127.0.0.1:7788
deno task demo              # a coordination demo (planner + workers + aggregator) against it
deno task chat              # a CLI LLM chatbot (needs OPENROUTER_API_KEY): thinking, tools, images
                            # and sandboxed code execution are all records; watch the Feed tab
deno task stress            # fill a space with waves of activity to watch in the Space tab
deno task test              # check + every test below
deno task test:runtime      # everything under test/, incl. the port contract suites
deno task test:conformance  # the port contract alone (storage adapters + the blob store)
deno task test:extensions   # the extension contract (workspace manifests, tree digests, path safety)
deno task bench             # throughput, latency percentiles, scaling curves; see bench/README.md
```

**The `radia` command.** Examples below use `radia <verb>` for the CLI. Nothing installs it for you,
so pick one:

```bash
deno run -A src/main.ts <verb>   # from source, no build (what the tasks above do)
deno task compile                # → ./radia, a self-contained binary; then ./radia <verb>
```

Putting the compiled binary on your `PATH` makes the examples read literally. The `npx radia` /
`pipx run radia` packaging is built by `deno task release` but is **not published**, so neither
works today.

Storage is in-memory by default. To persist across restarts, pass `--db`:

```bash
deno task dev --db                                  # persist under ./.radia
deno task dev --storage sqlite --db ./elsewhere.db  # or name the place yourself
```

**Everything a space writes goes in one directory, `./.radia`.** The database, the artifact blobs,
the space KEK and the event-chain signing key, so that directory is the whole on-disk footprint and
deleting it is a clean reset. `RADIA_DIR` moves it. (Not to be confused with `~/.radia/credentials.json`, which belongs to
you rather than to a project and is shared by every space you run.)

Records, envelopes, events, idempotency, and kind declarations all persist and reload on
restart. (Leases held by processes that crashed expire on their own clocks, as designed.)

Artifact *bytes* live beside them, in a directory rather than the database: `<db>-blobs` by
default, or `--blobs <dir>` explicitly (which is what a Postgres deployment needs, since its `--db`
is a connection URL). Without one, blobs are in-memory and do not survive a restart.
Encryption at rest is opt-in: `--blob-kek` (generated at `.radia/kek.json` on first use), a path of
your own, or `RADIA_BLOB_KEK` (base64, 32 bytes). The key is kept beside the blob directory rather
than inside it, so copying the blobs alone does not carry it along. The startup line reports which
you got: `blobs=file+aes-gcm (…)` versus `blobs=memory (in-memory)`.

For a real Postgres (the multi-instance backend), the compose file under `docker/postgres/`
brings up a local server:

```bash
docker compose -f docker/postgres/compose.yaml up -d --wait   # persistent Postgres, waits until healthy
deno task dev:pg                                               # radia dev against postgres://radia:radia@localhost:5432/radia
```

Tables are created on first connect (no migration step). `docker compose down` keeps the data
(named volume); `down -v` wipes it.

**Auth is required by default.** Every request needs `Authorization: Bearer <token>`; without one
it is `401`. `GET /` (the console) and `GET /v0/health` stay public so the console can bootstrap and
a client can tell "no space here" from "not allowed". `radia dev` prints an operator token at
startup and writes it to your credential file, so the CLI and the bundled examples authenticate
with no extra step. It also provisions a revocable OBSERVER credential (read-only ops access),
which `radia mcp` and the CLI's read-only verbs use by default: a model plugged in over MCP can
inspect the space and cannot write grants, coordinate ungranted, or destroy anything.

The server also binds loopback (`127.0.0.1`) by default. To expose it, pass `--host 0.0.0.0`.

```bash
deno task dev --auth open   # a header-less request is the OPERATOR: local throwaways and curl
```

`--auth open` exists because it is convenient, and it is a real hole: it resolves a credential-less
request to `human:local`, which authorizes every verb. Nothing radia ships depends on it.

Open the console and watch records and events stream through the **Feed** tab, use the
**Graph** tab to see how records relate (`parent_ids` DAG: a conversation's messages, a
job fanning out into tasks and back), the **Space** tab to see every record placed by what it
*is* rather than what it links to, the **Flows** tab for the recurring shapes of work mined out of
that lineage (nothing declares them), and open a record for its body + lineage. The view lives in
the URL, so any of it is a link you can send. The **Auth** tab
shows the bootstrap chain and, as an operator, mints a session for a person; paste any session
token into the principal pill to see the space as they see it. See
[examples/README.md](examples/README.md) for the three examples (a keyless coordination
pipeline, a load generator, and the full LLM agent), each with its own directory and README.

### The CLI

Every verb below is `radia <verb>`, which means the compiled binary or `deno run -A src/main.ts
<verb>` from a checkout (see Quick start).

`radia dev` provisions a real operator credential on startup (`$XDG_STATE_HOME/radia/credentials.json`,
`0600`), so every other command authenticates the same way a deployed client does. There is no
"no tokens locally" mode to grow out of. Override with `RADIA_TOKEN`, point elsewhere with
`RADIA_URL` or `--url`.

That credential is the space's own. For a person, `radia login human:alice [--grant kind:op,op]`
mints an ordinary scoped session through the same bootstrap chain an agent uses, and
`radia permissions human:alice` says what it can actually do. A `human:` name carries no privilege;
only the space's named operators have that.

**You log in once.** A run token lives 15 minutes and cannot be renewed by anything that is not
awake to renew it. A command you just typed is not, and neither is a tool that stores a password
in a config file. So `radia login` also keeps the
DURABLE half of the chain: a definition token, which cannot read or write anything (the space
refuses it for coordination) and can only mint a session. Clients hold both and exchange the first
for the second whenever it lapses, so nothing asks you to re-authenticate until
`radia revoke human:alice`, which is the only thing that stops it.

```bash
radia kinds                                   # declared kinds (a query for kind_def records)
radia put job '{"tag":"a"}'                   # write a record
radia query job --match '{"tag":"a"}'         # read by pattern
radia take job --lease 30 --json > claim.json # claim work
radia ack - --result-kind job_result --result '{"ok":true}' < claim.json
radia watch job                               # stream wakeups
radia doctor                                  # dead-letters, stuck leases, stale work (orphaned vs starving)
radia flows                                   # the recurring shapes of work, mined from lineage
radia integrity                               # verify the event chain, naming the first divergence
radia reclaim --all --drain                   # un-stick every expired lease
radia login human:alice --grant job:query     # a scoped session for a person
radia login human:alice --compact            # the token alone, for TOK=$(…)
radia permissions human:alice                 # what that principal can actually do
radia revoke human:alice                      # kill the durable credential; nothing else does
radia workspaces                              # multi-file trees, newest version of each
radia workspace-git site --dir /tmp/site.git  # a tree's history as a real git repository
radia git-serve                               # …the same, over HTTP, for `git clone`
```

Every command goes through the public `/v0` API; the CLI has no privileged backdoor. The
list above is a taste; `radia help` prints the authoritative one.

### Working trees, and git

An agent that writes code needs somewhere to put it. A **workspace** is a multi-file tree built out
of primitives that already existed: one manifest record listing paths, one artifact per file, and a
latest-wins projection over the versions. The runtime learns nothing from any of it: it has no idea
what a file or a path is. So this lives in [`extensions/`](extensions/README.md) beside the sandbox
records that say what a jail actually guarantees.

Trees can be materialised into a jail, written back as a new version, forked visibly when two
writers share a base, served to a browser over one short-lived link, and handed to git:

```bash
radia workspace-git site --dir /tmp/site.git   # a bare repo; `git clone` it
radia git-serve                                # …or serve every tree for `git clone` over HTTP
```

Export only, in both directions of that sentence: git is a projection of the records rather than
their storage, and `git push` is refused with the reason. What that buys over git is per-file
erasure without a rewritten history, every version attributable to a run, and grants that scope
which tree an agent may touch at all. See
[agent_docs/design-workspaces.md](agent_docs/design-workspaces.md).

### Joining from an MCP harness

`radia mcp` serves the space over stdio, so a model coordinates through it with no SDK:

```json
{ "mcpServers": { "radia": { "command": "radia", "args": ["mcp"] } } }
```

The adapter holds the credential and the fenced lease itself: `space_take` hands the model an
opaque `claimId`, and the lease is renewed at lease/3 in the background, so a model that spends
minutes thinking keeps its claim without ever seeing (or being able to leak) a token or a lease.
Kinds are discovered at runtime via `space_kinds`, so nothing about your space is baked into
the tool list.

### Distribution

```bash
./scripts/build-release.sh          # per-OS binaries + staged npm and pip shim packages
./scripts/build-release.sh host     # just this machine, for a quick check
```

`deno compile` produces one self-contained binary (console and its vendored asset included); the npm
and pip packages are thin launchers that exec it, so once published `npx radia dev` and
`pipx run radia dev` will need neither Deno nor a compile step. Nothing is on npm or PyPI yet, and
neither launcher has been run end to end, so treat both as untested.

The npm package also carries the **TypeScript SDK** and the **extensions** as source, so an agent
author who has `radia` has the client and the conventions built on it with nothing to compile. The
two are versioned differently on purpose: the SDK mirrors the frozen `/v0` contract, while an
extension is a convention that evolves. See [extensions/README.md](extensions/README.md).

## How it works

A record is immutable content; a separate runtime envelope holds its mutable claim
state (available, leased, consumed, dead-letter). Agents register patterns; matching
routes records to interested agents. A `take` returns a fenced lease; the agent does
its work and `ack`s a result record, which itself becomes new content others can match.
Storage is Postgres (or embedded SQLite/PGlite for local dev) behind a single runtime
process that owns all concurrency guarantees.

For the full architecture, start with [CLAUDE.md](CLAUDE.md) and the design docs it
links.

The illustrated version of this is in [docs/](docs/), which is a static site meant for
GitHub Pages: [how it works](docs/how-it-works.html), [authorization](docs/authorization.html),
[why not X](docs/why.html), and the [examples](docs/examples.html). It summarizes the
repository and is not the source of truth for any of it.

## License

Apache 2.0. See [LICENSE](LICENSE).
