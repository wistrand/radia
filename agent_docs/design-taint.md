# Taint: from one bit to a small closed label set (design)

Why the boolean saturates, the label vocabulary that replaces it, and the mechanics. Nothing here is
built. Taint as it exists today is described in [design-auth.md](design-auth.md) ("Taint:
server-computed") and [design-data-model.md](design-data-model.md).

> **Status: BUILT.** `TAINT_LABELS` in `src/core/kinds.ts`, union propagation in
> `Space.computeTaint`, the allowlist barrier in `src/core/take.ts` and `Space.taintBarrier`,
> per-label `Space.declassify`, a nullable `taint_labels` column in both adapters with a guarded
> migration. Conformance in `test/conformance/suites/taint.ts`; the chat's sites are relabelled.
>
> After: the same conversation that used to be tainted end to end from one tool call now
> discriminates, and a `calc` that touched nothing carries nothing:
>
> ```
> tool_result calc  []          tool_result read  ["file"]
> assistant (calc)  []          assistant (read)  ["file"]
> ```

## Contents
- The measurement
- Why one bit cannot work
- The rule: a label exists only where the log is too slow to ask
- The label list
- Mechanics
- The allowlist decision
- Migration
- The counter-argument
- Cost

## The measurement

One `run_javascript` in a conversation, and the classification never comes back down:

```
conversation    taint=false
user msg        taint=false
llm_call        taint=false
tool_call       taint=false
tool_result     taint=true     <- one run_javascript
assistant msg   taint=true     <- quotes the result, so it is a data parent
next llm_call   taint=true     <- takes the thread
```

The chat's own shape guarantees it: `client/turn.ts` makes the tool result a data parent of the
assistant message, which becomes a parent of the next call. After the first tool call, every record
in that conversation is tainted forever.

**And nothing uses the barrier.** `requireUntainted` and `scope: {taint: "none"}` appear in
`examples/chat` only inside comments, and are exercised only by conformance. Built, tested, unused,
and now the reason is known rather than suspected: a worker with `requireUntainted` could claim
nothing after the first tool call, and a grant with `scope: {taint: "none"}` would deny everything.

The attempt chain sharpens it. `retryOf` makes attempt N+1 a child of attempt N's tainted result, so
every retry in a debugging session is tainted by construction.

## Why one bit cannot work

The bit conflates *derived from untrusted input* with *untrusted for this purpose*. Everything an
LLM touches satisfies the first, which is why it saturates. Every policy anyone actually writes is
about the second, and the second is always about a SOURCE: do not let file contents reach the
network; do not let web content reach a shell; do not let another tenant's data reach this report.

One bit cannot name a source, so it cannot express such a policy. That is not an implementation gap
to close; it is what one bit means.

## The rule: a label exists only where the log is too slow to ask

Provenance is ALREADY in the log. Every record carries `parent_ids` and a server-assigned
`created_by`, so "did this descend from executed code" is a lineage walk that inspects each
ancestor's kind and author. A label naming that is a denormalised copy of a graph fact: it costs
space on every record, it can drift from the graph, and it adds density that makes the whole set
harder to reason about.

So the criterion is not "is this true of the record" but **"is this tested where walking the log is
too expensive"**. Measured:

```
lineage of a 60-turn thread: 121 records in 1.3 ms
one take over 200 candidates:  2.4 ms
a lineage walk PER candidate:  ~0.3 s      (125x the take itself)
```

A walk is cheap once and ruinous per candidate. The barrier runs inside `take`, per candidate, on
the hot path; every other question about origin is asked once, after the fact, by a person or an
auditor, where 1.3 ms is free.

**Therefore only barriers get labels.** An earlier draft of this document proposed `model` and
`exec` as "provenance labels" and was wrong: neither is ever tested on the claim path, so both are
answerable from lineage and neither earns a field.

## The label list

Three. Adding a fourth requires naming the policy that tests it AT CLAIM TIME; anything answerable
after the fact belongs in the log, not on the record.

| Label     | Set when                                               | Expected density |
|-----------|---------------------------------------------------------|------------------|
| `file`    | the content was read from a filesystem                  | medium           |
| `net`     | the content was fetched over a network                  | low              |
| `foreign` | derived from a record created by a different principal  | low              |

`foreign` is free to compute: `computeTaint` already fetches each parent to read its labels, so
comparing the parent's `created_by` to the writer costs nothing extra. That closes an open question
from the first draft.

**Deliberately absent: `user`.** Labelling what a person typed makes everything labelled and
reproduces saturation one level up. The user is the authority in this model. Paste-injection is
real, but the dangerous path is what the model RETRIEVES, which `file`, `net` and `foreign` name.

**Deliberately absent: `model` and `exec`.** Both are graph facts. Ask the log.

Workspaces need no new label: a materialised file carries `file`, and the run's output inherits it.

**Deliberately absent: a label for a class of DATA.** A `protected` label was proposed for a
pipeline over restricted data and rejected: a dedicated kind plus pattern-scoped grants contains
it better, because `bodyMatchesGrant` refuses a scoped agent's write outside its compartment on
every path, while a label bars claims but not reads, is off unless every applicable grant carries
an allowlist, and unions only the DECLARED parents. A label answers what a record TOUCHED; a
grant decides where it may go. See [architecture-workspace-agents.md](architecture-workspace-agents.md) D1.

### What "tainted" now means

Narrower, and more honest. It stops meaning "derived from anything untrusted", which was true of
everything and therefore said nothing, and starts meaning **"carries a classification some policy
bars"**. A wholly model-generated record with no retrieved input carries no labels, which is
correct: nothing about it was ever a policy input.

The containment application ([research-applications.md](research-applications.md) §4.1) survives
this and is sharpened by it, since prompt injection is precisely content that entered from a
retrieved source, and that is exactly the three labels.

## Mechanics

**Representation.** `runtimeMeta.taint` becomes a sorted, deduplicated `string[]`; empty means
untainted. It stays OUTSIDE the body, so the routing language still cannot match on it (patterns
match bodies only, and any filter over the envelope stays a separate input).

**Propagation.** `Space.computeTaint` becomes a union rather than an OR: the labels of every data
parent, plus any the client raised. Same traversal, same laundering caveat — a caller that omits a
parent edge omits its labels, which is the documented hole and is unchanged by this.

**Client raise needs no trust, for the same reason it needs none today.** A client may add labels
and may never remove one, so a raise is monotone: it can only ever restrict what the record may
reach. An unknown label is REFUSED rather than ignored, following `VALID_SCOPE_VALUES`.

**Declassify becomes per-label.** `declassify(recordId, principal, {labels?})` clears the named
labels, or all of them when unspecified, and the successor carries the remainder. The record of the
clearance says which labels were cleared and by whom, which is what "cleared of what" has been
missing.

**Claim filter.** `rankClaimable`'s `requireUntainted` boolean becomes an allowed-label set, and a
candidate is skipped unless its labels are a subset.

## The allowlist decision

A grant's taint barrier states what a record **may** carry, never what it may not.

```
scope: {taint: "none"}          no labels at all
scope: {taint: "file"}          may carry file, nothing else bars the claim
```

This is the one non-obvious choice here, and it is fail-closed by construction. If a fourth label is
introduced next year, every existing grant that CARRIES an allowlist automatically bars it, because
it is not on that list. A blocklist would silently permit it, and the grant would keep looking
correct while admitting a class of data nobody considered when it was written.

**True of SCOPED grants only, which the union rule below makes precise.** A grant stating no
allowlist turns the barrier off entirely (`Space.barrierFrom` returns undefined unless every
applicable grant carries one). That is fine for what labels are for, since a policy that cares
about `file` writes the scope that says so, and it is why a label cannot contain a class of data:
there the default must hold for grants nobody revisited.

It also composes with the union rule properly. Grants union, so the barrier binds only when EVERY
applicable grant carries one (already true today). With an allowlist, two grants with different
allowlists widen to their union, which is the correct and predictable reading of "these grants
together permit". With a blocklist, two grants with different exclusions would silently permit
everything either one allowed, which reads as narrowing and behaves as widening.

The value is validated against the closed vocabulary, so a typo is a registration error and not a
grant that quietly matches nothing.

## Migration

**Built as described.** The `taint` boolean column stays as the derived view (labels non-empty), so
existing predicates and indexes keep working, and a nullable `taint_labels` column holds the set.
Nullable is what distinguishes "written before labels" from "written with none". SQLite has no
`add column if not exists`, so its migration reads `pragma_table_info` and guards the ALTER;
Postgres uses `if not exists`.

`taint: true` is equivalent to a non-empty label set, so the boolean survives as a derived view and
nothing that only asks "is this tainted" changes.

Existing rows carry no label information, which cannot be invented. They take a reserved `unknown`
label that **no allowlist may contain**, so a legacy tainted record is claimable by nothing that
states a barrier. That is fail-closed and honest: the space does not know what those records
touched, and pretending otherwise is the failure this whole change exists to avoid.

That sentence was a comment before it was a rule: `normalizeTaint` accepted `unknown` wherever it
accepted a label, so `scope: {taint: "unknown"}` on a grant admitted exactly these records. It is
refused in the WIDENING direction only — an allowlist (a grant's scope, `take {allowTaint}`) may
not name it, while a client RAISE still may, because raising is monotone and only narrows who will
claim the raiser's own record. Two server paths keep naming it: a legacy record's stored labels
travelling back out, and an operator declassifying the marker, which is the only remedy such a
record has.

## The counter-argument

Decentralised information-flow control (Asbestos, HiStar, Flume) is academically successful and
practically rare, and the reason is label creep: an open vocabulary becomes unusable within months,
because every new integration adds a label and no policy can keep up. The mitigation is not a
lattice, a calculus, or a label algebra. It is a **small, closed, space-declared set** and the
discipline to keep it that way.

If that discipline cannot hold, the boolean is genuinely better than a mush of labels nobody can
reason about, and the honest alternative is to keep the bit and correct
[research-applications.md](research-applications.md) §4.1 and §4.2 to describe what one saturating
bit actually delivers.

## Cost

Not an IFC system, and not small either: an envelope column in both adapters plus a backfill, union
propagation, the claim filter, grant scope validation, per-label declassify, the conformance suite
in `suites/taint.ts`, and labelling the chat's existing taint sites. Worth scoping before starting,
and worth doing before Phase 2 rather than after.

Cutting the two provenance labels took a third of it out: three labels instead of five, no density
on records that only ever pass through, and one fewer thing that can disagree with the graph.
