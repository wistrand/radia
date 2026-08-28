# agent-lab

Run real MCP harnesses against a fresh binary on a script, and keep what they did.

Phase 0 and 1 of [plan-agent-lab.md](../../agent_docs/plan-agent-lab.md). Phase 0 is this runner and
changes nothing in the runtime. Phase 1 is `radia mcp --trace`, which is the only place an agent's
ATTEMPTS are recorded: a `take` appends its event only after it wins a record, so a claim that
matched nothing is invisible to the event log, to lineage and to `radia flows`.

```
deno task compile                 # the lab runs the BINARY, so the config names it
deno task lab                     # default scenario, free port, ~/.radia-lab/<name>-<ts>
deno task lab -- --dry-run        # space + members up, nothing launched: prints each command
deno task lab -- --out ~/lab/x --keep     # a free port is chosen unless --port says otherwise
deno task lab -- --scenario scripts/agent-lab/scenarios/smoke.json   # no model, no API key
```

## The scenarios

| scenario | costs | asks |
|---------------|--------------|--------------------------------------------------------|
| `smoke` | nothing | two model-free harnesses, for checking the plumbing |
| `team-code` (default) | a few cents | one agent asks the other for a TypeScript program that sums the first 1000 primes |
| `team-image` | ~$1 | the same shape with a generated image as the deliverable |
| `team-exec` | a few cents | the same request with a THIRD party present: a model-free worker advertising `run_javascript`, so the answer can be computed rather than reasoned |
| `team-exec-twostep` | a few cents | the same cast, with the execution moved to the REQUESTER: the worker is asked for source only, and the agent that wrote the task fetches the artifact and dispatches the `tool_call` itself |
| `team-queue` | a few cents | CONTENTION: five seeded tasks, no requester, both agents claiming the same queue at once. One of the five cannot be done |

**Every producer/consumer scenario has a startup race, and the prompt is where it is settled.** A
harness spends between 10 seconds and a minute orienting itself before its first tool call, and the
spread is wider than the work: measured, the worker claimed at 19s, found an empty queue, posted "no
work available" and exited at 36s, while the requester wrote the task at 30s. A one-shot `codex
exec` is not a worker loop. So the worker prompt says to WAIT with `space_watch` rather than to
report an empty queue, which is what a real agent does anyway and exercises the blocking read.

**`team-code` deliberately never says "artifact".** The requester asks for a program and the worker
is told only to do whatever work is waiting; whether the answer arrives as an artifact, as prose in
a note, or not at all is the finding. The kinds and the tools are all the agents are given, and what
they do with `space_put_artifact` when nobody named it is exactly what the lab is for.

**`team-exec-twostep` moves the execution to the requester**, so the deliverable has to survive a
handoff: the worker answers with source in an artifact, and the agent that wrote the task fetches it
and dispatches the `tool_call`. Two things are under observation and neither is prompted for by
name. The requester is told to check what the space can execute BEFORE deciding what to ask for,
because `run_javascript` feeds the program on stdin under `--ext=js` (`extensions/ts/sandbox.ts`),
so asking for TypeScript out of habit yields a syntax error rather than a number. And the worker is
told to do what it was asked and nothing more, on a space where it holds the grants to run the code
itself; whether it stops at the source is the finding.

**`team-queue` is the only scenario with no handoff**, and the only one whose work is SEEDED: a
`seed` array the operator writes before any agent starts, so a known number of claimable records is
in front of both agents from the first second. Every other scenario has one agent write what the
other claims, which buys a realistic handoff and pays for it with the startup race. Leases are what
the runtime exists for and nothing had exercised them, so this is the run to read for: every task
settled exactly once, nothing still claimed at the end (the lab passes `--session`, so the adapter
KEEPS claims on exit and an agent that stops holding a lease leaves work invisible until it
expires), whether `space_release` or `space_nack` is called at all (no recorded session has used
either), and what `leaseSeconds` an agent picks when the work has a knowable length. The fifth task
names a record id that does not exist, so it also answers what an agent does with work it cannot
complete: nack, ack with a failure, or abandon the claim.

The seed's `team` label is stamped by the runner. A member's grants are pattern-scoped to its team
and there is no unlabelled lane, so an unlabelled seed is invisible to everyone and reads as an
empty queue; a body naming its own `team` still wins, which is how an isolation scenario would seed
work nobody in the run can see.

**A `background: true` agent is a worker, not a harness.** It starts before the others, is never
waited for, and is killed when the run ends. Readiness is a RECORD (`readyWhen`) rather than a
sleep, because a worker advertises what it serves and its own `capability` record is the honest
signal that it is up. `team-exec` is the worked example: `exec-worker.ts` (about 60 lines over
`serveTools` and `execTools`) picks a jail, PROBES it, declares what it guarantees as a `sandbox`
record and serves `run_javascript`. It holds no model, so it costs nothing per run, and it is the
first publisher of a `capability` on a lab space, which is what turns "an agent discovers a tool
from records and dispatches by content" into something a run either does or does not do.

A scenario also declares its own `kinds` (the operator does, since a member holds `kind_def: query`
and never `put`) and per-agent `grants` / `unscopedGrants`. That split is load-bearing: `sandbox`
and `interest` carry no team, so a team-scoped grant on them matches nothing and refuses every
write.

Start with `smoke.json`. It runs two `fake-agent.ts` harnesses, which speak JSON-RPC to the adapter
with no model behind them, so it answers "is my lab wired up" in three seconds and for nothing. Its
fixed call sequence is the one a real session got wrong: claim by `$in` on an array path, then by
`$any`. A run whose trace does not show `empty` then `ok` is a runner that is not recording what it
says it records.

Output is live, one line per event:

```
   0s fake-a | calling space_take        | the harness's stdout
   2s fake-a → space_take empty 38ms     → a tool call reaching the space
   2s fake-a → space_take ok 69ms        ! would be its stderr
```

The `→` lines are the ones to watch. A harness that has not made a call yet is starting up or stuck
on its own side, and no transcript can tell you which; `claude -p --output-format json` prints once,
at the end, so without this a working three-minute run and a wedged one look identical.

Runs land OUTSIDE the repo on purpose. Claude Code walks up from its working directory collecting
`CLAUDE.md`, so a run under `radia/runs/` hands every lab agent 500 lines about this codebase and
stops measuring what a naive agent does.

## What a run leaves behind

```
~/.radia-lab/<scenario>-<ts>/
  space/                 the database, so a fifth query needs no rerun
  space.json             flows, stats, events, every record, every member's permissions
  space.log space.err    the space's own output
  credentials.json       this run's credentials, never the ones you use
  tally.json             models asked and reported, exit codes, calls/empties/refusals per agent
  <agent>/.mcp.json      the config that harness was given
  <agent>/trace.jsonl    one line per tool call: what the model ASKED FOR
  <agent>/stdout.log     what the harness said
```

## The scenario file

`agents[]` carries the harness argv, because those flags change on somebody else's release
schedule. The prompt goes in on stdin, so a multi-line prompt needs no shell quoting. The argv is
templated with this run's values, which is what lets one scenario serve two harnesses that take an
MCP server two different ways:

| placeholder    | is                                                          |
|----------------|-------------------------------------------------------------|
| `{{model}}`    | the model this agent runs (see below); the flag is DROPPED when none is set |
| `{{config}}`   | the MCP config file this runner wrote for that agent        |
| `{{binary}}`   | the absolute binary the adapter runs as                     |
| `{{mcpArgs}}`  | its argv as a JSON/TOML array, `--session` and `--trace` included |
| `{{token}}`    | that member's definition token                              |
| `{{codexTools}}` | every advertised tool pre-approved, as a TOML inline table |
| `{{url}}` `{{trace}}` `{{session}}` `{{dir}}` | the space, the trace file, the session name, the working directory |

The two shipped commands were read off `claude --help` and `codex --help` on 2026-08-28:

- **Claude Code** takes a config FILE: `-p --mcp-config {{config}} --strict-mcp-config
  --allowedTools mcp__radia --output-format json`. `--strict-mcp-config` is not optional here: it is
  what stops the lab agent also loading the MCP servers you use, including your own Radia.
- **Codex** takes config on the COMMAND LINE: `exec - --json --skip-git-repo-check
  --ignore-user-config -c mcp_servers.radia.command={{binary}} -c
  mcp_servers.radia.args={{mcpArgs}} -c mcp_servers.radia.tools={{codexTools}}`.
  `--ignore-user-config` is the same isolation, and auth still resolves through `CODEX_HOME`, so a
  logged-in Codex stays logged in. `--skip-git-repo-check` because a run directory is not a
  repository.

**The model is a variable of the experiment, so it is templated rather than appended.** The flag
differs per harness (`--model` for Claude Code, `-m` for Codex) and harness argv is the one thing
this runner deliberately does not know, so the scenario writes `{{model}}` into its own command. The
shipped scenarios default to `opus` and `gpt-5.6-luna`; `--model <name>` moves every agent and
`--model <agent>=<name>` moves one, repeatable, which is what a PAIRED run needs: same scenario,
same day, one arm held fixed.

```
deno task lab -- --scenario …/team-queue.json --model claude-lab=sonnet
```

An unset model DROPS the flag pair rather than passing an empty argument, so "no model named" keeps
meaning what it meant before this existed: the harness picks. A `--model` naming an agent the
scenario does not have is refused, since it would otherwise run on the default while the evidence
claimed a model that was never asked for.

`tally.json` records `models.asked` and `models.reported` separately. They differ: an alias resolves
on the vendor's side, and a fallback can substitute a model mid-run without changing the argv. Claude
Code names what it used in its final JSON; Codex names none, and an absent value is recorded absent
rather than assumed to be the ask.

**Codex refuses an MCP call that is not pre-approved BY TOOL**, and an isolated session starts with
no approvals, so the first real run answered "MCP tool call requires approval, but approval policy
is never", spent 85k tokens and made zero calls. `{{codexTools}}` is the fix: the runner asks the
binary for its tool list over stdio and expands it into
`{ space_kinds = { approval_mode = "approve" }, … }`, so a tool added later is approved without
anybody editing a scenario. An interactive Codex accumulates the same entries in
`~/.codex/config.toml` as you click through them, which is why this only bites automation.

Known side effect: Codex writes a `[projects."<run dir>"] trust_level = "trusted"` entry into your
real `~/.codex/config.toml` per run, since `--ignore-user-config` governs reads. Harmless, and it
accumulates; isolating it needs `CODEX_HOME` per agent with `auth.json` linked in.

`configPath` is where a file-configured harness reads its config, relative to the agent's directory
(default `.mcp.json`). Codex needs none, since its config rides in the argv.

## What the runner isolates, and why

- `RADIA_DIR` and `RADIA_CREDENTIALS` point into the run directory, so a lab run never appends to
  the credentials you use and `radia credentials` afterwards shows nothing new.
- `RADIA_TOKEN` and `RADIA_DEFINITION_TOKEN` are DROPPED from every child. Either would override a
  member's own token and make every agent act as whoever started the lab.
- `--auth required`. In open mode every member resolves to the operator and the scoping the lab
  exists to observe stops existing.
- `team add --rotate`, unconditionally. A second definition for one agent is not a rotation and
  looks exactly like one, so run 2 against a persistent space is refused without it.

## Reading a run

```
deno task lab-report ~/.radia-lab/team-queue-2026-08-28T13-28-17-483Z
deno task lab-report ~/.radia-lab/team-queue-* --json      # several runs print RATES
```

Everything it prints is computed from evidence the run already collected: the event log gives claim
history per record, the traces give what each model ASKED FOR, `space.json` gives records and mined
flows, `tally.json` gives models and exit codes. Nothing asks an agent whether it followed the
intended path, which is the third evidence source and the weakest.

Seven checks: an empty claim while work of that kind stood available (a concurrent winner within two
seconds is the fence working, not a finding), a record settled twice, a record left claimed or
dead-lettered when the run ended, a nack-and-reclaim loop on one record, a participant that authored
nothing, refusals, and acting before calling `space_kinds`. A check that cannot decide says so
(`[n/a]`, `[part]`) rather than passing silently: over-reporting puts false findings in front of a
reader, which is the one failure that makes a lab worse than no lab.

**Several directories print rates, and a rate is what a finding is here.** The same scenario with
the same models produces different choices, so one run is an anecdote. A PAIRED run is two sets of
directories with one variable moved between them, which is also why `--model` exists: model drift
cancels when both arms run the same day.

`tally.json` is a count, not a verdict. The column that matters is `empty`: a call that answered
nothing looks like success to the model and to every artifact except the trace, and it is how a
pattern bug (`{tags: {$in: […]}}` against an array path) went unnoticed for a session.

A `background` worker appears as "not traced": `--trace` lives in the MCP adapter and an SDK worker
holds none, so zero calls is what a working one reports. Whether it did anything is a record it
authored, in `space.json`.

One run is an anecdote. The failure that started this appeared in one of two sessions, and the
difference was whether `space_kinds` had been called first, so a scenario is worth running k times
and reading the rates. Ranking findings across runs is phase 2 and is not built.
