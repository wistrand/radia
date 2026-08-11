# Console auth without the paste treadmill (proposal)

Status: SUGGESTION, nothing built or scheduled. Written 2026-08-11 after live use: pasting a token
into the console on every tab and every expiry is the worst auth experience in the project, and it
pushes people toward repeatedly clipboard-handling the operator token, which is the strongest
secret transported the most often.

## The problem, decomposed

Three separate frictions with different fixes. Conflating them is how "auth is annoying" stays
unfixed.

- Storage: `sessionStorage` is per tab. Every new tab is a fresh paste.
- Lifetime: the console holds a bare RUN token and never renews it, so one tab re-authenticates
  every ~15 minutes. The "session ended" screen is this, working as coded.
- Transport: the token is born in a terminal and crosses to the browser by clipboard, every time.

## The mechanism already exists

The definition/run split was built precisely so nobody re-authenticates by hand: a definition
token is durable and MINT-ONLY (the space refuses it for coordination), a run token is short and
acts, and `RadiaClient.authorized()` exchanges the durable half on the first 401. The chat, the
CLI, the MCP adapter and every worker survive expiry, restarts and laptop sleep this way. The
console is the one client that got neither half. This is an unported feature, not a design gap.

## Plan

Phase order is by pain removed per line of code. 1 and 4 remove the treadmill; 2 and 3 are polish.

### 1. Port the exchange to the page

The sign-in box accepts a definition token. Stored in `localStorage` behind an explicit
"remember on this browser" checkbox; unchecked keeps today's per-tab behaviour. The page mints and
renews run tokens exactly as `sdk/ts/client.ts` does (exchange on 401, once; a 403 is never
retried; a revoked definition ends the session with the reason shown).

Security accounting, stated because it is the objection everyone will raise:

- A stolen definition token cannot read or write. It can only mint, and minting WRITES an
  `agent_run` record: theft leaves an audit trail and a handle (`stopRun`, `revokeDefinition`).
  A stolen run token, today's currency, acts silently until expiry.
- Today's model transports the OPERATOR token by clipboard many times a day. Frequent manual
  handling of the worst credential is itself the exposure this fixes.
- `localStorage` XSS exposure is real. The console already treats escaping as a tested invariant
  (`conformance/console.test.ts`, the `esc` suite), and what XSS would steal is the mint-only half.

Guards: exchange-once under concurrent 401s (the SDK's rule), the revoked-definition path, and a
test that the stored half never appears in a request except `POST /v0/agent-runs`.

### 2. Fragment handoff from the CLI

`radia login human:erik --console` mints the definition and prints (or opens)
`http://127.0.0.1:7788/#token=...`. The fragment never reaches the server. The page consumes it,
stores per phase 1, and `history.replaceState`s it out of the URL. One command, zero pasting.
Jupyter normalized the pattern. Terminal scrollback exposure is unchanged from printing a token,
which the CLI already does.

### 3. A labeled operator button, open mode only

The console refuses the no-header shortcut because it acquires the largest authority the least
visible way. The objection is VISIBILITY, not existence: open mode already grants it to any curl.
So in open mode only, a "Sign in as local operator" button uses the shortcut deliberately and the
header then says who you are. Hidden entirely under `--auth required` (the server refuses it
anyway). Zero-paste local dev, by the most visible path possible.

### 4. Renew whatever was pasted

Even a bare run token gets the `keepAlive` half-life renewal (same run, up to the 12h ceiling).
Small, independent of 1 to 3, and it makes the legacy flow tolerable for anyone who ignores them.

Plus one affordance across all phases: the header shows the signed-in principal and session state,
read from `ops/permissions` the way the Auth tab already does. With silent re-exchange, the
sign-in screen appears only when a credential is genuinely dead or revoked.

## Rejected

- HttpOnly cookies / server sessions: forks the auth model (the wire contract is Bearer), imports
  CSRF, complicates the isolated artifact origin, and breaks the console's defining property of
  being an ordinary client of the public API. Plausible someday for a hardened multi-user
  deployment, behind the same door as OIDC.
- OIDC now: the real multi-user answer and deliberately deferred, with its shape now recorded
  (design-auth.md, "OIDC: deferred, with the shape decided"): mint-at-the-boundary into the
  existing chain, a mapping registry for `(iss, sub)`, runs minted directly with no durable half.
  Phase 1 here is its prerequisite either way.
- Baking a token into the served page: `GET /` is public, and a test exists whose whole job is
  preventing this.
- Silently using the no-header shortcut: the original objection stands; phase 3 keeps the
  convenience and deletes the invisibility.

## Sizing

Phase 1 is the real work and is mostly transcription from `client.ts` (~a day with guards).
Phases 2 and 4 are small; phase 3 is trivial.
