// The BUILT browser bundle, booted under Deno: one wire round trip through the artifact
// `scripts/build-browser.sh` actually ships (agent_docs/plan-browser-space.md step 6).
//
// What this covers that the source suites cannot: the bundle is a different artifact from the
// source tree (minified, tree-shaken, PGlite left external), and only importing THAT file proves
// the bundling kept the module graph whole. Semantics are already covered by the PGlite adapter's
// conformance runs; a browser is deliberately not involved (nothing in this repo launches one),
// so the in-page half is a person's click-through.
//
// SKIPS when the bundle has not been built, loudly: `deno task conformance` must stay runnable
// from a clean checkout, and `deno task bundle-browser` always runs this for real. The same
// cannot-silently-skip stance as py-parity: the build task is the run that cannot skip.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const bundlePath = fromFileUrl(new URL("../docs/playground/radia-space.js", import.meta.url));
const built = await Deno.stat(bundlePath).then(() => true, () => false);

Deno.test({
  name: "browser bundle: the built artifact boots a space and serves the wire",
  ignore: !built,
  fn: async () => {
    // The bundle imports `@electric-sql/pglite` as a bare EXTERNAL specifier; under `deno test
    // --config` the import map resolves it to the real npm package, standing in for the page's
    // own import map pointing at the staged dist.
    const { bootBrowserSpace } = await import(`file://${bundlePath}`) as {
      bootBrowserSpace: (o?: Record<string, unknown>) => Promise<{
        handler: (req: Request) => Promise<Response>;
        operatorToken: string;
        stop: () => Promise<void>;
      }>;
    };
    const { handler, stop } = await bootBrowserSpace({}); // in-memory PGlite, open mode
    try {
      const health = await handler(new Request("http://radia.local/v0/health"));
      assertEquals(health.status, 200, await health.clone().text());

      // Open mode: a request with no Authorization acts as the operator, which is the playground's
      // posture. Kind declaration and a put/query round trip, all through the wire.
      const declare = await handler(
        new Request("http://radia.local/v0/records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "kind_def",
            body: { kind: "document", indexedPaths: [{ path: "type", type: "keyword" }], claimable: true },
          }),
        }),
      );
      assertEquals(declare.status, 201, await declare.clone().text());

      const put = await handler(
        new Request("http://radia.local/v0/records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "document", body: { type: "scan", file: "page.png" } }),
        }),
      );
      assertEquals(put.status, 201, await put.clone().text());

      const query = await handler(
        new Request("http://radia.local/v0/records/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "document", match: { type: "scan" }, limit: 10 }),
        }),
      );
      assertEquals(query.status, 200, await query.clone().text());
      const rows = (await query.json() as { records: unknown[] }).records;
      assertEquals(rows.length, 1, "the record written through the bundle's wire reads back");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "browser bundle: not built here (run `deno task bundle-browser` to build and test it)",
  ignore: built,
  fn: () => {},
});
