// The retention sweep (agent_docs/plan-gc.md), on every adapter.
//
// Deletion is the second deliberate carve-out from immutability, so most of these cases pin what
// is NOT deleted: the eligibility rules are the feature, and every one of them was chosen against
// a specific wrong deletion. The sweep itself is a batched SQL delete; what needs a contract is
// which rows it may see.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { RadiaError } from "../../src/core/errors.ts";
import { activeByKey } from "../../sdk/ts/registry.ts";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  // `job` is WORK (claimable); `note` is reference data, the shape llm_chunk/progress have.
  space.registerKind({ kind: "job", indexedPaths: [{ path: "tag", type: "keyword" }] });
  space.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
  return space;
}

export const gcSuites: Suite[] = [
  {
    name: "gc sweeps what retention promised and nothing else",
    run: async (adapter) => {
      const space = newSpace(adapter);

      // The sweepable: settled work and reference records, both past retention.
      const { id: consumed } = await space.put({ kind: "job", body: { tag: "done" }, retentionUntil: PAST });
      const c = await space.take({ recordId: consumed });
      await space.ack(c!.lease);
      const { id: ref } = await space.put({ kind: "note", body: { tag: "old" }, retentionUntil: PAST });

      // The not-sweepable, one per rule:
      const { id: permanent } = await space.put({ kind: "note", body: { tag: "keep" } }); // no retention = permanent
      const { id: unexpired } = await space.put({ kind: "note", body: { tag: "soon" }, retentionUntil: FUTURE });
      // Unclaimed WORK is never litter, however old its retention: deadline_at owns giving up.
      const { id: pending } = await space.put({ kind: "job", body: { tag: "todo" }, retentionUntil: PAST });
      // A held lease protects its record whatever the clock says about retention.
      const { id: held } = await space.put({ kind: "job", body: { tag: "busy" }, retentionUntil: PAST });
      await space.take({ recordId: held }, { leaseSeconds: 300 });
      // …and the lease guard has to hold on its OWN, which needs a LEASED REFERENCE record:
      // `claimable` is a diagnostic hint, not a matching rule, so a `note` can be taken by id, and
      // the any-state branch would sweep it mid-lease if only the state guard stood. This is the
      // one row where the two guards separate.
      const { id: heldRef } = await space.put({ kind: "note", body: { tag: "busy-ref" }, retentionUntil: PAST });
      await space.take({ recordId: heldRef }, { leaseSeconds: 300 });

      const r = await space.gc();
      assertEquals(r.swept, 2, `expected exactly the consumed job and the old note, got ${JSON.stringify(r.byKind)}`);
      assertEquals(r.byKind, { job: 1, note: 1 });
      assertEquals(r.more, false);

      assertEquals(await space.getRecord(consumed), null, "settled work past retention goes");
      assertEquals(await space.getRecord(ref), null, "reference data past retention goes");
      assert(await space.getRecord(permanent), "no retention means PERMANENT");
      assert(await space.getRecord(unexpired), "a future retention is a promise, not a state");
      assert(await space.getRecord(pending), "available claimable work is never swept");
      assert(await space.getRecord(held), "a valid lease outranks retention");
      assert(await space.getRecord(heldRef), "a valid lease outranks retention on a reference record too");

      // The envelope goes with the record: a record-less envelope is a state no reader handles.
      assertEquals(await space.getEnvelope(consumed), null);

      // Idempotent: everything eligible is gone, so a second sweep finds nothing.
      assertEquals((await space.gc()).swept, 0);
    },
  },
  {
    name: "gc leaves evidence: events survive, the chain verifies, lineage degrades honestly",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id: parent } = await space.put({ kind: "note", body: { tag: "p" }, retentionUntil: PAST });
      const { id: child } = await space.put({ kind: "note", body: { tag: "c" }, parentIds: [parent] });

      const r = await space.gc();
      assertEquals(r.swept, 1);

      // The audit residue: the swept record's put event still tells the story, and the sweep added
      // one recordless `gc` event for the kind — never one per record, which would replace the
      // growth with smaller growth forever.
      const events = await space.getEvents("0", 100);
      assert(events.some((e) => e.recordId === parent && e.operation === "put"), "the put event survives the record");
      const gcEvents = events.filter((e) => e.operation === "gc");
      assertEquals(gcEvents.length, 1);
      assertEquals(gcEvents[0].kind, "note");
      assertEquals(gcEvents[0].recordId, undefined, "a gc event is recordless: it is about a batch, not a record");
      assertEquals((gcEvents[0].detail as { swept: number }).swept, 1);

      // The chain hashes events, and events carry their own body digest, so deletion breaks nothing.
      const report = await space.verifyIntegrity();
      assert(report.ok, `the event chain must survive a sweep: ${JSON.stringify(report.failure ?? {})}`);

      // The surviving child still reads, still names its ghost parent, and a lineage walk returns
      // what exists rather than throwing on what does not.
      const kid = await space.getRecord(child);
      assertEquals(kid?.runtimeMeta.parentIds, [parent], "parent_ids is immutable body-side truth, ghost or not");
      const lineage = await space.getLineage(child);
      assertEquals(lineage.map((l) => l.record.id), [child], "the walk stops at the ghost, no throw");

      // And the retention contract read back: a swept record cannot parent NEW work. Stamping a
      // retention promises nothing will reference the record after it.
      let refused = "";
      try {
        await space.put({ kind: "note", body: { tag: "late" }, parentIds: [parent] });
      } catch (e) {
        refused = e instanceof RadiaError ? e.code : "";
      }
      assertEquals(refused, "parent_not_found");
    },
  },
  {
    name: "gc dry-run counts without deleting, which is what doctor reports",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "note", body: { tag: "x" }, retentionUntil: PAST });
      const dry = await space.gc({ dryRun: true });
      assertEquals(dry.eligible, 1);
      assertEquals(dry.swept, 0);
      assert(await space.getRecord(id), "a dry run must not delete");
      // And the report surfaces it, so an operator learns there is something to run.
      const diag = await space.diagnostics();
      assertEquals(diag.sweepable?.eligible, 1);
      assertEquals(diag.sweepable?.byKind, { note: 1 });
    },
  },
  {
    name: "gc never touches reserved kinds, artifact records above all",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // An artifact whose retention has passed. Sweeping the RECORD would strand the BYTES with no
      // path to them but the erasure report, so artifacts are excluded until blob GC exists; the
      // record survives and the erasure path (`shredArtifact`) stays the only way to destroy data.
      const { id } = await space.putArtifact(new TextEncoder().encode("bytes"), {
        mediaType: "text/plain",
        retentionUntil: PAST,
      });
      // CONSUMED, deliberately: an available artifact is already saved by the state guard, so this
      // is the row where the reserved-kinds exclusion is the only thing standing. Take-by-id works
      // on any kind (`claimable` is a hint, not a rule), so this state is reachable, and without
      // the exclusion a consumed artifact would sweep and strand its bytes.
      const claim = await space.take({ recordId: id });
      await space.ack(claim!.lease);
      const r = await space.gc();
      assertEquals(r.swept, 0, "an artifact past retention is NOT swept in v1, even consumed");
      assert(await space.getRecord(id));
      assert(await space.readArtifact(id), "and its bytes still read");
    },
  },
  {
    // COMPACTION (plan-gc.md phase 2). The failure mode is resurrection, so the central case here
    // is the tombstone: the newest entry per key survives even when it is `retired: true`, or a
    // withdrawal silently un-happens. Everything is checked through the same projection the
    // consumers read (`activeByKey`), because "the projection is unchanged" IS the contract.
    name: "gc compaction keeps exactly what the projection reads, tombstones above all",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "cap",
        indexedPaths: [{ path: "tool", type: "keyword" }],
        claimable: false,
        contentKey: ["tool"],
      });
      const put = (body: Record<string, unknown>) => space.put({ kind: "cap", body });
      // `search`: three supersessions, live at the end. `draw`: retired at the end — the
      // resurrection row. `odd`: no `tool` field at all, so it cannot be classified.
      await put({ tool: "search", v: 1 });
      await put({ tool: "search", v: 2 });
      const { id: searchNewest } = await put({ tool: "search", v: 3 });
      const { id: drawOld } = await put({ tool: "draw", v: 1 });
      const { id: drawRetired } = await put({ tool: "draw", retired: true });
      const { id: unclassifiable } = await put({ other: "shape" });

      const projection = async () => {
        const rows = await space.query({ kind: "cap" }, 100, { dir: "desc" });
        return [...activeByKey<{ tool?: string }>(rows, (b) => b?.tool).entries()]
          .map(([k, r]) => `${k}:${(r.body as { v?: number }).v ?? "retired?"}`)
          .sort();
      };
      const before = await projection();

      const r = await space.gc();
      assertEquals(r.compaction?.compacted, 3, "the two old search versions and the old draw");

      assert(await space.getRecord(searchNewest), "the newest per key survives");
      assert(await space.getRecord(drawRetired), "the TOMBSTONE survives: deleting it would resurrect the tool");
      assertEquals(await space.getRecord(drawOld), null, "the superseded live entry under a tombstone goes");
      assert(await space.getRecord(unclassifiable), "a record missing a key path is never deleted on a guess");

      assertEquals(await projection(), before, "compaction must be invisible to the projection");
      // What activeByKey folds: `search` live, `draw` retired away. Stated once explicitly, so the
      // projection-equality above cannot be trivially satisfied by both being wrong.
      assertEquals(before, ["search:3"]);

      // Idempotent: the survivors are each the newest of their key.
      assertEquals((await space.gc()).compaction?.compacted, 0);
    },
  },
  {
    name: "gc compaction of the bootstrap chain keeps the credential working and the audit intact",
    run: async (adapter) => {
      const space = new Space(adapter);
      // A run that RENEWED: mint + renewals are successor records under one `run` key, and only
      // the newest matters to credential resolution. The check that counts is not the record
      // count, it is that the TOKEN still resolves afterward.
      const { definitionToken } = await space.createAgentDefinition("agent:w", []);
      const { run, runToken } = await space.mintRun(definitionToken);
      await space.renewRun(run);
      await space.renewRun(run);
      const runRecords = () => space.query({ kind: "agent_run", match: { run } }, 50);
      assert((await runRecords()).length >= 3, "mint + two renewals should be successor records");

      // A STOPPED run beside it: its newest record IS the stop, which must survive compaction or
      // the revocation un-happens — the same resurrection hazard as a retired capability.
      const { run: stopped, runToken: stoppedToken } = await space.mintRun(definitionToken);
      await space.stopRun(stopped);

      // Interests: one from the live run, one from the stopped run, one from a person. Liveness is
      // the interest registry's key, so only the stopped run's entry is litter.
      await space.put({ kind: "interest", body: { kind: "job", match: {} } }, undefined, run);
      await space.put({ kind: "interest", body: { kind: "job", match: {} } }, undefined, stopped);
      await space.put({ kind: "interest", body: { kind: "job", match: {} } }, undefined, "human:alice");

      const r = await space.gc();
      assert((r.compaction?.byKind["agent_run"] ?? 0) >= 2, "the superseded run records go");
      assertEquals(r.compaction?.byKind["interest"], 1, "exactly the dead run's interest goes");

      assertEquals((await runRecords()).length, 1, "one record per run remains: the newest");
      const resolved = await space.resolveToken(runToken);
      assert(resolved.ok && resolved.kind === "run" && resolved.principal === run, "the live token still resolves through the survivor");
      const refused = await space.resolveToken(stoppedToken);
      assert(!refused.ok && refused.reason === "run_stopped", "the stop record survived compaction, so the revocation still holds");

      const interests = await space.query({ kind: "interest" }, 50);
      const authors = interests.map((i) => i.runtimeMeta.createdBy).sort();
      assertEquals(authors, ["human:alice", run].sort(), "live run and person keep their interests");

      // The chain that must NEVER compact: a definition and its revocation are the audit trail.
      // A contentKey is DECLARED on it here, deliberately — in-process registration skips the
      // reserved-redeclaration checks, so the exclusion list in `core/gc.ts` is the only thing
      // standing, and this is the row that proves it stands. Without the declaration the kind has
      // no key and the exclusion is dead code that any refactor could drop unnoticed.
      space.registerKind({
        kind: "agent_definition",
        indexedPaths: [{ path: "agent", type: "keyword" }, { path: "tokenHash", type: "keyword" }],
        claimable: false,
        contentKey: ["agent"],
      });
      const { definitionToken: dt2 } = await space.createAgentDefinition("agent:gone", []);
      void dt2;
      await space.revokeDefinition("agent:gone");
      const before = (await space.query({ kind: "agent_definition" }, 50)).length;
      assert(before >= 2, "a definition and its revocation are separate records");
      await space.gc();
      assertEquals((await space.query({ kind: "agent_definition" }, 50)).length, before, "agent_definition never compacts, whatever key anyone declares: revocation history is the audit");
    },
  },
];
