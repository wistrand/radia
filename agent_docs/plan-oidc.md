# OIDC sign-in: mint runs from an IdP's id_token

Status: BUILT 2026-08-11 (server + console; CLI device flow deferred). Sources:
`src/core/oidc.ts` (the verifier), `Space.mintOidcRun` in `src/core/space.ts`,
`handleOidcSession` in `src/server/handlers/agents.ts`, the sign-in flow in `src/ui/index.html`
(`oidcStart`/`oidcFinish` and the return leg in `start()`), `httpGetJson` in `src/platform.ts`
(the runtime's one outbound-HTTP function). Guards: `conformance/oidc.test.ts` (10 suites, the
in-repo issuer in `conformance/oidc-issuer.ts`), the OIDC harness tests in
`conformance/console.test.ts`, the `oidc: null` posture pin in `conformance/defaults.test.ts`.

The three decisions this implements are recorded in [design-auth.md](design-auth.md)
("OIDC: deferred, with the shape decided", now built): OIDC is a new way to MINT into the
existing bootstrap chain, never a parallel auth model; the principal comes from the `(iss, sub)`
mapping registry (`oidc_identity`, reserved, operator-written, latest-wins), never a raw claim;
runs are minted directly with NO durable half, so IdP deprovisioning takes effect within one
12-hour ceiling.

## Shape

- `POST /v0/sessions/oidc` `{id_token}`, pre-auth (the token IS the credential). Verified
  RS256/ES256 against the configured issuer's JWKS; `iss` exact, `aud` contains the audience
  (multi-audience additionally requires `azp`), `exp`/`nbf` with 60s skew on the DB clock.
- Config: `SpaceContext.oidc {issuer, audience, jwksUri?}` (`radia dev --oidc-issuer
  --oidc-audience`), null by default. Trust anchors are config like `operators`. `--oidc-audience`
  is the value the IdP puts in `aud`; health advertises it as `clientId`.
- Identity: mapped `(iss, sub)` wins; absent auto-admits as `human:oidc-<32 hex of
  sha256(iss\nsub)>` with ZERO grants; a `retired: true` mapping is a BAN, never a fall-through
  to auto-admit (offboarding must not un-happen). Privileged principals are refused at mapping
  write AND at mint.
- The run token is DERIVED from the id_token (domain-separated hash), so a replayed POST finds
  the existing run by tokenHash and writes nothing. A per-subject ceiling
  (`maxOidcRunsPerSubject`, default 8 active runs, 429 `too_many_runs`) bounds distinct tokens.
- Console: "Sign in with SSO" appears when the pre-auth health probe carries `oidc`. Code+PKCE
  in the page; the nonce is checked by the PAGE (the space never saw it); the return leg spends
  state/nonce/verifier once, strips the query, and restores the carried `#tab` route. The code
  arrives in the QUERY string, which unlike `#token` reaches server logs — fine for a
  PKCE-bound single-use code and required by IdPs; do not "fix" it into a fragment.
- JWKS: cached 1h TTL; unknown-kid refetch is single-flight with a GLOBAL 45s cooldown after a
  miss, because a per-kid negative cache is defeated by minting a fresh random kid per request.

## Accepted gaps

- No general rate limit on the unauthenticated endpoint (consistent with `POST /v0/agent-runs`):
  the idempotent mint, the run ceiling and the JWKS cooldown bound the damage, and a failed
  verification writes nothing.
- Silent refresh (prompt=none iframe) deferred: past the 12h ceiling the SSO button reappears
  and the dance repeats, which doubles as the deprovisioning check.
- CLI device flow deferred until a real IdP exists.
- An id_token replayed within its validity returns the same audited run; that is the designed
  bound, not a leak of new authority.

## Rejected

- Per-request JWT validation (resource-server style): a bearer JWT has no run, and fencing,
  lease ownership, idempotency scope and the event log's `runId` all key off run identity.
- Principal from `email`/`preferred_username`: mutable and reassignable; a rename would silently
  strand every grant. The mapping registry renames without touching grants.
- Refusing multi-audience tokens outright: `azp` is the compliant check and real IdPs emit
  multi-audience tokens.
