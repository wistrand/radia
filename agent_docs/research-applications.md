# Research: applications of the substrate

> Status: analysis, not a plan. Sources: a full-codebase review against `src/`, and Cal Paterson's
> ["An Oral History of Bank Python"](https://calpaterson.com/bank-python.html) as prior art.
> Mechanism claims are marked **verified** (read in `src/`), **doc-only** (asserted by a design
> doc, not re-checked), or **inferred**.
>
> Always re-verify a doc claim against the code before building on it — §8 lists plausible claims
> about this codebase that are false, several of which came from other `agent_docs/` files. Where
> a doc and the code disagree, the code wins.
>
> Companion docs: [plan-audit-remediation.md](plan-audit-remediation.md) (defects) and
> [plan-inspection.md](plan-inspection.md) (the emergent-flow backlog, which depends on both).

## Contents

- §1 The naming decision: template vs. pattern — **open**
- §2 The template layer, and why it is the primitive everything rests on
- §3 What the substrate uniquely provides
- §4 Applications, ranked
- §5 Gated execution of LLM-generated code — the sharpest specialization
- §6 Prior art: Bank Python
- §7 Anti-applications
- §8 Claim ledger

## Why this doc exists

Two questions kept being answered from memory and from stale docs: *what is this substrate
actually good for*, and *which of its advertised properties are real today*. Those interact — an
application only matters for Radia if it needs something nothing else has, and that judgement is
worthless if the property turns out to be aspirational. So the applications analysis and the
verification live in one document, with receipts attached.

The short version: Radia's leverage is **not** durable execution (Temporal owns that, and
[research-positioning.md](research-positioning.md) is honest about it). It is three things
nothing else combines — routing you can inspect and refuse, per-record authority and
classification, and one medium for work, knowledge, and the system's own configuration. The
applications worth pursuing need all three at once.

---

## 1. The naming decision: template vs. pattern

**Status: open. This doc uses "template" throughout, because that is what the code and the wire
contract say.** If the rename lands, this doc changes with it. Recording the argument here so the
decision is made deliberately rather than by default — it has a closing date (§1.4).

### 1.1 The case for keeping "template"

It is the lineage-correct word. In Linda — the tradition Radia's own name honours — the argument
to `rd`/`in` is literally a *template* (occasionally "anti-tuple"); JavaSpaces kept it. For a
reader who knows tuple spaces it signals exactly the right semantics: a partially specified
instance that matches by structure.

It also earns its keep on the equality-only case. `{kind: "task", match: {op: "reverse"}}` really
does look like a fragment of the record it matches — an example with holes. "Template" captures
that example-shaped quality in a way "query" and "predicate" do not.

### 1.2 The case against

**Mainstream usage points the arrow backwards.** To most working engineers a template is a
*generator*: something filled in to produce instances (HTML, C++, string, PR templates). Radia's
template is the opposite — a recognizer. A newcomer's first guess is inverted, and the misreading
has somewhere to land, because Radia contains a thing that genuinely is blueprint-shaped:
`kind_def`. People will call kind declarations "templates," and then the real templates need a
disambiguating conversation. That is the tax.

**The word drifted from what justified it.** Once `$in`, `$gt` and `$or` arrived, a template
stopped being a partial instance and became a small query expression. The example-shaped argument
holds only for the simple case; the general case wants a word about *selection*, not shape.

**The precedent lost.** JavaSpaces used "template" and lost the mindshare war. Kubernetes used
"selector" for declarative data that picks out resources and made it a generation's vocabulary.
Conversion to a content-routed model has to happen in a newcomer's first ten minutes, unaided; a
word that misleads on first contact is a cost paid at the worst point in the funnel, and the
audience that appreciates the Linda homage rounds to zero of that funnel.

### 1.3 Alternatives, ranked

1. **`pattern`** — strongest. "Pattern matching" is the one universally shared intuition pointing
   the right way (Erlang, Rust, destructuring): recognize, don't generate. "Workers register
   patterns", "starving patterns", "pattern-scoped grants" all read cleanly. Weakness is
   genericness — and in *this* repo that is more than mild: `pattern` is already used for design
   patterns throughout the docs and for **repeated-pattern livelock detection**
   ([design-observability.md](design-observability.md), M3). A rename would collapse a term with
   exactly one meaning onto one with several. Fixable by renaming the livelock feature too, but
   that is part of the cost.
2. **`selector`** — second. Kubernetes made it mainstream for these semantics and it connotes
   data-not-code. But Radia already uses "selector" for the **envelope** selector on the ops plane
   (`{state:"leased", expired:true}`), and the body/envelope split is the distinction the docs work
   hardest to keep sharp. Reusing the word across both planes blurs the design's most deliberate
   line. That existing usage is quietly an argument that "selector" was the natural word and is
   already taken.
3. **`query`** — accurate for reads, collides with the `query` verb (a template is the *argument*
   to query), and undersells the routing/claiming role, which is the differentiating one.
4. **`match`** — already the field name inside the template; the noun is awkward ("register a
   match" sounds completed, not pending).
5. **`interest`** — lovely for the subscription reading ("workers register interest"), wrong for
   grants and one-shot reads. Worth stealing as prose, not as the term.

### 1.4 What a rename would actually cost

Lighter than expected, but one surface heavier than the first estimate. Inside the JSON payloads
the fields are already `kind` / `match` / `orderBy`, so `Template` is largely an OpenAPI component
name plus doc prose plus SDK vocabulary (`templates:` in `agentLoop`). **Verified — it is
wire-visible in two places, not one:**

- the **take selector** request field (`openapi/radia.yaml:184`), in the hot path of every worker;
- the **`template` field in `grant` record bodies** (`:1049`), which is real stored data, echoed
  by `narrowedBy`.

So the rename is: docs, SDK option names, one request field, and one field in a reserved kind —
plus `Template` schema name and 190 identifier sites in `src/`. Nontrivial but small. The npm/pip
publish has not happened, so this is the last cheap moment. "The wire contract is frozen" is a
discipline against churning *users*; pre-launch there are none.

### 1.5 Recommendation

Rename to **`pattern`**, keep `match` as the inner field it already is, rename the livelock
feature to avoid the collision, and keep one sentence of lineage in the docs ("called a template
in the Linda tradition Radia descends from"). That preserves the homage as trivia while giving
first-contact readers a word whose arrow points the right way.

The counterargument with real weight is consistency-conservatism: a rename must be **total** to be
worth anything, because a codebase that says both is worse than either. If totality is a
distraction right now, the fallback is cheap and nearly as effective — keep "template", but have
every doc introduce it with the disarming line first: *a template matches records; it never
generates them*, placed exactly where the misreading would otherwise occur.

Do not do this halfway. Either surface is fine; the mixture is not.

---

## 2. The template layer

Templates are why the interesting applications are possible, and their limits are why some are
harder than they look.

### 2.1 Templates are data, and that is load-bearing

**Verified.** `src/core/matching.ts` holds `FORBIDDEN = new Set(["$regex", "$where", "$expr"])`,
rejected at compile with `operator_forbidden` and the message "templates are data, not code". Any
unknown `$` key at object level also throws. Allowed:
`$eq/$gt/$gte/$lt/$lte/$in/$exists/$any/$each/$and/$or`, with `$and`/`$or` nesting capped at depth
3 (`MAX_DEPTH`). `$ne`/`$nin`/`$not`/`$prefix`/`$text` are deferred.

Everything downstream depends on this. Because a template is a finite, analyzable structure rather
than a predicate function, it can be **stored in a record** (which is what makes a grant a record
rather than config), **compiled to SQL** as a pre-filter, **intersected with another template**
server-side (which is what makes scoped authorization possible at all), and **shown to a human or
an agent** and reasoned about before anything runs.

Never add an operator that cannot be analyzed. The moment a template can execute, grants stop
being inspectable and the pushdown stops being sound.

### 2.2 Templates are the authorization primitive, on both sides

The strongest thing in the codebase, and easy to miss. A grant carries an optional `template`,
enforced differently by direction.

| Direction   | Mechanism          | Question it answers                         |
|-------------|--------------------|---------------------------------------------|
| Write       | `bodyMatchesGrant` | May this principal *produce* this content?  |
| Read/claim  | `combineMatch`     | Which records may this principal *observe*? |

**Write side (verified, `src/core/space.ts`).** Each grant template is compiled against the kind
and evaluated against the body being written; an uncompilable template grants nothing
(fail-closed). Enforced in `handlers/records.ts` for `put`, `handlers/artifacts.ts` for artifact
writes, and — importantly — **in core** for ack-emitted results, checked before anything is
consumed.

**Read/claim side (verified, `src/core/matching.ts`).** The grant's template (or the `$or` union of
several) is ANDed with the client's own match: `{$and: [requestMatch, constraint]}`. Because the
AND is applied server-side *after* the client's template, a wrong or buggy client template can only
narrow. Applied in `handlers/records.ts` (query, read_one), `handlers/leases.ts` (take, including a
synthesized template for a record-id take), and `handlers/watches.ts`.

Together these give environment tiering for free: a supervisor holding `put runnable {env:"ci"}`
cannot mint a prod runnable, and a CI executor whose take grant is templated `{env:"ci"}` is
*incapable* of claiming prod work regardless of what its own template says. This is the mechanism
behind §5.

**Caveat, verified and important.** `Space.take` and `Space.query` do no grant work themselves —
`authorize`, `combineMatch` and `bodyMatchesGrant` all live in the HTTP handlers. An in-process
consumer of `Space` (embedded mode, an example's launcher, the conformance suite) bypasses grants
entirely. Read every "the runtime enforces X" as "the HTTP boundary enforces X".

### 2.3 What templates cannot express

**Verified.** Template matching evaluates `rec.body` only (`matchesRecord` → `evalNode(rec.body,…)`).
`taint` lives in `runtimeMeta`, not the body. Therefore:

- **No template can filter on taint** — not in a query, not in a watch, not in a grant.
- The ops envelope-query plane (`GET /v0/ops/records`) accepts `state`, `expired`, `stale`,
  `limit`; there is no taint dimension there either.
- The only place taint affects routing is a boolean skip in `rankClaimable`
  (`src/core/take.ts`), reached only when the *caller* passes `requireUntainted`.

This is the substrate's sharpest internal seam: classification is enforced at claim time but is
invisible to the language used for everything else. Two consequences follow directly.

- `requireUntainted` is a **per-call opt-in by the worker**, not a property of a grant or an
  identity. An operator cannot force a principal's takes to be untainted; a worker that omits the
  flag receives tainted records normally.
- Taint is **one bit with no provenance**. A client-raised `taint:true` and an inherited one are
  indistinguishable, and nothing records which parent caused it. "Untrusted because of which
  parent" is re-derivable only by walking lineage and inspecting each ancestor's bit — ambiguous
  when several ancestors are tainted.

If taint ever needs to be a policy dimension rather than a barrier, the honest fix is to stop
treating it as envelope state: either mirror a classification into the body (matchable, but then
client-shaped) or extend the constraint language to cover envelope fields. Both are real design
work.

### 2.4 The soundness contract is the price

Because templates compile to SQL, the pre-filter must **over-include, never over-exclude** — the
in-memory oracle decides (`src/storage/pushdown.ts`). Three live violations are recorded in
[plan-audit-remediation.md](plan-audit-remediation.md) package E. The structural lesson: **every
extension to the template language is also an extension to the pushdown, and an unsound pushdown
makes records invisible to `take` rather than merely slow.** A false-empty space is the worst
failure this system has, because it looks like idleness.

### 2.5 Addressing versus content-routing

Barbara is hierarchically addressed — `/Instruments/UKGILT201510yZXhhbXBsZQ==` — so every consumer
must know the key path. That is a routing table spelled as a folder hierarchy, and it works because
one firm's employees share conventions. Radia inverts it: consumers declare *shapes*, producers
never learn who consumes. A fleet of independently built agents cannot share naming conventions the
way one organization's engineers can, which is the whole argument for content-routing.

The interchange format carries the same split. Barbara stores pickles — opaque to the substrate
(unmatchable, unauditable) and executing code on load, so the storage format is itself an
arbitrary-code-execution channel, tolerable only inside a hard perimeter. "Templates are data, not
code" is the opposite commitment. **You cannot taint-track a pickle, and you cannot route on one.**

### 2.6 The recurring patterns

Five appear repeatedly. Four are built; the fifth is the notable absence.

**Registry (latest-wins or additive, with `retired: true`).** Kinds, grants, capabilities, models
and saved procedures are all mutable-looking views over an append-only stream, honoured once in
`src/core/registry.ts` (`activeByKey`, `activeSet`). Withdrawal is a successor, never a delete, so
the audit trail survives revocation. The stopping rule matters as much as the pattern: registry
state is read through `readRegistry`, which pages to exhaustion and reports `complete: false`
rather than a plausible prefix. A bounded read treated as a population is the most repeated bug
here; this pass found five more instances.

**Request → human approval → privileged write (the "vouch").** The assistant writes a
`grant_request` record and stops; a human approves; an operator-privileged principal writes the
grant (`examples/chat/client/grants.ts`). **Verified — built**, for authority. It is structurally
Bank Python's vouch (§6) and the pattern §5 reuses for code.

**Capability discovery.** Tool-workers publish `capability` records; agents watch or query them to
build a tool list and dispatch by content. Add a worker, the agent gains a tool.

**Blackboard.** Heterogeneous producers publish partial results; consumers match on shape; no
producer knows the fleet topology. `examples/pipeline/` is the miniature.

**Derived/reactive fact — absent.** Nothing recomputes when an upstream input changes (§4.6).

---

## 3. What the substrate uniquely provides

- **Dispatch is a queryable artifact.** Queues bury routing in code; agent frameworks bury it in
  the model. Here it is stored, authorizable data.
- **Record-scoped policy.** `taint` + `requireUntainted` answers "may this payload reach this
  step" — the question Temporal has no place to ask. `delegation_context` (authority) is separate
  from `parent_ids` (provenance), server-derived, and not a `PutRequest` field at all (verified).
- **One medium for work, knowledge, and configuration.** "What does the system currently
  know/permit/offer" is a query, and every answer has lineage.
- **Fenced, competitive claims** among independently implemented workers — real contention, not a
  DAG one team owns.
- **Embedded-to-Postgres portability** behind one frozen wire contract.

---

## 4. Applications, ranked

Build-state marked from verification, not from docs.

### 4.1 Prompt-injection containment for agent fleets

Ingestion workers write tainted records; taint propagates along data parents; side-effecting
workers take with `requireUntainted`; a human declassifies through the ops plane. The barrier is at
claim time in the runtime, not in executor discipline — which no incumbent offers.

Limits, all verified: enforcement is HTTP-boundary-only; `requireUntainted` is opt-in per call
rather than bindable to an identity; and taint launders by omitting the parent edge on a direct put
(§5). Pilot-grade, not a security product.

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

Bank Python's Dagger — automatic revaluation of everything downstream of a changed input — was the
killer app that funded the platform. Radia has the DAG but not the semantics: lineage is
backward-looking provenance and **nothing recomputes** (verified: no invalidation, no
dirty-marking, no dependency edges beyond `parent_ids`).

The indexing this needs exists: given a successor to record A, `record_edges` answers "what was
derived from A." What is missing is narrower and conceptual — **records are immutable, so there is
no "changed" event to react to**, only "a successor was written," and nothing links a successor
back to the consumers of its predecessor. Closing that is design work (staleness semantics,
recompute storms, glitch-freedom), not indexing work.

Nearest in-repo prior art is the proposed `flow` record in
[research-self-modeling.md](research-self-modeling.md) — a derived record whose `parent_ids` point
at exemplars, revised by successor.

### 4.7 Gated on M2+

Competitive task allocation (request/bid/award plus budgets) and cross-org federation. Both should
stay gated exactly as the docs say; the applications above generate the workload that would justify
them.

---

## 5. Gated execution of LLM-generated code

The requirement — *know when generated code may run, and on what* — decomposes onto two mechanisms,
which is what makes it a good fit.

**"When it may run" is the taint axis.** Taint is one bit, so it expresses exactly one thing.

```
code_candidate (tainted; source as content-addressed artifact)
  → scanner workers claim by template: lint, tests-in-sandbox, SAST, license
  → each acks an attestation record (parent: the candidate) — tainted, as descendants
  → a human or supervisor reviews the attestations
  → privileged DECLASSIFY emits the clean successor
  → only now can a requireUntainted executor claim it
```

The sandbox tier sits *before* clearance: a permissionless sandbox is the cheap first attestation,
and its run result is evidence for the gate. **Verified nuance** — the exec worker imposes no taint
barrier, so tainted work *would* be claimed and run; it is the isolation, not a taint check, that
carries the risk there. No comment or test asserts this as intent, so treat it as a property of the
current code rather than a documented decision.

**"On what" is the grants axis**, because one bit cannot distinguish "cleared for CI" from "cleared
for prod". Template-scoped grants do, on both sides, per §2.2.

**The bytes are bound to the approval by content addressing.** Artifact digests are over plaintext,
computed server-side, never taken from the client; records are immutable and carry `body_sha256`.
The reviewed bytes are the executed bytes.

**Authority is server-derived.** `delegation_context` is derived from the claimed lease at ack time
and is never client-writable, so the chain (human approved → gate emitted → executor ran) is
reconstructable and separate from data lineage.

### What is missing, in order of how much it hurts

Note that the first item outranks the tamper-evident log, which is the intuitive first answer.

1. **Declassify does not record who performed it.** Verified: `declassify` calls `putRaw` with no
   principal, so `created_by` — and the event's `runId` — is the space's own identity, not the
   approving operator. The event carries `operation: "put"`; there is no `declassify` operation in
   the log. The trail is the successor's `parentIds` plus an anonymous put. Bank Python's vouch, for
   all its faults, recorded *which* code owner clicked the button. A tamper-evident chain over a
   record that omits the approver protects the wrong fact. Tracked as package J in
   [plan-audit-remediation.md](plan-audit-remediation.md).
2. **Taint launders by omission.** `parent_ids` on a direct put is client-asserted. An agent that
   reads tainted content and writes a fresh record without naming the parent produces an untainted
   record. Only `ack` force-prepends the leased record. Containment holds for lease-mediated work,
   not arbitrary writes.
3. **The execution log is incomplete and operator-only.** Saved-procedure invocations carry only
   `{tool, args}` — no code in the body — so a `{kind:tool_call, tool:run_code}` query misses them.
   The executed text is synthesized (the worker prepends an `args` line), so what ran is never
   exactly what is stored. The scoped session holds no `query` grant on `tool_call`, so the audit
   query is operator-only.
4. **Clearance cannot lapse.** `GrantDef` has no TTL field and there is no sweeper; expiry is
   evaluated lazily at claim/resolve time. Time-based lapse waits on durable timers (M2). The
   workaround that works today is a `retired: true` successor.
5. **Not tamper-evident against the operator.** The hash-chained log is unbuilt (an M1 item; the
   anchored signed checkpoints are M2). Append-only and transactional is real, but nothing defends
   against a DB admin.
6. **Integrity is not re-verified on read.** `body_sha256` is never re-checked, and unencrypted blob
   `get` streams bytes without re-hashing. The encrypted path is fine — the digest is the AES-GCM
   AAD.

Items 1–3 are ordinary work against built machinery. Only 4 and 5 are milestone-gated.

**Why this beats the incumbent shapes.** CI systems gate code on checks, but the gate is pipeline
convention — nothing prevents a path that skips it, which is why SLSA-style frameworks bolt
signatures onto artifacts after the fact. Radia inverts it: the medium is the enforcement point, and
attestation, clearance and audit log are one substrate. And it covers the case the industry has no
answer for — code generated at runtime by an agent, seconds before it wants to run, where there is
no build pipeline to attest.

---

## 6. Prior art: Bank Python

Paterson's oral history of the proprietary Python monoliths inside investment banks ("Minerva",
standing in for Athena/Quartz) is the closest existence proof for Radia's central bet, and the
cautionary tale for §5.

| Bank Python                                                      | Radia                                              | Where the rhyme breaks                                          |
|-------------------------------------------------------------------|----------------------------------------------------|------------------------------------------------------------------|
| **Barbara** — hierarchical KV of pickled objects, ~16MB soft limit | The space: records + content-addressed artifacts   | Barbara is name-addressed and mutable; Radia content-routed, append-only |
| **Rings** — namespaces, stackable as overlays                      | Kinds + grants; scoping via templates              | Radia has no overlay/shadowing; rings are also how devs test     |
| Multiple instances, strongly consistent within, eventual across    | Embedded SQLite/PGlite vs. shared Postgres         | Radia's cross-instance gap is the kind registry, not auth        |
| **Dagger** — DAG of instruments, auto-revalues dependents          | `parent_ids` lineage DAG                           | Dagger is forward recompute; Radia's DAG is backward provenance  |
| **Walpole** — "mega Jenkins combined with mega systemd"            | Leases, take/ack, retries, watches                 | Radia's is a competitive work exchange, not a supervisor         |
| Source code in Barbara's `sourcecode` ring                         | Saved procedures: source as artifact + record      | Bank Python did this for the whole firm's code                   |
| **The vouch** — one code owner signs off, instantly in prod        | `grant_request` → human approval → privileged write | Radia's approval is an immutable record with lineage — but currently unattributed (§5) |
| Pickle + zip                                                       | JSON records, analyzable templates, frozen OpenAPI | Pickle executes on load; it is the anti-Radia                    |

**Where they agree.** Integration is the product: positions, market data, code and jobs in one
queryable place is almost word-for-word Radia's data-plane pitch. Both dogfood — Bank Python stores
its own source in Barbara, Radia stores its own kinds, grants and capabilities as records. And both
make deployment nearly free: "Anyone can put a job into Walpole - you need only a small ini-style
config file" is the same gravity as "start a worker, every agent gains the tool."

**The governance divergence is the point.** Bank Python let thousands of people write code straight
into the production substrate and managed the risk with trusted employment, code ownership and
compliance process — controls living entirely outside the system. The article notes no mandatory
test suite or CI gate before vouching. When Paterson described this to an outside programmer, the
response was disbelief, "asking who in the world would trust such a bank."

The answer was: accountable employees inside a legal perimeter. When the code's author is a model —
unaccountable, prompt-injectable, generating at machine rate — every one of those controls
evaporates, and the only place left for the gate is the medium itself. **Radia's gated-execution
story is Barbara's source-in-database pattern with the bank's human change control compiled into the
substrate.** That is the one-line thesis of this document.

**Lessons to take.** Substrates win by gravity, not feature comparison — Barbara became unremovable
because it was the cheapest place to put anything, so the metric that matters is "seconds until a
new agent's output lands in the space." Find the Dagger: Minerva was funded by pricing and risk, not
elegance, and §5 is the candidate here precisely because no organizational control can substitute
for it. Heed the exit costs the article is candid about — skill atrophy, "even months in, new
starters are still learning quite fundamental new things", and the circular answer that the way to
read Barbara is to use the Minerva source code. Radia's mitigations (frozen wire contract,
language-neutral JSON, SDK parity, examples using only the public API) are the right ones and should
stay non-negotiable. Expect the culture reaction: the author "nearly did" resign on seeing the
mandatory in-house IDE, then came to value shipping to prod within the hour.

---

## 7. Anti-applications

State these to avoid misdirected effort.

- **Durable execution as workflow-as-code.** Compose with Temporal; do not compete.
- **High-throughput event streaming.** Records are a coordination medium, not Kafka — the artifact
  invariant exists because payload volume breaks matching.
- **End-to-end encrypted content.** Encrypted content is coordination-invisible by construction.
- **Anything security-critical needing in-process enforcement**, since grants live at the HTTP
  boundary (§2.2).

---

## 8. Claim ledger

What was checked, with evidence pointers.

### Verified true

| Claim                                                                          | Evidence                                        |
|----------------------------------------------------------------------------------|-------------------------------------------------|
| Taint propagates along `parent_ids` at put and ack                                | `computeTaint`, `src/core/space.ts`             |
| `ack` force-prepends the leased record to `parentIds`                             | settle path, `src/core/space.ts`                |
| Clients may raise taint, never lower it                                           | `pickPut`, `handlers/records.ts`; `conformance/suites/taint.ts` |
| `declassify` is the only path clearing taint, and is ops-plane privileged          | `opts.taint` sole override; `READ_ONLY_OPS` excludes it |
| `requireUntainted` enforced inside the claim transaction                          | `rankClaimable`, `src/core/take.ts`             |
| Template-scoped grants enforced on writes, including ack-emitted results           | `bodyMatchesGrant`, `src/core/space.ts`         |
| Grant template ANDed into client match server-side                                | `combineMatch`, `src/core/matching.ts`          |
| `delegation_context` server-derived, not a `PutRequest` field                      | `deriveDelegation`, `src/core/record.ts`        |
| `$regex`/`$where`/`$expr` forbidden at compile                                     | `FORBIDDEN`, `src/core/matching.ts`             |
| Taint is a bare boolean, not in the body, therefore not template-matchable          | `RuntimeMeta`, both adapter schemas, `matchesRecord` |
| `template` is wire-visible on the take selector and in grant bodies                | `openapi/radia.yaml:184`, `:1049`               |
| **`record_edges` reverse index exists** — indexed, keyset-paged, same-transaction, backfilled | both adapters; `conformance/backfill.test.ts` |
| Graph BFS calls `childrenOf` per node under a `GRAPH_FANOUT = 200` budget           | `src/core/space.ts:1181`, `:1238`               |
| `matchesEvent` fires only on `state === "available"` and is watch-specific          | `src/core/space.ts:1257`                        |
| Event log carries no bodies (`seq, cursor, id, ts` + operation/record/kind/state)   | `SpaceEvent`, `src/storage/adapter.ts:164`      |
| Procedure source is a content-addressed artifact; result carries `{name, recordId, artifactId}` and the procedure record as lineage parent | `examples/chat/workers/exec.ts` |
| Sandbox child holds no credentials                                                 | `examples/chat/tools/exec-sandbox.ts`           |
| Hash-chained log unbuilt; events table has no hash column                          | both adapters; `design-observability.md`        |
| No sweeper exists; expiry evaluated lazily                                         | only `setInterval` in `src/` is the MCP heartbeat |
| `GrantDef` has no TTL/expiry field                                                 | `src/core/kinds.ts`                             |
| Retention GC absent — `retention_until` stored, never consulted                     | no delete path in `src/storage/`                |
| No reactive recomputation or invalidation primitive                                | no dependency edges beyond `parent_ids`         |
| Budgets entirely unbuilt                                                           | zero hits for `budget` in `src/`                |

### Plausible but false

These circulate — some appeared in other `agent_docs/` files. Check here before repeating one.

| Claim                                                    | Reality                                                                  |
|------------------------------------------------------------|---------------------------------------------------------------------------|
| "`childrenOf` is a `LIKE` scan; a reverse index is a prerequisite" | **False.** It is an indexed lookup through `record_edges`, keyset-paged, written in the same transaction, with a backfill under conformance test |
| "Auth enforcement is single-instance"                      | **Wrong.** Credentials and grants are read from records per request with no cache; a token minted on one instance authenticates on another. The real cross-instance gap is the kind registry |
| "Every program that ever ran is a query"                   | **Wrong.** Procedure invocations carry no code; executed text is synthesized; the scoped session lacks `query` on `tool_call` |
| "The exec worker acks every result with `taint:true`"      | **Partly wrong.** Artifacts and execution results yes; `saveProcedure`/`retireProcedure` success returns omit taint |
| "Only the exec worker can write `procedure` records"       | **Configuration, not invariant.** `role` defaults to `admin`, whose session sends no bearer and resolves to the `human:local` operator |
| "Three processes at three privilege levels"                | The repo's own diagram shows two; the third is the REPL/launcher         |
| "Resource limits are hard and enforced"                    | Only `$and`/`$or` depth ≤ 3 and the 32 MiB artifact cap                  |
| "`Template` is not wire-visible"                           | It is — the take selector request field, plus the grant body field       |

### Newly found gaps

- `declassify` records no principal; the event's operation is `put`, not `declassify`.
- Taint launders by omitting the parent edge on a direct put.
- `requireUntainted` is per-call, not bindable to a grant or identity.
- `authorize`/`combineMatch`/`bodyMatchesGrant` live in handlers — in-process `Space` callers bypass
  all of it.
- `body_sha256` never re-verified on read; unencrypted blob `get` does not re-hash.
- `declassify` mints a new record id with the same `body_sha256`, so a clearance keyed on record id
  and one keyed on digest diverge across it.
- The artifact put grant is checked against `{mediaType}` before `x-radia-meta` appFields are parsed,
  so an appField-scoped grant denies every artifact write (fail-closed).

---

