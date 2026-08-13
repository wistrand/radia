// JOIN MODE: a session that holds no operator credential at all.
//
// The property under test is the one that makes a fleet shareable — setup and session are separate
// jobs, and only the first is privileged. Until this split, opening the chat meant holding the
// control plane, so "N users" meant N operators (agent_docs/plan-scaling.md item 3).
//
// What a joining session must be able to do: start its own thread, learn who it is, see the fleet's
// advertisements, and take a turn. What it must NOT be able to do: register kinds, mint a worker,
// assign itself a grant, or enumerate anyone else's conversations. Both halves are asserted, and
// the second half is the reason the first is safe.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assignUserGrants, bootstrap, mintSession } from "./space/roles.ts";

const PORT = 7807;
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
const forbidden = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (e) {
    return /forbidden|requires an operator|401|403/.test(String(e));
  }
};

console.log("── join ────────────────────────────────────────────────────────");
console.log("   a session with NO operator credential: what it can do, and what it must not\n");

// ---- the DEPLOYMENT half, once, by somebody holding the operator credential ----
const admin = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(admin);
await bootstrap(admin, {});
const owner = "human:joiner";
await assignUserGrants(admin, owner, { owner });

// ---- the SESSION half: this is all a joining process gets ----
const session = new RadiaClient(url, { token: await mintSession(admin, owner, { owner }) });

check("the session is not privileged", !(await session.permissions(owner) as { privileged: boolean }).privileged);
check(
  "…and reads its OWN permissions without an operator, which is how join mode learns who it is",
  ((await session.permissions(owner) as { kinds: unknown[] }).kinds.length) > 0,
);

// It creates its own thread. No operator is present to make one for it.
const conv = await session.put({ kind: "conversation", body: {} });
check("it starts its own conversation", typeof conv.id === "string" && conv.id.length > 0, conv.id);

// And it can see what the fleet advertises, which is how the tool list is built.
check("it can read the capability registry", Array.isArray(await session.query({ kind: "capability" }, 5)));

// ---- what it must NOT be able to do ----
check(
  "it cannot ENUMERATE conversations, which is why `put` alone is safe",
  await forbidden(() => session.query({ kind: "conversation" }, 10)),
);
check(
  "it cannot register a kind",
  await forbidden(() => session.put({ kind: "kind_def", body: { kind: "sneaky", indexedPaths: [] } })),
);
check(
  "it cannot mint a worker definition",
  await forbidden(() => session.createAgentDefinition("agent:mine", [])),
);
check(
  "it cannot grant itself anything",
  await forbidden(() => session.put({ kind: "grant", body: { principal: owner, kind: "workspace", operations: ["query"] } })),
);
check(
  "it cannot reach the ops plane",
  await forbidden(() => session.getStats()),
);
check(
  "it cannot sweep the space",
  await forbidden(() => session.gc()),
);

// ---- and the turn traffic it exists for still works ----
await session.put({ kind: "message", body: { conversationId: conv.id, owner, index: 0, role: "user", content: "hi" } });
const mine = await session.query({ kind: "message", match: { conversationId: conv.id } }, 10);
check("it writes and reads its own conversation", mine.length === 1, `${mine.length} message`);

// A second person's records stay invisible, which is what the grant pattern is for.
const other = "human:someone-else";
await assignUserGrants(admin, other, { owner: other });
const otherSession = new RadiaClient(url, { token: await mintSession(admin, other, { owner: other }) });
await otherSession.put({ kind: "message", body: { conversationId: conv.id, owner: other, index: 0, role: "user", content: "theirs" } });
check(
  "two joined sessions on one space read only their own records",
  (await session.query({ kind: "message", match: { conversationId: conv.id } }, 10)).length === 1,
);

console.log(`\n${failures === 0 ? "ok" : `FAILED (${failures})`}\n`);
try {
  space.kill();
} catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 100));
Deno.exit(failures === 0 ? 0 : 1);
