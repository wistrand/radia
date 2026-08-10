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
import { operatorToken } from "../operator.ts";
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

const probe = new RadiaClient(url); // liveness only: /v0/health is public
let admin: RadiaClient;
for (let i = 0; i < 100; i++) {
  try {
    await probe.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
admin = new RadiaClient(url, { token: operatorToken(url) });
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

// ── identity scope: the escalation path and the session's own files ──────────────────────────────
// Both of these were broken under `{owner}` scope and worked under `{conversationId}`, which is the
// only shape the selfgrant suite covers. The default is `{owner}`.
const idOwner = alice.owner;
const idConv = (await admin.put({ kind: "conversation", body: { title: "identity" } })).id;
await assignUserGrants(admin, idOwner, { owner: idOwner });

// 1. `request_grant` must be WRITABLE. It stamps `owner` from the tool_call it is serving, because
// the tools-worker is a different PROCESS: the module-level `sessionOwner()` the REPL sets is still
// the default there, so stamping it wrote `agent:chat-user` against a `{owner: human:alice}`
// pattern and the write was refused. That killed the one escalation path the prompt tells the model
// to use, and the model reported it as its own request being restricted.
let asked = "wrote it";
try {
  await alice.client.put({
    kind: "grant_request",
    body: { conversationId: idConv, owner: idOwner, kind: "kind_def", operations: ["query"], why: "list kinds", scope: "own" },
  });
} catch (e) {
  asked = (e as Error).message;
}
check("a session under identity scope can write a grant_request", asked === "wrote it", asked);

// Stamping the WRONG owner is still refused; the fix is taking the value from the call, not
// loosening the pattern.
let forged2 = "wrote it";
try {
  await alice.client.put({
    kind: "grant_request",
    body: { conversationId: idConv, owner: CHAT_USER, kind: "kind_def", operations: ["query"], why: "x", scope: "own" },
  });
} catch (e) {
  forged2 = (e as Error).message;
}
check("…but not one stamped with a different owner", forged2 !== "wrote it", forged2);

// 2. "Which artifacts do I have?" The session could fetch an id it already knew and could not
// DISCOVER one, so it asked a human to widen a grant to see its own files.
const art = await admin.putArtifact(new TextEncoder().encode("<h1>mine</h1>"), {
  mediaType: "text/html",
  filename: "mine.html",
  meta: { conversationId: idConv, owner: idOwner },
});
await admin.putArtifact(new TextEncoder().encode("<h1>theirs</h1>"), {
  mediaType: "text/html",
  filename: "theirs.html",
  meta: { conversationId: idConv, owner: "human:bob" },
});
const listed = await alice.client.query({ kind: "artifact" }, 50);
check("a session can LIST its own artifacts", listed.some((r) => r.id === art.id), `${listed.length} visible`);
check("…and only its own", listed.every((r) => (r.body as { owner?: string }).owner === idOwner), listed.map((r) => (r.body as { owner?: string }).owner).join(","));

// 2b. ATTACHING a file (Ctrl-V at the prompt) is the session writing bytes under its own name. The
// grant that allows it is pattern-scoped, and a scope on a WRITE is checked against the body, so the
// stamp is not bookkeeping: it is the thing that decides whether the write happens at all.
const attached = await alice.client.putArtifact(new TextEncoder().encode("pretend PNG"), {
  mediaType: "image/png",
  filename: "pasted.png",
  meta: { conversationId: idConv, owner: idOwner },
  taint: ["file"],
});
check("a session can attach a file of its own", Boolean(attached.id), attached.id);
let forgedAttach = "stored it";
try {
  await alice.client.putArtifact(new TextEncoder().encode("not mine"), {
    mediaType: "image/png",
    filename: "theirs.png",
    meta: { conversationId: idConv, owner: "human:bob" },
  });
} catch (e) {
  forgedAttach = (e as Error).message;
}
check("…and cannot attach one stamped with someone else's owner", forgedAttach !== "stored it", forgedAttach);

// 3. The structural guard. The bug above is not visible at any one call site: `sessionOwner()` reads
// correctly and returns the wrong value only because of which PROCESS the code is in. So assert the
// separation instead of the symptom. Anything the tools-worker loads must take identity from the
// call it is serving.
// The space tools moved to `extensions/ts/agent-tools.ts`, where this property is now structural
// rather than checked: `conformance/layering.test.ts` bars an extension from importing an example at
// all, so it cannot reach `roles.ts`. The app-side files still need the check.
const workerSide = ["tools/save.ts", "tools/files.ts", "workers/tools.ts", "workers/exec.ts"];
for (const f of workerSide) {
  const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
  // The IMPORT, not the word: the fix is documented in a comment that names it, and prose is not a
  // dependency. Reading it requires importing it.
  const imports = [...src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["'][^"']*roles\.ts["']/gm)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim()));
  check(`${f} does not import the REPL's session state`, !imports.includes("sessionOwner"), imports.join(" "));
}

// ── no token: the chat refuses to start ──────────────────────────────────────────────────────────
// There is no default identity any more. The chat used to fall back to the shared `agent:chat-user`
// or, with no credential at all, to the space's open-mode operator, which made the identity of a
// session a property of how the process was launched rather than of who was using it.
const noToken = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "examples/chat/chat.ts"],
  env: { OPENROUTER_API_KEY: "dummy", RADIA_CHAT_DIRS: "examples/chat/sandbox", RADIA_URL: url },
  clearEnv: true,
  stdout: "piped",
  stderr: "piped",
  stdin: "null",
});
const out = await noToken.output();
const said = new TextDecoder().decode(out.stderr);
check("the chat exits non-zero with no session token", out.code !== 0, `exit ${out.code}`);
check("…and names the variable to set", /RADIA_CHAT_TOKEN/.test(said));
check("…and how to mint one", /radia login/.test(said));
check("…and says there is no default identity", /no default identity/i.test(said), said.split("\n")[0]);
check("…and never reached the space", CHAT_USER === "agent:chat-user"); // the constant survives, unused as a fallback

space.kill();
await space.status;
console.log(failed === 0 ? "\nok" : `\nFAILED (${failed})`);
Deno.exit(failed === 0 ? 0 : 1);
