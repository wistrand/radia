# A local Jaeger for OTLP export

This Compose configuration runs Jaeger v2 so `radia otlp` has a collector to push to and a UI to
read traces in. Local development only: in-memory storage, no TLS. The exporter is a client
(`extensions/ts/otlp.ts`); the space knows nothing about OTel. The mapping (thread = trace,
lease attempt = span) is in [plan-inspection.md](../../agent_docs/plan-inspection.md) item 5.

```sh
# 1. the collector (Ctrl-C stops it and discards every trace)
docker compose up

# 2. a space with something running in it
deno task dev
deno task demo

# 3. export: everything from the tail onward, or one thread
radia otlp --to http://localhost:4318 --follow
radia otlp --to http://localhost:4318 --thread <recordId>

# 4. open http://localhost:16686
```

- `--to` is the collector's base URL; the exporter appends `/v1/traces`.
- Use the operator credential `radia dev` writes. A credential that cannot read `agent_run`
  records gets raw `run:<ulid>` ids as service names, and `radia otlp` says so on stderr.
- `--trace-root <kind>` cuts traces at the nearest ancestor of that kind. A chat conversation is
  one lineage root, so without `--trace-root message` the whole conversation is one trace.
- Re-exporting is safe: trace and span ids are derived from record ids, so Jaeger dedupes them.
- Any OTLP/HTTP collector (Tempo, Alloy, the otel-collector) works the same way; nothing here is
  Jaeger-specific beyond the image.
