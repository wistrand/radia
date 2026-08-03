// Phase 1 conformance: put + read_one, record immutability, body_sha256 integrity, the
// client-vs-runtime metadata split, and parent-must-exist. Each suite runs on every
// adapter (see harness.ts), so a behavior is only done when green on both.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import { sha256Hex } from "../../src/core/ids.ts";
import { handlePut } from "../../src/server/handlers/records.ts";
import { RadiaError } from "../../src/core/errors.ts";

/** The error CODE a call raised, or undefined if it succeeded. Codes are the stable contract; the
 *  message is prose and changes. */
async function denied(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${e}`;
  }
}

/** Register the kinds these suites match on (predicates require declared indexed paths). */
function newSpace(adapter: Parameters<Suite["run"]>[0], operators?: string[]): Space {
  const space = new Space(adapter, operators ? { operators } : {});
  space.registerKind({
    kind: "task",
    indexedPaths: [
      { path: "tag", type: "keyword" },
      { path: "seq", type: "integer" },
      { path: "n", type: "integer" },
    ],
    sortablePaths: ["seq"],
  });
  space.registerKind({ kind: "fact", indexedPaths: [{ path: "v", type: "integer" }] });
  return space;
}

export const recordSuites: Suite[] = [
  {
    name: "put returns an id; read_one returns the committed record",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const { id } = await space.put({ kind: "task", body: { n: 1, tag: "alpha" } });
      assert(id.length > 0, "put returned empty id");

      const rec = await space.readOne({ kind: "task", match: { tag: "alpha" } });
      assert(rec, "read_one returned null");
      assertEquals(rec!.id, id);
      assertEquals(rec!.body, { n: 1, tag: "alpha" });
    },
  },
  {
    name: "read_one returns null when nothing matches",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({ kind: "task", body: { tag: "alpha" } });
      const miss = await space.readOne({ kind: "task", match: { tag: "nope" } });
      assertEquals(miss, null);
      const wrongKind = await space.readOne({ kind: "fact", match: {} });
      assertEquals(wrongKind, null);
    },
  },
  {
    name: "body_sha256 is present and correct over the stored body",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const body = { a: 1, b: ["x", "y"], c: { d: true } };
      await space.put({ kind: "task", body });
      const rec = await space.readOne({ kind: "task", match: {} });
      assert(rec);
      const expected = await sha256Hex(JSON.stringify(rec!.body));
      assertEquals(rec!.bodySha256, expected);
    },
  },
  {
    name: "server assigns authoritative metadata; client claims are preserved but not promoted",
    run: async (adapter) => {
      const space = newSpace(adapter);
      await space.put({
        kind: "task",
        body: { tag: "meta" },
        clientMeta: { requested_priority: 99, confidence: 0.5 },
      });
      const rec = await space.readOne({ kind: "task", match: { tag: "meta" } });
      assert(rec);
      // authoritative, server-assigned
      assertEquals(rec!.runtimeMeta.createdBy, "local:dev");
      assertEquals(rec!.runtimeMeta.schemaVersion, 1);
      assertEquals(rec!.runtimeMeta.taint, []);
      assert(rec!.runtimeMeta.createdAt.length > 0, "createdAt not assigned");
      // client claims preserved as-is, not turned into authority
      assertEquals(rec!.clientMeta?.requested_priority, 99);
    },
  },
  {
    name: "client-supplied authoritative fields are ignored at the API boundary",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const req = new Request("http://x/v0/records", {
        method: "POST",
        body: JSON.stringify({
          kind: "task",
          body: { tag: "boundary" },
          createdBy: "attacker",
          schemaVersion: 999,
          runtimeMeta: { createdBy: "attacker" },
        }),
      });
      const res = await handlePut(space, req, "human:local");
      assertEquals(res.status, 201);

      const rec = await space.readOne({ kind: "task", match: { tag: "boundary" } });
      assert(rec);
      // created_by is the server-RESOLVED caller (the handler's principal), never the client's
      // claim, and never the space's default when a caller is known.
      assertEquals(rec!.runtimeMeta.createdBy, "human:local"); // not "attacker", not "local:dev"
      assertEquals(rec!.runtimeMeta.schemaVersion, 1); // not 999

      // Taint is authoritative in the direction that matters: a client may RAISE a label and can
      // never lower one, so an empty raise does not clear what a data parent contributed. (A
      // wrong-TYPED taint is a 4xx, covered in http.test.ts; here the point is that even a
      // well-formed one cannot subtract.)
      // Same author on both, so this isolates the washing property: a different author would
      // legitimately add `foreign` and the assertion would be testing two things at once.
      const dirty = await space.put({ kind: "task", body: { tag: "src" }, taint: ["file"] }, undefined, "human:local");
      const clearAttempt = new Request("http://x/v0/records", {
        method: "POST",
        body: JSON.stringify({ kind: "task", body: { tag: "washed" }, parentIds: [dirty.id], taint: [] }),
      });
      assertEquals((await handlePut(space, clearAttempt, "human:local")).status, 201);
      const washed = await space.readOne({ kind: "task", match: { tag: "washed" } });
      assertEquals(washed!.runtimeMeta.taint, ["file"], "an empty raise cannot wash a parent's label");
    },
  },
  {
    name: "idempotency keys are scoped per principal (no cross-principal collision)",
    run: async (adapter) => {
      const space = newSpace(adapter, ["human:a", "human:b"]);
      const put = (principal: string, tag: string) =>
        handlePut(
          space,
          new Request("http://x/v0/records", {
            method: "POST",
            headers: { "Idempotency-Key": "job-42" },
            body: JSON.stringify({ kind: "task", body: { tag } }),
          }),
          principal,
        );
      // Two principals reuse the SAME Idempotency-Key with different bodies. Both are operators
      // here only so the write is allowed: the subject under test is key scoping, not authority.
      const a = await put("human:a", "from-a");
      const b = await put("human:b", "from-b");
      assertEquals(a.status, 201);
      assertEquals(b.status, 201); // NOT a 409, and NOT a replay of human:a's stored response
      const idA = (await a.json()).id, idB = (await b.json()).id;
      assert(idA !== idB); // distinct records, each attributed to its own caller
      assertEquals((await space.getRecord(idA))!.runtimeMeta.createdBy, "human:a");
      assertEquals((await space.getRecord(idB))!.runtimeMeta.createdBy, "human:b");
      // each principal's OWN replay still dedups (returns its own id)
      assertEquals((await (await put("human:a", "from-a")).json()).id, idA);
    },
  },
  {
    name: "records are immutable: a second put creates a new id, the first is unchanged",
    run: async (adapter) => {
      const space = newSpace(adapter);
      const a = await space.put({ kind: "task", body: { seq: 1 } });
      const b = await space.put({ kind: "task", body: { seq: 2 } });
      assert(a.id !== b.id, "expected distinct ids");

      const first = await space.readOne({ kind: "task", match: { seq: 1 } });
      const second = await space.readOne({ kind: "task", match: { seq: 2 } });
      assertEquals(first?.id, a.id);
      assertEquals(second?.id, b.id);
      assertEquals(first?.body, { seq: 1 }); // untouched by the second put
    },
  },
  {
    name: "parent_ids must all exist at commit",
    run: async (adapter) => {
      const space = newSpace(adapter);
      // a real parent is accepted
      const parent = await space.put({ kind: "fact", body: { v: 1 } });
      const child = await space.put({
        kind: "task",
        body: { tag: "child" },
        parentIds: [parent.id],
      });
      assert(child.id.length > 0);

      // a dangling parent is rejected
      let rejected = false;
      try {
        await space.put({
          kind: "task",
          body: { tag: "orphan" },
          parentIds: ["01BOGUSPARENTIDDOESNOTEXIST"],
        });
      } catch (e) {
        rejected = true;
        assertEquals((e as { code?: string }).code, "parent_not_found");
      }
      assert(rejected, "expected a dangling parent to be rejected");
    },
  },
  {
    name: "an artifact body carries application fields, and the runtime's own always win",
    run: async (adapter) => {
      const space = new Space(adapter);
      // Artifacts were the one kind an application could not SCOPE: the body is entirely
      // runtime-built, and a grant pattern matches the body, so "artifacts belonging to this
      // conversation" was inexpressible and any holder of an id could read one.
      const { id } = await space.putArtifact(new TextEncoder().encode("hello"), {
        mediaType: "text/plain",
        appFields: { conversationId: "conv-1", origin: "tool" },
      });
      const rec = await space.getRecord(id);
      const body = rec!.body as Record<string, unknown>;
      assertEquals(body.conversationId, "conv-1");
      assertEquals(body.origin, "tool");
      assertEquals(body.mediaType, "text/plain");
      assertEquals(body.size, 5, "the runtime's own fields are still there");
      assert(typeof body.digest === "string" && body.digest.length > 0);

      // …and cannot be forged: a caller supplying one is refused outright rather than silently
      // overridden, so a lie about a digest is never a stored record that merely looks wrong.
      for (const field of ["digest", "size", "mediaType", "filename"]) {
        let refused = false;
        try {
          await space.putArtifact(new TextEncoder().encode("x"), {
            mediaType: "text/plain",
            appFields: { [field]: "forged" },
          });
        } catch (e) {
          refused = (e as RadiaError).code === "invalid_artifact";
        }
        assert(refused, `supplying '${field}' must be refused`);
      }

      // Metadata, not a second payload: the bytes live in the blob store precisely so bodies stay
      // small and matchable.
      let tooBig = false;
      try {
        await space.putArtifact(new TextEncoder().encode("x"), {
          mediaType: "text/plain",
          appFields: { note: "x".repeat(300) },
        });
      } catch {
        tooBig = true;
      }
      assert(tooBig, "an oversized field is rejected");
    },
  },
  {
    name: "a pattern-scoped grant can bind an artifact to an application field",
    run: async (adapter) => {
      const space = new Space(adapter);
      // The whole point of the field: this grant is inexpressible without it.
      await space.persistKind({
        kind: "artifact",
        indexedPaths: [
          { path: "digest", type: "keyword" },
          { path: "mediaType", type: "keyword" },
          { path: "conversationId", type: "keyword" },
        ],
        claimable: false,
      });
      await space.put({
        kind: "grant",
        body: {
          principal: "agent:w",
          kind: "artifact",
          operations: ["read_one"],
          pattern: { conversationId: "mine" },
        },
      });
      const mine = await space.putArtifact(new TextEncoder().encode("mine"), {
        mediaType: "text/plain",
        appFields: { conversationId: "mine" },
      });
      const theirs = await space.putArtifact(new TextEncoder().encode("theirs"), {
        mediaType: "text/plain",
        appFields: { conversationId: "theirs" },
      });

      const constraint = await space.authorize("agent:w", "read_one", "artifact");
      assertEquals(constraint, [{ conversationId: "mine" }]);
      const ok = (await space.getRecord(mine.id))!.body;
      const no = (await space.getRecord(theirs.id))!.body;
      assert(space.bodyMatchesGrant("artifact", ok, constraint!), "its own artifact is inside the scope");
      assert(!space.bodyMatchesGrant("artifact", no, constraint!), "another conversation's is not");
    },
  },
  {
    name: "a body over the size limit is refused, because a body can never be erased",
    run: async (adapter) => {
      // The familiar reason for a size limit is that bodies stay queryable JSON: matched against,
      // returned in pages, re-sent to whatever reads them. The load-bearing reason is erasure. A
      // payload out of line can be destroyed (`shredArtifact`); a body cannot, and no verb reaches
      // one. With no limit, base64ing a secret into a body is how unerasable data enters a space.
      const space = new Space(adapter, { maxRecordBytes: 1024 });
      space.registerKind({ kind: "t", indexedPaths: [] });

      // Just under: accepted, so the limit is a limit and not a tax on ordinary records.
      const small = await space.put({ kind: "t", body: { s: "x".repeat(500) } });
      assert(small.id, "an ordinary body is unaffected");

      const err = await denied(() => space.put({ kind: "t", body: { s: "x".repeat(2000) } }));
      assertEquals(err, "record_too_large");

      // BYTES, not characters. A body of astral-plane characters is twice its length in the
      // encoded form, which is what storage holds and what travels on the wire; measuring
      // `.length` would let a caller past the limit by choosing a different alphabet.
      const astral = await denied(() => space.put({ kind: "t", body: { s: "\u{1F600}".repeat(300) } }));
      assertEquals(astral, "record_too_large", "600 UTF-16 units but 1200 bytes: the limit is on bytes");

      // The check sits in `buildRecord`, where the serialized body first exists, so every writer
      // passes through it rather than each entry point remembering to look. The artifact path
      // additionally has its own TIGHTER guard that fires first: metadata fields are capped at 256
      // characters each, so an artifact record cannot reach the body limit by that route at all.
      // Worth pinning, because "the size limit did not fire" here is correct rather than a gap.
      const wide = { mediaType: "text/plain", appFields: { note: "y".repeat(2000) } };
      const viaArtifact = await denied(() => space.putArtifact(new TextEncoder().encode("hi"), wide));
      assertEquals(viaArtifact, "invalid_artifact", "artifact metadata is capped earlier and tighter");
    },
  },
];
