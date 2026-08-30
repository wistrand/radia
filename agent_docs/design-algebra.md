# The coordination algebra

**Status: descriptive draft.** The mechanisms referenced are built (M0 plus the M1 auth stack);
the laws are a proposed summary, checked against the symbols they name but not normative until
they have survived review against lifecycle, retention, authorization and remediation behavior.
The stable part is the CLOSURE TEST: does a proposed feature need a new kernel operation, or is
it expressible as kinds, patterns, grants and ordinary records? Written 2026-08-30 after an
outside review observed that the extensions collectively demonstrate the second answer for model
routing, tools, durable turns, workspaces, promotion, git export, OTLP and sandboxed execution;
revised the same day after a second review corrected the first draft's laws (grow-only state,
one-way envelopes, an unqualified idempotency equation, "every guard reads the clock" and a
free-algebra claim were all wrong as stated).

Code wins over this doc on any conflict; fix the doc.

## Sorts

body (JSON) · kind · pattern (data, never code) · record (id, kind, body, parents, server-stamped
meta) · envelope state · principal · grant · lease (record, fencing epoch, deadline) · event ·
digest · bytes · DB time.

The state is four components: the record set, the envelope map, the hash-chained event log, and a
digest-to-bytes partial map (the blob store). The distinction that matters is IMMUTABLE ENTRIES,
NOT MONOTONE POPULATIONS: a record or event is never rewritten once committed, but the retained
population shrinks (retention sweep, registry compaction, the attested event horizon, shred and
blob GC; [plan-gc.md](plan-gc.md)). Registries, lineage, flows, permissions, stats and diagnostics
are all projections over these components, not state of their own.

## Generators

The ten operations of [design-api.md](design-api.md), with the payload plane beside them:

```
put    : principal x body x kind x parents x key    -> record | idempotency_conflict
take   : principal x pattern                        -> lease | null       # relation, not function
ack    : valid lease x optional (body x kind)       -> settled | lease_lost
                                                       # settle + put atomic; a record only on the
                                                       # result-bearing branch
nack, release, renew : lease -> ...
read   : principal x pattern                        -> records            # read_one / query / watch
views  : records x envelopes x events               -> projections        # registry, lineage,
                                                       # flows, stats, ops plane
blobs  : bytes <-> digest                           # artifacts; coordination stays on the record
```

Nothing else generates. The ops plane reuses the same selectors (remediation takes the query's own
predicate), artifacts are a record whose payload lives out of line
([design-data-model.md](design-data-model.md) §2.4), and extensions add zero operations (below).
Each view names what it consumes: registries and permissions fold RECORDS, lineage and flows walk
parent links, the envelope query reads ENVELOPES, stats and the feed read the EVENT log.

## Laws

Three groups, strongest claims first. Each entry: the law, its domain, the implementing symbol,
the guard.

### Equational

- **Idempotent put, on a stated domain.** `put_k ; put_k = put_k` holds for the SAME principal
  (keys scope to the agent), the same key, the same payload, within `idempotencyRetentionSeconds`
  (`src/core/space.ts`, 7d default). Same key with a different payload is `idempotency_conflict`;
  past the window the operation may execute again ([design-api.md](design-api.md) "Idempotency";
  `test/conformance/`).
- **Registry projection is a last-write-per-key fold over a record POPULATION.** `activeByKey` /
  `activeSet` (`sdk/ts/registry.ts`), taking only a `Population` so a fold over a page does not
  compile (`test/registrycost.test.ts`).
- **Registry compaction preserves the registry: `registry(R) = registry(compact_registry(R))`.**
  The object is the record population, never the event log: compaction keeps the newest record per
  key, tombstones above all. Event-log GC is a DIFFERENT operation with an attested finality
  horizon ([plan-gc.md](plan-gc.md)).
- **Withdrawal is a successor, and a later re-put outranks a tombstone.** `retired: true` is an
  element of the fold, not a delete; the ordering is why an authorization registry entry is never
  republished on a schedule ([gotchas.md](gotchas.md)).
- **Content addressing: `write(b) ; write(b) = write(b)`, absent an intervening shred, blob
  migration or key rotation.** Identical payloads are one blob (`src/storage/blobs.ts`); erasure
  deletes the mapping and never the name, so a re-write silently un-erases, which is why
  `erasures` reports it.

### Lattice (authority)

- **Authority is a PRODUCT, and a read answers `request ∧ authority`.** The dimensions: operation,
  kind, body pattern, `scope.createdBy`, the taint allowlist, and for a delegated run the grant
  intersection materialized on it. `combineMatch` (`src/core/matching.ts`) is the BODY-PATTERN
  component of that meet, not the whole of it; `Space.readFilter` (`src/core/space.ts`) applies
  the product to walks as a wall. An unscoped query answers scoped and says nothing about what it
  withheld.
- **Delegation is a meet, so attenuation cannot amplify.** `grants(worker) ∩ grants(caller)` is a
  SUBSET of each side; a capability the caller lacks can never be delegated
  (`src/core/authorization.ts`, [plan-delegation.md](plan-delegation.md);
  `test/delegation.test.ts`).
- **Taint is a join-semilattice, on runtime-derived paths.** `TAINT_LABELS` (`src/core/kinds.ts`)
  raise monotonically and lower only by privileged declassify; a grant's `scope.taint` allowlist
  is a lattice comparison. PROPAGATION is only as good as the parent list: `ack` and the broker
  supply authoritative parents, while an ordinary external client is responsible for naming every
  input it used and can omit one, so inheritance there is a convention, not a kernel guarantee
  ([design-taint.md](design-taint.md); the same caveat is on `docs/authorization.html`).
- **The pushdown is a sound over-approximation: `sql(P) ⊇ oracle(P)`.** The SQL pre-filter may
  admit too much and never too little; the oracle decides (soundness contract at the top of
  `src/storage/pushdown.ts`).
- **Provenance is not authority.** `parent_ids` is a DAG no rule reads authority from;
  `delegation_context` is the one authorization chain, server-derived from the lease
  ([design-auth.md](design-auth.md)).

### Trace (time and delivery)

- **Entries are immutable; settlement is terminal except privileged remediation.** The claim cycle
  runs both ways (leased returns to available via `nack`, `release` and lease expiry), and a
  dead-lettered record returns via `requeue` (`src/server/handlers/ops.ts`), which is
  operator-gated. What never happens: a committed record or event rewritten, or a settled attempt
  un-settled outside remediation.
- **At most one valid lease; settles are epoch-bound, and every new lease attempt gets a fresh
  fencing epoch.** A settle under a stale epoch is `lease_lost`, whatever the wall clock says
  (`src/core/take.ts`, `src/core/space.ts`; `test/conformance/`).
- **Every TIME-DEPENDENT transition evaluates on the DB clock.** Lease expiry, `availableAt`
  (clamped forward, refused past `maxPutDelaySeconds`), retention and the grace windows; never a
  client or app-server clock (`src/core/space.ts`). Guards with no time in them (authorization,
  pattern compilation, fencing comparison) read no clock and need none.
- **At-least-once applies to CLAIMED work.** A claimable record's execution attempts may repeat
  under lease recovery; settlement is once, to the epoch's winner. Facts, reads and watches carry
  no delivery contract at all, which is why a watch is a wakeup hint and the reconcile tick is the
  correctness spine ([plan-reactor-loop.md](plan-reactor-loop.md)).
- **The log is a hash chain, and honest truncation is attested.** Sealing follows the finality
  watermark; `verifyIntegrity` distinguishes an attested horizon from tampering
  (`src/core/seal.ts`, [design-observability.md](design-observability.md)).

## The closure property

**A result record re-enters `take`'s matching domain.** On the result-bearing branch of a
successful `ack`, the record emitted is an ordinary record, so work composes without a kernel
change: extensions are PROGRAMS over the kernel operations (not a free algebra; the laws above
constrain composition). An extension is only a choice of kinds, patterns, content keys and grant
shapes; `extensions/` adds conventions and `test/layering.test.ts` holds the direction (an
extension never imports `src/`). This is the formal statement of the design principle in
`CLAUDE.md` ("express features through the space, not beside it"), and
[plan-bounded-reads.md](plan-bounded-reads.md) is its side condition: the projection laws hold
only for readers that narrow or exhaust correctly.

The review test this yields: **a proposed feature is either an element (new kinds + patterns +
grants: build it as an extension or app) or a new generator, dimension or law (a kernel change to
be argued against this doc).** The defensible closure claim is scoped: the APPLICATION features
built since the kernel capabilities landed (the extensions and examples above) composed them
without adding an operation. The kernel itself did grow along the way (authorization, delegation,
delayed visibility, the ops pattern tier), each time as a new law or authority dimension argued
case by case, not as an app-specific verb.

## What this is not

An equational algebra is not the honest frame for the whole kernel, and a formalization that
ignored this would overclaim:

- `take` is a RELATION: a ranked nondeterministic choice among eligible candidates
  (`src/core/take.ts`), so its laws are refinement properties, not equations.
- Time is load-bearing: leases expire and visibility shifts on the DB clock, so the full system is
  a timed transition system with the equational fragment above inside it.
- At-least-once delivery makes equivalence hold only up to redelivery, and only for claimed work.

The honest genealogy is Linda ([research-positioning.md](research-positioning.md)): tuple spaces
have exactly this literature (process-algebraic semantics, Busi/Gorrieri/Zavattaro). Radia's delta
over `out/in/rd` is statable in one line: fenced leases, immutability plus lineage, the authority
product, and delayed visibility.

## What the statement buys

- The closure review test above, applied before any new endpoint or verb.
- Decidability: patterns are data with no `$regex`/`$where`, so pattern-subsumption questions
  (does grant A cover grant B; can data leave this compartment) are computable in principle.
  `auditCompartment` (`extensions/ts/compartment.ts`) is a hand-built instance. INFERRED: no
  general subsumption procedure is implemented, and nothing currently needs one.
- A law-to-guard index: every law above names its implementation and its test, which is what keeps
  this doc from drifting into prose the code no longer keeps.
