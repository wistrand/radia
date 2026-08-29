# What real agent harnesses did on a shared space

**Status: a findings log, kept as runs happen. Every entry is an observation with its evidence;
the fixes are linked to where they landed.** The subject is CLAUDE CODE and CODEX driving a team
space through `radia mcp`, first by hand and then through the lab
([plan-agent-lab.md](plan-agent-lab.md), which is the harness rather than the findings).

Forty-four sessions so far, 2026-08-26 to 2026-08-29: four hand-run and pasted into a review,
forty through `deno task lab`. Each cost roughly $0.30 to $1.00 and 45 to 120 seconds; a three-model scenario is about $0.90.

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

**"Already reading" is two variables, and the second is WHEN.** A kind's usage is read ONCE, during
orientation, and is not in front of the model twenty calls later; a tool description is re-read on
every call that considers that tool. So a hint about a decision taken late in a session survives
only in a tool description, however well it fits the kind.

Measured, on the rule's own terms: `note.ok` was placed in the `note` usage, which is where the
answer is written and is the correct artifact by the rule above. Codex called `space_kinds` at 12s
and therefore READ it, then decided at 38s and never used it. What it was reading at 38s was
`space_nack`'s description. The placement was right and the timing was wrong, which is the one case
the rule as first stated predicts a success for.

| the hint | right artifact | wrong moment |
|---|---|---|
| answer failed work, do not nack it | the `note` usage, read at 12s | decided at 38s, reading `space_nack` |

The corollary for a kind's usage: it teaches SHAPE (which fields a body carries, how the kind is
addressed), because shape is what an agent is deciding when it first reads the kind. A rule about
WHEN to reach for one verb over another belongs on the verbs.

## Findings

**Calling `space_kinds` predicts whether the session goes well.** Two sessions that skipped it wrote
a wrong claim pattern and, separately, addressed mail to a run id; seven that called it got both
right. The kind usage strings work when read, and nothing makes them read. This is the strongest
correlation in the log and the reason so many fixes ended up in tool descriptions instead.

**One claimant's wrong pattern stalls the whole run, twice over.** Measured 2026-08-29 on
`team-exec`: codex claimed with `{assignee: {$exists: false}}`, treating an unassigned task as the
only free one, while the task claude had written carried `assignee: "agent:lab-exec"`. It then
watched that pattern for the full **120.5s** with the work sitting claimable the whole time. Claude
meanwhile watched its own mailbox, a pattern that was RIGHT, for **120.0s**, because the reply it
waited on could not be written by a worker that was blocked. Two agents, two full timeouts, on a
three-minute run: the second is caused by the first, so a claimant's pattern error costs the
REQUESTER's time too. After the timeout codex re-watched with no match at all and hit in **0.1s**.

The `task` usage line already says it: "`assignee` is a PREFERENCE: nothing enforces it, anyone may
claim a task addressed to someone else." Codex called `space_kinds` at 11s, so it read that line,
and wrote the contradicting pattern at 18s. That is the TEMPORAL half of the hint rule in action
rather than in the abstract: a usage string is read once during orientation and is no longer in view
at the moment a claim pattern is chosen. So the fix went on the surface being used at that moment
rather than into the kind: the scenario prompts now name TWO KINDS OF EMPTY with opposite responses,
bound the first wait to 30 seconds, and say a second empty answer makes the PATTERN the likelier
problem than the timing.

**Four runs each arm, alternating so a drift in either model's service lands on both.** Time PARKED
in a watch, and how often a run burned the 120s ceiling:

| arm | runs | median parked | range | ceiling hit |
|---|---|---|---|---|
| before | 4 | 253.0s | 18.3-258.7s | **3 of 4** |
| after | 4 | 17.8s | 11.0-81.6s | **0 of 4** |

**The three ceilings had three different proximate causes, which is what makes this a rate rather
than one story told four times:** the `assignee` filter above; a REPLY RACE (below); and one run
where both happened at once, codex on `assignee` and claude on `newOnly` for its mailbox.

**What the after arm actually changed is not what the prompt said.** The prompt never mentions
`newOnly`; it says look again rather than wait longer. Codex then passed `newOnly: false` in 3 of the
4 after runs, with a bare `{team}` match or none at all, and the one slower after run (81.6s) is the
one where it passed `newOnly: true`. Reconcile-first defeats both failure modes at once, because it
finds work already sitting there AND replies that already landed. Emergent, then, not instructed:
report it as the rate it is.

**THE REPLY RACE, and the one fix here that removes a failure class rather than shifting its
probability.** In the second ceiling run codex claimed correctly (`{tags: {$any: "run_javascript"}}`,
0.0s), dispatched a `tool_call`, and opened `space_watch {callId, newOnly: true}` at 17:02:15.250.
The worker had answered at **17:02:12.525**, 2.7 seconds earlier. `newOnly` means "written after this
call started", so the one record it was waiting for was the one record the flag hides, and it waited
out the full 120s for a second answer nobody would send. Its description gave the REASON to use it (a
fact kind hands back the same record forever) and never the cost; it now says a reply is the other
case and wants the default. UNVERIFIED against a live agent: the after arm carries both edits, so
the rate above cannot separate "the description removed the race" from "the prompt changed the
behaviour". Four runs with the new description and the OLD prompt would.

ONE RUN, recorded because the CONDITION recurred rather than because the outcome was good. On
2026-08-29 at 17:13, the first run carrying both edits, the worker answered 203ms after the call and
therefore again before any watch could open. Codex omitted `newOnly` this time and the reconcile
found the reply in **15ms**, where the same shape with `newOnly: true` had cost **120.4s**. Claude
omitted it on its mailbox too. That is a data point about the RACE, not evidence about the fix: the
prompt-only arm was already omitting the flag in 3 of 4 runs, so this run is equally consistent with
either edit, and the arm is now MIXED (4 runs prompt-only, 1 prompt-and-description) which anyone
reading the rate above should know before treating it as homogeneous.

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
and `sandbox` carries no team, so that grant has to be unscoped. HOLDS: two `team-workspace` runs on
2026-08-29 opened with the same call and were answered (1 record), on a scenario that is not the one
the grant was fixed for.

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

**`space_release` and `space_nack` went uncalled for fourteen sessions**, including one whose
work contained something that could not be done. Both tools are advertised and described on every
call. `space_nack` has been seen since, three times in a row on work a retry could never fix, and
not once in the five later runs of that same scenario, so the rate rather than the absence is the
finding there. `space_release` has still not been called in any recorded session.

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
neither agent used it, on any note, including the failure, though Codex had read the usage naming it.
This is the observation behind the TEMPORAL half of the rule at the top of this doc, and the reason
the `space_nack` wording is the next thing to change rather than the `note` usage.

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

**A model authored a runnable workspace first try, and the tree landed in the compartment.**
`team-workspace`, `opus`, four tool calls, $0.29: `space_kinds`, a query of the real notes,
`space_list_workspaces` (it checked what existed before saving), then `space_save_workspace`
declaring an entrypoint nested under `src/`, a directory layout nothing asked for. The manifest and its file
artifact both carry `team: "lab"`, learned from a refusal rather than stamped, so the compartment
held without the model knowing there was one. An operator step promoted the digest and bound it;
the host ran it brokered and acked `{topic: "inventory-total", message: "14"}` under
`agent:runner`, tainted `foreign`, parented on the request.

**The broker's API is the one interface an agent cannot discover, and it wrote a SEARCH over it.**
The program is 2 690 characters for ten lines of work. Most of it is five candidate query patterns
tried in order until one returns something, plus five candidate result shapes (`Array`, `.records`,
`.notes`, `.results`, `.items`), behind the comment "The host's query pattern shape isn't pinned
down, so try the plausible ones". The prompt did say `space.query(pattern, limit)`, and that is not
enough: the MCP `space_query` tool takes `kind` and `match` as SEPARATE arguments, so a model fluent
in the surface it has been using guesses a flat pattern, which the wire refuses. Two of its five
attempts were refused before the third worked.

FIXED 2026-08-28, where the argument said it belonged: `SandboxSpec.api` carries `BROKER_API` (the
entrypoint signature, the three calls with their exact shapes, what a return becomes, what is
absent), `radia host` declares one at startup, and the `sandbox` usage now tells a reader to consult
it before writing code. The guard is that the advertised names are the names the shim binds, in both
languages. The rule it instantiates: a model that cannot verify an interface writes a SEARCH over
it, and the cost is a fallback list ending in a catch-all, saved here by an unrelated filter and on
another space totalling the wrong records.

**The refusals inside the jail are invisible, one level below the trace.** `--trace` records MCP
calls; a broker call refused inside the sandbox appears in neither the trace nor the space, and the
host logged nothing about them. It is "the space records what agents DID, never what they TRIED"
again, in a place the existing instrument cannot see.

**Three models on one tree: the collaboration worked and the deployment did not.**
`team-tree`, an author (opus), an editor (gpt-5.6-luna) and a verifier (opus). The editor did
exactly the right thing and did it unprompted by any tool name: `space_list_workspaces`, then
`space_read_one {kind: "sandbox"}` (it looked up the API record, first run after that record
existed), then the manifest, then the file, then a surgical `space_edit_workspace` with one
`oldString`/`newString`, then read it back to check. It did not rewrite the tree. Flow mining shows
the handover as lineage: `workspace@claude-author → workspace@codex-lab`.

Then the run failed, six times, on
`forbidden: result body is outside the pattern scope of the put grant for 'note'`.

**A brokered run has TWO write paths and they do not follow the same rules.** FIXED 2026-08-29:
one `Binding.outputMeta` stamp now reaches all three destinations, `radia bind --output-meta`
declares it, and the smoke proves it (the entrypoint returns no `team` and the acked result carries
one). A `space.put` inside
the code goes through the broker, where the host merges its stamp over the body; the value the
entrypoint RETURNS is handed to `client.ack` unchanged (`host.ts`). So the compartment label the
host is supposed to guarantee reaches a put and not a result. Both programs here returned a body
with no `team`, and nothing they could read said they had to: `BROKER_API` states, under
`space.put`, that "the host stamps the labels, the compartment and the claimed record as a parent",
which is true of that call and which a reader will reasonably generalise. The refusal lands inside
the host, after the code ran, where no model ever sees it.

Worse, `radia host` passes NO stamp and no labels to `brokeredInvoker` at all, so the sentence in
architecture-workspace-agents.md about the host stamping the compartment describes a capability the
shipped host does not use.

**The host retried an authorization refusal to a dead-letter.** FIXED 2026-08-29: reported
`permanent`, released rather than re-run, contract in `extensions/conformance/host.test.ts`. Six attempts, `backoffSeconds: 5`,
then the record dead-lettered and the deploy step timed out with nothing to show. A body refused for
scope will not become valid on redelivery, which is the rule `space_nack`'s own description states
and the host does not follow.

**A verifier with nothing to verify wrote nothing.** 19 calls, no records, timed out: it queried
notes, found no result, tried `exec_request` twice (refused, no grant), watched, and kept looking.
It was told to write one note saying whether the answer was right, and "there is no answer" is
exactly the case it did not report. Same shape as an empty queue read as an empty space: the absence
of a thing is a finding, and nothing in the instructions made it one.

## A defect the workspace scenario found before any model ran

**`radia host` cannot broker from the compiled binary.** Building the workspace chain
(`scenarios/workspace-smoke.json`, no model in it) failed at the run step with `the broker could not
create its channel: Requires run access to "mkfifo"`. Two causes, and the second is the real one:
`deno task compile` grants no `--allow-run`, and the Deno jail spawns `Deno.execPath()`, which in a
compiled binary is `radia` itself rather than a Deno runtime. So a permission flag would not fix it.
FIXED 2026-08-29: `--allow-run` is in both compile paths, and `denoRuntime()` resolves a Deno from
PATH when `Deno.build.standalone`, refusing by name when there is none. Verified by hosting a
brokered run from the compiled binary.

**The sandbox record cut the program in half and deleted the search.** Same authoring task, same
model, one day apart. WITHOUT the record: 2 690 characters, five candidate query patterns and five
candidate result shapes tried in order, two of them refused inside the jail where nothing could see
it. WITH it: 1 618 characters, ONE pattern, correct first time, and the contract copied into the
code as a comment, verbatim from `BROKER_API`:

    // space.query(pattern, limit) -> record[]   pattern is {kind, match}

Not a controlled pair (the prompt was reworded to stop naming the API and the scenario grew two more
agents), so it is evidence rather than proof. The mechanism is visible though: both agents queried
`sandbox` before writing, and both wrote its constraints into their own files.

**Three models on one tree, second run: the whole chain, and every fix from the day before.** An
author wrote a two-file workspace, an entrypoint under `src/` plus a README nothing asked for, an editor made a
surgical `space_edit_workspace` change and updated the README to match, an operator step deployed
it, the host ran it from the COMPILED binary, and a verifier checked the answer. Two workspace
versions, the second `basedOn` the first: a clean line of history, no fork. The result was
`{message: "20", count: 4, ok: true, team: "lab"}` on four seeded notes totalling 20.

Four things in that body are the day's changes landing. `count` is the editor's contribution to
another agent's code. `team` was stamped by the HOST from the binding, since neither program
mentions a compartment. `ok: true` is the first use by a model of the failure marker `note` gained.
And the verifier wrote a real verdict rather than nothing: it summed independently, checked the two
failure modes it could name (a zero silently dropped, a note falling off a page), and scoped its
claim to "within my grant (team=lab)".

**A model edited its own fresh tree to match a usage string it read as a schema.** `team-workspace`:
it saved a program returning `{to, topic, message, ok, counted, skipped}`, then immediately called
`space_edit_workspace` to delete the last two, with its own comment: "note body is
{to, message, topic?, ok?}, nothing else belongs here". Nothing had run, so this was not a reaction
to a failure; it read the kind's usage as a closed schema. The listing is not meant that way, and
the cost is visible in another run the same day, where `count` on a note body was the deliverable an
agent was asked to add. Candidate wording change, deliberately NOT made yet: say whether the listed
fields are the whole set, and pair-run it.

**The `to` prefix was dropped with the correct form present twice.** `team-exec-twostep`: Codex
answered `to: "claude-lab"` while the `note` usage says `to` is the AGENT name `space_health`
reports, and the task it had just claimed opened "From agent:claude-lab." It never called
`space_health` at all (five calls). It was harmless only by luck: the reader watched every note
rather than its mailbox, and a `{to: {$in: ['agent:claude-lab', 'all']}}` read would have missed the
answer entirely. The hypothesis worth pairing: the usage shows `'all'` unprefixed beside a prefixed
agent name, so a model generalises to unprefixed.

**An agent announced work the routing already routes.** The same run: alongside its task, Claude
broadcast a note saying "I posted task 01M16KQ4… Please claim it with space_take". Content routing
delivers the task on its own; the announcement is a model not yet trusting the medium.

Three runs that day, no findings from the report, and the two-step's bytes verbatim again (299
this time), 3 for 3.

**Two codex agents could not be run at once, and the reason was in the operator's own file.**
`--ignore-user-config` governs READS, so every run wrote a `trust_level` entry for its directory into
the real `~/.codex/config.toml`: twenty lab directories had accumulated there. Two codex agents also
shared that file, the history, the caches and the sqlite state, so they were one installation used
twice rather than two participants, which is the same mistake as two harnesses on one Radia
credential. FIXED 2026-08-29 with a private `CODEX_HOME` per agent, and verified the only way that
counts: the operator's config was byte-identical before and after a two-codex run, and the trust
entry landed in the run directory.

The credential is the one thing left shared, on purpose. `auth.json` is symlinked rather than
copied, because every codex process on the machine already writes that one file; a copy would break
the sharing instead of preserving it and leave the operator's token stale after a refresh inside a
run. It costs about 45 MB per agent per run, mostly a plugin cache fetched per home.

`team-queue-codex` is the scenario that was impossible: two codex agents on one queue of five, split
3 and 2, each task settled exactly once. It also produced a finding of its own. One of them called
`space_get {"id": …}` and was refused: the tool declares `recordId`, and a model that has just read a
record knows the field as `id`. The adapter now accepts either, which is the rule `order_by` beside
`orderBy` already followed in the same file, and the declared spelling still wins.

**A refusal named the problem and not the remedy, for the third time.** Second two-codex run: an
agent read `note`'s indexed paths from `space_kinds`, saw `topic`, and ordered by it. `note` declares
nothing sortable, so `space_kinds` omits the field entirely and an ABSENCE reads as an omission
rather than as "none". The refusal said "'topic' is not a declared sortable path" and stopped there.
It now names what would work, or says the kind has none, which is the rule `noGrant` and
`space_read_workspace` already follow (`src/core/matching.ts`, contract in
`test/conformance/suites/kinds.ts`).

**The better refusal fixed the recovery and not the reach: it is the SAME wrong call every time.**
Two runs on 2026-08-29, different scenarios (`team-queue`, `team-exec-twostep`), same model, and
byte-identical arguments both times: `orderBy: [{path: "team", dir: "desc"}]` on kind `note`. The
recovery is now immediate (a successful query on the next call, twice), so the message change did
its job. What did not change is the reach, and the path chosen says why: `team` is INDEXED and not
sortable, so a model reading `space_kinds` is generalising from the one list it was shown to a
capability nobody claimed. The remaining fix is at the digest rather than the refusal, and it is the
absence this entry already named: a kind that declares nothing sortable should SAY "none" where
`sortablePaths` would be, since an omitted field reads as an omission.

**The nack loop is about one run in two, not a fixed bug.** The same impossible task, the same model,
the same tool descriptions: the earlier run nacked three times with zero backoff before acking, this
one claimed it, fetched the missing record, and acked a failure answer straight away. Nothing changed
between them, which is what a rate looks like and why the `space_nack` wording is still the first
thing to pair-run rather than to edit again.

**Both codex agents worked the queue and one checked itself.** Five seeded tasks split 3 and 2, each
settled exactly once, no duplicates and nothing left claimed. One of them ended by walking
`space_children` on all five to confirm each carried an answer, which is the settled-versus-open
check the `task` usage asks for, done unprompted.

**Five runs of one scenario, and every refusal in all five is the same mistake.** `team-queue-codex`
with `gpt-5.6-luna` twice, then one arm moved to `gpt-5.4-mini`, then both, twice. Every correctness
check came back zero across all five: no task settled twice, nothing left claimed, no retry loop, no
silent participant, no claim that answered empty while work stood available, nobody acting before
reading the vocabulary. That holds under an uneven division too, the last run splitting 4 and 1 with
all five tasks answered exactly once. The one check that fires is REFUSALS, at 3 of 5, and the three
are one class:

| what it sent | what was true |
|---|---|
| `space_get {"id": …}` | the tool declares `recordId` |
| `orderBy: [{path: "topic"}]` on `note` | `topic` is indexed, and nothing on `note` is sortable |
| `match: {title: "Count vowels"}` on `task` | every task carries `title`; none indexes it |

**A model names a field from the data in front of it, not from the declaration.** That is the whole
class, and each refusal named the problem and not the remedy, so the third one was retried with
three different titles before the agent gave up. All three are now answered the way `noGrant` and
`space_read_workspace` already were: `unsortable_path` and `undeclared_path` list what would work (or
say the kind declares none), and the adapter accepts `recordId`, `id` or `record_id` with the
declared spelling winning. Contracts in `test/conformance/suites/kinds.ts`, so both storage adapters
hold to it.

**A model restated one of these warnings as its own reasoning.** Fifth run, mid-work: "The queue
still shows five `lab` tasks, but that view doesn't reflect settlement state", and it went back to
`space_take` rather than trusting the list. That is finding three from this log ("settled work is
reported as available") arriving as the model's own sentence, from the warning now carried by
`space_query`'s description and the `task` usage. The first time a hint here has been observed being
reasoned WITH rather than inferred from behaviour.

**`space_permissions` is a mini habit, not an adoption.** The tool added the day before was called in
2 of these 5 runs, both `gpt-5.4-mini` arms; neither luna run touched it, and the fifth run's two mini agents did not either. The mini arms
were also more thorough and more expensive: 25 and 13 calls against luna's 12, with one of them
walking `space_get` and `space_children` over every task to confirm each carried an answer.

**A third harness, added by reading its `--help` rather than its docs.** agy (Google Antigravity)
joined as a full peer: five seeded tasks split 2, 2 and 1 between Claude Code, Codex and agy, each
settled exactly once. It differs from the other two in exactly two ways. Its MCP config is the same
`mcpServers` object Claude Code takes, but at a FIXED path with no flag to move it
(`<home>/.gemini/config/mcp_config.json`), so isolating two of them means moving `HOME` the way
codex needs `CODEX_HOME`; verified the only way that counts, with the operator's own
`~/.gemini/trustedFolders.json` byte-identical after a three-harness run. And its prompt is an
ARGUMENT (`-p='…'`), not stdin, which is the one thing every scenario had assumed.

**Its one refusal was a model slip, not a harness incompatibility.** 18 of 19 calls carried correct
object arguments, nested `resultBody` included; one sent `match` as a JSON STRING and the next call
sent the object. That is the same family as `{"id": …}` for `recordId` and `orderBy` on an unsortable
path, and it is answered the same way: a `match` that parses to a plain object is accepted, narrowly,
so a genuine type error still fails.

**Three harnesses at once, and the slowest one got nothing.** `team-queue-three`, with `opus`,
`gpt-5.6-luna` and `gemini-3.1-pro-high` on five instant tasks: Codex took three, Claude two, agy
none. agy did everything right, and its first tool call landed 16 seconds after Claude's; by its
first claim the queue was drained. It then walked `space_children` over all five tasks, confirmed
each carried an answer, and said so honestly rather than claiming work.

**A contention scenario with fast work measures STARTUP LATENCY, not claiming, and MORE WORK DOES
NOT FIX IT.** Orientation runs 5 to 25 seconds and varies by harness. Raising the seed from five to
nine changed nothing: the two faster agents drained all nine in the 23 seconds before the third's
first claim, and it again got none. The fast agents drain whatever is there, so the fix is not more
work but putting the work in front of everyone at once. `seedWhen: "agents-ready"` holds the seed
until every harness has made its first tool call, using the TRACE as the readiness signal, since an
agent that has made a call is an agent that can claim. It has a ceiling and names whoever it gave up
waiting for: seeding late is a worse experiment, seeding never is no experiment.

The report also stopped scoring this like a bypass. An agent that TRIED to claim and was answered
empty every time lost a race (low); one that never tried, or whose work went elsewhere, is the
bypass the check exists for (high). A finding that fires on correct behaviour is the noise that gets
a lab ignored.

**The flagship check fired for the first time on a real run.** Codex claimed with
`{tags: {$any: "text"}}` while two `numbers`-tagged tasks stood available, so its empty answer was a
narrowed pattern rather than a drained queue. It recovered by trying the other tag, but this is
exactly the case the trace exists for: the space records nothing about a claim that matched nothing,
so without the request log the run reads as a queue that was simply empty.

**Holding the seed worked, and the follow-up corrected my reading of it.** With
`seedWhen: "agents-ready"` the seed lands once all three have made a call. On the first such run the
two fast agents still took everything, and agy's median gap between tool calls measured 98 seconds
against 3 and 4 for the others, so I wrote that no seeding policy could fix a 25x turnaround
difference and that agy could not be measured in a race.

THAT WAS WRONG, and one more run showed it: the same three agents split the queue 2, 2 and 1, and
agy's median gap was 5.0 seconds. The 98 was not agy's speed, it was agy sitting inside its own long
`space_watch` calls with nothing to claim, which the unconditional wait instruction had told it to
do. I measured a scenario artefact and reported it as a property of a harness, off one run, in a log
whose own rule is that findings are rates. The rule applies to the person writing it down.

With the work actually present when it looked, all three harnesses claimed, five tasks produced five
answers with five distinct parents and no duplicate, no call in the run took over a minute, and the
whole thing finished in 75 seconds against 400 for the run before.

**"Wait rather than conclude the queue is empty" is expensive at the END of a run.** The same
instruction that stops a late agent giving up makes a finished agent park on a 120-second watch for
work that will never come: three of Claude's four watches ran over a minute and its span stretched
to 400 seconds. The prompt now names the two states, which need opposite responses: empty on the
FIRST look means the others are still starting, so wait briefly; empty AFTER completing something
means drained, so stop. One instruction covering both was the mistake.

## The broker, measured rather than assumed

Asked whether the broker was needed at all, the answer came from counting consumers rather than from
the design. `sandboxInvoker` calls `mod.default(record)`; `brokeredInvoker` calls
`mod.default(record, space)`. Everything else is identical: the same jail, tree, host-fetched
inputs, host-captured output files and fenced ack. **The broker's entire marginal value is one
function argument**, and the only production user of the brokered host, the analysis pipeline's
three stages, takes one parameter and never calls `space`.

So it was on for everyone and used by nobody, at the cost of a FIFO pair, a shim per language, the
`mkfifo` permission that hid the compiled-binary defect, an API no author could discover, and two
write paths with different rules. INVERTED 2026-08-29: `Binding.brokered` is opt-in, which is least
privilege for model-written code rather than only a saving.

Two claims did not survive the check. The frame format was labelled NORMATIVE the day after the file
was written and does not qualify: the frames travel between a shim and a host that ship in one file,
nothing outside that pair observes one, and all 22 conformance cases assert behaviour instead. And
`radia host` never passed the stamp or the labels that the containment story rests on, so the
compartment guarantee described in the architecture doc was a capability nothing configured.

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
