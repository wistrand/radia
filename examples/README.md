# Radia examples

Deterministic demo agents that exercise the runtime the way a real agent would — over the
public HTTP API, via the TS SDK stub in [`../sdk/ts`](../sdk/ts). No LLM keys, no
flakiness; the seam where a tool runs (`examples/tools.ts`) is where a real agent would
call a model.

## Watch it in the web console

```bash
deno task dev            # terminal 1: the space + web console at http://localhost:7788
deno task demo           # terminal 2: runs the agents against that space
```

Open http://localhost:7788, go to the **Feed** tab, then run `deno task demo`. It detects
the running space, runs a planner + two workers + an aggregator against it, and you watch
the events stream in live; open the `summary` record to see its lineage. (If no space is
running, `demo` starts one and leaves it up so you can open it — Ctrl-C to stop.)

## One command, self-contained (CI)

```bash
deno task demo:ci
```

Spawns an ephemeral `radia dev`, runs the whole pipeline, prints the summary + event log +
lineage, and exits. An integration smoke test of the wire contract — nothing to watch, it
tears down.

## What it demonstrates

- **Content-routed coordination, no routing table.** `worker upper` and `worker reverse`
  each claim only `{kind:task, match:{op:...}}` that matches their tool.
- **Fan-out / fan-in.** The planner splits a `job` into per-word `task`s (fan-out); workers
  emit `result` facts; the aggregator reads them and emits one `summary` (fan-in).
- **Leases + at-least-once**, idempotent aggregation (`summary:<jobId>` key), the
  transactional **event log**, and a 4-level **lineage** tree (summary → results → tasks → job).
- **Claim vs. read.** Workers *take* tasks (claimed once, fenced); the aggregator *reads*
  results (facts, never consumed).

## Running the pieces separately (the two-terminal experience)

Point agents at a running space with `RADIA_URL` (default `http://localhost:7788`):

```bash
deno task dev                                             # terminal 1: the space + web console
deno run --allow-net --allow-env examples/planner.ts     # terminal 2
deno run --allow-net --allow-env examples/worker.ts upper # terminal 3
deno run --allow-net --allow-env examples/aggregator.ts  # terminal 4
deno run --allow-net --allow-env examples/coordinator.ts "hello there world"  # seed + read
```

Watch it unfold live in the web console's **Feed** tab, and open a `summary` record to see
its lineage.

## CLI chatbot (`chat/`) — a real LLM agent, full symmetry

A CLI chatbot where **the whole conversation lives on the blackboard**. The chatbot makes
no external calls — it only reads and writes records. LLM inference (`llm_call →
llm_result`, streamed as `llm_chunk`) and tools (`tool_call → tool_result`) are both served
by content-routed workers.

The conversation is an **append-only thread of `message` records** anchored to a
`conversation` record — not a client-held array. The chatbot appends messages (system /
user / assistant / tool); an `llm_call` references the thread by `{conversationId,
upToIndex}` and the **inference-worker reconstructs the context by querying the thread**
(`{kind:message, match:{conversationId}, orderBy:index}`). Consequences: history is stored
once (linear, not quadratic — no re-embedding), the whole conversation is reconstructible
from the space (`query` the thread), and every message is a record you can watch in the
Feed. This is the blackboard shared-memory pattern, not just content-routed dispatch.

```bash
export OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/keys
deno task dev                                # optional: open http://localhost:7788, Feed tab
deno task chat                               # connects to 7788 (or spawns its own space)
```

`deno task chat` connects to (or spawns) a space and launches two **scoped subprocess**
workers, then gives you a REPL. Watch every thought and action stream into the Feed tab.

Why subprocesses: permission isolation only holds across processes.

- **inference-worker** — `--allow-net --allow-env`; holds `OPENROUTER_API_KEY`; no file access.
- **tool-worker** — `--allow-read=<sandbox dirs>` and `--allow-net=127.0.0.1:<port>` only,
  **no `--allow-env`**. The process that can read files cannot reach the network beyond the
  local space and cannot read secrets, so reading a file can't lead to exfiltrating it.
  Path canonicalization (realpath + allowlist, in `tools.ts`) is defense-in-depth on top.

Tools: `read_file`, `list_files`, `search_files`, `stat` (sandboxed to `RADIA_CHAT_DIRS`,
default `examples/chat/sandbox`; `list_files`/`read_file`/`stat` return `size` + `modified`
so size/date questions get ground truth, not guesses), plus `time` and `calc`. Config:
`OPENROUTER_API_KEY`,
`RADIA_CHAT_MODEL` (default `openai/gpt-4o-mini`), `RADIA_CHAT_DIRS`, `RADIA_URL`.

Honest edges (documented, not hidden): a crashed inference retries and can double-spend
(at-least-once — the gateway is the real fix); file contents become records and flow to the
model (taint, M3). The thread model makes Radia storage linear, but re-sending history to
the provider each call is inherent to stateless chat APIs (prompt caching mitigates it,
provider-side), and a large single message (e.g. a 64 KB file read) is still one big record
until **artifacts** (§2.4, M1) let it be stored once and referenced. Not a CI test
(non-deterministic); `calc` and the sandbox path checks are unit-testable.

## Files

| File | Role |
|------|------|
| `../sdk/ts/client.ts` | `RadiaClient` — fetch wrappers over `/v0` (the TS SDK stub) |
| `../sdk/ts/loop.ts` | `agentLoop` — take → handle → ack/nack with heartbeat (design §5) |
| `tools.ts` | deterministic tools keyed by `op` |
| `kinds.ts` | registers the demo kinds |
| `worker.ts` | claims `{kind:task, match:{op}}`, runs the tool, emits a `result` |
| `planner.ts` | claims a `job`, fans out into `task`s |
| `aggregator.ts` | reads `result`s, emits a `summary` when a job is complete |
| `coordinator.ts` | seeds a job + a standalone task, reads outcomes |
| `demo.ts` | orchestrates all of the above in one process (`deno task demo`) |
| `chat/chat.ts` | CLI chatbot (pure record I/O); appends the `message` thread, spawns scoped workers, runs the REPL |
| `chat/kinds.ts` | registers `conversation`/`message`/`llm_*`/`tool_*` kinds |
| `chat/inference.ts` | inference-worker: reconstructs the thread from `message` records → OpenRouter (stream) → `llm_chunk` + `llm_result` |
| `chat/toolworker.ts` | tool-worker: `tool_call` → sandboxed tool → `tool_result` (scoped perms) |
| `chat/tools.ts` | tool impls + JSON schemas + sandbox (realpath allowlist, `calc`) |
| `chat/openrouter.ts` | streaming OpenAI-compatible client (sole API-key holder's dep) |
