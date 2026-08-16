// Conversation keys and encrypted content, end to end on a real space (plan-encryption.md 2-3).
//
// The crypto is pinned in `extensions/conformance/encrypted.test.ts`; what this adds is the half a
// pure test cannot reach — whether the app's GRANTS let the right party fetch the key record and
// stop the wrong one. Both halves have to hold: the wrap is what protects a dump, the grant is what
// protects a live space, and each looks fine on its own while the other is broken.
//
// The second half runs a REAL turn through the real inference worker against a fake provider,
// because the property that matters cannot be seen from either end alone: the worker has to decrypt
// to call the model, and the stored row has to hold none of it.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assignUserGrants, bootstrap, mintSession, setSessionOwner } from "./space/roles.ts";
import { Thread } from "./client/thread.ts";
import { newFleetKeyPair, NoConversationKeyError, openBody, openConversation, sealConversation } from "../../extensions/ts/encrypted.ts";
import { serveTools } from "../../extensions/ts/tool-worker.ts";

const PORT = 7811;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
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

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const refused = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (e) {
    return /forbidden|401|403/.test(String(e));
  }
};

console.log("── encrypt ─────────────────────────────────────────────────────");
console.log("   conversation keys: who can fetch one, and who can open it\n");

// The operator credential BEFORE the key files move: `operatorToken` reads the same per-user file
// the person key is about to be redirected away from.
const admin = new RadiaClient(url, { token: operatorToken(url) });

// Both key stores into a temp directory. A suite that wrote a person key into the real credential
// file, or a fleet key into the repo's `.radia`, would leave a machine's state behind.
const tmp = await Deno.makeTempDir({ prefix: "radia-encrypt-" });
Deno.env.set("RADIA_CREDENTIALS", `${tmp}/credentials.json`);
Deno.env.set("RADIA_DIR", tmp);
const { CONVERSATION_KEY_KIND, ConversationErasedError, conversationKeys, currentFleetKey, fleetKeyPair, eraseConversation, livePersonKeys, personKeyPair, publishFleetKey, publishPersonKey, writeConversationKey } =
  await import("./space/keys.ts");
/** Alice, reading on one of her machines. */
const asAlice = (k: { keyId: string; privateKey: string }) =>
  ({ kind: "person", principal: alice, keyId: k.keyId, privateKey: k.privateKey }) as const;

await registerChatKinds(admin);
const { inferenceToken, turnToken, toolsToken, routerToken } = await bootstrap(admin, {});
const alice = "human:alice", bob = "human:bob";
await assignUserGrants(admin, alice, { owner: alice });
await assignUserGrants(admin, bob, { owner: bob });
const aliceC = new RadiaClient(url, { token: await mintSession(admin, alice, { owner: alice }) });
const bobC = new RadiaClient(url, { token: await mintSession(admin, bob, { owner: bob }) });

// ---- the deployment half: the fleet publishes its PUBLIC key ----
const fleet = await fleetKeyPair({ create: true });
check("the fleet generates a key pair", fleet !== undefined && fleet.privateKey.length > 0);
await publishFleetKey(admin, fleet!);
check("…and a joining session can read the public half", (await currentFleetKey(aliceC))?.keyId === fleet!.keyId);
check(
  "…which is the only half that leaves the fleet",
  !JSON.stringify(await aliceC.query({ kind: "fleet_key" }, 5)).includes(fleet!.privateKey.slice(0, 40)),
);
// Content-keyed: a fleet restarting must not append a record per boot.
await publishFleetKey(admin, fleet!);
check("republishing the same key writes nothing new", (await admin.query({ kind: "fleet_key" }, 10)).length === 1);

// ---- a session seals its own conversation ----
const conv = await aliceC.put({ kind: "conversation", body: {} });
// ALICE'S LAPTOP: a key pair whose public half is published, so any session of hers can seal to it.
const laptop = await personKeyPair(url, alice);
await publishPersonKey(aliceC, alice, laptop);
const { encryption, key: sealedKey } = await sealConversation(
  (await currentFleetKey(aliceC))!,
  await livePersonKeys(aliceC, alice),
);
const written = await writeConversationKey(aliceC, conv.id, alice, encryption);
check("a session writes its own conversation's key material", true, conv.id);

// Her key is STABLE across sessions on this machine, or a later one could not read what this wrote.
check("her machine's key is remembered", (await personKeyPair(url, alice)).keyId === laptop.keyId);
check("…and only its PUBLIC half is on the space",
  !JSON.stringify(await aliceC.query({ kind: "person_key" }, 5)).includes(laptop.privateKey.slice(0, 40)));

// ---- she reads it back, which is the whole point of a record over a client-side file ----
const back = await aliceC.readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId: conv.id } });
check("she fetches her key record", back !== null);
check(
  "…and the record NAMES the wraps rather than holding them, which is what makes them destroyable",
  (back!.body as { keys?: string }).keys === written.keys && !JSON.stringify(back!.body).includes(encryption.fleet),
);
const wraps = JSON.parse(new TextDecoder().decode(await aliceC.getArtifact(written.keys)));
const hers = await openConversation(wraps, { kind: "person", principal: alice, keyId: laptop.keyId, privateKey: laptop.privateKey });
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sealedKey.content, new TextEncoder().encode("probe"));
check(
  "…and the DEK it yields is the one she sealed with",
  new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, hers.content, ct)) === "probe",
);

// ---- bob: stopped by the grant FIRST, and by the wrap even if he gets past it ----
// EMPTY rather than forbidden, and the distinction is the mechanism: his grant is scoped to
// `{owner: bob}`, so the runtime ANDs that into his read and hers cannot match. A refusal would mean
// he holds no grant at all, which would pass this line for the wrong reason on a space that simply
// never granted him anything.
const asBob = await bobC.readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId: conv.id } });
check("bob's own grant cannot reach her key record", asBob === null, JSON.stringify(asBob?.body ?? null));
check(
  "…and it is scoping that does it, not an absence of grants",
  !(await refused(() => bobC.readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId: "nothing" } }))),
);
const bobKey = await personKeyPair(url, bob);
let opened = false;
try {
  await openConversation(wraps, { kind: "person", principal: bob, keyId: bobKey.keyId, privateKey: bobKey.privateKey });
  opened = true;
} catch (e) {
  check("…and handed the record anyway, his key does not open it", e instanceof NoConversationKeyError, String(e));
}
check("…he never opens it", !opened);

// ---- the fleet opens it, because inference must ----
const asFleet = await openConversation(wraps, { kind: "fleet", privateKey: fleet!.privateKey });
check(
  "the fleet opens what a session sealed, which is what lets inference answer",
  new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, asFleet.content, ct)) === "probe",
);

// ---- end to end: a real turn, with the real inference worker and a fake provider ----
//
// The loop phase 3 exists to prove: a session encrypts, the worker DECRYPTS to call a provider,
// seals its answer, and the session opens it. Asserted against the stored ROW as the operator sees
// it, not through a reader that would decrypt on the way out.

const frames = (deltas: Record<string, unknown>[]) =>
  [...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
    "data: [DONE]",
    ""].join("\n");

// It ECHOES what it was asked. A provider handed ciphertext would answer about nothing and the
// turn would still look like it worked, so the answer carries the question back and the assertion
// below is that the worker sent plaintext.
let sawPrompt = "";
const fake = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const sent = await req.json().catch(() => ({})) as { messages?: { role?: string; content?: string }[] };
  sawPrompt = (sent.messages ?? []).map((m) => m.content ?? "").join("\n");
  return new Response(frames([{ content: "the answer" }]), { headers: { "content-type": "text/event-stream" } });
});
const apiBase = `http://127.0.0.1:${(fake.addr as Deno.NetAddr).port}`;

// Spawned with EXACTLY the permissions and environment `launchFleet` gives it: `--allow-net
// --allow-env` and no filesystem at all. Under `-A` this test passed while the real fleet could not
// read the key file, and `fleetKeyPair` cannot tell "denied" from "absent", so the worker served no
// encrypted conversation and said nothing. A harness more privileged than the deployment is a
// harness that cannot see the deployment's bugs.
const worker = new Deno.Command(Deno.execPath(), {
  args: [
    "run", "--allow-net", "--allow-env",
    "examples/chat/workers/inference.ts",
    "--url", url, "--token", inferenceToken, "--tier", "fast", "--model", "fake/model",
  ],
  env: {
    RADIA_CHAT_API_BASE: apiBase,
    OPENROUTER_API_KEY: "unused",
    RADIA_CHAT_FLEET_KEY: btoa(JSON.stringify(fleet!)),
  },
  stdout: "null",
  stderr: "inherit",
}).spawn();

const awaitOne = async (pattern: { kind: string; match?: Record<string, unknown> }, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    const r = await admin.readOne(pattern);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
};

try {
  setSessionOwner(alice);
  const who = { principal: alice, privileged: false };
  const dek = await conversationKeys(aliceC, asAlice(laptop))(conv.id);
  const thread = await Thread.open(aliceC, who, conv.id, dek);
  await thread.append({ role: "user", content: "the secret question" });

  // What the operator sees on disk: no fragment of either message.
  const rows = await admin.query({ kind: "message", match: { conversationId: conv.id } }, 20);
  const raw = JSON.stringify(rows.map((r) => r.body));
  check("the stored rows carry no plaintext", !raw.includes("the secret question") && !raw.includes("concise assistant"), raw.slice(0, 90));
  check("…and every one is MARKED, so a keyless reader refuses rather than guesses", rows.every((r) => (r.body as { enc?: string }).enc === "v1"));
  check("…while its routing fields stay clear, or no grant could bind them", rows.every((r) => (r.body as { owner?: string }).owner === alice));

  const call = await aliceC.put({
    kind: "llm_call",
    body: { conversationId: conv.id, owner: alice, upToIndex: thread.upToIndex, tools: [], tier: "fast" },
    parentIds: [conv.id],
  });
  const answer = await awaitOne({ kind: "message", match: { conversationId: conv.id, callId: call.id } });
  check("the worker answered", answer !== null);
  if (answer) {
    check("it decrypted to call the provider", sawPrompt.includes("the secret question"), sawPrompt.slice(0, 60));
    const body = answer.body as Record<string, unknown>;
    check("the assistant message is sealed on the way back", body.enc === "v1" && !String(body.content).includes("the answer"));
    check("…and the session opens it", (await openBody(body, "message", dek!)).content === "the answer");
    const chunks = await admin.query({ kind: "llm_chunk", match: { conversationId: conv.id } }, 20);
    check("the STREAM is sealed too, not just the final answer", chunks.length > 0 && chunks.every((r) => (r.body as { enc?: string }).enc === "v1"), `${chunks.length} chunks`);
    check(
      "…and no chunk leaks the answer, which a day of retention would otherwise keep in clear",
      !JSON.stringify(chunks.map((r) => r.body)).includes("the answer"),
    );
  }

  // ---- the same turn with encryption OFF is untouched ----
  const plainConv = await aliceC.put({ kind: "conversation", body: {} });
  const plainThread = await Thread.open(aliceC, who, plainConv.id);
  await plainThread.append({ role: "user", content: "an open question" });
  const plainCall = await aliceC.put({
    kind: "llm_call",
    body: { conversationId: plainConv.id, owner: alice, upToIndex: plainThread.upToIndex, tools: [], tier: "fast" },
    parentIds: [plainConv.id],
  });
  const plainAnswer = await awaitOne({ kind: "message", match: { conversationId: plainConv.id, callId: plainCall.id } });
  check("a plaintext conversation still runs, byte for byte as before", plainAnswer !== null &&
    (plainAnswer.body as { content?: string }).content === "the answer" &&
    (plainAnswer.body as { enc?: string }).enc === undefined);
} finally {
  worker.kill();
  await worker.status;
  await fake.shutdown();
}

// ---- the FULL CHAIN on an encrypted conversation: a tool round ----
//
// The property phase 4 rests on, and the only place it can be seen: the TURN WORKER routes an
// encrypted conversation without a key. It reads the assistant message to find the tool calls,
// copies the sealed `arguments` blob into a `tool_call` without parsing it, and the tool worker —
// which does hold a key — opens it. A worker-level test cannot show this, because it writes the
// `tool_call` itself.

let round = 0;
const fake2 = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const sent = await req.json().catch(() => ({})) as { messages?: { role?: string; content?: string }[] };
  const msgs = sent.messages ?? [];
  // A tool call first, then prose once the reply is in the transcript. The provider ALSO reports
  // what it was shown, which is how "the tool's output came back decrypted" is asserted.
  // The ROUTER's classifier arrives here too, by reference (phase 0), and must not be answered with
  // a tool call. Told apart by the system prompt: the chat's own starts "You are a concise
  // assistant"; the router's does not.
  const isTurn = msgs.some((m) => m.role === "system" && (m.content ?? "").includes("concise assistant"));
  if (!isTurn) {
    return new Response(frames([{ content: "fast" }]), { headers: { "content-type": "text/event-stream" } });
  }
  const sawToolReply = msgs.some((m) => (m.content ?? "").includes("SECRET-OUTPUT"));
  if (!sawToolReply && round++ === 0) {
    return new Response(
      frames([{ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "peek", arguments: '{"path":"/etc/secret"}' } }] }]),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(frames([{ content: sawToolReply ? "saw the tool output" : "no tool output" }]), {
    headers: { "content-type": "text/event-stream" },
  });
});
const apiBase2 = `http://127.0.0.1:${(fake2.addr as Deno.NetAddr).port}`;

const chainWorkers = [
  new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--allow-net", "--allow-env",
      "examples/chat/workers/inference.ts",
      "--url", url, "--token", inferenceToken, "--tier", "fast", "--model", "fake/model",
    ],
    env: { RADIA_CHAT_API_BASE: apiBase2, OPENROUTER_API_KEY: "unused", RADIA_CHAT_FLEET_KEY: btoa(JSON.stringify(fleet!)) },
    stdout: "null",
    stderr: "inherit",
  }).spawn(),
  // NO KEY, and that is the assertion: this process is given neither the fleet key nor any other,
  // and the turn still completes.
  new Deno.Command(Deno.execPath(), {
    args: ["run", `--allow-net=127.0.0.1:${PORT}`, "examples/chat/workers/turn.ts", "--url", url, "--token", turnToken],
    stdout: "null",
    stderr: "inherit",
  }).spawn(),
  // The router too: the turn worker emits UNTIERED calls deliberately, so each round is classified
  // afresh, and without it round 2 would never be picked up. It holds NO key either.
  new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--allow-net", "--allow-env",
      "examples/chat/workers/router.ts", "--url", url, "--token", routerToken, "--classify-model", "fake/model",
    ],
    env: { RADIA_CHAT_API_BASE: apiBase2, OPENROUTER_API_KEY: "unused" },
    stdout: "null",
    stderr: "inherit",
  }).spawn(),
];

let toolSaw: unknown;
const toolStop = new AbortController();
const toolWorker = serveTools(new RadiaClient(url, { definitionToken: toolsToken }), {
  provider: "agent:chat-tools",
  tools: { peek: (a) => { toolSaw = a.path; return Promise.resolve("SECRET-OUTPUT for " + a.path); } },
  schemas: [{ type: "function", function: { name: "peek", description: "peek", parameters: { type: "object", properties: {} } } }],
  keys: conversationKeys(new RadiaClient(url, { definitionToken: toolsToken }), {
    kind: "fleet",
    privateKey: fleet!.privateKey,
    keyId: fleet!.keyId,
  }),
  signal: toolStop.signal,
});

try {
  const conv2 = await aliceC.put({ kind: "conversation", body: {} });
  const { encryption: e2 } = await sealConversation((await currentFleetKey(aliceC))!, await livePersonKeys(aliceC, alice));
  await writeConversationKey(aliceC, conv2.id, alice, e2);
  const dek2 = await conversationKeys(aliceC, asAlice(laptop))(conv2.id);
  const t2 = await Thread.open(aliceC, { principal: alice, privileged: false }, conv2.id, dek2);
  await t2.append({ role: "user", content: "look at the file" });
  // SEED-SHAPED, exactly as the client writes it: no `tier` (the router assigns one) and a
  // `deadlineAt`, which is what `currentCall` looks for. A tiered call is not a seed and the turn
  // worker will not resume from it.
  await aliceC.put({
    kind: "llm_call",
    body: { conversationId: conv2.id, owner: alice, upToIndex: t2.upToIndex, turnAt: t2.upToIndex, round: 0, tools: [] },
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    parentIds: [conv2.id],
  });

  const done = await awaitOne({ kind: "message", match: { conversationId: conv2.id, role: "assistant", round: 1 } }, 200);
  check("the turn completed a second round, so the whole chain ran", done !== null);
  check("the TOOL saw plaintext arguments", toolSaw === "/etc/secret", String(toolSaw));

  const calls = await admin.query({ kind: "tool_call", match: { conversationId: conv2.id } }, 5);
  check("the tool_call is marked and carries no plaintext argument", calls.length > 0 &&
    calls.every((r) => (r.body as { enc?: string }).enc === "v1") &&
    !JSON.stringify(calls.map((r) => r.body)).includes("/etc/secret"));

  const all = await admin.query({ kind: "message", match: { conversationId: conv2.id } }, 20);
  const dump = JSON.stringify(all.map((r) => r.body));
  check("…and neither the tool's output nor its arguments are in the transcript",
    !dump.includes("SECRET-OUTPUT") && !dump.includes("/etc/secret"));
  check("…while the tool call's ROUTING stayed readable, which is what let the turn worker route it",
    dump.includes("call_x") && dump.includes("peek"));
  if (done) {
    check("the model was shown the tool's output, so the round trip decrypted both ways",
      (await openBody(done.body as Record<string, unknown>, "message", dek2!)).content === "saw the tool output");
  }
} finally {
  toolStop.abort();
  await toolWorker.catch(() => {});
  for (const w of chainWorkers) {
    w.kill();
    await w.status;
  }
  await fake2.shutdown();
}

// ---- a SECOND MACHINE for the same person ----
//
// The property this exists to prove: Alice reads her own conversation from a machine that was not
// involved in creating it, without copying a file. Her desktop publishes its own public key; the
// laptop, which can already read, extends the conversation to it.

{
  const desktop = await newFleetKeyPair();
  await publishPersonKey(aliceC, alice, desktop);
  check("a second machine publishes its own public key", (await livePersonKeys(aliceC, alice)).length === 2);

  // Not yet: publishing does not retroactively open anything, and this must be true or the wrap
  // would be doing nothing.
  const early = await conversationKeys(aliceC, asAlice(desktop))(conv.id).then(() => "opened", (e) => e.constructor.name);
  check("…which does not by itself open a conversation sealed before it", early === "NoConversationKeyError", String(early));

  // The LAPTOP opens the conversation with enrolment on, which is what a real session does.
  await conversationKeys(aliceC, asAlice(laptop), alice)(conv.id);

  const nowOnDesktop = await conversationKeys(aliceC, asAlice(desktop))(conv.id).catch((e) => e);
  check("…and after the laptop next opens it, the desktop can read it too",
    nowOnDesktop !== undefined && !(nowOnDesktop instanceof Error), String(nowOnDesktop));
  check("…without re-encrypting anything: the transcript is untouched",
    (await admin.query({ kind: "message", match: { conversationId: conv.id } }, 20))
      .every((r) => (r.body as { enc?: string }).enc === "v1"));
  // Bob publishing a key of his own must not put him in her conversation.
  const bobDesktop = await newFleetKeyPair();
  await publishPersonKey(bobC, bob, bobDesktop).catch(() => {});
  const asBobKey = await conversationKeys(aliceC, { kind: "person", principal: bob, keyId: bobDesktop.keyId, privateKey: bobDesktop.privateKey })(conv.id)
    .then(() => "opened", (e) => e.constructor.name);
  check("…and enrolment is per PERSON: bob's machine is not one of hers", asBobKey === "NoConversationKeyError", String(asBobKey));
  check("…nor can he publish a key claiming to be her",
    await refused(() => bobC.put({ kind: "person_key", body: { principal: alice, keyId: "forged", publicKey: bobDesktop.publicKey } })));
}

// ---- phase 5: ERASURE by destroying the key ----
//
// The only deletion path a record body has. Bodies are immutable and permanent, which is why the
// erasure invariant pushes erasable data into artifacts; the wraps live in one, so shredding it
// destroys the sole copy of the key and every body it protected becomes permanently unreadable.
// What must SURVIVE is as much the point as what goes: the records, their lineage and the chain.

{
  const before = await admin.query({ kind: "message", match: { conversationId: conv.id } }, 20);
  const lineageBefore = await admin.getLineage(before[0].id).catch(() => null);

  // EVERY key artifact, not just the one the conversation started with. Enrolling the desktop wrote
  // a successor, so there are two, and both hold the same DEK — shredding one would leave the
  // conversation readable while the erasure looked done.
  const erased = await eraseConversation(admin, conv.id);
  check("erasure destroys every key artifact the conversation accumulated", erased.shredded.length === 2,
    `${erased.shredded.length} shredded`);
  // The reader-facing check below is NOT sufficient evidence on its own: it reads the newest key
  // record, so shredding only that one makes the conversation look erased while the DEK survives in
  // an earlier artifact. Enumerating them is what actually proves it.
  check("the original key artifact is gone", await aliceC.getArtifact(written.keys).then(() => false, () => true));
  // A FRESH resolver: the point is that nobody can open it any more, not that one cache went cold.
  const after = await conversationKeys(aliceC, asAlice(laptop))(conv.id)
    .then(() => null, (e) => e);
  check("…so the conversation is ERASED, named as that rather than as a failure", after instanceof ConversationErasedError, String(after));
  const asFleetNow = await conversationKeys(admin, { kind: "fleet", privateKey: fleet!.privateKey })(conv.id)
    .then(() => null, (e) => e);
  check("…for the FLEET too, which is what makes it an erasure and not a permission", asFleetNow instanceof ConversationErasedError);

  // The paper trail is the half that must not go.
  const still = await admin.query({ kind: "message", match: { conversationId: conv.id } }, 20);
  check("the records survive, with their ids and ordering", still.length === before.length &&
    still[0].id === before[0].id);
  check("…and their lineage still walks", JSON.stringify(await admin.getLineage(before[0].id).catch(() => null)) === JSON.stringify(lineageBefore));
  check("…and the space still verifies, so an erasure is not tampering", (await admin.integrity()).ok);
  // Reported as an erasure, by whatever field the ops plane names it with: what matters is that the
  // shredded artifact appears, so `radia erasures` and `radia doctor` can say this key is gone.
  const erasures = JSON.stringify(await admin.erasures());
  check("…and the erasure is reported on the ops plane", erasures.includes(written.keys), erasures.slice(0, 160));
  // Converges: erasing an already-erased conversation is success, not a fault.
  check("…and erasing twice is a no-op rather than an error",
    await eraseConversation(admin, conv.id).then(() => true, () => false));
}

console.log(`\n${failures === 0 ? "ok" : `${failures} FAILED`}`);
space.kill();
await space.status;
await Deno.remove(tmp, { recursive: true }).catch(() => {});
Deno.exit(failures === 0 ? 0 : 1);
