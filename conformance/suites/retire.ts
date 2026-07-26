// Retirement: withdrawing a registry entry without deleting anything.
//
// Radia's registries (declared kinds, assigned grants, and in applications capabilities/models/
// procedures) are projections over immutable records, so "remove" cannot be a delete. It is a
// successor carrying `retired: true`, honoured by the projection in `core/registry.ts`.
//
// The two shapes are tested separately because using the wrong one is a correctness bug:
// kind_def is LATEST-WINS (one entry per kind name), grants are ADDITIVE (a principal may hold
// several on one kind, and revoking one must leave the others standing).

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import { type GrantDef, KIND_DEF } from "../../src/core/kinds.ts";
import type { RadiaError } from "../../src/core/errors.ts";

/** A fresh Space that reloads its registry from the records already on the adapter. */
async function reloaded(adapter: Parameters<Suite["run"]>[0]): Promise<Space> {
  const space = new Space(adapter);
  await space.loadKinds();
  return space;
}

async function forbidden(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as RadiaError).code === "forbidden";
  }
}

export const retireSuites: Suite[] = [
  {
    name: "a retired kind_def stops being registered, and re-declaring it revives the kind",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] });
      assert((await reloaded(adapter)).listKinds().some((k) => k.kind === "widget"));

      // Retirement is an ordinary successor record — no delete, no endpoint.
      await space.put({ kind: KIND_DEF, body: { kind: "widget", indexedPaths: [], retired: true } });
      assert(
        !(await reloaded(adapter)).listKinds().some((k) => k.kind === "widget"),
        "the newest declaration says retired, so the kind is not registered",
      );

      await space.put({ kind: KIND_DEF, body: { kind: "widget", indexedPaths: [{ path: "n", type: "integer" }] } });
      assert(
        (await reloaded(adapter)).listKinds().some((k) => k.kind === "widget"),
        "a newer non-retired declaration revives it — there is no un-retire path to call",
      );
    },
  },
  {
    name: "retirement is decided by the NEWEST record, not by any record",
    run: async (adapter) => {
      const space = new Space(adapter);
      await space.persistKind({ kind: "gadget", indexedPaths: [] });
      await space.put({ kind: KIND_DEF, body: { kind: "gadget", indexedPaths: [], retired: true } });
      // A projection that filtered retired records out FIRST would now see only the original
      // declaration, call it newest, and resurrect the kind. Order of arrival must not matter.
      assert(!(await reloaded(adapter)).listKinds().some((k) => k.kind === "gadget"));
    },
  },
  {
    name: "revoking a grant denies the operation it granted",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const grant = { principal: "agent:w", kind: "task", operations: ["query"] };
      await space.put({ kind: "grant", body: grant });
      assertEquals(await space.authorize("agent:w", "query", "task"), null, "granted: unrestricted");

      // Revocation is retirement of that grant record's content, written by the same privileged
      // path that assigned it.
      await space.put({ kind: "grant", body: { ...grant, retired: true } });
      assert(await forbidden(() => space.authorize("agent:w", "query", "task")), "revoked: forbidden");

      // …and re-granting works, for the same latest-wins reason.
      await space.put({ kind: "grant", body: grant });
      assertEquals(await space.authorize("agent:w", "query", "task"), null);
    },
  },
  {
    name: "revoking ONE grant leaves the principal's other grants standing",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      // Two grants on the SAME kind — the case that makes grants additive rather than latest-wins.
      const readGrant = { principal: "agent:w", kind: "task", operations: ["query"] };
      const takeGrant = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: readGrant });
      await space.put({ kind: "grant", body: takeGrant });

      await space.put({ kind: "grant", body: { ...readGrant, retired: true } });

      assert(await forbidden(() => space.authorize("agent:w", "query", "task")), "the revoked one is gone");
      assertEquals(
        await space.authorize("agent:w", "take", "task"),
        null,
        "the other one survives — a projection keyed on (principal, kind) would have taken it too",
      );
    },
  },
  {
    name: "revoking a scoped grant leaves a differently-scoped one in force",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const a = { principal: "agent:w", kind: "task", operations: ["query"], template: { tag: "a" } };
      const b = { principal: "agent:w", kind: "task", operations: ["query"], template: { tag: "b" } };
      await space.put({ kind: "grant", body: a });
      await space.put({ kind: "grant", body: b });
      assertEquals((await space.authorize("agent:w", "query", "task"))?.length, 2, "both scopes apply");

      await space.put({ kind: "grant", body: { ...a, retired: true } });
      const left = await space.authorize("agent:w", "query", "task");
      assertEquals(left, [{ tag: "b" }], "only the surviving scope — template is part of a grant's identity");
    },
  },
  {
    name: "a revoked grant stops authorizing WATCHES too",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const grant = { principal: "agent:w", kind: "task", operations: ["take"] };
      await space.put({ kind: "grant", body: grant });
      assertEquals(await space.authorizeWatch("agent:w", "task"), null);

      // A revocation that stopped query but left watch standing would revoke nothing that matters:
      // a watch observes the records it was meant to lose sight of.
      await space.put({ kind: "grant", body: { ...grant, retired: true } });
      assert(await forbidden(() => space.authorizeWatch("agent:w", "task")));
    },
  },
  {
    name: "re-defining an agent does not accumulate grant records",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [] });
      const grants: GrantDef[] = [
        { principal: "agent:w", kind: "task", operations: ["query"] },
        { principal: "agent:w", kind: "task", operations: ["put"] },
      ];
      // Every restart re-defines its agents. Unchecked, that appended a fresh record per grant per
      // boot, and a long-lived principal outran the bounded page each authorization read takes —
      // which fails SILENTLY, in both directions: a live grant denied, or worse, a revocation
      // invisible so the revoked grant kept working.
      for (let boot = 0; boot < 10; boot++) await space.createAgentDefinition("agent:w", grants);

      const records = await space.query({ kind: "grant", match: { principal: "agent:w" } }, 500);
      assertEquals(records.length, 2, "one record per distinct grant, however many boots");
      assertEquals(await space.authorize("agent:w", "query", "task"), null);
    },
  },
  {
    name: "a revocation applies even with a long history of grant records",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [] });
      const query = { principal: "agent:w", kind: "task", operations: ["query"] };
      const put = { principal: "agent:w", kind: "task", operations: ["put"] };
      // History written before grant writes were content-keyed: the same two grants, over and over,
      // interleaved as a boot loop produces them.
      for (let i = 0; i < 60; i++) {
        await space.put({ kind: "grant", body: query });
        await space.put({ kind: "grant", body: put });
      }
      assertEquals(await space.authorize("agent:w", "query", "task"), null, "granted");

      await space.put({ kind: "grant", body: { ...query, retired: true } });
      assert(await forbidden(() => space.authorize("agent:w", "query", "task")), "the revocation is seen");
      assertEquals(await space.authorize("agent:w", "put", "task"), null, "the other grant survives");
    },
  },
  {
    name: "retirement withdraws, it does not erase",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
      const grant = { principal: "agent:w", kind: "task", operations: ["query"] };
      await space.put({ kind: "grant", body: grant });
      await space.put({ kind: "grant", body: { ...grant, retired: true } });

      // Both records are still there and still queryable. That is the point: an audit of who
      // could do what, and when it changed, survives the revocation.
      const all = await space.query({ kind: "grant", match: { principal: "agent:w" } }, 50);
      assertEquals(all.length, 2, "the grant and its revocation both remain on the space");
    },
  },
];
