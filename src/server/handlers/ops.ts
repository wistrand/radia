// Handlers for the observe-and-operate plane, `/v0/ops/*`: stats, the event log, record and
// envelope introspection, lineage/children/graph, derived diagnostics, and control-plane
// remediation (reclaim / dead-letter / requeue / declassify).
//
// All of it goes through the public `Space` surface — no privileged backdoor. The dev console
// is a consumer of this plane, not its owner (the file was once called `dev.ts`, which read as
// "console support code" and undersold what lives here).

import type { Space } from "../../core/space.ts";
import type { RecordState, StatsScope } from "../../storage/adapter.ts";
import { problem } from "../problem.ts";

/**
 * How a scoped response describes itself.
 *
 * Without this, an empty scoped answer is indistinguishable from an empty SPACE — and that is not
 * hypothetical: a scoped session read `stats: []`, `events: []` and an all-zero diagnostics and
 * reported "the space is empty and healthy". Every scoped response therefore carries what it was
 * narrowed to, so "nothing here" can be read as "nothing YOU can see, of these kinds".
 */
function describeScope(scope?: StatsScope | null) {
  if (!scope) return undefined;
  return {
    self: true,
    kinds: scope.kinds ?? [],
    note: "scoped to your own records, on the kinds you are granted — an empty result means nothing " +
      "visible to you, NOT that the space is empty",
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
 * so both answer 404 — a 403 here would confirm the id exists, which is exactly the probe a
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
 * `{records:[{record, envelope}]}`. The substrate primitive diagnostics is a caller of.
 */
export async function handleEnvelopeQuery(space: Space, url: URL, scope?: StatsScope | null): Promise<Response> {
  const state = url.searchParams.get("state");
  const valid = new Set(["available", "leased", "consumed", "dead_letter", "expired"]);
  if (!state || !valid.has(state)) {
    return problem(400, "invalid_state", `state must be one of ${[...valid].join(", ")}`);
  }
  const expired = url.searchParams.get("expired") === "1" || url.searchParams.get("expired") === "true";
  // A query parameter is a string, so every numeric one needs a finiteness check: `Number("abc")`
  // is NaN, and a NaN `stale` reached date arithmetic and turned a bad request into a 500.
  const staleParam = url.searchParams.get("stale");
  let staleSeconds: number | undefined;
  if (staleParam !== null && staleParam !== "") {
    staleSeconds = Number(staleParam);
    if (!Number.isFinite(staleSeconds) || staleSeconds < 0) {
      return problem(400, "invalid_stale", `stale must be a non-negative number of seconds, got '${staleParam}'`);
    }
  }
  const limitParam = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100, 500);
  // deno-lint-ignore no-explicit-any
  const rows = await space.queryEnvelopes({ state: state as any, expired, staleSeconds, limit, scope: scope ?? undefined });
  return Response.json({ records: rows, scope: describeScope(scope) });
}

export async function handleEnvelope(space: Space, recordId: string, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const env = await space.getEnvelope(recordId);
  if (!env) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(env);
}

/**
 * The event log. A scoped caller sees only events IT CAUSED, on the kinds it is scoped to.
 *
 * The filter is on `runId` — the principal that performed the operation — which under-returns on
 * purpose: an event another agent caused on your record is not shown. Under-returning is the safe
 * direction, and the alternative (resolving every event's record to check its author) is a lookup
 * per event on the hottest read in the plane. Note that a filtered page can be short without being
 * the end of the log; the cursor still advances correctly, which is what an event log's paging
 * relies on.
 */
/** How many raw pages one scoped request will scan looking for events the caller may see. */
const EVENT_SCAN_PAGES = 20;

export async function handleEvents(space: Space, url: URL, scope?: StatsScope | null): Promise<Response> {
  const after = url.searchParams.get("after") ?? "0"; // opaque cursor, passed through
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);
  if (!scope) {
    const events = await space.getEvents(after, limit);
    return Response.json({ events, nextAfter: events[events.length - 1]?.cursor });
  }

  // A scoped caller sees only events IT CAUSED, on the kinds it is scoped to. The `runId` filter
  // under-returns on purpose: an event another agent caused on your record is not shown, and the
  // alternative — resolving every event's record to check its author — is a lookup per event on
  // the busiest read in the plane.
  //
  // FILTERING BREAKS CURSOR PAGING, which is the part that is easy to miss. An empty page is how
  // every caller detects the end of the log, so a page whose events were all withheld reads as
  // "nothing further" — and a scoped caller could never reach its own events past a run of foreign
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
    ...(mine.length < scanned ? { withheld: scanned - mine.length } : {}),
  });
}

export async function handleLineage(space: Space, recordId: string, scope?: StatsScope | null): Promise<Response> {
  if (!await visible(space, recordId, scope)) return problem(404, "not_found", `no record ${recordId}`);
  const lineage = await space.getLineage(recordId);
  if (!lineage.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ lineage });
}

/** Records that reference this one via parent_ids (its children — the reverse of lineage). */
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
  // it visible — another agent's result on your task is still theirs.
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
  const graph = await space.getGraph(recordId, { excludeKinds });
  if (!graph.nodes.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(graph);
}

export async function handleDiagnostics(space: Space, scope?: StatsScope | null): Promise<Response> {
  return Response.json({ ...await space.diagnostics(scope ?? undefined), scope: describeScope(scope) });
}

/** Privileged declassify (operator-gated via the /ops boundary): emit a clean successor. */
export async function handleDeclassify(space: Space, recordId: string): Promise<Response> {
  const out = await space.declassify(recordId);
  if (!out) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ declassifiedFrom: recordId, id: out.id });
}

/** Control-plane remediation (bypasses lease fencing; grant-gated with real auth). */
/** Selector-driven remediation: fix everything matching, instead of one id at a time. The body is
 *  the same envelope selector `GET /v0/ops/records` takes, so diagnosing and fixing share one
 *  vocabulary. */
export async function handleRemediate(space: Space, req: Request): Promise<Response> {
  let j: Record<string, unknown>;
  try {
    const parsed = await req.json();
    // `null` and `[]` are valid JSON but not objects — without this the field reads below throw.
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
  const out = await space.remediate(action, {
    state: state as RecordState,
    expired: j.expired === true,
    staleSeconds: typeof j.stale === "number" && Number.isFinite(j.stale) && j.stale >= 0 ? j.stale : undefined,
    limit: typeof j.limit === "number" ? j.limit : undefined,
  });
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
