// A LONG, awkward conversation: the shape that has actually broken this app.
//
//   deno run -A examples/chat/smoke-longthread.ts
//
// Every context bug so far came from the SHAPE of accumulated state rather than from a single bad
// call: a resumed thread with a second system message mid-conversation, a tool-heavy turn wider
// than the window, a reply whose call fell outside it. Those are cheap to construct as records and
// impossible to hit reliably by chatting, so this builds one deliberately unpleasant thread on a
// real space and checks the invariants at EVERY position in it.
//
// No API key: a message is a record, and the context path is a pure function over rows the space
// returns. What is exercised here is the real query (`orderBy index desc`, limited), the real
// window expansion, and the real assembly. Nothing here is a re-implementation.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { registerChatKinds } from "./space/kinds.ts";
import { assembleContext, selectWindow, type ThreadRow } from "./provider/context.ts";

const PORT = 7794;
const url = `http://127.0.0.1:${PORT}`;
const space = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT)],
  stdout: "null",
  stderr: "inherit",
}).spawn();

const client = new RadiaClient(url);
for (let i = 0; i < 100; i++) {
  try {
    await client.health();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
await registerChatKinds(client);

const check = (label: string, pass: boolean, detail = "") => console.log(`  ${pass ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);

const conv = (await client.put({ kind: "conversation", body: {} })).id;
let index = 0;
async function append(msg: Record<string, unknown>) {
  await client.put({ kind: "message", body: { conversationId: conv, index: index++, ...msg }, parentIds: [conv] });
}

// ---- build the awkward thread ----------------------------------------------------------------
await append({ role: "system", content: "original standing instructions" });

// Ordinary exchanges.
for (let t = 0; t < 12; t++) {
  await append({ role: "user", content: `question ${t}` });
  await append({ role: "assistant", content: `answer ${t}` });
}

// A TOOL-HEAVY turn: one assistant message calling six tools, then six replies. Wider than a small
// window on its own, which is what used to push the user's question out of view.
await append({ role: "user", content: "do the tool-heavy thing" });
await append({
  role: "assistant",
  content: null,
  tool_calls: Array.from({ length: 6 }, (_, i) => ({ id: `call_${i}`, function: { name: "list_files", arguments: "{}" } })),
});
for (let i = 0; i < 6; i++) await append({ role: "tool", tool_call_id: `call_${i}`, content: `{"files":${i}}` });
await append({ role: "assistant", content: "tool-heavy answer" });

// Odd entries, each one a shape that has to survive serialization and windowing.
await append({ role: "user", content: "" }); // empty content
await append({ role: "assistant", content: null }); // null content, no tool_calls
await append({ role: "user", content: "unicode: 🐨 → é ± 中文 control" });
await append({ role: "assistant", content: "x".repeat(20_000) }); // a very large message
await append({ role: "user", content: JSON.stringify({ looks: "like json", quote: '"' }) });

// A RESUME: fresh standing instructions land mid-thread, which is the shape no provider accepts
// in the body and which the assembly has to hoist.
await append({ role: "system", content: "current standing instructions (resumed)" });
for (let t = 0; t < 8; t++) {
  await append({ role: "user", content: `post-resume question ${t}` });
  await append({ role: "assistant", content: `post-resume answer ${t}` });
}
// A second resume, because "one extra system message" is not the general case.
await append({ role: "system", content: "newest standing instructions (resumed twice)" });
await append({ role: "user", content: "the current question" });

const total = index;
// Longer than the 40-message window, so windowing genuinely engages rather than the whole
// thread fitting and the interesting paths never running.
check("the thread is longer than the context window", total > 40, `${total} messages`);

// ---- the invariants, at EVERY position ---------------------------------------------------------
async function contextAt(upTo: number) {
  const tail = await selectWindow(
    async (limit) =>
      (await client.query({
        kind: "message",
        match: { conversationId: conv, index: { $lte: upTo } },
        orderBy: [{ path: "index", dir: "desc" }],
      }, limit)).map((r) => r.body as ThreadRow),
    { window: 40, cap: 400 },
  );
  const newestSystem = (await client.query({
    kind: "message",
    match: { conversationId: conv, role: "system", index: { $lte: upTo } },
    orderBy: [{ path: "index", dir: "desc" }],
  }, 1)).map((r) => r.body as ThreadRow)[0];
  return { ...assembleContext(newestSystem, tail), tail };
}

let badSystem = -1, orphanTool = -1, lostTurn = -1, staleSystem = -1;
for (let upTo = 0; upTo < total; upTo++) {
  const { messages, tail } = await contextAt(upTo);

  // 1. Exactly one system message, and it leads. Providers reject anything else.
  const systemsAt = messages.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
  if (!(systemsAt.length === 0 || (systemsAt.length === 1 && systemsAt[0] === 0)) && badSystem < 0) badSystem = upTo;

  // 2. No leading orphan tool reply: a `tool` message must answer a preceding `tool_calls`.
  const body = messages.filter((m) => m.role !== "system");
  if (body[0]?.role === "tool" && orphanTool < 0) orphanTool = upTo;

  // 3. The current turn survives windowing: if a user message exists at or below `upTo`, the
  //    window must contain one. This is the bug that made a tool-heavy turn answer the wrong
  //    question.
  const anyUserBelow = upTo >= 1;
  if (anyUserBelow && !tail.some((m) => m.role === "user") && tail.length > 0 && lostTurn < 0) lostTurn = upTo;

  // 4. The instructions in force are the NEWEST system message at or below this point.
  const head = messages[0];
  if (head?.role === "system" && upTo >= 58 && !String(head.content).includes("resumed twice") && staleSystem < 0) {
    staleSystem = upTo;
  }
}
check("system placement is valid at every position", badSystem < 0, badSystem < 0 ? "" : `first bad at ${badSystem}`);
check("no orphaned tool reply leads the body", orphanTool < 0, orphanTool < 0 ? "" : `first at ${orphanTool}`);
check("the current turn is never windowed out", lostTurn < 0, lostTurn < 0 ? "" : `first at ${lostTurn}`);
check("the newest instructions win after two resumes", staleSystem < 0, staleSystem < 0 ? "" : `first at ${staleSystem}`);

// ---- specific shapes -------------------------------------------------------------------------
const atEnd = await contextAt(total - 1);
check("the final question is in context", JSON.stringify(atEnd.messages).includes("the current question"));
check("older system messages are not in the body", !atEnd.messages.slice(1).some((m) => String(m.content).includes("original standing")));
check("the hidden-message notice is folded into the system message", String(atEnd.messages[0].content).includes("not included here"));

// A narrow window over the tool-heavy turn must still expand to the question that started it.
const toolTurnEnd = 32;
const narrow = await selectWindow(
  async (limit) =>
    (await client.query({
      kind: "message",
      match: { conversationId: conv, index: { $lte: toolTurnEnd } },
      orderBy: [{ path: "index", dir: "desc" }],
    }, limit)).map((r) => r.body as ThreadRow),
  { window: 4, cap: 400 }, // deliberately smaller than the turn
);
check("a window smaller than one turn expands to include it", narrow.some((m) => m.role === "user"), `${narrow.length} rows`);

// Odd payloads survive the round trip through records.
const odd = await client.query({ kind: "message", match: { conversationId: conv, role: "user" } }, 200);
const contents = odd.map((r) => String((r.body as ThreadRow).content ?? ""));
check("unicode survives storage", contents.some((c) => c.includes("🐨") && c.includes("中文")));
check("an empty message is kept, not dropped", contents.some((c) => c === ""));
const big = await client.query({ kind: "message", match: { conversationId: conv, role: "assistant" } }, 200);
check("a 20k message round-trips intact", big.some((r) => String((r.body as ThreadRow).content ?? "").length === 20_000));

// U+0000 is valid JSON and has no representation in Postgres `jsonb`, so it must be refused at the
// boundary rather than exploding inside the driver. It must also be refused identically on every
// adapter, which is the property that broke when a parsed body column arrived.
const nul = String.fromCharCode(0);
let nulRejected = "";
try {
  await client.put({ kind: "message", body: { conversationId: conv, index: 9999, role: "user", content: `a${nul}b` } });
} catch (e) {
  nulRejected = String(e);
}
check("a NUL in a body is refused, not a 500", nulRejected.includes("invalid_body"), nulRejected.slice(0, 72));
check("…and the literal text spelling that escape still stores", await (async () => {
  try {
    await client.put({ kind: "message", body: { conversationId: conv, index: 9998, role: "user", content: "a\\u0000b" } });
    return true;
  } catch {
    return false;
  }
})());

try {
  space.kill();
} catch { /* already gone */ }
Deno.exit(0);
