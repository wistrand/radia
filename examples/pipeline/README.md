# Pipeline example

This deterministic example exercises content routing, competitive claims, fan-out, fan-in and
lineage through the public HTTP API. It requires no model provider.

A planner fans a `job` out into per-word `task`s, two workers claim only the ops they can handle,
and an aggregator reads the `result` facts and emits one `summary`.

```mermaid
flowchart LR
    C[coordinator] -->|put job| S[(space)]
    S -->|take job| P[planner]
    P -->|put task ×N| S
    S -->|"take {op: upper}"| W1[worker upper]
    S -->|"take {op: reverse}"| W2[worker reverse]
    W1 -->|ack result| S
    W2 -->|ack result| S
    S -->|read results| A[aggregator]
    A -->|put summary| S
```

## Run with the web console

```bash
deno task dev            # terminal 1: the space + web console at http://127.0.0.1:7788
deno task demo           # terminal 2: runs the agents against that space
```

Open http://127.0.0.1:7788 and select **Feed** before starting the demo. Open the resulting
`summary` record to inspect its lineage. If no space is running, the demo starts one and leaves it
available until interrupted.

## Run the self-contained smoke test

```bash
deno task demo:ci
```

This command starts an ephemeral space, runs the pipeline, prints the summary, events and lineage,
then shuts the space down. CI uses it as a wire-contract integration test.

## What it demonstrates

- **Content-routed coordination, no routing table.** `worker upper` and `worker reverse`
  each claim only `{kind:task, match:{op:...}}` that matches their tool.
- **Fan-out / fan-in.** The planner splits a `job` into per-word `task`s (fan-out); workers
  emit `result` facts; the aggregator reads them and emits one `summary` (fan-in).
- **Leases + at-least-once**, idempotent aggregation (`summary:<jobId>` key), the
  transactional **event log**, and a 4-level **lineage** tree (summary → results → tasks → job).
- **Claim vs. read.** Workers *take* tasks (claimed once, fenced); the aggregator *reads*
  results (facts, never consumed).

## Run each process separately

Point agents at a running space with `RADIA_URL` (default `http://127.0.0.1:7788`, matching the
host `radia dev` binds; the provisioned credential is keyed by host, so `localhost` is a different
space to anything looking one up):

```bash
deno task dev                                             # terminal 1: the space + web console
deno run --allow-net --allow-env examples/pipeline/planner.ts     # terminal 2
deno run --allow-net --allow-env examples/pipeline/worker.ts upper # terminal 3
deno run --allow-net --allow-env examples/pipeline/aggregator.ts  # terminal 4
deno run --allow-net --allow-env examples/pipeline/coordinator.ts "hello there world"  # seed + read
```

Watch it unfold live in the web console's **Feed** tab, and open a `summary` record to see
its lineage.

## Files

| File | Role |
|------|------|
| `tools.ts` | deterministic tools keyed by `op` |
| `kinds.ts` | registers the demo kinds |
| `worker.ts` | claims `{kind:task, match:{op}}`, runs the tool, emits a `result` |
| `planner.ts` | claims a `job`, fans out into `task`s |
| `aggregator.ts` | reads `result`s, emits a `summary` when a job is complete |
| `coordinator.ts` | seeds a job + a standalone task, reads outcomes |
| `demo.ts` | orchestrates all of the above in one process (`deno task demo`) |
