// The one UNAUTHENTICATED write path: `POST /v0/sessions/oidc` (plan-oidc.md). Its cost matters
// differently from every other suite's, because a caller needs no credential to make the space
// pay it — the rejects are the flood-facing numbers, the mints are the sign-in experience.
//
// Token signing is RSA and costs more than most of what is measured here, so every token is
// PRE-SIGNED outside the timed region. The JWKS is stubbed (in-memory fetch): these numbers are
// the space's own work — parse, WebCrypto verify, registry read, tokenHash lookup — with the
// IdP's network cost deliberately excluded.

import type { Bench, Measurement } from "../harness.ts";
import { measure } from "../harness.ts";
import { Space } from "../../src/core/space.ts";
import { makeTestKeys } from "../../test/oidc-issuer.ts";

const ISS = "https://bench.idp";
const AUD = "bench";

export const oidcBenches: Bench[] = [
  {
    name: "oidc",
    note: "rejects are what an anonymous flood costs (wrong-iss fails on a string compare, bad-signature pays the full WebCrypto verify); first login writes mapping + profile artifact + run; replay is the read-only tokenHash path.",
    run: async (ctx) => {
      // deno-lint-ignore no-explicit-any
      const space = new Space(ctx.adapter, { oidc: { issuer: ISS, audience: AUD, jwksUri: `${ISS}/jwks.json` } } as any);
      const keys = await makeTestKeys();
      space.oidcFetch = () => Promise.resolve(keys.jwksDoc);
      const out: Measurement[] = [];
      const nowSec = Math.floor(Date.now() / 1000);
      const base = { iss: ISS, aud: AUD, iat: nowSec, exp: nowSec + 3600, preferred_username: "bench", name: "Bench User" };

      // Warm the JWKS cache outside the timed region: the first verify pays the (stubbed) fetch.
      await space.mintOidcRun(await keys.sign({ ...base, sub: "warm" })).catch(() => {});

      const wrongIss = await keys.sign({ ...base, iss: "https://evil.idp", sub: "x" });
      out.push(await measure("reject: wrong issuer", 50 * ctx.scale, () => space.mintOidcRun(wrongIss).catch(() => {})));

      const badSig = await keys.sign({ ...base, sub: "x" }, { key: keys.rogue.rsa });
      out.push(await measure("reject: bad signature", 50 * ctx.scale, () => space.mintOidcRun(badSig).catch(() => {})));

      // First logins: distinct subjects, each consumed once (warmup 0), each writing the
      // enrollment mapping, the profile artifact and the run.
      const n = 30 * ctx.scale;
      const fresh: string[] = [];
      for (let i = 0; i < n; i++) fresh.push(await keys.sign({ ...base, sub: `u-${i}` }));
      out.push(await measure("mint: first login (enrolls)", n, (i) => space.mintOidcRun(fresh[i]), 0));

      // Replay: the same id_token again is the indexed tokenHash lookup plus the registry read,
      // and writes nothing.
      const replayed = await keys.sign({ ...base, sub: "replayer" });
      await space.mintOidcRun(replayed);
      out.push(await measure("mint: replay (same token)", 50 * ctx.scale, () => space.mintOidcRun(replayed)));
      return out;
    },
  },
];
