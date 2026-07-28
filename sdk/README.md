# Radia SDKs

Client libraries for talking to a Radia space. Both wrap the public `/v0` API and nothing else:
whatever an SDK can do, a plain HTTP client can too.

| | TypeScript | Python |
|-|------------|--------|
| Path        | [`ts/`](ts/): `client.ts`, `loop.ts` | [`py/radia.py`](py/radia.py) |
| Client      | `RadiaClient`      | `RadiaClient` |
| Worker loop | `agentLoop`        | `agent_loop` |
| Paging      | `query` / `queryPage` (keyset: `{after, dir}`) | `query` / `query_page` (keyset: `after=`, `dir=`) |
| Watches     | `client.watch()` async generator | `client.watch()` generator |
| Artifacts   | `putArtifact` / `getArtifact` / `artifactCapability` | `put_artifact` / `get_artifact` / `artifact_capability` |
| Remediation | `admin(action, id)` / `remediate(action, selector)` | `admin(action, id)` / `remediate(action, state=…, expired=…)` |
| Ops queries | `queryEnvelopes` / `diagnostics` / `getStats` / `getEvents` | `query_envelopes` / `diagnostics` / `get_stats` / `get_events` |
| Bootstrap   | `grant` / `createAgentDefinition` / `createRun` / `stopRun` | `grant` / `create_agent_definition` / `create_run` / `stop_run` |
| Dependencies| none beyond the runtime | none, standard library only (3.9+) |

**TypeScript is the full surface; Python is frozen to the core.** The table above is the frozen
core: coordination verbs, watches, artifacts, remediation, the basic ops reads, and bootstrap.
Python tracks that set and nothing more. The inspection surface (`digest`, `thread`, `dryRun`,
`queryExplained` / `explain`, `publishInterest`, `queryAll`) is TS-only, because the one consumer
that drives it (the chat example) is TS. Never add a Python method for parity's own sake; extend
Python when a Python consumer needs the call.

## Credentials

Neither SDK asks you to pass a token in the common case. `radia dev` provisions one; the Python
SDK reads it via `resolve_token()`, and the CLI and MCP adapter do the same through
`src/credentials.ts`. `RADIA_TOKEN` overrides, `RADIA_URL` picks the space. See
[agent_docs/architecture-surfaces.md](../agent_docs/architecture-surfaces.md).

The TS client resolves `RADIA_URL` through a guarded `globalThis.Deno?.env` read so it still
works in a worker without `--allow-env`, and does not depend on the runtime's platform seam. It
is meant to ship standalone.

## The worker loop

Both loops implement the same contract (design §5, [agent_docs/design-api.md](../agent_docs/design-api.md)):
watch-driven with a poll fallback, a renewal heartbeat at lease/3 while a handler runs, a
per-attempt idempotency key on ack, and a nack on any handler failure.

Delivery is **at-least-once**. A handler with side effects must be idempotent at the effect
boundary. A fenced worker keeps running until it observes `lease_lost`, so physical execution can
overlap.

A `403` on a watch is treated as permanent (the run has no grant for that kind): both loops log it
loudly once and fall back to polling, rather than retrying forever. "Silently slow" would be a
worse failure than "loudly wrong".

## Usage

TypeScript: see [`examples/`](../examples/) for runnable agents; every one of them imports only
from `sdk/ts/`, which is the boundary that keeps them honest about what an external author can do.

Python:

```python
from radia import RadiaClient, agent_loop

client = RadiaClient()                    # $RADIA_URL, credential auto-resolved
client.register_kind({"kind": "job", "indexedPaths": [{"path": "tag", "type": "keyword"}]})
client.put({"kind": "job", "body": {"tag": "a"}})

def handle(record, c):
    return {"kind": "job_result", "body": {"ok": True}}

agent_loop(client, name="worker", patterns=[{"kind": "job"}], handle=handle)
```
