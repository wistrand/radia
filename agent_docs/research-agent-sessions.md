# What real agent harnesses did on a shared space

**Status: a findings log, kept as runs happen. Every entry is an observation with its evidence;
the fixes are linked to where they landed.** The subject is CLAUDE CODE and CODEX driving a team
space through `radia mcp`, first by hand and then through the lab
([plan-agent-lab.md](plan-agent-lab.md), which is the harness rather than the findings).

Thirteen sessions so far, 2026-08-26 to 2026-08-28: four hand-run and pasted into a review, nine
through `deno task lab`. Each cost roughly $0.60 and 45 to 85 seconds.

This doc does not restate. The traps live in [gotchas.md](gotchas.md), the team convention in
[architecture-teams.md](architecture-teams.md), the lab's construction in
[plan-agent-lab.md](plan-agent-lab.md).

## The rule everything else turned out to be an instance of

**A hint fires only in the thing the model is already reading at the moment of the decision.**
Three findings are the same shape, and each was fixed twice because the first attempt put the words
somewhere reasonable and useless:

| the hint | put here first, no effect | moved here, worked |
|---|---|---|
| claim by tag, not by `$in` | the `task` kind's usage | the MCP `MATCH` description |
| code goes in an artifact | `space_put_artifact`'s description | the `note` kind's usage |
| a listed task may be finished | nowhere | `space_query`'s description + `task` usage |

The direction differs per case, which is why the rule is about the DECISION rather than about a
layer. `space_put_artifact` reaches an agent that has already decided to make an artifact; the
decision happens while writing a note, so the counterweight belongs in `note`. A kind's usage
reaches an agent that called `space_kinds`; a pattern is written on every call, so that one belongs
in the always-read tool description.

## Findings

**Calling `space_kinds` predicts whether the session goes well.** Two sessions that skipped it wrote
a wrong claim pattern and, separately, addressed mail to a run id; seven that called it got both
right. The kind usage strings work when read, and nothing makes them read. This is the strongest
correlation in the log and the reason so many fixes ended up in tool descriptions instead.

**A claim that matched nothing looks exactly like an empty queue.** Codex claimed with
`{tags: {$in: ["image"]}}` on an array path, got nothing, and recovered with `{tags: ["image"]}`,
which matched only because the list had exactly one element, since that is whole-list equality.
`$in` compares the WHOLE array. Fixed in the `MATCH` description and as an `explain` note
(`src/core/inspection.ts`); the empty answer itself stays the contract
(`test/conformance/suites/matching.ts`).

**Settled work is reported as available.** "Radia has 3 available tasks" twice, on a space where two
of the three had been acked. `space_query` cannot see envelope state and the body carries no status
by design. Minutes later the other harness got it right unprompted, by walking `space_children` for
a result note. So the information was reachable and nothing pointed at it: now `space_query`'s
description and the `task` usage both do.

**Four spellings of one identity.** `assignee: "codex"`, `to: "claude-alpha"`, and twice a run id,
which worked only because both agents were wrong the same way. The cause was mechanical rather than
sloppy: `space_health` reported `principal`, which is a RUN, and there was no call that answered
"what is my durable name". Fixed by adding `agent` to health (and making the adapter exchange its
credential first, since `/v0/health` is public and answered `anonymous` to a cold session). The next
run had both agents using `agent:` names on both the write and the read side, first try.

**Convention propagates by imitation, in both directions.** Asked to create a task, Claude read a
neighbouring one and copied its shape, wrong name spelling included. Later, after the `note` usage
gained the artifact rule, the requester restated that rule in its own task body, teaching the worker
without the worker reading anything. The earliest records of a kind are load-bearing documentation,
and nothing marks one as exemplary or superseded.

**An agent reaches for an artifact when the payload forces it, not when the content is code.** Asked
for a TypeScript program with no delivery mechanism named, Codex inlined 558 characters into a note
body while the requester queried `artifact` and found nothing. The image scenario had produced an
artifact only because bytes cannot go in a body. One sentence in the `note` usage changed it: the
next run stored `sum-first-1000-primes.ts` and the requester fetched it. It holds about two runs in
three, and what decides it is the TASK BODY rather than the usage string. Two `team-exec` runs
differed in one clause the requester wrote itself: "Include the source too, but the deliverable I
need is the number" produced an artifact, "Include the source too if you like" produced 351
characters of TypeScript inlined in the note. The task is what the worker is reading when it
chooses, and the kind usage is one call further back.

**A harness's own permission layer is part of the experiment, and is invisible until it refuses.**
Codex answered every MCP call with "MCP tool call requires approval, but approval policy is never",
spent 85k tokens, made zero calls, and exited 0. Its approvals live per TOOL in the user's
`~/.codex/config.toml`, accumulated by clicking through them months earlier, and `--ignore-user-config`
(the flag that isolates a lab run) throws them away. The lab now asks the binary for its tool list
and generates per-tool approvals.

**A clean pair of exit 0s is not a successful run.** The startup race: the worker claimed at 19s,
found an empty queue, posted "no work available" and exited at 36s; the requester wrote the task at
30s. Both exited 0. A one-shot `codex exec` is not a worker loop, and the fix is the prompt telling
it to wait on `space_watch`, which is what a real agent does anyway.

**Models neutralise a safety knob while appearing to use it.** One run passed
`allowTaint: ["file","net","foreign"]`, which is every label and therefore no barrier; the next run,
same model and same tools, passed `requireUntainted: true`. Neither is a bug; both are why findings
are rates.

**Discovery works, and a refused dispatch degrades into a plausible answer.** First `team-exec` run:
Codex queried `capability`, found `run_javascript`, wrote a `tool_call` naming it, and was refused,
because the SCENARIO granted `tool_call` to the worker and to neither harness. It then computed the
prime sum in its own head, wrote the source as an artifact, acked, and exited 0; the requester
fetched the artifact and reported the number. Both agents succeeded, the answer was right, and the
worker the scenario exists to exercise served zero calls. Content-routed discovery is confirmed
(`capability` to `tool_call` with nothing hardcoded); what a run must not do is let a 403 look like
a finished task. The phase 2 assertion is a worker that AUTHORED NOTHING, not one with no calls:
`tally.json` counts MCP calls, and an SDK worker holds no adapter, so `lab-exec: 0 calls` is what a
successful run prints too.

**With the grant in place, the whole chain ran and no model did the arithmetic.** Second
`team-exec` run: Codex claimed the task, queried `capability` scoped to its team, wrote a
`tool_call{tool: "run_javascript"}`, and watched for the answer, which was already there (16ms). The
worker had claimed, run the code under bubblewrap over the Deno jail and acked
`{ok: true, stdout: "3682913\n", sandbox: "deno-confined"}` 168ms after the call. Flow mining
recovered the three-principal shape with nothing declared:
`task@claude-lab → note@codex-lab + tool_call@codex-lab → tool_result@lab-exec → artifact@codex-lab`.
Run 3 repeated it in 35s with the same result and no artifact, and claimed by
`{tags: {$any: "javascript"}}` first try, on a tag the requester had invented for itself.

**Two-step: the requester ran what it was given, byte for byte.** `team-exec-twostep` moves the
execution to the agent that wrote the task, and it ran first try:
`task@claude-lab → artifact@codex-lab + note@codex-lab → tool_call@claude-lab → tool_result@lab-exec`,
28s, `3682913`. Two things are worth keeping. The code in the `tool_call` hashes to the artifact's
own digest (`d796b2…`, 442 bytes), so the requester passed the delivered bytes through rather than
retyping or improving them, which is an assertion a script can compute. And the requester read the
capability's description and wrote its constraints INTO the task ("this space's run_javascript
sandbox, plain JS, no network, no filesystem, must finish within 5 seconds, so use no imports"),
which is why the dialect trap never fired: `run_javascript` runs stdin under `--ext=js`, so
TypeScript annotations are a syntax error, and nothing told it that.

**A kind's usage promised a read the grants refused.** The scenario's `sandbox` usage says "Query
this to learn what running code here can and cannot reach", and the first thing the requester did
after `space_kinds` was `space_query {kind: "sandbox"}`, which was refused: only the worker held the
grant. It recovered in one call by querying `capability` instead. A usage string is a promise made
to every reader of the kind, so a kind that invites a query must be granted to everyone it invites,
and `sandbox` carries no team, so that grant has to be unscoped.

**The prose credits the wrong principal about half the time.** Run 2's answer note read "The
program ran successfully and printed 3682913" and the requester reported that Codex had run it;
run 3's read "Executed successfully in the team's JavaScript sandbox". Same model, same tools, same
task. In both the records are right (`delegationContext.chain: ["agent:lab-exec"]`,
`sandbox: "deno-confined"`), and in neither does the note name the `tool_result` it rests on, so
only a walk DOWN from the task reaches the evidence. Not a defect; it is why an agent's summary is
the third evidence source and the weakest.

**A refusal named a run, so nothing in it could be acted on.** The same 403 read
`principal 'run:01M1451B17W3ZNHBX64BN2DS7C' has no 'put' grant for kind 'tool_call'`. A grant is
written against `agent:codex-lab`, and the model was handed the one identity that cannot appear in a
`grant` record. This is the identity finding above in a second surface, and it was fixed the same
way: `noGrant` (`src/core/authorization.ts`) now resolves `grantSubject` and reports
`'agent:codex-lab' (acting as run:…)`.

**A narrowed answer reads as an empty space.** A team member's `space_stats` returned `[]` on a space
holding eight kinds, because the aggregates deliberately do not count pattern-scoped kinds and the
surface dropped the `scope` that says so. Four MCP reads were fixed; the sibling surface
(`extensions/ts/agent-tools.ts`) had it right all along, which is worth remembering before treating
a gap as a design question.

## What a run costs, measured

| | Claude Code | Codex |
|---|---|---|
| tool calls | 6 to 9 | 4 to 7 |
| input tokens | (not reported) | 120k to 240k |
| cost | $0.57 to $0.72 | (subscription) |
| wall clock | 45 to 85s for the pair | |

Orientation dominates: both agents spend 10 to 30 seconds and several calls before their first
useful one, which is why a cheap scenario's race is wider than its work.

## Rules that generalise past this space

- **The space records what agents DID, never what they TRIED.** A `take` appends its event only
  after it wins a record, so a fruitless claim is invisible to the log, to lineage and to
  `radia flows`. That is why `radia mcp --trace` exists.
- **Findings are rates, not booleans.** The `$in` failure appeared in one of two sessions, and the
  difference was whether `space_kinds` had been called. One run is an anecdote.
- **A name belongs on a fact, never in the routing position of a claimable record.** `note.to` is
  mail and is right; `task.assignee` binds nothing, and a task addressed to a departed member is
  claimable forever because unclaimed claimable work is never swept.
- **An identity question must be answerable by the surface that is asked it.** Agents will not read
  a convention they cannot resolve; they will invent one that agrees with itself and breaks at the
  12h run ceiling.
- **Absence from an exclusion list is not evidence.** An external reviewer read
  `x-reserved-operators`, did not find `$exists`, and concluded it was unimplemented; it is absent
  because it IS implemented. The spec now states the supported set beside it, checked against the
  compiler.

## Read before

Writing a tool description or a kind `usage` string, adding a lab scenario, or explaining why an
agent did something surprising: check whether it is already here before treating it as new.
