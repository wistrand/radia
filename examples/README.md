# Radia examples

Three examples, in increasing order of how much of the runtime they touch. Each has its own
directory and README; start with whichever question you have.

| Example | What it shows | Needs a key? |
|---------|---------------|--------------|
| [`pipeline/`](pipeline/) | Content-routed coordination with no routing table: a job fans out into tasks, workers claim only what matches their pattern, an aggregator fans the results back in. Leases, at-least-once, the event log, a 4-level lineage tree. | no |
| [`stress/`](stress/) | What a busy space looks like. Waves of activity — poison records retrying into `dead_letter`, abandoned leases, per-op worker agents — to watch develop in the console's **Space** tab. | no |
| [`chat/`](chat/) | The full end-to-end exercise: an LLM agent whose thinking, tool calls, images, saved files and sandboxed code execution are *all* records, served by six least-privilege worker processes with real auth roles. | yes |

```bash
deno task dev      # a space + web console at http://localhost:7788

deno task demo     # pipeline: planner + workers + aggregator against that space
deno task stress   # stress:   fill the space with waves of activity
deno task chat     # chat:     the LLM agent (needs OPENROUTER_API_KEY)
```

Every example talks to the space over the public `/v0` API through the SDK in
[`../sdk/ts`](../sdk/ts) — none of them imports from `src/`. That is deliberate: they model what an
external agent author writes, so anything they can do, your code can do too.

## What each one is for

**`pipeline/`** is the one to read first, and the only one that runs in CI (`deno task demo:ci`).
It is deterministic and keyless, so it doubles as an integration smoke test of the wire contract.

**`stress/`** exists because the Space tab is hard to judge on an empty space. It also exercises
the parts of the runtime that only appear under load: retry churn, dead-lettering, stuck leases.

**`chat/`** is where the design claims get tested against something real. If a coordination
primitive is awkward, this is where it shows: model choice is delegated to a router-worker, tools
are discovered from `capability` records rather than configured, payloads become artifacts instead
of travelling inside records, and every worker runs with the narrowest permissions that let it
work.
