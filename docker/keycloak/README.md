# Local Keycloak OIDC setup

This Compose configuration runs Keycloak with a preconfigured Radia realm, browser login and CLI
loopback redirects. It is for local development only: dev mode, no TLS and no restart policy. A
deployment recipe rather than an example (nothing here coordinates through the space). See
[agent_docs/plan-oidc.md](../../agent_docs/plan-oidc.md) for what the space does with the
id_token.

```sh
# 1. the issuer (first start imports the realm; Ctrl-C stops it, nothing restarts it)
docker compose up

# 2. the space, trusting it (any dev variant works; the flags are the whole wiring)
deno task dev:pg --oidc-issuer http://localhost:8080/realms/radia --oidc-audience radia-console

# 3. open the console, click "Sign in with SSO", log in as demo / radia
```

The imported realm contains:

- Realm `radia`; the issuer URL is `http://localhost:8080/realms/radia`. Use the SAME host in
  `--oidc-issuer` that the browser will use: the `iss` claim mirrors how Keycloak was reached,
  and the space matches it exactly.
- Public client `radia-console` with PKCE S256 enforced and only the standard (code) flow: the
  console is a public client and sends no secret. `--oidc-audience` is this client id (the
  id_token's `aud`).
- Redirect URIs and web origins for the console on `127.0.0.1:7788` and `localhost:7788`, the
  analysis example on `:8081` and the chat's web UI on `:8082` (both host spellings), plus
  `http://127.0.0.1:8253/*` for the CLI's
  loopback sign-in (`radia login --sso`). A different `--port` needs matching entries (admin
  console → Clients → radia-console). NOTE: the import only runs against a fresh database — an
  already-imported realm needs these added in the admin UI, or `docker compose down && up` to
  re-import.

  **Valid Redirect URIs and Web Origins are SEPARATE fields, and a browser sign-in needs both.**
  They fail at different moments and neither error names the other, which is what makes this cost
  an afternoon:

  | symptom | missing |
  |---|---|
  | Keycloak's own page: "Invalid parameter: redirect_uri" | the URI in **Valid Redirect URIs** |
  | back on your page, the token exchange fails with no status | the origin in **Web Origins** (CORS) |

  `http://localhost:8081` and `http://127.0.0.1:8081` are different origins to an IdP. The realm
  lists both for every port it knows; a hand-added entry usually lists one.
- One user, `demo` / `radia`. Add people in the admin console
  (http://localhost:8080, admin / admin).

First sign-in lands as `human:oidc-<hash>` with zero grants, and ENROLLS itself: the space
writes an `oidc_identity` record carrying the `(iss, sub)` pair, referencing the IdP's
username/name/email in a `profile` ARTIFACT (out of line so a deletion request is honourable:
`radia shred <profile id>` destroys the claims while the mapping and sign-in survive). Renaming
needs no trip to Keycloak's admin screen — read the record, write a successor:

```sh
radia query oidc_identity     # who has signed in: iss/sub/principal + the profile artifact id
radia put oidc_identity '{"iss":"http://localhost:8080/realms/radia","sub":"<sub from above>","principal":"human:you"}'
radia put ops_grant '{"principal":"human:you","operations":["observe"]}'   # the console's observability tabs
```

Then sign in with SSO again (the principal is resolved at mint, so the running session keeps
its old name until a fresh id_token mints). A mapping with `retired: true` is a BAN — that
identity's sign-in is refused until a successor re-admits it.
