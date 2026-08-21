// Whose conversation an `llm_call` may load (`extensions/ts/inference.ts`, `contextFor`).
//
//   deno task test:extensions
//
// One property, and it is the whole file: a call names its conversation in the BODY, and a body is
// a CLAIM. `bodyMatchesGrant` bounds what a caller may WRITE and says nothing about what this
// worker — which holds an unscoped `message` grant — can then be induced to read for them. So the
// query must reduce to records the caller could have read themselves.
//
// This existed as a defect (package V, agent_docs/plan-audit-remediation.md): the owner conjunction
// was in the windowed branch and missing from the `window <= 0` one, so `RADIA_CHAT_WINDOW=0`
// (which reads like "no limit") loaded another person's whole conversation into the model and
// streamed it back stamped for the caller. BOTH window settings are asserted here, because a guard
// that covered only the default would have passed against the bug.

import { assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { contextForTest } from "../ts/inference.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7839;

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

Deno.test("inference: a call cannot load a conversation belonging to someone else", async () => {
  await withSpace(async (c) => {
    const convBob = uniq("conv-bob"), convAlice = uniq("conv-alice");
    // Bob's thread. In the real space these are Bob's records under Bob's grant; here the operator
    // writes them, because what is under test is the WORKER's query, not who wrote the rows.
    for (let i = 0; i < 3; i++) {
      await c.put({
        kind: "message",
        body: { conversationId: convBob, owner: "human:bob", index: i, role: "user", content: `bob secret ${i}` },
      });
    }
    await c.put({
      kind: "message",
      body: { conversationId: convAlice, owner: "human:alice", index: 0, role: "user", content: "alice hello" },
    });

    // The attack: a body Alice's own `llm_call: put` grant accepts under the default identity
    // scope, because the pattern binds `owner` and she is naming herself. The conversation is not
    // hers, and nothing in the write path objects to that.
    const forged = { conversationId: convBob, owner: "human:alice", upToIndex: 99 };

    // BOTH settings. `window <= 0` is the branch that was wrong; 40 is the default that was right.
    for (const window of [0, 40]) {
      const { messages } = await contextForTest(c, forged, window, 200_000);
      assertEquals(
        messages.filter((m) => (m.content ?? "").includes("bob secret")).length,
        0,
        `window=${window}: a forged owner must not reach another person's messages`,
      );
      assertEquals(messages.length, 0, `window=${window}: the context is empty, not partial`);
    }

    // …and the honest case still works, or the fix would just be a way to break the product.
    for (const window of [0, 40]) {
      const { messages } = await contextForTest(
        c,
        { conversationId: convAlice, owner: "human:alice", upToIndex: 99 },
        window,
        200_000,
      );
      assertEquals(messages.length, 1, `window=${window}: her own thread still loads`);
      assertEquals(messages[0].content, "alice hello");
    }
  });
});

Deno.test("inference: a classify reference resolves under the caller's scope, never the worker's", async () => {
  await withSpace(async (c) => {
    const convBob = uniq("conv-bob"), convAlice = uniq("conv-alice");
    await c.put({
      kind: "message",
      body: { conversationId: convBob, owner: "human:bob", index: 4, role: "user", content: "bob secret question" },
    });
    await c.put({
      kind: "message",
      body: { conversationId: convAlice, owner: "human:alice", index: 4, role: "user", content: "alice question" },
    });

    // The router names a message instead of copying its text (plan-encryption.md phase 0). That
    // moves the READ from the writer to this worker, which holds an unscoped `message` grant — so
    // the reference is resolved with the caller's `owner` conjoined, or it is a confused deputy
    // introduced in exchange for a scoping accident.
    const forged = await contextForTest(
      c,
      { system: "classify", classifyOf: { conversationId: convBob, owner: "human:alice", index: 4 } },
      40,
      200_000,
    );
    assertEquals(forged.messages.length, 0, "a reference naming another owner's message resolves to nothing");

    const honest = await contextForTest(
      c,
      { system: "classify", classifyOf: { conversationId: convAlice, owner: "human:alice", index: 4, context: " (ctx)" } },
      40,
      200_000,
    );
    assertEquals(honest.messages.length, 2, "system + the referenced user message");
    assertEquals(honest.messages[0].role, "system");
    assertEquals(honest.messages[1].content, "alice question (ctx)");
  });
});
