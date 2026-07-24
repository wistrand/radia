// Record kinds for the chatbot's full-symmetry loop: both thinking (llm_*) and acting
// (tool_*) flow through the space. `callId` on results/chunks is the id of the call record
// they answer.

import type { RadiaClient } from "../../sdk/ts/client.ts";

export async function registerChatKinds(client: RadiaClient): Promise<void> {
  await client.registerKind({ kind: "llm_call", indexedPaths: [{ path: "model", type: "keyword" }] });
  await client.registerKind({ kind: "llm_result", indexedPaths: [{ path: "callId", type: "keyword" }] });
  await client.registerKind({
    kind: "llm_chunk",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "index", type: "integer" }],
    sortablePaths: ["index"],
  });
  await client.registerKind({ kind: "tool_call", indexedPaths: [{ path: "tool", type: "keyword" }] });
  await client.registerKind({ kind: "tool_result", indexedPaths: [{ path: "callId", type: "keyword" }] });
}
