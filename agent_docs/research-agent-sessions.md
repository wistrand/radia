# What real agent harnesses did on a shared space

**Status: a findings log, kept as runs happen. Every entry is an observation with its evidence;
the fixes are linked to where they landed.** The subject is CLAUDE CODE and CODEX driving a team
space through `radia mcp`, first by hand and then through the lab
([plan-agent-lab.md](plan-agent-lab.md), which is the harness rather than the findings).

Sixteen sessions so far, 2026-08-26 to 2026-08-28: four hand-run and pasted into a review, twelve
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

**Contention: five tasks, two claimants, nothing coordinated and nothing wrong.** `team-queue`
seeds five tasks and gives both agents the same prompt. Every task settled exactly once, each note
parented to a distinct task, nothing left claimed at exit. Neither agent held two leases: both ran
take, ack, take, ack. Neither NARROWED its claim either, despite the tags on every task; both sent
bare `{kind: "task"}` and let the space arbitrate, which is the correct read of what fencing is for
and means the seeded tags went unused.

**There is no way to settle a task as FAILED, and the model used the only shape there is.** The
fifth task asks for a summary of a record id that does not exist. Codex claimed it, tried to fetch
the record, got nothing, and ACKED with a note saying the record does not exist. Not a nack, which
would have been wrong (nothing changes on retry, so it is a livelock), and not an abandoned claim.
The answer is right and unreadable: the result is an ordinary `note`, indistinguishable from the
four successes, so a reader querying notes sees five completions. `tool_result` carries `ok` and
`note` carried nothing. FIXED 2026-08-28: `note.ok` is the marker (optional, indexed, absent means
the note is mail), `space_ack`'s description now says a failure is acked rather than nacked, and
the `note` usage carries the mechanism, trimmed to fit rather than raising `MAX_KIND_USAGE` to
hold one string. Still not a nack: it reaches dead-letter only after `maxAttempts`, and a
dead-lettered record emits no result, so the member that asked would learn nothing at all.

**`space_release` and `space_nack` have never been called.** Fourteen sessions, including one whose
work contained something that could not be done. Both tools are advertised and described on every
call. Nothing yet shows whether the descriptions are wrong or the situation that needs them has not
occurred.

**Nobody reasons about lease length.** Codex passed `leaseSeconds: 120` for work that takes a
second, on every claim; Claude passed none at all and took the default. The number is the model's to
pick and neither treated it as a decision.

**An empty claim was VERIFIED rather than believed, unprompted.** Claude's take answered empty, and
instead of reporting an empty queue it queried the tasks, saw four notes, queried again, saw five,
and walked `space_children` on a task to confirm the work was done rather than taken. That is
exactly the behaviour the settled-work hints were written for, appearing on a scenario where nothing
prompted it.

**`space_nack` was used for the first time, and used toward a dead-letter.** Second `team-queue`
run, now pinned to `opus` and `gpt-5.6-luna`. Codex claimed the impossible task and nacked it with
`backoffSeconds: 0`, re-claimed it immediately, nacked again, re-claimed, nacked again, and on
attempt 4 acked with a failure note. `maxAttempts` is 5. One more turn of that loop and the record
dead-letters, which emits NO result, so the member that asked would wait out its deadline learning
nothing. `space_nack`'s description reads "use this when the work failed and retrying might
succeed"; the model matched on the first clause and the qualifier did not bite. The indicated fix is
to lead with the DISCRIMINATOR rather than the situation, but it is not made yet: see the confound
below.

**A hint read at orientation is not available at the decision.** `note.ok` shipped hours earlier and
neither agent used it, on any note, including the failure. Codex called `space_kinds` at 12s, so it
READ the usage naming `ok:false`, and did not use it at 55s, twenty calls later. That refines the
rule at the top of this doc rather than contradicting it: "the thing the model is already reading"
means at the moment of the decision, and a kind's usage is read once during orientation. What it was
reading at 38s was `space_nack`'s description.

**This run changed two things at once and can attribute neither.** The previous `team-queue` run
acked the impossible task immediately; this one nacked three times first. Between them, both the
tool descriptions AND the models changed (the earlier runs took the harness defaults). That is the
whole argument for a PAIRED design over a table of absolute rates: one variable, two arms, same day.
The model plumbing that makes it possible landed with this run (`--model`, and `tally.json` carrying
`asked` versus `reported`, which differ: `opus` was asked and `claude-opus-5` reported).

**The queue itself was handled correctly, again.** Five tasks, five answers, distinct parents,
nothing left claimed. Claude also ended by writing an unparented `queue-status` note saying the
queue was drained and all five were settled, which is the conclusion-as-a-record shape
plan-agent-lab.md wanted from a scenario and nothing asked for here. It cost it 7 empty calls and
about three minutes of waiting to become sure of that, since an empty claim cannot distinguish a
drained queue from a busy one.

**Two-step, second run: verbatim again, and the requester wrote the constraint into the task.**
`opus` and `gpt-5.6-luna` this time. Claude inspected the capability, asked for JavaScript by name,
and titled the task "deliver as an artifact, do not run it"; Codex delivered `sum_primes.js` and
stopped there. The `tool_call` hashes to the artifact's own digest (366 bytes, `4057313d…`), so the
delivered bytes ran unchanged, 2 for 2 on this scenario. It is now a mechanical check rather than
something a human hashes afterwards: a record descending from an artifact and carrying a payload of
the same size is compared by digest (`deno task lab-report`, proved by planting one changed
character). Codex also parented its `tool_call` on the ARTIFACT rather than the task, which is what
makes the check precise, and nothing asked it to.

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

## Answering a refusal

`space_permissions` (2026-08-28) is the tool the adapter did not have. Every recorded session that
hit a 403 recovered by guessing: one queried a kind its member was not granted, one wrote a kind it
could not write, one read an aggregate that came back narrowed and read it as an empty space.
`radia permissions`, the console and the chat all answer "what may I do"; the MCP adapter, which is
what a refused agent is holding, did not. It answers about the CALLER only, which is what makes it
always answerable: `http.ts` checks `asksAboutSelf` before the ops gate, so a member with no ops
power gets an answer, and a tool taking a principal argument would 403 on the one surface a refused
caller reaches for. Guard: `test/team.test.ts`.

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
