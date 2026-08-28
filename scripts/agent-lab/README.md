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
  tally.json             calls, empties and refusals per agent
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

`tally.json` is a count, not a verdict. The column that matters is `empty`: a call that answered
nothing looks like success to the model and to every artifact except the trace, and it is how a
pattern bug (`{tags: {$in: […]}}` against an array path) went unnoticed for a session.

One run is an anecdote. The failure that started this appeared in one of two sessions, and the
difference was whether `space_kinds` had been called first, so a scenario is worth running k times
and reading the rates. Ranking findings across runs is phase 2 and is not built.
