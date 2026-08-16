// The fail-closed contract for encrypted bodies (`extensions/ts/encrypted.ts`).
//
//   deno task extensions
//
// One property: a reader that meets a marker it cannot handle RAISES, and nothing downstream ever
// sees the field. Nothing encrypts yet (plan-encryption.md phase 1 ships the refusal BEFORE the
// thing that needs it), so a planted `{enc: "v1"}` body is the whole fixture.
//
// The failure this stops is worse than a leak and quieter than a crash: ciphertext handed to a
// provider as text produces a confident answer about nothing, with nothing in the transcript
// saying why. So each reader is asserted at ITS OWN boundary rather than once at a shared helper —
// the helper is not what a future change routes around.
//
// The tool worker's half of the contract lives in tool-worker.test.ts, where the
// answer-not-a-nack rule it has to obey is already pinned.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { assembleContext, type ThreadRow, toMessage } from "../ts/context.ts";
import {
  assertReadable,
  type ConversationKey,
  decryptText,
  openBody,
  sealBody,
  encMarker,
  EncryptedBodyError,
  ENC_V1,
  encryptionOf,
  fleetKeyId,
  KeyRing,
  newFleetKeyPair,
  newKeyBytes,
  NoConversationKeyError,
  openConversation,
  sealConversation,
} from "../ts/encrypted.ts";
import { contextForTest } from "../ts/inference.ts";

const PORT = 7841;
const url = `http://127.0.0.1:${PORT}`;

const row = (index: number, role: string, content: string, enc?: string): ThreadRow =>
  ({ index, role, content, ...(enc ? { enc } : {}) }) as ThreadRow;

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind({
    kind: "message",
    indexedPaths: [
      { path: "conversationId", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "role", type: "keyword" },
    ],
    sortablePaths: ["index"],
    claimable: false,
  });
  try {
    return await fn(c);
  } finally {
    try {
      space.kill();
    } catch { /* already gone */ }
    await space.status;
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test("[encrypted] no marker this build can read, and that is the phase-1 contract", () => {
  assertEquals(encMarker({ content: "hello" }), undefined);
  assertEquals(encMarker({ content: "…", enc: ENC_V1 }), ENC_V1);
  // A non-string marker still refuses: the check is presence-of-something-unhandled, so a body
  // cannot slip past by carrying `enc: true`.
  assertEquals(encMarker({ enc: true }), "true");
  assertThrows(() => assertReadable({ enc: ENC_V1 }, "here"), EncryptedBodyError);
  assertThrows(() => assertReadable({ enc: "v99" }, "here"), EncryptedBodyError);
  assertReadable({ content: "plain" }, "here");
  assertReadable(undefined, "here");
});

Deno.test("[encrypted] the refusal names the READER, because that is the useful half", () => {
  const e = assertThrows(
    () => assertReadable({ enc: ENC_V1 }, "assembleContext"),
    EncryptedBodyError,
  ) as EncryptedBodyError;
  assertEquals(e.where, "assembleContext");
  assertEquals(e.marker, ENC_V1);
  assert(!e.message.includes("placeholder"), "never a substitute; the read stops");
});

Deno.test("[encrypted] the provider payload refuses an encrypted row, head or body", () => {
  const system = row(0, "system", "be brief");
  const plain = [row(1, "user", "hello"), row(2, "assistant", "hi")];
  assertEquals(assembleContext(system, plain).messages.length, 3, "a plaintext thread is untouched");

  assertThrows(
    () => assembleContext(system, [row(1, "user", "hello"), row(2, "assistant", "zzz", ENC_V1)]),
    EncryptedBodyError,
    "assembleContext",
  );
  // The head too. It is read directly rather than through `toMessage`, so a check placed only in
  // the converter would let the standing instructions through as ciphertext.
  assertThrows(
    () => assembleContext(row(0, "system", "zzz", ENC_V1), plain),
    EncryptedBodyError,
    "assembleContext",
  );
  // And the converter on its own, which `contextFor`'s unwindowed branch reaches directly.
  assertThrows(() => toMessage(row(1, "user", "zzz", ENC_V1)), EncryptedBodyError, "toMessage");
  assertEquals(toMessage(row(1, "user", "hello")).content, "hello");
});

Deno.test("[encrypted] the inference worker refuses at every way in", async () => {
  await withSpace(async (c) => {
    const conversationId = "conv-e";
    const owner = "human:alice";
    await c.put({ kind: "message", body: { conversationId, owner, index: 0, role: "system", content: "be brief" } });
    await c.put({ kind: "message", body: { conversationId, owner, index: 1, role: "user", content: "hello" } });

    // Control: the same call before anything is marked.
    const ok = await contextForTest(c, { conversationId, owner, upToIndex: 1 }, 40, 200_000);
    assertEquals(ok.messages.length, 2);

    // 1. A thread row. BOTH window settings, for the reason inference.test.ts asserts both: the two
    //    branches read the same records by different routes.
    await c.put({
      kind: "message",
      body: { conversationId, owner, index: 2, role: "assistant", content: "Y2lwaGVy", enc: ENC_V1 },
    });
    for (const window of [0, 40]) {
      const e = await contextForTest(c, { conversationId, owner, upToIndex: 2 }, window, 200_000)
        .then(() => null, (err) => err);
      assert(e instanceof EncryptedBodyError, `window=${window}: refused rather than rendered`);
    }

    // 2. The call body itself, which carries prose inline and beside a reference.
    const inline = await contextForTest(
      c,
      { messages: [{ role: "user", content: "zzz" }], enc: ENC_V1 } as never,
      40,
      200_000,
    ).then(() => null, (err) => err);
    assert(inline instanceof EncryptedBodyError, "an encrypted llm_call body is refused before its messages are used");

    // 3. The classify reference, whose text the worker fetches rather than receives.
    await c.put({
      kind: "message",
      body: { conversationId, owner, index: 9, role: "user", content: "Y2lwaGVy", enc: ENC_V1 },
    });
    const classify = await contextForTest(
      c,
      { system: "classify", classifyOf: { conversationId, owner, index: 9 } } as never,
      40,
      200_000,
    ).then(() => null, (err) => err);
    assert(classify instanceof EncryptedBodyError, "a reference resolving to an encrypted message is refused");
    assertEquals((classify as EncryptedBodyError).where, "contextFor(classifyOf)");
  });
});

// ---- phase 2: one DEK per conversation, wrapped twice ----
//
// The four properties the design turns on, plus the one the build added: the fleet half is
// ASYMMETRIC, because in join mode the SESSION creates the conversation and must wrap to a fleet
// whose secret it must not hold. A symmetric KEK cannot express that — wrapping to it is holding it.

/**
 * Whether two DEKs are the same key, proved by USE rather than by bytes.
 *
 * An unwrapped DEK is deliberately non-extractable, so there are no bytes to compare — and this is
 * the better assertion regardless: what phase 3 needs is that the opened key decrypts what the
 * sealed one wrote, not that two handles look alike.
 */
async function sameKey(sealed: ConversationKey, opened: ConversationKey): Promise<boolean> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sealed.content, new TextEncoder().encode("probe"));
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, opened.content, ct)) === "probe";
  } catch {
    return false;
  }
}

Deno.test("[encrypted] a person opens their own conversation, and only their own", async () => {
  const fleet = await newFleetKeyPair();
  const alice = newKeyBytes();
  const bob = newKeyBytes();

  const hers = await sealConversation(fleet, { "human:alice": alice });
  const his = await sealConversation(fleet, { "human:bob": bob });

  const opened = await openConversation(hers.encryption, { kind: "person", principal: "human:alice", key: alice });
  assert(await sameKey(hers.key, opened), "her own thread opens");

  // HANDED THE RECORD, which is the case worth pinning: grants stop her fetching his, and this is
  // what is left if one ever reaches her anyway.
  await assertRejects(
    () => openConversation(his.encryption, { kind: "person", principal: "human:bob", key: alice }),
    NoConversationKeyError,
    "does not open",
  );
  await assertRejects(
    () => openConversation(his.encryption, { kind: "person", principal: "human:alice", key: alice }),
    NoConversationKeyError,
    "no key wrapped for",
  );
});

Deno.test("[encrypted] the fleet opens both, and a session cannot wrap ITSELF into the fleet's place", async () => {
  const fleet = await newFleetKeyPair();
  const alice = newKeyBytes(), bob = newKeyBytes();
  const hers = await sealConversation(fleet, { "human:alice": alice });
  const his = await sealConversation(fleet, { "human:bob": bob });

  for (const [conv, sealed] of [[hers, "alice"], [his, "bob"]] as const) {
    const dek = await openConversation(conv.encryption, { kind: "fleet", privateKey: fleet.privateKey });
    assert(await sameKey(conv.key, dek), `the fleet decrypts ${sealed}'s`);
  }

  // The asymmetry, stated as a test: what a session holds to SEAL is the public half, and it opens
  // nothing. This is the whole reason the fleet half is not a shared symmetric KEK.
  const other = await newFleetKeyPair();
  await assertRejects(
    () => openConversation(hers.encryption, { kind: "fleet", privateKey: other.privateKey }),
    NoConversationKeyError,
  );
});

Deno.test("[encrypted] rotating a person's key leaves the fleet wrap intact", async () => {
  const fleet = await newFleetKeyPair();
  const before = newKeyBytes();
  const conv = await sealConversation(fleet, { "human:alice": before });

  const after = newKeyBytes(); // she rotates; the record is untouched
  await assertRejects(
    () => openConversation(conv.encryption, { kind: "person", principal: "human:alice", key: after }),
    NoConversationKeyError,
    "does not open",
  );
  // The point of the second wrap: the conversation is not lost, it is merely no longer hers to open.
  const dek = await openConversation(conv.encryption, { kind: "fleet", privateKey: fleet.privateKey });
  assert(await sameKey(conv.key, dek));
});

Deno.test("[encrypted] a rotated FLEET key is named as a rotation, not as a decrypt failure", async () => {
  const old = await newFleetKeyPair();
  const conv = await sealConversation(old, { "human:alice": newKeyBytes() });
  const now = await newFleetKeyPair();

  const e = await openConversation(conv.encryption, { kind: "fleet", privateKey: now.privateKey, keyId: now.keyId })
    .then(() => null, (err) => err);
  assert(e instanceof NoConversationKeyError);
  assert(e.message.includes(old.keyId), "names the key it was sealed to, so an operator knows which one to keep");
  // The id is derived from the public half, so both sides compute it from what they hold.
  assertEquals(await fleetKeyId(old.publicKey), old.keyId);
});

Deno.test("[encrypted] key material reads back off a record body, and a half-written one reads as none", async () => {
  const fleet = await newFleetKeyPair();
  const { encryption } = await sealConversation(fleet, { "human:alice": newKeyBytes() });
  // The shape the key record stores: the block flattened beside its routing fields.
  const body = { conversationId: "conv-1", owner: "human:alice", ...encryption };
  assertEquals(encryptionOf(body)?.fleet, encryption.fleet);
  assertEquals(encryptionOf({ conversationId: "conv-1", owner: "human:alice" }), undefined);
  assertEquals(encryptionOf({ v: ENC_V1 }), undefined, "a version with no wrap is not key material");
  // And it must never carry the reader's refusal marker, or the one record needed to proceed is the
  // one every reader rejects.
  assertReadable(body, "conversation_key");
});

Deno.test("[encrypted] a KeyRing unwraps once per conversation and forgets a failure", async () => {
  const fleet = await newFleetKeyPair();
  const alice = newKeyBytes();
  const a = await sealConversation(fleet, { "human:alice": alice });
  const ring = new KeyRing({ kind: "person", principal: "human:alice", key: alice });

  const [x, y] = await Promise.all([ring.dek("conv-a", a.encryption), ring.dek("conv-a", a.encryption)]);
  assertEquals(x, y, "concurrent claims on one conversation unwrap once");
  assert(await sameKey(a.key, x));

  // A rejection is evicted rather than cached: a holder that was briefly wrong must not have that
  // remembered as this conversation's answer.
  const other = await sealConversation(fleet, { "human:bob": newKeyBytes() });
  await assertRejects(() => ring.dek("conv-b", other.encryption), NoConversationKeyError);
  const fixed = await sealConversation(fleet, { "human:alice": alice });
  assert(await sameKey(fixed.key, await ring.dek("conv-b", fixed.encryption)));
});

// ---- phase 3: one field, end to end ----
//
// `message.content` and `llm_chunk.delta`. The chunk is not in the plan's phase-3 list and is here
// anyway: encrypting the final answer while the same text streams past in clear is a feature that
// looks like it works, and chunks are retained for a day.

const conversationKey = async (): Promise<ConversationKey> =>
  (await sealConversation(await newFleetKeyPair(), { "human:alice": newKeyBytes() })).key;

Deno.test("[encrypted] a sealed body round-trips, and the marker is what a reader keys on", async () => {
  const key = await conversationKey();
  const sealed = await sealBody({ conversationId: "c1", owner: "human:alice", index: 3, role: "user", content: "hello" }, "message", key);

  assertEquals(sealed.conversationId, "c1", "routing fields stay CLEAR: a grant pattern matches the body on write");
  assertEquals(sealed.owner, "human:alice");
  assertEquals(sealed.index, 3);
  assertEquals(sealed.role, "user");
  assertEquals(encMarker(sealed), ENC_V1);
  assert(!String(sealed.content).includes("hello"), "the prose is gone from the body");
  assertThrows(() => assertReadable(sealed, "anyone"), EncryptedBodyError); // a keyless reader still refuses

  const opened = await openBody(sealed, "message", key);
  assertEquals(opened.content, "hello");
  assertEquals(encMarker(opened), undefined, "opening REMOVES the marker, which is what lets the reader proceed");
  assertReadable(opened, "anyone");
});

Deno.test("[encrypted] opening is what clears the refusal, never a whitelist", async () => {
  const key = await conversationKey();
  const sealed = await sealBody({ role: "assistant", content: "answer" }, "message", key);
  // The phase-1 wall is still up for the marker phase 3 introduced. If `READABLE` had gained "v1"
  // instead, a reader that forgot to decrypt would pass ciphertext along in silence — the exact
  // failure the marker exists to stop.
  assertThrows(() => assertReadable(sealed, "a reader that forgot"), EncryptedBodyError);
  assertThrows(() => toMessage(sealed as never), EncryptedBodyError);
  assertEquals(toMessage(await openBody(sealed, "message", key) as never).content, "answer");
});

Deno.test("[encrypted] a KEYED re-put is byte-identical, so a retry replays instead of conflicting", async () => {
  const key = await conversationKey();
  const body = { conversationId: "c1", owner: "human:alice", index: 1, role: "user", content: "same text" };

  // `Space.idem` hashes {kind, body, parentIds} into `requestHash` to detect a DIFFERENT request
  // under one key. A random nonce would make every keyed retry an `idempotency_conflict` — a
  // substrate error for something the substrate got right.
  const a = await sealBody(body, "message", key, "turn:01ABC");
  const b = await sealBody(body, "message", key, "turn:01ABC");
  assertEquals(a.content, b.content, "same key, same body: byte-identical ciphertext");

  // …and distinct across writes, or two records would share a nonce under one DEK.
  const other = await sealBody(body, "message", key, "turn:01XYZ");
  assert(a.content !== other.content, "a different idempotency key is a different nonce");

  // An UNKEYED write is random: there is no replay to match, and randomness is the stronger default.
  const r1 = await sealBody(body, "message", key);
  const r2 = await sealBody(body, "message", key);
  assert(r1.content !== r2.content, "unkeyed writes do not repeat a nonce");

  // Determinism must not leak equality between DIFFERENT plaintexts sharing a key…
  const different = await sealBody({ ...body, content: "other text" }, "message", key, "turn:01ABC");
  assert(different.content !== a.content);
  // …nor make identical plaintexts recognisable across records, which fully deterministic
  // encryption would. Different writes, different keys, different ciphertext.
  assert(other.content !== a.content);
  assertEquals(await decryptText(key, String(a.content)), "same text");
});

Deno.test("[encrypted] the stream is sealed too, and each kind seals only its own fields", async () => {
  const key = await conversationKey();
  const chunk = await sealBody({ callId: "x", conversationId: "c1", index: 0, delta: "hel" }, "llm_chunk", key);
  assertEquals(chunk.callId, "x", "the watermark and its routing stay clear");
  assertEquals(chunk.index, 0);
  assert(!String(chunk.delta).includes("hel"));
  assertEquals((await openBody(chunk, "llm_chunk", key)).delta, "hel");

  // A kind with nothing declared is untouched, marker included: sealing a key record would make the
  // one record every reader needs the one every reader refuses.
  const untouched = await sealBody({ conversationId: "c1", fleet: "…" }, "conversation_key", key);
  assertEquals(encMarker(untouched), undefined);
  assertReadable(untouched, "conversation_key");
});

Deno.test("[encrypted] an absent or null field is left absent, never invented", async () => {
  const key = await conversationKey();
  // An assistant message that only calls tools carries `content: null`. Encrypting the absence
  // would put a string where the provider payload expects none.
  const sealed = await sealBody({ role: "assistant", content: null, tool_calls: [{ id: "t1" }] }, "message", key);
  assertEquals(sealed.content, null);
  assertEquals((await openBody(sealed, "message", key)).content, null);
  assertEquals(encMarker(sealed), ENC_V1, "the body is still MARKED, because its kind can carry prose");
});

Deno.test("[encrypted] the wrong conversation's key does not open a body", async () => {
  const mine = await conversationKey();
  const theirs = await conversationKey();
  const sealed = await sealBody({ role: "user", content: "secret" }, "message", mine);
  await assertRejects(() => openBody(sealed, "message", theirs));
  // Tampering fails the same way: AES-GCM authenticates, so a flipped byte is a refusal and never
  // a plausible-looking different answer.
  const bytes = atob(String(sealed.content)).split("");
  bytes[bytes.length - 1] = String.fromCharCode(bytes[bytes.length - 1].charCodeAt(0) ^ 1);
  await assertRejects(() => decryptText(mine, btoa(bytes.join(""))));
});
