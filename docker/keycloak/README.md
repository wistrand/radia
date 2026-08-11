# Keycloak as a real OIDC issuer for a local space

The in-repo test issuer (`conformance/oidc-issuer.ts`) authenticates nobody; this is the same
flow against a real IdP with a login page. Dev mode, no TLS, no autorestart. See
[agent_docs/plan-oidc.md](../../agent_docs/plan-oidc.md) for what the space does with the
id_token.

```sh
# 1. the issuer (first start imports the realm; Ctrl-C stops it, nothing restarts it)
docker compose up

# 2. the space, trusting it (any dev variant works; the flags are the whole wiring)
deno task dev:pg --oidc-issuer http://localhost:8080/realms/radia --oidc-audience radia-console

# 3. open the console, click "Sign in with SSO", log in as wistrand / radia
```

What the realm import sets up, and why each piece:

- Realm `radia`; the issuer URL is `http://localhost:8080/realms/radia`. Use the SAME host in
  `--oidc-issuer` that the browser will use: the `iss` claim mirrors how Keycloak was reached,
  and the space matches it exactly.
- Public client `radia-console` with PKCE S256 enforced and only the standard (code) flow: the
  console is a public client and sends no secret. `--oidc-audience` is this client id (the
  id_token's `aud`).
- Redirect URIs and web origins for the console on `127.0.0.1:7788` and `localhost:7788`, plus
  `http://127.0.0.1:8253/*` for the CLI's loopback sign-in (`radia login --sso`). A different
  `--port` needs matching entries (admin console → Clients → radia-console). NOTE: the import
  only runs against a fresh database — an already-imported realm needs these added in the admin
  UI, or `docker compose down && up` to re-import.
- One user, `wistrand` / `radia`. Add people in the admin console
  (http://localhost:8080, admin / admin).

First sign-in lands as `human:oidc-<hash>` with zero grants, and ENROLLS itself: the space
writes an `oidc_identity` record carrying the `(iss, sub)` pair plus the IdP's username/email
as description. So renaming needs no trip to Keycloak's admin screen — read the record, write
a successor:

```sh
radia query oidc_identity     # who has signed in, with iss/sub/username on each record
radia put oidc_identity '{"iss":"http://localhost:8080/realms/radia","sub":"<sub from above>","principal":"human:you"}'
radia put ops_grant '{"principal":"human:you","operations":["observe"]}'   # the console's observability tabs
```

Then sign in with SSO again (the principal is resolved at mint, so the running session keeps
its old name until a fresh id_token mints). A mapping with `retired: true` is a BAN — that
identity's sign-in is refused until a successor re-admits it.
