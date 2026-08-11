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
  return fallback;
}
