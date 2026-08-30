# The coordination algebra

**Status: descriptive.** Everything here is built (M0 plus the M1 auth stack); this doc adds no
mechanism and schedules no work. Its job is to state the kernel as a signature and laws, each law
pointing at the symbol that implements it and the guard that holds it, so the review question
"does this feature need a new kernel operation, or is it an element of the existing algebra" is
checkable rather than taste. Written 2026-08-30 after an outside review observed that the
extensions collectively demonstrate the kernel is closed under composition: model routing, tools,
durable turns, workspaces, promotion, git export, OTLP and sandboxed execution were all built
without a kernel change.

Code wins over this doc on any conflict; fix the doc.

## Sorts

body (JSON) · kind · pattern (data, never code) · record (id, kind, body, parents, server-stamped
meta) · envelope state · principal · grant · lease (record, fencing epoch, deadline) · event ·
digest · bytes · DB time.

The state is four components: a grow-only set of records, an envelope map, an append-only
hash-chained event log, and a digest-to-bytes partial map (the blob store). Every other view
(registries, lineage, flows, stats, diagnostics) is a fold over these, not state of its own.

## Generators

The ten operations of [design-api.md](design-api.md), with the payload plane beside them:

```
put    : principal x body x kind x parents x key  -> record
take   : principal x pattern                      -> lease | null      # relation, not function
ack    : lease x body x kind                      -> record            # settle + put, atomic
nack, release, renew : lease -> ...
read   : principal x pattern                      -> records           # read_one / query / watch
folds  : log -> derived views                     # lineage, registry, flows, stats, ops plane
blobs  : bytes <-> digest                         # artifacts; coordination stays on the record
```

Nothing else generates. The ops plane reuses the same selectors (remediation takes the query's own
predicate), artifacts are a record whose payload lives out of line
([design-data-model.md](design-data-model.md) §2.4), and extensions add zero operations (below).

## Laws

Three groups, weakest claims last. Each entry: the law, the implementing symbol, the guard.

### Equational

- **Idempotent put: `put_k ; put_k = put_k`.** A keyed re-put answers with the stored response;
  checked BEFORE lease validation, or a replayed ack falsely answers `lease_lost`
  ([design-api.md](design-api.md) "Idempotency"; `test/conformance/`).
- **Registry projection is a last-write-per-key fold.** `activeByKey` / `activeSet`
  (`sdk/ts/registry.ts`), taking only a `Population` so a fold over a page does not compile
  (`test/registrycost.test.ts`).
- **Compaction preserves the projection: `project(compact(log)) = project(log)`.** The sweep keeps
  the newest record per key, tombstones above all
  ([plan-gc.md](plan-gc.md), [plan-registry-cost.md](plan-registry-cost.md)).
- **Withdrawal is a successor, and a later re-put outranks a tombstone.** `retired: true` is an
  element of the fold, not a delete; the ordering is why an authorization registry entry is never
  republished on a schedule ([gotchas.md](gotchas.md)).
- **Content addressing: `write(b) ; write(b) = write(b)`.** Identical payloads are one blob
  (`src/storage/blobs.ts`); erasure deletes the mapping, never the name, so the digest in the
  record stays valid and a re-write silently un-erases, which is why `erasures` reports it.

### Lattice (authority)

- **A read answers the meet: `pattern ∧ grants`.** The ∧ is a function, `combineMatch`
  (`src/core/matching.ts`); walks take the same meet as a wall via `Space.readFilter`
  (`src/core/space.ts`). An unscoped query answers scoped and says nothing about what it withheld.
- **Effective authority is a join of grants; delegation is a meet.** `grants(worker) ∩
  grants(caller)` is a SUBSET of each side, so attenuation can never amplify and a capability the
  caller lacks can never be delegated (`src/core/authorization.ts`,
  [plan-delegation.md](plan-delegation.md); `test/delegation.test.ts`).
- **Taint is a join-semilattice.** `TAINT_LABELS` (`src/core/kinds.ts`) raise monotonically, lower
  only by privileged declassify, and a grant's `scope.taint` allowlist is a lattice comparison, so
  a label added later is barred by every existing grant ([design-taint.md](design-taint.md)).
- **The pushdown is a sound over-approximation: `sql(P) ⊇ oracle(P)`.** The SQL pre-filter may
  admit too much and never too little; the oracle decides (soundness contract at the top of
  `src/storage/pushdown.ts`).
- **Provenance is not authority.** `parent_ids` is a DAG no rule reads authority from;
  `delegation_context` is the one authorization chain, server-derived from the lease
  ([design-auth.md](design-auth.md)).

### Trace (time and delivery)

- **Records are monotone; envelopes advance one way.** The record set only grows (immutability),
  and an envelope moves along open -> leased -> settled/dead-lettered, never back
  (`test/conformance/`).
- **At most one valid lease; settles are epoch-bound.** A settle under a stale fencing epoch is
  `lease_lost`, whatever the wall clock says (`src/core/take.ts`, `src/core/space.ts`;
  `test/conformance/`).
- **Every guard reads the DB clock.** Never a client or app-server clock; `availableAt` is clamped
  forward and refused past `maxPutDelaySeconds` (`src/core/space.ts`).
- **Delivery is at-least-once.** Observational equivalence holds only up to redelivery, which is
  why idempotency lives at the effect boundary and `event.causedBy` exists
  ([design-api.md](design-api.md) "The guarantee").
- **The log is a hash chain.** Sealing follows the finality watermark and `verifyIntegrity`
  distinguishes attested truncation from tampering (`src/core/seal.ts`,
  [design-observability.md](design-observability.md)).

## The closure property

**The codomain of `ack` is the domain of `take`'s matching.** A result is an ordinary record, so
work composes without a kernel change: the extension tier lives in the free algebra over the
generators above. An extension is only a choice of kinds, patterns, content keys and grant shapes;
`extensions/` adds conventions and `test/layering.test.ts` holds the direction (an extension never
imports `src/`). This is the formal statement of the design principle in `CLAUDE.md` ("express
features through the space, not beside it"), and [plan-bounded-reads.md](plan-bounded-reads.md) is
its side condition: the projection laws hold only for readers that narrow or exhaust correctly.

The review test this yields: **a proposed feature is either an element (new kinds + patterns +
grants: build it as an extension or app) or a new generator or law (a kernel change that must be
argued against this doc).** Every M0/M1 feature so far has been an element; the ops PATTERN tier
([architecture-ops-tiers.md](architecture-ops-tiers.md)) is the recent example of the second kind,
and it changed a LAW (what `readFilter` answers), not the signature.

## What this is not

An equational algebra is not the honest frame for the whole kernel, for three reasons, and a
formalization that ignored them would overclaim:

- `take` is a RELATION: a ranked nondeterministic choice among eligible candidates
  (`src/core/take.ts`), so its laws are refinement properties, not equations.
- Time is load-bearing: leases expire and visibility shifts on the DB clock, so the full system is
  a timed transition system with the equational fragment above inside it.
- At-least-once delivery makes equivalence hold only up to redelivery.

The honest genealogy is Linda ([research-positioning.md](research-positioning.md)): tuple spaces
have exactly this literature (process-algebraic semantics, Busi/Gorrieri/Zavattaro). Radia's delta
over `out/in/rd` is statable in one line: fenced leases, immutability plus lineage, the authority
lattice, and delayed visibility.

## What the statement buys

- The closure review test above, applied before any new endpoint or verb.
- Decidability: patterns are data with no `$regex`/`$where`, so pattern-subsumption questions
  (does grant A cover grant B; can data leave this compartment) are computable in principle.
  `auditCompartment` (`extensions/ts/compartment.ts`) is a hand-built instance. INFERRED: no
  general subsumption procedure is implemented, and nothing currently needs one.
- A law-to-guard index: every law above names its test, which is what keeps this doc from
  drifting into prose the code no longer keeps.
