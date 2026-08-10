// Record kinds for the chatbot. The conversation is an append-only thread of `message`
// records on the space (not a client-held array), anchored to a `conversation` record.
// llm_call references the thread by conversationId + upToIndex; the inference-worker
// reconstructs the context by querying the messages. So history is stored once (linear,
// not quadratic) and the whole conversation is reconstructible from the space.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import { PROGRESS_KIND } from "../../../extensions/ts/progress.ts";
import { CAPABILITY_KIND } from "../../../extensions/ts/capability.ts";
import { CANCEL_KIND, TURN_COMPLETE_KIND } from "../../../extensions/ts/turn.ts";
import { SANDBOX_KIND } from "../../../extensions/ts/sandbox-registry.ts";

export async function registerChatKinds(client: RadiaClient): Promise<void> {
  // A `capability` record = a tool a worker serves ({tool, def}). The chatbot DISCOVERS its
  // tools by querying these, instead of a hard-coded list. That is content-routed capability
  // discovery: the "no preconfigured routing table" thesis applied to tools.
  // Reference kinds (claimable:false) are read by query/watch, never `take`n, so they don't
  // trip the starvation diagnostic. Only llm_call/tool_call are claimed as work (by the workers).
  // `provider` is indexed as well as `tool`, because the registry is keyed by the PAIR: a
  // publisher checks its own newest advertisement (`match: {tool, provider}`), and without the path
  // declared that query throws `undeclared_path`, the publisher's catch swallows it, and every
  // publish falls back to the unanchored key. The visible symptom is a retired tool that cannot be
  // revived, which is two silent steps away from the missing declaration.
  await client.registerKind({
    ...CAPABILITY_KIND, // extensions/ts/capability.ts owns the shape
  });
  // REDECLARING a reserved kind, on purpose. `artifact` is defined in code with {digest, mediaType}
  // indexed; the app adds `conversationId` so a grant pattern can bind an artifact to the
  // conversation that produced it. Artifacts were otherwise the one kind a session could not be
  // scoped on (the body is runtime-built, and a pattern matches the body), so any session holding
  // an artifact id could read it. The runtime's own paths are repeated here because a redeclaration
  // REPLACES rather than merges (latest-wins), and dropping `digest` would break dedup by content.
  // The runtime enforces exactly that now: a reserved kind may be EXTENDED, never shrunk, so
  // omitting `digest`/`mediaType`/`claimable` here is refused with `reserved_kind`.
  await client.registerKind({
    kind: "artifact",
    indexedPaths: [
      { path: "digest", type: "keyword" },
      { path: "mediaType", type: "keyword" },
      { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" },
      // Which working tree a file belongs to. Needed to ANSWER "erase this workspace's payloads":
      // erasure is per artifact, so the set has to be findable without walking every manifest.
      { path: "workspace", type: "keyword" },
    ],
    claimable: false,
  });
  await client.registerKind({ kind: "conversation", indexedPaths: [], claimable: false });
  // The two kinds the turn CHAIN introduces (extensions/ts/turn.ts owns both shapes): a terminus so
  // a client has something to wait for, and Escape as a fact the worker can read. Both carry
  // `turnAt`, because a conversation accumulates one of each per turn and a per-conversation read
  // finds the previous turn's.
  await client.registerKind(TURN_COMPLETE_KIND);
  await client.registerKind(CANCEL_KIND);
  await client.registerKind({
    kind: "message",
    // `role` is indexed because it is the dimension anyone aggregating a conversation reaches for
    // ("how many user turns, how many tool results") and every message body carries it. Without it
    // that question degrades into fetching pages and counting by hand, a worse answer computed
    // from a page rather than the population.
    indexedPaths: [
      { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "role", type: "keyword" },
      // An assistant message is the inference worker's ACK, and the client finds it by the call it
      // answers (plan-chat-turn.md). Messages a client writes simply have no callId.
      { path: "callId", type: "keyword" },
      // ADDRESSING. A tool reply is found by the provider call id it answers, an assistant message
      // by which turn and round it belongs to. `index` orders the transcript and bounds the context
      // window; it is never used to predict where a record will land, because a prediction that
      // misses returns the wrong record rather than nothing.
      { path: "tool_call_id", type: "keyword" },
      { path: "turnAt", type: "integer" },
      { path: "round", type: "integer" },
    ],
    sortablePaths: ["index"],
    claimable: false,
  });
  // llm_call is indexed on `tier` so a per-tier inference-worker claims `{match:{tier}}`. Model
  // selection is content-routing (like tool_call → the worker that serves the tool). A `model`
  // record (reference) advertises which tier→model each worker serves, for discovery + the console.
  // `conversationId` is indexed on both work kinds because both BODIES carry it. A field a
  // record holds but its kind does not declare is invisible to matching, so a scoped query is
  // rejected with `undeclared_path` rather than answered. That is what makes "how many run_javascript
  // did we do in THIS conversation" reachable in one query instead of a walk down children.
  await client.registerKind({
    kind: "llm_call",
    indexedPaths: [{ path: "tier", type: "keyword" }, { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
    // The BYTE hog: each body carries the tool list, and nothing reads it after the result lands
    // (context assembly reads `message` records, which carry no retention and stay). Measured
    // live: 747 llm_calls held 8 MB of the 10 MB of all bodies. A week covers any debugging.
    defaultRetentionSeconds: 7 * 24 * 3600,
  });
  // `contentKey: tier` matches `liveModels`' own projection (activeByKey on body.tier), so what
  // compaction keeps is exactly what the router reads.
  await client.registerKind({
    kind: "model",
    indexedPaths: [{ path: "tier", type: "keyword" }],
    claimable: false,
    contentKey: ["tier"],
  });
  // `conversationId` on the RESULT kinds, not just the call kinds: these are keyed by callId, and a
  // grant scoped by conversation can only bind a path the body actually carries. Without it a
  // session holding a callId from another conversation could read its result.
  await client.registerKind({
    // Since plan-chat-turn.md 2a this answers INLINE calls only (the router's classifier: `messages`
    // in the body, no conversation). A conversation call's answer is the assistant `message` itself,
    // acked by the inference worker inside the lease's fence.
    kind: "llm_result",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
    claimable: false,
  });
  await client.registerKind({
    kind: "llm_chunk",
    indexedPaths: [
      { path: "callId", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" },
    ],
    sortablePaths: ["index"],
    claimable: false,
    // Ephemera BY DECLARATION, not by every writer remembering: a chunk's job ends with its turn
    // (the result carries the full text; the watermark replay only matters mid-turn), and the
    // kind is the COUNT hog — ~8 records per call at the stream cadence, ~400 for a one-minute
    // answer. The runtime stamps this into each record at commit; a writer may still override.
    defaultRetentionSeconds: 24 * 3600,
  });
  await client.registerKind({
    kind: "tool_call",
    // `attempt` and `retryOf` record the iteration loop: code generation is write, run, read the
    // error, fix, rerun, and every attempt used to parent to the conversation, so eight tries were
    // eight siblings with no ordering. Sortable on `attempt` so a chain reads in the order it
    // happened rather than in id order, which is the same thing until a retry crosses a second.
    indexedPaths: [
      { path: "tool", type: "keyword" },
      { path: "conversationId", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "attempt", type: "integer" },
      { path: "retryOf", type: "keyword" },
    ],
    sortablePaths: ["attempt"],
  });
  // A `sandbox` = an execution environment and what it guarantees, declared by the OPERATOR and
  // verified by the worker before it serves anything. A record rather than prose because a grant
  // can bind `{network: false}` and a sentence in a tool description cannot.
  await client.registerKind(SANDBOX_KIND);
  // A `workspace` = one version of a multi-file working tree: a manifest of {path, mode, digest,
  // artifactId} with the bytes stored as artifacts. Latest-wins by name like `procedure`, so a new
  // version is a successor and every earlier one stays readable.
  //
  // `treeDigest` is indexed because it is the tree's IDENTITY: it is how a re-written identical
  // tree is recognised (and skipped), and eventually what a `check` attaches to. `basedOn` is
  // indexed so a fork is a query: two manifests naming one predecessor diverged.
  await client.registerKind({
    kind: "workspace",
    indexedPaths: [
      { path: "name", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "conversationId", type: "keyword" },
      { path: "treeDigest", type: "keyword" },
      { path: "basedOn", type: "keyword" },
    ],
    claimable: false,
  });
  // A `check` = whether a run did what was CLAIMED of it, decided by the worker that ran it.
  //
  // The point is who writes it. "The code works" was previously the model's assertion in prose,
  // sitting next to output only the model had read. A check is written by the exec-worker from a
  // real run, against an expectation stated BEFORE it ran, and the session has no grant to put one.
  // So a pass is evidence rather than a claim, which is the half of the audit story that was
  // missing: the space could show that code ran, never that it did what it was supposed to.
  //
  // Indexed on `verdict` so "what was claimed and did not hold" is one query, which is the
  // question an auditor asks and the model never volunteers.
  await client.registerKind({
    kind: "check",
    indexedPaths: [
      { path: "callId", type: "keyword" },
      { path: "conversationId", type: "keyword" },
      { path: "owner", type: "keyword" },
      // "pass"/"fail" rather than a boolean: `boolean` is not an index type, and a match reading
      // `{verdict: "fail"}` says what it is looking for.
      { path: "verdict", type: "keyword" },
    ],
    claimable: false,
  });
  await client.registerKind({
    kind: "tool_result",
    indexedPaths: [{ path: "callId", type: "keyword" }, { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
    claimable: false,
  });
  // A `grant_request` = the assistant asking for authority it does not have. Grants are
  // "assigned, never self-declared" (CLAUDE.md), so an agent that hits a 403 cannot fix it. What it
  // CAN do is say what it needs and why, as a record, and let a human decide. The request is
  // written by the SESSION principal, so `created_by` names the asker authoritatively rather than
  // a body field anyone could set. Indexed on conversationId because the approver is the person
  // in that conversation; `kind` so a request can be found by what it asks for.
  await client.registerKind({
    kind: "grant_request",
    indexedPaths: [{ path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "kind", type: "keyword" }],
    claimable: false,
  });
  // A `procedure` = code the ASSISTANT wrote and named, so it can be run again without being
  // re-typed into a tool call. Deliberately its own kind rather than a `capability`: a capability
  // is what a worker serves and is global, while a procedure belongs to the conversation that
  // wrote it. `conversationId` is indexed because that scope is enforced on every execution, not
  // just used to filter what the model is offered. The code itself is an artifact; the record
  // carries its id, never its text (records route, blobs hold bytes).
  await client.registerKind({
    kind: "procedure",
    indexedPaths: [{ path: "name", type: "keyword" }, { path: "conversationId", type: "keyword" }, { path: "owner", type: "keyword" }],
    claimable: false,
  });
  // `progress` = what a worker is doing right now, keyed to the call the chat awaits. Turn
  // feedback is a record like everything else (see progress.ts): the chat renders the stream,
  // and its ABSENCE tells the chat nobody claimed the work.
  await client.registerKind({
    ...PROGRESS_KIND, // extensions/ts/progress.ts owns the shape; this app only declares it
  });
}
