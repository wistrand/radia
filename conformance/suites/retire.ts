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
      assertEquals((await space.authorizeWatch("agent:w", "task")).constraint, null);

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
  {
    name: "swapping one grant template for another supersedes the old one",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "message",
        indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
      });

      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["query"], template: { owner: "agent:w" } },
      ]);
      assertEquals(await space.authorize("agent:w", "query", "message"), [{ owner: "agent:w" }]);

      // Switching what a grant binds to is not adding a grant. Templates union, so without
      // superseding the principal would hold BOTH bindings and see the union of them — a change of
      // scope that widens instead of changing. Found by testing the untemplated case's fix.
      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["query"], template: { conversationId: "c1" } },
      ]);
      assertEquals(
        await space.authorize("agent:w", "query", "message"),
        [{ conversationId: "c1" }],
        "the new binding replaces the old rather than joining it",
      );
    },
  },
  {
    name: "tightening an agent definition supersedes its own unrestricted grant",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "conversationId", type: "keyword" }] });

      // An existing space: the loose grant a previous build declared.
      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["put", "query"] },
      ]);
      assertEquals(await space.authorize("agent:w", "query", "message"), null, "unrestricted to begin with");

      // The new build declares the SAME grant with a template. Scope and template are part of a
      // grant's identity, so without superseding this is a second grant beside the first — and
      // grants union, so the tightening would change nothing at all. That is not hypothetical: it
      // is how a session on a pre-existing space kept reading every conversation after its grants
      // were scoped to one.
      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["put", "query"], template: { conversationId: "mine" } },
      ]);
      assertEquals(
        await space.authorize("agent:w", "query", "message"),
        [{ conversationId: "mine" }],
        "the tightening actually takes effect",
      );
    },
  },
  {
    name: "…but it does not touch grants a human assigned separately",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "conversationId", type: "keyword" }] });
      space.registerKind({ kind: "note", indexedPaths: [] });

      // A human approved this one out of band. An agent definition speaks for the grants IT
      // declares; treating it as authority over everything the principal holds would mean every
      // restart silently revoked what a person approved.
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "note", operations: ["query"] } });
      await space.put({ kind: "grant", body: { principal: "agent:w", kind: "message", operations: ["read_one"] } });

      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["put", "query"], template: { conversationId: "mine" } },
      ]);

      assertEquals(await space.authorize("agent:w", "query", "note"), null, "another kind is untouched");
      assertEquals(
        await space.authorize("agent:w", "read_one", "message"),
        null,
        "and so are different operations on the same kind",
      );
    },
  },
  {
    name: "a scope switched away and BACK is live again, not a permanent lockout",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({
        kind: "message",
        indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
      });
      const identity: GrantDef = {
        principal: "agent:w",
        kind: "message",
        operations: ["query"],
        template: { owner: "agent:w" },
      };
      const conversation: GrantDef = {
        principal: "agent:w",
        kind: "message",
        operations: ["query"],
        template: { conversationId: "c1" },
      };

      // The grant write is content-keyed, and the supersede retires whatever is live. Together
      // those turn a swap BACK into a lockout unless the revival carries a distinct idempotency
      // key: the re-declaration replays the retired record and writes nothing, while the supersede
      // still retires the live one — leaving the principal with no grant at all.
      await space.createAgentDefinition("agent:w", [identity]);
      assertEquals(await space.authorize("agent:w", "query", "message"), [{ owner: "agent:w" }]);
      await space.createAgentDefinition("agent:w", [conversation]);
      assertEquals(await space.authorize("agent:w", "query", "message"), [{ conversationId: "c1" }]);
      await space.createAgentDefinition("agent:w", [identity]);
      assertEquals(
        await space.authorize("agent:w", "query", "message"),
        [{ owner: "agent:w" }],
        "switching back to a scope used before must revive it",
      );
    },
  },
  {
    name: "a definition may declare two templates on one triple, and they union",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "conversationId", type: "keyword" }] });

      // Superseding per grant as each one lands makes the second retire the first. `authorize`
      // unions templates on purpose, so a definition has to be able to declare more than one.
      await space.createAgentDefinition("agent:w", [
        { principal: "agent:w", kind: "message", operations: ["query"], template: { conversationId: "a" } },
        { principal: "agent:w", kind: "message", operations: ["query"], template: { conversationId: "b" } },
      ]);
      const templates = await space.authorize("agent:w", "query", "message");
      assertEquals(templates?.length, 2, "both declared scopes survive");
      assert(
        templates?.some((t) => t.conversationId === "a") && templates?.some((t) => t.conversationId === "b"),
        `expected both scopes, got ${JSON.stringify(templates)}`,
      );
    },
  },
  {
    name: "a grant re-granted after a retirement can be retired again",
    run: async (adapter) => {
      const space = new Space(adapter);
      space.registerKind({ kind: "message", indexedPaths: [{ path: "owner", type: "keyword" }] });
      const wide: GrantDef = { principal: "agent:w", kind: "message", operations: ["query"] };
      const narrow: GrantDef = {
        principal: "agent:w",
        kind: "message",
        operations: ["query"],
        template: { owner: "agent:w" },
      };

      // Keying a retirement on the grant identity alone lets an identity be retired only ONCE.
      // A wide grant that was retired, re-granted, and then narrowed again would survive the
      // second supersede and stay live — widening, silently.
      await space.createAgentDefinition("agent:w", [wide]);
      await space.createAgentDefinition("agent:w", [narrow]);
      await space.createAgentDefinition("agent:w", [wide]);
      await space.createAgentDefinition("agent:w", [narrow]);
      assertEquals(
        await space.authorize("agent:w", "query", "message"),
        [{ owner: "agent:w" }],
        "the re-granted wide grant must not outlive the second narrowing",
      );
    },
  },
];
