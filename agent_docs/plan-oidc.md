# OIDC sign-in: mint runs from an IdP's id_token

Status: BUILT 2026-08-11 (server + console + CLI). Sources:
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
  sha256(iss\nsub)>` with ZERO grants, and the FIRST login writes the `oidc_identity` record
  itself (`auto: true`) — so a rename is a successor of a visible record and a ban is a retire
  of one. Later logins REFRESH the display claims when they changed at the IdP (a successor
  preserving the principal, keyed `:after:` its predecessor; a withheld claim never strips a
  stored one; a ban refuses before any write, so a tombstone stays newest forever). A
  `retired: true` mapping is a BAN, never a fall-through to auto-admit (offboarding must not
  un-happen). Privileged principals are refused at mapping write AND at mint.
- **Display claims live in a PROFILE ARTIFACT the mapping references, never in the mapping
  body** — the erasure invariant applied, after a review rightly escalated the earlier inline
  shape from "trade to know about" to blocker: `oidc_identity` never compacts and a body has no
  erasure path, so an inline name or email would be permanent. The body carries only
  `{iss, sub, principal, auto, profile}` (`sub` is pseudonymous and is the registry key; the
  console requests `scope=openid profile email` to fill the artifact). The artifact's JSON
  carries a random NONCE, because {name, email} is low-entropy and the plaintext sha256
  survives a shred — without it, a destroyed name would stay confirmable by anyone holding a
  candidate. **Deletion-request runbook:** `radia query oidc_identity` (all successors for the
  sub) → `radia shred <each profile id>`; the mapping, principal, grants and sign-in survive.
  Two honest residues: a shredded ACTIVE user re-enrolls a profile on their next changed-claim
  login (erasure is not offboarding — retire the mapping first), and any record enrolled while
  claims were inline (before 2026-08-11, same day, no known deployments) keeps them in its
  immutable body UNTIL superseded and compacted: `oidc_identity` compacts under the runtime's
  (iss, sub) key (`RUNTIME_KEYS` in core/gc.ts, which also defeats a hostile contentKey
  redeclaration — newest per identity survives, tombstone included, so a ban stands), so a
  successor plus `radia gc --run` deletes the legacy record whole. What remains after that is
  the event log's entry (id, kind, bodySha256) until event retention truncates it.
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
- CLI: `radia login --sso` (`ssoLogin` in `src/surfaces/cli.ts`) is the native-app LOOPBACK flow
  (RFC 8252), not device codes: a one-shot listener on `127.0.0.1:8253` (`--sso-port`; the port
  is part of the IdP's redirect-URI registration, so fixed, not ephemeral), the printed URL is
  the person's one click, PKCE exchanged CLI-side, nonce checked CLI-side, and the run token
  stored in the `#login` slot the chat and CLI verbs already read — with NO definitionToken, so
  a lapsed session is one click again rather than a silent re-mint. What the terminal prints is
  `http://127.0.0.1:8253/<12 random hex>`: the listener 302s that path to the full authorize
  URL, so the PKCE query string never has to survive a terminal, and the random path means a
  probe of `/` or a link preview cannot spend the sign-in by accident.
- Display: the enrollment record's claims decorate, never decide. The console pill shows the
  IdP name beside a derived principal (kept client-side from the id_token at sign-in); the
  chat's banner reads it from the enrollment record. Both show the principal alongside, because
  that string is what grants and records say.

## Accepted gaps

- No general rate limit on the unauthenticated endpoint (consistent with `POST /v0/agent-runs`):
  the idempotent mint, the run ceiling and the JWKS cooldown bound the damage, and a failed
  verification writes nothing.
- Silent refresh (prompt=none iframe) deferred: past the 12h ceiling the SSO button reappears
  and the dance repeats, which doubles as the deprovisioning check. Same for the CLI: a lapsed
  `--sso` session is one browser click, not a stored secret.
- A device-code flow (for a HEADLESS machine, where no browser can reach 127.0.0.1) stays
  deferred; the loopback flow covers every desktop case.
- An id_token replayed within its validity returns the same audited run; that is the designed
  bound, not a leak of new authority.
## Rejected

- Per-request JWT validation (resource-server style): a bearer JWT has no run, and fencing,
  lease ownership, idempotency scope and the event log's `runId` all key off run identity.
- Principal from `email`/`preferred_username`: mutable and reassignable; a rename would silently
  strand every grant. The mapping registry renames without touching grants.
- Refusing multi-audience tokens outright: `azp` is the compliant check and real IdPs emit
  multi-audience tokens.
- Display claims inline in the mapping body: shipped for a few hours as an "accepted gap"
  ("permanent, deliberate, know the trade") and correctly escalated to a blocker — it was the
  erasure invariant's exact target shape, and the fix is cheap before the first real deployment
  and impossible after (immutable bodies). The profile-artifact design above replaced it.
- Not storing claims at all (operator names people by hand): loses the enrollment record's
  whole point — an operator recognizing WHO signed in without IdP archaeology — to avoid a
  problem the artifact path solves properly.
