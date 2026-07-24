// Read-only handlers backing the dev UI overview: space stats, registered kinds, and a
// single record's envelope. All use the public Space surface; no privileged backdoor.

import type { Space } from "../../core/space.ts";
import { problem } from "../problem.ts";

export async function handleStats(space: Space): Promise<Response> {
  return Response.json({ stats: await space.stats() });
}

export function handleListKinds(space: Space): Response {
  return Response.json({ kinds: space.listKinds() });
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
