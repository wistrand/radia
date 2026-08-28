// MCP tool definitions. The descriptions are the documentation: a model learns HOW to use a
// tool from its description, not from a system prompt that teaches the space (see the
// "discover, don't hardcode" corollary in CLAUDE.md). Nothing here names a specific record kind:
// the space's kinds are discovered at runtime through `space_kinds`.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const KIND = { type: "string", description: "Record kind. Discover valid kinds with space_kinds." };
const MATCH = {
  type: "object",
  description:
    // The list is the WHOLE list, and it named two operators the compiler refuses ($ne, $nin, both
    // deferred): a description that promises an operator buys a guaranteed refusal, since a model
    // reading it has no other source. Checked against `src/core/matching.ts` by `test/team.test.ts`.
    "Pattern match on the record body, e.g. {\"status\":\"open\"} or {\"n\":{\"$gt\":3}}. Operators: " +
    "$eq $gt $gte $lt $lte $in $exists $any $each $and $or, and nothing else (there is no negation " +
    "yet). Absence is matchable: {\"assignee\":{\"$exists\":false}} finds the records where nobody " +
    "set it, which is how you claim unassigned work, and a missing field matches NO other " +
    "predicate. ON AN ARRAY FIELD (space_kinds says which), a scalar predicate never distributes " +
    "over the elements: {\"tags\":\"image\"} matches nothing, and {\"tags\":{\"$in\":[\"image\"]}} " +
    "does NOT mean 'has one of these' either, since $in compares the WHOLE array. Membership is " +
    "{\"tags\":{\"$any\":\"image\"}}; 'every element' is $each. {\"tags\":[\"image\"]} is legal and " +
    "is whole-list equality, so it silently misses a record tagged [\"image\",\"urgent\"]. Only " +
    "paths declared indexed for the kind may be matched, and space_kinds lists them. Patterns are " +
    "data: no regex, no expressions. Omit to match every record of the kind.",
};
const ORDER_BY = {
  type: "array",
  description: "Sort, e.g. [{\"path\":\"priority\",\"dir\":\"desc\"}]. Paths must be declared sortable.",
  items: {
    type: "object",
    properties: { path: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } },
    required: ["path"],
  },
};
const CLAIM_ID = {
  type: "string",
  description: "The claimId returned by space_take. The lease itself is held by the adapter.",
};

export const TOOLS: McpTool[] = [
  {
    name: "space_kinds",
    description:
      "List the record kinds declared in this space, with the paths each one indexes (matchable) " +
      "and sorts by. Call this FIRST: which kinds exist, and what you may match on, is a property " +
      "of the running space, not of this tool list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "space_health",
    // `principal` is a RUN, and a run is not what anything addresses. Two harnesses in a lab run
    // asked this call who they were, got run ids, and addressed their mail to them; it worked only
    // because both were wrong the same way, and a run dies at the 12h ceiling.
    description: "Storage backend, database clock, and who you are. `principal` is the RUN your " +
      "requests resolve to, which changes every session; `agent` is your durable name (`agent:you`) " +
      "and is what conventions address, so use it when a record asks who something is for or from. " +
      "`agent` is absent when your principal is already durable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "space_stats",
    description: "Record counts grouped by kind and envelope state (available/leased/consumed/dead_letter).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "space_doctor",
    description:
      "Diagnostics: dead-lettered records, leases that expired while still held, and work sitting " +
      "available far longer than usual. Use this when work seems stuck before assuming a bug.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "space_put",
    description:
      "Write a new record. Records are immutable once written. To 'update' something, consume it " +
      "and emit a successor rather than trying to modify it. Set parentIds to record which records " +
      "this one was derived from (data lineage; it grants no authority). Pass idempotencyKey if a " +
      "retry must not create a second record.",
    inputSchema: {
      type: "object",
      properties: {
        kind: KIND,
        body: { type: "object", description: "The record body: any JSON object." },
        parentIds: { type: "array", items: { type: "string" }, description: "Record ids this was derived from." },
        idempotencyKey: { type: "string", description: "Retry-safe key: the same key returns the first result." },
      },
      required: ["kind", "body"],
    },
  },
  {
    name: "space_query",
    // "3 available tasks" was reported off this call twice, on a space where two of the three were
    // finished a day earlier: a record does not stop matching when its work is done, and nothing in
    // the answer says otherwise. The reader has no other source, so the caveat belongs here.
    description: "Read records matching a pattern. Read-only. It does not claim anything. The answer carries `count`, the records, and `more`: true when further records match, in which case what you have is a PAGE and counting or aggregating from it is wrong (space_stats has totals; narrowing the match is the fix). `notes` is the space's own commentary on the query you sent. Without order_by, records come back in ascending record-id order, so a limit gives you the OLDEST matches and never the newest: this is the wrong tool for \"the most recent X\". Narrow the match, or order_by a sortable path. A record here may be FINISHED WORK: claim state lives in the runtime envelope, not the body, so on a claimable kind the settled records come back looking exactly like open ones. Never report this list as what is outstanding. What is open is what space_take hands you; whether one record is done shows in space_children, where a settled one carries the result it was answered with.",
    inputSchema: {
      type: "object",
      properties: { kind: KIND, match: MATCH, orderBy: ORDER_BY, limit: { type: "number", description: "Default 50." } },
      required: ["kind"],
    },
  },
  {
    name: "space_read_one",
    description: "The single best record matching a pattern, or null. Read-only.",
    inputSchema: { type: "object", properties: { kind: KIND, match: MATCH, orderBy: ORDER_BY }, required: ["kind"] },
  },
  {
    name: "space_get",
    description: "Fetch one record by id.",
    inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] },
  },
  {
    name: "space_lineage",
    description: "Walk a record's ancestry through parentIds: what it was derived from, and so on up.",
    inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] },
  },
  {
    name: "space_children",
    description: "Records derived FROM this one (the reverse of space_lineage): what came of it.",
    inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] },
  },
  {
    name: "space_events",
    description:
      "The space's event log in order: every put, take, ack, nack, release and expiry. Pass the last " +
      "cursor you saw as `after` to read only what happened since.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "string", description: "Opaque cursor from a previous call. Omit to start at the beginning." },
        limit: { type: "number", description: "Default 50." },
      },
    },
  },
  {
    name: "space_take",
    description:
      "Claim one record matching a pattern so you can work on it. No other agent can claim it " +
      "while you hold it. Returns a claimId and the record, or reports that nothing is available " +
      "(a normal outcome, not an error). The lease is held and renewed for you while you think, so " +
      "there is no time pressure. ALWAYS finish with space_ack, space_nack or space_release: an " +
      "abandoned claim blocks that record until the lease lapses.",
    inputSchema: {
      type: "object",
      properties: {
        kind: KIND,
        match: MATCH,
        leaseSeconds: { type: "number", description: "Initial lease length; renewed automatically. Default 60." },
        requireUntainted: { type: "boolean", description: "Accept only records carrying NO classification labels. Shorthand for allowTaint: []." },
        allowTaint: { type: "array", items: { type: "string" }, description: "Classification labels a record may carry and still be claimed (file, net, foreign). Anything outside the list is skipped. An allowlist, so a label added later is barred rather than silently accepted." },
      },
      required: ["kind"],
    },
  },
  {
    name: "space_ack",
    description:
      "Settle a claim with an ANSWER, including an answer that reports failure: work that cannot " +
      "succeed on a retry is acked saying so, never nacked. Set resultKind/resultBody to emit that " +
      "result in the same step. It is itself a record others match on, which is how work flows " +
      "onward. A status of lease_lost means the claim had already been reclaimed and someone else " +
      "may have redone the work (delivery is at-least-once).",
    inputSchema: {
      type: "object",
      properties: {
        claimId: CLAIM_ID,
        resultKind: KIND,
        resultBody: { type: "object", description: "Body of the result record. Requires resultKind." },
      },
      required: ["claimId"],
    },
  },
  {
    name: "space_nack",
    description:
      "Give up on a claim so it can be retried. Use this when the work failed and retrying might " +
      "succeed. After enough attempts the record is dead-lettered instead of retried forever.",
    inputSchema: {
      type: "object",
      properties: { claimId: CLAIM_ID, backoffSeconds: { type: "number", description: "Delay before it is claimable again." } },
      required: ["claimId"],
    },
  },
  {
    name: "space_release",
    description:
      "Return a claim untouched, with no failure recorded. Use it when you claimed something you " +
      "should not have, or cannot act on right now.",
    inputSchema: { type: "object", properties: { claimId: CLAIM_ID }, required: ["claimId"] },
  },
  {
    name: "space_watch",
    description:
      "Wait for a record matching a pattern, and return one. Use it to pick up work another agent " +
      "left, without polling in a loop yourself. By default it RECONCILES FIRST: a matching record " +
      "that already exists comes back immediately, so this answers 'is there anything for me?'. " +
      "Set newOnly:true for 'tell me when the NEXT one arrives' — you need that for a MAILBOX, " +
      "because nothing consumes a fact: on a kind that is not claimable the default hands you the " +
      "same record every time, however you narrow the match. The reply says which you got " +
      "(`existing`). It does NOT claim anything: call space_take to claim, which is what stops two " +
      "agents doing the same work. Returns {found:false} on timeout, an ordinary outcome and not " +
      "an error: nobody wrote one in time.",
    inputSchema: {
      type: "object",
      properties: {
        kind: KIND,
        match: MATCH,
        timeoutSeconds: { type: "number", description: "How long to wait. Default 30, capped at 120." },
        newOnly: {
          type: "boolean",
          description:
            "Only report a record written AFTER this call started. What a mailbox wants: without it, " +
            "a kind that is not claimable returns the same existing record every time.",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "space_put_artifact",
    description:
      "Store bytes beside the space and get back a record that NAMES them. THE WAY TO SHARE CODE, " +
      "a script, a file, a diff, a transcript, or any output another agent should read: source " +
      "pasted into a record body is prose in a field nothing indexes, cannot be run or downloaded, " +
      "and cannot be erased, while an artifact keeps its filename and media type, is fetched by " +
      "whoever needs it, and can be shredded. Reach for it whenever you are about to put a code " +
      "block in a message. " +
      "Bytes never travel inside a record body, so this is how agents hand each other content. " +
      "Four ways to supply the bytes, and only one of them puts them in this conversation. " +
      "`link:true` returns a single-use URL to PUT them to with no credential, which assumes " +
      "nothing about where you are running: use it from a browser, a container, or another " +
      "machine. `path` reads a file this server can see, which is simpler when you share a " +
      "filesystem with it. `text` is for content you are writing here. `base64` exists for small " +
      "binary you already hold and is a poor way to move a file, since a 100 KB image costs 133 KB " +
      "of context to say. With `link` or `path` the media type and filename are taken from what " +
      "you give unless you override them. " +
      "The record is ordinary: give it parentIds for lineage and meta so a pattern can find it. " +
      "Identical bytes are one stored payload, so re-sending the same content costs nothing.",
    inputSchema: {
      type: "object",
      properties: {
        link: {
          type: "boolean",
          description:
            "Return a single-use upload URL instead of taking the bytes here. PUT them to it with " +
            "no credential. Everything except the bytes is fixed when the link is minted.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to a file this server can read. Simpler than `link` when you share a " +
            "filesystem with it; useless when you do not.",
        },
        text: { type: "string", description: "The content, as text. Use this unless the bytes are binary." },
        base64: { type: "string", description: "The content, base64-encoded. For binary only; prefer `text`." },
        mediaType: { type: "string", description: "e.g. text/markdown, application/json. Default text/plain." },
        filename: { type: "string", description: "Advisory, for a download. Never used as a path." },
        parentIds: { type: "array", items: { type: "string" }, description: "Record ids this was derived from." },
        meta: {
          type: "object",
          description: "Scalar fields merged into the artifact's record body, so a query can find it (e.g. {task: 'abc'}).",
        },
        idempotencyKey: { type: "string", description: "Retry-safe key: the same key returns the first result." },
      },
    },
  },
  {
    name: "space_get_artifact",
    description:
      "Read an artifact's bytes by record id. Text comes back as text. Binary does NOT: it is " +
      "reported with its size and media type instead, because base64 in a context window is not " +
      "something you can act on. Oversized content is REFUSED with its size rather than truncated, " +
      "so you never mistake part of a file for the whole of it. For either of those, call again " +
      "with link:true: you get a short-lived URL that downloads THIS artifact and nothing else, " +
      "with no header needed. That is how you receive an image, a PDF or an archive another agent " +
      "sent you, and it works whether or not the space is on your machine.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "The artifact record's id." },
        link: {
          type: "boolean",
          description:
            "Return a short-lived download URL for this one artifact instead of its content. Use " +
            "for anything binary or oversized. It carries its own authorization, so fetch it with " +
            "no header; it is not a credential and opens nothing else.",
        },
      },
      required: ["recordId"],
    },
  },
  {
    name: "space_artifact_meta",
    description:
      "An artifact's digest, media type and size WITHOUT reading it. Use it to decide whether to " +
      "read something, and to compare content: the digest is the sha256 of the bytes, so two " +
      "artifacts with the same digest are the same content.",
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string", description: "The artifact record's id." } },
      required: ["recordId"],
    },
  },
];
