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
import { assembleContext, type ThreadRow, toMessage } from "../ts/context.ts";
import { bootSpace } from "./space.ts";
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
  NoConversationKeyError,
  openConversation,
  sealConversation,
  withWrapsFor,
} from "../ts/encrypted.ts";
import { contextForTest } from "../ts/inference.ts";

const PORT = 7841;
const url = `http://127.0.0.1:${PORT}`;

/** A person holder from a key pair. Their machines are addressed by KEY ID, so the principal is
 *  only there to name whose machine it is when something is refused. */
const asPerson = (principal: string, k: { keyId: string; privateKey: string }) =>
  ({ kind: "person", principal, keyId: k.keyId, privateKey: k.privateKey }) as const;

const row = (index: number, role: string, content: string, enc?: string): ThreadRow =>
  ({ index, role, content, ...(enc ? { enc } : {}) }) as ThreadRow;

const shared = await bootSpace(PORT);
await shared.registerKind({
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

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  return await fn(shared);
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
  const alice = await newFleetKeyPair();
  const bob = await newFleetKeyPair();

  const hers = await sealConversation(fleet, [alice]);
  const his = await sealConversation(fleet, [bob]);

  const opened = await openConversation(hers.encryption, asPerson("human:alice", alice));
  assert(await sameKey(hers.key, opened), "her own thread opens");

  // HANDED THE RECORD, which is the case worth pinning: grants stop her fetching his, and this is
  // what is left if one ever reaches her anyway.
  // Her key id is not among his readers, so this is "no wrap for this key" rather than a decrypt
  // failure — and either way she does not get in.
  await assertRejects(
    () => openConversation(his.encryption, asPerson("human:alice", alice)),
    NoConversationKeyError,
    "no key wrapped for",
  );
  // …and a forged holder that names HIS key id with HER private half fails at the crypto.
  await assertRejects(
    () => openConversation(his.encryption, { kind: "person", principal: "human:alice", keyId: bob.keyId, privateKey: alice.privateKey }),
    NoConversationKeyError,
    "does not open",
  );
});

Deno.test("[encrypted] the fleet opens both, and a session cannot wrap ITSELF into the fleet's place", async () => {
  const fleet = await newFleetKeyPair();
  const alice = await newFleetKeyPair(), bob = await newFleetKeyPair();
  const hers = await sealConversation(fleet, [alice]);
  const his = await sealConversation(fleet, [bob]);

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
  const before = await newFleetKeyPair();
  const conv = await sealConversation(fleet, [before]);

  const after = await newFleetKeyPair(); // she rotates; the record is untouched
  await assertRejects(
    () => openConversation(conv.encryption, asPerson("human:alice", after)),
    NoConversationKeyError,
  );
  // The point of the second wrap: the conversation is not lost, it is merely no longer hers to open.
  const dek = await openConversation(conv.encryption, { kind: "fleet", privateKey: fleet.privateKey });
  assert(await sameKey(conv.key, dek));
});

Deno.test("[encrypted] a rotated FLEET key is named as a rotation, not as a decrypt failure", async () => {
  const old = await newFleetKeyPair();
  const conv = await sealConversation(old, [await newFleetKeyPair()]);
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
  const { encryption } = await sealConversation(fleet, [await newFleetKeyPair()]);
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
  const alice = await newFleetKeyPair();
  const a = await sealConversation(fleet, [alice]);
  const ring = new KeyRing(asPerson("human:alice", alice));

  const [x, y] = await Promise.all([ring.dek("conv-a", a.encryption), ring.dek("conv-a", a.encryption)]);
  assertEquals(x, y, "concurrent claims on one conversation unwrap once");
  assert(await sameKey(a.key, x));

  // A rejection is evicted rather than cached: a holder that was briefly wrong must not have that
  // remembered as this conversation's answer.
  const other = await sealConversation(fleet, [await newFleetKeyPair()]);
  await assertRejects(() => ring.dek("conv-b", other.encryption), NoConversationKeyError);
  const fixed = await sealConversation(fleet, [alice]);
  assert(await sameKey(fixed.key, await ring.dek("conv-b", fixed.encryption)));
});

// ---- phase 3: one field, end to end ----
//
// `message.content` and `llm_chunk.delta`. The chunk is not in the plan's phase-3 list and is here
// anyway: encrypting the final answer while the same text streams past in clear is a feature that
// looks like it works, and chunks are retained for a day.

const conversationKey = async (): Promise<ConversationKey> =>
  (await sealConversation(await newFleetKeyPair(), [await newFleetKeyPair()])).key;

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
  // runtime error for something the runtime got right.
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

// ---- phase 4: the remaining fields ----

Deno.test("[encrypted] a JSON field round-trips as its VALUE, not as a string of one", async () => {
  const key = await conversationKey();
  // `tool_result.output` is whatever a tool returned, so it is sealed as JSON and must come back
  // the same shape. A codec that returned the string would make every reader parse defensively.
  for (const output of [{ rows: [1, 2], note: "hi" }, "plain", 42, ["a"], true] as unknown[]) {
    const sealed = await sealBody({ callId: "c", ok: true, output }, "tool_result", key);
    assert(typeof sealed.output === "string", "on the wire it is ciphertext");
    assertEquals((await openBody(sealed, "tool_result", key)).output, output);
  }
  // A text field keeps phase 3's format: sealed as itself, not as JSON of itself.
  const msg = await sealBody({ role: "user", content: "hi" }, "message", key);
  assertEquals(await decryptText(key, String(msg.content)), "hi");
});

Deno.test("[encrypted] tool ARGUMENTS seal inside the assistant message, leaving routing readable", async () => {
  const key = await conversationKey();
  const calls = [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/secret"}' } },
    { id: "call_2", type: "function", function: { name: "run_js", arguments: '{"code":"1+1"}' } },
  ];
  const sealed = await sealBody({ role: "assistant", content: null, tool_calls: calls }, "message", key);
  const out = sealed.tool_calls as typeof calls;

  // What the TURN WORKER routes on has to survive in the clear, or it needs a key — and the design
  // rests on it not needing one.
  assertEquals(out.map((c) => c.id), ["call_1", "call_2"]);
  assertEquals(out.map((c) => c.function.name), ["read_file", "run_js"]);
  assert(!JSON.stringify(out).includes("/secret"), "the arguments are not");
  assert(!JSON.stringify(out).includes("1+1"));
  // Two calls in one round must not share a nonce under one DEK.
  assert(out[0].function.arguments !== out[1].function.arguments);

  const opened = (await openBody(sealed, "message", key)).tool_calls as typeof calls;
  assertEquals(opened.map((c) => c.function.arguments), calls.map((c) => c.function.arguments));
});

Deno.test("[encrypted] the same idempotency key seals two tool calls differently, and repeatably", async () => {
  const key = await conversationKey();
  const calls = [
    { id: "a", function: { name: "t", arguments: '{"x":1}' } },
    { id: "b", function: { name: "t", arguments: '{"x":1}' } },
  ];
  const body = { role: "assistant", tool_calls: calls };
  const one = await sealBody(body, "message", key, "turn:K");
  const two = await sealBody(body, "message", key, "turn:K");
  const a = (one.tool_calls as typeof calls).map((c) => c.function.arguments);
  const b = (two.tool_calls as typeof calls).map((c) => c.function.arguments);
  assertEquals(a, b, "a keyed re-put is byte-identical, calls included, so a retry replays");
  assert(a[0] !== a[1], "…while IDENTICAL arguments in one round still differ, so no nonce repeats");
});

Deno.test("[encrypted] a check keeps its verdict clear and its observations sealed", async () => {
  const key = await conversationKey();
  const sealed = await sealBody({
    callId: "c",
    verdict: "fail",
    sandbox: "deno",
    exitCode: 1,
    expected: { stdout_equals: "the secret" },
    stdout: "the actual output",
  }, "check", key);

  // An operator triaging a space needs to see WHICH checks failed without reading anyone's data.
  assertEquals(sealed.verdict, "fail");
  assertEquals(sealed.sandbox, "deno");
  assertEquals(sealed.exitCode, 1);
  assert(!JSON.stringify(sealed).includes("the secret"), "the expectation is content too");
  assert(!JSON.stringify(sealed).includes("the actual output"));

  const opened = await openBody(sealed, "check", key);
  assertEquals(opened.stdout, "the actual output");
  assertEquals(opened.expected, { stdout_equals: "the secret" });
});

// ---- a person's SECOND machine ----
//
// The wrap is per KEY, not per principal, and that is what unties a conversation from the machine
// it was created on. A symmetric person key could not do this: the sealer would have needed the
// opener's secret, so only the machine holding it could ever read.

Deno.test("[encrypted] a conversation seals to every machine a person has published", async () => {
  const fleet = await newFleetKeyPair();
  const laptop = await newFleetKeyPair(), desktop = await newFleetKeyPair();
  const conv = await sealConversation(fleet, [laptop, desktop]);

  for (const [name, k] of [["laptop", laptop], ["desktop", desktop]] as const) {
    assert(await sameKey(conv.key, await openConversation(conv.encryption, asPerson("human:alice", k))), name);
  }
  // A machine that was not published when it was sealed is not a reader, and says which key.
  const phone = await newFleetKeyPair();
  const e = await openConversation(conv.encryption, asPerson("human:alice", phone)).then(() => null, (x) => x);
  assert(e instanceof NoConversationKeyError);
  assert(e.message.includes(phone.keyId), "names the KEY, since the person may hold several");
});

Deno.test("[encrypted] enrolling a new machine reaches conversations sealed before it existed", async () => {
  const fleet = await newFleetKeyPair();
  const laptop = await newFleetKeyPair();
  const conv = await sealConversation(fleet, [laptop]);
  const desktop = await newFleetKeyPair();

  // Nothing yet: publishing a key does not retroactively open anything.
  await assertRejects(() => openConversation(conv.encryption, asPerson("human:alice", desktop)), NoConversationKeyError);

  // The laptop, which CAN read, extends the conversation to the desktop. Only a holder can: adding
  // a wrap needs the DEK, so access spreads from a machine that has it, never from one that wants it.
  const grown = await withWrapsFor(conv.encryption, asPerson("human:alice", laptop), [laptop, desktop]);
  assert(await sameKey(conv.key, await openConversation(grown, asPerson("human:alice", desktop))));
  assert(await sameKey(conv.key, await openConversation(grown, asPerson("human:alice", laptop))), "and the laptop still reads");

  // Nothing was re-encrypted: the same DEK, one more wrap. The old wrap is byte-identical, so the
  // records the conversation already holds are untouched.
  assertEquals(grown.people[laptop.keyId], conv.encryption.people[laptop.keyId]);
  assertEquals(grown.fleet, conv.encryption.fleet);

  // Idempotent, and IDENTITY is the signal: a caller uses it to skip the write entirely.
  assertEquals(await withWrapsFor(grown, asPerson("human:alice", laptop), [laptop, desktop]), grown);

  // The FLEET can enrol too, which is what makes recovery possible when every machine is gone.
  const phone = await newFleetKeyPair();
  const byFleet = await withWrapsFor(grown, { kind: "fleet", privateKey: fleet.privateKey }, [phone]);
  assert(await sameKey(conv.key, await openConversation(byFleet, asPerson("human:alice", phone))));
});

Deno.test("[encrypted] a machine that cannot read the conversation cannot enrol itself", async () => {
  const fleet = await newFleetKeyPair();
  const laptop = await newFleetKeyPair();
  const conv = await sealConversation(fleet, [laptop]);
  const intruder = await newFleetKeyPair();

  // The whole safety of enrolment being a client operation: it needs the DEK, so a holder who
  // cannot open the conversation cannot add themselves to it.
  await assertRejects(
    () => withWrapsFor(conv.encryption, asPerson("human:mallory", intruder), [intruder]),
    NoConversationKeyError,
  );
});
