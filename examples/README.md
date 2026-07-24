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

**Tools are discovered, not hard-coded, and their usage lives with them.** Each tool-worker
publishes its tools as `capability` records (`{tool, def}` — `def` carries the description the LLM
reads); the chatbot keeps a live tool set by *watching* them (`watch {kind:capability}`) and
dispatches by content (`tool_call{tool}` → whichever worker registered it). Add a tool-worker → its
capability record streams in and the chatbot gains the tool on the next turn, no code or prompt
change; how to *use* a tool is in its description, not the chat's system prompt. Like `kind_def`
records, a capability is content-keyed and immutable — a redefined tool is a **successor** record,
latest-per-tool wins on discovery (so re-running never conflicts). This is "no preconfigured
routing table" (§7) applied to tools — the substrate coordinating its own capabilities.

**Model selection is content-routing, and the routing is delegated to the substrate.** There are
three capability/cost **tiers** — `fast`, `balanced`, `deep` — each served by its own
inference-worker that claims only its tier's calls (`take {kind:llm_call, match:{tier}}`) and
advertises a `model` record. **The chat holds no routing logic:** it puts an *untiered* `llm_call`.
A **router-worker** (`chat/router.ts`) claims untiered calls (`match:{tier:{$exists:false}}`),
classifies the turn (a heuristic here — swap it for a classifier model without touching the chat),
and re-dispatches a *tiered* `llm_call`; the matching inference-worker serves it and supplies the
concrete model. The result stays keyed to the original call (`replyTo`), so the chat is oblivious
to the indirection — it just sees `[routed → deep]`. So both model-serving *and* the model-choice
are content-routed steps in the substrate; add a tier-worker → a new model is live, no orchestrator
change. Two models across three tiers by default (`fast`/`balanced` → `openai/gpt-4o-mini`, `deep`
→ `anthropic/claude-sonnet-5`); override per tier with `RADIA_CHAT_MODEL_{FAST,BALANCED,DEEP}` (e.g.
point `balanced` at a mid-tier model).

**Cheap-first, escalate on demand.** On top of routing there's a cost **cascade**: the model is
offered an `escalate` capability (a discovered tool — guidance in its description), and when it's
out of depth it calls `escalate`. The inference-worker *intercepts* that call and re-dispatches the
turn to the next-stronger tier (ordered by the `rank` on each `model` record), keyed to the same
original call — so the chat only ever sees the final answer and `[routed → deep]`. The top tier has
no escalation target (the tool is stripped, so it just answers), which terminates the cascade. So
the router *pre*-routes each turn and escalation *catches* an under-routed one; both are worker
behavior, and the chat is unchanged (it still puts an untiered call and reads one result).

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
so size/date questions get ground truth, not guesses), plus `time` and `calc`.

**Inspection tools** (`inspect.ts`) make the chatbot a conversational inspector of its own
space: `space_stats`, `space_kinds`, `space_query`, `space_record`, `space_lineage` (ancestors,
UP), `space_children` (records that reference this one, DOWN — e.g. a conversation's messages),
`space_events`, and `space_doctor` (a derived health report — stuck leases, dead-letters,
stale-available). Tool guidance lives in each tool's description (published as a `capability`
record), not in the chatbot's prompt. Because everything is a record, it can inspect *itself* — ask it "how many
records are in the space?", "show the lineage of the last summary", "is the space healthy?",
or "query my conversation thread" (the conversation is `kind:message` with your
`conversationId`). Output is size-capped so results are LLM-friendly, and each inspection is
itself a `tool_call` (a small observer effect).

**Remediation tools** (`remediate.ts`) turn it into an operator: `space_reclaim` (un-stick
an expired lease), `space_dead_letter`, `space_requeue` — control-plane operations that
bypass lease fencing (fixing another worker's stuck record), so they're privileged (grant-
gated with real auth). Pair with `space_doctor`: "find what's stuck and fix it," in chat.

**Run it with auth (`roles.ts`).** The launcher is the OPERATOR of its local space, so it
bootstraps the chain (design-auth): it registers kinds and, as operator, mints **least-privilege
run tokens** for the two workers (`agent:chat-inference` = take `llm_call`, put
`llm_result`/`llm_chunk`; `agent:chat-tools` = take `tool_call`, put `tool_result`/`capability`).
The **session role** picks who the REPL (and its `space_*` tools) run as:

```bash
deno task chat                       # role=admin (default): session is the OPERATOR
RADIA_CHAT_ROLE=user deno task chat  # role=user: session is a scoped agent:chat-user run token
```

As **admin** the `space_*` inspect/remediate tools have full `/ops/*` access. As a **user** the
session is `agent:chat-user` — granted only the conversational kinds — so it can chat, query its
own thread, and discover tools, but `space_stats`/`space_doctor`/`space_reclaim`/`declassify`
return **403** (try "is the space healthy?"), and `space_query {kind: grant}` is denied too. This
is the same enforcement the conformance suite covers, exercised by a real agent: workers are
least-privileged, the user is scoped, and the operator is the only principal on the control plane.

Config: `OPENROUTER_API_KEY`, `RADIA_CHAT_ROLE` (`admin`|`user`, or `--role`),
`RADIA_CHAT_MODEL_{FAST,BALANCED,DEEP}` (per-tier model overrides), `RADIA_CHAT_DIRS`, `RADIA_URL`.
(No tier setting — the router-worker picks the tier per turn.)

Honest edges (documented, not hidden): a crashed inference retries and can double-spend
(at-least-once — the gateway is the real fix); file contents become records and flow to the
model — taint now exists (a tool-worker could `put {taint:true}` on file reads so the untrust
propagates, and a sensitive consumer could `take {requireUntainted}`), though this example
doesn't wire it yet. The thread model makes Radia storage linear, but re-sending history to
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
| `chat/kinds.ts` | registers `conversation`/`message`/`llm_*` (llm_call indexed on `tier`)/`tool_*`/`capability`/`model` kinds |
| `chat/roles.ts` | least-privilege grant sets + bootstrap (mint worker/session run tokens; admin vs user) |
| `chat/router.ts` | router-worker: claims UNTIERED `llm_call`s, classifies the turn, re-dispatches a tiered call (`replyTo` keeps the result correlated) — routing delegated to the substrate |
| `chat/inference.ts` | per-tier inference-worker (`--tier`/`--model`/`--rank`): claims `{llm_call, tier}`, advertises a `model` record + the `escalate` capability, reconstructs the thread → OpenRouter (stream) → `llm_chunk` + `llm_result`; intercepts an `escalate` call and re-dispatches the turn to the next-stronger tier |
| `chat/toolworker.ts` | tool-worker: `tool_call` → sandboxed tool → `tool_result` (scoped perms) |
| `chat/tools.ts` | file/compute tool impls + JSON schemas + sandbox (realpath allowlist, `calc`) |
| `chat/inspect.ts` | space-inspection tools (`space_stats`/`query`/`lineage`/`events`/`doctor`, …) |
| `chat/remediate.ts` | remediation tools (`space_reclaim`/`dead_letter`/`requeue`) over the admin endpoints |
| `chat/openrouter.ts` | streaming OpenAI-compatible client (sole API-key holder's dep) |
