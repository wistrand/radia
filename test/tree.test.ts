// Serving a TREE over one capability (plan-workspaces Phase 11.4).
//
// The feature renders untrusted, model-written HTML to a browser, and three of the properties below
// are security properties: traversal cannot reach outside the index, a capability cannot be minted
// over bytes the caller could not already read, and the bytes are served from the isolated origin
// rather than the console's. Until this file existed they were an ARGUMENT ("path traversal is
// structurally absent because there is no filesystem") with nothing checking it, which is the shape
// this repo has been bitten by before.
//
// Driven through `makeHandler` / `makeArtifactHandler` directly, like `http.test.ts`: a function
// from Request to Response, no socket, no ports.

import { assert, assertEquals } from "@std/assert";
import { makeArtifactHandler, makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";

type Handler = (req: Request) => Promise<Response>;

/** The isolated origin, named so capability URLs are absolute and the CSP can reference the host. */
const ARTIFACT_ORIGIN = "http://artifacts.test";

async function newTree(): Promise<{
  space: Space;
  /** The console's origin: the API, and the place a tree must NOT be served from. */
  main: Handler;
  /** The isolated artifact origin: capability URLs only. */
  bytes: Handler;
  close: () => Promise<void>;
}> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.artifactOrigin = ARTIFACT_ORIGIN;
  return {
    space,
    main: makeHandler(space, "<html>console</html>", false),
    bytes: makeArtifactHandler(space),
    close: () => adapter.close(),
  };
}

const enc = new TextEncoder();

/** A three-file site: the case the phase was written for. */
async function site(space: Space): Promise<Record<string, string>> {
  const html = await space.putArtifact(
    enc.encode(`<!doctype html><link rel=stylesheet href="./style.css"><script src="./app.js"></script><h1>hi</h1>`),
    { mediaType: "text/html" },
  );
  const css = await space.putArtifact(enc.encode("h1 { color: rebeccapurple }"), { mediaType: "text/css" });
  const js = await space.putArtifact(enc.encode("console.log('hi')"), { mediaType: "text/javascript" });
  return { "index.html": html.id, "style.css": css.id, "app.js": js.id };
}

function post(handler: Handler, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handler(new Request(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

/** Mint a path capability over `{path: artifactId}`, returning the parsed body. */
async function mint(
  main: Handler,
  tree: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; capability?: string; url?: string }> {
  const entries = Object.entries(tree).map(([path, artifactId]) => ({ path, artifactId }));
  const res = await post(main, "/v0/capabilities", { entries }, headers);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

/** GET a path under a capability on the isolated origin, exactly as a browser would. */
function get(bytes: Handler, url: string): Promise<Response> {
  return bytes(new Request(url));
}

Deno.test("tree: a three-file site serves from one capability, and relative links resolve into it", async () => {
  const { space, main, bytes, close } = await newTree();
  try {
    const tree = await site(space);
    const cap = await mint(main, tree);
    assertEquals(cap.status, 201);
    assert(cap.url!.startsWith(`${ARTIFACT_ORIGIN}/v0/w/`), `capability URL is not on the isolated origin: ${cap.url}`);
    // Trailing slash is what makes `./style.css` resolve INSIDE the tree rather than beside it. A
    // browser resolves against the URL path, so this one character is the whole feature.
    assert(cap.url!.endsWith("/"), `capability URL must end in a slash: ${cap.url}`);

    const index = await get(bytes, cap.url!);
    assertEquals(index.status, 200, "a bare capability URL serves index.html");
    assert((await index.text()).includes("<h1>hi</h1>"));

    // Resolve the page's own relative references with the same algorithm a browser uses, and fetch
    // what comes out. This is the mechanical form of "relative links resolve": no browser is
    // launched, and nothing is asserted about a URL that was not derived from the page's markup.
    for (const [href, mediaType] of [["./style.css", "text/css"], ["./app.js", "text/javascript"]]) {
      const resolved = new URL(href, cap.url!).toString();
      const res = await get(bytes, resolved);
      assertEquals(res.status, 200, `${href} resolved to ${resolved} and did not serve`);
      assert(res.headers.get("content-type")?.startsWith(mediaType), `${href} served as ${res.headers.get("content-type")}`);
      await res.body?.cancel();
    }
  } finally {
    await close();
  }
});

Deno.test("tree: a path outside the index is refused the SAME way an unknown capability is", async () => {
  // The plan's verification list said 404 here. The code answers 403, deliberately and better: one
  // answer for an unknown capability, an expired one, and a path that is simply not in the tree, so
  // a prober cannot map what a tree contains by reading status codes. Pinned as 403 with that
  // reasoning, and the plan corrected rather than the code.
  const { space, main, bytes, close } = await newTree();
  try {
    const cap = await mint(main, await site(space));
    const missing = await get(bytes, `${cap.url}nope.txt`);
    assertEquals(missing.status, 403);

    const unknown = await get(bytes, `${ARTIFACT_ORIGIN}/v0/w/not-a-capability/index.html`);
    assertEquals(unknown.status, 403, "an unknown capability must be indistinguishable from a missing path");
    assertEquals(await missing.text(), await unknown.text(), "the two answers must be byte-identical, or the status is a probe");
  } finally {
    await close();
  }
});

Deno.test("tree: traversal MISSES the index rather than being normalised into it", async () => {
  // The claim under test: there is no filesystem here, so a path is an exact key in a fixed map and
  // `..` is just a key that is not in it. Each of these is a real attempt at the shape that would be
  // a directory-traversal CVE against a server that resolves paths on disk.
  const { space, main, bytes, close } = await newTree();
  try {
    const tree = await site(space);
    // A file that exists in the space but NOT in the capability's index. Traversal succeeding would
    // reach exactly this class of thing: readable bytes the capability was never minted over.
    const secret = await space.putArtifact(enc.encode("TOP-SECRET"), { mediaType: "text/plain" });
    const cap = await mint(main, tree);

    // ENCODED separators are the ones that reach the handler as literal text, so these are the real
    // test of "the index is the allowlist": nothing has resolved them, and they simply miss.
    const attempts = [
      "%2e%2e%2fsecret.txt", // `../secret.txt`
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "..%2findex.html",
      "/etc/passwd", // absolute, so the URL carries `//etc/passwd` and the path starts with a slash
      `${secret.id}`, // the artifact id itself is not a path in this tree
    ];
    for (const attempt of attempts) {
      const res = await get(bytes, `${cap.url}${attempt}`);
      assertEquals(res.status, 403, `'${attempt}' was served`);
      const text = await res.text();
      assert(!text.includes("TOP-SECRET"), `'${attempt}' leaked an artifact outside the index`);
    }

    // An UNENCODED `..` never reaches the tree route at all: the URL parser removes the dot segment
    // first, so the request lands somewhere else entirely and the capability is not even consulted.
    // Two independent layers, and worth separating, because only the second one is the property the
    // design claims ("the index is the allowlist"); the first is a gift from the URL parser that a
    // different client could decline to give.
    const climbed = new URL(`${cap.url}../../v0/health`);
    assert(!climbed.pathname.startsWith("/v0/w/"), `a dot segment survived into the tree route: ${climbed.pathname}`);
    const escaped = await get(bytes, climbed.toString());
    assert(escaped.status !== 200, "climbing out of the capability reached a live route on the artifact origin");

    // A dot segment that does NOT climb is ordinary relative addressing, resolved by the same parser
    // and served: this is what a browser sends for `./style.css`, and refusing it would break the
    // feature rather than secure it.
    const dotted = await get(bytes, `${cap.url}./index.html`);
    assertEquals(dotted.status, 200, "an ordinary relative reference must still serve");
    await dotted.body?.cancel();

    // And the tree still works: a guard that refuses everything is not a guard.
    assertEquals((await get(bytes, `${cap.url}index.html`)).status, 200);
  } finally {
    await close();
  }
});

Deno.test("tree: a capability cannot be minted over bytes the caller could not already read", async () => {
  // The mint is where authorization happens, once, because the served URL carries no credential
  // afterwards. A scoped principal that could turn a foreign artifact into a public link would have
  // laundered a read grant into a bearer URL.
  const { space, main, close } = await newTree();
  try {
    const foreign = await space.putArtifact(enc.encode("TOP-SECRET"), { mediaType: "text/plain" });

    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "artifact", operations: ["put", "read_one", "query"], scope: { createdBy: "self" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };
    const mine = await space.putArtifact(enc.encode("mine"), { mediaType: "text/plain" }, undefined, "agent:w");

    const stolen = await mint(main, { "index.html": foreign.id }, auth);
    assertEquals(stolen.status, 404, "a foreign artifact must be 404, not 403: a mint is not an existence oracle either");

    const mixed = await mint(main, { "index.html": mine.id, "secret.txt": foreign.id }, auth);
    assertEquals(mixed.status, 404, "ONE unreadable entry refuses the whole capability");

    const own = await mint(main, { "index.html": mine.id }, auth);
    assertEquals(own.status, 201, "its own artifact still mints, or the check is just a wall");
  } finally {
    await close();
  }
});

Deno.test("tree: a shredded file is GONE on its path while the rest of the site still serves", async () => {
  const { space, main, bytes, close } = await newTree();
  try {
    const tree = await site(space);
    const cap = await mint(main, tree);
    await space.shredArtifact(tree["style.css"], { reason: "a secret got committed" });

    const shredded = await get(bytes, `${cap.url}style.css`);
    assertEquals(shredded.status, 410, "an erased payload is Gone, not merely missing");
    await shredded.body?.cancel();

    // The rest of the tree is untouched: erasure is per payload, and one destroyed file does not
    // take the site down with it.
    const index = await get(bytes, `${cap.url}index.html`);
    assertEquals(index.status, 200);
    await index.body?.cancel();
  } finally {
    await close();
  }
});

Deno.test("tree: the console's origin does not serve a tree at all", async () => {
  // `--artifact-port` exists so untrusted HTML never renders on the origin that holds an operator
  // token. A tree of model-written markup is the case it was built for, so the main handler must not
  // have a second, quieter route to the same bytes.
  const { space, main, bytes, close } = await newTree();
  try {
    const cap = await mint(main, await site(space));
    const path = new URL(cap.url!).pathname;

    const onConsole = await main(new Request(`http://console.test${path}index.html`));
    assert(onConsole.status !== 200, `the console origin served a tree: ${onConsole.status}`);
    const text = await onConsole.text();
    assert(!text.includes("<h1>hi</h1>"), "the console origin returned the tree's bytes");

    // The same request on the isolated origin does serve, so the assertion above is about the
    // ORIGIN and not about a malformed URL.
    const onArtifacts = await get(bytes, `${ARTIFACT_ORIGIN}${path}index.html`);
    assertEquals(onArtifacts.status, 200);
    await onArtifacts.body?.cancel();
  } finally {
    await close();
  }
});

Deno.test("tree: a capability keeps serving the version it was minted over, after the tree is edited", async () => {
  // The snapshot property, and the reason the name-following variant is deliberately unbuilt: a
  // capability that followed a name could serve content authorized LATER, possibly by someone else,
  // under a URL whose authorization was decided at mint.
  const { space, main, bytes, close } = await newTree();
  try {
    const tree = await site(space);
    const cap = await mint(main, tree);

    // "Editing" a tree means writing a NEW artifact; records are immutable, so the old bytes are
    // still there under their own id. The capability names ids, so it cannot drift.
    await space.putArtifact(enc.encode("h1 { color: red }"), { mediaType: "text/css" });

    const css = await get(bytes, `${cap.url}style.css`);
    assertEquals(css.status, 200);
    assertEquals(await css.text(), "h1 { color: rebeccapurple }", "the capability drifted onto newer bytes");
  } finally {
    await close();
  }
});
