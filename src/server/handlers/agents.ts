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

/** How much JSON an UNAUTHENTICATED caller may make us parse. The only pre-auth route with a
 *  body; `maxRecordBytes` never applies here. An id_token is a few KB on the largest IdPs. */
const MAX_OIDC_BODY_BYTES = 64 * 1024;

/** POST /v0/sessions/oidc: body {id_token}. No credential — the token IS the credential; the
 *  space verifies it against the configured issuer and mints an ordinary run (design-auth.md
 *  "OIDC"). Verification failures are one broad 401: which check failed is for the space's own
 *  tests, never for an anonymous caller. */
export async function handleOidcSession(space: Space, req: Request): Promise<Response> {
  // Cap the STREAM, not the content-length header: a chunked body carries no length and this is
  // the one route where the caller needed no credential to make us read.
  const reader = req.body?.getReader();
  let text = "";
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OIDC_BODY_BYTES) {
        await reader.cancel();
        return problem(413, "body_too_large", `id_token body over ${MAX_OIDC_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    text = new TextDecoder().decode(all);
  }
  let j: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { /* refused below */ }
  if (!j || typeof j.id_token !== "string" || j.id_token.length === 0) {
    return problem(400, "invalid_body", "expected {id_token: string}");
  }
  try {
    const out = await space.mintOidcRun(j.id_token);
    return new Response(JSON.stringify(out), { status: 201, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof RadiaError) {
      if (e.code === "oidc_not_configured") return problem(403, e.code, e.message);
      if (e.code === "oidc_unavailable") return problem(503, e.code, e.message);
      if (e.code === "too_many_runs") return problem(429, e.code, e.message);
      return problem(401, "invalid_credential", e.message);
    }
    throw e;
  }
}

/** POST /v0/agent-runs/{id}/stop: operator, or the run's own definition token (Bearer).
 *  Body `{quarantine: true}` upgrades graceful stop to emergency revocation (invalidate leases). */
/**
 * POST /v0/agent-runs/{id}/renew: extend a live run, presenting its own token (or as operator).
 *
 * Its OWN token, not a definition token. A definition token can mint a fresh run whenever it likes,
 * so letting it renew adds nothing; a run token is the credential actually in a running process's
 * hand, and extending it is the thing that had no answer.
 */
export async function handleRenewRun(space: Space, req: Request, principal: string, runId: string): Promise<Response> {
  let allowed = space.isPrivileged(principal);
  if (!allowed) {
    const token = bearer(req);
    if (token) {
      const r = await space.resolveToken(token);
      allowed = r.ok && r.kind === "run" && r.principal === runId;
    }
  }
  if (!allowed) return problem(403, "forbidden", "renewing a run requires an operator or the run's own token");
  try {
    return Response.json(await space.renewRun(runId));
  } catch (e) {
    const code = e instanceof RadiaError ? e.code : "error";
    if (code === "not_found") return problem(404, "not_found", `no run ${runId}`);
    // A stopped or aged-out run is a CLOSED door, not a transient failure: 409 says "this will not
    // start working", so a renewing client gives up and re-authenticates instead of retrying.
    if (code === "run_stopped" || code === "run_lifetime_exceeded") {
      return problem(409, code, e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

/**
 * POST /v0/agent-definitions/{agent}/revoke: kill a definition token, permanently.
 *
 * OPERATOR ONLY, and the asymmetry with `stop` is deliberate. A run may be stopped by its own token
 * because giving up your own authority needs no permission. A definition is the credential that
 * MINTS authority, and a holder who can revoke it can also mint a replacement first, so
 * self-revocation buys nothing an attacker would not simply skip — while the caller who actually
 * needs this (someone responding to a leak) is by definition not holding the token any more.
 */
export async function handleRevokeDefinition(
  space: Space,
  req: Request,
  principal: string,
  agent: string,
): Promise<Response> {
  if (!space.isPrivileged(principal)) {
    return problem(403, "forbidden", "revoking a definition requires an operator");
  }
  const j = await readJson(req);
  const reason = typeof j?.reason === "string" ? j.reason : undefined;
  const { applied, alreadyRevoked } = await space.revokeDefinition(agent, { reason });
  if (!applied) return problem(404, "not_found", `no definition for ${agent}`);
  // Idempotent, and it says which it was: re-running a revocation during an incident must not read
  // as a second leak, and must not fail either.
  return Response.json({ agent, status: "revoked", applied, alreadyRevoked });
}

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
