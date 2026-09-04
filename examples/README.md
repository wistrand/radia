# Radia examples

The runnable applications here exercise different parts of the public API. Each directory contains
its own setup and source guide. The Keycloak configuration in
[`../docker/keycloak/`](../docker/keycloak/) is a local deployment recipe, not an example.

| Example | What it shows | Needs a key? |
|---------|---------------|--------------|
| [`pipeline/`](pipeline/) | Fan-out and fan-in through records, competitive claims, leases and lineage. | no |
| [`pipeline-py/`](pipeline-py/) | The same pipeline on the Python SDKs, plus presence-policed capabilities and seed-and-wait through the extension bindings. | no |
| [`stress/`](stress/) | Retry churn, dead letters and abandoned leases for inspecting the console under load. | no |
| [`analysis/`](analysis/) | A web application whose stages are keyed by dataset, input digest and code digest. | no |
| [`mud/`](mud/) | A shared world where NPCs are principals with their own grants, not branches in a game loop. | no |
| [`chat/`](chat/) | A multi-process LLM application with discovered tools, artifacts, encrypted conversations and sandboxed code. | for live model calls |

```bash
deno task dev      # a space + web console at http://127.0.0.1:7788

deno task demo     # pipeline: planner + workers + aggregator against that space
deno task demo:py  # the same pipeline on the Python SDKs (the space needs --ext)
deno task stress   # stress:   fill the space with waves of activity
deno task mud -- --player alice   # mud: a scripted world; run the play command it prints

radia login human:you                     # chat: the LLM agent needs a session of its own
RADIA_CHAT_TOKEN=<token> deno task chat   #       plus OPENROUTER_API_KEY
```

Authentication is required by default. `radia dev` provisions the operator credential used to
bootstrap the pipeline and stress examples. Chat sessions run as separately logged-in principals.

Every example coordinates through the public `/v0` API using the SDKs (TypeScript, and Python in
`pipeline-py/`) and shared [`extensions`](../extensions/README.md). Runtime internals are not part
of the application surface.

Two non-coordination exceptions exist:
[`operator.ts`](operator.ts) reads the local credential file (`src/credentials.ts`) to get the
operator token it bootstraps with, rather than reimplementing a path convention that would drift
(`operatorToken(url)`: `RADIA_TOKEN`, else the file `radia dev` writes, and it throws rather than
returning nothing, so no example relies on the no-header open-mode shortcut);
and `chat/smoke-fleet.ts`, a test, imports the registry projection it is asserting about. Neither is
a coordination verb. An example reaching into `src/` for anything a client could do over `/v0` is a
bug in the example.

## What each one is for

**`pipeline/`** is the smallest example and runs in CI through `deno task demo:ci`.

**`stress/`** populates the Space tab and exercises retry churn, dead-lettering and stuck leases.

**`analysis/`** demonstrates content-keyed recomputation and workspace-backed stage promotion.

**`mud/`** makes an NPC a principal: its grants pin which room it may speak in and whose name it may
speak under, so misbehaviour is refused at the write rather than checked for. Phase 1 of
[agent_docs/plan-mud.md](../agent_docs/plan-mud.md); the contest over a scarce item is phase 3.

**`chat/`** exercises the broadest surface: model routing, capability records, turn persistence,
artifacts, delegation, encryption and sandboxed execution.
