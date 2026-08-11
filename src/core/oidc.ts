// OIDC id_token verification (design-auth.md "OIDC"). One class, one job: decide whether an
// id_token was signed by the configured issuer for this audience, and hand back (iss, sub).
// Everything after that — mapping to a principal, minting the run — is `Space.mintOidcRun`.
//
// The fetcher is INJECTED (the `seal.ts` shape: core imports platform only for default wiring),
// so conformance drives the verifier without a socket and the JWKS-fetch tests point it at an
// in-repo issuer. Checks run cheap-first: string claims before key selection, key selection
// before WebCrypto, so garbage costs string compares and never an outbound fetch.

import { RadiaError } from "./errors.ts";

/** Config-side trust anchors (SpaceContext.oidc): who may sign, and for whom. Trust anchors are
 *  config like `operators` — the issuer set cannot be a record written by the thing it
 *  authenticates. `audience` is the value the IdP puts in `aud` (the client id for plain OIDC;
 *  an API identifier on Auth0-style setups). */
export interface OidcConfig {
  issuer: string;
  audience: string;
  /** Where the issuer's keys live. Unset, the verifier reads `jwks_uri` from
   *  `<issuer>/.well-known/openid-configuration` — guessing a path is wrong for major IdPs. */
  jwksUri?: string;
}

export type FetchJson = (url: string) => Promise<unknown>;

export type Verified =
  /** `username`/`name`/`email` are DESCRIPTIVE, for the enrollment record an operator reads
   *  before renaming ("who is b6fc…?"); the principal never derives from them (mutable,
   *  reassignable). Present only when the client requested the `profile`/`email` scopes. */
  | { ok: true; iss: string; sub: string; username?: string; name?: string; email?: string }
  | { ok: false; reason: string };

/** Clock skew allowed on `exp`/`nbf`, seconds. IdP and space clocks are different machines. */
const SKEW_SECONDS = 60;

/** How long a fetched JWKS (and the discovery document behind it) stays trusted. A rotated or
 *  revoked IdP key must not verify until process restart; an hour matches common IdP cache
 *  headers without hammering anyone. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Cooldown after a refetch that still had no matching key, GLOBAL rather than per kid: a
 *  per-kid cache is defeated by minting a fresh random kid per request, and the whole point is
 *  that an anonymous flood must not convert one-for-one into outbound requests at the IdP. A
 *  legitimate signer mid-rotation retries into the refreshed cache within one window. */
const UNKNOWN_KID_COOLDOWN_MS = 45 * 1000;

interface Jwk {
  kty?: string;
  kid?: string;
  crv?: string;
  use?: string;
  [k: string]: unknown;
}

/** base64url → bytes, or null. A malformed segment is a failed token, never an exception. */
function b64urlDecode(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlDecode(s);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Deno's lib types declare `BufferSource` as `ArrayBufferView<ArrayBuffer>`, which a plain
 *  `Uint8Array` does not satisfy. Runtime-identical (same as storage/crypto.ts). */
const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

/** Per-alg WebCrypto parameters. The allowlist is closed HERE: `none` and the HMAC family never
 *  reach a code path, and the JWK's `kty` must match the token's alg family so the header can
 *  only SELECT a key, never define the algorithm. */
const ALGS: Record<string, { kty: string; import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: "RSASSA-PKCS1-v1_5",
  },
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
};

export class OidcVerifier {
  #cfg: OidcConfig;
  #fetchJson: FetchJson;
  #keys: Jwk[] | null = null;
  #fetchedAt = 0;
  #inflight: Promise<Jwk[]> | null = null;
  #missAt = 0; // when a forced refetch last came back still missing the asked-for key
  #ttlMs: number;
  #cooldownMs: number;

  constructor(cfg: OidcConfig, fetchJson: FetchJson, opts: { ttlMs?: number; cooldownMs?: number } = {}) {
    this.#cfg = cfg;
    this.#fetchJson = fetchJson;
    this.#ttlMs = opts.ttlMs ?? JWKS_TTL_MS;
    this.#cooldownMs = opts.cooldownMs ?? UNKNOWN_KID_COOLDOWN_MS;
  }

  /** Verify one id_token against the configured issuer/audience. `now` is the DB clock (the
   *  invariant: never a local clock) in epoch milliseconds — as a THUNK, because fetching it
   *  costs a database round trip on Postgres and this is the unauthenticated path: a flood of
   *  garbage must fail on string compares before the space pays any I/O for it (measured:
   *  562µs -> 27µs-class for a wrong-issuer reject). A plain number is accepted for tests. */
  async verify(idToken: string, now: number | (() => Promise<number>)): Promise<Verified> {
    const parts = idToken.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed token" };
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    const sig = b64urlDecode(parts[2]);
    if (!header || !payload || !sig) return { ok: false, reason: "malformed token" };

    const alg = ALGS[String(header.alg)];
    if (!alg) return { ok: false, reason: "unsupported alg" };

    // Claims, cheapest first. `iss` exact; `aud` contains the audience, and a MULTI-audience
    // token additionally needs `azp` to name us (OIDC Core §3.1.3.7) or a token minted for a
    // different client at the same issuer would pass.
    if (payload.iss !== this.#cfg.issuer) return { ok: false, reason: "issuer mismatch" };
    const aud = payload.aud;
    const audOk = typeof aud === "string"
      ? aud === this.#cfg.audience
      : Array.isArray(aud) && aud.includes(this.#cfg.audience) &&
        (aud.length === 1 || payload.azp === this.#cfg.audience);
    if (!audOk) return { ok: false, reason: "audience mismatch" };
    const nowMs = typeof now === "number" ? now : await now();
    const nowSec = Math.floor(nowMs / 1000);
    if (typeof payload.exp !== "number" || nowSec > payload.exp + SKEW_SECONDS) {
      return { ok: false, reason: "expired" };
    }
    if (typeof payload.nbf === "number" && nowSec < payload.nbf - SKEW_SECONDS) {
      return { ok: false, reason: "not yet valid" };
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return { ok: false, reason: "missing sub" };
    }

    const jwk = await this.#keyFor(header.kid === undefined ? undefined : String(header.kid), alg.kty, nowMs);
    if (!jwk) return { ok: false, reason: "no matching key" };

    try {
      const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, alg.import, false, ["verify"]);
      const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const valid = await crypto.subtle.verify(alg.verify, key, buf(sig), buf(data));
      if (!valid) return { ok: false, reason: "bad signature" };
    } catch {
      // A malformed signature or an unimportable key is a failed verification, not an exception
      // (the seal.ts convention).
      return { ok: false, reason: "bad signature" };
    }
    return {
      ok: true,
      iss: this.#cfg.issuer,
      sub: payload.sub,
      ...(typeof payload.preferred_username === "string" && payload.preferred_username ? { username: payload.preferred_username } : {}),
      ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
      ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}),
    };
  }

  /** The signing key for `kid`, from cache, refetching at most once — single-flight, and never
   *  inside the per-kid cooldown. `kid` absent is legal when the JWKS holds exactly one key of
   *  the right family. */
  async #keyFor(kid: string | undefined, kty: string, nowMs: number): Promise<Jwk | null> {
    const pick = (keys: Jwk[]): Jwk | null => {
      // kty must match the token's alg family. WebCrypto's importKey refuses a mismatched JWK
      // independently, so this is double-covered; the filter also makes a kid-absent JWKS with
      // one key per family resolve correctly instead of failing on "two keys".
      const family = keys.filter((k) => k.kty === kty && (k.use === undefined || k.use === "sig"));
      if (kid !== undefined) return family.find((k) => k.kid === kid) ?? null;
      return family.length === 1 ? family[0] : null;
    };

    let keys = await this.#jwks(nowMs, false).catch(() => null);
    if (keys) {
      const hit = pick(keys);
      if (hit) return hit;
    }
    // Unknown kid: one refetch (rotation happened since the cache) — unless a recent refetch
    // already came back empty-handed, in which case the flood gets the cache's answer.
    if (nowMs - this.#missAt < this.#cooldownMs) return null;
    keys = await this.#jwks(nowMs, true).catch(() => null);
    const hit = keys ? pick(keys) : null;
    if (!hit) this.#missAt = nowMs;
    return hit;
  }

  /** The JWKS, cached for the TTL. `force` bypasses freshness but still rides the single-flight,
   *  so N concurrent unknown-kid requests are one outbound fetch. */
  #jwks(nowMs: number, force: boolean): Promise<Jwk[]> {
    if (!force && this.#keys && nowMs - this.#fetchedAt < this.#ttlMs) return Promise.resolve(this.#keys);
    if (this.#inflight) return this.#inflight;
    this.#inflight = (async () => {
      try {
        let uri = this.#cfg.jwksUri;
        if (!uri) {
          const base = this.#cfg.issuer.replace(/\/+$/, "");
          const disco = await this.#fetchJson(`${base}/.well-known/openid-configuration`) as { jwks_uri?: unknown };
          if (typeof disco?.jwks_uri !== "string") {
            throw new RadiaError("oidc_unavailable", "issuer discovery document has no jwks_uri");
          }
          uri = disco.jwks_uri;
        }
        const doc = await this.#fetchJson(uri) as { keys?: unknown };
        if (!Array.isArray(doc?.keys)) throw new RadiaError("oidc_unavailable", "JWKS has no keys array");
        this.#keys = doc.keys as Jwk[];
        this.#fetchedAt = nowMs;
        return this.#keys;
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }
}
