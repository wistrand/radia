# What two applications taught the runtime

**Status: analysis, with proposed actions. Nothing here is scheduled.** The findings are evidence
from building [examples/chat/](../examples/chat/) and [examples/analysis/](../examples/analysis/)
against `src/`; the actions at the bottom are proposals, sized, not a plan of record. Where a claim
was checked, the ledger at the end says how.

This doc synthesizes. It does not restate: the recurring traps live in
[gotchas.md](gotchas.md), the ops tiers in
[architecture-ops-tiers.md](architecture-ops-tiers.md), the extension admission rule in
[extensions/README.md](../extensions/README.md).

## Why these two

They fail differently, which is what makes the overlap interesting.

The chat is long-lived, conversational, and model-driven: its hard parts are context, credentials
and turn control flow. The analysis pipeline is short-lived, deterministic and batch: its hard part
is deciding what to recompute. Neither shares code with the other. A property both hit is a property
of the runtime rather than of an app.

## What held up

**The runtime is complete for coordination and empty for meaning, and the line is in the right
place.** The pipeline needed exactly one thing Radia does not provide: which work is stale. The DAG
(`parent_ids`), the routing, the leases, the audit and content-addressed storage were all already
there. That decision is about 60 lines and cannot be provided, because "what counts as an input" is
the application. The chat reaches the same split from the other side: the space routes records,
and a turn is a worker. Neither app had to fight the boundary.

**Indexed paths are the real API surface.** Both apps' central design decision was the same one:
which fields go in `indexedPaths`. The pipeline's entire behaviour follows from indexing
`(dataset, inputDigest, codeDigest)`, which is what makes "has this been computed" a query. The
chat's encryption is possible for the mirror reason: nothing indexes prose, so `content` can be
ciphertext and the runtime never notices. `kind_def` is not metadata. It is the schema of what is
designable.

**Content addressing carries more than it advertises.** The docs present artifacts as "bytes too
large for a body" plus the erasure boundary. Three unrelated features fell out of the same
mechanism instead: the pipeline gets memoization AND downstream invalidation by chaining an output
digest to the next input digest, and encryption gets a deletion path for record bodies by putting
wraps in an artifact. None of those is the use the doc leads with.

**A bounded context over records degrades to retrieval, not loss.** The chat's inference worker
sends the newest N messages only (a descending keyset over the sortable `index`, so a turn's cost
is bounded by the window rather than the thread), and the truncation notice is a POINTER, never a
summary: the omitted messages are still records and the assistant knows its own conversation id,
so "[N earlier messages ... not lost; retrieve them]" (`extensions/ts/context.ts`) turns the
usual lossy window into a cache miss. This is CLAUDE.md's disposition-plus-identity pair doing
real work, and it exists only because the thread lives in the space rather than in the process.

**"A client that happens to listen" scales as a pattern.** `git-serve`, `otlp` and now the analysis
web app all bind their own port and need no runtime change and no wire-contract entry. The `/v0`
surface is complete enough that a UI is a client. The analysis app additionally holds no credential:
it relays the browser's own token, so the space applies that person's grants and the app cannot
exceed them.

**The invariants force correct designs rather than merely forbidding wrong ones.** The encryption
arc is the evidence: each phase's storage choice was wrong until the next requirement appeared, and
every wrong turn was caught by an EXISTING invariant rather than by taste. A symmetric fleet key
broke on "the session creates the conversation" (deployment shape). Key material on the anchor broke
on "a session cannot fetch by id" (the ops-plane boundary). Wraps in a record body broke on "a body
has no erasure path" (the erasure invariant). Following the invariants produced the design.

## The dominant hazard, and it is one hazard

Every non-trivial bug across both apps this session was the same shape: **a projection over an
append-only log, read as if it were state.** Four instances, all found by running the thing or by a
planted test, none by the type system:

- `readOne` answers with the OLDEST match, so a successor written by enrolment was invisible.
- An idempotency key naming the conversation rather than the wrap set replayed the first write.
- Content-key idempotency expires, so a memo built on it silently stops memoizing.
- A bounded `query` where `readExhaustively` was needed.

CLAUDE.md already names this as the stopping rule for expressing features through the space.
Two independent applications hitting it four times says the rule is real and under-enforced: it is
documented prose defending against an ergonomics problem. Actions 1 and 2 below are the cheap half
of the fix.

## What is missing

**The scoped ops READ tier is AUTHOR-scoped, and the apps want work done FOR them.** Analysed in
full under action 6; the summary is that the tier exists, is opt-in, and answers a different
question than either app asks. `Space.opsScope` throws unless some grant carries both `query` and
`scope.createdBy: "self"`, then scopes to `runPrincipalsOf(subject)` — every run of that person, so
a later session still sees its earlier records. Its intended reader is an AGENT inspecting its own
work. A pipeline user authors two records (the upload artifact, the dataset) while requests,
results and outputs are worker-authored, so they would see a two-node view.

The demand is weaker than it first looks, and this is the part to hold onto: **both apps already
satisfy their users' inspection needs without the ops plane at all.** The analysis page renders the
whole pipeline — stages, states, digests, ids — from coordination queries; the chat serves its own
`space_*` tools. What neither can do is REUSE THE CONSOLE. The actionable gap is therefore a console
that assumes an operator, not an authorization model that is missing a tier.

**No CORS means every browser application proxies, and that is a TRADE rather than a gap.** The
space sends no `Access-Control-*` headers, so a page on another origin cannot call `/v0`. Proposed
as action 3 and rejected on reading `src/server/http.ts`, where the same fact is what makes the
isolated artifact origin safe:

> Artifact BYTES get their own origin... its requests back to the API are cross-origin, which no
> CORS header permits. That is what makes it safe to render an artifact someone's agent generated.

An artifact is content an agent wrote, rendered in a browser. It is served from a second port —
a different origin — so it can neither read the console's storage nor call the API. Adding CORS
turns that unconditional sentence into "safe unless somebody allowlists the wrong origin", and
under `--auth open`, where a request with no Authorization header is answered as the OPERATOR, an
allowlisted origin could read operator responses. Doing it safely needs three new invariants
(refuse `*`, refuse in open mode, refuse the artifact's own origin), each of which can be got
wrong later, to buy an application a convenience that costs about twenty lines.

The relay in `examples/analysis/serve.ts` is that twenty lines, holds no credential, and is
verified to forward a 401 from the space rather than answering itself. A browser app pays it once.

**"Which code version is live" has two mechanisms and no convention.** `extensions/ts/promotion.ts`
answers it as authorization (which digest a tier MAY run, pinned in a grant). The analysis example
invented a `stage_code` advertisement to answer it as discovery (which digest IS running). They are
complementary rather than duplicative, but nothing says so and nothing composes them.

## Where the apps are weaker than the runtime allows

Recorded because the gap is the app's, not Radia's, and both are worth fixing.

**The pipeline trusts a self-reported code digest.** A stage worker writes its own `stage_code`
record, and nothing verifies it. A worker could report digest X while running Y, and every result
would be filed and cached under a version that never produced it. The whole memo rests on an
unverified claim. Radia already has the answer: promotion pins which digest may run, a `binding`
names the digest a host runs, and a mismatch is refused rather than run.

~~**The planner re-plans every dataset on every wake.**~~ FIXED 2026-08-16 (action 4): a pass is
four reads and then map lookups, measured by a counting proxy at 4 reads for 1 dataset and 4 for 5,
where the old shape was 7 and 15. What remains is bounded and documented rather than fixed: a pass
still plans every dataset rather than the one the `Wakeup` names, and only the 50 newest, so a
larger space can leave an older stale dataset unplanned. Both want the same thing — incremental
planning from the record that changed.

## From the test harness: shared spaces, and an unexplained history penalty

Added 2026-08-16, from the extension-suite refactor rather than the two apps. The suites booted
`src/main.ts dev` PER TEST: ~1.4s of subprocess start around milliseconds of assertion, ~150
boots, 3m44s in CI. They now boot one space per FILE (`extensions/conformance/space.ts`) with
isolation moved to NAMES (`uniq()` per test), which cut the suite to ~1m15s locally. One
runtime-shaped observation surfaced: a ~13k-write burst (workspace.test.ts's manifest-cap case)
took 21s on a fresh space and 42s on one carrying the file's accumulated history — on CI
hardware, twice, in different regions — while the same comparison is only 17s vs 21s locally.
Profiled locally 2026-08-16, and every runtime-shaped suspect is EXONERATED, each by
measurement: the burst is CPU-bound server-side (~1.5ms CPU per file) and FLAT to 13k
accumulated artifacts, so data volume costs nothing; a replayed history phase changes nothing;
the amortized GC is ruled out by plan-gc.md's own cost table; and the suite's sibling spaces
(alive until process exit, since `space.ts` reaps only on unload) idle at 0% CPU — the no-timer
design holding — at ~400MB RSS each, with NINE of them adding nothing to the burst even confined
to 2 cores under a 5GB memory cap. The CI doubling therefore does not reproduce under local
simulation of the runner's CPU and memory, which leaves it ENVIRONMENTAL (vCPU quality, steal,
or throttling on the shared 2-core VM), not a property of a long-lived space. The workaround
stands and suffices: the one heavy test boots a private space, and the full suite now runs it at
18s with an aged client and nine siblings alive. Instrument a CI run before reopening this.

## Suggested actions

Ranked by value over cost. Sizes are relative: SMALL is a contained change with an obvious guard,
DESIGN-FIRST means the open question below has to be answered before code.

| # | Action | Why | Size | Lands in |
|---|---|---|---|---|
| 1 | ~~`readNewest(pattern)` on both SDKs~~ **BUILT 2026-08-16** | the hazard's commonest instance; makes the correct call as cheap as the wrong one, and lets `readOne`'s doc say "oldest match; you probably want readNewest". No new endpoint: it is `query(p, 1, {dir:"desc"})[0]` | SMALL | `sdk/ts/client.ts`, `sdk/py/radia.py`, pointer from gotchas |
| 2 | ~~A generic `contentKey(prefix, body)`~~ **BUILT 2026-08-16** | the second instance. `kindDefKey`/`grantKey`/`opsGrantKey` already do this per kind; apps re-derive it per site and get it wrong by naming the container instead of the content | SMALL | `sdk/ts/registry.ts`, beside the existing keys |
| 3 | ~~Opt-in CORS (`--allow-origin <origin>`)~~ **REJECTED 2026-08-16** | the absence of CORS is load-bearing, not an oversight: it is what makes the isolated artifact origin safe. See below | — | — |
| 4 | ~~Plan from bulk reads, in memory~~ **BUILT 2026-08-16** | O(1) queries per wake instead of O(datasets x stages); `ui.html` is the worked example | SMALL | `examples/analysis/planner.ts` |
| 5 | Pin stage code with promotion instead of self-report | turns the memo's foundation from a claim into an enforced fact, and would be the first worked composition of promotion with something other than an exec runner. **BUILT in full 2026-08-17** (stages as workspace agents, pins on both sides, shape as a `stage_def` registry): [architecture-analysis-workspace-agents.md](architecture-analysis-workspace-agents.md) | MEDIUM | `examples/analysis/`, `extensions/ts/promotion.ts` |
| 6 | A scoped ops READ tier | **ANALYSED 2026-08-16, recommendation: do not build.** Both apps already inspect their own work through the coordination plane; what they cannot reuse is the console. See below | — | a console that degrades for a scoped principal, if anything |

**Actions 1 and 2 are built** (`sdk/ts/client.ts`, `sdk/ts/registry.ts`, `sdk/py/radia.py`;
guards in `test/registry.test.ts` and `test/http.test.ts`, both proved red). Two
things the build settled that the proposal had not:

- `contentKey` HASHES rather than returning a canonical string, because `idem_key` is part of a
  PRIMARY KEY and a few kilobytes of body would cross Postgres's btree tuple limit. That forces it
  async in TS (Web Crypto) while Python's is sync (hashlib), which is an asymmetry the parity table
  now records rather than hides.
- The two SDKs have to compute the SAME key or a TS writer and a Python writer each write their own
  record. They diverged on two axes when first written (non-ASCII escaping, `1.0` vs `1`), were
  reconciled, and a THIRD axis then surfaced exactly as this entry predicted: float FORM. Python
  switches to exponent notation at 1e-5 and zero-pads it (`1e-05`) where JavaScript writes
  `0.00001`, so any body carrying a small float keyed differently. Fixed 2026-08-16: `_js_number`
  in `sdk/py/radia.py` renders per ECMA-262 (verified against `JSON.stringify` over 30k doubles),
  ints beyond 2**53 are refused since JavaScript rounds them, and the discipline is now a guard:
  `test/py-parity.test.ts` feeds one corpus of raw JSON texts through both implementations
  wherever python3 exists, including CI.

### Action 6, analysed: the open question already has an answer, and it is sharper than the question

The traversal worry was the wrong worry. `getLineage` says why walks stop at a boundary:

> Stop at a foreign ancestor rather than skipping past it: **`put` never checks that a parent is
> readable**, so a scoped principal can name any id as a parent of its own record, and an
> unfiltered walk then hands back that record's whole upstream, bodies included.

Ancestry is FORGEABLE. Anyone may name any record as their parent, so an upward walk must stop at
the boundary rather than skip past it, and it does. That also settles the two candidate semantics I
had written down: truncate-and-say-so is already chosen, and refuse-the-whole-read would let a
forged parent deny you your own lineage.

Three designs, given that:

**A. Mirror the coordination pattern into the ops scope** ("ops never widens what you can already
see"). REJECT. The aggregates — stats, events, flows, diagnostics — would need per-row body
matching where `createdBy` is a column filter, and any record carrying no scoping field becomes
invisible. That is precisely the structural hubs: a `conversation` anchor has an empty body, a
`stage_code` advertisement has no owner. Walks would truncate at the joints. Touches all twelve ops
read endpoints.

**B. Subtree scope: you may read what descends from a record you authored.** The shape to build if
this is ever built. It matches what both apps mean by "my work" (the pipeline descends from the
uploaded artifact, a chat turn from the seed the session wrote), costs one ancestry check per
request, and is safe against forged ancestry BECAUSE it is down-only: you can attach yourself to
someone else's record as a child, but you cannot make their record your descendant. Touches the six
rooted endpoints; the aggregates stay closed.

**C. No runtime change.** The ops plane is for operators; applications expose what their users may
see through the coordination plane, which is what `extensions/ts/agent-tools.ts` already splits
along and what both apps already do.

**Recommendation: C, with B recorded as the shape and A rejected.** Before treating this as a
runtime gap, notice that the thing actually missing is a console that degrades honestly for a
scoped principal — showing what it can read and naming what it cannot — which is a page change
rather than an authorization change.

One concrete finding from the analysis, already fixed: the analysis app linked to the DATASET
record, but that record and the first `stage_request` are both children of the upload artifact, so
the dataset's own subtree is empty. It looked right only because the console's default walk goes
both ways and reaches the pipeline by going up to the artifact first. Under any down-only scope it
would have shown nothing.

## Claim ledger

| Claim | How it was checked |
|---|---|
| `readOne` returns the oldest match | Empirically: enrolment wrote a successor and the reader kept returning the original wrap set until the query became `dir: "desc"`; a plant reproduced it |
| The space sends no CORS headers | `grep -c "Access-Control" src/server/http.ts` is 0 |
| Neither SDK has `readNewest` | grep, both files |
| `observe` opens every read unscoped | `src/server/http.ts` ops gate, plus architecture-ops-tiers.md |
| Self-scope needs `createdBy: "self"` on every grant | `src/core/kinds.ts`: "`authorScope` restricts only when every applicable grant says `createdBy: \"self\"`" |
| Nothing verifies a `stage_code` digest | By construction: the worker writes its own advertisement |
| The planner is O(datasets) per wake | `planAll` iterates `datasets(c)`; the watch binds the `Wakeup` to `_` |
| A person cannot forge a `stage_result` | `examples/analysis/roles.ts` withholds it; asserted in `smoke.ts` |
| Encryption's three redesigns | Each is recorded with its cause in [plan-encryption.md](plan-encryption.md) |
| A history-carrying space doubles a 13k-write burst on CI | Measured twice (two Azure regions): 41s/43s shared vs 21s on the old per-test spaces; locally 21s shared vs 17s fresh |
| The amortized GC is not that penalty's cause | plan-gc.md's measured table: 0.36–9ms per trigger, one trigger per 1000 writes |
| Neither history, data volume, nor idle sibling spaces cause it | Profiled: per-1000-file chunks flat at ~1.35s across 13k artifacts, replay of the file's history ±0, 9 idlers ±0 even under `taskset -c 0,1` with `MemoryMax=5G`; idle space CPU 0% over 15s, before and after writes |
| The fix holds in context | Full suite, aged client, nine siblings alive: the heavy test runs 18s on its private space vs 21s shared before the fix |

**Not checked, and stated as inference:** that the runtime's boundary is in "the right place" is a
judgement from two apps, not a measurement. A third application with a different shape (streaming
ingest, or anything with a hard latency budget) is the test that would falsify it.
