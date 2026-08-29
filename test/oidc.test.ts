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

Deno.test("oidc: first login ENROLLS the identity as a record; renames and bans start from it", async () => {
  // Without this record the operator renames and bans by fishing the sub out of the IdP's admin
  // screen. With it, `radia query oidc_identity` shows who has signed in, a rename is a
  // successor of a visible record, and a ban is a retire of one.
  const t = await newSpace();
  try {
    const readProfile = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const got = await t.space.readArtifact(String(body.profile));
      assert(got, "the mapping references a readable profile artifact");
      const chunks: Uint8Array[] = [];
      for await (const c of got!.stream) chunks.push(c);
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(all));
    };
    const first = await (await post(t.handler, {
      id_token: await t.keys.sign(claims({ preferred_username: "demo", name: "Radia Demo", email: "demo@x.test" })),
    })).json();
    const rows = await t.space.query({ kind: "oidc_identity", match: { sub: "user-1" } }, 10, { dir: "desc" });
    assertEquals(rows.length, 1, "one enrollment record");
    const body = rows[0].body as Record<string, unknown>;
    assertEquals(body.principal, first.agent, "the record names the derived principal");
    assertEquals(body.auto, true, "…marked as enrolled, not operator-assigned");
    // The claims live in a PROFILE ARTIFACT, never in the body: the body has no erasure path and
    // the kind never compacts, so an inline name would be permanent — the erasure invariant's
    // exact target shape. The body carries only the reference.
    for (const k of ["username", "name", "email"]) assertEquals(k in body, false, `${k} must not live in the mapping body`);
    const p1 = await readProfile(body);
    assertEquals(p1.username, "demo");
    assertEquals(p1.name, "Radia Demo", "the real name (the profile scope's whole point here)");
    assertEquals(p1.email, "demo@x.test");
    assertMatch(String(p1.nonce), /^[0-9a-f]{32}$/, "low-entropy claims get a nonce, or a shredded digest stays confirmable");

    // A later login with UNCHANGED claims writes nothing…
    await post(t.handler, {
      id_token: await t.keys.sign(claims({ preferred_username: "demo", name: "Radia Demo", email: "demo@x.test", iat: 5 + Math.floor(Date.now() / 1000) })),
    });
    assertEquals((await t.space.query({ kind: "oidc_identity", match: { sub: "user-1" } }, 10, { dir: "desc" })).length, 1);

    // …a CHANGED claim refreshes: one successor, a NEW profile artifact, principal preserved,
    // absent claims kept. The IdP renamed the person; the record must not keep describing who
    // they used to be.
    await post(t.handler, {
      id_token: await t.keys.sign(claims({ preferred_username: "demo", name: "Radia Demo-Renamed", iat: 6 + Math.floor(Date.now() / 1000) })),
    });
    const refreshed = await t.space.query({ kind: "oidc_identity", match: { sub: "user-1" } }, 10, { dir: "desc" });
    assertEquals(refreshed.length, 2, "one change is one successor (audit keeps the old name reachable)");
    const now2 = refreshed[0].body as Record<string, unknown>;
    assert(now2.profile !== body.profile, "a refresh is a new artifact, not a rewrite");
    const p2 = await readProfile(now2);
    assertEquals(p2.name, "Radia Demo-Renamed");
    assertEquals(p2.email, "demo@x.test", "a claim the IdP stopped sending is never stripped");
    assertEquals(now2.principal, first.agent, "a display refresh never touches the principal");
    assertEquals(now2.auto, true, "…nor the provenance flag");
    // Same change replayed: the :after: key dedupes, no third record.
    await post(t.handler, {
      id_token: await t.keys.sign(claims({ preferred_username: "demo", name: "Radia Demo-Renamed", iat: 7 + Math.floor(Date.now() / 1000) })),
    });
    assertEquals((await t.space.query({ kind: "oidc_identity", match: { sub: "user-1" } }, 10, { dir: "desc" })).length, 2);

    // ERASURE, the reason for this whole shape: shred the profiles and the person's name is
    // gone while the mapping, the principal and sign-in itself survive.
    for (const r of refreshed) await t.space.shredArtifact(String((r.body as { profile?: string }).profile), { reason: "deletion request" });
    assertEquals(await t.space.readArtifact(String(now2.profile)), null, "the claims are destroyed");
    const afterShred = await post(t.handler, {
      id_token: await t.keys.sign(claims({ preferred_username: "demo", name: "Radia Demo-Renamed", iat: 8 + Math.floor(Date.now() / 1000) })),
    });
    assertEquals(afterShred.status, 201, "erasure of display data never breaks authentication");
    assertEquals((await (afterShred).json()).agent, first.agent);

    // Two people with the SAME claims produce DIFFERENT digests: the nonce at work. Without it,
    // a shred leaves a content address anyone holding a candidate name could confirm.
    await post(t.handler, { id_token: await t.keys.sign(claims({ sub: "twin-a", name: "Same Name" })) });
    await post(t.handler, { id_token: await t.keys.sign(claims({ sub: "twin-b", name: "Same Name" })) });
    const digestOf = async (sub: string) => {
      const rec = (await t.space.query({ kind: "oidc_identity", match: { sub } }, 1, { dir: "desc" }))[0];
      const prof = await t.space.readArtifact(String((rec.body as { profile?: string }).profile));
      return prof!.def.digest;
    };
    assert((await digestOf("twin-a")) !== (await digestOf("twin-b")), "identical claims must never share a content address");

    // The rename an operator actually performs: a successor over the SAME (iss, sub).
    await t.space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "user-1", principal: "human:demo" } });
    const renamed = await (await post(t.handler, { id_token: await t.keys.sign(claims({ iat: 9 + Math.floor(Date.now() / 1000) })) })).json();
    assertEquals(renamed.agent, "human:demo");

    // And a ban needs nothing built by hand: retire the enrollment itself.
    const u2 = await t.keys.sign(claims({ sub: "user-2" }));
    await post(t.handler, { id_token: u2 });
    await t.space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "user-2", principal: (await (await post(t.handler, { id_token: u2 })).json()).agent, retired: true } });
    const banned = await post(t.handler, { id_token: await t.keys.sign(claims({ sub: "user-2", iat: 3 + Math.floor(Date.now() / 1000) })) });
    assertEquals(banned.status, 401, "retiring the auto-enrollment bans the identity");
  } finally {
    await t.close();
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

Deno.test("oidc: `radia login --sso` runs the loopback dance end to end", async () => {
  // The CLI leg (RFC 8252): everything over real sockets — the issuer, the space, and the
  // one-shot listener — with `onUrl` playing the person's browser. PKCE is enforced by the
  // issuer (S256 verified at /token), so this passing means the CLI sent a real challenge.
  const issuer = await startIssuer({ audience: AUD });
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  // deno-lint-ignore no-explicit-any
  const space = new Space(adapter, { oidc: { issuer: issuer.base, audience: AUD } } as any);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space, "<html>x</html>", true));
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const { ssoLogin } = await import("../src/surfaces/cli.ts");
    // The issuer verifies PKCE only when a challenge arrives, so the test must SEE one or a CLI
    // that dropped PKCE entirely would still pass the dance.
    let sawPkce = false;
    let shortUrl = "";
    const browser = (url: string) => {
      shortUrl = url;
      // A browser follows the SHORT url to the authorize redirect, then the authorize redirect
      // back to the CLI's loopback listener. Two manual hops, exactly what a real browser does.
      (async () => {
        // A probe of the bare root must NOT spend the sign-in: the random path is the consent.
        const probe = await fetch(new URL("/", url), { redirect: "manual" });
        if (probe.status !== 200) throw new Error(`bare root answered ${probe.status}; an accidental hit would consume the dance`);
        await probe.body?.cancel();
        const hop1 = await fetch(url, { redirect: "manual" });
        const authorize = hop1.headers.get("location");
        await hop1.body?.cancel();
        const a = new URL(authorize!);
        sawPkce = a.searchParams.get("code_challenge_method") === "S256" && !!a.searchParams.get("code_challenge");
        const hop2 = await fetch(authorize!, { redirect: "manual" });
        const loc = hop2.headers.get("location");
        await hop2.body?.cancel();
        const done = await fetch(loc!);
        const text = await done.text();
        if (!text.includes("Signed in")) throw new Error(`listener answered: ${text.slice(0, 80)}`);
      })();
    };
    const out = await ssoLogin(base, { port: 8259, onUrl: browser, timeoutMs: 15_000 });
    assert(sawPkce, "the authorize URL carried no S256 challenge");
    assertMatch(shortUrl, /^http:\/\/127\.0\.0\.1:8259\/[0-9a-f]{12}$/, "the printed URL is short, and behind a random path — never the PKCE query string, never the bare root");
    assertMatch(out.agent, /^human:oidc-[0-9a-f]{32}$/);
    assertMatch(out.runToken, /^[0-9a-f]{48}$/);
    const r = await space.resolveToken(out.runToken);
    assert(r.ok && r.kind === "run", "the CLI holds a live run on the space");
    // And the listener is truly one-shot: the port is free again for the next sign-in.
    const again = Deno.serve({ port: 8259, hostname: "127.0.0.1", onListen: () => {} }, () => new Response("x"));
    await again.shutdown();
  } finally {
    await server.shutdown();
    await adapter.close();
    await issuer.close();
  }
});

Deno.test("oidc: the identity registry compacts under the RUNTIME's key, and a hostile contentKey changes nothing", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  try {
    const space = new Space(adapter);
    // One identity, three generations: two superseded live entries and a BAN tombstone on top.
    // The superseded rows are the privacy case — a pre-artifact enrollment carries names in an
    // immutable body, and supersede-then-compact is its only deletion path (plan-oidc.md).
    const body = { iss: ISS, sub: "user-1", principal: "human:erik" };
    const { id: a } = await space.put({ kind: "oidc_identity", body: { ...body, name: "legacy inline" } });
    const { id: b } = await space.put({ kind: "oidc_identity", body: { ...body, note: 2 } });
    const { id: c } = await space.put({ kind: "oidc_identity", body: { ...body, retired: true } });
    // TWO identities sharing one principal: under a hostile contentKey of ["principal"] one of
    // them would be superseded by the other; under the runtime's (iss, sub) key each is the
    // newest of its own identity and must survive.
    const { id: x } = await space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "sub-x", principal: "human:shared" } });
    const { id: y } = await space.put({ kind: "oidc_identity", body: { iss: ISS, sub: "sub-y", principal: "human:shared" } });
    // The hostile-but-legal move: any `put: kind_def` grant may EXTEND a reserved kind, and a
    // contentKey is an extension (assertReservedCompatible pins only paths and claimable). The
    // runtime key must win (`RUNTIME_KEYS[kind] ?? contentKey`), or this grant re-keys an
    // authorization-adjacent registry.
    //
    // `supersedes` because adding a contentKey is now an INCOMPATIBLE change
    // (plan-schema-versioning.md phase 2: it makes a kind compactable for the first time, which
    // retroactively makes stored records deletable). That is a speed bump, not a defence, and
    // saying so is the point of keeping this test hostile: a caller holding `put: kind_def` reads
    // the newest declaration and names it, exactly as this does.
    const prior = (await space.query({ kind: "kind_def", match: { kind: "oidc_identity" } }, 1, { dir: "desc" }))[0];
    await space.put({
      kind: "kind_def",
      body: {
        kind: "oidc_identity",
        indexedPaths: [{ path: "iss", type: "keyword" }, { path: "sub", type: "keyword" }],
        claimable: false,
        contentKey: ["principal"],
        supersedes: prior?.id ?? null, // `null` is the "there was none" acknowledgement; a reserved kind is declared in code
      },
    });
    const r = await space.gc();
    assertEquals(r.compaction?.byKind?.["oidc_identity"], 2, "exactly the two superseded generations go");
    assertEquals(await space.getRecord(a), null, "the legacy inline body is finally deletable");
    assertEquals(await space.getRecord(b), null);
    assert(await space.getRecord(c), "the newest per identity survives, TOMBSTONE INCLUDED: the ban stands");
    assert(await space.getRecord(x), "a shared principal is not a shared key");
    assert(await space.getRecord(y), "…in either direction: the hostile contentKey was ignored");
  } finally {
    await adapter.close();
  }
});
