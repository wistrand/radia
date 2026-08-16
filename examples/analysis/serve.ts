// The web app: a CLIENT THAT HAPPENS TO LISTEN, the same shape as `radia git-serve`.
//
//   deno run -A examples/analysis/serve.ts --url http://127.0.0.1:7788 --port 8081
//
// It binds its own port and needs no runtime change and no wire-contract entry. Two jobs, and it is
// important that they are the only two:
//
//   1. serve one HTML page
//   2. RELAY `/v0/*` to the space, forwarding the caller's Authorization header
//
// IT HOLDS NO CREDENTIAL. Every request carries the browser's own run token, so the space applies
// that person's grants and this process cannot see, or do, anything they could not. A proxy that
// held an operator token would be a hole no grant could close, and it would be invisible from here.
//
// The relay exists only because the space sends no CORS headers, so a page on another origin cannot
// call `/v0` directly. That is the whole reason; if the space ever allows the origin, this file
// becomes a static file server.

const arg = (n: string) => {
  const i = Deno.args.indexOf(n);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};

const page = new URL("./ui.html", import.meta.url);

/** Headers worth relaying in each direction. An allowlist rather than a copy: forwarding whatever
 *  arrives is how a proxy leaks a cookie or a hop-by-hop header it does not understand. */
const TO_SPACE = ["authorization", "content-type", "idempotency-key", "x-radia-meta", "x-radia-filename", "x-radia-parent-ids"];
const FROM_SPACE = ["content-type", "content-disposition", "cache-control"];

/**
 * The app, bound to one space. A FACTORY rather than module state, so a test can point it at its
 * own space — the same reason `src/server/http.ts` has `makeHandler`. Reading `Deno.args` at module
 * scope would have made every import of this file talk to :7788.
 */
export function makeHandler(spaceUrl: string): (req: Request) => Promise<Response> {
  const space = spaceUrl.replace(/\/+$/, "");
  return (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/v0/")) return relay(space, req, url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // The space's own base URL, so the page can link INTO the console (a stage record opens in the
    // Graph tab). Injected rather than guessed: the browser may reach the space by a different
    // name than this process does, and it is the operator who knows.
    //
    // Read per request, not cached: this is an example, and editing the page while it runs is how
    // anyone will actually work on it. No dependency for one file read.
    return Deno.readTextFile(page).then(
      (html) =>
        new Response(html.replaceAll("__SPACE_URL__", space), {
          headers: { "content-type": "text/html; charset=utf-8" },
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
  const upstream = await fetch(space + url.pathname + url.search, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
  }).catch((e) => new Response(JSON.stringify({ title: "space_unreachable", detail: String(e) }), {
    status: 502,
    headers: { "content-type": "application/json" },
  }));
  const out = new Headers();
  for (const h of FROM_SPACE) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

if (import.meta.main) {
  const space = (arg("--url") ?? "http://127.0.0.1:7788").replace(/\/+$/, "");
  const port = Number(arg("--port") ?? "8081");
  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, makeHandler(space));
  console.error(`analysis app on http://127.0.0.1:${port}  (space: ${space})`);
}
