// Read-only handlers backing the dev UI overview: space stats, registered kinds, and a
// single record's envelope. All use the public Space surface; no privileged backdoor.

import type { Space } from "../../core/space.ts";
import { problem } from "../problem.ts";

export async function handleStats(space: Space): Promise<Response> {
  return Response.json({ stats: await space.stats() });
}

/**
 * Envelope query: records filtered by runtime state (the envelope dimension the content-routing
 * query language deliberately excludes). `?state=leased&expired=1&stale=60&limit=100`. Returns
 * `{records:[{record, envelope}]}`. The substrate primitive diagnostics is a caller of.
 */
export async function handleEnvelopeQuery(space: Space, url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  const valid = new Set(["available", "leased", "consumed", "dead_letter", "expired"]);
  if (!state || !valid.has(state)) {
    return problem(400, "invalid_state", `state must be one of ${[...valid].join(", ")}`);
  }
  const expired = url.searchParams.get("expired") === "1" || url.searchParams.get("expired") === "true";
  const staleParam = url.searchParams.get("stale");
  const staleSeconds = staleParam ? Number(staleParam) : undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500);
  // deno-lint-ignore no-explicit-any
  const rows = await space.queryEnvelopes({ state: state as any, expired, staleSeconds, limit });
  return Response.json({ records: rows });
}

export async function handleEnvelope(space: Space, recordId: string): Promise<Response> {
  const env = await space.getEnvelope(recordId);
  if (!env) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(env);
}

export async function handleEvents(space: Space, url: URL): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? "0") || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);
  return Response.json({ events: await space.getEvents(after, limit) });
}

export async function handleLineage(space: Space, recordId: string): Promise<Response> {
  const lineage = await space.getLineage(recordId);
  if (!lineage.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ lineage });
}

/** Records that reference this one via parent_ids (its children — the reverse of lineage). */
export async function handleChildren(space: Space, recordId: string): Promise<Response> {
  return Response.json({ children: await space.getChildren(recordId) });
}

export async function handleGetRecord(space: Space, recordId: string): Promise<Response> {
  const rec = await space.getRecord(recordId);
  if (!rec) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(rec);
}

export async function handleGraph(space: Space, recordId: string, url: URL): Promise<Response> {
  const excludeParam = url.searchParams.get("exclude");
  const excludeKinds = new Set((excludeParam ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const graph = await space.getGraph(recordId, { excludeKinds });
  if (!graph.nodes.length) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json(graph);
}

export async function handleDiagnostics(space: Space): Promise<Response> {
  return Response.json(await space.diagnostics());
}

/** Privileged declassify (operator-gated via the /ops boundary): emit a clean successor. */
export async function handleDeclassify(space: Space, recordId: string): Promise<Response> {
  const out = await space.declassify(recordId);
  if (!out) return problem(404, "not_found", `no record ${recordId}`);
  return Response.json({ declassifiedFrom: recordId, id: out.id });
}

/** Control-plane remediation (bypasses lease fencing; grant-gated with real auth). */
export async function handleAdmin(space: Space, recordId: string, action: string): Promise<Response> {
  let applied: boolean;
  if (action === "reclaim") applied = await space.reclaim(recordId);
  else if (action === "dead-letter") applied = await space.forceDeadLetter(recordId);
  else if (action === "requeue") applied = await space.requeue(recordId);
  else return problem(404, "not_found", `unknown admin action ${action}`);
  return Response.json({ action, recordId, applied });
}
