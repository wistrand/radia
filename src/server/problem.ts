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

/** Map a RadiaError code to an HTTP status: forbidden→403, idempotency_conflict→409, else the
 *  fallback. Shared by the record handlers and the top-level catch-all. */
export function statusFor(code: string, fallback: number): number {
  if (code === "forbidden") return 403;
  if (code === "idempotency_conflict") return 409;
  return fallback;
}
