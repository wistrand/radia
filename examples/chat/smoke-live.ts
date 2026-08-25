// TWO CLIENTS ON ONE CONVERSATION: what each of them sees, and what neither of them writes.
//
// A conversation is records, so nothing about it belongs to the client that wrote them. Until the
// live view (client/live.ts) that was true and invisible: `runTurn` follows the call IT seeded, and
// nothing looked for messages this client did not write, so a second tab or a second terminal on one
// thread showed each other nothing (agent_docs/plan-chat-web-ui.md phase 3).
//
// Three properties, all record-level and none needing a model:
//
//   1. a live view renders what ANOTHER client said, and never re-renders what the local one did
//   2. attaching as a VIEWER writes nothing (a system message is a write, and `resume` appends one)
//   3. `findOpenTurn` finds a turn still running, and refuses every way one is over
//   4. two clients appending at once take DIFFERENT slots, so two turns cannot share an identity
//
// The third is the load-bearing one: following a finished turn means waiting out the inference
// deadline in silence and then reporting a timeout that never happened.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../operator.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { Thread } from "./client/thread.ts";
import { findOpenTurn } from "./client/turn.ts";
import { liveView } from "./client/live.ts";
import { installUI } from "./client/ui.ts";
import { __captureOutput, terminalUI } from "./client/terminal.ts";
import { setSessionOwner } from "./space/roles.ts";

installUI(terminalUI);

const PORT = 7827;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("── live ────────────────────────────────────────────────────────");
console.log("   two clients on one conversation: what each sees, and what a viewer must not write\n");

const client = new RadiaClient(url, { token: operatorToken(url) });
await registerChatKinds(client);
setSessionOwner("human:a");

const conversationId = (await client.put({ kind: "conversation", body: {} })).id;
const threadA = await Thread.open(client, { principal: "human:a", privileged: true }, conversationId);
await threadA.append({ role: "user", content: "first, from A" });

// ---- 2. a viewer writes nothing ----
//
// Checked BEFORE anything else writes, so the count is unambiguous.
{
  const before = (await client.queryOldest({ kind: "message", match: { conversationId } }, 100)).length;
  const viewer = await Thread.attach(client, conversationId);
  const after = (await client.queryOldest({ kind: "message", match: { conversationId } }, 100)).length;
  check("attaching as a viewer writes nothing", after === before, `${before} -> ${after}`);
  check("and still recovers the cursor", viewer.upToIndex === threadA.upToIndex, `${viewer.upToIndex} vs ${threadA.upToIndex}`);

  const resumed = await Thread.resume(client, conversationId, { principal: "human:b", privileged: false });
  const afterResume = (await client.queryOldest({ kind: "message", match: { conversationId } }, 100)).length;
  check("while RESUMING takes the thread up (a system message)", afterResume === after + 1, `${after} -> ${afterResume}`);
  check("and resume leaves the cursor past it", resumed.upToIndex === after, String(resumed.upToIndex));
}

// ---- 1. the live view ----
{
  const cap = __captureOutput();
  const stop = new AbortController();
  // A VIEWER's watermark: everything already said is accounted for, nothing after it is.
  const viewer = await Thread.attach(client, conversationId);
  let busy = false;
  const live = liveView({
    client,
    conversationId,
    accountedFor: () => viewer.upToIndex,
    busy: () => busy,
    patterns: [], // the tick alone, which is what a browser has
    pollMs: 1000,
    signal: stop.signal,
  });

  await sleep(300);
  check("nothing already on screen is re-rendered", !cap.text().includes("first, from A"), cap.text().trim().slice(0, 60));

  // Somebody else speaks.
  setSessionOwner("human:b");
  const threadB = await Thread.attach(client, conversationId);
  await threadB.append({ role: "user", content: "second, from B" });

  for (let i = 0; i < 40 && !cap.text().includes("second, from B"); i++) await sleep(100);
  check("a message from another client is rendered", cap.text().includes("second, from B"));
  check("and it is attributed to whoever wrote it", cap.text().includes("human:b"), cap.text().trim().split("\n").pop() ?? "");

  // Held while the local client is mid-turn: an answer must not have somebody else's question
  // spliced into it.
  busy = true;
  await threadB.append({ role: "user", content: "third, while busy" });
  await sleep(1500);
  check("a message arriving mid-turn waits", !cap.text().includes("third, while busy"));
  busy = false;
  for (let i = 0; i < 40 && !cap.text().includes("third, while busy"); i++) await sleep(100);
  check("and lands once the turn ends", cap.text().includes("third, while busy"));

  stop.abort();
  await live.catch(() => {});
  cap.stop();
}

// ---- 4. two writers on one conversation ----
//
// The collision that mattered was never the display order: `turnAt` IS the index a turn started at,
// so two clients appending at one index gave two turns one identity, and the workers addressing
// `{turnAt, round, role}` could answer with each other's records. `append` claims its slot with an
// idempotency key, so one writer wins and the other takes the next one (client/thread.ts).
{
  const a = await Thread.attach(client, conversationId);
  const b = await Thread.attach(client, conversationId);
  check("both clients agree where the transcript ends", a.upToIndex === b.upToIndex, `${a.upToIndex} vs ${b.upToIndex}`);

  // Sent at the same moment from the same cursor: exactly the race two tabs produce.
  const [idA, idB] = await Promise.all([
    a.append({ role: "user", content: "from A" }),
    b.append({ role: "user", content: "from B" }),
  ]);
  check("both messages are written", idA !== idB && !!idA && !!idB);
  check("…at DIFFERENT slots", a.upToIndex !== b.upToIndex, `${a.upToIndex} vs ${b.upToIndex}`);

  const rows = await client.queryOrdered({ kind: "message", match: { conversationId, role: "user" }, orderBy: [{ path: "index" }] }, 50);
  const texts = rows.map((r) => (r.body as { content?: string }).content);
  check("…and both survive in the transcript", texts.includes("from A") && texts.includes("from B"), texts.join(" | "));
  const indices = rows.map((r) => (r.body as { index?: number }).index);
  check("…with no index used twice", new Set(indices).size === indices.length, indices.join(","));

  // The turn's identity follows the slot, which is the whole point: two turns started at once can
  // no longer address each other's rounds.
  check("two turns started now would not share a turnAt", a.upToIndex !== b.upToIndex);

  // THE LIMIT, tested so it is known rather than discovered: the same words at the same slot are
  // one request under one key, so the runtime replays rather than refusing, and both clients hold
  // the same record.
  const c = await Thread.attach(client, conversationId);
  const d = await Thread.attach(client, conversationId);
  const [idC, idD] = await Promise.all([
    c.append({ role: "user", content: "identical" }),
    d.append({ role: "user", content: "identical" }),
  ]);
  check("an identical message at one slot is deduped, not doubled", idC === idD, `${idC} vs ${idD}`);
}

// ---- 3. findOpenTurn ----
//
// One conversation per case: each is a different way a turn ends, and they must not interfere.
{
  const seed = async (extra: Record<string, unknown> = {}) => {
    const id = (await client.put({ kind: "conversation", body: {} })).id;
    const call = await client.put({
      kind: "llm_call",
      body: { conversationId: id, owner: "human:a", upToIndex: 0, turnAt: 0, round: 0, ...extra },
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return { id, callId: call.id };
  };

  check("no call at all is not an open turn", (await findOpenTurn(client, (await client.put({ kind: "conversation", body: {} })).id)) === null);

  const unanswered = await seed();
  const open = await findOpenTurn(client, unanswered.id);
  check("an unanswered call is an open turn", open?.callId === unanswered.callId && open?.turnAt === 0, JSON.stringify(open));

  const withTools = await seed();
  await client.put({
    kind: "message",
    body: {
      conversationId: withTools.id,
      owner: "human:a",
      index: 1,
      role: "assistant",
      callId: withTools.callId,
      turnAt: 0,
      round: 0,
      tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }],
    },
  });
  check("answered WITH tool calls is still open", (await findOpenTurn(client, withTools.id))?.callId === withTools.callId);

  const answered = await seed();
  await client.put({
    kind: "message",
    body: { conversationId: answered.id, owner: "human:a", index: 1, role: "assistant", callId: answered.callId, turnAt: 0, round: 0, content: "done" },
  });
  check("a final answer ends the turn", (await findOpenTurn(client, answered.id)) === null);

  const complete = await seed();
  await client.put({ kind: "turn_complete", body: { conversationId: complete.id, owner: "human:a", turnAt: 0 } });
  check("a turn_complete ends it", (await findOpenTurn(client, complete.id)) === null);

  const cancelled = await seed();
  await client.put({ kind: "cancel", body: { conversationId: cancelled.id, owner: "human:a", turnAt: 0 } });
  check("a cancel ends it", (await findOpenTurn(client, cancelled.id)) === null);

  // A turn whose deadline passed: the worker resumes one only while it is in the future, so this
  // is the same test the worker applies, against the same field.
  const stale = (await client.put({ kind: "conversation", body: {} })).id;
  await client.put({
    kind: "llm_call",
    body: { conversationId: stale, owner: "human:a", upToIndex: 0, turnAt: 0, round: 0 },
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
  });
  check("a passed deadline ends it", (await findOpenTurn(client, stale)) === null);

  // The router re-dispatches under a TIERED call; the client follows the untiered one it can see.
  const routed = await seed();
  await client.put({
    kind: "llm_call",
    body: { conversationId: routed.id, owner: "human:a", upToIndex: 0, turnAt: 0, round: 0, tier: "fast", replyTo: routed.callId },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  check("a re-dispatched call still resolves to the untiered one", (await findOpenTurn(client, routed.id))?.callId === routed.callId);
}

console.log(`\n  ${failures === 0 ? "live: all checks passed" : `live: ${failures} failed`}`);
try {
  space.kill();
} catch { /* already gone */ }
await space.status;
Deno.exit(failures === 0 ? 0 : 1);
