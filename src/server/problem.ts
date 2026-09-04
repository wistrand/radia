// RFC 9457 problem+json responses. The error model is frozen v0-stable (additive-only),
// so establish it now. `lease_lost` and lost-race are distinct NON-error statuses and do
// not use this helper. They return 200 with a status body (see design-api.md).

export function problem(
  status: number,
  type: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  const body = {
    type: `about:radia/${type}`,
    title: type,
    status,
    detail,
    ...extra,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** Map a RadiaError code to an HTTP status: forbidden→403, idempotency_conflict→409,
 *  record_too_large→413, else the fallback. Shared by the record handlers and the top-level
 *  catch-all. */
export function statusFor(code: string, fallback: number): number {
  if (code === "forbidden") return 403;
  if (code === "idempotency_conflict") return 409;
  // 413, matching `artifact_too_large`: the two limits are the same rule seen from both sides, and
  // a caller that hits the body one is being told to use the artifact path.
  if (code === "record_too_large") return 413;
  // A ceiling on a per-principal resource, not a malformed request: the same call succeeds once
  // the caller's idle watches lapse or it closes the streams it is done with.
  if (code === "too_many_watches") return 429;
  // Same shape: a budget the caller can get back under by retiring what it no longer listens for.
  if (code === "too_many_interests") return 429;
  // A per-principal ceiling on grant HISTORY, which every authorize re-reads. 429 like the two
  // above, though the honest difference is that retiring shrinks what the READER projects and not
  // the history it walks: grants never compact, so this one does not hand the budget back.
  if (code === "too_many_grants") return 429;
  // Same rule on the registry the ops-plane gate reads, and the same honest caveat: retiring shrinks
  // what the reader projects, not the history it walks.
  if (code === "too_many_ops_grants") return 429;
  // The OIDC subject's active-run ceiling: waits out an expiry or stops a run, then succeeds.
  if (code === "too_many_runs") return 429;
  // 413 with `record_too_large`, because these are the same rule read on a different axis: the
  // record is too expensive to accept. Bytes bound one dimension; depth and fan-out bound the
  // others, and a caller told 400 would look for a syntax error that is not there.
  if (code === "body_too_deep" || code === "array_too_long") return 413;
  if (code === "pattern_too_large") return 413;
  // 429 rather than 413: the request is small and well-formed, and what it exceeded is a budget on
  // the WORK it would cause. The same pattern succeeds against a smaller kind, and narrowing it or
  // paging with `after` is a retry the caller can actually make.
  if (code === "scan_budget_exceeded") return 429;
  // 422 rather than 400: the request is well formed and the kind exists. What it asks for is a
  // remediation this verb refuses to perform on reference data, and saying so is the point (an
  // empty 200 would read as "nothing to fix").
  if (code === "kind_not_remediable") return 422;
  // 503: the request was fine and the space is up, but the blob store it needs is not answering.
  // The same request succeeds once the store is back, and nothing about it needs changing.
  if (code === "blob_store_unavailable") return 503;
  return fallback;
}

/**
 * A request may carry only the fields the operation HAS. Anything else is a 400 naming it.
 *
 * Handlers PICK fields by name, so every other key was silently dropped. That is deliberate on
 * `put`, where it is how the server-assigned half gets ignored, and a defect everywhere the dropped
 * field NARROWS: the caller asked for a smaller thing and got a bigger one, told nothing. Measured:
 * `order_by` (the spelling the design docs, the Python docstrings and the chat's own tool
 * description use in prose) returned records in id order where `orderBy` sorted them, status 200.
 * A misspelled `match` on the registry verb hands back the whole registry as a slice; a misspelled
 * `kind` on `remediate` drains every app's backlog instead of one.
 *
 * `handleTake` already stated the rule for the pattern OBJECT ("dropping it would claim a different
 * record than asked") and `bodyTaint` for `taint`. This is that rule, applied to fields.
 */
const NEAR_MISS: Record<string, string> = {
  order_by: "orderBy",
  next_cursor: "cursor",
  next_after: "after",
  order: "orderBy",
  sort: "orderBy",
  record_id: "recordId",
  lease_seconds: "leaseSeconds",
  allow_taint: "allowTaint",
  require_untainted: "requireUntainted",
  parent_ids: "parentIds",
  available_at: "availableAt",
  client_meta: "clientMeta",
  // The two handlers that had no `rejectUnknown` at all until 2026-08-29, and their snake_case
  // spellings: a watch's `match` NARROWS, and a definition's `supersedes` is the compare-and-set
  // that stops an agent ending with two live minting tokens.
  id_token: "id_token", // already snake_case on the wire; listed so the allow-list reads complete
  supersedes_id: "supersedes",
  agent_id: "agent",
};

export function rejectUnknown(
  j: Record<string, unknown>,
  allowed: string[],
  where = "field",
): Response | undefined {
  for (const key of Object.keys(j)) {
    if (allowed.includes(key)) continue;
    const meant = NEAR_MISS[key];
    return problem(
      400,
      "invalid_pattern",
      meant
        ? `unknown ${where} ${JSON.stringify(key)}: did you mean ${JSON.stringify(meant)}? It was silently ignored before this check`
        : `unknown ${where} ${JSON.stringify(key)} (allowed: ${allowed.join(", ")})`,
    );
  }
}
