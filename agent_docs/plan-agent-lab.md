# Plan: an agent lab, so real harnesses can be run and mined without a human in the loop

**Status: PHASES 0, 1 AND 2 BUILT (0 and 1 on 2026-08-28, 2 on 2026-08-29).** Phases 3 and 4 planned. Written after four hand-run
sessions with Claude Code and Codex on one team space, which produced three code changes in two
days: the `$in`-on-array claim that answered nothing, settled tasks reported as available, and an
answer written as a separate put instead of riding the ack. Each was found by reading a pasted
transcript.

WHAT THE RUNS FOUND lives in [research-agent-sessions.md](research-agent-sessions.md); this doc is
the harness. Keeping them apart is deliberate: the lab's construction changes rarely and the
findings accumulate every run.

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
kind and each member's permissions into the run directory. **Permissions are collected by the
PRINCIPAL, `agent:<name>`, never the member name**: asking about a name nothing holds is not an
error, so the bare name answers `kinds: []` and reads as a member holding nothing (which is how
every run's permissions section was empty until 2026-08-29). The stale-binary problem was already
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
Two more hold the experiment together. The space runs `--auth required` (`run.ts`, `replay.ts`):
open mode resolves every member to the operator, and the scoping under observation stops existing.
And `team add` always passes `--rotate`, because a second definition for one agent is not a
rotation and looks exactly like one. The runner is a CLIENT throughout: it spawns the binary and
reads nothing private. The harnesses' non-interactive flags in the scenario file are VERIFIED BY
NOTHING here, since they change on somebody else's release schedule.

**Phase 1: `--trace`. BUILT.** `src/surfaces/mcp/trace.ts`, one JSONL line per tool call, written at
the single `tools/call` dispatch so a tool added later is traced without anybody remembering to.
`classify` is deliberately narrow: an empty array, `null`, and the two sentences the adapter itself
writes for "found nothing". Anything it cannot classify counts as `ok`, because over-reporting
`empty` puts false findings in front of a reader, which is the one failure that makes a lab worse
than no lab. Long arguments are truncated with their original length stated (`space_put_artifact`
carries base64 megabytes). A failed write disables tracing for the process and says so once, rather
than failing the call it observes. Guards: `test/trace.test.ts`.

**Scenario shape, as built.** An `agents[]` entry is a harness or, with `background: true`, a WORKER:
started before the others, never waited for, killed at the end, and gated on a readiness RECORD
(`readyWhen`) rather than a sleep, because a worker advertises what it serves and its own
`capability` record is the honest signal. A scenario also declares its own `kinds` (the operator
does it, since a member holds `kind_def: query` and never `put`) and per-agent `grants` /
`unscopedGrants`. That split is load-bearing: `sandbox` and `interest` carry no team, so a
team-scoped grant on them matches nothing and refuses every write. `scenarios/team-exec.json` is the
worked example, with `scripts/agent-lab/exec-worker.ts` as the third party that costs nothing to run
because it holds no model. A scenario may also SEED records the operator writes before any agent
starts (`seed`, written after the members because `team add` is what declares the team's kinds, with
the team label stamped so an unlabelled seed cannot become an invisible queue). Seeding is what a
CONTENTION scenario needs: `team-queue` puts five claimable tasks in front of both agents at once,
which is the only shape that measures leases rather than a handoff.

**Scenario shape, credentials.** An agent may declare `credential: "operator"`, and exactly one kind
of step needs it: `promote` writes grants and `bind` is the escalation root, so deploying a workspace
is not a member's to do. It is REFUSED on a harness, which is the lab's isolation rule stated as a
check rather than a convention. Everything else runs as its own member; a script gets its definition
token in the environment rather than on the command line, where `ps` would carry it.

**A run explains itself. BUILT 2026-08-29.** Every run writes `run.html` beside its evidence as it
finishes (`run.ts` calls the renderer, so no second command has to be remembered), and
`deno task lab-index ~/.radia-lab/*/` writes one page over a corpus: a card per scenario with runs,
how many had findings and the median duration, then a sortable row per run. Directories holding no
evidence are listed rather than dropped, since a set of 70 that quietly becomes 44 reads as though
the killed runs never happened. The page shows: the prompts each agent was given, the seeded work, a
verdict, every call on one clock, what happened to each claimed record, the findings, the mined
shape, and the agents' own words marked as the weakest source. It shares the loader and the CHECKS
with the text report, because two implementations of one verdict drift. It also needed something the
evidence did not have: a run directory recorded what HAPPENED and never what was ASKED, so
`scenario.json` is now written with the models resolved; older runs render without it and say so.

**Phase 2: the assertion pass. BUILT 2026-08-28.** `scripts/agent-lab/report.ts`,
`deno task lab-report <run-dir>…`: eight checks joining the trace against the space, ranked, with no
new instrumentation, because the event log already carries claim history per record and the traces
already carry what was asked for. One runner change was needed and it is the one that makes a bypass
detectable: `agent_run` is collected into `space.json`, since a record's `createdBy` is a RUN and an
untraced SDK worker appears in no trace, so "which participant wrote this" was unanswerable for
exactly the participant a bypass check is about. A check that cannot decide REPORTS that (`[n/a]`,
`[part]`) rather than passing, on the same rule as `classify` in the tracer: over-reporting puts
false findings in front of a reader. Several directories print RATES, which is the form a finding
takes here. Proved on planted violations: a run with the worker's records removed reports it silent while the
unplanted run does not, and one character changed inside an executed payload is caught by digest
against the artifact it descends from.

**Phase 3: replay in CI. BUILT 2026-08-29.** `scripts/agent-lab/replay.ts`, `deno task lab-replay
<run-dir>… [--source]`, and `scripts/agent-lab/replay.test.ts` for the CI half (`deno task test:lab`, kept OUT of `test:runtime` because a case here spawns a space and an adapter and costs a dozen seconds): a recorded trace with the
model stripped, re-issued through a real `radia mcp` against a space built from the same
`scenario.json`. Real runs DISCOVER; replays REGRESS, and a replay can never find new model
behaviour. A DRIVER rather than `fake-agent.ts` reading a trace, because a replay interleaves
several agents by timestamp and rebuilds arguments, which no single participant can do. The
verdict, the argument rebuilding and the coverage reporting are stated once, in `replay.ts`'s
header; the rule they serve is that only "was answered, now refuses or errors" fails, and anything
skipped or diverged is counted and named.

WHAT THE CORPUS CANNOT SEE: every recorded run passes `--session`, so the adapter resolves its
credential at startup and a bug that only bites an unsessioned process is outside replay's reach
(verified by planting the `health() → anonymous` defect: the replay stayed green). What it does
catch was proven the same way: a planted off-by-one in `ScopeFiller.choose` refuses a single-team
caller, and `space_save_workspace` came back REGRESSED with the refusal quoted.

**A settle names things no recorded id describes.** `claimId` carries a record the OPERATOR
seeded and a claim the adapter minted, so seeded records are mapped by BODY as they are written and
each take's claimId is remembered against the record it holds. An id the recording never held is a
LITERAL and travels untouched, since scenarios plant `01ZZZ…` for an agent to look up and a model
writes ids into its own prose. An ARTIFACT is paired by its content address, `space_put_artifact`
being the one write whose arguments carry no body. Measured across the three queue runs: mapping
settles took 20 skipped calls to 4, all four races the asymmetric verdict declines to fail on.

**A LOCAL FILE IS NOT EVIDENCE.** The
image scenario puts its artifact by PATH, naming a PNG the harness generated beside its own config;
that file does not travel with a run directory, so replayed anywhere else the call fails, and since
the recording answered `ok` it would be reported as a REGRESSION. A false finding from a missing
file is the one output that would make this worse than no replay. Such a call is SKIPPED and says
so, and the frozen image fixture carries a path that resolves on no machine at all, so the guard is
exercised rather than asserted.

**The corpus is frozen, in part.** `scripts/agent-lab/testdata/` holds the evidence half of six real
runs (traces, `space.json`, `tally.json`, the blobs, and `scenario.json` where the run is new enough
to have one), without the credential file, the logs, or the 28 MB PGlite directory beside them. 468 KB, and it is what lets `report.ts`'s eight checks and the replay run in CI at all: before it, both
ran only when somebody spent tokens, which is the one thing CI cannot do. `scripts/agent-lab/report.test.ts`
pins the checks against the run that produced the `space_nack` finding, so that finding's evidence
stops being re-derivable only by paying for another session.

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
- a nack-and-reclaim loop on one record: `maxAttempts` is 5, and a dead-letter emits no result
- a name-shaped field (`note.to`, `task.assignee`) whose value is not a live member
- the agent's own `report` record disagreeing with the space
- a task settled TWICE, or a task still claimed when every agent has exited (the adapter keeps a
  named session's claims, so an abandoned lease is invisible until it expires)
- a claim abandoned rather than released: no `space_release` or `space_nack` anywhere in a run whose
  work included something impossible
- code ALTERED between delivery and use: the sha256 of a payload carried by a record against the
  digest of the artifact it descends from (BUILT; both two-step runs passed their bytes through
  unchanged, 442 and 366)
- a `background` worker that AUTHORED NOTHING in a scenario built around it (the first `team-exec`
  run: a missing `tool_call` grant on the harnesses, two exit 0s, a correct answer, and the worker
  never invoked). The signal is a record it wrote, never `tally.json`: the tally counts MCP calls,
  and an SDK worker holds no adapter, so it reads 0 on a successful run too.

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

## A scenario with two roles has a startup race

Measured on the first `team-code` run: the worker claimed at 19s, found an empty queue, posted "no
work available" and exited at 36s; the requester wrote the task at 30s. Eleven seconds, and the run
produced a clean pair of exit 0s with nothing coordinated.

A harness spends anywhere from 10 seconds to a minute orienting itself before its first tool call,
and that spread is wider than the work in a cheap scenario. A one-shot `codex exec` is not a worker
loop. THE PROMPT IS WHERE THIS IS SETTLED, and the fix is the one a real agent wants anyway: tell
the worker to WAIT with `space_watch` rather than to report an empty queue. Seeding the task before
launch would also remove the race and removes the collaboration being measured with it.

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

## The launcher scenario (2026-09-05)

`scenarios/team-up.json` runs a member as a WORKER rather than a session: `radia team up` launches
`codex exec` only when the requester's task is claimed, with the worker's `team.json` written by the
runner's `files` field and the launched adapter traced through `trace`. Its readiness signal is the
`interest` record the loop publishes. Three runs found three defects in the launcher (a missing env
for the adapter, a double settle, a fence read from our own ack), each fixed the same day; the runs
are in research-agent-sessions.md.

## Read before

Building anything that observes agent behaviour, adding an event type to capture attempts, or
assuming `radia flows` can see why a claim came back empty.
