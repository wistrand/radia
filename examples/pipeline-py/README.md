# Pipeline example, in Python

The [TypeScript pipeline](../pipeline/) ported onto the Python SDKs: `radia.py` (client +
`agent_loop`) for coordination, `radia_ext.py` (`radia.ext` from pip) for the extension HTTP
bindings. Same kinds, same shape, no model provider, and both SDKs are dependency-free, so the
only requirements are python3 and a running space.

A planner fans a `job` out into per-word `task`s, two workers claim only the ops they can handle,
and an aggregator reads the `result` facts and emits one `summary`. On top of the TS version the
workers advertise their tools as presence-policed capabilities, and the coordinator uses the
extension bindings instead of hand-rolled polling.

## Run with the web console

```bash
deno task dev -- --ext                   # terminal 1: space + console + /ext/ routes
python3 examples/pipeline-py/demo.py     # terminal 2: runs the agents against that space
```

The `--ext` flag co-hosts the extension bindings at `/ext/` on the space's port; without it the
capability, presence and turn calls have nothing to talk to and the demo says so. If no space is
running, the demo starts one (with `--ext`) and leaves it available until interrupted.

## Run the self-contained smoke test

```bash
python3 examples/pipeline-py/demo.py --once
```

Starts an ephemeral space, runs the pipeline, prints the summary, events and lineage, then shuts
the space down.

## What it adds over the TS pipeline

- **Liveness, not just advertisement.** Each worker publishes its op as a capability with
  `presence: true` and beats a short window. `coordinator.py` asks `tools` with that presence
  kind, so it lists only ops a live process backs. Kill a worker and its tool drops out within
  seconds, with nothing cleaning up after it.
- **Seed-and-wait for the direct answer.** The standalone task goes through
  `ext.seed("pipeline_task", ..., result_kind="pipeline_result")`: one call writes the record and long-polls the
  child that answers it, the shape a tool call has. The job's summary is three links downstream,
  past what seed-and-wait covers, so the coordinator reads it by content (`jobId`), the same
  field the aggregator grouped the results by.

## Run each process separately

```bash
deno task dev -- --ext                                      # terminal 1
python3 examples/pipeline-py/planner.py                     # terminal 2
python3 examples/pipeline-py/worker.py upper                # terminal 3
python3 examples/pipeline-py/worker.py reverse              # terminal 4
python3 examples/pipeline-py/aggregator.py                  # terminal 5
python3 examples/pipeline-py/coordinator.py "hello there"   # seed + read
```

Point at another space with `RADIA_URL`; the credential resolves like every client's (RADIA_TOKEN,
else the file `radia dev` provisioned for that base).

The demo bootstraps as the operator and shares the TS pipeline's kind names, prefixed
`pipeline_*` so they collide with nobody's `task` or `job` on a shared space. Should a space
still declare one of them differently, the demo passes the runtime's refusal on rather than
superseding a live declaration.

## Files

| File | Role |
|------|------|
| `common.py` | SDK imports for both layouts (pip package / checkout), tools, kind registration |
| `worker.py` | claims `{kind:pipeline_task, match:{op}}`, runs the tool, emits a `result`; advertises + beats |
| `planner.py` | claims a `job`, fans out into `task`s |
| `aggregator.py` | reads `result`s, emits a `summary` when a job is complete |
| `coordinator.py` | lists live tools, seeds work through `turn/v1/seed`, prints the answers |
| `demo.py` | orchestrates all of the above in one process |
