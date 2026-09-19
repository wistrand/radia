# The cluster benchmark's database side

A Postgres primary, a streaming standby (`standby1`, cloned with `pg_basebackup`) and an S3 endpoint,
for the cluster and failover benchmark ([plan-cluster-bench.md](../../agent_docs/plan-cluster-bench.md)).
Not a deployment recipe: one host, no TLS, throwaway credentials, every port ephemeral.

It is not meant to be brought up by hand. `bench/cluster/cluster.ts` starts it under a project name
unique to the run, starts the Radia instances on the host and the proxy they reach Postgres through,
switches the primary to synchronous replication once the standby streams, and removes all of it:

```sh
deno run -A bench/cluster/run.ts check              # up, verify every part, down, twice
deno run -A bench/cluster/run.ts check --async      # the asynchronous control arm
```

Two settings are deliberate and look like mistakes:

- **`synchronous_standby_names` is not on the primary's command line.** The image's init-time
  server takes the same flags, and the init script's first commit then waits for a standby that
  cannot exist yet. The harness sets it with `alter system` after the standby streams.
- **The S3 container has a 1s stop grace.** SeaweedFS `server` mode does not exit on SIGTERM, so
  every teardown otherwise waited out docker's 10s default. Its bytes are discarded with the volume.
