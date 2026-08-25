# Research: applications of the runtime

> Status: analysis, not a plan. Sources: a full-codebase review against `src/`, and Cal Paterson's
> ["An Oral History of Bank Python"](https://calpaterson.com/bank-python.html) as prior art.
> Mechanism claims are marked **verified** (read in `src/`), **doc-only** (asserted by a design
> doc, not re-checked), or **inferred**.
>
> Always re-verify a doc claim against the code before building on it. §8 lists plausible claims
> about this codebase that are false, several of which came from other `agent_docs/` files. Where
> a doc and the code disagree, the code wins.
>
> Companion docs: [plan-audit-remediation.md](plan-audit-remediation.md) (defects) and
> [design-inspection.md](design-inspection.md) with its backlog
> [plan-inspection.md](plan-inspection.md) (inspecting emergent flows, which depends on both).

## Contents

- §1 Naming: `pattern`, not `template` (decided and applied)
- §2 The pattern layer, and why it is the primitive everything rests on
- §3 What the runtime uniquely provides
- §4 Applications, ranked
- §5 Gated execution of LLM-generated code (the sharpest specialization)
- §6 Prior art: Bank Python
- §7 Anti-applications
- §8 Claim ledger

## Why this doc exists

Two questions kept being answered from memory and from stale docs: *what is this runtime
actually good for*, and *which of its advertised properties are real today*. Those interact. An
application only matters for Radia if it needs something nothing else has, and that judgement is
worthless if the property turns out to be aspirational. So the applications analysis and the
verification live in one document, with receipts attached.

The short version: Radia's advantage is **not** durable execution (Temporal owns that, and
[research-positioning.md](research-positioning.md) is honest about it). It is three things
nothing else combines: routing you can inspect and refuse, per-record authority and
classification, and one medium for work, knowledge, and the system's own configuration. The
applications worth pursuing need all three at once.

---

## 1. Naming: `pattern`, not `template`

**Decided and applied.** The matching construct is a **pattern** everywhere: wire contract, code,
both SDKs, CLI, MCP tool definitions, docs. The inner field stays `match`.

It is named here because everything from §2 onward argues from the construct being a recognizer
rather than a generator, and that argument is unreadable if the word is still in dispute. The
reasoning, the rejected alternatives, and the standing rules that came out of it (never `selector`,
never "repeated-pattern" for the livelock feature) are in
[gotchas.md](gotchas.md) with the other decisions of that kind.

## 2. The pattern layer

Patterns are why the interesting applications are possible, and their limits are why some are
harder than they look. The mechanics live in the design docs and are not repeated here: the
language itself in [design-matching.md](design-matching.md), its use as an authorization primitive
in [design-auth.md](design-auth.md). What follows is only what the applications below rest on.
Where a claim below is verified, its evidence pointer is in §8.

**A pattern is a finite, analyzable structure, not a predicate function**, and that one property is
what this whole document trades on. It is why a grant can be a record instead of config, why the
matcher compiles to a SQL pre-filter, why two patterns can be intersected server-side, and why a
routing rule can be read and refused before anything runs. "Routing you can inspect and refuse"
(§3) is a restatement of it. So the prohibition on executable operators is not fastidiousness:
the moment a pattern can execute, grants stop being inspectable and the pushdown stops being sound.

**The same construct scopes authority in both directions**, write side and read/claim side
([design-auth.md](design-auth.md), "Grants"). For applications that means environment tiering falls
out with no additional mechanism: a supervisor whose grant is `put runnable {env:"ci"}` cannot mint
a prod runnable, and an executor whose take grant is patterned `{env:"ci"}` is incapable of
claiming prod work whatever its own pattern asks for. That is the mechanism §5 is built on. Read
every "the runtime enforces X" as "the HTTP boundary enforces X", since an in-process caller of
`Space` bypasses all of it (§8, newly found gaps).

**Classification is the seam that does not fit.** Patterns see record bodies, taint is envelope
state, so nothing in the routing language can filter on it; the envelope-side vocabulary that can
is `scope` on a grant. Both facts are stated where they are enforced
([design-matching.md](design-matching.md) "What patterns cannot express",
[design-auth.md](design-auth.md) "Taint"). A barrier can now say WHAT it refuses, since taint is a
closed label set rather than one bit ([design-taint.md](design-taint.md)). What is left open is
which ANCESTOR contributed a label, and that is deliberate rather than missing: provenance is a
lineage walk, and the labels make it a pruned one. It is the same join the graph overlay in
[design-inspection.md](design-inspection.md) wants.

**The price is the pushdown contract**, and the applications here are what makes it expensive:
an unsound pre-filter hides records from `take`, and a false-empty space presents as idleness
rather than as an error, which is the worst failure mode a coordination runtime can have. Three
live violations are recorded in [plan-audit-remediation.md](plan-audit-remediation.md) package E.

### 2.1 Addressing versus content-routing

Barbara is hierarchically addressed (`/Instruments/UKGILT201510yZXhhbXBsZQ==`), so every consumer
must know the key path. That is a routing table spelled as a folder hierarchy, and it works because
one firm's employees share conventions. Radia inverts it: consumers declare *shapes*, producers
never learn who consumes. A fleet of independently built agents cannot share naming conventions the
way one organization's engineers can, which is the whole argument for content-routing.

The interchange format carries the same split. Barbara stores pickles: opaque to the runtime
(unmatchable, unauditable) and executing code on load, so the storage format is itself an
arbitrary-code-execution channel, tolerable only inside a hard perimeter. "Patterns are data, not
code" is the opposite commitment. **You cannot taint-track a pickle, and you cannot route on one.**

### 2.2 The recurring patterns

Five appear repeatedly. Four are built; the fifth is the notable absence.

**Registry (latest-wins or additive, with `retired: true`).** Kinds, grants, capabilities, models
and saved procedures are all mutable-looking views over an append-only stream, honoured once in
`src/core/registry.ts` (`activeByKey`, `activeSet`). Withdrawal is a successor, never a delete, so
the audit trail survives revocation. The stopping rule matters as much as the pattern: registry
state is read through `readExhaustively`, which pages to exhaustion and reports `complete: false`
rather than a plausible prefix. A bounded read treated as a population is the most repeated bug
here; this pass found five more instances.

**Request → human approval → privileged write (the "vouch").** The assistant writes a
`grant_request` record and stops; a human approves; an operator-privileged principal writes the
grant (`examples/chat/client/grants.ts`). **Verified as built**, for authority. It is structurally
Bank Python's vouch (§6) and the pattern §5 reuses for code.

**Capability discovery.** Tool-workers publish `capability` records; agents watch or query them to
build a tool list and dispatch by content. Add a worker, the agent gains a tool.

**Blackboard.** Heterogeneous producers publish partial results; consumers match on shape; no
producer knows the fleet topology. `examples/pipeline/` is the miniature.

**Derived/reactive fact: absent.** Nothing recomputes when an upstream input changes (§4.6).

---

## 3. What the runtime uniquely provides

- **Dispatch is a queryable artifact.** Queues bury routing in code; agent frameworks bury it in
  the model. Here it is stored, authorizable data.
- **Record-scoped policy.** Taint LABELS + `allowTaint` answer "may this payload reach this
  step", the question Temporal has no place to ask. `delegation_context` (authority) is separate
  from `parent_ids` (provenance), server-derived, and not a `PutRequest` field at all (verified).
- **One medium for work, knowledge, and configuration.** "What does the system currently
  know/permit/offer" is a query, and every answer has lineage.
- **Fenced, competitive claims** among independently implemented workers: real contention, not a
  DAG one team owns.
- **Embedded-to-Postgres portability** behind one frozen wire contract.

---

## 4. Applications, ranked

Build-state marked from verification, not from docs.

### 4.1 Prompt-injection containment for agent fleets

Ingestion workers write tainted records; taint propagates along data parents; side-effecting
workers take with an `allowTaint` list; a human declassifies the label they reviewed, through the
ops plane. The barrier is at
claim time in the runtime, not in executor discipline, and no incumbent offers that.

Limits, verified 2026-08-03: the barrier is bindable by a grant (`scope.taint`, an ALLOWLIST), so
an executor cannot opt out, but only when EVERY applicable grant carries one, since grants union.
Enforcement moved into `src/core/` for reads and ack-emitted writes; `Space.put` still authorizes
only at the HTTP boundary, so an embedded host calling it directly writes past every grant. And
taint still launders by omitting the parent edge on a direct put (§5). Pilot-grade, not a security
product.

### 4.2 Guaranteed audit of LLM-generated code

§5. The application that most needs all three differentiators at once, and the one with no
incumbent answer.

### 4.3 Org-wide capability mesh over MCP

Capability records plus grant-scoped visibility turn "which tools does our platform have" from a
per-agent config file into a live, authorized registry. Additive to existing MCP investments, which
is why it is the least speculative option.

### 4.4 Blackboard research and data-discovery swarms

Where the published evidence points ([research-positioning.md](research-positioning.md)). Radia
adds durable, queryable, taint-tracked intermediate findings.

### 4.5 Local-first personal agent workspace

Embedded mode is a deployment target, not just a dev convenience. The lineage graph and Space tab
amount to a personal agent activity monitor. Low revenue, high demo value.

### 4.6 Derived facts that stay current ("Dagger for agents")

Bank Python's Dagger (automatic revaluation of everything downstream of a changed input) was the
killer app that funded the platform. Radia has the DAG but not the semantics: lineage is
backward-looking provenance and **nothing recomputes** (verified: no invalidation, no
dirty-marking, no dependency edges beyond `parent_ids`).

The indexing this needs exists: given a successor to record A, `record_edges` answers "what was
derived from A." What is missing is narrower and conceptual: **records are immutable, so there is
no "changed" event to react to**, only "a successor was written," and nothing links a successor
back to the consumers of its predecessor. Closing that is design work (staleness semantics,
recompute storms, glitch-freedom), not indexing work.

Nearest in-repo prior art is the proposed `flow` record in
[research-self-modeling.md](research-self-modeling.md): a derived record whose `parent_ids` point
at exemplars, revised by successor.

### 4.7 Gated on M2+

Competitive task allocation (request/bid/award plus budgets) and cross-org federation. Both should
stay gated exactly as the docs say; the applications above generate the workload that would justify
them.

---

## 5. Gated execution of LLM-generated code

The requirement (*know when generated code may run, and on what*) decomposes onto two mechanisms,
which is what makes it a good fit.

**"When it may run" is the taint axis.** Taint is a closed set of barrier labels, so it expresses
which CLASSIFICATION a payload carries rather than a single yes/no.

```
code_candidate (tainted; source as content-addressed artifact)
  → scanner workers claim by pattern: lint, tests-in-sandbox, SAST, license
  → each acks an attestation record (parent: the candidate), tainted as descendants
  → a human or supervisor reviews the attestations
  → privileged DECLASSIFY emits the clean successor
  → only now can an executor with a matching allowTaint list claim it
```

The sandbox tier sits *before* clearance: a permissionless sandbox is the cheap first attestation,
and its run result is evidence for the gate. **Verified nuance:** the exec worker imposes no taint
barrier, so tainted work *would* be claimed and run; it is the isolation, not a taint check, that
carries the risk there. No comment or test asserts this as intent, so treat it as a property of the
current code rather than a documented decision.

**"On what" is the grants axis.** Labels distinguish what a payload TOUCHED (`file` vs `net`); they
do not distinguish "cleared for CI" from "cleared for prod", which is a property of the consumer
rather than the data. Pattern-scoped grants do that, on both sides (§2, and
[design-auth.md](design-auth.md) "Grants" for the enforcement points).

**The bytes are bound to the approval by content addressing.** Artifact digests are over plaintext,
computed server-side, never taken from the client; records are immutable and carry `body_sha256`.
The reviewed bytes are the executed bytes.

**Authority is server-derived.** `delegation_context` is derived from the claimed lease at ack time
and is never client-writable, so the chain (human approved → gate emitted → executor ran) is
reconstructable and separate from data lineage.

### What is missing, in order of how much it hurts

Note that the first item outranks the tamper-evident log, which is the intuitive first answer.

1. **Declassify does not record who performed it.** Verified: `declassify` calls `putRaw` with no
   principal, so `created_by` (and the event's `runId`) is the space's own identity, not the
   approving operator. The event carries `operation: "put"`; there is no `declassify` operation in
   the log. The trail is the successor's `parentIds` plus an anonymous put. Bank Python's vouch, for
   all its faults, recorded *which* code owner clicked the button. A tamper-evident chain over a
   record that omits the approver protects the wrong fact. Tracked as package J in
   [plan-audit-remediation.md](plan-audit-remediation.md).
2. **Taint launders by omission.** `parent_ids` on a direct put is client-asserted. An agent that
   reads tainted content and writes a fresh record without naming the parent produces an untainted
   record. Only `ack` force-prepends the leased record. Containment holds for lease-mediated work,
   not arbitrary writes.
3. **The execution log is incomplete and gated.** Saved-procedure invocations carry only
   `{tool, args}`, with no code in the body, so a `{kind:tool_call, tool:run_javascript}` query misses
   them.
   The executed text is synthesized (the worker prepends an `args` line), so what ran is never
   exactly what is stored. The scoped session holds no `query` grant on `tool_call`, so the audit
   query needs an operator, a `tool_call` grant, or (since ops tiers, 2026-08-06) the `observe`
   ops power through the ops plane.
4. **Clearance cannot lapse.** `GrantDef` has no TTL field and there is no sweeper; expiry is
   evaluated lazily at claim/resolve time. Time-based lapse is still unbuilt: delayed visibility
   (2026-08-21) defers when a RECORD becomes claimable and does nothing to a grant. The
   workaround that works today is a `retired: true` successor.
5. **Tamper-EVIDENT against database access, not against the host.** The hash chain is BUILT
   (`src/core/seal.ts`, `GET /v0/ops/integrity`): each event is sealed once the log's finality
   watermark passes it, the hash covers the record's `body_sha256` as well as the event, and each
   link is HMAC'd under a key that lives beside the database rather than in it. So a DB admin who
   edits a row is caught even after rebuilding the chain. Someone holding the KEY as well is not,
   and that is what M2's externally anchored checkpoints are for.
6. **Integrity is not re-verified on read.** `body_sha256` is never re-checked, and unencrypted blob
   `get` streams bytes without re-hashing. The encrypted path is fine; the digest is the AES-GCM
   AAD.

Items 1–3 are ordinary work against built machinery. Only 4 is milestone-gated; 5 is now built for
the threat that matters here and milestone-gated only for the stronger one.

**Why this beats the incumbent shapes.** CI systems gate code on checks, but the gate is pipeline
convention. Nothing prevents a path that skips it, which is why SLSA-style frameworks bolt
signatures onto artifacts after the fact. Radia inverts it: the medium is the enforcement point, and
attestation, clearance and audit log are one space. And it covers the case the industry has no
answer for: code generated at runtime by an agent, seconds before it wants to run, where there is
no build pipeline to attest.

---

## 6. Prior art: Bank Python

Paterson's oral history of the proprietary Python monoliths inside investment banks ("Minerva",
standing in for Athena/Quartz) is the closest existence proof for Radia's central bet, and the
cautionary tale for §5.

| Bank Python                                                      | Radia                                              | Where the rhyme breaks                                          |
|-------------------------------------------------------------------|----------------------------------------------------|------------------------------------------------------------------|
| **Barbara**: hierarchical KV of pickled objects, ~16MB soft limit  | The space: records + content-addressed artifacts   | Barbara is name-addressed and mutable; Radia content-routed, append-only |
| **Rings**: namespaces, stackable as overlays                       | Kinds + grants; scoping via patterns              | Radia has no overlay/shadowing; rings are also how devs test     |
| Multiple instances, strongly consistent within, eventual across    | Embedded SQLite/PGlite vs. shared Postgres         | Radia's cross-instance gap is the kind registry, not auth        |
| **Dagger**: DAG of instruments, auto-revalues dependents           | `parent_ids` lineage DAG                           | Dagger is forward recompute; Radia's DAG is backward provenance  |
| **Walpole**: "mega Jenkins combined with mega systemd"             | Leases, take/ack, retries, watches                 | Radia's is a competitive work exchange, not a supervisor         |
| Source code in Barbara's `sourcecode` ring                         | Saved procedures: source as artifact + record      | Bank Python did this for the whole firm's code                   |
| **The vouch**: one code owner signs off, instantly in prod         | `grant_request` → human approval → privileged write | Radia's approval is an immutable record with lineage, though currently unattributed (§5) |
| Pickle + zip                                                       | JSON records, analyzable patterns, frozen OpenAPI | Pickle executes on load; it is the anti-Radia                    |

**Where they agree.** Integration is the product: positions, market data, code and jobs in one
queryable place is almost word-for-word Radia's data-plane pitch. Both dogfood: Bank Python stores
its own source in Barbara, and Radia stores its own kinds, grants and capabilities as records. And
both make deployment nearly free: "Anyone can put a job into Walpole - you need only a small
ini-style config file" is the same gravity as "start a worker, every agent gains the tool."

**The governance divergence is the point.** Bank Python let thousands of people write code straight
into the production system and managed the risk with trusted employment, code ownership and
compliance process, all controls living entirely outside the system. The article notes no mandatory
test suite or CI gate before vouching. When Paterson described this to an outside programmer, the
response was disbelief, "asking who in the world would trust such a bank."

The answer was: accountable employees inside a legal perimeter. When the code's author is a model
(unaccountable, prompt-injectable, generating at machine rate), every one of those controls
evaporates, and the only place left for the gate is the medium itself. **Radia's gated-execution
story is Barbara's source-in-database pattern with the bank's human change control compiled into the
runtime.** That is the one-line thesis of this document.

**Lessons to take.** Shared spaces win by gravity, not feature comparison. Barbara became unremovable
because it was the cheapest place to put anything, so the metric that matters is "seconds until a
new agent's output lands in the space." Find the Dagger: Minerva was funded by pricing and risk, not
elegance, and §5 is the candidate here precisely because no organizational control can substitute
for it. Heed the exit costs the article is candid about: skill atrophy, "even months in, new
starters are still learning quite fundamental new things", and the circular answer that the way to
read Barbara is to use the Minerva source code. Radia's mitigations (frozen wire contract,
language-neutral JSON, SDK parity, examples using only the public API) are the right ones and should
stay non-negotiable. Expect the culture reaction: the author "nearly did" resign on seeing the
mandatory in-house IDE, then came to value shipping to prod within the hour.

---

## 7. Anti-applications

State these to avoid misdirected effort.

- **Durable execution as workflow-as-code.** Compose with Temporal; do not compete.
- **High-throughput event streaming.** Records are a coordination medium, not Kafka; the artifact
  invariant exists because payload volume breaks matching.
- **End-to-end encrypted content.** Encrypted content is coordination-invisible by construction.
- **Anything security-critical needing in-process enforcement**, since grants live at the HTTP
  boundary (§8, newly found gaps).

---

## 8. Claim ledger

What was checked, with evidence pointers.

**Re-verified against `src/` on 2026-07-29.** Evidence points at FILE + SYMBOL, never a line
number: every line citation this ledger carried had rotted, several pointing into unrelated code,
which makes an entry look checked while proving nothing. This ledger exists so an unverified claim cannot
misdirect work, and it had gone stale in exactly that way: two entries under "newly found gaps" were
fixed months earlier, and a reviewer reading this file recommended both as the highest-leverage work
available. The lesson is the ledger's own thesis turned on itself: a claim is only as current as its
last check, and "verified" is a date, not a property. Re-check before citing an entry, and move a
fixed gap into "verified true" with its evidence rather than deleting it, so the same claim does not
get rediscovered as new.

### Verified true

| Claim                                                                          | Evidence                                        |
|----------------------------------------------------------------------------------|-------------------------------------------------|
| Taint propagates along `parent_ids` at put and ack                                | `computeTaint`, `src/core/space.ts`             |
| `ack` force-prepends the leased record to `parentIds`                             | settle path, `src/core/space.ts`                |
| Clients may raise taint, never lower it                                           | `pickPut`, `handlers/records.ts`; `test/conformance/suites/taint.ts` |
| `declassify` is the only path clearing taint, and is ops-plane privileged          | `opts.taint` sole override; `READ_ONLY_OPS` excludes it |
| The taint barrier is enforced inside the claim transaction                        | `rankClaimable`, `src/core/take.ts`             |
| **Taint is a closed set of BARRIER labels, not one bit**: `file`/`net`/`foreign`, unioned along data parents | `TAINT_LABELS` + `normalizeTaint`, `src/core/kinds.ts`; `Space.computeTaint` |
| A grant's `scope.taint` is an ALLOWLIST, so a label added later is barred rather than permitted | `parseTaintAllowlist`; `Space.taintBarrier` |
| `declassify` clears NAMED labels and the successor carries the remainder           | `Space.declassify`, and the `cleared`/`remaining` it records on the event |
| Pattern-scoped grants enforced on writes, including ack-emitted results           | `bodyMatchesGrant`, `src/core/space.ts`         |
| Grant pattern ANDed into client match server-side                                | `combineMatch`, `src/core/matching.ts`          |
| `delegation_context` server-derived, not a `PutRequest` field                      | `Space.deriveDelegation`, `src/core/space.ts`   |
| `$regex`/`$where`/`$expr` forbidden at compile                                     | `FORBIDDEN`, `src/core/matching.ts`             |
| Taint is outside the body, therefore not pattern-matchable                        | `RuntimeMeta`, both adapter schemas, `matchesRecord` |
| `pattern` is wire-visible on the take selector and in grant bodies                | `openapi/radia.yaml`: the `TakeRequest` selector and the `GrantDef` schema |
| **`record_edges` reverse index exists**: indexed, keyset-paged, same-transaction, backfilled | both adapters; `test/backfill.test.ts` |
| Graph BFS calls `childrenOf` per node under a `GRAPH_FANOUT = 200` budget           | `GRAPH_FANOUT` + `getGraph`, `src/core/space.ts` |
| `matchesEvent` fires only on `state === "available"` and is watch-specific          | `matchesEvent`, `src/core/space.ts`             |
| Event log carries no bodies (`seq, cursor, id, ts` + operation/record/kind/state)   | `SpaceEvent`, `src/storage/adapter.ts`          |
| Procedure source is a content-addressed artifact; result carries `{name, recordId, artifactId}` and the procedure record as lineage parent | `examples/chat/workers/exec.ts` |
| Sandbox child holds no credentials                                                 | `extensions/ts/sandbox.ts`                      |
| Hash-chained log unbuilt; events table has no hash column                          | both adapters; `design-observability.md`        |
| No sweeper exists; expiry evaluated lazily                                         | the only `setInterval` in the RUNTIME is the MCP heartbeat (the console page has its own, in the browser) |
| `GrantDef` has no TTL/expiry field                                                 | `src/core/kinds.ts`                             |
| ~~Retention GC absent~~ BUILT 2026-08-05: `retention_until` is consulted by an on-demand sweep | `Space.gc`, `POST /v0/ops/gc`, `radia gc`; registry compaction beside it. Still nothing on a schedule, by design. See [plan-gc.md](plan-gc.md) |
| **An artifact's payload can be erased on demand**, keeping the record, its digest and its lineage | `Space.shredArtifact`, `POST /v0/ops/records/{id}/shred`, `shred` records; a shredded read is 410 |
| Record BODIES have no erasure path, because the routing language matches on them     | bodies are plaintext JSON; see design-data-model.md, "Erasure" |
| No reactive recomputation or invalidation primitive                                | no dependency edges beyond `parent_ids`         |
| Budgets entirely unbuilt                                                           | zero hits for `budget` in `src/**/*.ts`         |
| **A grant can bar tainted work, so a worker cannot opt out**: `scope: {taint: "none"}` | `VALID_SCOPE_VALUES` in `src/core/kinds.ts`; `Space.taintBarrier` folds it into `readAccess`, and the code says "this one the principal cannot decline" |
| **`declassify` records the principal that performed it**                           | `Space.declassify(recordId, principal?)`, `src/core/space.ts`  |
| **Reads and ack-emitted writes authorize inside `Space`**, not only at the boundary  | `Space.readAccess` → `authorize`; `Space.ack` → `authorize(owner, "put", kind)` |
| A run RENEWS rather than dying: successor `agent_run`, same token hash, later expiry | `Space.renewRun`; bounded by `runMaxLifetimeSeconds` and by a stop |
| A person is an ordinary principal; privilege is a NAMED set, not the `human:` prefix | `Space.isPrivileged` reads `ctx.operators`; `radia login` mints a human's run |

### Plausible but false

These circulate, and some appeared in other `agent_docs/` files. Check here before repeating one.

| Claim                                                    | Reality                                                                  |
|------------------------------------------------------------|---------------------------------------------------------------------------|
| "`childrenOf` is a `LIKE` scan; a reverse index is a prerequisite" | **False.** It is an indexed lookup through `record_edges`, keyset-paged, written in the same transaction, with a backfill under conformance test |
| "Auth enforcement is single-instance"                      | **Wrong.** Credentials and grants are read from records per request with no cache; a token minted on one instance authenticates on another. The real cross-instance gap is the kind registry |
| "Every program that ever ran is a query"                   | **Wrong.** Procedure invocations carry no code; executed text is synthesized; the scoped session lacks `query` on `tool_call` |
| "The exec worker acks every result with `taint:true`"      | **Partly wrong.** Artifacts and execution results yes; `saveProcedure`/`retireProcedure` success returns omit taint |
| "Only the exec worker can write `procedure` records"       | **Configuration, not invariant**, though the hole it named is closed. The chat once defaulted to a role that ran the session as the operator; there are no roles now and a session token is required, so the session holds only `procedure: query`. It stays configuration because the grant list is the app's, not the runtime's |
| "Three processes at three privilege levels"                | The repo's own diagram shows two; the third is the REPL/launcher         |
| "Resource limits are hard and enforced"                    | Only `$and`/`$or` depth ≤ 3 and the 32 MiB artifact cap                  |
| "`Pattern` is not wire-visible"                           | It is: the take selector request field, plus the grant body field       |

### Gaps

Open unless marked. A CLOSED entry stays here with what closed it, so the same gap is not
rediscovered as new; the corresponding positive claim is in "verified true" above.

- **CLOSED.** ~~`declassify` records no principal.~~ It takes one (`Space.declassify(recordId,
  principal?)`). Still open: the event's operation is `put`, not `declassify`, so the audit trail
  says a record appeared rather than that a clearance happened.
- **CLOSED.** ~~`requireUntainted` is per-call, not bindable to a grant or identity.~~ A grant
  carries `scope.taint`, an ALLOWLIST of labels, which `taintBarrier` applies whatever the caller
  asked for. The per-call `allowTaint` remains as a courtesy a worker pays, and the two INTERSECT.
  Note the union rule: the grant-side barrier binds only when EVERY applicable grant carries one.
  Superseded in shape by the label set: the boolean it was written against saturated after the first
  tool call, so "bindable" was true and useless. See [design-taint.md](design-taint.md).
- **PARTIALLY CLOSED.** ~~`authorize`/`combineMatch`/`bodyMatchesGrant` live in handlers, so
  in-process `Space` callers bypass all of it.~~ They live in `src/core/` now, and reads
  (`readAccess`) plus ack-emitted writes (`Space.ack`) authorize inside the core. Still open, and
  it is the one that matters for §5: **`Space.put` does not authorize** (`src/core/space.ts`, "that
  only a privileged principal may put one is enforced at the API boundary"), so a host embedding
  `Space` and calling `put` directly writes past every grant. Until that closes, "the medium is the
  enforcement point" is true of the HTTP surface and a design intent for an embedded one.
- Taint launders by omitting the parent edge on a direct put. `computeTaint` reads only
  `parentIds` and the client's raise, so a caller that derives content without declaring the parent
  writes it clean.
- `body_sha256` never re-verified on read; unencrypted blob `get` does not re-hash.
- `declassify` mints a new record id with the same `body_sha256`, so a clearance keyed on record id
  and one keyed on digest diverge across it.
- The artifact put grant is checked against `{mediaType}` before `x-radia-meta` appFields are
  parsed (`handlers/artifacts.ts`: `authorize` + `bodyMatchesGrant` on `{mediaType}` alone, ~20
  lines before `appFields`), so an appField-scoped put grant denies every artifact write
  (fail-closed). Not hit by the chat, whose artifact writers hold an unscoped `artifact: put`.
- Schema versioning and migration of kinds are unbuilt (`plan-milestones.md`: `[~]`). Every
  application here depends on it eventually; a capability mesh at org scale reaches it first.

---

