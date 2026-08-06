// The COMPARTMENT contract (agent_docs/architecture-workspace-agents.md phase 1).
//
// A compartment is how a class of data is contained without adding anything to the runtime: a
// DEDICATED KIND, which no pre-existing grant can name, plus pattern-scoped grants inside it. The
// plan reaches for this instead of a taint label because containment has to bind the WRITE side,
// and `bodyMatchesGrant` does that on every path a record can enter by while a label binds only
// what the writer chose to declare as a parent.
//
// Every case here asserts one of the four properties phase 1 exists to prove, and each is written
// as the thing that would actually leak:
//
//   1. a kind nobody was granted is closed, for every verb
//   2. a member reads, claims and chains inside the compartment
//   3. a producer CANNOT write outside its pattern, on the put path, the ack-emitted result and
//      the artifact path
//   4. a read narrows, and a client's own pattern can only narrow further, never widen
//   5. crossing out takes a principal deliberately granted both sides
//
// Adapter-parameterized because grants ARE records: the two adapters must agree about what a
// grant permits, or the compartment means something different depending on where it is deployed.
// Enforcement lives at the HTTP boundary and only there (design-auth.md), so these drive the
// HANDLERS rather than `Space` directly: a test that called `space.put` would pass while the
// boundary leaked.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { Space } from "../../src/core/space.ts";
import { handlePut, handleQuery } from "../../src/server/handlers/records.ts";
import { handleAck, handleTake } from "../../src/server/handlers/leases.ts";
import { handlePutArtifact } from "../../src/server/handlers/artifacts.ts";

/** The compartment's kind is `finding`; `public_summary` is the world outside it. */
function newSpace(adapter: StorageAdapter): Space {
  const space = new Space(adapter);
  space.registerKind({ kind: "finding", indexedPaths: [{ path: "compartment", type: "keyword" }, { path: "tag", type: "keyword" }] });
  space.registerKind({ kind: "public_summary", indexedPaths: [{ path: "tag", type: "keyword" }] });
  // `artifact` is RESERVED, so a compartment cannot get its own artifact kind. What it can do is
  // add an indexed path, which is what makes an artifact grant scopable to a compartment: the
  // redeclaration keeps the kind's own paths and its fixed `claimable: false`.
  space.registerKind({
    kind: "artifact",
    indexedPaths: [{ path: "compartment", type: "keyword" }, { path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }],
    claimable: false,
  });
  return space;
}

/** Grants are records, and an in-process caller is privileged, so this is the operator writing
 *  them. `pattern` is what scopes a principal INTO a compartment. */
function grant(
  space: Space,
  principal: string,
  kind: string,
  operations: string[],
  pattern?: Record<string, unknown>,
): Promise<{ id: string }> {
  return space.put({ kind: "grant", body: { principal, kind, operations, ...(pattern ? { pattern } : {}) } });
}

const post = (path: string, body: unknown) =>
  new Request(`http://t${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The status a handler answered with, so a refusal is asserted as a REFUSAL and not as an
 *  exception that happened to be thrown somewhere. */
async function status(r: Promise<Response>): Promise<number> {
  const res = await r;
  await res.body?.cancel();
  return res.status;
}

export const compartmentSuites: Suite[] = [
  {
    name: "compartment: a dedicated kind is closed to everyone who was not granted it",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // The outsider is a fully working principal in the space: it holds grants, it writes, it
      // reads. It simply was never granted the compartment's kind, which is the whole mechanism.
      await grant(space, "agent:outsider", "public_summary", ["put", "query"]);
      await space.put({ kind: "finding", body: { compartment: "alpha", tag: "secret" } });

      assertEquals(await status(handleQuery(space, post("/v0/records/query", { kind: "finding" }), "agent:outsider")), 403);
      assertEquals(await status(handleTake(space, post("/v0/takes", { pattern: { kind: "finding" } }), "agent:outsider")), 403);
      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "finding", body: { compartment: "alpha" } }), "agent:outsider")),
        403,
      );
      // …while the grant it DOES hold keeps working, so this is containment and not a broken space.
      assertEquals(await status(handlePut(space, post("/v0/records", { kind: "public_summary", body: { tag: "ok" } }), "agent:outsider")), 201);

      // The property stated as the plan states it: adding the compartment later cannot widen a
      // grant written before it existed, because that grant names another kind.
      space.registerKind({ kind: "finding_v2", indexedPaths: [{ path: "compartment", type: "keyword" }] });
      assertEquals(await status(handleQuery(space, post("/v0/records/query", { kind: "finding_v2" }), "agent:outsider")), 403);
    },
  },
  {
    name: "compartment: a member reads, claims and chains inside it",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // An ordinary member: it may read and claim the compartment's kind, and write back into the
      // compartment it belongs to. Nothing here is special-cased for people.
      await grant(space, "agent:analyst", "finding", ["query", "take"], { compartment: "alpha" });
      await grant(space, "agent:analyst", "finding", ["put"], { compartment: "alpha" });
      await space.put({ kind: "finding", body: { compartment: "alpha", tag: "raw" } });

      const read = await (await handleQuery(space, post("/v0/records/query", { kind: "finding" }), "agent:analyst")).json();
      assertEquals(read.records.length, 1);

      const claimed = await (await handleTake(space, post("/v0/takes", { pattern: { kind: "finding" } }), "agent:analyst")).json();
      assert(claimed.lease, "a member must be able to claim its own compartment's work");

      // The chain: acking emits a new record INSIDE the compartment, which is how an evaluator
      // hands work to an aggregator without anything leaving.
      const acked = await handleAck(
        space,
        post("/v0/leases/ack", { lease: claimed.lease, result: { kind: "finding", body: { compartment: "alpha", tag: "derived" } } }),
        "agent:analyst",
      );
      assertEquals(acked.status, 200);
      assertEquals((await acked.json()).status, "ok");
    },
  },
  {
    name: "compartment: a producer cannot write outside its pattern, on ANY write path",
    run: async (adapter) => {
      // The property the plan rests on. `bodyMatchesGrant` runs in three places and a compartment
      // is only as good as the weakest of them, so all three are asserted here rather than the
      // one that is easiest to reach.
      const space = newSpace(adapter);
      await grant(space, "agent:analyst", "finding", ["query", "take", "put"], { compartment: "alpha" });
      await grant(space, "agent:analyst", "artifact", ["put"], { compartment: "alpha" });

      // 1. the put path
      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "finding", body: { compartment: "beta", tag: "x" } }), "agent:analyst")),
        403,
        "a put into another compartment must be refused",
      );
      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "finding", body: { tag: "x" } }), "agent:analyst")),
        403,
        "OMITTING the field is not a way out: the body must satisfy the pattern",
      );
      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "finding", body: { compartment: "alpha", tag: "x" } }), "agent:analyst")),
        201,
      );

      // 2. the ack-emitted result, which is the path a worker actually produces through
      await space.put({ kind: "finding", body: { compartment: "alpha", tag: "work" } });
      const claimed = await (await handleTake(space, post("/v0/takes", { pattern: { kind: "finding" } }), "agent:analyst")).json();
      assertEquals(
        await status(handleAck(
          space,
          post("/v0/leases/ack", { lease: claimed.lease, result: { kind: "finding", body: { compartment: "beta", tag: "leak" } } }),
          "agent:analyst",
        )),
        403,
        "an ack result outside the pattern must be refused before anything is consumed",
      );

      // 3. the artifact path, which matters because protected BYTES are artifacts and `artifact`
      // is reserved, so a compartment cannot get its own artifact kind.
      const artifact = (compartment: string) =>
        new Request("http://t/v0/artifacts", {
          method: "POST",
          headers: { "content-type": "text/plain", "x-radia-meta": JSON.stringify({ compartment }) },
          body: "payload",
        });
      assertEquals(await status(handlePutArtifact(space, artifact("beta"), "agent:analyst")), 403);
      assertEquals(await status(handlePutArtifact(space, artifact("alpha"), "agent:analyst")), 201);
    },
  },
  {
    name: "compartment: a read narrows, and a client pattern can only narrow further",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await grant(space, "agent:analyst", "finding", ["query"], { compartment: "alpha" });
      await space.put({ kind: "finding", body: { compartment: "alpha", tag: "mine" } });
      await space.put({ kind: "finding", body: { compartment: "beta", tag: "theirs" } });

      const asAnalyst = (match?: Record<string, unknown>) =>
        handleQuery(space, post("/v0/records/query", { kind: "finding", ...(match ? { match } : {}) }), "agent:analyst")
          .then((r) => r.json());

      const mine = await asAnalyst();
      assertEquals(mine.records.map((r: { body: { tag: string } }) => r.body.tag), ["mine"]);
      // The narrowing is REPORTED, so a member cannot mistake its slice for the whole kind.
      assert(mine.scope?.narrowedBy, "a narrowed read must say so");

      // Asking for the other compartment returns nothing: the grant is ANDed server-side, so a
      // client pattern narrows and never widens.
      const widen = await asAnalyst({ compartment: "beta" });
      assertEquals(widen.records.length, 0);

      // And the operator, who bypasses grants, sees both. Stated so the test cannot pass because
      // the records were never written.
      const all = await (await handleQuery(space, post("/v0/records/query", { kind: "finding" }), "human:local")).json();
      assertEquals(all.records.length, 2);
    },
  },
  {
    name: "compartment: crossing out takes a principal granted BOTH sides",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await grant(space, "agent:analyst", "finding", ["query", "put"], { compartment: "alpha" });
      // The exporter is the whole exit gate: it reads inside and writes outside. Nothing else in
      // the space can move work across, and there is no second mechanism behind that.
      await grant(space, "agent:exporter", "finding", ["query"], { compartment: "alpha" });
      await grant(space, "agent:exporter", "public_summary", ["put"]);
      await space.put({ kind: "finding", body: { compartment: "alpha", tag: "raw" } });

      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "public_summary", body: { tag: "leaked" } }), "agent:analyst")),
        403,
        "a member holding only inside grants cannot write outside",
      );
      const read = await (await handleQuery(space, post("/v0/records/query", { kind: "finding" }), "agent:exporter")).json();
      assertEquals(read.records.length, 1);
      assertEquals(
        await status(handlePut(space, post("/v0/records", { kind: "public_summary", body: { tag: "approved" } }), "agent:exporter")),
        201,
      );

      // The audit an operator runs at promotion: the exporter is the principal holding both
      // sides, and `effectivePermissions` names it without anyone reading grant records by hand.
      const perms = await space.effectivePermissions("agent:exporter");
      assertEquals(perms.kinds.map((k) => k.kind).sort(), ["finding", "public_summary"]);
      const member = await space.effectivePermissions("agent:analyst");
      assertEquals(member.kinds.map((k) => k.kind), ["finding"]);
    },
  },
];
