// Record kinds for the chatbot. The conversation is an append-only thread of `message`
// records on the space (not a client-held array), anchored to a `conversation` record.
// llm_call references the thread by conversationId + upToIndex; the inference-worker
// reconstructs the context by querying the messages. So history is stored once (linear,
// not quadratic) and the whole conversation is reconstructible from the space.

import type { RadiaClient } from "../../../sdk/ts/client.ts";

export async function registerChatKinds(client: RadiaClient): Promise<void> {
  // A `capability` record = a tool a worker serves ({tool, def}). The chatbot DISCOVERS its
  // tools by querying these, instead of a hard-coded list (content-routed capability
  // discovery — the "no preconfigured routing table" thesis applied to tools).
  // Reference kinds (claimable:false) are read by query/watch, never `take`n — so they don't
  // trip the starvation diagnostic. Only llm_call/tool_call are claimed as work (by the workers).
  await client.registerKind({ kind: "capability", indexedPaths: [{ path: "tool", type: "keyword" }], claimable: false });
  // REDECLARING a reserved kind, on purpose. `artifact` is defined in code with {digest, mediaType}
  // indexed; the app adds `conversationId` so a grant template can bind an artifact to the
  // conversation that produced it. Artifacts were otherwise the one kind a session could not be
  // scoped on — the body is runtime-built, and a template matches the body — so any session holding
  // an artifact id could read it. The runtime's own paths are repeated here because a redeclaration
  // REPLACES rather than merges (latest-wins), and dropping `digest` would break dedup by content.
  await client.registerKind({
    kind: "artifact",
    indexedPaths: [
      { path: "digest", type: "keyword" },
      { path: "mediaType", type: "keyword" },
      { path: "conversationId", type: "keyword" },
    ],
    claimable: false,
  });
  await client.registerKind({ kind: "conversation", indexedPaths: [], claimable: false });
  await client.registerKind({
    kind: "message",
    // `role` is indexed because it is the dimension anyone aggregating a conversation reaches for
    // ("how many user turns, how many tool results") and every message body carries it. Without it
    // that question degrades into fetching pages and counting by hand — a worse answer, computed
    // from a page rather than the population.
    indexedPaths: [
      { path: "conversationId", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "role", type: "keyword" },
    ],
    sortablePaths: ["index"],
    claimable: false,
  });
  // llm_call is indexed on `tier` so a per-tier inference-worker claims `{match:{tier}}` — model
  // selection is content-routing (like tool_call → the worker that serves the tool). A `model`
  // record (reference) advertises which tier→model each worker serves, for discovery + the console.
  // `conversationId` is indexed on both work kinds because both BODIES carry it — a field a
  // record holds but its kind does not declare is invisible to matching, so a scoped query is
  // rejected with `undeclared_path` rather than answered. That is what makes "how many run_code
  // did we do in THIS conversation" reachable in one query instead of a walk down children.
  await client.registerKind({
    kind: "llm_call",
    indexedPaths: [{ path: "tier", type: "keyword" }, { path: "conversationId", type: "keyword" }],
  });
  await client.registerKind({ kind: "model", indexedPaths: [{ path: "tier", type: "keyword" }], claimable: false });
  // `conversationId` on the RESULT kinds, not just the call kinds: these are keyed by callId, and a
  // grant scoped by conversation can only bind a path the body actually carries. Without it a
  // session holding a callId from another conversation could read its result.
  await client.registerKind({
    kind: "llm_result",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "conversationId", type: "keyword" }],
    claimable: false,
  });
  await client.registerKind({
    kind: "llm_chunk",
    indexedPaths: [
      { path: "callId", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "conversationId", type: "keyword" },
    ],
    sortablePaths: ["index"],
    claimable: false,
  });
  await client.registerKind({
    kind: "tool_call",
    indexedPaths: [{ path: "tool", type: "keyword" }, { path: "conversationId", type: "keyword" }],
  });
  await client.registerKind({
    kind: "tool_result",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "conversationId", type: "keyword" }],
    claimable: false,
  });
  // A `grant_request` = the assistant asking for authority it does not have. Grants are
  // "assigned, never self-declared" (CLAUDE.md), so an agent that hits a 403 cannot fix it — but it
  // CAN say what it needs and why, as a record, and let a human decide. The request is written by
  // the SESSION principal, so `created_by` names the asker authoritatively rather than a body field
  // anyone could set. Indexed on conversationId because the approver is the person in that
  // conversation; `kind` so a request can be found by what it asks for.
  await client.registerKind({
    kind: "grant_request",
    indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "kind", type: "keyword" }],
    claimable: false,
  });
  // A `procedure` = code the ASSISTANT wrote and named, so it can be run again without being
  // re-typed into a tool call. Deliberately its own kind rather than a `capability`: a capability
  // is what a worker serves and is global, while a procedure belongs to the conversation that
  // wrote it — `conversationId` is indexed because that scope is enforced on every execution, not
  // just used to filter what the model is offered. The code itself is an artifact; the record
  // carries its id, never its text (records route, blobs hold bytes).
  await client.registerKind({
    kind: "procedure",
    indexedPaths: [{ path: "name", type: "keyword" }, { path: "conversationId", type: "keyword" }],
    claimable: false,
  });
  // `progress` = what a worker is doing right now, keyed to the call the chat awaits. Turn
  // feedback is a record like everything else (see progress.ts): the chat renders the stream,
  // and its ABSENCE tells the chat nobody claimed the work.
  await client.registerKind({
    kind: "progress",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "conversationId", type: "keyword" }],
    claimable: false,
  });
}
