// An in-repo OIDC issuer for tests and for the live console dance (the fake-OpenRouter
// precedent, named by design-auth.md "OIDC"). Two layers on purpose:
//
//   - `makeTestKeys()` — keys + a `sign()` for compact JWS. No sockets: verifier and handler
//     tests pre-sign fixtures and stub the space's `oidcFetch` with the JWKS document.
//   - `startIssuer()` — the same keys behind a real `Deno.serve({port: 0})`: discovery, JWKS,
//     `/authorize` (302 back with a code) and `/token` (code → id_token, CORS), which is the one
//     part a socketless test cannot reach and what the console's PKCE flow needs end-to-end.
//
// Runnable standalone for live verification: `deno run -A conformance/oidc-issuer.ts --port 7899`.

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(te.encode(JSON.stringify(obj)));
}

export interface SignOpts {
  alg?: "RS256" | "ES256";
  /** Override the header kid; `null` omits it entirely. */
  kid?: string | null;
  /** Sign with a different private key (a rogue signer wearing a real kid). */
  key?: CryptoKey;
}

export interface TestKeys {
  /** The JWKS document, as `/jwks.json` would serve it. */
  jwksDoc: { keys: Record<string, unknown>[] };
  /** Compact JWS over `claims`. Defaults: RS256 under kid `rs-test`. */
  sign(claims: Record<string, unknown>, opts?: SignOpts): Promise<string>;
  /** A valid keypair the JWKS does NOT contain, for bad-signature fixtures. */
  rogue: { rsa: CryptoKey; ec: CryptoKey };
}

export async function makeTestKeys(): Promise<TestKeys> {
  const rsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rogueRsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const rogueEc = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

  const rsaJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey) as Record<string, unknown>;
  const ecJwk = await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>;
  const jwksDoc = {
    keys: [
      { ...rsaJwk, kid: "rs-test", use: "sig", alg: "RS256" },
      { ...ecJwk, kid: "es-test", use: "sig", alg: "ES256" },
    ],
  };

  const sign = async (claims: Record<string, unknown>, opts: SignOpts = {}): Promise<string> => {
    const alg = opts.alg ?? "RS256";
    const kid = opts.kid === null ? undefined : (opts.kid ?? (alg === "RS256" ? "rs-test" : "es-test"));
    const header: Record<string, unknown> = { alg, typ: "JWT", ...(kid ? { kid } : {}) };
    const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const key = opts.key ?? (alg === "RS256" ? rsa.privateKey : ec.privateKey);
    const params = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
    const sig = new Uint8Array(await crypto.subtle.sign(params, key, te.encode(input) as BufferSource));
    return `${input}.${b64url(sig)}`;
  };

  return { jwksDoc, sign, rogue: { rsa: rogueRsa.privateKey, ec: rogueEc.privateKey } };
}

export interface TestIssuer extends TestKeys {
  /** The issuer URL (also the `iss` every signed token should carry). */
  base: string;
  /** How many times each document was served, for cache assertions. */
  served: { discovery: number; jwks: number; token: number };
  /** The subject `/token` puts in the id_tokens it issues. */
  subject: string;
  close(): Promise<void>;
}

/** Start the issuer on a real socket. `audience` is what `/token`-issued id_tokens carry in
 *  `aud`; `port` 0 (default) picks a free one. */
export async function startIssuer(opts: { audience?: string; port?: number; subject?: string } = {}): Promise<TestIssuer> {
  const keys = await makeTestKeys();
  const audience = opts.audience ?? "console";
  const subject = opts.subject ?? "user-1";
  const served = { discovery: 0, jwks: 0, token: 0 };
  // code → what /authorize recorded for it. The PKCE check is real (S256), because the console
  // flow being tested is exactly "does the exchange enforce the verifier".
  const codes = new Map<string, { nonce?: string; challenge?: string; clientId?: string }>();
  let counter = 0;

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  let base = "";
  const server = Deno.serve({ port: opts.port ?? 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/.well-known/openid-configuration") {
      served.discovery++;
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks.json`,
      }, { headers: cors });
    }
    if (url.pathname === "/jwks.json") {
      served.jwks++;
      return Response.json(keys.jwksDoc, { headers: cors });
    }
    if (url.pathname === "/authorize") {
      // No login page: this issuer trusts everyone as `subject`, which is the point of a test IdP.
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const code = `code-${++counter}`;
      codes.set(code, {
        nonce: url.searchParams.get("nonce") ?? undefined,
        challenge: url.searchParams.get("code_challenge") ?? undefined,
        clientId: url.searchParams.get("client_id") ?? undefined,
      });
      const to = new URL(redirect);
      to.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) to.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: to.href } });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      served.token++;
      const form = new URLSearchParams(await req.text());
      const issued = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!issued) return Response.json({ error: "invalid_grant" }, { status: 400, headers: cors });
      if (issued.challenge) {
        const verifier = form.get("code_verifier") ?? "";
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(verifier) as BufferSource));
        if (b64url(digest) !== issued.challenge) {
          return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400, headers: cors });
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const idToken = await keys.sign({
        iss: base,
        aud: issued.clientId ?? audience,
        sub: subject,
        iat: nowSec,
        exp: nowSec + 300,
        ...(issued.nonce ? { nonce: issued.nonce } : {}),
      });
      return Response.json({ id_token: idToken, token_type: "Bearer" }, { headers: cors });
    }
    return new Response("not found", { status: 404 });
  });
  base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

  return { ...keys, base, served, subject, close: () => server.shutdown() };
}

if (import.meta.main) {
  const portArg = Deno.args.indexOf("--port");
  const issuer = await startIssuer({
    port: portArg >= 0 ? Number(Deno.args[portArg + 1]) : 0,
    audience: (() => {
      const i = Deno.args.indexOf("--audience");
      return i >= 0 ? Deno.args[i + 1] : "console";
    })(),
  });
  console.log(`test OIDC issuer at ${issuer.base} (audience: console, subject: ${issuer.subject})`);
}
