# Radia SDKs

The TypeScript and Python SDKs wrap the public `/v0` API. They provide clients, watches, worker
loops, artifact transfer and shared wire types without importing runtime internals.

**Import from `radia` (`ts/mod.ts`) and nothing else.** It is a barrel: every name is re-exported
unchanged from the module that owns it, so the individual paths stay importable and there is nothing
to keep in sync. Measured on four minimal journeys (a task/result pair, a registry you own, a
correlated request, a registry you discover): 9 imports across 9 module paths became 4 across 1,
and `contentKey` had not been reachable from the client at all.

`ts/wire.ts` defines the frozen wire vocabulary and pure functions that clients and the server must
compute identically. The runtime imports these definitions; the SDK imports nothing from `src/`.
`test/layering.test.ts` enforces that direction for value and type imports.

The EXTENSION conventions (workspaces, capabilities, presence, promotion) reach non-TS apps over
HTTP rather than through an SDK port: `radia serve-ext`, or `--ext` on `dev`/`serve`, serves them
as routes, and [`py/radia_ext.py`](py/radia_ext.py) (imported as `radia.ext` from pip) is the thin
Python client. Zero choreography client-side by design: the fork checks, publish anchors and digest
hashing stay in the reference implementation
([agent_docs/plan-extension-http.md](../agent_docs/plan-extension-http.md)).

| | TypeScript | Python |
|-|------------|--------|
| Path        | [`ts/`](ts/): import `mod.ts`; behind it `wire.ts`, `registry.ts`, `await.ts`, `client.ts`, `loop.ts` | [`py/radia.py`](py/radia.py) |
| Client      | `RadiaClient`      | `RadiaClient` |
| Worker loop | `agentLoop`        | `agent_loop` |
| Reactor loop (fact-side: watch, re-read, decide) | `reactorLoop` | not yet: hand-roll the sweep, or poll |
| Paging      | `queryNewest` / `queryOldest` / `queryOrdered` / `queryPage` → `{records, nextCursor, scope}` | `query_newest` / `query_oldest` / `query_page` → `(records, next_cursor, scope)` |
| Watches     | `client.watch()` async generator | `client.watch()` generator |
| Artifacts   | `putArtifact` / `getArtifact` / `artifactMeta` (HEAD: digest and size, no bytes) / `artifactCapability` (download) / `uploadCapability` (upload, single-use: the record is described at mint and the holder PUTs only bytes) | `put_artifact` / `get_artifact` / `artifact_capability` |
| Remediation | `admin(action, id)` / `remediate(action, selector)` | `admin(action, id)` / `remediate(action, state=…, expired=…, kind=…)` |
| Ops queries | `queryEnvelopes` / `getEnvelope` (ONE record's claim state and, when leased, its fenced lease) / `diagnostics` / `erasures` / `getStats` / `getEvents` / `getEventsPage` | `query_envelopes` / `diagnostics` / `erasures` / `get_stats` / `get_events` / `get_events_page`; no per-record envelope |
| Bootstrap   | `grant` / `createAgentDefinition` / `createRun` / `stopRun` | `grant` / `create_agent_definition` / `create_run` / `stop_run` |
| Delegation  | `createDelegatedRun` / `delegatedClient`                    | `create_delegated_run` / `delegated_client`                     |
| Credential  | `{definitionToken}` exchanges on expiry; `keepAlive(signal, onLost)` renews at half-life | `definition_token=` exchanges on expiry; `keep_alive(stop, on_lost)` renews at half-life |
| Children    | `getChildren` / `getChildrenPage` (paged) | `get_children` / `get_children_page` (paged) |
| Reads       | `readOne` (the OLDEST match) / `readNewest` | `read_one` (the OLDEST match) / `read_newest` |
| Body typing | `RadiaRecord<T>`: `agentLoop<T>` / `registry<T>` / `readOne<T>` / `readNewest<T>` hand back a named body | none; bodies are dicts |
| Registry    | `registry(kind, match?)`: the current set, projected server-side from the kind's declared key. Entries are a `ReadonlySet`, since a projection has no order to index into | `registry(kind, match=None)`, a list, and the ONLY correct path there: Python has no projection helper |
| Content key | `contentKey(tag, body)`, async (Web Crypto) | `content_key(tag, body)`, sync (hashlib) |
| Dependencies| none beyond the runtime | none, standard library only (3.9+) |

**Credential lifecycle.** `keepAlive` renews an active run before expiry. A client may also hold a
mint-only definition token and exchange it for a new run after expiry or the absolute run ceiling,
which is what lets a session outlive the 12-hour ceiling and what renewal alone cannot do, since
renewing needs a process awake inside the window. Concurrent callers produce ONE exchange, not one
each, and a 403 is never retried: a grant is not a credential, so exchanging would spend a mint and
hide the answer. **Both SDKs now do this** (Python since 2026-08-29, closing the last parity gap);
`test/exchange.test.ts` and `test/py-exchange.test.ts` cover them, each against a real socket.

Every path that does not share the ordinary request code must be covered separately, and in both
SDKs those are the artifact calls and the SSE watch stream: the stream holds whatever token it
opened with, so it mints before connecting and treats a 401 mid-stream as an exchange rather than a
revocation.

**Read ordering.** Every read names its direction, and there is no bare `query(pattern, limit)` in
either SDK. It read the OLDEST matches while saying nothing about that at the call site, which is
how a re-saved procedure kept resolving to a stale version and a re-published tool kept vanishing.
`queryNewest` and `queryOldest` page the natural record-id order; `queryOrdered` is for a pattern
carrying `order_by`, which already sets the order (the space refuses a direction combined with it,
and the directional calls throw locally rather than letting you find that as a 400).

If you are RELAYING a pattern somebody else wrote (a tool call, jailed code), dispatch on it rather
than picking a direction: `pattern.orderBy?.length ? queryOrdered(...) : queryNewest(...)`. A
direction is an assumption, and it is not yours to make about a pattern you did not write.

**Field names are camelCase on the wire, and a misspelling is refused rather than dropped.**
`orderBy`, `parentIds`, `availableAt`, `clientMeta`. The design docs name these concepts in prose as
`order_by`, `parent_ids` and `available_at`, which is the mistake worth knowing about: those
spellings used to be silently ignored, so a read came back unsorted and a record came back with no
lineage, both with a 200. The space now answers 400 and names the field it meant.

`readOne` returns the oldest matching record. Use `readNewest` for registries, versions and other
successor-based data. `readNewest` uses the query operation and therefore requires a query grant.

**Paging.** Send `nextCursor` back as `cursor` and nothing else: it carries the direction of the
walk, so page two cannot run the other way. `cursor` with `dir` or `after` is a 400, and in
TypeScript `Page` is a union so that pair does not compile. An `order_by`
read is offered no cursor at all, since a record-id keyset cannot express that order. TypeScript's
`queryAll` returns a `Population`, the brand `activeByKey` / `newestByKey` / `activeSet` require, so
a latest-wins projection over a page does not compile; Python has no such check, which is why
`registry(kind)` is the path there.

**Content and identity keys.** `contentKey(tag, body)` keys an idempotent write by its full content. The key functions in
`registry.ts` (`grantKey`, `opsGrantKey`, `kindDefKey`, `oidcIdentityKey`) answer a different
question: a logical IDENTITY, deliberately a subset of the body, so a successor shares the key and
supersedes — which is what makes a `retired: true` tombstone replace the entry it withdraws.
`contentKey` hashes everything, so any change is a new record. Choose by what a re-put should MEAN.
Keying on the container rather than the content dedupes writes that were meant to change something:
the call returns 200 and nothing happened.

The two SDKs compute the SAME key for the same body, which matters because a TS writer and a Python
writer would otherwise each write their own record. Python renders numbers exactly as JavaScript
does (`1.0` → `1`, `1e-5` → `0.00001`, exponent form only outside `[1e-6, 1e21)`, never
zero-padded), sorts object keys in UTF-16 code-unit order, leaves non-ASCII unescaped, and refuses
what no shared key can exist for: NaN/Infinity, integers beyond 2**53 (JavaScript would silently
round them), and values that are not JSON. The agreement is a guard, not a discipline:
`test/py-parity.test.ts` runs one corpus of raw JSON texts through both implementations
wherever `python3` is present, including CI. The small-float divergence it exists to catch
(`1e-05` vs `0.00001`) shipped and survived precisely because nothing checked.

**Client-side helpers.** Two helpers compose public verbs without adding wire operations.
`readExhaustively` pages a read to exhaustion and reports `complete: false`
rather than a plausible prefix. `awaitResult` waits for the record another agent will write: the
deadline loop, the poll, an injected wake (pass a shared one, or take the default sleep) and a final
read after the deadline, returning a DISCRIMINATED outcome, because "nobody answered in time" is an
ordinary result of asking a fleet for something rather than an exception each caller re-invents.

**Extensions.** The SDK is one method per `/v0` verb,
with no policy, and carries the wire contract's stability promise. An extension is an opinionated
CONVENTION built on those verbs (a `workspace` manifest, a `sandbox` record) and evolves
independently. Both ship in the npm package; only this half is frozen. If something here starts
making decisions rather than making requests, it belongs one directory over.

**Language coverage.** TypeScript exposes the complete current client surface. Python tracks the frozen
core: coordination verbs, watches, artifacts, remediation, the basic ops reads, and bootstrap.
Python tracks that set and nothing more. The inspection surface (`digest`, `thread`, `flows`, `gc`,
`rewrapBlobs`, `integrity`, `dryRun`, `queryExplained` / `explain`, `publishInterest`, `queryAll`) is TS-only, because the one consumer
that drives it (the chat example) is TS. **Credential EXCHANGE is TS-only too, and that one is a
gap rather than a scoping decision**: a Python `agent_loop` still ends at the 12-hour ceiling. It
wants the same `definition_token` treatment when a Python consumer needs a session that outlives a
day. Never add a Python method for parity's own sake; extend
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

`watch: false` runs `agentLoop` on its poll alone, for a host with a connection budget rather than a
preference: a browser allows six per origin over HTTP/1.1, shared across tabs. It costs latency and
nothing else, because the poll is the correctness argument and a watch is a wakeup hint.

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

`log` is optional and the loop is SILENT without one, but only about routine trace (took, acked,
fenced). A FAILURE is never silent: a handler that throws, a take that errors, a watch refused and
an interest that could not be published go to `console.error` / `stderr` when no `log` was given.
A REPEATED failure is one line, not one per tick: an unreachable space is reported once per streak
(with the address and the transport cause unpacked from Deno's bare "fetch failed"), counted with a
once-a-minute reminder, retried with a capped backoff, and announced on recovery. **That paragraph
is TS only.** Python's `agent_loop` reports every failure and does not back off, so an unreachable
space is one line per tick there. Stated rather than left to be discovered: the section above reads
as describing the loop in general, and a third audit read it that way.
Pass a `log` to route them elsewhere; there is no way to switch them off. A swallowed handler
exception is indistinguishable from a hang, because the record is claimed, nacked, reclaimed and
nacked again with nothing anywhere saying why.

**The watch stream authenticates, and re-creates itself when the server forgets it.** The SSE
connect is a raw request, so it does not inherit the client's `Authorization` unless it is set
there explicitly — TS did not, so under `--auth required` every connect 401'd and the loop
degraded to polling, quietly. And watches live in server memory, so a restart 404s every existing
id permanently; both SDKs re-create the watch on a 404 instead of retrying the dead one. Events
during the gap are missed by construction, which is what the poll fallback is for.

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
