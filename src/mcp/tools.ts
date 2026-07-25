// MCP tool definitions. The descriptions are the documentation — a model learns HOW to use a
// tool from its description, not from a system prompt that teaches the substrate (see the
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
    "Template match on the record body, e.g. {\"status\":\"open\"} or {\"n\":{\"$gt\":3}}. Operators: " +
    "$eq $ne $gt $gte $lt $lte $in $nin $exists $and $or. Only paths declared indexed for the kind " +
    "may be matched — space_kinds lists them. Templates are data: no regex, no expressions. Omit to " +
    "match every record of the kind.",
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
    description: "Storage backend, database clock, and the principal your requests resolve to.",
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
      "Write a new record. Records are immutable once written — to 'update' something, consume it " +
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
    description: "Read records matching a template. Read-only — it does not claim anything.",
    inputSchema: {
      type: "object",
      properties: { kind: KIND, match: MATCH, orderBy: ORDER_BY, limit: { type: "number", description: "Default 50." } },
      required: ["kind"],
    },
  },
  {
    name: "space_read_one",
    description: "The single best record matching a template, or null. Read-only.",
    inputSchema: { type: "object", properties: { kind: KIND, match: MATCH, orderBy: ORDER_BY }, required: ["kind"] },
  },
  {
    name: "space_get",
    description: "Fetch one record by id.",
    inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] },
  },
  {
    name: "space_lineage",
    description: "Walk a record's ancestry through parentIds — what it was derived from, and so on up.",
    inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] },
  },
  {
    name: "space_children",
    description: "Records derived FROM this one (the reverse of space_lineage) — what came of it.",
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
      "Claim one record matching a template so you can work on it — no other agent can claim it " +
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
        requireUntainted: { type: "boolean", description: "Skip records whose data lineage is untrusted." },
      },
      required: ["kind"],
    },
  },
  {
    name: "space_ack",
    description:
      "Finish a claim successfully. Set resultKind/resultBody to emit a result record in the same " +
      "step — that result is itself a record others match on, which is how work flows onward. A " +
      "status of lease_lost means the claim had already been reclaimed and someone else may have " +
      "redone the work (delivery is at-least-once).",
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
      "Return a claim untouched, with no failure recorded — use it when you claimed something you " +
      "should not have, or cannot act on right now.",
    inputSchema: { type: "object", properties: { claimId: CLAIM_ID }, required: ["claimId"] },
  },
];
