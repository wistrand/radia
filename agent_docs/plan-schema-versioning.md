# Plan: schema versioning and migration

> Status: PHASES 1, 2 AND 3 BUILT 2026-08-29 (`incompatibleChanges` and `KindRegistry.versionOf` in
> `src/core/kinds.ts`; `Space.checkRedeclaration`, `Space.patternsBrokenBy` and
> `Space.declarationCount`; `test/conformance/suites/schemaversion.ts`); phase 4 designed, not built. The last M1 item with no decision on record
> ([plan-milestones.md](plan-milestones.md), "schema version registry"). Written after auditing what
> a kind actually declares, which is narrower than the feature's name suggests and changes what is
> worth building.

## What a kind declares, and what it does not

**A kind declares no body schema, and never has.** `KindDef` (`sdk/ts/wire.ts`) is `indexedPaths`,
`sortablePaths`, `claimable`, `contentKey`, `usage`, `defaultRetentionSeconds`. No write path
validates a record body. So versioning here cannot mean "check bodies against a versioned schema"
without adding a concept the runtime does not have; it means versioning the ROUTING CONTRACT and the
patterns pinned to it.

**`schemaVersion` already existed and meant nothing.** It was on every record, server-assigned, and
stamped from `SpaceContext.schemaVersion`, a space-wide constant `1`. The field was reserved for
this and never wired to anything, which is what phase 1 below changed; `SpaceContext.schemaVersion`
survives as the fallback for a record of an UNDECLARED kind.

**A redeclaration silently overwrites.** `KindRegistry.register` (`src/core/kinds.ts`) copies the new
definition over the old with no comparison. `assertReservedCompatible` exists and guards RESERVED
kinds only; its own comment says an app-owned kind is freely redeclarable.

**A declared `type` is documentation.** Verified across every consumer: `matching.ts` builds
`ctx.indexed` as path to type and then only ever asks `has(path)` or lists the keys; `sortablePaths`
is a separate membership set; `prepareKind` (`src/storage/pgbase.ts`) takes `paths: string[]` and no
types at all; the pushdown guards on the STORED JSON type per row, never the declared one, which is
what keeps its soundness contract independent of declarations. Outside `assertReservedCompatible`
and the `VALID_TYPES` check in `validateKindDef`, nothing reads it. Everyone assumes this is the
dangerous field to change and it is the safe one.

## What actually breaks on a redeclaration

Ranked by damage, and the ranking is the plan: build for the top three, report the fourth.

- **Removing an indexed path.** Every stored pattern naming it stops compiling (`undeclared_path`):
  grant scopes, interests, watches. It fails CLOSED, since a grant that cannot compile cannot widen
  anyone, but reads start throwing and a team-isolation grant quietly stops matching.
- **Flipping `claimable`, either way.** It does NOT gate `take`, which is the thing everyone assumes
  and which cost this plan a wrong first draft. What it decides is which records the RETENTION SWEEP
  may reach (`sweepSelector` in `src/core/gc.ts`: a `claimable:false` kind sweeps from ANY state,
  and unclaimed claimable work is never swept) and whether the kind is in the starvation check. True
  to false makes stored records newly DELETABLE, which is the direction that loses data; false to
  true makes them permanently unsweepable litter.
- **Changing `contentKey`.** Compaction identity changes retroactively, so records that were distinct
  entries collapse under one key and the sweep deletes the losers. The only one that loses data.
- **Adding a path.** Old records lack it, so a pattern on it silently matches nothing for them. No
  error, and the answer looks complete: the same shape as the bounded-read class
  ([plan-bounded-reads.md](plan-bounded-reads.md)).
- **Changing a type.** Harmless today, per the finding above. Affects the physical statistics hint.

## The precedent this follows

`defaultRetentionSeconds` already answered "what does a redeclaration do to existing records", and
its answer is the model for all of this: the value is MATERIALIZED into the record at commit, from
the declaration in force, so a redeclaration changes only future records and never rewrites history.
Copy that, do not invent a second rule.

## Phases

**Phase 1: stamp the version. BUILT.** `schemaVersion` stops being a space-wide constant and becomes an
ordinal over the `kind_def` successors in force at commit. Every record then says which contract it
was written under, self-describing the way `retention_until` already is. No behaviour change yet,
which is the point: it can land before anything depends on it, and it is what every later phase
reads. Wire note: the field is already `number` in `sdk/ts/wire.ts`, so an ordinal keeps the
contract; the declaring record's id would not.

**Phase 2: classify a redeclaration, and refuse an unacknowledged incompatible one. BUILT.** Generalize
`assertReservedCompatible` from reserved kinds to every kind. COMPATIBLE: adding an indexed path,
adding a sortable path already indexed, changing `usage`, changing `defaultRetentionSeconds`.
INCOMPATIBLE: removing an indexed or sortable path, changing `contentKey`, flipping `claimable`
either way. A `retired: true` marker is EXEMPT: it withdraws the kind and carries no contract, so it
drops every path by construction. The exemption's ADOPTION half shipped 2026-09-02: both write
paths used to register the tombstone (a TypeError AFTER commit, so a bare retire answered 500 and
a fresh instance's `refreshKind` 500'd every query naming the kind). `adoptKind` and `refreshKind`
now REMOVE from the process registry, and `test/conformance/suites/kinds.ts` retires bare.
An incompatible redeclaration is refused unless the write acknowledges what it supersedes.
PRESENCE of `supersedes` is what acknowledges, `null` included, which is the convention
`createAgentDefinition({supersedes})` already uses and the only thing sayable about a RESERVED kind,
whose declaration lives in code and has no record to name.

REMAINING in this phase: the compare-and-set itself. Naming the record makes the caller read the
state it is deciding on, which is most of the value, but the write is not yet keyed to it, so two
callers with different views both land. The acknowledgement is a speed bump and not a defence: a
caller holding `put: kind_def` reads the newest declaration and names it, which `test/oidc.test.ts`
demonstrates deliberately rather than working around.

**Phase 3: name what a declaration breaks, not just that it breaks something. BUILT.**
`Space.patternsBrokenBy(def)` compiles every live pattern on the kind against the PROPOSED
declaration: grants with a pattern, live interests, and this instance's watches. Phase 2 is
structural and free, and knows a path was dropped; this answers the question that follows, which is
the one an operator has, DROPPED FOR WHOM. The refusal names them, and the check runs on BOTH write
paths for the reason `validateReservedBody` already states: an `ack` emitting a `kind_def` must not
be a way around a rule a `put` obeys.

Three properties it has to have, and each is a case in the suite. It costs nothing on the common
path: the live read happens only once something STRUCTURAL says a pattern could break, so a
declaration that only adds paths pays for no query. An ACKNOWLEDGED break is not refused, so the
consequence is written onto the declaration's own event (`detail.brokePatterns`), which is the only
place it survives; the ACK path refuses identically but records nothing, since a result record is
written by the adapter's settle rather than through `putRaw`. And an EMPTY answer says what it did not see: a watch is process-local, so this
reports the ones on THIS instance and never implies it saw them all.

It is also the fault-matrix row **schema migration with live patterns**, which was covered only by
`test/backfill.test.ts`, i.e. the STORAGE schema, a different thing
([plan-validation.md](plan-validation.md)). It is what
[design-observability.md](design-observability.md) specifies as "patterns pin validated schema
versions"; the "re-validates or quarantines" half is phase 4.

**Phase 4: dispositions, and none of them is a rewrite.** Records are immutable; that invariant is
not negotiable for this feature. A declarer picks one: QUARANTINE the old records, EMIT SUCCESSORS
(consume-plus-emit, the model's own answer to "update"), or LEAVE THEM and let readers scope by
version. The third needs `schemaVersion` in a grant's `scope` beside `taint`, because it is
server-assigned runtime metadata and not a body path, so it can never be a body match.

## Rejected

**Body-shape validation (JSON Schema on a kind).** Nothing in the runtime reads a body except at
declared paths, so this would put a validator on every write to enforce something no read depends
on. The declared-path set already IS the contract, which is why
[research-app-lessons.md](research-app-lessons.md) calls `indexedPaths` the real API surface.

**A schema registry table.** The `kind_def` successors are the version history already, latest-wins
like every other registry. A side table would be the flat-API symptom CLAUDE.md names.

**Refusing an incompatible redeclaration outright.** It has to be reachable, or the only way to
change a kind is a new kind name and a fork of every pattern that reads it. The acknowledgement is
the fix, not the refusal.

**Rewriting stored records to the new shape.** Immutability is the property everything else rests
on, and a migration that rewrites is indistinguishable from tampering to the event chain.

## Open questions

- Whether phase 3 should also refuse on a COMPATIBLE change that would newly match old records,
  which is the "adding a path" hazard. Inferred, not measured: it may be noise on a space that
  redeclares often.
- What a quarantine disposition does to a claimable kind with work in flight. Untested.
- Whether `schemaVersion` should be queryable on the coordination plane or stay an ops-plane read.
  It is runtime metadata, so the envelope-query precedent (`GET /v0/ops/records?state=`) fits.

Read before adding a field to `KindDef`, before changing what a redeclaration does, or before
treating a declared `type` as something the runtime enforces.
