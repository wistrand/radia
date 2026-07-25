# Conformance suite

The `StorageAdapter` contract, executed against every adapter. This is the only guard against
storage-adapter drift — the CLAUDE.md invariant that *embedded is never a semantically weaker
cousin of Postgres*.

```bash
deno task conformance                     # sqlite + pglite            (142 tests)
scripts/pg-conformance.sh                 # + a live Postgres          (213 tests)
RADIA_PG_URL=postgres://… scripts/pg-conformance.sh   # against your own server
```

Without `RADIA_PG_URL`, `pg-conformance.sh` starts a throwaway Docker Postgres and removes it
afterwards. Each Postgres test runs in its own ephemeral schema, dropped on close, so it is safe
to point at a database you care about.

## Layout

| File | Role |
|------|------|
| `run.test.ts` | entry point: enumerates adapters, registers every suite against each |
| `harness.ts`  | the `Suite` type and adapter setup/teardown. The only `Deno.test` binding in the repo |
| `suites/`     | one file per behavior area (records, matching, leases, idempotency, events, watches, faults, auth, taint, diagnostics) |

## Writing a suite

A suite is a name plus a `run(adapter)` function; the harness runs it once per adapter. Assert on
observable adapter behavior, never on a specific backend's SQL — a test that only passes on one
adapter is testing the implementation, not the contract.

Two conventions worth copying rather than reinventing:

- **Simulate faults by composition, not test hooks.** A crashed worker is one that took a lease
  and never acked, with the lease forced expired via a negative `leaseSeconds`. Deterministic, no
  sleeps, and no test-only code paths in production. See `suites/faults.ts`.
- **Never assert on wall-clock timing.** All time comparisons use the database clock; a test that
  sleeps is a test that flakes in CI.

Adding a behavior to `StorageAdapter` means adding it here in the same change. A behavior is not
done until it is green on every adapter.
