# Plan: garbage collection (retention sweep + registry compaction)

> Status: phases 1–2 built (2026-08-05); phases 3–4 designed, not scheduled. Origin: a measured
> finding, not a feature request — see the table below. Read
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
- `claimable: false` kinds sweep from any state: reference data sits `available` forever by design.
- Never a reserved kind, and never `artifact` until reference-aware blob GC exists (phase 4):
  sweeping an artifact record strands its bytes with no path to them but `erasures`.
- Eligibility is COLUMN predicates (`retention_until < now`, state, lease), never a body pattern:
  no oracle, no scan-budget interaction, index-served.

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
- Idempotency rows sweep by `created_at` age; rows from before the column existed (`''`) never
  sweep, because an unknown age must not read as an old one.

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
