# Plan: an agent lab, so real harnesses can be run and mined without a human in the loop

**Status: PHASES 0 AND 1 BUILT 2026-08-28.** Phases 2 to 4 planned. Written after four hand-run
sessions with Claude Code and Codex on one team space, which produced three code changes in two
days: the `$in`-on-array claim that answered nothing, settled tasks reported as available, and an
answer written as a separate put instead of riding the ack. Each was found by reading a pasted
transcript.

Built: the runner (`scripts/agent-lab/`, `deno task lab`) and `radia mcp --trace`
(`src/surfaces/mcp/trace.ts`). Proved on a live space by driving the adapter over stdio: a `put` of
a task tagged `["image"]`, then a claim with `{tags: {$in: ["image"]}}`, which the trace recorded as
`"outcome":"empty"` with the pattern verbatim while the record stood available. The same claim with
`{$any: "image"}` recorded `"ok"`. That is the Codex session's failure reproduced as two lines of
data with no transcript in the loop.

The goal is to stop pasting transcripts, not to replace review. A run should end with a directory of
evidence and a ranked list of findings, and a rerun against a new binary should say what changed.

## The finding that decides the design

**The space records what an agent DID, never what it TRIED.** A `take` appends its event only after
it wins a record (`src/storage/sqlite.ts`, `src/storage/pgbase.ts`: the append sits below the
`won === 0` continue), and reads emit no events at all. So a claim that matched nothing is invisible
to the event log, to lineage, and to flow mining.

That is not a defect to fix. An event log of attempts would be unbounded, caller-controlled and
mostly noise. It is a statement about where the evidence has to come from, and the four sessions
sort cleanly by it:

| Finding | In the space | In the request stream | In the model's prose |
|-----------------------------------------------|---|---|---|
| answer written as a put, then a bare ack       | yes | | |
| `to: "claude-alpha"` where the principal is `agent:claude-alpha` | yes | | |
| a task's shape copied from a neighbouring record | yes | | |
| `{tags: {$in: […]}}` claimed nothing           | | yes | |
| whether `space_kinds` was called before writing | | yes | |
| `space_stats` refused (observe is opt-in)      | | yes | |
| "3 available tasks" when two were settled      | | | yes |
| "check tasks" searched the filesystem          | | | yes |

Flow mining covers the first third. It would have caught none of the three findings that changed
code.

## Three sources

**The space, free today.** `radia flows --json`, `radia events`, a query per kind, `ops/diagnostics`,
and `radia otlp --to <collector>` for a run as a trace timeline. The question it answers well is
*which shapes emerged and did they change*: `FlowShape` (`sdk/ts/wire.ts`) carries `successRate`,
durations and `exemplars`, so a diff across runs points at the records behind a regression. Treat it
as the cross-run comparator, never as the detector.

**The request stream, one small change and it is ours.** Every tool call passes one dispatch in
`src/surfaces/mcp/server.ts`. A `radia mcp --trace <file>` writing one JSONL line per call (ts,
session, principal, tool, arguments, outcome class, error code, duration) turns the middle column
into data. Writes go through `src/platform.ts` like everything else.

TRACE TO A FILE, NOT INTO THE SPACE UNDER TEST. Records would be the doctrinal choice and are the
wrong one here: the space is the instrument, and trace records would appear in its own flows, stats,
event chain and registry budgets. Import the JSONL into a SECOND space afterwards if queryable
traces are wanted; that keeps both properties.

**The model's prose, expensive and unreliable, mostly avoidable.** Rather than judging a final
message, end each scenario with "write a `report` note stating how many tasks are open and which".
The conclusion becomes a record, and comparing it to `ops/records?state=available` needs no judge.
That converts most of the third column into the first.

## Phases

**Phase 0: the runner. BUILT, no runtime change.** `scripts/agent-lab/`, `deno task lab`: compile,
start a space on an isolated `RADIA_DIR` with a persistent `--db` so a run can be post-mortemed,
`radia team add --rotate --json` per agent, write each agent's MCP config into its own working
directory, launch each harness with the prompt on stdin, then dump flows, stats, events, a query per
kind and each member's permissions into the run directory. The stale-binary problem was already
solved upstream: `src/surfaces/mcp/config.ts` names the binary that wrote the config, absolute, so
recompiling before `team add` is the whole of it. The harnesses' own non-interactive flags live in
the scenario file, because they change on somebody else's release schedule; the two shipped were
read off `--help` on 2026-08-28 and are templated (`{{config}}`, `{{mcpArgs}}`, `{{token}}`),
because Claude Code takes an MCP server as a FILE and Codex takes it on the COMMAND LINE, so a
scenario that hardcoded either would serve one harness only.

RUNS LAND OUTSIDE THE REPO. Claude Code walks up from its working directory collecting `CLAUDE.md`,
so a run under `radia/runs/` hands every lab agent 500 lines about this codebase and stops measuring
what a naive agent does. Both harnesses also need their own config ISOLATED from the operator's
(`--strict-mcp-config`, `--ignore-user-config`), or a lab agent loads the Radia server you use and
the run reaches your real space.

ISOLATION COSTS THE APPROVALS TOO, which is the trap in it. Codex refuses an MCP call that is not
pre-approved BY TOOL, and an isolated session starts with none: the first real run answered "MCP
tool call requires approval, but approval policy is never", spent 85k tokens and made zero calls,
while the same harness worked interactively because a person had clicked through those approvals
into `~/.codex/config.toml` months earlier. The runner now asks the BINARY for its tool list over
stdio and expands it into per-tool approvals, so a tool added later is covered without editing a
scenario. Generalises past Codex: a harness's own permission layer is part of the experiment's
setup, and it is invisible until it refuses.

TWO ISOLATION RULES, both learned by breaking them on the first run. Every CLI call carries
`--url`, or a setup verb targets `defaultBase()`, which on a developer's machine is their own
`radia dev`: the first dry run sent `team add --rotate` there and was refused only because
`RADIA_CREDENTIALS` had already been redirected. And `RADIA_TOKEN` is dropped from every child, or
it overrides each member's definition token and every agent acts as whoever started the lab.

**Phase 1: `--trace`. BUILT.** `src/surfaces/mcp/trace.ts`, one JSONL line per tool call, written at
the single `tools/call` dispatch so a tool added later is traced without anybody remembering to.
`classify` is deliberately narrow: an empty array, `null`, and the two sentences the adapter itself
writes for "found nothing". Anything it cannot classify counts as `ok`, because over-reporting
`empty` puts false findings in front of a reader, which is the one failure that makes a lab worse
than no lab. Long arguments are truncated with their original length stated (`space_put_artifact`
carries base64 megabytes). A failed write disables tracing for the process and says so once, rather
than failing the call it observes. Guards: `test/trace.test.ts`.

**Phase 2: the assertion pass.** A script joining trace against space, printing ranked findings. The
catalogue below is derived from the four sessions and is what makes a run self-reporting.

**Phase 3: replay in CI.** A recorded trace with the model stripped, replayed against a fresh
binary, no API key, the same move `examples/chat/smoke-turnlink.ts` already makes for the chat.
Real runs DISCOVER; replays REGRESS. A replay can never find new model behaviour. Its seed is built:
`scripts/agent-lab/fake-agent.ts` is a harness with no model, speaking JSON-RPC to the adapter with
a fixed call sequence; phase 3 is that file reading its script from a recorded trace instead of
carrying one. The `smoke` scenario runs two of them and is what answers "is the lab wired up"
without spending a token.

**Phase 4: diffing runs.** The point of the exercise: "the new build changed how agents behave" as a
report rather than a read.

## The assertion catalogue

Each line is a finding seen in a real session, stated as something a script can compute:

- a `take` returned nothing while a record of that kind stood `available` (the `$in` bug and every
  future variant)
- a session wrote to a kind whose `space_kinds` it never read (2-for-2 predictor of the above)
- a claim that never settled: an `expire` or `release` in the event log
- an answer that did not ride the ack: a result record whose put precedes the ack rather than being
  performed by it
- a 403 in the trace: each one is either a missing grant or a model error, and both are findings
- a name-shaped field (`note.to`, `task.assignee`) whose value is not a live member
- the agent's own `report` record disagreeing with the space

## Traps the runner will hit, all of them rules that already exist

- **A second definition is not a rotation.** Run 2 calling `team add alice` again is refused; the
  fix is `--rotate`, or storing run 1's token. This breaks first.
- **One member per session.** Two harnesses on one credential are one principal, so nothing tells
  their work apart. Each scripted agent needs its own name, its own directory, and a local-scoped
  config.
- **One writer per database.** A stale space from the previous run holds the advisory lock. The
  runner owns the lifecycle, and a per-run `RADIA_DIR` keeps the `.radia-*` siblings from returning.
- **Auth posture.** In open mode every member is the operator and the scoping under observation
  stops existing. The lab runs authenticated.
- **`--session`** on the adapter if a claim must survive an adapter restart mid-scenario.

## Findings are rates, not booleans

The `$in` failure appeared in one of two Codex sessions, and the difference was whether
`space_kinds` had been called first. A single run is an anecdote. Each scenario runs k times and the
report gives frequencies, or the lab will chase a bug a rerun "fixes" and ship a regression a rerun
hides. This also sets the cost model: real models per run, so Phase 3's replays carry CI and the
real runs are scheduled.

## Rejected

- **Scenario-as-records** (a `scenario` kind, a runner claiming them). Doctrinally attractive and
  wrong here: it puts the experiment inside the instrument, which is the observer effect the trace
  decision above already avoids.
- **Assertions over transcript prose.** Brittle against wording, and unnecessary once the agent's
  conclusion is a record.
- **Teaching the runtime about the lab.** It is a client. `scripts/`, importing the SDK, never
  `src/`. `--trace` is the single exception and it lives in a surface.

## Read before

Building anything that observes agent behaviour, adding an event type to capture attempts, or
assuming `radia flows` can see why a claim came back empty.
