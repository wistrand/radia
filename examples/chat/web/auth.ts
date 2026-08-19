/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Signing in from a page: authorization code + PKCE against the issuer the SPACE advertises, then
// the id_token exchanged BY THE SPACE for an ordinary run token (agent_docs/plan-oidc.md).
//
// SSO is the only way in here. There is no paste box, because a definition token in browser storage
// is a durable credential somebody then has to carry between machines, while a run token is short,
// mints nothing, and stops working when the IdP stops vouching.
//
// Nothing in this file invents an identity: the page proves who it is to the IdP, and the space
// decides what that is worth.

const TOKEN_KEY = "radia.chat.token";
/** The IdP's display claims for this sign-in. DECORATION, never authority: the principal beside it
 *  is what the space enforces, and this is only what the issuer said the person is called. Kept
 *  page-side because a session holds no `oidc_identity` grant to read the enrollment record with,
 *  which is how the terminal answers the same question when it happens to be an operator. */
const NAME_KEY = "radia.chat.name";
const PENDING_KEY = "radia.chat.oidc";

export interface OidcInfo {
  issuer: string;
  clientId: string;
}

interface Pending {
  verifier: string;
  state: string;
  nonce: string;
  tokenEndpoint: string;
  clientId: string;
  /** The fragment to come back to. It never reaches the IdP, so the page carries it across. */
  route: string;
  silent: boolean;
}

const randHex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The run token this tab holds. sessionStorage, not localStorage: an SSO session has no durable
 *  half to remember, so a new tab re-runs a dance that is usually silent anyway. */
export function storedToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

/** What the IdP called this person, or "" when it said nothing (or the claim was never stored). */
export function displayName(): string {
  return sessionStorage.getItem(NAME_KEY) ?? "";
}

export function signOut(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(NAME_KEY);
  location.href = "/"; // the IdP session survives, so signing back in is one click
}

/** What this space offers a signed-out page. `oidc` is present exactly when it trusts an issuer. */
export async function probeSpace(): Promise<{ oidc: OidcInfo | null }> {
  const health = await fetch("/v0/health").then((r) => r.ok ? r.json() : null).catch(() => null);
  return { oidc: (health && health.oidc) || null };
}

/**
 * Leave for the IdP.
 *
 * `silent` adds `prompt=none`, which is how a lapsed run renews without asking the person anything.
 * It is a TOP-LEVEL redirect rather than a hidden iframe: a third-party IdP cookie is blocked or
 * partitioned in every browser that matters, so the iframe form fails silently on exactly the
 * machines it was meant to serve. A full-page round trip costs nothing here, because no state lives
 * in the page: the conversation is records and the route is in the URL.
 */
export async function beginSignIn(oidc: OidcInfo, opts: { silent?: boolean } = {}): Promise<string | null> {
  const disco = await fetch(oidc.issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration")
    .then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!disco) return "the issuer's discovery document is unreachable from this browser";
  const pending: Pending = {
    verifier: randHex(32),
    state: randHex(16),
    nonce: randHex(16),
    tokenEndpoint: disco.token_endpoint,
    clientId: oidc.clientId,
    route: location.hash || "",
    silent: !!opts.silent,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))));
  const u = new URL(disco.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: oidc.clientId,
    redirect_uri: location.origin + "/",
    scope: "openid profile email",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(opts.silent ? { prompt: "none" } : {}),
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  location.href = u.href;
  return null;
}

/**
 * The return leg. The code arrives in the QUERY string, which is correct for a PKCE-bound
 * single-use code and required by IdPs; do not "fix" it into a fragment.
 *
 * Returns an error to show, or null when a token was obtained (or a redirect is in flight).
 */
export async function completeSignIn(params: URLSearchParams, oidc: OidcInfo | null): Promise<string | null> {
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  const pending: Pending | null = raw ? JSON.parse(raw) : null;
  history.replaceState({}, "", "/" + (pending?.route ?? "")); // strip code+state, keep the conversation
  if (!pending || pending.state !== params.get("state")) return "the sign-in did not match this browser; try again";

  const err = params.get("error");
  if (err) {
    // A silent renewal the IdP declined is not an error to show: it means the person has to be
    // asked properly. Anything else is the IdP saying no, and it says why.
    if (pending.silent && oidc) {
      await beginSignIn(oidc);
      return null;
    }
    return `the issuer declined the sign-in: ${err}${params.get("error_description") ? ` (${params.get("error_description")})` : ""}`;
  }

  let res: Response;
  try {
    res = await fetch(pending.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: location.origin + "/",
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
  } catch {
    // A THROWN fetch is the browser refusing to show a cross-origin response, almost always the
    // issuer not listing this page's origin in Web Origins, which is a different field from Valid
    // Redirect URIs and therefore the one people set and forget.
    return `the token endpoint could not be reached from ${location.origin}. Add ${location.origin} to the ` +
      `client's Web Origins (a different field from Valid Redirect URIs, which is already working or ` +
      `you would not be here).`;
  }
  const tok = await res.json().catch(() => null);
  if (!tok || !tok.id_token) {
    return `the issuer declined the token exchange (${res.status}): ` +
      `${(tok && (tok.error_description || tok.error)) || "no id_token in the response"}`;
  }
  // The nonce binds this id_token to THIS dance. The space never saw it, so the page must check it.
  const claims = JSON.parse(atob((String(tok.id_token).split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.nonce !== pending.nonce) return "the id_token does not match this sign-in";
  // Taken from the token this page just verified rather than asked of the space, which would need a
  // grant on the enrollment registry that no session holds. Absent is normal: a realm need not
  // send a name.
  const shown = claims.name ?? claims.preferred_username ?? claims.email ?? "";
  if (shown) sessionStorage.setItem(NAME_KEY, String(shown));
  else sessionStorage.removeItem(NAME_KEY);

  const session = await fetch("/v0/sessions/oidc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: tok.id_token }),
  }).then((r) => r.json()).catch(() => null);
  if (!session || !session.runToken) {
    return "the space refused the sign-in: " + ((session && (session.detail || session.title)) || "no run token");
  }
  sessionStorage.setItem(TOKEN_KEY, session.runToken);
  return null;
}

/** Did this fail because the credential is OVER, rather than insufficient? The same distinction the
 *  SDK makes internally: expiry is renewable, `forbidden` never is. */
export function expired(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return !!err && (err.status === 401 || err.code === "token_expired" || err.code === "run_stopped");
}
