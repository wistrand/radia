// RFC 9457 problem+json responses. The error model is frozen v0-stable (additive-only),
// so establish it now. `lease_lost` and lost-race are distinct NON-error statuses and do
// not use this helper — they return 200 with a status body (see design-api.md).

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
