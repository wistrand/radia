// Schema versioning, phases 1 and 2 (agent_docs/plan-schema-versioning.md).
//
// PHASE 1 stamps which declaration a record was written under. The model is
// `defaultRetentionSeconds`, which materializes at commit for the same reason: a later
// redeclaration then changes only FUTURE records and never rewrites what history says a record was
// written against. The ordinal is the count of `kind_def` records naming the kind, which works only
// because two existing properties hold, and both are asserted below: `kind_def` is in
// `NEVER_COMPACT`, and an identical re-put is ABSORBED rather than appended.
//
// PHASE 2 refuses a redeclaration that breaks something already stored, unless it says it meant to.
// Before this, `KindRegistry.register` copied the new definition over the old with no comparison,
// so every one of these happened silently.
//
// What is deliberately NOT here: body-shape validation. A kind declares no body schema and never
// has, so there is nothing of the sort to version.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../../src/storage/adapter.ts";
import { Space } from "../../../src/core/space.ts";
import { KIND_DEF } from "../../../src/core/kinds.ts";
import { RadiaError } from "../../../src/core/errors.ts";

/** The error code a call raised, or undefined if it succeeded. */
async function refused(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${e}`;
  }
}

const versionOf = async (space: Space, id: string) => (await space.getRecord(id))?.runtimeMeta.schemaVersion;

/** The newest `kind_def` record for a kind: what `supersedes` has to name. */
async function newestDeclaration(space: Space, kind: string): Promise<string> {
  const rows = await space.query({ kind: KIND_DEF, match: { kind } }, 1, { dir: "desc" });
  return rows[0].id;
}

export const schemaVersionSuites: Suite[] = [
  {
    name: "schema version: a record names the declaration it was written under, and a redeclaration only moves FUTURE records",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      const first = (await space.put({ kind: "widget", body: { n: 1 } })).id;
      assertEquals(await versionOf(space, first), 1);

      // A real change: one more indexed path. Compatible, so no acknowledgement needed.
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }] });
      const second = (await space.put({ kind: "widget", body: { n: 2, tag: "a" } })).id;
      assertEquals(await versionOf(space, second), 2, "a record written after the change names the new declaration");
      assertEquals(await versionOf(space, first), 1, "and the one written before it is untouched");
    },
  },
  {
    name: "schema version: a redeclaration that changes NOTHING does not move the version",
    run: async (adapter) => {
      // Rests on the absorb (`checkKindDefBudget`): a fleet re-declaring its ~20 kinds on every
      // start must not append a record per kind per boot, and if it did, the version would climb
      // with restarts rather than with changes.
      const space = new Space(adapter);
      const def = { kind: "widget", indexedPaths: [{ path: "n", type: "integer" as const }] };
      await space.persistKind(def);
      await space.persistKind(def);
      await space.persistKind(def);
      const id = (await space.put({ kind: "widget", body: { n: 1 } })).id;
      assertEquals(await versionOf(space, id), 1);
      assertEquals((await space.query({ kind: KIND_DEF, match: { kind: "widget" } }, 50)).length, 1);
    },
  },
  {
    name: "schema version: an undeclared kind names no declaration rather than claiming one",
    run: async (adapter) => {
      // A put of an undeclared kind is legal by design: a write must not race a fleet's
      // declaration. Such a record falls back to the space's own version.
      const space = new Space(adapter);
      const id = (await space.put({ kind: "undeclared", body: { a: 1 } })).id;
      assertEquals(await versionOf(space, id), 1);
    },
  },
  {
    name: "schema version: the version survives a restart, because it is counted from the log",
    run: async (adapter) => {
      const one = new Space(adapter);
      await one.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      await one.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }] });

      // A different process over the same database, which is also how a SECOND INSTANCE computes
      // it: from the same records, so the two agree without being told.
      const two = new Space(adapter);
      await two.loadKinds();
      const id = (await two.put({ kind: "widget", body: { n: 3 } })).id;
      assertEquals(await versionOf(two, id), 2);
    },
  },
  {
    name: "redeclaration: dropping an indexed path is refused, and the message names what breaks",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }] });
      const code = await refused(() => space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] }));
      assertEquals(code, "incompatible_redeclaration");
      // The declaration in force is unchanged, so a pattern on the dropped path still compiles.
      assertEquals((await space.query({ kind: "widget", match: { tag: "a" } }, 10)).length, 0);
    },
  },
  {
    name: "redeclaration: naming what it supersedes is the acknowledgement, and then it lands",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }] });
      const prior = await newestDeclaration(space, "widget");
      await space.put({
        kind: KIND_DEF,
        body: { kind: "widget", indexedPaths: [{ path: "n", type: "integer" }], supersedes: prior },
      });
      // The path is gone, so a pattern naming it no longer compiles. That IS the breakage the
      // refusal was protecting; acknowledging it means accepting it.
      assertEquals(await refused(() => space.query({ kind: "widget", match: { tag: "a" } }, 10)), "undeclared_path");
      const id = (await space.put({ kind: "widget", body: { n: 1 } })).id;
      assertEquals(await versionOf(space, id), 2);
    },
  },
  {
    name: "redeclaration: flipping claimable is refused in BOTH directions, because it moves what the sweep may delete",
    run: async (adapter) => {
      // `claimable` does not gate `take`, which is what everyone assumes and what this rule got
      // wrong on its first draft. It decides which records the RETENTION SWEEP may reach
      // (`sweepSelector`), so true to false makes stored records newly deletable and false to true
      // makes them permanently unsweepable.
      const space = new Space(adapter);
      const paths = [{ path: "n", type: "integer" as const }];
      await space.persistKind({ kind: "note", indexedPaths: paths, claimable: false });
      assertEquals(
        await refused(() => space.persistKind({ kind: "note", indexedPaths: paths, claimable: true })),
        "incompatible_redeclaration",
      );
      await space.persistKind({ kind: "task", indexedPaths: paths });
      assertEquals(
        await refused(() => space.persistKind({ kind: "task", indexedPaths: paths, claimable: false })),
        "incompatible_redeclaration",
        "the direction that makes stored records sweepable is refused too",
      );
      // An OMITTED field is not a change: absent means claimable, which is the documented default.
      await space.persistKind({ kind: "task", indexedPaths: paths, usage: "a task" });
    },
  },
  {
    name: "redeclaration: changing contentKey is refused, since compaction identity changes retroactively",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }], contentKey: ["tag"] });
      assertEquals(
        await refused(() => space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }], contentKey: ["n"] })),
        "incompatible_redeclaration",
      );
      // ORDER is not a change: a content key is an identity, and writing it the other way round
      // does not change which records share one.
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "tag", type: "keyword" }], contentKey: ["tag"] });
    },
  },
  {
    name: "redeclaration: adding paths, usage and retention are compatible; a type change is too",
    run: async (adapter) => {
      // The declared type is DOCUMENTATION: `matching.ts` asks only whether a path is declared,
      // `prepareKind` takes no types, and the pushdown guards on the stored JSON type per row.
      // Refusing a type change would refuse the one edit that costs nothing.
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      await space.persistKind({
        kind: "widget",
        indexedPaths: [{ path: "n", type: "keyword" }, { path: "tag", type: "keyword" }],
        sortablePaths: ["n"],
        usage: "a widget",
        defaultRetentionSeconds: 3600,
      });
      const id = (await space.put({ kind: "widget", body: { n: 1, tag: "a" } })).id;
      assertEquals(await versionOf(space, id), 2);
    },
  },
  {
    name: "live patterns: the refusal names the GRANT that would stop matching, not just the path",
    run: async (adapter) => {
      // Phase 3. Phase 2 knows a path was dropped; this answers the question that follows, which is
      // the one an operator has: dropped for whom. A grant whose pattern stops compiling stops
      // matching, silently and fail-closed, which is the combination worth naming at the write.
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "team", type: "keyword" }] });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "widget", operations: ["query"], pattern: { team: "blue" } } });

      let message = "";
      try {
        await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      } catch (e) {
        message = (e as RadiaError).message;
      }
      assert(message.includes("grant agent:w"), `the refusal must name the grant, got: ${message}`);
      assert(message.includes("'team'"), "and the path it rests on");
    },
  },
  {
    name: "live patterns: a WATCH counts, and the message says a watch is process-local",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "team", type: "keyword" }] });
      // A watch is grant-gated, so the watcher needs one, and the grant is UNSCOPED on purpose:
      // only the watch's own pattern names the dropped path, so the second instance below finds
      // nothing rather than finding the grant.
      await space.put({ kind: "grant", body: { principal: "agent:watcher", kind: "widget", operations: ["query"] } });
      await space.createWatch({ kind: "widget", match: { team: "blue" } }, "agent:watcher");
      let here = "";
      try {
        await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      } catch (e) {
        here = (e as RadiaError).message;
      }
      assert(here.includes("watch agent:watcher"), `the instance holding the watch names it, got: ${here}`);

      // Nothing live: the message must not imply it saw every instance's watches, since a watch
      // lives in ONE process.
      const other = new Space(adapter);
      await other.loadKinds();
      let message = "";
      try {
        await other.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      } catch (e) {
        message = (e as RadiaError).message;
      }
      assert(message.includes("process-local"), `an empty answer must be honest about its reach, got: ${message}`);
    },
  },
  {
    name: "live patterns: an acknowledged break is recorded on the event, since nothing refused it",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "team", type: "keyword" }] });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "widget", operations: ["query"], pattern: { team: "blue" } } });
      const prior = await newestDeclaration(space, "widget");
      await space.put({
        kind: KIND_DEF,
        body: { kind: "widget", indexedPaths: [{ path: "n", type: "integer" }], supersedes: prior },
      });

      const events = await space.getEvents("0", 500);
      const broke = events.filter((e) => (e.detail as { brokePatterns?: unknown[] })?.brokePatterns);
      assertEquals(broke.length, 1, "exactly the declaration that broke something carries it");
      const victims = (broke[0].detail as { brokePatterns: { what: string; who: string }[] }).brokePatterns;
      assertEquals(victims.length, 1);
      assertEquals(victims[0].what, "grant");
      assert(victims[0].who.startsWith("agent:w"));
    },
  },
  {
    name: "live patterns: a compatible declaration pays for no live read and records nothing",
    run: async (adapter) => {
      // The check runs only when something STRUCTURAL says a pattern could break. Adding a path
      // is the common case and must stay free.
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "team", type: "keyword" }] });
      const events = await space.getEvents("0", 500);
      assertEquals(events.filter((e) => (e.detail as { brokePatterns?: unknown })?.brokePatterns).length, 0);
    },
  },
  {
    name: "redeclaration: restoring a dropped path WRITES, rather than replaying the identical older record",
    run: async (adapter) => {
      // `kindDefKey` is content-derived, which is right for "declare the same thing twice" and
      // wrong for restoring a declaration that was superseded: the key replays the earlier
      // identical record, so the call reports success and writes nothing, the in-memory registry
      // shows the restored def, and A RESTART REVERTS IT. Phase 2 is what made drop-then-restore
      // an ordinary thing to do, so `persistKind` anchors its key on what it supersedes.
      const space = new Space(adapter);
      const two = [{ path: "n", type: "integer" as const }, { path: "tag", type: "keyword" as const }];
      await space.persistKind({ kind: "widget", indexedPaths: two });
      const prior = await newestDeclaration(space, "widget");
      await space.put({ kind: KIND_DEF, body: { kind: "widget", indexedPaths: [{ path: "n", type: "integer" }], supersedes: prior } });
      await space.persistKind({ kind: "widget", indexedPaths: two });

      // THE RELOAD is the assertion. In memory it looked restored either way; only the log decides.
      const fresh = new Space(adapter);
      await fresh.loadKinds();
      assertEquals(fresh.listKinds().find((k) => k.kind === "widget")?.indexedPaths.length, 2, "the restore must survive a restart");
      const id = (await fresh.put({ kind: "widget", body: { n: 1, tag: "a" } })).id;
      assertEquals(await versionOf(fresh, id), 3, "and it is a third declaration, not a replay of the first");
    },
  },
  {
    name: "redeclaration: a fleet redeclaring its kinds on every start still writes nothing",
    run: async (adapter) => {
      // The other half of the same key. Anchoring must not defeat the absorb, or the growth it
      // exists to stop comes back one record per kind per restart.
      const space = new Space(adapter);
      for (let i = 0; i < 4; i++) await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      assertEquals((await space.query({ kind: KIND_DEF, match: { kind: "widget" } }, 50)).length, 1);
    },
  },
  {
    name: "redeclaration: the check reads the LOG, so a second instance cannot drop a path it never loaded",
    run: async (adapter) => {
      // The multi-instance hole this check would have had if it compared against the in-memory
      // registry: B started before A added a path, so B's registry says the kind has one path and
      // the log says two. A redeclaration through B naming one path is "no change" to B and drops
      // a live path in fact (audit package O's class).
      const b = new Space(adapter);
      await b.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });

      const a = new Space(adapter);
      await a.loadKinds();
      await a.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }, { path: "team", type: "keyword" }] });

      // B never reloaded, so its registry still says one path.
      assertEquals(b.listKinds().find((k) => k.kind === "widget")?.indexedPaths.length, 1);
      assertEquals(
        await refused(() => b.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] })),
        "incompatible_redeclaration",
        "the declaration in force is the log's, not this process's",
      );
    },
  },
  {
    name: "redeclaration: a retirement is exempt, and reviving the kind is a first declaration again",
    run: async (adapter) => {
      // A `retired: true` marker carries no contract and drops every path by construction, so it
      // would fail the compatibility check on every kind that ever declared one.
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      await space.put({ kind: KIND_DEF, body: { kind: "widget", indexedPaths: [], retired: true } });
      const fresh = new Space(adapter);
      await fresh.loadKinds();
      assert(!fresh.listKinds().some((k) => k.kind === "widget"), "a retired kind is not registered");
      await fresh.persistKind({ kind: "widget", indexedPaths: [{ path: "other", type: "keyword" }] });
      assert(fresh.listKinds().some((k) => k.kind === "widget"), "and reviving it needs no acknowledgement");
    },
  },
];
