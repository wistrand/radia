# Plan: garbage collection (retention sweep + registry compaction)

> Status: phases 1–2 built (2026-08-05), plus the amortized write-path sweep, idempotency-row
> sweeping and kind-level `defaultRetentionSeconds` (2026-08-06); phases 3–4 designed, not
> scheduled. Origin: a measured finding, not a feature request — see the table below. Read
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

## Eligibility (phase 1)

- Never a record whose lease is unexpired, whatever its state (the CLAUDE.md invariant, as SQL).
- Never `available` work of a claimable kind: unclaimed work is not litter, `deadline_at` owns
  giving up. Claimable kinds sweep only from `consumed` / `dead_letter`.
  **Stated plainly, because it compounds: unstamped abandoned work has NO deletion path at all.**
  Nothing enforces `deadline_at` (it appears nowhere in the claim path), so an unclaimed job sits
  `available` forever; `remediate --stale` can dead-letter it, but a dead-lettered record without
  a `retention_until` still never sweeps. That chain is deliberate — each link is the safe choice —
  and its end state is immortal abandoned work until durable timers (M2) give `deadline_at` teeth.
  An operator who wants such work gone today must requeue-or-dead-letter it AND stamp retention on
  what replaces it, or declare a `defaultRetentionSeconds` on the kind going forward.
- `claimable: false` kinds sweep from any state: reference data sits `available` forever by design.
- Never a reserved kind, and never `artifact` until reference-aware blob GC exists (phase 4):
  sweeping an artifact record strands its bytes with no path to them but `erasures`.
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
  integrity property. Event GC (phase 3) is where the chain work lives.
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
- `interest` is neither retention nor keep-newest: an interest is live while its RUN is live, so
  interests of terminal runs sweep (the `liveInterests` liveness test, applied destructively).
- **Never compacted: `grant`, `kind_def`, `signal`, `agent_definition`.** "The audit trail
  survives revocation" is a documented property of grants; the others are small, security-load-bearing,
  or both. Revisit only with the event-horizon story (phase 3) in hand.

## Surface

On demand, never a timer — the lesson `Notifier`, `sweepWatches` and sealing already carry.
`POST /v0/ops/gc` (operator-only, ops plane, so no frozen-contract change) runs sweep + compaction
and reports per-kind counts; `radia gc` wraps it; `radia doctor` reports the sweepable backlog so
the operator learns there is something to run. Batched keyset deletes, per-batch transactions,
idempotent, safe to run concurrently (a lost race deletes zero rows).

**And the amortized half, so GC is a property of an active space rather than an operator
discipline.** Every `gcEveryWrites` record commits (default 1000; `0` disables), the writing call
runs ONE small retention batch inline (`AMORTIZED_BATCH`, 256 rows) — the lazy-lease-expiry shape.
No timer is involved, an idle space runs nothing and does not grow, and the cost lands on the
principal generating the litter. Awaited rather than fire-and-forget, so the Nth writer pays a
bounded few milliseconds and the behaviour is deterministic under test. Retention only: compaction
walks whole registries, its litter grows per session not per write, and it stays with the verb. A
live `gc` call restarts the amortized clock; a DRY one deliberately does not, or doctor's own
backlog report would forever postpone the sweep it reports on.

## Phases

1. **Retention sweep** — port method + both adapters, `core/gc.ts`, ops verb, doctor row, chat
   stamps `llm_chunk`/`progress` (24h) and `llm_call` (7d), boot-time sweep in the chat launcher.
2. **Registry compaction** — `contentKey` on `KindDef`, keep-newest compactor, dead-run interest
   sweep, resurrection guard.
3. **Event-log retention** — seal checkpointing, `verifyIntegrity` reporting "verified in full" vs
   "attested by chain only", 410 `cursor_expired` activation. This is where the design weight is.
4. **Reference-aware blob GC** — artifacts join retention.

## Rejected

- Partition-drop retention (Postgres-only; the embedded-parity invariant kills it).
- Archive tables (hot-index row count is the problem; the audit residue already lives in events).
- Not storing chunks as records (mid-turn reattach replays chunks by watermark; no other source).
- Per-record GC events or tombstones (replaces the growth with smaller growth, forever).
