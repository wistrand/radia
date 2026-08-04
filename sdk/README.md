# Radia SDKs

Client libraries for talking to a Radia space. Both wrap the public `/v0` API and nothing else:
whatever an SDK can do, a plain HTTP client can too.

`ts/wire.ts` is where the frozen contract's vocabulary is DEFINED — the shapes that cross `/v0`, and
the few pure functions a client must compute identically to the server (`kindDefKey`, and the
latest-wins-minus-retired projection in `ts/registry.ts`). The runtime imports it; it imports nothing.
That direction is load-bearing rather than tidy: the npm package stages `sdk/` and `extensions/` and
no `src/`, so an SDK that reached back into the runtime shipped an entry point importing paths that
were not in the package. `conformance/layering.test.ts` holds the line, in both value and type
imports.

| | TypeScript | Python |
|-|------------|--------|
| Path        | [`ts/`](ts/): `wire.ts`, `registry.ts`, `client.ts`, `loop.ts` | [`py/radia.py`](py/radia.py) |
| Client      | `RadiaClient`      | `RadiaClient` |
| Worker loop | `agentLoop`        | `agent_loop` |
| Paging      | `query` / `queryPage` (keyset: `{after, dir}`) | `query` / `query_page` (keyset: `after=`, `dir=`) |
| Watches     | `client.watch()` async generator | `client.watch()` generator |
| Artifacts   | `putArtifact` / `getArtifact` / `artifactCapability` | `put_artifact` / `get_artifact` / `artifact_capability` |
| Remediation | `admin(action, id)` / `remediate(action, selector)` | `admin(action, id)` / `remediate(action, state=…, expired=…)` |
| Ops queries | `queryEnvelopes` / `diagnostics` / `erasures` / `getStats` / `getEvents` | `query_envelopes` / `diagnostics` / `erasures` / `get_stats` / `get_events` |
| Bootstrap   | `grant` / `createAgentDefinition` / `createRun` / `stopRun` | `grant` / `create_agent_definition` / `create_run` / `stop_run` |
| Dependencies| none beyond the runtime | none, standard library only (3.9+) |

**Beside the SDK: [extensions/](../extensions/README.md).** The SDK is one method per `/v0` verb,
with no policy, and carries the wire contract's stability promise. An extension is an opinionated
CONVENTION built on those verbs (a `workspace` manifest, a `sandbox` record) and evolves
independently. Both ship in the npm package; only this half is frozen. If something here starts
making decisions rather than making requests, it belongs one directory over.

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

**The handler is told when it stops holding the lease**, which is what makes that last sentence
actionable: TS gets a third argument, an `AbortSignal`; Python gets a third parameter, a
`threading.Event` (passed only to a handler that declares it, so two-parameter handlers are
unaffected). Both fire the moment the heartbeat's renew comes back `lease_lost` — reclaimed,
reassigned, force-transitioned — or 401/403, which is where a stopped or quarantined run lands,
since revoking the run kills its token before anything answers `lease_lost`. A handler with side
effects should thread it into whatever it calls and check it between steps. Neither loop settles a
claim it knows it lost: acking would only be told `lease_lost`, and nacking risks bumping the
attempt count of whoever holds the record now. The heartbeat ignores everything else (a network
blip, a 5xx): the lease has until its expiry, and treating a hiccup as a fence would cancel work
that is still legitimately this worker's.

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
