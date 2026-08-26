// Handlers for the observe-and-operate plane, `/v0/ops/*`: stats, the event log, record and
// envelope introspection, lineage/children/graph, derived diagnostics, and control-plane
// remediation (reclaim / dead-letter / requeue / declassify).
//
// All of it goes through the public `Space` surface. There is no privileged backdoor. The dev
// console is a consumer of this plane, not its owner.

import type { Space } from "../../core/space.ts";
import type { RecordState, StatsScope } from "../../storage/adapter.ts";
import { problem, rejectUnknown, statusFor } from "../problem.ts";
import { RadiaError } from "../../core/errors.ts";

/**
 * How a scoped response describes itself.
 *
 * Without this, an empty scoped answer is indistinguishable from an empty SPACE: a scoped session
 * reads `stats: []`, `events: []` and an all-zero diagnostics, and reports "the space is empty and
 * healthy". Every scoped response therefore carries what it was narrowed to, so "nothing here" can
 * be read as "nothing YOU can see, of these kinds".
 */
function describeScope(scope?: StatsScope | null) {
  if (!scope) return undefined;
  const more = scope.alsoReadable ?? [];
  return {
    self: true,
    kinds: scope.kinds ?? [],
    // Kinds this caller can READ in full even though these counts cover only its own records. Not
    // a caveat about completeness in general. It is a specific, checkable statement that `query` on
    // these kinds returns more than the number above, so the number is never mistaken for a total.
    ...(more.length > 0 ? { alsoReadableInFull: more } : {}),
    note: "scoped to your own records, on the kinds you are granted. An empty result means nothing " +
      "visible to you, NOT that the space is empty" +
      (more.length > 0
        ? `. Your grants let you READ every record of ${more.join(", ")}, so a query there returns more than these counts`
        : ""),
  };
}

/** What a principal can actually do. Operator-only: it is an authorization view of another
 *  principal, which is not something a self scope should ever reach. */
export async function handlePermissions(space: Space, url: URL): Promise<Response> {
  const principal = url.searchParams.get("principal");
  if (!principal) return problem(400, "invalid_request", "principal is required");
  return Response.json(await space.effectivePermissions(principal));
}

export async function handleStats(space: Space, scope?: StatsScope | null): Promise<Response> {
  return Response.json({ stats: await space.stats(scope ?? undefined), scope: describeScope(scope) });
}

/**
 * Per-record ops reads are scoped by a VISIBILITY check rather than a filter: fetch, then decide.
 *
 * A scoped principal must not be able to distinguish "someone else's record" from "no such record",
 * so both answer 404. A 403 here would confirm the id exists, which is exactly the probe a
 * per-record endpoint invites.
 */
async function visible(space: Space, recordId: string, scope?: StatsScope | null): Promise<boolean> {
  if (!scope) return true;
  const rec = await space.getRecord(recordId);
  if (!rec) return false;
  const okKind = !scope.kinds || scope.kinds.includes(rec.kind);
  const okAuthor = !scope.createdBy || scope.createdBy.includes(rec.runtimeMeta.createdBy);
  return okKind && okAuthor;
}

/**
 * Envelope query: records filtered by runtime state (the envelope dimension the content-routing
 * query language deliberately excludes). `?state=leased&expired=1&stale=60&limit=100`. Returns
 * `{records:[{record, envelope}]}`. The runtime primitive diagnostics is a caller of.
 */
export async function handleEnvelopeQuery(space: Space, url: URL, scope?: StatsScope | null): Promise<Response> {
  const state = url.searchParams.get("state");
  const valid = new Set(["available", "leased", "consumed", "dead_letter"]);
  if (!valid.has(state ?? "")) {
    // `expired` is the one people reach for and it is NOT a state. A lapsed lease leaves the
    // record `leased`. Never accept it and answer zero rows: that reads as "no expired leases"
    // rather than "wrong question", so it is named explicitly here.
    const hint = state === "expired" ? " (expiry is a predicate over leased records: state=leased&expired=1)" : "";
    return problem(400, "invalid_state", `state must be one of ${[...valid].join(", ")}${hint}`);
  }
  const expired = url.searchParams.get("expired") === "1" || url.searchParams.get("expired") === "true";
  // A query parameter is a string, so every numeric one needs a finiteness check: `Number("abc")`
  // is NaN, and a NaN `stale` in date arithmetic turns a bad request into a 500.
  const staleParam = url.searchParams.get("stale");
  let staleSeconds: number | undefined;
  if (staleParam !== null && staleParam !== "") {
    staleSeconds = Number(staleParam);
    if (!Number.isFinite(staleSeconds) || staleSeconds < 0) {
      return problem(400, "invalid_stale", `stale must be a non-negative number of seconds, got '${staleParam}'`);
    }
  }
  // `kind` is REPEATABLE (`?kind=a&kind=b`) and also accepts one comma-separated value, because
  // both spellings are what people try. Absent means every kind, which is what this endpoint
  // always answered.
  const kindParams = url.searchParams.getAll("kind").flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
  const kinds = kindParams.length > 0 ? kindParams : undefined;
  const limitParam = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100, 500);
  // deno-lint-ignore no-explicit-any
  const rows = await space.queryEnvelopes({ state: state as any, expired, staleSeconds, limit, kinds, scope: scope ?? undefined });
  return Response.json({ records: rows, scope: describeScope(scope) });
}

export async function handleEnvelope(space: Space, recordId: string, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const env = await space.getEnvelope(recordId);
  if (!env) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(env);
}

/** How many raw pages one scoped request will scan looking for events the caller may see. */
const EVENT_SCAN_PAGES = 20;

/**
 * The event log. A scoped caller sees only events IT CAUSED, on the kinds it is scoped to.
 *
 * The filter is on `runId` (the principal that performed the operation), which under-returns on
 * purpose: an event another agent caused on your record is not shown. Under-returning is the safe
 * direction, and the alternative (resolving every event's record to check its author) is a lookup
 * per event on the hottest read in the plane. Note that a filtered page can be short without being
 * the end of the log; the cursor still advances correctly, which is what an event log's paging
 * relies on.
 */
export async function handleEvents(space: Space, url: URL, scope?: StatsScope | null): Promise<Response> {
  const after = url.searchParams.get("after") ?? "0"; // opaque cursor, passed through
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);
  // `tail=N`: the newest N events, ascending, plus a cursor to FOLLOW from. A live view starting
  // at "0" replays the whole log to reach the present, which reads as history when the question
  // is "what is happening"; a view starting at the high-water shows nothing until something
  // moves. The tail is the third answer, and `nextAfter` is always usable, even on an empty log.
  const tailRaw = url.searchParams.get("tail");
  if (tailRaw !== null) {
    const tail = Math.min(Math.max(Number(tailRaw) || 0, 1), 500);
    const raw = await space.latestEvents(tail);
    const events = scope
      ? raw.filter((e) =>
        (!scope.createdBy || scope.createdBy.includes(e.runId)) &&
        (!scope.kinds || (e.kind !== undefined && scope.kinds.includes(e.kind))))
      : raw;
    return Response.json({
      events,
      // From the last RAW event, scoped or not, so a follower advances past what it cannot see.
      nextAfter: raw.length ? raw[raw.length - 1].cursor : await space.latestCursor(),
      ...(scope ? { scope: describeScope(scope) } : {}),
    });
  }
  // A read starting below the event-GC horizon mechanically begins at the oldest retained event;
  // the clamp is free. What must not be free is the caller believing it read from genesis, so the
  // response says where the log now begins. Unlike the watch's 410, the sentinel is INCLUDED:
  // "after=0" is exactly the read that needs the note.
  const h = await space.eventHorizon(after);
  const truncated = h.expired && h.horizon ? { logBeginsAfter: h.horizon.cursor, sweptBefore: h.horizon.swept } : {};
  if (!scope) {
    const events = await space.getEvents(after, limit);
    return Response.json({ events, nextAfter: events[events.length - 1]?.cursor, ...truncated });
  }

  // A scoped caller sees only events IT CAUSED, on the kinds it is scoped to. The `runId` filter
  // under-returns on purpose: an event another agent caused on your record is not shown, and the
  // alternative (resolving every event's record to check its author) is a lookup per event on
  // the busiest read in the plane.
  //
  // FILTERING BREAKS CURSOR PAGING, which is the part that is easy to miss. An empty page is how
  // every caller detects the end of the log, so a page whose events were all withheld reads as
  // "nothing further". A scoped caller could then never reach its own events past a run of foreign
  // ones. Two things fix that: scan forward across raw pages rather than filtering one, and report
  // `nextAfter` from the last RAW event examined, so the caller can advance past what it cannot see.
  const mine = [];
  let cursor = after;
  let scanned = 0;
  for (let page = 0; page < EVENT_SCAN_PAGES && mine.length < limit; page++) {
    const raw = await space.getEvents(cursor, limit);
    if (raw.length === 0) break; // genuinely the end of the log
    scanned += raw.length;
    cursor = raw[raw.length - 1].cursor;
    for (const e of raw) {
      if (mine.length >= limit) break;
      const okRun = !scope.createdBy || scope.createdBy.includes(e.runId);
      const okKind = !scope.kinds || (e.kind !== undefined && scope.kinds.includes(e.kind));
      if (okRun && okKind) mine.push(e);
    }
  }
  return Response.json({
    events: mine,
    nextAfter: cursor === after ? undefined : cursor,
    scope: describeScope(scope),
    ...truncated,
    ...(mine.length < scanned
      ? {
        withheld: scanned - mine.length,
        // WHY, because the number alone reads as "ask for a grant and this goes away". It
        // does not. The filter is on which principal PERFORMED the operation, so no grant on any
        // record kind widens it. Sessions burned turn after turn requesting kind grants (and
        // inventing kinds to request) chasing an answer this endpoint cannot give them; saying so
        // once, here, is cheaper than every caller learning it by exhaustion.
        withheldNote: "events are filtered by which principal performed the operation, not by " +
          "record kind. No grant on a kind widens this. Seeing another principal's activity " +
          "needs an operator session.",
      }
      : {}),
  });
}

export async function handleLineage(space: Space, recordId: string, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  // Scoped like every other read. Reaching a visible record does not make its ancestors visible:
  // `put` does not check that a parent is readable, so naming a foreign id as a parent of your own
  // record would otherwise return that record's entire upstream, bodies included.
  const lineage = await space.getLineage(recordId, undefined, scope?.createdBy);
  if (!lineage.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ lineage, scope: describeScope(scope) });
}

/** Records that reference this one via parent_ids (its children, the reverse of lineage). */
export async function handleChildren(
  space: Space,
  recordId: string,
  scope?: StatsScope | null,
  url?: URL,
): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const limitParam = Number(url?.searchParams.get("limit") ?? "100");
  const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100, 500);
  const after = url?.searchParams.get("after") ?? undefined;
  const children = await space.getChildren(recordId, limit, after ? { after } : undefined);
  // The children are filtered too: reaching a visible record does not make everything hanging off
  // it visible. Another agent's result on your task is still theirs.
  const shown = scope ? children.filter((c) => visibleRec(c, scope)) : children;
  return Response.json({
    children: shown,
    // The cursor is the last child of the RAW page: a scoped caller whose page was filtered empty
    // must still be able to advance, the same reason `ops/events` reports its own cursor.
    nextAfter: children.length === limit ? children[children.length - 1]?.id : undefined,
    scope: describeScope(scope),
  });
}

function visibleRec(rec: { kind: string; runtimeMeta: { createdBy: string } }, scope: StatsScope): boolean {
  return (!scope.kinds || scope.kinds.includes(rec.kind)) &&
    (!scope.createdBy || scope.createdBy.includes(rec.runtimeMeta.createdBy));
}

export async function handleGetRecord(space: Space, recordId: string, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const rec = await space.getRecord(recordId);
  if (!rec) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(rec);
}

export async function handleGraph(space: Space, recordId: string, url: URL, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const excludeParam = url.searchParams.get("exclude");
  const excludeKinds = new Set((excludeParam ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  // Anything but the explicit "down" is the both-ways default, so an unknown value narrows nothing.
  const direction = url.searchParams.get("direction") === "down" ? "down" as const : "both" as const;
  const graph = await space.getGraph(recordId, { excludeKinds, direction, createdBy: scope?.createdBy });
  if (!graph.nodes.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ ...graph, scope: describeScope(scope) });
}

export async function handleDiagnostics(space: Space, scope?: StatsScope | null): Promise<Response> {
  return Response.json({ ...await space.diagnostics(scope ?? undefined), scope: describeScope(scope) });
}

/**
 * Every erasure, and whether it still holds.
 *
 * OPERATOR-ONLY by living on this plane, which is right for two reasons: a shred record names an
 * artifact somebody destroyed, and the answer is only actionable by whoever could shred again.
 *
 * `?undone=true` narrows to the ones that were REVERSED, which is the question anyone actually has.
 */
export async function handleErasures(space: Space, url: URL): Promise<Response> {
  const onlyUndone = url.searchParams.get("undone") === "true";
  const r = await space.erasures({ onlyUndone });
  return Response.json({
    ...r,
    // Never let an empty list read as "every erasure holds" when the scan stopped early. This is the
    // bounded-read-as-population trap, and an erasure report is the worst place to fall into it.
    ...(r.complete ? {} : {
      note: `the scan did not reach the end after ${r.checked} shred records; this list is a PREFIX, ` +
        `not a population`,
    }),
    ...(onlyUndone && r.erasures.length === 0 && r.complete
      ? { note: `all ${r.checked} erasures still hold: no shredded payload is readable again` }
      : {}),
  });
}

/**
 * Dry run: which registered interests would receive this record?
 *
 * A read of the interest registry, so it sits on the observe plane rather than beside `put`. It
 * answers before the write, which is the point: the question is about a draft.
 */
export async function handleDryRun(space: Space, req: Request): Promise<Response> {
  let j: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return problem(400, "invalid_body", "expected a JSON object");
  }
  if (!j || typeof j.kind !== "string" || j.kind.length === 0) {
    return problem(400, "invalid_body", "expected {kind: string, body?: unknown}");
  }
  const { interests, complete } = await space.matchingInterests(j.kind, j.body);
  return Response.json({
    kind: j.kind,
    interests,
    // An interest registry is unbounded in principle, so say when the answer is a prefix rather
    // than letting "no interests" mean two different things.
    ...(complete ? {} : { complete: false }),
    ...(interests.length === 0
      ? {
        note: "no live interest matches this record. Either nothing is listening for it, or the " +
          "workers that would are not running: an interest is only live while its run is.",
      }
      : {}),
  });
}

/**
 * Recompute the event chain and report the first divergence.
 *
 * OPERATOR-ONLY by living on this plane, and the answer is deliberately shaped so it cannot be
 * quoted as more than it is: `signed:false` means the chain detects corruption and naive edits but
 * not a rewrite, since anyone who can edit a row can recompute the hashes after it.
 */
export async function handleIntegrity(space: Space): Promise<Response> {
  const r = await space.verifyIntegrity();
  return Response.json({
    ...r,
    ...(r.signed ? {} : {
      note: "this chain is NOT signed, so it detects corruption and careless edits but not a " +
        "deliberate rewrite: anyone who can write to the database can recompute every hash. " +
        "Set RADIA_SEAL_KEY (or run with --seal-key) to anchor it under a key the database does not hold.",
    }),
    ...(r.unsealed > 0 ? {
      unsealedNote: `${r.unsealed}+ events are committed but not yet sealed; sealing follows the ` +
        "log's finality watermark, so the most recent activity is always outside the chain",
    } : {}),
    ...(r.truncated ? {
      truncatedNote: `the chain begins at idx ${r.truncated.anchorIdx}: ${r.truncated.swept} ` +
        `events were removed by event-log GC, ` +
        (r.truncated.attested
          ? (r.signed
            ? "attested by the anchor's signature and a sealed horizon statement"
            : "with a sealed horizon statement; on an UNSIGNED chain that is naive-edit evidence only")
          : "and nothing attests the truncation"),
    } : {}),
  });
}

/**
 * Recurring shapes of work, mined from lineage: the workflow diagram nobody wrote.
 *
 * Both granularity knobs are query parameters because neither setting is knowable in advance, and
 * the failure of a mined shape is silent: too fine and every run is unique, too coarse and
 * everything is one flow. A caller that cannot vary them cannot tell which it is looking at.
 */
export async function handleFlows(space: Space, url: URL, scope?: StatsScope | null): Promise<Response> {
  const p = url.searchParams;
  const granularity = p.get("granularity") ?? "kind+agent";
  const counts = p.get("counts") ?? "bucketed";
  if (granularity !== "kind" && granularity !== "kind+agent") {
    return problem(400, "invalid_query", `granularity must be 'kind' or 'kind+agent', got '${granularity}'`);
  }
  if (counts !== "bucketed" && counts !== "exact") {
    return problem(400, "invalid_query", `counts must be 'bucketed' or 'exact', got '${counts}'`);
  }
  const num = (name: string): number | undefined => {
    const raw = p.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  // Body paths to sum per shape. Validated to the same grammar a kind declaration accepts, and
  // capped: each path is resolved once per scanned record, so an open-ended list is a scan
  // multiplier handed to the caller.
  const sum = (p.get("sum") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (sum.length > 4) return problem(400, "invalid_query", `sum accepts at most 4 paths, got ${sum.length}`);
  for (const path of sum) {
    if (path.length > 128 || !path.split(".").every((seg) => seg.length > 0)) {
      return problem(400, "invalid_query", `invalid sum path '${path}'`);
    }
  }
  const r = await space.flows({
    granularity,
    counts,
    maxRecords: num("max_records"),
    minOccurrences: num("min_occurrences"),
    hubDegree: num("hub_degree"),
    includeReserved: p.get("include_reserved") === "true",
    includeSingletons: p.get("include_singletons") === "true",
    ...(sum.length > 0 ? { sum } : {}),
    scope: scope ?? undefined,
  });
  return Response.json({
    ...r,
    scope: describeScope(scope),
    // A mined shape read as the population is this feature's version of the bounded-read bug, and
    // it is worse here than elsewhere: the answer LOOKS like a complete diagram either way.
    ...(r.flows.length === 0
      ? {
        note: "no shapes were mined. Either nothing has run yet, or every record here is unrelated " +
          "to every other: a flow needs parent_ids, and work that never links is work with no shape.",
      }
      : {}),
  });
}

/** One read that orients an investigator: what kinds exist, what is in them, who is listening,
 *  and what the caller may do. Generated from records so it cannot drift. */
export async function handleDigest(space: Space, principal: string, scope?: StatsScope | null): Promise<Response> {
  const d = await space.digest(principal, scope);
  return Response.json({
    ...d,
    scope: describeScope(scope),
    // Never let an empty scoped list read as an empty space. A session sees only the interests it
    // published, and it publishes none unless it is a worker, so without this it reports "nothing
    // is listening" about a fleet that is running.
    ...(d.interestsWithheld
      ? {
        interestsNote: `${d.interestsWithheld} interests belong to other principals and are not shown. ` +
          "This does NOT mean nothing is listening; seeing the whole routing table needs an operator session.",
      }
      : {}),
  });
}

/** The causally ordered story around a record: its lineage root, then everything descended from it. */
export async function handleThread(
  space: Space,
  recordId: string,
  scope?: StatsScope | null,
): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const out = await space.thread(recordId, { createdBy: scope?.createdBy });
  if (out.records.length === 0) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({
    ...out,
    scope: describeScope(scope),
    // A truncated story read as a whole one is the failure this verb exists to prevent, so say it
    // rather than leaving the caller to infer it from a suspiciously round count.
    ...(out.truncated ? { note: "the story was truncated at the node cap; it is a prefix, not the whole thread" } : {}),
  });
}

/**
 * Privileged declassify (operator-gated via the /ops boundary): emit a successor carrying the
 * labels that were NOT cleared.
 *
 * PER LABEL, which `Space.declassify` has always supported and this handler used to discard: it
 * ignored the body and cleared everything, so the design had no caller and the spec described a
 * feature no request could reach. An absent or empty `labels` still clears all of them, which is
 * what a caller that names nothing means.
 *
 * The answer reports `cleared` and `remaining` rather than an id alone. A clearance that does not
 * say what it was FOR is the weakness the per-label design exists to remove, and an operator who
 * named one label needs to see the others still standing.
 */
export async function handleDeclassify(
  space: Space,
  req: Request,
  recordId: string,
  principal: string,
): Promise<Response> {
  let labels: string[] | undefined;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return problem(400, "invalid_body", "expected a JSON object, or no body at all to clear every label");
    }
    const j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    if (!j) return problem(400, "invalid_body", "expected a JSON object, or no body at all to clear every label");
    if (j.labels !== undefined) {
      if (!Array.isArray(j.labels) || j.labels.some((l) => typeof l !== "string")) {
        return problem(400, "invalid_body", "labels must be an array of strings");
      }
      labels = j.labels as string[];
    }
  }
  try {
    const out = await space.declassify(recordId, principal, labels ? { labels } : undefined);
    if (!out) return problem(404, "not_found", `no record ${recordId}`);
    return Response.json({ declassifiedFrom: recordId, id: out.id, cleared: out.cleared, remaining: out.remaining });
  } catch (e) {
    // An unrecognized label is a 400, not a 500: the vocabulary is closed and the caller named
    // something outside it.
    if (e instanceof RadiaError) return problem(statusFor(e.code, 400), e.code, e.message);
    throw e;
  }
}

/** Selector-driven control-plane remediation: fix everything matching, not one id at a time
 *  (bypasses lease fencing; grant-gated). The body is the same envelope selector
 *  `GET /v0/ops/records` takes, so diagnosing and fixing share one vocabulary. */
export async function handleRemediate(space: Space, req: Request): Promise<Response> {
  let j: Record<string, unknown>;
  try {
    const parsed = await req.json();
    // `null` and `[]` are valid JSON but not objects. Without this the field reads below throw.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return problem(400, "invalid_body", "expected a JSON object");
    }
    j = parsed as Record<string, unknown>;
  } catch {
    return problem(400, "invalid_body", "expected a JSON object");
  }
  const action = String(j.action ?? "");
  if (action !== "reclaim" && action !== "dead-letter" && action !== "requeue") {
    return problem(400, "invalid_action", `action must be reclaim | dead-letter | requeue, got '${action}'`);
  }
  const state = String(j.state ?? "");
  if (!["available", "leased", "consumed", "dead_letter"].includes(state)) {
    return problem(400, "invalid_state", `state must be available | leased | consumed | dead_letter, got '${state}'`);
  }
  // The SAME selector the envelope query takes, which is the whole point of this endpoint: `kind`
  // here means what it means there. A string is accepted beside an array because a caller
  // remediating one kind writes the string.
  const kindField = j.kind ?? j.kinds;
  let kinds: string[] | undefined;
  if (typeof kindField === "string") kinds = [kindField];
  else if (Array.isArray(kindField)) {
    if (kindField.some((k) => typeof k !== "string")) return problem(400, "invalid_body", "kind must be a string or an array of strings");
    kinds = kindField as string[];
  } else if (kindField !== undefined) {
    return problem(400, "invalid_body", "kind must be a string or an array of strings");
  }
  // Every field here NARROWS, so dropping one widens a sweep that mutates lease state: a misspelled
  // `kind` drains every app's backlog rather than one (the reason `kind` exists), and a misspelled
  // `stale` or `limit` removes the bound the caller thought it set.
  const badSelector = rejectUnknown(j, ["action", "state", "kind", "kinds", "expired", "stale", "limit"], "selector field");
  if (badSelector) return badSelector;
  // Typed strictly for the same reason: `expired: "true"` is a string, `=== true` is false, and the
  // sweep would then reclaim LIVE leases from a caller that asked only for lapsed ones.
  if (j.expired !== undefined && typeof j.expired !== "boolean") {
    return problem(400, "invalid_body", "expired must be a boolean");
  }
  const out = await space.remediate(action, {
    state: state as RecordState,
    expired: j.expired === true,
    staleSeconds: typeof j.stale === "number" && Number.isFinite(j.stale) && j.stale >= 0 ? j.stale : undefined,
    limit: typeof j.limit === "number" ? j.limit : undefined,
    ...(kinds && kinds.length > 0 ? { kinds } : {}),
  });
  return Response.json(out);
}

/** The retention sweep (`Space.gc`): on demand, gated by ops power. A DRY run is a read (the
 *  gate admits it with `observe`; it is how `doctor` reports the backlog); a LIVE run deletes,
 *  so it demands the `sweep` power, decided here because only the parsed body says which one
 *  this is. */
export async function handleGc(space: Space, req: Request, principal: string, allowLive: boolean): Promise<Response> {
  let j: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return problem(400, "invalid_body", "expected a JSON object");
      }
      j = parsed as Record<string, unknown>;
    }
  } catch {
    return problem(400, "invalid_body", "expected a JSON object");
  }
  if (j.dryRun !== true && !allowLive) {
    return problem(403, "forbidden", "'sweep' ops power required for a live gc; dryRun:true needs only 'observe'");
  }
  const out = await space.gc({
    limit: typeof j.limit === "number" && Number.isFinite(j.limit) ? j.limit : undefined,
    dryRun: j.dryRun === true,
    compact: j.compact !== false,
    principal,
  });
  return Response.json(out);
}

/** Finish a KEK rotation (`Space.rewrapBlobs`): re-seal referenced payloads under the current key.
 *  Gated like a live gc, because it rewrites stored bytes; `dryRun` reports what a live pass would
 *  touch. A store with no cipher answers 400 rather than a row of zeroes that would read as done. */
export async function handleRewrap(space: Space, req: Request, allowLive: boolean): Promise<Response> {
  let j: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return problem(400, "invalid_body", "expected a JSON object");
      }
      j = parsed as Record<string, unknown>;
    }
  } catch {
    return problem(400, "invalid_body", "expected a JSON object");
  }
  if (j.dryRun !== true && !allowLive) {
    return problem(403, "forbidden", "'sweep' ops power required for a live rewrap; dryRun:true needs only 'observe'");
  }
  const out = await space.rewrapBlobs({ dryRun: j.dryRun === true });
  if (!out) return problem(400, "not_encrypted", "this space's blob store has no key, so there is nothing to re-seal");
  return Response.json(out);
}

export async function handleAdmin(space: Space, recordId: string, action: string): Promise<Response> {
  let applied: boolean;
  if (action === "reclaim") applied = await space.reclaim(recordId);
  else if (action === "dead-letter") applied = await space.forceDeadLetter(recordId);
  else if (action === "requeue") applied = await space.requeue(recordId);
  else return problem(404, "not_found", `unknown admin action ${action}`);
  return Response.json({ action, recordId, applied });
}
