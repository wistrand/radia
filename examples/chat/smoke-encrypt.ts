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
import { NoConversationKeyError, openBody, openConversation, sealConversation } from "../../extensions/ts/encrypted.ts";

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
const { CONVERSATION_KEY_KIND, conversationKeys, currentFleetKey, fleetKeyPair, personKey, publishFleetKey } =
  await import("./space/keys.ts");

await registerChatKinds(admin);
const { inferenceToken } = await bootstrap(admin, {});
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
const aliceKey = personKey(url, alice);
const { encryption, key: sealedKey } = await sealConversation((await currentFleetKey(aliceC))!, { [alice]: aliceKey });
await aliceC.put(
  { kind: CONVERSATION_KEY_KIND, body: { conversationId: conv.id, owner: alice, ...encryption } },
  `conversation-key:${conv.id}`,
);
check("a session writes its own conversation's key material", true, conv.id);

// Her key is STABLE across sessions, or a later one could not read what this one wrote.
check("her person key is remembered", [...personKey(url, alice)].join() === [...aliceKey].join());

// ---- she reads it back, which is the whole point of a record over a client-side file ----
const back = await aliceC.readOne({ kind: CONVERSATION_KEY_KIND, match: { conversationId: conv.id } });
check("she fetches her key record", back !== null);
const hers = await openConversation(back!.body as never, { kind: "person", principal: alice, key: aliceKey });
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
const bobKey = personKey(url, bob);
let opened = false;
try {
  await openConversation(back!.body as never, { kind: "person", principal: bob, key: bobKey });
  opened = true;
} catch (e) {
  check("…and handed the record anyway, his key does not open it", e instanceof NoConversationKeyError, String(e));
}
check("…he never opens it", !opened);

// ---- the fleet opens it, because inference must ----
const asFleet = await openConversation(back!.body as never, { kind: "fleet", privateKey: fleet!.privateKey });
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
  const dek = await conversationKeys(aliceC, { kind: "person", principal: alice, key: aliceKey })(conv.id);
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

console.log(`\n${failures === 0 ? "ok" : `${failures} FAILED`}`);
space.kill();
await space.status;
await Deno.remove(tmp, { recursive: true }).catch(() => {});
Deno.exit(failures === 0 ? 0 : 1);
