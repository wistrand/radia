# Radia's implementation, explained

What the code is made of. Companions: [radia-explained.md](radia-explained.md) for the model and
[radia-auth-explained.md](radia-auth-explained.md) for the auth stack. Code wins over this file on
any conflict.

There is one process. It is Deno and TypeScript, it owns every concurrency guarantee, and the
database behind it is Postgres or a Postgres-shaped embedded equivalent. There is no build step;
`deno compile` turns the same source into one binary.

## 1. Inside the binary

```
┌────────────────────────────────────────────────────────────────────┐
│ src/main.ts       dev | serve | mcp | <cli verb>   (the ONLY exit) │
├────────────────────────────────────────────────────────────────────┤
│ src/surfaces/     CLI, MCP over stdio;  /v0 clients, in-process    │
│ src/ui/           the console, served by src/server/               │
├────────────────────────────────────────────────────────────────────┤
│ src/platform.ts   the platform seam: serve, fs, env, subprocess,   │
│                   crypto, clock.  One documented exception below.  │
├────────────────────────────────────────────────────────────────────┤
│ src/server/http.ts    route -> resolveAuth -> ops gate -> handler  │
│   handlers/       records  leases  watches  artifacts  agents  ops │
│   problem.ts  RFC 9457 + rejectUnknown   body.ts  capped reader    │
├────────────────────────────────────────────────────────────────────┤
│ src/core/space.ts     the one facade;  as(principal) -> handle     │
│   take.ts  matching.ts  seal.ts  identity.ts  gc.ts  flows.ts      │
│   notifier.ts     wakeup for SSE watches                           │
├────────────────────────────────────────────────────────────────────┤
│ src/storage/adapter.ts    StorageAdapter + BlobStore ports         │
└────────────────────────────────────────────────────────────────────┘
```

Four seams, each checked by `test/layering.test.ts` rather than left to convention:

- `platform.ts` is where `Deno.*` belongs. There is one documented exception,
  `src/storage/postgres.ts`, which uses `Deno.connect`/`Deno.startTls` for TCP_NODELAY and
  dead-socket detection. Replacing the backend via `setPlatformBackend` runs the same runtime in
  a browser (`platform_browser.ts`).
- A surface never takes a value from `src/core`, `server` or `storage`. The CLI and the MCP
  adapter talk `/v0` through the SDK, like an external client. A type is erased, so `import type`
  is allowed, and a surface may still take values from `platform`, `flags`, `credentials`,
  `paths`, `log` and from `extensions/`.
- An extension never imports `src/` at all, only the SDK. The check scans `extensions/ts/`.
- The runtime logs through `getLogger`; a surface prints. There is no `console.*` in
  core/server/storage, and `radia mcp` never touches stdout, since that is its JSON-RPC channel.

`src/main.ts` is also the only place allowed to call `exit`. Everything else returns a status or
throws `UsageError`.

The dependency list is five imports in `deno.json`: `@std/ulid`, `@std/assert`, `@std/path`,
`@electric-sql/pglite` and `@db/postgres`. Nothing under `src/` or `sdk/` bypasses the import
map. The binary also carries one vendored browser asset for the console,
`src/ui/vendor/blitzoom.bundle.js`, checked in prebuilt and pinned to an upstream commit.

## 2. Three storage backends behind one port

```
            StorageAdapter   (src/storage/adapter.ts)
                                 │
           ┌─────────────────────┼───────────────────────┐
           ▾                     ▾                       ▾
 ┌───────────────────┐  ┌──────────────────┐   ┌───────────────────┐
 │ sqlite.ts         │  │ pglite.ts        │   │ postgres.ts       │
 │ node:sqlite,      │  │ PGlite, wasm     │   │ @db/postgres      │
 │ built into Deno   │  │ Postgres in the  │   │ a real server     │
 │ zero dependency   │  │ same process     │   │ over TCP          │
 └───────────────────┘  └────────┬─────────┘   └─────────┬─────────┘
                                 └───────────────────────┘
                             pgbase.ts: one dialect, one DDL,
                             one planner, one pushdown
```

PGlite and Postgres share `pgbase.ts` (`PgSqlAdapter`), so the embedded Postgres is Postgres
compiled to wasm, not an emulation of it. SQLite stands alone and uses `node:sqlite`, which is
built into the Deno runtime, so it adds no dependency and no FFI.

Embedded mode is not a semantically weaker version of Postgres. `test/conformance/` is the port
contract and runs against every adapter and every blob store, encrypted and not, embedded and
against a live Postgres, in CI. That suite is the only protection against drift, and it protects
only while it runs: the pg half was manual until 2026-08-04 while the docs already claimed
otherwise.

`src/storage/pushdown.ts` compiles a match pattern into SQL. It is sound rather than complete:
what it cannot translate it declines, and the adapter filters in memory instead of returning a
wrong page.

### The tables

| Table            | Holds                                                                    |
|------------------|--------------------------------------------------------------------------|
| `records`        | the immutable half: body, `created_by`, `parent_ids`, taint, timing       |
| `record_runtime` | the mutable envelope: state, attempt, `available_at`, lease id/epoch/owner |
| `record_edges`   | the lineage DAG, so `children` is an index lookup rather than a scan       |
| `idempotency`    | keyed per principal, so two agents reusing a key do not collide            |
| `events`         | the append-only event log                                                  |
| `event_seal`     | the tamper-evident chain over it                                           |

There are two record tables rather than one because that split is the data model: the left half
never changes, and the right half is the only thing a `take` writes.

The index a claim actually uses is `idx_runtime_claim_order`, which is the claim ordering
column for column and is deliberately not state-filtered: putting `state` before those columns
took the query from 19.5 ms to 0.8 ms. A partial index on `state = 'available'` exists alongside
it.

## 3. What a take executes

```
POST /v0/takes  {pattern, leaseSeconds}
  1  resolveAuth      one tokenHash lookup, no cache
  2  readAccess       grant records -> constraint pattern
                                    + createdBy + taint allowlist
  3  combineMatch     grant AND request
  4  pushdown         -> SQL, the untranslatable part filtered after
  5  rankClaimable    priority desc, available_at asc, id asc
  6  conditional UPDATE on record_runtime, one of two branches:

     claim an available record
       set state='leased', lease_epoch=<epoch+1>, lease_owner=...
       where record_id=? and state='available'
         and available_at <= now
         and lease_epoch is not distinct from ?

     reclaim an expired lease   (same guard on state='leased',
                                 plus an attempt bump)
```

Step 6 carries the concurrency guarantee. The compare-and-set on `lease_epoch` makes the claim
atomic without a lock held by the application, and the bumped epoch is the fence: a worker still
running past expiry presents a stale epoch, so its `ack` matches zero rows and returns
`lease_lost`. The next epoch is computed in TypeScript before the statement runs. The
`available_at <= now` half of the guard is needed too: on `state='available'` alone, a record
could be claimed inside a nack backoff, which wrote a stale epoch over a live fence. Take-by-id
additionally uses `FOR UPDATE SKIP LOCKED`.

All time comparisons use the database clock, never the client's and never the app server's.

## 4. Deployment

```
    browser  ·  CLI  ·  MCP  ·  TS/Py SDK
            │  HTTPS,  Authorization: Bearer
            ▾
┌────────────────────────┐    ┌────────────────────────┐
│ radia serve   (deno)   │    │ radia serve   (deno)   │  N stateless
└───────────┬────────────┘    └───────────┬────────────┘  instances
            └──────────────┬──────────────┘
                 ┌─────────┴─────────────────────────┐
                 ▾                                   ▾
  ┌─────────────────────────────┐     ┌─────────────────────────────┐
  │ POSTGRES                    │     │ S3, or a filesystem         │
  │ records, record_runtime,    │     │ artifact BYTES              │
  │ events, event_seal          │     │ wrapped DEK beside each     │
  └─────────────────────────────┘     └─────────────────────────────┘

  every concurrency guarantee lives in the database; the instances
  share no memory. A watch wakes on an in-process notify, or on a
  250 ms poll of the event log for another instance's write
```

`src/core/notifier.ts` is the only cross-instance coordination, and it carries no payload. Both
sources are hints, so a poll that fails or fires spuriously costs one wasted loop iteration. Two
properties it has for measured reasons: waiters are keyed by kind, because kind-blind wakeup made
one write wake every parked stream and was the chat's fan-out ceiling, and the poll runs only
while somebody is waiting, so an idle space holds no timer.

Give the instances one shared blob location. An erasure reaches only the blob store the handling
instance holds, so N instances over N local directories shred one copy each.

`radia serve` is the deployment posture of the same space `radia dev` runs: no credential file,
nothing on stdout, persistent storage required.

## 5. Local development

```
$ radia dev
```

Embedded PGlite, in memory by default, so `radia dev` writes no database at all unless asked.
Bare `--db` persists under `./.radia` (`RADIA_DIR`; `src/paths.ts` owns it, so no call site
writes a path), and `--db <path>` takes a SQLite file or a PGlite directory. One writer per local
database, held by an advisory lock on `<db>.lock`
(`src/lock.ts`). It binds loopback, defaults to `--auth required`, and provisions two credentials
into `src/credentials.ts`: an operator token printed to stdout, and `agent:local-observer` with
`observe` only, which the MCP adapter and the read-only CLI verbs prefer.

The console at `GET /` is `src/ui/index.html`, public API only, with the view in the URL hash.
It is one hand-written file plus the prebuilt vendored bundle, with no build step; `deno compile`
`--include`s both into the binary.

## 6. Nothing fires on a timer

There is no sweeper and no scheduler. The one recurring timer in the process is the Postgres
pool's idle-connection reaper, which closes sockets and issues no SQL. Everything else that looks
scheduled is either lazy or amortized on the write path:

- a lease does not expire, it is observed expired by the next `take`
- `available_at` does not fire; it stops a record being a take candidate until the DB clock passes
- retention GC runs every `gcEveryWrites` commits
- registry compaction runs every `compactEveryWritesPerKind` writes of that kind, because a global
  counter would walk every registry after somebody streamed a million chunks

An idle space therefore issues no queries. That is also why a far-future `availableAt` is refused
rather than accepted: retention GC never sweeps unclaimed claimable work, so such a record would
be litter no sweep can reach.
