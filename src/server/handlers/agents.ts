// The bootstrap-chain endpoints: human/operator creates an agent DEFINITION (assigns grants,
// gets a definition token); a definition token MINTS a short-lived run token; a run can be
// STOPPED. Tokens are returned once and never stored (only their hash). These are the auth
// substrate. Each does its own principal check, so they sit outside the blanket /ops/* gate.

import type { Space } from "../../core/space.ts";
import type { GrantDef } from "../../core/kinds.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem } from "../problem.ts";

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await req.json();
    return j && typeof j === "object" && !Array.isArray(j) ? j as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get("Authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length).trim() : undefined;
}

/** POST /v0/agent-definitions: operator only. Body {agent, grants?}. Returns {agent, definitionToken}. */
export async function handleCreateDefinition(space: Space, req: Request, principal: string): Promise<Response> {
  if (!space.isPrivileged(principal)) {
    return problem(403, "forbidden", `principal '${principal}' may not create agent definitions`);
  }
  const j = await readJson(req);
  if (!j || typeof j.agent !== "string") {
    return problem(400, "invalid_body", "expected {agent: string, grants?: GrantDef[]}");
  }
  const grants = Array.isArray(j.grants) ? j.grants as GrantDef[] : [];
  try {
    const out = await space.createAgentDefinition(j.agent, grants);
    return new Response(JSON.stringify(out), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(422, e.code, e.message);
    throw e;
  }
}

/** POST /v0/agent-runs: presents a definition token (Bearer). Returns {run, agent, runToken, expiresAt}. */
export async function handleCreateRun(space: Space, req: Request): Promise<Response> {
  const token = bearer(req);
  if (!token) return problem(401, "missing_credential", "minting a run requires a definition token (Authorization: Bearer)");
  try {
    const out = await space.mintRun(token);
    return new Response(JSON.stringify(out), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) return problem(401, e.code, e.message);
    throw e;
  }
}

/** POST /v0/agent-runs/{id}/stop: operator, or the run's own definition token (Bearer).
 *  Body `{quarantine: true}` upgrades graceful stop to emergency revocation (invalidate leases). */
export async function handleStopRun(space: Space, req: Request, principal: string, runId: string): Promise<Response> {
  let allowed = space.isPrivileged(principal);
  if (!allowed) {
    const token = bearer(req);
    if (token) {
      const r = await space.resolveToken(token);
      allowed = r.ok && ((r.kind === "def" && await space.agentForRun(runId) === r.agent) ||
        (r.kind === "run" && r.principal === runId));
    }
  }
  if (!allowed) return problem(403, "forbidden", "stopping a run requires an operator or the run's own definition/run token");
  const j = await readJson(req);
  const quarantine = j?.quarantine === true;
  const { applied, quarantined } = await space.stopRun(runId, { quarantine });
  if (!applied) return problem(404, "not_found", `no run ${runId}`);
  return Response.json({ run: runId, status: "stopped", applied, quarantined });
}
