// Phase 1 conformance: put + read_one, record immutability, body_sha256 integrity, the
// client-vs-runtime metadata split, and parent-must-exist. Each suite runs on every
// adapter (see harness.ts), so a behavior is only done when green on both.

import { assert, assertEquals } from "@std/assert";
import type { Suite } from "../harness.ts";
import { Space } from "../../../src/core/space.ts";
import { sha256Hex } from "../../../src/core/ids.ts";
import { handlePut } from "../../../src/server/handlers/records.ts";
import { RadiaError } from "../../../src/core/errors.ts";

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
    name: "an erasure that stopped holding is REPORTED, since neither refusing the write nor the read is right",
    run: async (adapter) => {
      const space = new Space(adapter);
      const SECRET = new TextEncoder().encode("the thing someone exercised a right to erase\n");
      const leaked = await space.putArtifact(SECRET, { mediaType: "text/plain", filename: "leak.txt" });
      const other = await space.putArtifact(new TextEncoder().encode("unrelated\n"), { mediaType: "text/plain" });
      await space.shredArtifact(leaked.id, { reason: "subject request" });
      await space.shredArtifact(other.id, { reason: "retention" });

      const before = await space.erasures({ onlyUndone: true });
      assertEquals(before.erasures.length, 0, "both erasures hold to begin with");
      assertEquals(before.checked, 2);
      assert(before.complete, "a scan that reached the end says so");

      // The accident that exposed all of this: a model still holding the erased text in its context
      // re-saved it through an ordinary tool. The blob returns to the same content address and every
      // record referencing it reads again — nothing in the system noticed, because `shredOf` was
      // consulted only AFTER a read had already failed.
      await space.putArtifact(SECRET, { mediaType: "text/plain", filename: "reconstructed.txt" });
      assert((await space.readArtifact(leaked.id)) !== null, "the shredded record reads again: that is the fact being reported");

      const after = await space.erasures({ onlyUndone: true });
      assertEquals(after.erasures.length, 1, "the reversed erasure is found");
      assertEquals(after.erasures[0].artifactId, leaked.id);
      assertEquals(after.erasures[0].holds, false);
      assertEquals(after.erasures[0].reason, "subject request");

      // The one that still holds is not swept up with it: this is a report, not an alarm.
      const all = await space.erasures();
      assertEquals(all.erasures.length, 2);
      assertEquals(all.erasures.filter((e) => e.holds).length, 1);

      // And it reaches the health report, which is where an operator will actually meet it.
      const d = await space.diagnostics();
      assertEquals(d.undoneErasures?.count, 1);
      assertEquals(d.undoneErasures?.checked, 2);

      // THE LOOP CLOSES, which is what makes the finding worth reporting rather than a permanent
      // scar. Re-erasing needs `acknowledgeShared` — by now two records hold those bytes and both
      // lose them — so the cost is stated before the act rather than discovered after it.
      const restored = (await space.query({ kind: "artifact", match: { digest: leaked.digest } }, 10))[0];
      let refusedWithoutAck = "";
      try {
        await space.shredArtifact(restored.id);
      } catch (e) {
        refusedWithoutAck = (e as Error).message;
      }
      assert(refusedWithoutAck.includes("all of them lose it"), refusedWithoutAck || "expected a shared-payload refusal");

      await space.shredArtifact(restored.id, { acknowledgeShared: true, reason: "re-erased" });
      assertEquals((await space.erasures({ onlyUndone: true })).erasures.length, 0, "the finding clears");
      // EVERY marker for that digest flips back, including the one written before the re-upload,
      // because `holds` is derived from present state rather than tracked. Nothing has to remember
      // the sequence, so nothing can disagree with it.
      const markers = (await space.erasures()).erasures.filter((e) => e.digest === leaked.digest);
      assertEquals(markers.length, 2, "one marker per erasure EVENT, not per digest");
      assert(markers.every((e) => e.holds), "all of them hold again");
      assertEquals(await space.readArtifact(leaked.id), null, "and the payload is gone once more");
    },
  },
  {
    name: "a scoped caller is told nothing about erasures rather than a reassuring zero",
    run: async (adapter) => {
      const space = new Space(adapter);
      const a = await space.putArtifact(new TextEncoder().encode("gone\n"), { mediaType: "text/plain" });
      await space.shredArtifact(a.id, { reason: "leaked" });
      await space.putArtifact(new TextEncoder().encode("gone\n"), { mediaType: "text/plain" });

      // Unscoped: the finding is there.
      assertEquals((await space.diagnostics()).undoneErasures?.count, 1);
      // Scoped: ABSENT, never 0. Shred records are operator-visible, so a session reporting "no
      // erasure was undone" would be reassurance on no evidence — the same trap that makes every
      // other scoped count carry a `scope` note.
      const scoped = await space.diagnostics({ createdBy: ["agent:x"], kinds: ["artifact"] });
      assertEquals(scoped.undoneErasures, undefined);
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
  {
    name: "clientMeta is guarded exactly like a body, and counts against the same budget",
    run: async (adapter) => {
      // `clientMeta` is client-supplied, persisted verbatim, returned on every read, and has no
      // erasure path — the body's whole argument, verbatim. It was assigned unguarded, so both
      // limits could be walked past by moving the payload one field sideways.
      const space = new Space(adapter, { maxRecordBytes: 1024 });
      space.registerKind({ kind: "t", indexedPaths: [] });

      const ok = await space.put({ kind: "t", body: { s: "x" }, clientMeta: { note: "y".repeat(200) } });
      assert(ok.id, "ordinary claims are unaffected");

      assertEquals(
        await denied(() => space.put({ kind: "t", body: { s: "x" }, clientMeta: { blob: "y".repeat(2000) } })),
        "record_too_large",
        "an oversized clientMeta is refused like an oversized body",
      );

      // ONE budget, not one each: halves that each fit but together do not must still be refused,
      // or the limit is defeated by splitting the payload across the two fields.
      assertEquals(
        await denied(() =>
          space.put({ kind: "t", body: { s: "x".repeat(600) }, clientMeta: { m: "y".repeat(600) } })
        ),
        "record_too_large",
        "body and clientMeta share the budget",
      );

      // NUL, both fields. A body's reason is storage (jsonb cannot hold U+0000); clientMeta's is
      // the boundary — a caller cannot see why the neighbouring JSON field would accept it.
      assertEquals(
        await denied(() => space.put({ kind: "t", body: { s: "a\u0000b" } })),
        "invalid_body",
        "a NUL in a body is refused",
      );
      assertEquals(
        await denied(() => space.put({ kind: "t", body: { s: "ok" }, clientMeta: { s: "a\u0000b" } })),
        "invalid_body",
        "…and in clientMeta too",
      );
      // The literal six-character text that SPELLS the escape is ordinary data and stays storable:
      // the check matches a genuine escape (an even number of preceding backslashes), not the text.
      const spelled = await space.put({ kind: "t", body: { s: "\\u0000" }, clientMeta: { s: "\\u0000" } });
      assert(spelled.id, "the escape written out as text is not a NUL");
    },
  },
];
