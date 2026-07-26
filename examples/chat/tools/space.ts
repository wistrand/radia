// Inspection tools — let the chatbot inspect the Radia space it runs on, in natural
// language. Thin wrappers over the read endpoints, with BOUNDED output (small limits,
// truncated bodies) so results are good LLM food, not firehoses. Because the chatbot's own
// thinking/acting are records in the same space, these also let it inspect itself
// (its conversation thread, its own llm_calls, their lineage).
//
// Note the observer effect: each inspection is itself a tool_call/tool_result (and the
// wrapping llm_call/message), so calling space_stats slightly changes the stats.

import type { RadiaClient, RadiaRecord } from "../../../sdk/ts/client.ts";
import type { Tool } from "./files.ts";
import type { ToolDef } from "../provider/openrouter.ts";

/** A record trimmed for the prompt: id, kind, createdAt, and a size-capped body. */
function compact(rec: RadiaRecord): unknown {
  const s = JSON.stringify(rec.body);
  const body = s.length > 1500 ? { _truncated: true, preview: s.slice(0, 1500) } : rec.body;
  return { id: rec.id, kind: rec.kind, createdAt: rec.runtimeMeta.createdAt, body };
}

/** Coerce a model-supplied order_by into valid OrderKeys: keep only elements with a string `path`.
 *  A mis-shaped element (the model guessing `{field:…}` or omitting `path`) then degrades to
 *  no-sort instead of a cryptic `unsortable_path: order_by path 'undefined'`. */
function normalizeOrderBy(raw: unknown): { path: string; dir?: "desc" }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keys = raw
    .map((k) => (k && typeof k === "object" ? k as Record<string, unknown> : {}))
    .filter((k) => typeof k.path === "string" && k.path.length > 0)
    .map((k) => ({ path: k.path as string, ...(k.dir === "desc" ? { dir: "desc" as const } : {}) }));
  return keys.length ? keys : undefined;
}

export function makeInspectTools(client: RadiaClient): Record<string, Tool> {
  return {
    space_stats: () => client.getStats().then((stats) => ({ stats })),

    space_kinds: () => client.listKinds().then((kinds) => ({ kinds })),

    space_query: async (a) => {
      const limit = Math.min(Number(a.limit ?? 10) || 10, 25);
      // Fetch one past the limit purely to answer "is this all of them?". A page that reports only
      // its own size reads as a population: the model counts 10 records and states a total. This is
      // a page, and it says so.
      const found = await client.query(
        { kind: String(a.kind ?? ""), match: a.match as Record<string, unknown> | undefined, orderBy: normalizeOrderBy(a.orderBy) as never },
        limit + 1,
      );
      const records = found.slice(0, limit);
      const more = found.length > limit;
      return {
        count: records.length,
        more,
        ...(more
          ? { warning: `more than ${limit} records match; this is a PAGE, not the total. Do not count or aggregate from it — use space_stats for totals, or narrow the match.` }
          : {}),
        records: records.map(compact),
      };
    },

    // Counting is not querying. A page answers "show me some"; this answers "how many", which is
    // what an aggregation question actually needs — the model was computing percentages from
    // whatever 10 records it happened to see. Bounded by the server's own query cap, and it says so
    // rather than rounding the truth off.
    space_count: async (a) => {
      const CAP = 500; // the server's max query limit
      const records = await client.query(
        { kind: String(a.kind ?? ""), match: a.match as Record<string, unknown> | undefined },
        CAP,
      );
      return records.length >= CAP
        ? { count: CAP, exact: false, note: `at least ${CAP} records match; narrow the match for an exact count` }
        : { count: records.length, exact: true };
    },

    space_record: async (a) => {
      const rec = await client.getRecord(String(a.recordId ?? ""));
      return rec ? compact(rec) : { error: "not found" };
    },

    space_lineage: async (a) => {
      const lineage = await client.getLineage(String(a.recordId ?? ""));
      return { lineage: lineage.map((n) => ({ depth: n.depth, id: n.record.id, kind: n.record.kind })) };
    },

    space_children: async (a) => {
      const kind = a.kind ? String(a.kind) : undefined;
      const limit = Math.min(Number(a.limit ?? 25) || 25, 50);
      let children = await client.getChildren(String(a.recordId ?? ""));
      if (kind) children = children.filter((r) => r.kind === kind);
      return { count: children.length, children: children.slice(0, limit).map(compact) };
    },

    space_events: async (a) => {
      const after = a.after != null ? String(a.after) : "0"; // opaque cursor
      const limit = Math.min(Number(a.limit ?? 20) || 20, 50);
      const events = await client.getEvents(after, limit);
      return {
        events: events.map((e) => ({ seq: e.seq, op: e.operation, kind: e.kind, state: e.state, recordId: e.recordId })),
      };
    },

    space_doctor: () => client.diagnostics(),
  };
}

export const INSPECT_SCHEMAS: ToolDef[] = [
  { type: "function", function: { name: "space_stats", description: "Counts of records by kind and state in the Radia space (a quick overview / health check).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_kinds", description: "List the registered record kinds and their indexed/sortable paths.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_query", description: "Find records by kind, with an optional match (equality/$gt/$in/$exists/…) and order_by. order_by is an array of {path, dir?} over the kind's SORTABLE paths only (list a kind's sortable paths with space_kinds), and only over fields in the record BODY — when a record was created is not a body field, so there is no way to sort by time. Without order_by, records come back in ascending record-id order; that is stable, not arbitrary, but it means a `limit` gives you the OLDEST matches, never the newest. So this is the wrong tool for 'the most recent X': use space_events (the event log is in time order) or narrow the match instead. Returns up to `limit` (default 10, max 25) records with size-capped bodies, plus `more`: true when further records match — the result is then a PAGE, so never count or compute percentages from it (space_stats has per-kind totals). The conversation itself is records: kind 'message' with match {conversationId}, order_by [{path:\"index\"}].", parameters: { type: "object", properties: { kind: { type: "string" }, match: { type: "object" }, orderBy: { type: "array", items: { type: "object", properties: { path: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["path"] } }, limit: { type: "integer" } }, required: ["kind"] } } },
  { type: "function", function: { name: "space_count", description: "How MANY records match, not which ones: {count, exact}. Use this for totals, distributions and percentages — count each value separately (e.g. one call per tier) rather than counting the records a query happened to return. A count is over the WHOLE SPACE unless the match narrows it, so a question about this conversation must say so: {kind:'tool_call', match:{conversationId, tool:'run_code'}}. `exact` is false only when the match is too broad to count precisely.", parameters: { type: "object", properties: { kind: { type: "string" }, match: { type: "object" } }, required: ["kind"] } } },
  { type: "function", function: { name: "space_record", description: "Fetch a single record by id.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_lineage", description: "The ANCESTRY (parent_ids, UP) of a record: {depth, id, kind} — how it was derived. A root record (e.g. a conversation) has no ancestors; to find what REFERENCES it, use space_children.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_children", description: "Records that REFERENCE this record via parent_ids — its children (DOWN, the reverse of lineage), with bodies. Use this to follow links from a root: a conversation's messages (kind:message) and llm_calls, an llm_call's chunks + result, a task's results. Optional `kind` filter (e.g. 'message'). Returns up to `limit` (default 25).", parameters: { type: "object", properties: { recordId: { type: "string" }, kind: { type: "string" }, limit: { type: "integer" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_events", description: "Recent event-log entries (put/take/ack/nack/…) after seq `after`. Returns {seq, op, kind, state, recordId}.", parameters: { type: "object", properties: { after: { type: "integer" }, limit: { type: "integer" } } } } },
  { type: "function", function: { name: "space_doctor", description: "A derived health report: counts by state, dead-lettered records, expired-but-stuck leases, and records that have sat available/unclaimed. Use to answer 'is the space healthy / what's stuck?'.", parameters: { type: "object", properties: {} } } },
];

// ---- remediation: the control-plane half ----
//
// `space_doctor` diagnoses; these fix. They bypass lease fencing (that is the point — they repair
// another worker's stuck record), so they are operator-gated and act as the SESSION principal.

export function makeRemediateTools(client: RadiaClient): Record<string, Tool> {
  // Each tool takes EITHER one record id or a selector. Draining a backlog one id at a time means
  // a call per record preceded by diagnostics calls just to learn the ids — and the report only
  // samples ten of them. The selector form fixes everything matching in one call.
  const fix = (action: "reclaim" | "dead-letter" | "requeue", defaultState: string) => async (a: Record<string, unknown>) => {
    if (typeof a.recordId === "string" && a.recordId) return await client.admin(action, a.recordId);
    return await client.remediate(action, {
      state: typeof a.state === "string" ? a.state : defaultState,
      expired: a.expired !== false && defaultState === "leased",
      stale: typeof a.stale === "number" ? a.stale : undefined,
      limit: typeof a.limit === "number" ? a.limit : undefined,
    });
  };
  return {
    space_reclaim: fix("reclaim", "leased"),
    space_dead_letter: fix("dead-letter", "leased"),
    space_requeue: fix("requeue", "dead_letter"),
  };
}

export const REMEDIATE_SCHEMAS: ToolDef[] = [
  { type: "function", function: { name: "space_reclaim", description: "Un-stick EXPIRED leases: force records back to available (attempt +1) so a worker can re-take them. Called with NO recordId it fixes EVERY expired lease (up to `limit`, default 200) in one call and returns {matched, applied, more} — prefer that for a backlog instead of one id at a time; repeat while `more` is true. Pass recordId only to fix exactly one. No effect on a valid (unexpired) lease.", parameters: { type: "object", properties: { recordId: { type: "string", description: "Fix just this record. Omit to fix all matching." }, limit: { type: "integer", description: "Max records per call (default 200, max 2000)." } } } } },
  { type: "function", function: { name: "space_dead_letter", description: "Give up on a record: force it to dead_letter (from available or leased). Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_requeue", description: "Retry a dead-lettered record: force it back to available. Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
];
