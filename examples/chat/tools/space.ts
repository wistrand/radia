// Inspection tools. These let the chatbot inspect the Radia space it runs on, in natural
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

/**
 * Does this set of records describe fewer THINGS than there are records, and under which field?
 *
 * Every registry in this system is a latest-wins projection over successor records: saving a
 * workspace again writes another `workspace`, retiring a capability writes another `capability`.
 * So a record count on one of those kinds is an EDIT COUNT, and reporting it as a population is a
 * wrong answer that looks like a right one — a workspace saved fifteen times was reported as
 * "15 instances of a workspace named fireworks", while `radia workspaces` (the shared latest-wins
 * projection) said one workspace, 15 versions.
 *
 * The candidates are the fields those registries actually key on. No guessing about WHICH is the
 * content key: the claim made here is only the observable one, that N records carry M distinct
 * values of a field, which is true whatever the key turns out to be.
 */
function distinctKey(records: RadiaRecord[]): { distinct?: { by: string; count: number; note: string } } {
  if (records.length < 2) return {};
  for (const field of ["name", "tool", "path", "model", "principal"]) {
    const values = records.map((r) => (r.body as Record<string, unknown>)?.[field]).filter((v) => typeof v === "string");
    if (values.length !== records.length) continue;
    const count = new Set(values).size;
    if (count === records.length) continue; // one record per thing: the count IS the population
    return {
      distinct: {
        by: field,
        count,
        note: `${records.length} records carry only ${count} distinct '${field}' value(s): this kind keeps its ` +
          `history, so the count is of VERSIONS, not of things. Report ${count}, or use the tool that ` +
          `projects the kind (list_workspaces for workspaces).`,
      },
    };
  }
  return {};
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
    /**
     * Ask a human for authority this session does not have.
     *
     * The one escalation path an agent gets, and it deliberately stops at a person. Grants are
     * "assigned, never self-declared", so this writes a REQUEST, as the session principal: the
     * record's server-assigned `created_by` names the asker and no body field has to be trusted.
     * The REPL shows it to the human, who approves or refuses; nothing here can grant anything.
     */
    request_grant: async (a, ctx) => {
      const kind = String(a.kind ?? "");
      const ops = Array.isArray(a.operations) ? a.operations.map(String) : [];
      const why = String(a.why ?? "");
      // "own" unless the asker says otherwise: the narrow ask stays the default, and widening is a
      // thing it has to state rather than the shape of a missing field.
      const scope = a.scope === "all" ? "all" : "own";
      if (!kind || ops.length === 0) return { ok: false, error: "request_grant needs `kind` and `operations`" };
      if (!why.trim()) return { ok: false, error: "request_grant needs `why`; a human is going to read it" };
      // BOTH identifiers come from the CALL, never from module state. This code runs in the
      // TOOLS-WORKER process: `sessionOwner()` is a mutable global the REPL sets after resolving
      // the login token, so in this process it is still the default and stamping it wrote
      // `owner: agent:chat-user` while the session's grant pattern said `human:wistrand`. The write
      // was refused, which killed the escalation path the prompt tells the model to use, and the
      // model reported it as its own request being restricted.
      //
      // `ctx.owner` is the value the SESSION stamped on the tool_call, so the runtime already
      // checked it against that session's write pattern. It is the only trustworthy source here.
      // The worker starts before any conversation exists, which is why neither can be a launch flag.
      await client.put({
        kind: "grant_request",
        body: { conversationId: ctx?.conversationId, owner: ctx?.owner, kind, operations: ops, why, scope },
      });

      // …and WAIT for the answer, rather than returning "I asked, retry later".
      //
      // The escalation loop used to cost two full turns and two human inputs per grant: ask, end
      // the turn, human approves at the prompt, human types "retry", assistant retries. And every
      // miss (wrong kind, wrong scope) cost another two. In practice it broke before it converged.
      // The human is sitting at the prompt; the only reason the decision could not come back here
      // was that nothing waited for it. The REPL reviews pending requests WHILE this call is in
      // flight (see `onToolWait` in chat.ts), so the person is asked immediately and the answer
      // lands in this same turn, leaving the assistant its remaining tool rounds to act on it.
      const deadline = Date.now() + 240_000; // a person is deciding; do not rush them
      const mine = (b: Record<string, unknown>) =>
        b.kind === kind && b.scope === scope &&
        JSON.stringify([...(b.operations as string[] ?? [])].sort()) === JSON.stringify([...ops].sort());
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        // The decision comes back as a SUCCESSOR grant_request carrying `decision`. The session
        // can read its own requests but has no grant on `grant` itself, so this is the only channel
        // that does not widen it.
        const rows = await client.query(
          { kind: "grant_request", match: { conversationId: ctx?.conversationId } },
          50,
          { dir: "desc" },
        );
        const decided = rows.map((r) => r.body as Record<string, unknown>).find((b) => b.decision && mine(b));
        if (!decided) continue;
        // The kind does not exist, so whatever was decided, the grant authorizes nothing. Say that
        // plainly and hand back the real names rather than reporting success the caller will spend
        // another round discovering is empty.
        if (decided.noSuchKind) {
          return {
            ok: false,
            decision: "no_such_kind",
            kindsOnThisSpace: decided.kindsOnThisSpace,
            note: `there is no record kind '${decided.noSuchKind}' on this space, so that grant authorizes nothing. ` +
              `Pick the kind that actually holds what you want from the list and ask again, in this turn.`,
          };
        }
        if (decided.decision !== "granted") {
          return { ok: false, decision: "refused", note: "the human refused. Do not ask again for the same thing." };
        }
        return {
          ok: true,
          decision: "granted",
          granted: decided.granted ?? { kind, operations: ops },
          note: "in force now; retry the operation in THIS turn rather than ending it.",
        };
      }
      return {
        ok: true,
        decision: "pending",
        note: "no answer yet. Say what you asked for and stop; the human will approve or refuse, and you can retry after.",
      };
    },

    // Passing `scope` through matters: a scoped session reading `stats: []` once told its user
    // "the space is empty and healthy". The scope is what makes that unsayable.
    space_stats: () => client.getStatsReport(),

    space_kinds: () => client.listKinds().then((kinds) => ({ kinds })),

    space_query: async (a) => {
      const limit = Math.min(Number(a.limit ?? 10) || 10, 25);
      // Fetch one past the limit purely to answer "is this all of them?". A page that reports only
      // its own size reads as a population: the model counts 10 records and states a total. This is
      // a page, and it says so.
      const page = await client.queryPage(
        { kind: String(a.kind ?? ""), match: a.match as Record<string, unknown> | undefined, orderBy: normalizeOrderBy(a.orderBy) as never },
        limit + 1,
        undefined,
        { explain: true },
      );
      const records = page.records.slice(0, limit);
      const more = page.records.length > limit;
      return {
        count: records.length,
        more,
        ...(more
          ? { warning: `more than ${limit} records match; this is a PAGE, not the total. Do not count or aggregate from it. Use space_stats for totals, or narrow the match.` }
          : {}),
        // A page bounded by the LIMIT and a page bounded by your GRANT are different facts, and
        // only the first was ever reported. A session whose reads are scoped to its conversation
        // queried `message`, got its own, and told the user that was the space's whole history.
        ...(page.scope ? { scope: page.scope } : {}),
        // The server's own notes about this query: an undeclared kind, a match on an unindexed
        // path, the default oldest-first order. They come from the same code that answered, so
        // repeat them to the user instead of reasoning around them.
        ...(page.explain && page.explain.length > 0 ? { notes: page.explain } : {}),
        records: records.map(compact),
      };
    },

    // Counting is not querying. A page answers "show me some"; this answers "how many", which is
    // what an aggregation question actually needs. The model was computing percentages from
    // whatever 10 records it happened to see. Bounded by the server's own query cap, and it says so
    // rather than rounding the truth off.
    //
    // See `distinctKey` below for the other half: on a kind that keeps its history, how many
    // RECORDS matched is not how many THINGS there are.
    space_count: async (a) => {
      const CAP = 500; // the server's max query limit
      const page = await client.queryPage(
        { kind: String(a.kind ?? ""), match: a.match as Record<string, unknown> | undefined },
        CAP,
      );
      // A count is the shape most likely to be quoted as a fact about the space, so a narrowed one
      // has to say what it counted over.
      const scope = page.scope ? { scope: page.scope } : {};
      // A count of RECORDS is not a count of THINGS on a kind that keeps its history. Every registry
      // here (workspace, procedure, model, capability) is a latest-wins projection over successor
      // records, so a workspace saved fifteen times is fifteen records and one workspace — which is
      // exactly what got reported as "15 instances of a workspace named fireworks". The duplicate
      // key is visible in the records already fetched, so say it rather than leaving the caller to
      // multiply one thing by its own edit history.
      // Only on the EXACT branch: a distinct count over a page that stopped at the cap would be a
      // second number with the same defect as the first.
      return page.records.length >= CAP
        ? { count: CAP, exact: false, note: `at least ${CAP} records match; narrow the match for an exact count`, ...scope }
        : { count: page.records.length, exact: true, ...distinctKey(page.records), ...scope };
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
      // One past the limit, so "is this all of them?" is answerable. A count taken from a page
      // reads as a population, the same trap `space_query` warns about, and fan-out is exactly
      // where it bites: a conversation has a child per message.
      const page = await client.getChildrenPage(String(a.recordId ?? ""), limit + 1);
      const filtered = kind ? page.children.filter((r) => r.kind === kind) : page.children;
      const more = page.children.length > limit;
      return {
        count: filtered.slice(0, limit).length,
        more,
        ...(more
          ? { warning: `more children exist; this is a PAGE, not the total. Narrow with \`kind\`, or count with space_count.` }
          : {}),
        children: filtered.slice(0, limit).map(compact),
      };
    },

    /**
     * The tail of the event log this session may see.
     *
     * It PAGES, and that is the whole point. One page was not enough and failed in a way that read
     * as an answer: a scoped caller sees only events it caused, the server scans a bounded number
     * of raw pages per request, and on a busy space every one of those was somebody else's, so
     * "what happened in my space" returned `{events: [], withheld: 500}` on a log of 11,588,
     * forever, with the cursor stuck at the same place across retries. The caller's own events were
     * real and simply out of reach behind a wall of foreign ones.
     *
     * Two consequences of paging forward, both deliberate: raw pages are requested LARGE (the
     * server caps at 500) because the cost is per request, not per event scanned; and the newest
     * `limit` are kept rather than the first, because a question about a log means its end.
     */
    space_events: async (a) => {
      const limit = Math.min(Number(a.limit ?? 20) || 20, 50);
      let cursor = a.after != null ? String(a.after) : "0"; // opaque cursor
      const kept: { seq: unknown; op: string; kind?: string; state?: string; recordId?: string }[] = [];
      let withheld = 0;
      let withheldNote: string | undefined;
      let scope: unknown;
      let complete = false;
      for (let call = 0; call < 12; call++) {
        const page = await client.getEventsPage(cursor, 500);
        scope = page.scope ?? scope;
        withheld += page.withheld ?? 0;
        withheldNote = page.withheldNote ?? withheldNote;
        for (const e of page.events) {
          kept.push({ seq: e.seq, op: e.operation, kind: e.kind, state: e.state, recordId: e.recordId });
        }
        if (kept.length > limit) kept.splice(0, kept.length - limit); // keep the newest `limit`
        // No cursor movement means the log is exhausted, not that this page was empty.
        if (!page.nextAfter || page.nextAfter === cursor) {
          complete = true;
          break;
        }
        cursor = page.nextAfter;
      }
      return {
        events: kept,
        nextAfter: cursor,
        // `complete` distinguishes "this is the end of the log" from "I ran out of budget",
        // and `scope` keeps an empty answer from reading as an empty space.
        complete,
        ...(scope ? { scope } : {}),
        ...(withheld ? { withheld, withheldNote } : {}),
      };
    },

    /**
     * What this session may actually do: the fold over its grants, from the enforcement itself.
     *
     * Exists because inferring authority from the `scope` line of an unrelated answer does not
     * work, and the failure is confident: a session was granted exactly what it asked for, saw no
     * change in the call it retried (which was failing for a different reason), and told its user
     * the request was still awaiting approval. It could not check, so it guessed, and the guess
     * was wrong in the direction that wastes a person's time.
     *
     * Reads its OWN principal only, resolved from the server rather than passed in. A caller that
     * could name the principal could name someone else's.
     */
    space_permissions: async () => {
      const { principal } = await client.health();
      return { principal, ...(await client.permissions(principal) as Record<string, unknown>) };
    },

    space_digest: async () => {
      const d = await client.digest();
      return {
        ...d,
        ...(d.complete ? {} : { warning: "a registry read was truncated; this digest is a prefix, not the whole space" }),
      };
    },

    space_thread: async (a) => {
      const t = await client.thread(String(a.recordId ?? ""));
      return {
        root: t.root,
        count: t.records.length,
        ...(t.truncated ? { warning: "truncated at the node cap; this is a prefix of the story, not all of it" } : {}),
        records: t.records.map(compact),
      };
    },

    space_flows: async (a) => {
      const f = await client.flows({
        ...(a.granularity ? { granularity: String(a.granularity) as "kind" | "kind+agent" } : {}),
        ...(a.counts ? { counts: String(a.counts) as "bucketed" | "exact" } : {}),
      });
      return {
        ...f,
        ...(f.complete ? {} : { warning: "the scan did not finish; these shapes are mined from a PREFIX of the space" }),
      };
    },

    space_doctor: () => client.diagnostics(),
  };
}

export const INSPECT_SCHEMAS: ToolDef[] = [
  { type: "function", function: { name: "request_grant", description: "Ask the human for permission this session lacks. `kind` must be a RECORD KIND (the kinds records are stored under, like 'message' or 'artifact'), never a tool name: 'space_events' is a tool, and there is no record kind called that. If you cannot list the kinds, ask for what you actually want to read (the records) rather than naming the tool that reads them. When a space_* call fails with 'forbidden', that is not a bug and not something to work around. This session runs under a scoped identity, and the missing authority has to be granted by a person. Call this with the kind and operations you need and a plain-language reason; the human sees the request and decides. You cannot grant yourself anything. This call BLOCKS until the human answers and reports what you actually got, so when it returns `decision: granted`, RETRY the failed operation immediately IN THE SAME TURN. Ending your turn to ask the user to type 'retry' wastes a round trip and usually loses the thread. On `refused`, say so and stop; on `pending`, say what you asked for and stop.", parameters: { type: "object", properties: { kind: { type: "string", description: "The record kind you need access to, e.g. 'kind_def' or 'artifact'." }, operations: { type: "array", items: { type: "string", enum: ["put", "query", "read_one", "take"] }, description: "The coordination verbs you need on that kind." }, why: { type: "string", description: "Why you need it, in one sentence, for the human deciding." }, scope: { type: "string", enum: ["own", "all"], description: "Whose records you need: 'own' (the default) for a kind you WRITE (your messages, your tool calls), where reading your own is the whole point; 'all' for a kind written by someone else, where a grant over your own records authorizes a view of NOTHING. Registries and other agents' work are the 'all' case. Asking for 'own' on such a kind is the mistake to avoid: it is approved, it looks like access, and every read returns empty." } }, required: ["kind", "operations", "why"] } } },
  { type: "function", function: { name: "space_stats", description: "Counts of records by kind and state in the Radia space (a quick overview / health check).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_kinds", description: "List the registered record kinds and their indexed/sortable paths.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_query", description: "Find records by kind, with an optional match (equality/$gt/$in/$exists/…) and order_by. order_by is an array of {path, dir?} over the kind's SORTABLE paths only (list a kind's sortable paths with space_kinds), and only over fields in the record BODY. When a record was created is not a body field, so there is no way to sort by time. Without order_by, records come back in ascending record-id order; that is stable, not arbitrary, but it means a `limit` gives you the OLDEST matches, never the newest. So this is the wrong tool for 'the most recent X': use space_events (the event log is in time order) or narrow the match instead. Returns up to `limit` (default 10, max 25) records with size-capped bodies, plus `more`: true when further records match. The result is then a PAGE, so never count or compute percentages from it (space_stats has per-kind totals). The conversation itself is records: kind 'message' with match {conversationId}, order_by [{path:\"index\"}]. A `scope` in the answer means your GRANT narrowed the read: what came back is a slice of that kind, not the kind. Say so instead of describing it as everything, and do not try to widen it by guessing at kinds.", parameters: { type: "object", properties: { kind: { type: "string" }, match: { type: "object" }, orderBy: { type: "array", items: { type: "object", properties: { path: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["path"] } }, limit: { type: "integer" } }, required: ["kind"] } } },
  { type: "function", function: { name: "space_count", description: "How MANY records match, not which ones: {count, exact}. Use this for totals, distributions and percentages, counting each value separately (e.g. one call per tier) rather than counting the records a query happened to return. A count is over the WHOLE SPACE unless the match narrows it, so a question about this conversation must say so: {kind:'tool_call', match:{conversationId, tool:'run_code'}}. `exact` is false only when the match is too broad to count precisely. A `scope` in the answer means the count covers only the records your grant lets you read. Quote it as a count of the records you can see, never as the space's total. This counts RECORDS, and on a kind that keeps its history (workspace, procedure, model, capability: saving one again writes a successor) that is a count of versions rather than of things — a `distinct` field in the answer says so and gives the real number. For workspaces prefer list_workspaces, which projects them.", parameters: { type: "object", properties: { kind: { type: "string" }, match: { type: "object" } }, required: ["kind"] } } },
  { type: "function", function: { name: "space_record", description: "Fetch a single record by id.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_lineage", description: "The ANCESTRY (parent_ids, UP) of a record: {depth, id, kind}, i.e. how it was derived. A root record (e.g. a conversation) has no ancestors; to find what REFERENCES it, use space_children.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_children", description: "Records that REFERENCE this record via parent_ids: its children (DOWN, the reverse of lineage), with bodies. Use this to follow links from a root: a conversation's messages (kind:message) and llm_calls, an llm_call's chunks + result, a task's results. Optional `kind` filter (e.g. 'message'). Returns up to `limit` (default 25).", parameters: { type: "object", properties: { recordId: { type: "string" }, kind: { type: "string" }, limit: { type: "integer" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_events", description: "The most recent event-log entries (put/take/ack/nack/…) this session may see: {seq, op, kind, state, recordId}. It pages to the end of the log for you, so a scoped session still reaches its own activity past events belonging to others. `withheld` counts what was filtered out: activity performed by OTHER principals, not an error and not something a grant fixes, because the log is filtered by who acted, not by record kind, so do not request kind grants to widen it (say it needs an operator session instead), `complete` is false only if it ran out of paging budget, and `scope` says what the answer was narrowed to. An empty result with a `scope` means you saw everything you are allowed to see, NOT that the space is idle. Say so that way.", parameters: { type: "object", properties: { after: { type: "integer" }, limit: { type: "integer" } } } } },
  { type: "function", function: { name: "space_permissions", description: "What THIS session is actually allowed to do: the fold over its grants, per kind, with whether reads are narrowed to its own records. Use it whenever authority is in question: before claiming a grant is missing or still pending, and after a human approves a request, since the answer here is the enforcement itself rather than an inference from some other call's scope line. A grant on a kind that does not exist authorizes nothing, and will show up here as exactly that.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_digest", description: "Orient yourself in one call: every kind with its indexed/sortable paths and whether it is claimable, record counts by state, which workers are LISTENING for what (live interests), and what this session may do. Use it FIRST when asked what this space is or does, instead of stitching together space_kinds + space_stats + space_permissions. An `interestsNote` means other principals' interests were withheld from you: an empty or short interest list then says nothing about whether workers are running, so never report the fleet as idle on that basis.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "space_thread", description: "The WHOLE story around one record, in the order it happened: walks up to the root it descends from, then down through everything derived from it. Use for 'what led to this and what came of it' instead of chaining space_lineage + space_children yourself. A `warning` means the story was cut off at a cap; say so rather than presenting it as complete.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_flows", description: "The recurring SHAPES of work in this space, mined from what actually happened: signatures like `job → task×4-7 → result×4-7 → summary`, each with how often it occurred, how often it completed, median size and duration, and exemplar record ids. Use it for 'what does this space DO / what are the workflows here', which no other call answers: nothing declares a topology, so the shape only exists as a pattern across lineage. Shapes that start and rarely finish appear beside the ones that complete, and a low successRate on a frequent shape is the finding, not a gap in the data. `granularity` 'kind' merges agents together and 'kind+agent' (default) keeps them apart; `counts` 'bucketed' (default) makes a four-item and a five-item run the same flow while 'exact' splits them, so switch when everything looks unique. A signature reading `X ⇒ …` means a HUB of kind X was cut out so the work hanging off it could be counted separately: a long-lived record everything attaches to (a conversation), or a chain of versions of one thing (a workspace saved repeatedly). Those shapes are therefore per-turn rather than per-conversation. A signature starting `…` is a fragment whose parent was outside the scan. A `warning` means the scan was a prefix; say so rather than presenting the diagram as the whole space.", parameters: { type: "object", properties: { granularity: { type: "string", enum: ["kind", "kind+agent"] }, counts: { type: "string", enum: ["bucketed", "exact"] } } } } },
  { type: "function", function: { name: "space_doctor", description: "A derived health report: counts by state, dead-lettered records, expired-but-stuck leases, and records that have sat available/unclaimed. Use to answer 'is the space healthy / what's stuck?'. If the reply carries `undoneErasures` with a non-zero count, LEAD with it: a payload somebody destroyed is readable again, which matters more than anything else in the report. That field is absent for a scoped session, and its absence means you were not told, NOT that every erasure holds.", parameters: { type: "object", properties: {} } } },
];

// ---- remediation: the control-plane half ----
//
// `space_doctor` diagnoses; these fix. They bypass lease fencing (that is the point: they repair
// another worker's stuck record), so they are operator-gated and act as the SESSION principal.

export function makeRemediateTools(client: RadiaClient): Record<string, Tool> {
  // Each tool takes EITHER one record id or a selector. Draining a backlog one id at a time means
  // a call per record preceded by diagnostics calls just to learn the ids, and the report only
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
  { type: "function", function: { name: "space_reclaim", description: "Un-stick EXPIRED leases: force records back to available (attempt +1) so a worker can re-take them. Called with NO recordId it fixes EVERY expired lease (up to `limit`, default 200) in one call and returns {matched, applied, more}. Prefer that for a backlog instead of one id at a time, and repeat while `more` is true. Pass recordId only to fix exactly one. No effect on a valid (unexpired) lease.", parameters: { type: "object", properties: { recordId: { type: "string", description: "Fix just this record. Omit to fix all matching." }, limit: { type: "integer", description: "Max records per call (default 200, max 2000)." } } } } },
  { type: "function", function: { name: "space_dead_letter", description: "Give up on a record: force it to dead_letter (from available or leased). Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_requeue", description: "Retry a dead-lettered record: force it back to available. Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
];
