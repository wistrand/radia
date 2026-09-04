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
> implemented, and checksum-verified release binaries are available. The project has no independent
> deployment history yet, the SDK registry packages are unpublished and documented hardening work
> remains. See [the milestone plan](agent_docs/plan-milestones.md) for implemented and remaining work
> and [the audit record](agent_docs/plan-audit-remediation.md) for known security boundaries.

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
deno task cli <verb>        # the CLI from a checkout: `deno task cli health`, `deno task cli doctor`
deno task test              # check + every test below
deno task test:runtime      # everything under test/, incl. the port contract suites
deno task test:conformance  # the port contract alone (storage adapters + the blob store)
deno task test:extensions   # the extension contract (workspace manifests, tree digests, path safety)
deno task test:lab          # recorded agent-harness runs replayed against this build; no model, no key
deno task bench             # throughput, latency percentiles, scaling curves; see bench/README.md
```

**The `radia` command.** Examples below use `radia <verb>` for the CLI. Install the checksum-verified
release binary, or run it from source:

```bash
curl -fsSL https://radia.sh/install.sh | bash
deno run -A src/main.ts <verb>   # from source, no build (what the tasks above do)
deno task compile                # → ./radia, a self-contained binary; then ./radia <verb>
```

Putting the compiled binary on your `PATH` makes the examples read literally. The supported install
is `curl -fsSL https://radia.sh/install.sh | bash`, which fetches a prebuilt binary from the GitHub
release and verifies it against the release's checksums. After that, `radia update` replaces it in
place with the same verification, and `radia update --check` reports whether a release exists
without touching anything. npm and PyPI carry the
SDKs only, never the binary. Native Windows is unsupported; run the Linux binary under WSL2.

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
[examples/README.md](examples/README.md) for the five examples (a keyless coordination pipeline, a
load generator, a content-keyed analysis application, a shared world whose NPCs are principals, and
the full LLM agent), each with its own directory and README.

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
radia query job --match '{"tag":"a"}'         # read by pattern, NEWEST first
radia query job --cursor "$C"                 # continue; the cursor carries its direction
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
radia git-serve                               # …the same, over HTTP, for `git clone` and `git push`
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
radia git-serve                                # …or serve every tree for `git clone` and `git push` over HTTP
git config --global credential.http://127.0.0.1:7790.helper '!radia git-credential'   # once: git signs in there as your radia login
```

Git is a projection of the records rather than their storage. `git push` is accepted fast-forward
only: each commit becomes the next version, and a rewritten or merged branch is refused with the
reason. What that buys over git is per-file
erasure without a rewritten history, every version attributable to a run, and grants that scope
which tree an agent may touch at all. See
[agent_docs/design-workspaces.md](agent_docs/design-workspaces.md).

### Joining from an MCP harness

`radia mcp` serves the space over stdio, so a model coordinates through it with no SDK:

```json
{ "mcpServers": { "radia": { "command": "radia", "args": ["mcp"] } } }
```

For several harnesses sharing one space, `radia team` writes that block for you and gives each one
an identity of its own:

```bash
deno task compile                # ./radia, the binary the generated config will name
radia dev --db &                 # a space whose records outlive the process
radia team add claude codex      # one durable principal each, plus the config to paste
```

Run the printed `claude mcp add … --scope local …` line **in each agent's own project directory**:
the local scope keys the config to that directory, which is what gives each agent its own
principal. The block names the absolute path of the binary that wrote it, so it works from any
project; running `team add` from source instead says so, and points at `deno task compile`.

Each member is an `agent_definition`, not a session: a run token dies at the 12h ceiling, so
attribution resting on one lasts a day, while every run a definition mints resolves back to the
same `agent:` name for as long as the space exists. Give each SESSION its own member
(`radia team add claude-a claude-b`), because one credential in two windows is one principal:
nothing tells their work apart, and stopping one stops both. `radia team` lists who holds what,
`radia team remove` revokes and stops the live runs, and `radia get <id>` names the agent behind a
record's run.

The members share `task` (claimable, so a lease is what stops two agents doing the same work twice)
and `note` (a mailbox by `to`, a thread by `topic`).

**Teams are isolated by default.** `--team alpha` scopes every grant with `pattern: {team: "alpha"}`,
so a write carrying another team's label, or no label at all, is refused at the write, and a read
returns that team's records without hinting there were others. Repeat `--team` for a member that
crosses. `radia team` lists who reaches which team.

Nothing has to remember the label: the MCP adapter fills it in from the grant, after the space
refuses a write for scope rather than by stamping every write up front. A member of several teams
is asked which one, because guessing would file the work in the wrong team.

The cost is the ops plane: `space_get`, `space_lineage`, `space_children`, `space_stats` and
`space_events` need the `observe` power, which is unscoped and so reads every team. `--observe`
grants it and says what it costs. See [extensions/ts/team.ts](extensions/ts/team.ts).

This surface has been exercised by real harnesses: Claude Code, Codex and Antigravity have run
against it across 44 recorded sessions, and the recorded runs replay as regression tests
(`scripts/agent-lab/`). [docs/agent-findings.html](docs/agent-findings.html) reports what the
agents did and what changed because of it.

The adapter holds the credential and the fenced lease itself: `space_take` hands the model an
opaque `claimId`, and the lease is renewed at lease/3 in the background, so a model that spends
minutes thinking keeps its claim without ever seeing (or being able to leak) a token or a lease.
Kinds are discovered at runtime via `space_kinds`, so nothing about your space is baked into
the tool list.

### Running it for somebody else

`radia dev` is a laptop. `radia serve` is the same space in a deployment's posture:

```bash
radia serve --config /etc/radia.json --operator-token-file /run/radia/op.token
```

The config file is these same flag names without the dashes, and a flag on the command line beats
the file:

```json
{ "storage": "postgres", "db": "postgres://radia@db/radia", "host": "127.0.0.1", "port": 8080,
  "blobs": "s3://radia/blobs", "event-retention": 2592000 }
```

What differs from `dev`, all of it about what a start leaves lying around: nothing is printed to
stdout (a service's stdout is the journal, and the operator token is the only thing `dev` puts
there); no credential is written to this machine's shared credential file; `--auth open` is refused;
persistent storage is required; and the web console is served only with `--console`. The operator
bit is for bootstrap, so `--operator-token-file` writes it owner-only where you asked, and without
that flag it dies with the process.

Two ports, not one: artifact bytes get their own ORIGIN at `--artifact-port` (the main port plus one
by default), because a second origin is what stops generated content reaching the console. A proxy
that forwards only the main port leaves every capability URL pointing at nothing; `--artifact-port 0`
turns it off and serves artifacts as downloads from the main origin instead.

Not yet provided, and a deployment still owns them: TLS (terminate at a proxy), backup and restore,
and an upgrade procedure. `radia update` swaps the binary; deciding when to restart a space and how
to roll one back is the deployment's. Set `RADIA_DIR` in the unit file, or the runtime directory holding the
seal key and blob KEK follows the working directory.

### Distribution

```bash
deno task bump                      # stamp the next YYYY.M.COUNTER version everywhere,
                                    # then run the git commands it prints (the v* tag builds
                                    # and publishes the release); `deno task bump 2027.1.2`
                                    # sets an explicit version instead
./scripts/build-release.sh          # per-OS binaries + staged npm and pip SDK packages
./scripts/build-release.sh host     # just this machine, for a quick check
```

`deno compile` produces one self-contained binary (console and its vendored asset included) per
target: Linux and macOS, x64 and arm64. Native Windows is unsupported; WSL2 runs the Linux binary.
The binary's one supported install is `curl | sh` ([docs/install.sh](docs/install.sh), which
downloads the release assets `.github/workflows/release.yml` publishes on a `v*` tag and verifies
them against the release's `SHA256SUMS`). Nothing is on npm or PyPI yet.

```bash
curl -fsSL https://radia.sh/install.sh | bash     # -> ~/.local/bin/radia
radia update --check                              # is there a newer release? exit 1 if so
radia update                                      # replace this binary with it
```

`update` reads the same asset names and `SHA256SUMS` the installer does, which is why
`test/docs.test.ts` holds that contract across three files. It refuses to run from a checkout,
where the binary it would replace is `deno` itself. Releases are not signed; the reasoning and the
triggers that would change it are in
[agent_docs/plan-self-update.md](agent_docs/plan-self-update.md).

The npm package carries the **TypeScript SDK** and the **extensions** as source, and the pip
package (`radia-space` on PyPI, importable as `radia`) the **Python SDK**; neither carries a
binary or a launcher. The SDK and the extensions are
versioned differently on purpose: the SDK mirrors the frozen `/v0` contract, while an extension is
a convention that evolves. See [extensions/README.md](extensions/README.md).

## How it works

A record is immutable content; a separate runtime envelope holds its mutable claim
state (available, leased, consumed, dead-letter). Agents register patterns; matching
routes records to interested agents. A `take` returns a fenced lease; the agent does
its work and `ack`s a result record, which itself becomes new content others can match.
Storage is Postgres (or embedded SQLite/PGlite for local dev) behind a single runtime
process that owns all concurrency guarantees.

For the full architecture, start with [CLAUDE.md](CLAUDE.md) and the design docs it
links. The documentation is structured for coding agents with the
[structuring-agent-docs](https://github.com/wistrand/structuring-agent-docs) skill: one routing
entry point, topic files under `agent_docs/`, and a gotchas record beside them.

The illustrated version of this is in [docs/](docs/), which is a static site meant for
GitHub Pages: [how it works](docs/how-it-works.html), [authorization](docs/authorization.html),
[why not X](docs/why.html), and the [examples](docs/examples.html). It summarizes the
repository and is not the source of truth for any of it.

## License

Apache 2.0. See [LICENSE](LICENSE).
