// Record kinds for the chatbot. The conversation is an append-only thread of `message`
// records on the space (not a client-held array), anchored to a `conversation` record.
// llm_call references the thread by conversationId + upToIndex; the inference-worker
// reconstructs the context by querying the messages. So history is stored once (linear,
// not quadratic) and the whole conversation is reconstructible from the space.

import type { RadiaClient } from "../../sdk/ts/client.ts";

export async function registerChatKinds(client: RadiaClient): Promise<void> {
  // A `capability` record = a tool a worker serves ({tool, def}). The chatbot DISCOVERS its
  // tools by querying these, instead of a hard-coded list (content-routed capability
  // discovery — the "no preconfigured routing table" thesis applied to tools).
  // Reference kinds (claimable:false) are read by query/watch, never `take`n — so they don't
  // trip the starvation diagnostic. Only llm_call/tool_call are claimed as work (by the workers).
  await client.registerKind({ kind: "capability", indexedPaths: [{ path: "tool", type: "keyword" }], claimable: false });
  await client.registerKind({ kind: "conversation", indexedPaths: [], claimable: false });
  await client.registerKind({
    kind: "message",
    indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "index", type: "integer" }],
    sortablePaths: ["index"],
    claimable: false,
  });
  // llm_call is indexed on `tier` so a per-tier inference-worker claims `{match:{tier}}` — model
  // selection is content-routing (like tool_call → the worker that serves the tool). A `model`
  // record (reference) advertises which tier→model each worker serves, for discovery + the console.
  await client.registerKind({ kind: "llm_call", indexedPaths: [{ path: "tier", type: "keyword" }] });
  await client.registerKind({ kind: "model", indexedPaths: [{ path: "tier", type: "keyword" }], claimable: false });
  await client.registerKind({ kind: "llm_result", indexedPaths: [{ path: "callId", type: "keyword" }], claimable: false });
  await client.registerKind({
    kind: "llm_chunk",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "index", type: "integer" }],
    sortablePaths: ["index"],
    claimable: false,
  });
  await client.registerKind({ kind: "tool_call", indexedPaths: [{ path: "tool", type: "keyword" }] });
  await client.registerKind({ kind: "tool_result", indexedPaths: [{ path: "callId", type: "keyword" }], claimable: false });
}
