// What a scoped session may read, under both postures:
//
//   deno run -A examples/chat/smoke-scope.ts
//
// `RADIA_CHAT_SCOPE` picks what the session's grants bind to, and the two answers are genuinely
// different deployments rather than a preference:
//
//   identity     `{owner: agent:chat-user}`: everything this identity produced, across ALL its
//                conversations, INCLUDING the results and artifacts workers made for it.
//   conversation `{conversationId}`: this thread only, whoever produced the record.
//
// The case that forced the choice: conversation scoping is airtight and also hides your own earlier
// threads, which is not what "my records" means to the person who wrote them. Scoping by AUTHOR
// instead does not work. The results, chunks and artifacts are written by WORKERS under their own
// principals, so `createdBy: self` would hide the session's own tool output and the chat would hang
// waiting for results it could no longer read. Hence a field the session stamps and workers copy.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { bootstrap, CHAT_USER } from "./space/roles.ts";

const PORT = 7803;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const admin = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await admin.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
await registerChatKinds(admin);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// Two conversations for this identity, plus a third belonging to someone else.
const older = (await admin.put({ kind: "conversation", body: { title: "yesterday" } })).id;
const current = (await admin.put({ kind: "conversation", body: { title: "today" } })).id;
const theirs = (await admin.put({ kind: "conversation", body: { title: "someone else" } })).id;

// The identity's own history, as the session would have written it. That includes an OLDER thread,
// which is the thing conversation scoping takes away.
const myArtifacts: Record<string, string> = {};
for (const [conv, n] of [[older, 3], [current, 2]] as [string, number][]) {
  for (let i = 0; i < n; i++) {
    await admin.put({ kind: "message", body: { conversationId: conv, owner: CHAT_USER, index: i, role: "user", content: `m${i}` } });
  }
  // …and what a WORKER produced for it. These are the records `createdBy: self` would hide.
  await admin.put({ kind: "tool_result", body: { callId: `call-${conv}`, conversationId: conv, owner: CHAT_USER, ok: true, output: "ok" } });
  myArtifacts[conv] = (await admin.putArtifact(new TextEncoder().encode(`bytes for ${conv}`), {
    mediaType: "text/plain",
    meta: { conversationId: conv, owner: CHAT_USER },
  })).id;
}
// Another identity's work in the same space: an operator-role session and a different agent.
await admin.put({ kind: "message", body: { conversationId: theirs, owner: "agent:someone-else", index: 0, role: "user", content: "private" } });
await admin.put({ kind: "message", body: { conversationId: theirs, index: 0, role: "user", content: "operator, no owner" } });
await admin.put({ kind: "tool_result", body: { callId: "call-theirs", conversationId: theirs, owner: "agent:someone-else", ok: true, output: "private" } });
const theirArtifact = (await admin.putArtifact(new TextEncoder().encode("their bytes"), {
  mediaType: "text/plain",
  meta: { conversationId: theirs, owner: "agent:someone-else" },
})).id;

/** Artifacts are fetched by id (the session holds `read_one`, not `query`), the way the chat reads
 *  a generated image back. */
async function canRead(client: RadiaClient, id: string): Promise<boolean> {
  try {
    await client.getArtifact(id);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
console.log("\n  identity scope: everything this identity produced");
// ---------------------------------------------------------------------------
const idToken = (await bootstrap(admin, "user", { owner: CHAT_USER })).sessionToken!;
const byIdentity = new RadiaClient(url, { token: idToken });

const idMessages = await byIdentity.queryPage({ kind: "message" }, 50);
check(
  "sees its own messages from EVERY conversation it had, not just this one",
  idMessages.records.length === 5,
  `${idMessages.records.length} of 7 in the space`,
);
check(
  "…including the older thread, which is the whole point",
  idMessages.records.some((r) => (r.body as { conversationId: string }).conversationId === older),
);
check(
  "…and none belonging to another identity",
  !idMessages.records.some((r) => (r.body as { conversationId: string }).conversationId === theirs),
);
check("…and the answer says what narrowed it", JSON.stringify(idMessages.scope?.narrowedBy ?? []).includes(CHAT_USER));

// The records a worker wrote FOR this identity: the ones author-scoping would have lost.
const mineResult = await byIdentity.readOne({ kind: "tool_result", match: { callId: `call-${older}` } });
check("reads results a WORKER produced for it, in an older conversation", mineResult !== null);
const theirResult = await byIdentity.readOne({ kind: "tool_result", match: { callId: "call-theirs" } });
check("…but not another identity's results", theirResult === null);

check("reads its own artifact from an older conversation", await canRead(byIdentity, myArtifacts[older]));
check("…and from this one", await canRead(byIdentity, myArtifacts[current]));
check("…but not another identity's", !(await canRead(byIdentity, theirArtifact)));

// The binding is enforced on WRITES too, so `owner` cannot be claimed. It is not an honour system.
let forged = true;
try {
  await byIdentity.put({ kind: "message", body: { conversationId: current, owner: "agent:someone-else", index: 99, role: "user", content: "forged" } });
} catch {
  forged = false;
}
check("cannot stamp another identity's owner on a write", !forged);

let unowned = true;
try {
  await byIdentity.put({ kind: "message", body: { conversationId: current, index: 98, role: "user", content: "no owner" } });
} catch {
  unowned = false;
}
check("…nor omit it to escape the scope", !unowned);

// ---------------------------------------------------------------------------
console.log("\n  conversation scope: this thread only, whoever produced it");
// ---------------------------------------------------------------------------
const convToken = (await bootstrap(admin, "user", { conversationId: current })).sessionToken!;
const byConversation = new RadiaClient(url, { token: convToken });

const convMessages = await byConversation.queryPage({ kind: "message" }, 50);
check("sees only this conversation", convMessages.records.length === 2, `${convMessages.records.length} of 7`);
check(
  "…so its own older thread is NOT visible, which is the cost of the strict posture",
  !convMessages.records.some((r) => (r.body as { conversationId: string }).conversationId === older),
);
check(
  "…and its results are this conversation's",
  (await byConversation.readOne({ kind: "tool_result", match: { callId: `call-${current}` } })) !== null,
);
check(
  "…while the older conversation's are not",
  (await byConversation.readOne({ kind: "tool_result", match: { callId: `call-${older}` } })) === null,
);
check("…and this answer names its constraint too", JSON.stringify(convMessages.scope?.narrowedBy ?? []).includes(current));
check("…and an artifact from the older thread is out of reach", !(await canRead(byConversation, myArtifacts[older])));
check("…while this thread's is not", await canRead(byConversation, myArtifacts[current]));

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
