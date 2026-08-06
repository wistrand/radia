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
import { SealKey } from "../../src/core/seal.ts";
import { rawExec } from "./integrity.ts";

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
    // The THIRD append-only store. The subtle half is the stamp: the insert used to omit
    // `created_at`, falling to the schema's '' default — so every row read as "age unknown" and an
    // age-based sweep would have deleted nothing, forever, while the plan said otherwise.
    name: "gc sweeps aged idempotency rows, and never the ones whose age is unknown",
    run: async (adapter) => {
      const space = new Space(adapter, { idempotencyRetentionSeconds: 3600 });
      space.registerKind({ kind: "job", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await space.put({ kind: "job", body: { tag: "a" } }, "key-fresh");
      // A row from before the stamp existed: planted directly, since no current write path can
      // produce one — which is exactly why it must be pinned rather than assumed.
      // deno-lint-ignore no-explicit-any
      const db = (adapter as any).db ?? (adapter as any).sql;
      if (db?.prepare) {
        db.prepare("insert into idempotency (principal, operation, idem_key, request_hash, response_json) values ('p','put','key-unknown','h','{}')").run();
      } else {
        await db.query("insert into idempotency (principal, operation, idem_key, request_hash, response_json) values ('p','put','key-unknown','h','{}')");
      }

      // Fresh rows are inside the window: nothing sweeps.
      const first = await space.gc({ compact: false });
      assertEquals(first.idempotency, 0, "a fresh row is inside the retention window");

      // Shrink the window to zero-ish by constructing a space whose window is negative-adjacent:
      // a 1-second window plus a stamped row older than it. Simplest honest route: a second space
      // over the same adapter with a tiny window, after the clock has moved past it.
      await new Promise((r) => setTimeout(r, 20));
      const tight = new Space(adapter, { idempotencyRetentionSeconds: 0.001 });
      tight.registerKind({ kind: "job", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const swept = await tight.gc({ compact: false });
      assertEquals(swept.idempotency, 1, "the aged stamped row goes; the ''-aged row NEVER does");

      // And the replay contract degrades the honest way: the key re-executes as a fresh write.
      const again = await tight.put({ kind: "job", body: { tag: "a" } }, "key-fresh");
      assert(again.id, "a swept key re-executes rather than erroring");
    },
  },
  {
    // Kind-level default retention (plan-gc.md): declared once on the kind_def, MATERIALIZED into
    // each record at commit. The alternative was retention remembered per call site, which is the
    // named most-repeated bug class of this codebase wearing a new field.
    name: "gc kind defaults are materialized at commit, and an explicit stamp wins",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "chunk",
        indexedPaths: [{ path: "n", type: "integer" }],
        claimable: false,
        defaultRetentionSeconds: 3600,
      });
      space.registerKind({ kind: "note", indexedPaths: [], claimable: false });

      const { id: defaulted } = await space.put({ kind: "chunk", body: { n: 1 } });
      const rec = await space.getRecord(defaulted);
      assert(rec?.retentionUntil, "the default is stamped INTO the record, self-describing");
      const now = await space.now();
      assert(rec!.retentionUntil! > now, "…in the future");

      const { id: explicit } = await space.put({ kind: "chunk", body: { n: 2 }, retentionUntil: FUTURE });
      assertEquals((await space.getRecord(explicit))?.retentionUntil, FUTURE, "an explicit stamp always wins");

      const { id: plain } = await space.put({ kind: "note", body: { n: 3 } });
      assertEquals((await space.getRecord(plain))?.retentionUntil, undefined, "no default declared = permanent, as before");

      // Materialized-at-commit is what makes a redeclaration prospective: records written under
      // the old default keep their stamp, so changing the kind_def is never a mass-deletion of
      // history. The stamped value IS the contract; the def is only the pen.
      space.registerKind({
        kind: "chunk",
        indexedPaths: [{ path: "n", type: "integer" }],
        claimable: false,
        defaultRetentionSeconds: 7200,
      });
      assertEquals((await space.getRecord(defaulted))?.retentionUntil, rec!.retentionUntil, "a redeclared default changes only future records");

      // An ack-emitted result is a put with a lease attached, and gets the default too: skipping
      // that path would make every WORKER-written record of an ephemera kind permanent.
      space.registerKind({ kind: "task", indexedPaths: [] });
      const { id: taskId } = await space.put({ kind: "task", body: {} });
      const claim = await space.take({ recordId: taskId });
      const acked = await space.ack(claim!.lease, { kind: "chunk", body: { n: 9 } });
      assert(acked.status === "ok" && acked.resultId, "ack emitted a result");
      assert((await space.getRecord(acked.resultId!))?.retentionUntil, "the ack-result path stamps the kind default too");
    },
  },
  {
    // The amortized half: every `gcEveryWrites` commits, the writing call runs one small retention
    // batch inline — the lazy-lease-expiry shape, so an ACTIVE space pays for its own housekeeping
    // and an idle one runs nothing. Without this, GC is an operator discipline: the measured litter
    // grows per turn and the remedy ran only when somebody remembered.
    name: "gc runs itself amortized on the write path",
    run: async (adapter) => {
      const space = new Space(adapter, { gcEveryWrites: 5 });
      space.registerKind({ kind: "note", indexedPaths: [{ path: "n", type: "integer" }], claimable: false });
      const { id: litter } = await space.put({ kind: "note", body: { n: 0 }, retentionUntil: PAST });
      // Four more commits reach the threshold; the fifth write pays for the sweep.
      for (let i = 1; i <= 4; i++) await space.put({ kind: "note", body: { n: i } });
      assertEquals(await space.getRecord(litter), null, "the expired record went without anyone calling gc");

      // Disabled is disabled: 0 means no amortized pass, ever.
      const off = new Space(adapter, { gcEveryWrites: 0 });
      off.registerKind({ kind: "note", indexedPaths: [{ path: "n", type: "integer" }], claimable: false });
      const { id: kept } = await off.put({ kind: "note", body: { n: 10 }, retentionUntil: PAST });
      for (let i = 11; i <= 30; i++) await off.put({ kind: "note", body: { n: i } });
      assert(await off.getRecord(kept), "gcEveryWrites: 0 disables the amortized pass");

      // Housekeeping must never fail the write that happened to trigger it: the Nth put is an
      // ordinary put that drew the short straw, and a space whose storage cannot sweep (a
      // permissions change, a wedged table) must degrade to "the backlog waits", not to every
      // thousandth write failing with an error about a feature the writer never invoked.
      const broken = new Proxy(adapter, {
        get(target, prop, receiver) {
          if (prop === "sweepExpired") return () => Promise.reject(new Error("sweep exploded"));
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as StorageAdapter;
      const fragile = new Space(broken, { gcEveryWrites: 3 });
      fragile.registerKind({ kind: "note", indexedPaths: [{ path: "n", type: "integer" }], claimable: false });
      for (let i = 100; i < 110; i++) {
        const { id } = await fragile.put({ kind: "note", body: { n: i } });
        assert(id, "every put succeeds while the sweep behind it throws");
      }
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
    // The `seen` set carried ACROSS pages is the whole of keep-newest once a registry outgrows one
    // page (PAGE = 500), and no other case crosses that boundary: every fixture elsewhere is under
    // ten records, so a compactor that forgot its memory between pages — keeping one "newest" per
    // PAGE per key — would pass the entire suite while resurrecting at scale.
    name: "gc compaction remembers what it saw across page boundaries",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "cap",
        indexedPaths: [{ path: "tool", type: "keyword" }],
        claimable: false,
        contentKey: ["tool"],
      });
      // Key "b": its OLD record first, so it lands at the far end of the newest-first walk (the
      // last page), with its newest among the first page. Only a seen-set that survives the page
      // turn dooms the old one.
      const { id: bOld } = await space.put({ kind: "cap", body: { tool: "b", v: 1 } });
      const ids: string[] = [];
      for (let i = 0; i < 510; i++) ids.push((await space.put({ kind: "cap", body: { tool: "a", v: i } })).id);
      const aNewest = ids[ids.length - 1];
      const { id: bNew } = await space.put({ kind: "cap", body: { tool: "b", v: 2 } });

      const r = await space.gc();
      // 512 records, two keys: everything but the two newest goes — 509 of "a" and b's old one.
      assertEquals(r.compaction?.compacted, 510, "509 superseded a's and the cross-page b");
      assert(await space.getRecord(aNewest), "a's newest survives");
      assert(await space.getRecord(bNew), "b's newest survives");
      assertEquals(await space.getRecord(bOld), null, "b's OLD record, met two pages after its newest, still goes");
      assertEquals((await space.query({ kind: "cap" }, 600)).length, 2);
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
  {
    name: "eventHorizon: a complete log has no horizon, sealed or not",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "note", body: { tag: "a" } });
      await space.put({ kind: "note", body: { tag: "b" } });

      // Unsealed log: no seals means nothing was ever swept (the sweep is seal-first by contract).
      assertEquals(await adapter.eventHorizon("0"), { expired: false, horizon: null });

      // Sealed from genesis with every event present: still complete, whatever cursor is asked.
      await space.sealEvents();
      assertEquals(await adapter.eventHorizon("0"), { expired: false, horizon: null });
      const [ev] = await space.getEvents();
      assertEquals((await adapter.eventHorizon(ev.cursor)).expired, false);
    },
  },
  {
    name: "eventHorizon: the anchor state expires stale cursors exactly; sentinel policy stays with the caller",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const tag of ["a", "b", "c", "d", "e"]) await space.put({ kind: "note", body: { tag } });
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);
      assert(seals.length >= 5, "expected one seal per put");

      // The state the M2 sweep leaves behind: events and seals below the horizon gone, the newest
      // pre-horizon seal kept as the anchor, its own event swept with the rest.
      const anchor = seals[2];
      await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

      // The sentinel reads as expired ON PURPOSE: the watch handler exempts it, the ops read
      // annotates it. The adapter reports the truth and does not choose for them.
      const fromZero = await adapter.eventHorizon("0");
      assertEquals(fromZero.expired, true);
      assertEquals(fromZero.horizon, { cursor: anchor.cursor, swept: anchor.idx + 1 });

      // Resuming exactly at the horizon is gap-free; below it is not; a retained cursor is fine.
      assertEquals((await adapter.eventHorizon(anchor.cursor)).expired, false);
      assertEquals((await adapter.eventHorizon(seals[0].cursor)).expired, true);
      assertEquals((await adapter.eventHorizon(seals[4].cursor)).expired, false);
      // An unparseable cursor keeps today's behavior (getEvents decides), even under truncation.
      assertEquals((await adapter.eventHorizon("not-a-cursor")).expired, false);

      // The clamp is mechanical: a from-zero read starts at the oldest retained event.
      const events = await space.getEvents("0");
      assert(events.length > 0 && events.every((e) => e.seq > anchor.seq), "getEvents must serve only retained events");
    },
  },
  {
    name: "eventHorizon: a sweep in flight floors just below the oldest survivor",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const tag of ["a", "b", "c", "d"]) await space.put({ kind: "note", body: { tag } });
      await space.sealEvents();
      const seals = await adapter.getSeals(-1, 100);

      // Mid-sweep: pairs below idx 2 deleted, seal 2 and its event both still present. The exact
      // newest-swept cursor is unknowable here, so the floor over-refuses by at most one position:
      // refusing a safe cursor costs a re-sync, admitting an unsafe one costs a silent gap.
      const survivor = seals[2];
      await rawExec(adapter, "delete from events where seq < ?", [survivor.seq]);
      await rawExec(adapter, "delete from event_seal where idx < ?", [survivor.idx]);

      const h = await adapter.eventHorizon("0");
      assertEquals(h.expired, true);
      assertEquals(h.horizon, { cursor: (BigInt(survivor.cursor) - 1n).toString(), swept: survivor.idx });
      assertEquals((await adapter.eventHorizon(survivor.cursor)).expired, false);
      assertEquals((await adapter.eventHorizon(h.horizon!.cursor)).expired, false);
      assertEquals((await adapter.eventHorizon(seals[0].cursor)).expired, true);
    },
  },

  // --- the event sweep itself (plan-gc.md phase 3, step 3). Retention -1 puts the cutoff a
  // second in the FUTURE: with a millisecond clock, several puts land in one tick, and a cutoff
  // of "now" would flake on whether the last event squeaked under it.

  {
    name: "event GC is off by default: an unconfigured space never truncates its log",
    run: async (adapter) => {
      const space = newSpace(adapter);
      for (const tag of ["a", "b"]) await space.put({ kind: "note", body: { tag } });
      assertEquals((await space.gc({ dryRun: true })).events, undefined);
      assertEquals((await space.gcEvents()).enabled, false);
      assertEquals((await space.getEvents("0")).length, 2);
    },
  },
  {
    name: "event GC: seal-first, anchored, attested, and the boundary reads it back",
    run: async (adapter) => {
      const space = new Space(adapter, { eventRetentionSeconds: -1 });
      space.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
      space.sealKey = await SealKey.fromBytes(new Uint8Array(32).fill(7), "test");
      for (const tag of ["a", "b", "c", "d", "e"]) await space.put({ kind: "note", body: { tag } });

      const r = await space.gcEvents();
      assertEquals(r.attested, true);
      assert(r.anchorIdx !== undefined && r.swept === r.anchorIdx + 1, `swept ${r.swept} != anchor ${r.anchorIdx} + 1`);

      const v = await space.verifyIntegrity();
      assertEquals(v.ok, true);
      assertEquals(v.truncated, { anchorIdx: r.anchorIdx!, swept: r.swept, attested: true });
      const h = await adapter.eventHorizon("0");
      assertEquals(h.horizon?.swept, r.swept);
      const retained = await space.getEvents("0");
      assert(retained.length > 0 && retained.every((e) => BigInt(e.cursor) > BigInt(h.horizon!.cursor)));
    },
  },
  {
    name: "event GC: a dry run reports the seal-first debt instead of paying it",
    run: async (adapter) => {
      const space = new Space(adapter, { eventRetentionSeconds: -1 });
      space.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
      for (const tag of ["a", "b", "c", "d", "e"]) await space.put({ kind: "note", body: { tag } });

      // Never sealed: the dry run answers "nothing can sweep YET, and here is why", and deletes
      // and seals nothing. This is the never-doctored space of the plan, made visible.
      const dry = await space.gcEvents({ dryRun: true });
      assertEquals({ sealed: dry.sealed, unsealed: dry.unsealed, eligible: dry.eligible, swept: dry.swept, more: dry.more }, { sealed: 0, unsealed: 1, eligible: 0, swept: 0, more: true });
      assertEquals((await space.getEvents("0")).length, 5, "a dry run deletes nothing");

      // The live run pays the debt and sweeps: only-sealed is enforced by construction, since
      // candidates are selected THROUGH seals.
      const live = await space.gcEvents();
      assert(live.sealed >= 5, "the live run seals first");
      assertEquals(live.swept, live.anchorIdx! + 1);
      assertEquals((await space.verifyIntegrity()).ok, true);
    },
  },
  {
    name: "event GC: refuses to delete while the horizon statement is unsealed",
    run: async (adapter) => {
      // 501 events: attest's own sealing pass covers at most SEAL_BATCH (500) links, so with a
      // zero seal budget the statement cannot seal and the sweep MUST walk away. This is the
      // ordering rule under failure: better a sweep that does nothing than a truncation verify
      // would rightly call tampering.
      const space = new Space(adapter, { eventRetentionSeconds: -1 });
      space.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
      for (let i = 0; i < 501; i++) await space.put({ kind: "note", body: { tag: `t${i}` } });
      await space.sealEvents(1); // just enough chain for an anchor candidate to exist

      const r = await space.gcEvents({ sealBudget: 0 });
      assertEquals(r.attested, false);
      assertEquals(r.swept, 0);
      assertEquals(r.more, true);
      assertEquals((await space.getEvents("0", 1000)).length, 502, "501 events + the statement, nothing deleted");
      assertEquals((await space.verifyIntegrity({ seal: false })).ok, true);
    },
  },
  {
    name: "event GC: bounded batches resume, and every intermediate state verifies",
    run: async (adapter) => {
      const space = new Space(adapter, { eventRetentionSeconds: -1 });
      space.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }], claimable: false });
      space.sealKey = await SealKey.fromBytes(new Uint8Array(32).fill(7), "test");
      for (const tag of ["a", "b", "c", "d", "e", "f"]) await space.put({ kind: "note", body: { tag } });

      // Two pairs per call: the state after this IS the killed-mid-sweep state (each batch is one
      // transaction), and it must verify as honest GC, not tampering.
      const first = await space.gcEvents({ limit: 2 });
      assertEquals(first.attested, true);
      assertEquals(first.swept, 2);
      assertEquals(first.more, true);
      const mid = await space.verifyIntegrity();
      assertEquals(mid.ok, true);
      assert(mid.truncated?.attested, "the in-flight truncation must be attested");

      const rest = await space.gcEvents();
      assertEquals(rest.more, false);
      assertEquals((await space.verifyIntegrity()).ok, true);
    },
  },
  {
    name: "event GC never splits events that share a cursor",
    run: async (adapter) => {
      // ack-with-result appends two events in ONE transaction, so on the pg dialects they share
      // an xid (the cursor). Tampering the second event's ts to the future BEFORE sealing puts
      // the window boundary inside that group; the guard must sweep less, never split.
      const space = new Space(adapter, { eventRetentionSeconds: -1 });
      space.registerKind({ kind: "job", indexedPaths: [{ path: "tag", type: "keyword" }] });
      await space.put({ kind: "job", body: { tag: "a" } });
      const t = await space.take({ pattern: { kind: "job" } });
      assert(t);
      await space.ack(t!.lease, { kind: "result", body: { ok: true } }); // events: put, take, put(result), ack
      const evs = await space.getEvents("0");
      await rawExec(adapter, "update events set ts = ? where seq = ?", [FUTURE, evs[evs.length - 1].seq]);

      const r = await space.gcEvents();
      // sqlite cursors are per-event, so the candidate (the result put, idx 2) stands; on the pg
      // dialects it shares the ack's xid and the guard steps down to the take (idx 1).
      assertEquals(r.anchorIdx, adapter.name === "sqlite" ? 2 : 1);
      const h = await adapter.eventHorizon("0");
      assert(h.horizon, "the sweep must have truncated");
      const retained = await space.getEvents("0");
      assert(retained.every((e) => BigInt(e.cursor) > BigInt(h.horizon!.cursor)), "no retained event may sit at or below the horizon");
      assertEquals((await space.verifyIntegrity()).ok, true);
    },
  },
  {
    name: "gc compaction never compacts ops_grant: power history is audit, and a swept retirement is a restored power",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // Same shape as the agent_definition case above: declare a contentKey in-process so the
      // NEVER_COMPACT exclusion in core/gc.ts is the only thing standing.
      space.registerKind({
        kind: "ops_grant",
        indexedPaths: [{ path: "principal", type: "keyword" }],
        claimable: false,
        contentKey: ["principal"],
      });
      await space.put({ kind: "ops_grant", body: { principal: "agent:x", operations: ["observe"] } });
      await space.put({ kind: "ops_grant", body: { principal: "agent:x", operations: ["observe"], retired: true } });
      const before = (await space.query({ kind: "ops_grant" }, 50)).length;
      assertEquals(before, 2, "an assignment and its retirement are separate records");
      await space.gc();
      assertEquals((await space.query({ kind: "ops_grant" }, 50)).length, before, "ops_grant never compacts, whatever key anyone declares");
      assertEquals((await space.opsPowers("agent:x")).size, 0, "the retirement stands");
    },
  },
];
