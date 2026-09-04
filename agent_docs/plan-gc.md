# Plan: garbage collection (retention sweep + registry compaction)

> Status: ALL FOUR PHASES BUILT (records 2026-08-05; the amortized write-path sweep,
> idempotency-row sweeping, kind-level `defaultRetentionSeconds`, and all three steps of
> event-log retention 2026-08-06; reference-aware blob GC 2026-08-11, "Phase 4" below).
> Origin: a measured finding, not a feature request — see the table below. Read
> [design-data-model.md](design-data-model.md) for `retention_until`'s field semantics and
> [design-observability.md](design-observability.md) for the event chain GC must not break.

## The problem, measured

Two growth engines, on a live chat space of 10,311 records (61 MB):

| engine | evidence | grows per |
|---|---|---|
| LLM ephemera | `llm_chunk` 841 (8.2/call, cadence-limited), `progress` 973 | turn |
| `llm_call` bodies | 747 records holding **8 MB of the 10 MB of all bodies** (full prompt arrays) | turn |
| registry successors | `agent_run` 2,074 over 304 runs · `capability` 1,498 over **39 tools** (38:1) · `interest` 1,769, per-run | session / renewal |
| the other stores | `events` 1.19/record · `idempotency` 4,758 rows | write |

Registry successors are 52% of all records today; under heavy streaming the ephemera win (a 60s
answer is ~400 chunks). Litter is not only disk: flow mining scans a 5,000-record prefix, `stats`
is linear, and a space that is half dead successors answers "what does this space do" with its own
exhaust.

## Two problems, not one

- **Retention sweep**: delete records whose writer declared an expiry (`retention_until`, a real
  column, wire-carried since v0.3, stored and never consulted until now). Correctness is
  eligibility.
- **Registry compaction**: delete SUPERSEDED entries of latest-wins registries, keeping the newest
  per content key. Correctness is the projection: **the newest entry per key must survive even
  when it is a `retired: true` tombstone** — sweep a retire-marker while an older live entry
  survives and the withdrawal is silently undone. Resurrection is the failure mode, and its guard
  must be proved to fail on a planted regression.

They share the deletion mechanics and nothing else.

## GC is sanctioned, not a betrayal

- CLAUDE.md's timing invariant constrains it by name: "Retention GC never discards a valid
  in-flight lease's completed work." You do not constrain the forbidden.
- The 410 `cursor_expired` watch path was built "dormant until event-log retention (M2)".
- The erasure carve-out set the pattern: destroy the payload, keep the evidence. Record GC is the
  same move one level up — the record goes; the EVENT LOG keeps id, kind, `body_sha256` and every
  transition (~200 bytes against ~1.1 KB/record all-in, measured in `bench/deployment.ts`).
- Immutable means never rewritten, not permanent. Absence of `retention_until` = permanent, always.

## The ledger: what each sweep buys, and what it costs

The one place the trade is stated whole; the sections below carry the mechanics.

- **Record sweep** (on for any record stamped or kind-defaulted; the amortized pass keeps an
  active space from growing).
  Won: bounded rows and disk; flow mining, `stats` and the Feed read work instead of exhaust.
  Lost: the BODY. Lineage over a swept parent reports fragments, v1 cannot answer "swept or never
  existed", and a swept record cannot parent new work (`parent_not_found`). What survives: the
  event residue (id, kind, `body_sha256`, every transition) — until the event horizon below.
- **Registry compaction** (the verb, AND amortized per keyed kind since 2026-08-23).
  Won: projections whose read cost is the number of MEANINGS, not the number of writes.
  Lost: succession history of compacted registries (who republished, when, how often).
  Never lost: `grant`/`kind_def`/`signal`/`agent_definition` history, and the newest entry per
  key, tombstones above all.
- **Event sweep** (opt-in: `eventRetentionSeconds`; off = the log is complete from genesis).
  Won: the log and seal tables stop growing, which no record setting achieves (they grow per
  WRITE); and stale watch resumes are refused (410) instead of silently jumping the gap.
  Lost: audit and re-execution reach the horizon, not genesis; the record sweep's evidence
  residue now expires too (the two-tiered promise); a from-zero ops read is the retained log,
  annotated; a watch asleep past the window must re-sync by query. What survives: the anchor
  seal, its dense idx counting exactly how many links history lost, and the sealed statement
  that lets verify tell honest GC from tampering — on an UNSIGNED space, naive-edit evidence
  only, like the chain itself.
- **Never lost under any setting:** erasure detection (`shred` records + blob stat, never
  events), work under a live lease, unclaimed claimable work, reserved kinds, artifact records.

## Eligibility (phase 1)

- Never a record whose lease is unexpired, whatever its state (the CLAUDE.md invariant, as SQL).
- Never `available` work of a claimable kind: unclaimed work is not litter, `deadline_at` owns
  giving up. Claimable kinds sweep only from `consumed` / `dead_letter`.
  **Stated plainly, because it compounds: unstamped abandoned work has NO deletion path at all.**
  Nothing enforces `deadline_at` (it appears nowhere in the claim path), so an unclaimed job sits
  `available` forever; `remediate --stale` can dead-letter it, but a dead-lettered record without
  a `retention_until` still never sweeps. That chain is deliberate — each link is the safe choice —
  and its end state is immortal abandoned work until something gives `deadline_at` teeth. Delayed
  visibility (2026-08-21) did NOT: `availableAt` defers when work STARTS being claimable, and
  `deadline_at` is still stored, indexed on the envelope, and read by nothing.
  An operator who wants such work gone today must requeue-or-dead-letter it AND stamp retention on
  what replaces it, or declare a `defaultRetentionSeconds` on the kind going forward.
- `claimable: false` kinds sweep from any state: reference data sits `available` forever by design.
- Never a reserved kind — except `artifact`, since phase 4: with the blob pass reclaiming
  unreferenced bytes, an artifact record whose writer declared retention sweeps like any other
  reference record (any state, `claimable: false`). Before phase 4 sweeping one stranded its
  bytes with no path to them but `erasures`, which is why the exclusion existed.
- Eligibility is COLUMN predicates (`retention_until < now`, state, lease), never a body pattern:
  no oracle, no scan-budget interaction, index-served.
- A kind may declare `defaultRetentionSeconds` on its `kind_def`: MATERIALIZED into
  `retention_until` at commit (DB clock), on the put path and the ack-result path alike, with an
  explicit stamp always winning. Materialize-at-commit is the load-bearing choice: every record
  stays self-describing and a redeclaration changes only future records — a default consulted at
  sweep time would make a kind_def redeclare a mass-deletion instrument over history. The
  consequence is the declarer's to own: absence stops meaning permanence for that kind, and a
  writer wanting one record kept stamps a far-future date. This replaced retention remembered per
  call site, which is the repo's named most-repeated bug class wearing a new field.

## What deletion breaks, and the answers

- `record_runtime` (FK) and `record_edges` rows go in the record's transaction, per batch.
- A surviving child's `parent_ids` may name a swept id. `getLineage` already tolerates it
  (`getRecords` simply returns fewer); flows already has the fragment concept. v1 does NOT answer
  "swept or never existed" — the per-kind horizon design (monotonic ULIDs make one id a coarse
  tombstone for everything before it) is deferred until an inspection consumer needs it, because
  mixed retentions make it "possibly swept" at best and per-record tombstones would defeat the
  reclamation.
- `put` refuses a parent that does not exist, so a swept record cannot parent NEW work
  (`parent_not_found`). That is the retention contract read back: stamping a retention promises
  nothing will reference the record after it. Pinned in conformance, stated here.
- The seal chain is over EVENTS and events carry their own `body_sha256`, so record GC breaks no
  integrity property. Event GC is where the chain work lives — see "Phase 3" below, including why
  the obvious design (keep seals, drop events) measurably fails to change the asymptote.
- One recordless `gc` event per sweep batch (kind, cutoff, count) — audit without per-record
  events, which would trade 1.1 KB of record for 200 bytes of event forever.
- Idempotency rows sweep by `created_at` age (`idempotencyRetentionSeconds`, default 7 days); rows
  whose age is `''` never sweep, because an unknown age must not read as an old one. Two findings
  behind that sentence: this section CLAIMED the sweep a day before it existed (the drift class
  this repo names), and the insert had never stamped `created_at` at all — every row was `''`, so
  the sweep as first written would have deleted nothing forever. Both fixed, both pinned.

## Compaction scope (phase 2)

- Keep-newest-per-content-key, including tombstones. Delete only entries strictly older than the
  newest for the same key.
- Keys: `agent_run` → `run` (in code). App registries declare `contentKey` paths on their
  `kind_def` (additive `KindDef` field), which is what lets the runtime compact a kind it knows
  nothing about; the chat declares `capability` (provider, tool) and `model` (provider, model).
- **An absent keyed path is a VALUE, not a refusal to classify** (`keyOf`, `src/core/gc.ts`,
  corrected 2026-08-25). Records missing the same path are one entry, newest wins. It returned null
  before, which meant compaction KEPT such a record while `registryOf` SKIPPED it: a `capability`
  published with no provider was invisible to every reader of the declared key, and the tool
  vanished from the model's list with no error. Absence is not null: the marker is a NUL, which
  `JSON.stringify` never emits, so a body carrying an explicit `null` stays a separate entry.
  Consequence: `gc` now deletes superseded records that lack a keyed path, where it used to keep
  every one of them.
- `interest` is neither retention nor keep-newest: an interest is live while its RUN is live, so
  interests of terminal runs sweep (the `liveInterests` liveness test, applied destructively).
- **Never compacted: `grant`, `kind_def`, `signal`, `agent_definition`.** "The audit trail
  survives revocation" is a documented property of grants; the others are small, security-load-bearing,
  or both. Revisit only with the event-horizon story (phase 3) in hand.

## Surface

On demand, never a timer — the lesson `Notifier`, `sweepWatches` and sealing already carry.
`POST /v0/ops/gc` (the `sweep` ops power live, `observe` for dryRun; ops plane, so no
frozen-contract change) runs sweep + compaction
and reports per-kind counts; `radia gc` wraps it; `radia doctor` reports the sweepable backlog so
the operator learns there is something to run. Batched keyset deletes, per-batch transactions,
idempotent, safe to run concurrently (a lost race deletes zero rows).

**And the amortized half, so GC is a property of an active space rather than an operator
discipline.** Every `gcEveryWrites` record commits (default 1000; `0` disables), the writing call
runs ONE small retention batch inline (`AMORTIZED_BATCH`, 256 rows) — the lazy-lease-expiry shape.
No timer is involved, an idle space runs nothing and does not grow, and the cost lands on the
principal generating the litter. Awaited rather than fire-and-forget, so the Nth writer pays a
bounded few milliseconds and the behaviour is deterministic under test. A live `gc` call restarts the amortized clock; a DRY one deliberately does not, or doctor's own
backlog report would forever postpone the sweep it reports on.

**COMPACTION IS AMORTIZED TOO, since 2026-08-23, on its own counter.** This paragraph used to end
"compaction walks whole registries, its litter grows per session not per write, and it stays with
the verb". The first two clauses are right and the conclusion did not follow: litter growing per
SESSION is an argument against riding `gcEveryWrites`, not against automating it. So the trigger is
per KIND (`compactEveryWritesPerKind`, default 200, `0` disables): only keyed kinds count, and the
pass walks the one registry that just grew, so a space streaming an unkeyed kind never pays for a
walk over somebody else's registry. Measured, it is not even a trade: 1,000 writes of a keyed kind
took 177ms uncompacted and 77ms with the trigger on, because a 20-row table is cheaper to insert
into than a 1,000-row one, and the reader went from 1.66ms to 0.07ms. Why it matters at all is
[plan-registry-cost.md](plan-registry-cost.md): a registry read is linear in HISTORY, and only
compaction makes it flat.

**The counters are INSTANCE state** (`SweepState`, `src/core/gc.ts`: `writesSinceSweep` and a
per-keyed-kind `writesSinceCompact` map), never the database's. Two instances over one database
each keep their own count, so the housekeeping merely runs oftener; coordinating it would need a
shared row and a lock to save work nobody is waiting on. The sweeps reach the space through
`GcHost`, which is wider than `ChainHost` because eligibility is a question about kinds, reads and
the blob store at once, and it asks the chain to ATTEST an event-log truncation rather than
reimplementing it, or the sweep is indistinguishable from tampering when integrity next runs.

**What it costs, measured** (in-process, 2026-08-06; the per-write counter itself is unmeasurable):

| the Nth write pays          | sqlite  | pglite |
|-----------------------------|---------|--------|
| trigger, nothing to sweep   | +0.36ms | +1.7ms |
| trigger, full 256-row batch | +5.0ms  | +9.2ms |

Amortized that is 0.4–9µs per write (<1% of a put); p50 and p99 are untouched, since 1-in-1000 is
p99.9. Two shapes behind the numbers. On SQLite the batch delete is SYNCHRONOUS, so it blocks the
whole process for its ~5ms — bounded by `AMORTIZED_BATCH` by construction, and far under the 48ms
neighbour-wait the scan-budget chunking accepted; the pg dialects await, and their 9ms is mostly
GIN maintenance for the deleted bodies. And a backlog never stacks onto one write: 256 rows per
trigger means 100k expired records cost ~390 unlucky writes across 390k, or one `radia gc`, which
is the intended split — the verb drains backlogs, the amortized pass keeps a space that keeps up.
The idempotency age scan is the one un-indexed predicate, O(table) per trigger: +0.2ms (sqlite) /
+1ms (pglite) at 20k rows, left un-indexed on purpose — the table is self-bounding once swept, and
a partial index would tax every keyed write to speed up noise. Revisit only if a profile shows it:
the one-liner is an index on `created_at where created_at <> ''`.

## Phases

1. **Retention sweep** — port method + both adapters, `core/gc.ts`, ops verb, doctor row, chat
   stamps `llm_chunk`/`progress` (24h) and `llm_call` (7d), boot-time sweep in the chat launcher.
2. **Registry compaction** — `contentKey` on `KindDef`, keep-newest compactor, dead-run interest
   sweep, resurrection guard.
3. **Event-log retention** — BUILT, all three steps (see "Phase 3" below): the 410 + clamp
   boundary, the anchored verify + sealed horizon statement, and the sweep
   (`Space.gcEvents`, riding the `gc` verb; `eventRetentionSeconds` in `SpaceContext`,
   `radia dev --event-retention`, off by default).
4. **Reference-aware blob GC** — BUILT 2026-08-11 (see "Phase 4" below).

## Phase 4: reference-aware blob GC (BUILT 2026-08-11)

Artifacts join retention. The record side is one selector change (`artifact` left `neverKinds`
and joined the any-state class in `Space.sweepSelector`); the byte side is
`BlobStore.retainOnly(liveDigests, {graceMs})`, run LAST by a live `Space.gc`: the live set is
every digest a surviving artifact record carries (paged to exhaustion), and the store deletes
what is absent from it and untouched past the grace window. Three decisions carry the safety:

- **The keep set travels as DIGESTS, mapped by the store.** An encrypted store's filenames are
  HMAC(KEK, digest) precisely so a listing identifies nothing, so no port method may return
  digests from storage; the store computes keep-names (both homes, since a pre-encryption blob
  sits at its plaintext name) and deletes the complement. Sidecar DEKs and stale `.tmp`/orphan
  `.key` crash leftovers go with their payloads.
- **The grace window is the race answer, not politeness** (`blobGcGraceSeconds`, default 900).
  `putArtifact` writes bytes before committing the record, and a DEDUPED put now refreshes the
  blob's clock (mtime / `touchedAt`), so bytes younger than the grace are live whatever the
  record store says — including a put from a second process over the same directory, which no
  in-process latch could see. Ages are host-clock on purpose: mtimes are host-clock data. An
  object store has no `utimes`, so `S3BlobStore` refreshes `LastModified` with a server-side copy
  onto itself and its sweep is a paged LIST rather than a directory walk.
- **Live runs only.** `doctor` runs `gc` dry on every diagnostics, and a dry blob pass would
  walk every artifact record plus the whole blob directory to predict what the live sweep
  reports anyway (`blobs: {scanned, deleted, bytes}`).

Erasure stays the only DELIBERATE destruction and neither mechanism masks the other: a
re-written shredded digest with a surviving record is KEPT (deleting it would silently
re-assert an erasure the report says was undone), and a shredded digest simply never appears in
the store's listing. Guards: `test/conformance/suites/gc.ts` ("sweeps an expired artifact",
"never deletes a re-written shredded digest") and `test/conformance/suites/blobs.ts` (the port
contract across all four stores, the grace/touch pair on real mtimes), each proven red by a
plant. KEK rotation no longer collides with the sweep, and the two passes divide the work: a live digest's keep set covers every key's name, a payload sealed under a key this space does not hold is kept and counted (`BlobGcResult.foreign`) rather than deleted, and `Space.rewrapBlobs` re-seals the referenced ones under the current key. The rewrap is DIGEST-driven and therefore blind to what it cannot name, which is exactly what the sweep's keep-and-count half covers.

## Phase 3: event GC (analyzed and BUILT 2026-08-06)

Facts verified against the code and a live space before any of this was trusted; the build-order
list at the end carries the per-step pointers into `src/` and the plants that guard them.

**The consumers, and what each one's contract becomes.** Watch streams (SSE resume via
`Last-Event-ID`; the 410 path is live at `watches.ts` since step 1 below, firing only once a
horizon exists); ops reads
(`GET /v0/ops/events`, `space_events`, `radia events` — which page from cursor `"0"` BY DESIGN);
the seal chain (`event_seal`, one row per event, dense idx from 0); `verifyIntegrity` (re-fetches
each sealed event and recomputes its hash); the notifier (`latestCursor`, head-only, unaffected);
and record GC's own evidence promise, which this phase puts an expiry on.

**The earlier sketch here was WRONG, by measurement.** "Keep the signed seal rows, drop event
bodies" does not change the asymptote: an event row is 259 bytes all-in (measured, 3,120 kB over
12,331) and a seal row is ~230 (two 64-hex hashes, a sig, ids, PK index). Per-event seals retained
forever keep ~90% of the growth. The correct shape is ANCHOR-BASED: delete events AND seals below
the horizon, keep the newest pre-horizon seal as the anchor — each seal is self-contained
(idx, hash, prev_hash, sig), so the retained suffix verifies in full from the anchor forward. Dense
idx buys truncation visibility for free: the anchor's idx states exactly how many links history
lost, so the DEPTH of removal is provable even though content is not. This is also where the M2
"signed, externally-anchored checkpoints" row converges with GC: one design, not two.

**Honest GC is currently indistinguishable from tampering, and must not become so by weakening.**
`verifyIntegrity` hard-fails on exactly the states event GC creates: a chain starting past idx 0 is
`gap`, a swept sealed event is `missing_event` — both written as tamper verdicts, and they must
STAY tamper verdicts for anything not honestly anchored. The mechanism: the event sweep emits a
`gc` event naming the horizon, sealed into the retained suffix; verify checks the anchor against
the newest sealed horizon statement. Unforgeable without the seal key; a deeper truncation
that deletes the statement leaves an anchor with no attestation, reportable as exactly that. On an
UNSIGNED space none of this holds — event GC there makes truncation undetectable, extending the
stated posture ("unsigned detects corruption, not a rewrite"), and the report must say so. Report
grades: "N verified in full" / "M attested by anchor only (content swept)" / "begins at idx K"
(on an unsigned space: "begins at idx K, unattested").

**Ordering is what keeps an honest crash from reading as tamper.**
- Always write AND seal the horizon statement before the first delete: a crash between delete and
  statement would otherwise fabricate the unattested-anchor state on an honest sweep.
- Always delete an event and its seal together, oldest-first, per batch transaction, so every
  intermediate state is a clean prefix truncation. Delete events ahead of their seals and a
  mid-sweep verify hits `missing_event`, a tamper verdict, on honestly swept links.
- The cross-check is therefore "chain begins at idx J and the newest sealed statement attests a
  horizon >= J-1", never anchor-equals-statement: a crashed-and-resumed sweep, or a verify racing
  a live one, must still pass.

**410 is a prerequisite, not a follow-up.** A cursor below the horizon silently jumps the gap
(`getEvents` is `seq > ?` on sqlite, `xid > ?` on pg), so a watcher resuming after sleep misses
swept events and never learns — the one failure worse than deletion. It is TWO behaviors: watch
resumption gets the 410, whose body names the horizon (the client must re-sync by query), while
the ops read CLAMPS and annotates ("log begins at X; N swept before it") — a unified 410 would
permanently break every from-zero ops read on the first sweep. Two constraints found by reading
the consumers:
- Never 410 the sentinel: `"0"` and an absent cursor mean "from the beginning" and CLAMP instead.
  Both SDKs recover from 410 by resetting the cursor to the literal `"0"` and reconnecting with no
  sleep, so a uniform `cursor < horizon → 410` hot-loops every shipped client forever. With the
  sentinel exempt the shipped SDKs are correct as-is: 410, reset to `"0"`, clamp, resume.
- The check is a STORAGE-PORT change, not a handler check: cursors are opaque to the transport by
  design (`watches.ts`), so it lands on the port in both adapters plus conformance (built:
  `eventHorizon`; both dialects issue decimal-string cursors, so the comparison itself is shared,
  `resolveEventHorizon`). No new state: the horizon IS the anchor (the oldest retained seal whose
  event is gone), and the swept count is `anchor.idx + 1`.

**Policy.** Events carry no `retention_until`; the horizon is `eventRetentionSeconds` (weeks, not
hours — it must dwarf any reconnect gap) intersected with the sealed head: never sweep unsealed
events, for the chain and because that range is the watch hot tail. Which collides with a live
finding: a real space held 12,331 events and ZERO seals, because sealing is on-demand and only
verify/doctor triggers it — so the sweep must seal first, as verify already does, or a
never-doctored space sweeps nothing forever. Verb-only, never amortized: sealing on the write path
is exactly the background work the on-demand rule refuses. Seal-first makes the FIRST gc on a
never-doctored space O(history): all of it seals, `SEAL_BATCH` at a time, before anything sweeps.
Bounded batches and resumable, but doctor must report "must seal first" separately from the
sweepable backlog, or the first run looks hung.

**The evidence horizon.** This phase makes record GC's promise two-tiered: records go at the
retention horizon leaving events as residue; the residue goes at the event horizon leaving only the
anchor and its idx-count. The CLAUDE.md invariant and the OpenAPI `/ops/gc` text now carry the
two-horizon framing (updated with the build). Unqualified evidence remains the default: an
unconfigured space never truncates its log.
Unaffected, verified: erasure detection reads `shred` RECORDS plus blob stat, never events.

**Build order and the plants that matter.** (1) 410 + clamp — BUILT (2026-08-06):
`eventHorizon` on the port (`resolveEventHorizon` in `adapter.ts` is the shared derivation over
the oldest seal + whether its event survives, covering the anchor state AND a sweep in flight),
implemented in `sqlite.ts`/`pgbase.ts`, the sentinel-exempt 410 in `watches.ts`, the
`logBeginsAfter`/`sweptBefore` annotation in `ops.ts`; planted truncations pinned in
`test/conformance/suites/gc.ts` and the boundary in `http.test.ts`. (2) Anchored verify + the
sealed horizon statement — BUILT (2026-08-06): `IntegrityReport.truncated` + the
`unattested_truncation` verdict (`space.ts verifyIntegrity`, judged AFTER the walk because the
statement sits above the anchor), the statement format as one writer/reader pair in `seal.ts`
(`horizonStatement`/`attestedAnchorIdx`), and `Space.attestEventTruncation` (append via the
port's `appendGcEvent`, seal, confirm coverage) which the sweep MUST call and see `attested:
true` before deleting. Plants in `test/conformance/suites/integrity.ts`: mid-chain gap past an anchor
still fails, a deleted statement un-attests, deeper-than-attested fails, a forged anchor
signature fails, unsigned passes attested with its standing caveat. (3) The sweep itself — BUILT
(2026-08-06): `Space.gcEvents` (rides the `gc` verb when `eventRetentionSeconds` is set; never
amortized), over two port methods: `latestSealBefore` (candidates selected THROUGH seals, so
window ∩ sealed-only holds by construction) and `sweepSealedEvents` (seal+event pairs
oldest-first per transaction, anchor seal retained, its event last). Order inside `gcEvents`:
seal within a budget, pick the anchor without splitting a cursor group (an xid groups siblings;
the guard steps DOWN and sweeps less), attest and require `attested: true`, then delete; a
statement that cannot seal aborts the sweep with `more: true` and deletes nothing. Dry runs
report the seal-first debt instead of paying it, which is doctor's "must seal first" row
(`eventsSweepable`). Plants in `test/conformance/suites/gc.ts`: off-by-default, seal-first, the
unsealed-statement refusal (501 events against `SEAL_BATCH`), bounded batches with every
intermediate state verifying, and the cursor-group guard (a tampered-ts ack pair; the pg
dialects step down, sqlite need not). The end-to-end check is `test/resume.test.ts`: a
real `client.watch()` over a socket survives a sweep under its held cursor — one 410, sentinel
recovery, wakeups resume; a server that 410'd the sentinel would hang the test rather than fail
it.

## Rejected

- Partition-drop retention (Postgres-only; the embedded-parity invariant kills it).
- Archive tables (hot-index row count is the problem; the audit residue already lives in events).
- Not storing chunks as records (mid-turn reattach replays chunks by watermark; no other source).
- Per-record GC events or tombstones (replaces the growth with smaller growth, forever).
