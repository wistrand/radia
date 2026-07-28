// Who the session IS, when a person brings their own credential:
//
//   deno run -A examples/chat/smoke-login.ts
//
// Without a login token every chat session is `agent:chat-user`, a constant in `roles.ts`. That is
// fine for one person on a laptop and wrong the moment two people share a space: they are the same
// principal, so identity scope cannot separate them and each reads the other's threads.
//
// `radia login human:alice` mints a real per-person credential, and `RADIA_CHAT_TOKEN` hands it to
// the chat. What this suite pins down is the part that is easy to get wrong: the chat must learn
// who the token belongs to from the SPACE, never from anything the caller says, and the operator
// must be the one assigning that person's grants.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assignUserGrants, CHAT_USER, setSessionOwner } from "./space/roles.ts";
import { Thread } from "./client/thread.ts";

const PORT = 7808;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
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

/** What `radia login <principal>` does: a definition that mints runs for a human, then one run. */
async function login(principal: string): Promise<string> {
  const { definitionToken } = await admin.createAgentDefinition(principal, []);
  const { runToken } = await admin.createRun(definitionToken);
  return runToken;
}

/** What chat.ts does with `RADIA_CHAT_TOKEN`: resolve the identity, then scope and grant to it. */
async function startSession(token: string): Promise<{ client: RadiaClient; owner: string; privileged: boolean }> {
  const who = (await new RadiaClient(url, { token }).health()).principal;
  const perms = await admin.permissions(who) as { subject: string; privileged: boolean };
  await assignUserGrants(admin, perms.subject, { owner: perms.subject });
  return { client: new RadiaClient(url, { token }), owner: perms.subject, privileged: perms.privileged };
}

const conv = (await admin.put({ kind: "conversation", body: { title: "shared space" } })).id;

// ── identity resolution ──────────────────────────────────────────────────────────────────────────
const aliceToken = await login("human:alice");
const alice = await startSession(aliceToken);
check("a login token resolves to the person it was minted for", alice.owner === "human:alice", alice.owner);
check("…and that person is not privileged", !alice.privileged);
check("…and is not the shared default principal", alice.owner !== CHAT_USER);

// The token names a RUN, not the human. The chat must map it back through the space, because the
// run id is what a scoped read reports and what a grant would otherwise be assigned to.
const aliceRun = (await new RadiaClient(url, { token: aliceToken }).health()).principal;
check("the credential is a run, resolved to its subject by the space", aliceRun !== alice.owner && aliceRun.startsWith("run:"), aliceRun);

// ── two people, one space ────────────────────────────────────────────────────────────────────────
const bob = await startSession(await login("human:bob"));
check("a second login is a different principal", bob.owner === "human:bob", bob.owner);

await alice.client.put({ kind: "message", body: { conversationId: conv, owner: alice.owner, index: 1, role: "user", content: "from alice" } });
await bob.client.put({ kind: "message", body: { conversationId: conv, owner: bob.owner, index: 2, role: "user", content: "from bob" } });

const aSees = (await alice.client.query({ kind: "message" }, 50)).map((r) => (r.body as { content: string }).content);
const bSees = (await bob.client.query({ kind: "message" }, 50)).map((r) => (r.body as { content: string }).content);
check("alice reads her own message", aSees.includes("from alice"));
check("…and not bob's, in the SAME conversation", !aSees.includes("from bob"), aSees.join(","));
check("bob reads his own message", bSees.includes("from bob"));
check("…and not alice's", !bSees.includes("from alice"), bSees.join(","));
check("the operator sees both", (await admin.query({ kind: "message" }, 50)).length === 2);

// ── the grant is the enforcement, not the stamp ──────────────────────────────────────────────────
// The session stamps `owner` on what it writes, and the grant pattern is matched against the write
// body. So claiming someone else's identity is refused by the runtime, not by client-side care.
let forged = "wrote it";
try {
  await alice.client.put({ kind: "message", body: { conversationId: conv, owner: bob.owner, index: 3, role: "user", content: "impersonation" } });
} catch (e) {
  forged = (e as Error).message;
}
check("alice cannot write a record stamped as bob", forged !== "wrote it", forged);

// A login token brings a credential, never authority: the grants are the operator's to assign.
let escalated = "granted";
try {
  await alice.client.grant("human:alice", "grant", ["put", "query"]);
} catch (e) {
  escalated = (e as Error).message;
}
check("a logged-in session cannot grant itself anything", escalated !== "granted", escalated);

// ── re-login is idempotent ───────────────────────────────────────────────────────────────────────
// Grants are content-keyed, so a person opening a second chat window must not append a duplicate
// grant per kind. Unbounded registry growth is what makes bounded reads dangerous.
const countGrants = async () => (await admin.queryAll({ kind: "grant", match: { principal: "human:alice" } })).length;
const before = await countGrants();
await startSession(await login("human:alice"));
const after = await countGrants();
check("logging in again assigns no duplicate grants", before === after && before > 0, `${before} then ${after}`);

// ── the assistant is told who it is ──────────────────────────────────────────────────────────────
// The prompt may carry the agent's own IDENTITY (that is the documented exception to "discover,
// don't hardcode"), which only helps if it is the real one. It named the `agent:chat-user` constant
// while the session ran as a person, so "whoami" answered from this file rather than from the space.
const aliceConv = (await admin.put({ kind: "conversation", body: { title: "prompt" } })).id;
// What chat.ts does before opening the thread. Without it the writer stamps the default owner and
// the grant pattern refuses the write, which is the enforcement working: the stamp and the scope
// are the same value or nothing is written at all.
setSessionOwner(alice.owner);
const t = await Thread.open(alice.client, { principal: alice.owner, privileged: alice.privileged }, aliceConv);
const sys = (await admin.query({ kind: "message", match: { conversationId: t.id, role: "system" } }, 1))
  .map((r) => (r.body as { content: string }).content)[0] ?? "";
check("the system prompt names the session's real principal", sys.includes(alice.owner), alice.owner);
check("…and not the shared constant it used to hardcode", !sys.includes(CHAT_USER), CHAT_USER);
check("…and says the session is scoped, not an operator", /SCOPED/.test(sys) && !/OPERATOR/.test(sys));

// ── no token: the shared default is unchanged ────────────────────────────────────────────────────
// The login path is additive. A chat run without RADIA_CHAT_TOKEN still gets `agent:chat-user`, so
// nothing about the single-person setup moved.
check("the default owner is still the shared principal", CHAT_USER === "agent:chat-user");

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
