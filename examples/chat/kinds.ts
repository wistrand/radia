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
  await client.registerKind({ kind: "capability", indexedPaths: [{ path: "tool", type: "keyword" }] });
  await client.registerKind({ kind: "conversation", indexedPaths: [] });
  await client.registerKind({
    kind: "message",
    indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "index", type: "integer" }],
    sortablePaths: ["index"],
  });
  await client.registerKind({ kind: "llm_call", indexedPaths: [] });
  await client.registerKind({ kind: "llm_result", indexedPaths: [{ path: "callId", type: "keyword" }] });
  await client.registerKind({
    kind: "llm_chunk",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "index", type: "integer" }],
    sortablePaths: ["index"],
  });
  await client.registerKind({ kind: "tool_call", indexedPaths: [{ path: "tool", type: "keyword" }] });
  await client.registerKind({ kind: "tool_result", indexedPaths: [{ path: "callId", type: "keyword" }] });
}
