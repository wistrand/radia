// The chat's web UI: a CLIENT THAT HAPPENS TO LISTEN, the same shape as `radia git-serve` and the
// analysis example's app (agent_docs/plan-chat-web-ui.md).
//
//   deno run --allow-net --allow-read=examples/chat/web examples/chat/web/serve.ts --url http://127.0.0.1:7788 --port 8082
//
// Started for you by `deno task chat -- --serve --web`, as a SEPARATE PROCESS: the process holding
// the operator credential must not be the one listening.
//
// Two jobs, and it matters that they are the only two:
//
//   1. serve one HTML page
//   2. RELAY `/v0/*` to the space, forwarding the caller's Authorization header
//
// IT HOLDS NO CREDENTIAL. Every request carries the browser's own run token, so the space applies
// that person's grants and this process cannot see, or do, anything they could not.
//
// The relay exists only because the space sends no CORS headers, so a page on another origin cannot
// call `/v0` directly.

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const page = new URL("./ui.html", import.meta.url);

/** Request headers worth relaying. An allowlist rather than a copy: forwarding whatever arrives is
 *  how a proxy leaks a cookie or a hop-by-hop header it does not understand.
 *
 *  `last-event-id` is here because a watch RESUMES with it (`RadiaClient.watch` reconnects that
 *  way): dropping it turns every reconnect into a stream that restarts from now and silently loses
 *  the events in the gap. */
const TO_SPACE = [
  "authorization",
  "content-type",
  "idempotency-key",
  "last-event-id",
  "x-radia-meta",
  "x-radia-filename",
  "x-radia-parent-ids",
  // Labels an upload RAISES on its own bytes. Dropping it does not fail the write, it stores the
  // artifact unlabelled, which is the shape of mistake this allowlist is most likely to make: a
  // header nobody notices is missing until a policy that reads it silently permits something.
  "x-radia-taint",
];

/** Response headers worth relaying.
 *
 *  `content-security-policy` and `x-content-type-options` are NOT optional and are the reason this
 *  list differs from the analysis example's. The space sets both on artifact bytes and varies them
 *  by origin (`src/server/handlers/artifacts.ts`); dropping them here would put sniffable content
 *  on this page's own origin, which is where the run token lives. Bytes the page merely PAINTS
 *  (`image/*` into a blob URL) come through here; anything a browser might navigate to goes to the
 *  artifact origin under a capability instead, and never through this process. */
const FROM_SPACE = [
  "content-type",
  "content-disposition",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
];

/**
 * The app, bound to one space. A FACTORY rather than module state, so a test can point it at its
 * own space (the same reason `src/server/http.ts` has `makeHandler`).
 */
export function makeHandler(spaceUrl: string): (req: Request) => Promise<Response> {
  const space = spaceUrl.replace(/\/+$/, "");
  /** The IdP's origin, for the page's `connect-src`. Learned from the space rather than configured:
   *  the page talks to the issuer directly (discovery, then the token exchange), so a policy that
   *  did not name it would block sign-in, and a policy wide enough to skip the question would give
   *  up the property worth having. Probed once, lazily; a space restarted onto a different issuer
   *  wants this process restarted too. */
  let issuerOrigin: Promise<string> | null = null;
  const issuer = () =>
    issuerOrigin ??= fetch(space + "/v0/health")
      .then((r) => r.ok ? r.json() : null)
      .then((h) => h?.oidc?.issuer ? new URL(h.oidc.issuer).origin : "")
      .catch(() => "");

  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v0/")) return relay(space, req, url);
    // The page's one script, built by `deno task bundle-chat-web` and gitignored. Served from disk
    // rather than embedded so editing the page and rebuilding is the whole edit loop.
    if (url.pathname === "/app.js") {
      return Deno.readTextFile(new URL("./app.js", import.meta.url)).then(
        (js) =>
          new Response(js, {
            headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
          }),
        () => new Response("// missing: run `deno task bundle-chat-web`", { status: 404, headers: { "content-type": "text/javascript" } }),
      );
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // The space's own base URL, so the page can link INTO the console. Injected rather than
      // guessed: the browser may reach the space by a different name than this process does.
      // Read per request, not cached: this is an example, and editing the page while it runs is how
      // anyone will actually work on it.
      return Promise.all([Deno.readTextFile(page), issuer()]).then(
        ([html, idp]) =>
          new Response(html.replaceAll("__SPACE_URL__", space), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              // The page holds a bearer token in sessionStorage, so it states what may run in it.
              // `script-src 'self'` with no `unsafe-inline` is affordable because every decision
              // moved into the bundle: the page is markup. `connect-src` names exactly two hosts,
              // this app and the IdP, so a bug in the page cannot post the token anywhere else.
              // `img-src` allows blob: because that is how an inline preview is painted, and
              // deliberately not the artifact origin: anything a browser might NAVIGATE to opens
              // there under a capability instead (agent_docs/plan-chat-web-ui.md).
              "content-security-policy": "default-src 'self'; script-src 'self'; " +
                "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; " +
                `connect-src 'self'${idp ? " " + idp : ""}; ` +
                "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            },
          }),
        () => new Response("ui.html is missing", { status: 500 }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

async function relay(space: string, req: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const h of TO_SPACE) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // `signal` matters more here than in a polling app: a watch stream is held open for as long as
  // the tab is, and without this a closed tab leaves the upstream SSE connection running forever.
  const upstream = await fetch(space + url.pathname + url.search, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    signal: req.signal,
  }).catch((e) =>
    new Response(JSON.stringify({ title: "space_unreachable", detail: String(e) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  );
  const out = new Headers();
  for (const h of FROM_SPACE) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  // Streamed through, never buffered: the body is passed as-is so an SSE stream arrives event by
  // event. Reading it to completion here would make every watch look like a hang.
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

if (import.meta.main) {
  const space = (arg("--url") ?? "http://127.0.0.1:7788").replace(/\/+$/, "");
  const port = Number(arg("--port") ?? "8082");
  const host = arg("--host") ?? "127.0.0.1";
  Deno.serve({ port, hostname: host, onListen: () => {} }, makeHandler(space));
  console.error(`chat web ui on http://${host}:${port}  (space: ${space})`);
  // Said at boot rather than left to a blank page: the bundle is gitignored, so a fresh checkout
  // has none, and the page cannot explain a script that never arrived.
  try {
    await Deno.stat(new URL("./app.js", import.meta.url));
  } catch {
    console.error("  the UI bundle is missing; run: deno task bundle-chat-web");
  }
}
