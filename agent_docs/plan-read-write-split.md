# Plan: splitting a space by write capability

> Status: analysis 2026-08-29, from source. Nothing built. Origin: the question whether the `/v0`
> server should run in "ops only" and "data only" modes so the two planes can be separated by
> process and merged by a gateway. The answer is that the plane boundary is the wrong cut and the
> read/write boundary is a real one, so this doc records the cut that survives inspection.

## Why not ops/data

Three findings, each checkable in the source:

- **`/v0/ops/*` is not an admin plane.** `space_get`, `space_lineage`, `space_children`,
  `space_thread`, `space_stats` and `space_events` are `/v0/ops/records/...` reads called per turn
  by `src/surfaces/mcp/server.ts`, `extensions/ts/agent-tools.ts`, `examples/chat/web/app.js` and
  the console. The three ops READ tiers exist because ordinary participants need them
  ([architecture-ops-tiers.md](architecture-ops-tiers.md)). A data-only process breaks every MCP
  session; an ops-only process is not low-traffic. The line runs through the middle of one agent's
  request mix.
- **Process separation alone gives no authority isolation.** Both processes hold the same database
  credential, blob store, KEK and seal key, so a compromised data-plane process writes `grant` and
  `ops_grant` records straight to storage. What a split buys is reachability (do not route
  `/v0/ops/*` from the public edge) and event-loop isolation (Deno is single-threaded, so a `graph`
  walk, a `flows` mine or an `integrity` verify competes with `take`). A gateway already gives the
  first, and N identical instances already give the second.
- **The escalation root is on neither plane.** `POST /v0/agent-definitions`, `/v0/agent-runs*`,
  `/v0/agent-definitions/{agent}/revoke` and `/v0/sessions/oidc` mint and revoke credentials and sit
  outside `/v0/ops/`. Any cut made for reachability has to move them, which is another way of saying
  the useful axis is not the prefix.

## The cut: reader and writer postures

A **reader** serves health, coordination reads, watch streams, artifact bytes and ops reads. It
writes no record. A **writer** serves everything. The reader can then run under a database role with
no DML, which is containment a gateway cannot give.

Two facts make the reader posture real rather than a routing rule:

- `resolveCredential` (`src/core/identity.ts:1069`) resolves a bearer token from records with no
  write, so a reader authenticates every principal without minting anything.
- `Space.createWatch` (`src/core/space.ts:2193`) allocates in memory and reads `latestCursor`. Watch
  fan-out, which is the expensive read-side work ([plan-scaling.md](plan-scaling.md)), is therefore
  a reader's job.

### Route classification

| Reader | Writer |
|--------|--------|
| `GET /v0/health` | `POST /v0/records`, `/v0/takes`, `/v0/leases/{renew,ack,nack,release}` |
| `POST /v0/records/{read-one,query,registry}` | `POST /v0/artifacts`, `PUT /v0/a/{cap}` (capability upload) |
| `GET` and `HEAD /v0/artifacts/{id}`, `GET /v0/a/{cap}`, `GET /v0/w/{cap}/{path}` | `POST /v0/agent-definitions`, `/v0/agent-runs`, `/v0/agent-runs/delegated`, `/{id}/{renew,stop}`, `/{agent}/revoke`, `/v0/sessions/oidc` |
| `POST /v0/artifacts/{id}/capability`, `POST /v0/capabilities` (process-local state only) | `POST /v0/ops/remediate`, `/v0/ops/records/{id}/{reclaim,dead-letter,requeue,declassify,shred}` |
| `POST /v0/watches`, `GET /v0/watches/{id}/events` | `POST /v0/ops/{gc,rewrap}` live |
| every `GET /v0/ops/*` read, `POST /v0/ops/dry-run`, `POST /v0/ops/{gc,rewrap}` with `dryRun` | |

### Two reads that write today

- `GET /v0/ops/integrity` and `GET /v0/ops/diagnostics` call `verifyIntegrity`, which seals the
  chain first unless `seal: false` (`src/core/seal.ts:280`). A GET that appends rows is a surprise
  on any deployment, so this is worth fixing whether or not the split is built.
- Nothing else on the reader column writes. `prepareKind` DDL runs at kind load and is guarded by an
  existence query, so on an existing database it is a read (`src/storage/pgbase.ts:448`).

## Constraints that bind whatever the cut

- **Process-local state forces stickiness.** `Space.watches` (`src/core/space.ts:398`) means
  `POST /v0/watches` and its `GET .../events` must hit one process. `CapabilityStore`
  (`src/core/artifacts.ts:223`) means a capability minted on one process is a 403 on another. Bytes
  are self-sticky when each instance advertises its own `artifactOrigin`, since the capability URL
  names the host that minted it; watches are not, and need a sticky route or one watch per
  connection origin. Both predate this plan ([design-storage.md](design-storage.md), "Scaling and
  multi-instance operation").
- **Postgres only.** `src/lock.ts` is one writer per local database, and two PGlite processes on one
  directory diverge undetectably. A reader posture over an embedded database must be refused at
  startup, not merely discouraged.
- **Sweeps ride the write path.** Retention (`gcEveryWrites`) and registry compaction
  (`compactEveryWritesPerKind`) are amortized on commits with per-instance `SweepState`, so a reader
  never sweeps and never needs to. Housekeeping stays where the writes are
  ([plan-gc.md](plan-gc.md)).
- **Keys follow the bytes, not the plane.** A reader serving artifact bytes needs the blob KEK to
  decrypt, and one verifying the chain needs the seal key to check signatures. A reader that serves
  records only needs neither, which is the sharpest containment available here.

## Phases

1. **Gateway only, no code.** Route `/v0/ops/*` and the bootstrap chain to an internal listener.
   Verify: the public edge answers 404 for `/v0/ops/stats` while a session inside still reads it.
   This gets reachability and nothing else, and it costs nothing to undo.
2. **Stop the two reads from writing.** `seal: false` on the `integrity` and `diagnostics` read
   paths, with sealing reachable as its own verb for whoever wants it eager. Verify: a `GET
   /v0/ops/integrity` against a read-only connection succeeds and reports `unsealed`.
3. **`--role reader|writer` in `runSpace`.** A route filter over `makeHandler`, the way
   `makeArtifactHandler` already filters (`src/server/http.ts:163`); refuse embedded storage in
   reader mode; name the role in the startup line, which must keep saying which side of every
   either/or you got ([plan-startup-ergonomics.md](plan-startup-ergonomics.md)). Verify: every
   writer route answers 404 on a reader, and `test/openapi.test.ts` still passes, since the spec
   describes the contract and a role is a deployment fact.
4. **The database role.** Revoke INSERT/UPDATE/DELETE from the reader's Postgres role and keep its
   DDL privileges, so `init()`'s idempotent `create table if not exists` stays a no-op rather than a
   permission error (UNVERIFIED against a real server; the alternative is a startup that skips DDL
   in reader mode). Verify: a reader process cannot write a record even with an operator token.
5. **Optional: a records-only reader with no blob store.** Artifact bytes stay on the artifact
   origin, which is already a separate handler and can be a separate process.

## Rejected

- **An ops-only and a data-only process.** See the three findings above. The prefix is a stability
  and authorization boundary, not a traffic or trust one.
- **A second binary for the ops plane.** The planes share `Space`, the matcher, the grant registry
  and the storage adapter; a second binary duplicates all of it to move a route table.
- **Persisting capabilities so any process can resolve one.** High-churn security-critical state as
  records is the shape CLAUDE.md's stopping rule names as a bad fit, and the store says so
  (`src/core/artifacts.ts:210`).

## Open

- No measurement exists for the event-loop isolation this is partly aimed at. Before phase 3, take
  one: `bench/suites/deployment.ts` against a space while a `graph` walk or `flows` mine runs, and
  compare take latency with and without the ops traffic on the same process. If the number is small,
  phases 1 and 4 are the whole of the value and the role flag is not worth its surface.
