# Conformance suite

Port contracts, executed against every implementation. This is the only guard against drift — the
CLAUDE.md invariant that *embedded is never a semantically weaker cousin of Postgres*, applied to
each port the runtime depends on.

Two ports are under contract, and encryption is treated as an implementation of one of them rather
than a variant with a weaker contract:

```mermaid
flowchart LR
    S1[storage suites<br/>records · matching · leases · idempotency<br/>events · watches · faults · auth · taint · admin]
    S2[blob suites<br/>round-trip · content addressing<br/>path safety · delete · payload shapes]
    S3[blob-crypto suites<br/>ciphertext at rest · opaque paths<br/>wrong key · AAD · shredding]
    S1 --> A1[sqlite]
    S1 --> A2[pglite]
    S1 --> A3[postgres]
    S2 --> B1[memory]
    S2 --> B2[file]
    S2 --> B3["memory+enc"]
    S2 --> B4["file+enc"]
    S3 --> B4
```

```bash
deno task conformance                     # sqlite + pglite + the blob port   (177 tests)
scripts/pg-conformance.sh                 # + a live Postgres                 (adds ~71)
RADIA_PG_URL=postgres://… scripts/pg-conformance.sh   # against your own server
```

Without `RADIA_PG_URL`, `pg-conformance.sh` starts a throwaway Docker Postgres and removes it
afterwards. Each Postgres test runs in its own ephemeral schema, dropped on close, so it is safe
to point at a database you care about. (The Postgres run was last measured at 213 total, before
the blob suites existed; its storage half is what a live server adds.)

## Layout

| File | Role |
|------|------|
| `run.test.ts` | entry point: enumerates implementations, registers every suite against each |
| `harness.ts`  | the `Suite` / `BlobSuite` / `BlobCryptoSuite` types and setup/teardown. The only `Deno.test` binding in the repo |
| `suites/`     | one file per behavior area (records, matching, leases, idempotency, events, watches, faults, auth, taint, admin, blobs) |

## Writing a suite

A suite is a name plus a `run(...)` function; the harness runs it once per implementation. Assert on
observable behavior, never on a specific backend's SQL or on-disk layout — a test that only passes
on one implementation is testing the implementation, not the contract.

Three conventions worth copying rather than reinventing:

- **Simulate faults by composition, not test hooks.** A crashed worker is one that took a lease
  and never acked, with the lease forced expired via a negative `leaseSeconds`. Deterministic, no
  sleeps, and no test-only code paths in production. See `suites/faults.ts`.
- **Never assert on wall-clock timing.** All time comparisons use the database clock; a test that
  sleeps is a test that flakes in CI.
- **Keep crypto deterministic.** The blob-crypto suites use a fixed KEK, so a failure means a
  behavior change rather than a coin flip. Randomness stays inside the implementation (DEKs,
  nonces), never in the assertions.

Adding a behavior to `StorageAdapter` or `BlobStore` means adding it here in the same change. A
behavior is not done until it is green on every implementation of that port.
