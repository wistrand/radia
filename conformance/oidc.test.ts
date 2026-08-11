// OIDC sign-in (design-auth.md "OIDC"): the verifier, the mapping registry, the mint's replay
// and ceiling bounds, and the JWKS cache. Socketless through `makeHandler` with pre-signed
// fixtures wherever possible (the http.test.ts pattern); the real-socket issuer appears only
// where a stubbed fetch cannot reach — the discovery→JWKS chain over HTTP.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { Space } from "../src/core/space.ts";
import { OidcVerifier } from "../src/core/oidc.ts";
import { RadiaError } from "../src/core/errors.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { makeHandler } from "../src/server/http.ts";
import { makeTestKeys, startIssuer, type TestKeys } from "./oidc-issuer.ts";

const ISS = "https://idp.test";
const AUD = "console";

type Handler = (req: Request) => Promise<Response>;

async function newSpace(opts: { oidc?: { issuer: string; audience: string; jwksUri?: string } | null; ctx?: Record<string, unknown>; keys?: TestKeys } = {}) {
  const keys = opts.keys ?? await makeTestKeys();
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter, {
    oidc: opts.oidc === undefined ? { issuer: ISS, audience: AUD, jwksUri: `${ISS}/jwks.json` } : opts.oidc,
    ...(opts.ctx ?? {}),
    // deno-lint-ignore no-explicit-any
  } as any);
  let fetches = 0;
  space.oidcFetch = (url) => {
    fetches++;
    return Promise.resolve(url.endsWith("/jwks.json") ? keys.jwksDoc : { jwks_uri: `${ISS}/jwks.json` });
  };
  const handler: Handler = makeHandler(space, "<html>console</html>", true);
  return { space, adapter, keys, handler, fetches: () => fetches, close: () => adapter.close() };
}

function post(handler: Handler, body: unknown): Promise<Response> {
  return handler(
    new Request("http://t/v0/sessions/oidc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const s = Math.floor(Date.now() / 1000);
  return { iss: ISS, aud: AUD, sub: "user-1", iat: s, exp: s + 300, ...over };
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.test("oidc: a good token mints an ordinary run with zero grants, and it renews", async () => {
  const t = await newSpace();
  try {
    for (const alg of ["RS256", "ES256"] as const) {
      const res = await post(t.handler, { id_token: await t.keys.sign(claims({ sub: `u-${alg}` }), { alg }) });
      assertEquals(res.status, 201, await res.clone().text());
      const j = await res.json();
      assertMatch(j.agent, /^human:oidc-[0-9a-f]{32}$/, "auto-admitted under the derived principal");
      assertMatch(j.runToken, /^[0-9a-f]{48}$/, "an ordinary run token");
      assertMatch(j.run, /^run:/, "an ordinary run");

      // The run is real: it authenticates, renews with its own token, and holds ZERO grants.
      const r = await t.space.resolveToken(j.runToken);
      assert(r.ok && r.kind === "run" && r.agent === j.agent);
      const renew = await t.handler(
        new Request(`http://t/v0/agent-runs/${j.run}/renew`, { method: "POST", headers: { Authorization: `Bearer ${j.runToken}` } }),
      );
      assertEquals(renew.status, 200, "an OIDC run renews like any run");
      const perms = await t.space.effectivePermissions(j.agent);
      assertEquals(perms.kinds.length, 0, "a fresh OIDC user lands with no grants");
      const put = await t.handler(
        new Request("http://t/v0/records", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${j.runToken}` },
          body: JSON.stringify({ kind: "task", body: { x: 1 } }),
        }),
      );
      assertEquals(put.status, 403, "zero grants means coordination refuses");
    }
  } finally {
    await t.close();
  }
});

Deno.test("oidc: every forgery class is refused, and only real signatures pass", async () => {
  const t = await newSpace();
  try {
    const cases: [string, string][] = [
      ["issuer mismatch", await t.keys.sign(claims({ iss: "https://evil.test" }))],
      ["audience mismatch", await t.keys.sign(claims({ aud: "other-app" }))],
      // Multi-audience WITHOUT azp: minted for another client at the same issuer (OIDC §3.1.3.7).
      ["multi-aud missing azp", await t.keys.sign(claims({ aud: [AUD, "other-app"] }))],
      ["expired", await t.keys.sign(claims({ exp: Math.floor(Date.now() / 1000) - 400 }))],
      ["nbf in the future", await t.keys.sign(claims({ nbf: Math.floor(Date.now() / 1000) + 400 }))],
      ["missing sub", await t.keys.sign(claims({ sub: undefined as unknown as string }))],
      // A rogue key wearing a REAL kid: right claims, wrong signer.
      ["rogue signer", await t.keys.sign(claims(), { key: t.keys.rogue.rsa })],
      // The header may SELECT a key, never define the algorithm: RS256 pointing at the EC key.
      ["kty mismatch", await t.keys.sign(claims(), { alg: "RS256", kid: "es-test" })],
      ["unknown kid", await t.keys.sign(claims(), { kid: "no-such-key" })],
      // alg none and HMAC, hand-built: neither has a signing path in the test keys on purpose.
      ["alg none", `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims()))}.`],
      ["HS256", `${b64url(JSON.stringify({ alg: "HS256", kid: "rs-test" }))}.${b64url(JSON.stringify(claims()))}.${b64url("mac")}`],
      ["not a jwt", "definitely-not-a-token"],
    ];
    for (const [label, idToken] of cases) {
      const res = await post(t.handler, { id_token: idToken });
      assertEquals(res.status, 401, `${label}: expected 401, got ${res.status} ${await res.clone().text()}`);
      const j = await res.json();
      assertEquals(j.title, "invalid_credential", `${label}: one broad refusal class for anonymous callers`);
    }
    // The multi-audience shape is LEGAL once azp names us — refusing it would break real IdPs.
    const ok = await post(t.handler, { id_token: await t.keys.sign(claims({ aud: [AUD, "other-app"], azp: AUD })) });
    assertEquals(ok.status, 201, "multi-audience with azp is the compliant shape");
  } finally {
    await t.close();
  }
});

Deno.test("oidc: unconfigured refuses, malformed refuses, oversized is refused before parsing", async () => {
  const t = await newSpace({ oidc: null });
  try {
    const off = await post(t.handler, { id_token: "x" });
    assertEquals(off.status, 403, "no issuer configured: the endpoint exists and says so");
  } finally {
    await t.close();
  }
  const u = await newSpace();
  try {
    assertEquals((await post(u.handler, "not json")).status, 400);
    assertEquals((await post(u.handler, {})).status, 400);
    assertEquals((await post(u.handler, { id_token: "" })).status, 400);
    const big = await post(u.handler, { id_token: "x".repeat(70 * 1024) });
    assertEquals(big.status, 413, "an unauthenticated route must not buffer unbounded bodies");
  } finally {
    await u.close();
  }
});

Deno.test("oidc: the mapping registry decides who you are, and RETIRE IS A BAN", async () => {
  const t = await newSpace();
  try {
    const mapped = { iss: ISS, sub: "user-1", principal: "human:erik" };
    await t.space.put({ kind: "oidc_identity", body: mapped });
    const res = await post(t.handler, { id_token: await t.keys.sign(claims()) });
    assertEquals((await res.json()).agent, "human:erik", "the operator's name for this person wins");

    // Offboarding: the tombstone REFUSES the mint. Falling back to auto-admit here would
    // re-admit the identity under its old derived principal — offboarding that un-offboards.
    await t.space.put({ kind: "oidc_identity", body: { ...mapped, retired: true } });
    const banned = await post(t.handler, { id_token: await t.keys.sign(claims({ iat: 1 + Math.floor(Date.now() / 1000) })) });
    assertEquals(banned.status, 401, "a retired mapping is a ban, not an unmapping");
    assert((await banned.json()).detail.includes("retired"));

    // And a deliberate re-admission is a successor record, exactly like any registry revival.
    await t.space.put({ kind: "oidc_identity", body: mapped });
    const back = await post(t.handler, { id_token: await t.keys.sign(claims({ iat: 2 + Math.floor(Date.now() / 1000) })) });
    assertEquals((await back.json()).agent, "human:erik");
  } finally {
    await t.close();
  }
});

Deno.test("oidc: a mapping may not name a privileged principal, at write time and at mint time", async () => {
  const keys = await makeTestKeys();
  const t = await newSpace({ keys });
  try {
    await assertRejects(
      () => t.space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "s", principal: "human:local" } }),
      RadiaError,
      "privileged",
    );
    await assertRejects(
      () => t.space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "s", principal: "agent:worker" } }),
      RadiaError,
      "human:",
    );

    // Config drift: the mapping was legal when written, and its principal became an operator
    // LATER. The mint re-checks, or OIDC becomes an operator-minting oracle.
    await t.space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "user-1", principal: "human:boss" } });
    const promoted = new Space(t.adapter, {
      operators: ["human:local", "human:boss"],
      oidc: { issuer: ISS, audience: AUD, jwksUri: `${ISS}/jwks.json` },
      // deno-lint-ignore no-explicit-any
    } as any);
    promoted.oidcFetch = () => Promise.resolve(keys.jwksDoc);
    await promoted.loadKinds();
    const bossToken = await keys.sign(claims());
    await assertRejects(() => promoted.mintOidcRun(bossToken), RadiaError, "privileged");
  } finally {
    await t.close();
  }
});

Deno.test("oidc: one id_token is one run — replay returns it, a stop kills it", async () => {
  const t = await newSpace();
  try {
    const idToken = await t.keys.sign(claims());
    const first = await (await post(t.handler, { id_token: idToken })).json();
    const again = await (await post(t.handler, { id_token: idToken })).json();
    assertEquals(again.run, first.run, "the same id_token names the same run");
    assertEquals(again.runToken, first.runToken, "and the same token");
    const rows = await t.space.query({ kind: "agent_run", match: { run: first.run } }, 10, { dir: "desc" });
    assertEquals(rows.length, 1, "a replay writes NOTHING");

    // Revocation wins over replay: the newest record per hash is a stop, and the mint honours it.
    await t.space.stopRun(first.run);
    const stopped = await post(t.handler, { id_token: idToken });
    assertEquals(stopped.status, 401, "a stopped run's id_token does not resurrect it");
  } finally {
    await t.close();
  }
});

Deno.test("oidc: the per-subject ceiling refuses session number N+1 with 429", async () => {
  const t = await newSpace({ ctx: { maxOidcRunsPerSubject: 2 } });
  try {
    const s = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2; i++) {
      const r = await post(t.handler, { id_token: await t.keys.sign(claims({ iat: s + i })) });
      assertEquals(r.status, 201);
    }
    const third = await post(t.handler, { id_token: await t.keys.sign(claims({ iat: s + 9 })) });
    assertEquals(third.status, 429, "an unauthenticated endpoint appending permanent records needs a ceiling");
    assertEquals((await third.json()).title, "too_many_runs");
    // A DIFFERENT subject is unaffected: the ceiling is per identity, not per space.
    const other = await post(t.handler, { id_token: await t.keys.sign(claims({ sub: "user-2" })) });
    assertEquals(other.status, 201);
  } finally {
    await t.close();
  }
});

Deno.test("oidc: JWKS is fetched once, refetched once on an unknown kid, and a flood hits the cooldown", async () => {
  const issuer = await startIssuer({ audience: AUD });
  try {
    const adapter = new SqliteAdapter(":memory:");
    await adapter.init();
    // No jwksUri: this is the discovery-document path, over a real socket, with the platform's
    // real fetcher — the one chain a stubbed fetch cannot exercise.
    // deno-lint-ignore no-explicit-any
    const space = new Space(adapter, { oidc: { issuer: issuer.base, audience: AUD } } as any);
    const handler: Handler = makeHandler(space, "<html>x</html>", true);
    const mint = (tok: string) => post(handler, { id_token: tok });
    const good = (over: Record<string, unknown> = {}) => {
      const s = Math.floor(Date.now() / 1000);
      return issuer.sign({ iss: issuer.base, aud: AUD, sub: "u", iat: s, exp: s + 300, ...over });
    };
    try {
      for (let i = 0; i < 3; i++) assertEquals((await mint(await good({ iat: i }))).status, 201);
      assertEquals(issuer.served.discovery, 1, "discovery is cached with the JWKS");
      assertEquals(issuer.served.jwks, 1, "N mints, one fetch");

      assertEquals((await mint(await good({}, )).then((r) => r.status)), 201);
      const unknown = await mint(await issuer.sign({ iss: issuer.base, aud: AUD, sub: "u", iat: 0, exp: Math.floor(Date.now() / 1000) + 300 }, { kid: "rotated-away" }));
      assertEquals(unknown.status, 401);
      assertEquals(issuer.served.jwks, 2, "an unknown kid earns exactly one refetch (rotation is real)");

      // The flood: fresh random kid per request must NOT convert into fetches at the IdP.
      for (let i = 0; i < 5; i++) {
        const r = await mint(await issuer.sign({ iss: issuer.base, aud: AUD, sub: "u", iat: i, exp: Math.floor(Date.now() / 1000) + 300 }, { kid: `garbage-${i}` }));
        assertEquals(r.status, 401);
      }
      assertEquals(issuer.served.jwks, 2, "the cooldown is global: a unique-kid flood gets the cache's answer");
      assertEquals((await mint(await good({ iat: 99 }))).status, 201, "legitimate sign-ins ride the cache through the flood");
    } finally {
      await adapter.close();
    }
  } finally {
    await issuer.close();
  }
});

Deno.test("oidc: the verifier's cache honours its TTL and single-flights concurrent fetches", async () => {
  const keys = await makeTestKeys();
  let fetches = 0;
  const fetchJson = async () => {
    fetches++;
    await new Promise((r) => setTimeout(r, 20)); // long enough that concurrency would overlap
    return keys.jwksDoc;
  };
  const cfg = { issuer: ISS, audience: AUD, jwksUri: `${ISS}/jwks.json` };
  const now = Date.now();
  const token = await keys.sign(claims());

  // Single-flight: five concurrent verifies against a cold cache are ONE fetch.
  const v1 = new OidcVerifier(cfg, fetchJson);
  const results = await Promise.all(Array.from({ length: 5 }, () => v1.verify(token, now)));
  assert(results.every((r) => r.ok));
  assertEquals(fetches, 1, "concurrent cold verifies share one JWKS fetch");

  // TTL: a rotated IdP key must not verify until restart, so the cache expires.
  fetches = 0;
  const v2 = new OidcVerifier(cfg, fetchJson, { ttlMs: 1 });
  assert((await v2.verify(token, now)).ok);
  assert((await v2.verify(token, now + 10)).ok);
  assertEquals(fetches, 2, "past the TTL the JWKS is refetched");
});

Deno.test("oidc: the identity registry never compacts, even redeclared with a hostile contentKey", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  try {
    const space = new Space(adapter);
    // Three records, one (iss, sub): two supersessions and a tombstone. Under compaction with a
    // contentKey of ["principal"] the older rows are exactly what a keep-newest pass deletes.
    const body = { iss: ISS, sub: "user-1", principal: "human:erik" };
    const { id: a } = await space.put({ kind: "oidc_identity", body });
    const { id: b } = await space.put({ kind: "oidc_identity", body: { ...body, note: 2 } });
    const { id: c } = await space.put({ kind: "oidc_identity", body: { ...body, retired: true } });
    // The hostile-but-legal move: any `put: kind_def` grant may EXTEND a reserved kind, and a
    // contentKey is an extension (assertReservedCompatible pins only paths and claimable).
    await space.put({
      kind: "kind_def",
      body: {
        kind: "oidc_identity",
        indexedPaths: [{ path: "iss", type: "keyword" }, { path: "sub", type: "keyword" }],
        claimable: false,
        contentKey: ["principal"],
      },
    });
    const r = await space.gc();
    assertEquals(r.compaction?.byKind?.["oidc_identity"] ?? 0, 0, "NEVER_COMPACT holds whatever anyone declares");
    for (const id of [a, b, c]) assert(await space.getRecord(id), `record ${id} must survive: identity history is audit, and the tombstone is a ban`);
  } finally {
    await adapter.close();
  }
});
