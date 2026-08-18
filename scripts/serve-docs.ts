// Serve docs/ statically, for the site and the playground (agent_docs/plan-browser-space.md).
//
//   deno task serve-docs [--port 8000]
//
// Dependency-free on purpose: a static file server is twenty lines, and the one part that
// matters is the content types — `application/wasm` in particular, or the browser refuses to
// compile PGlite's module with streaming and the playground boots slow or not at all.

const args = Deno.args;
const port = Number(args[args.indexOf("--port") + 1] || "") || 8000;
const root = new URL("../docs/", import.meta.url);

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  wasm: "application/wasm",
  data: "application/octet-stream",
  svg: "image/svg+xml",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
};

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  let path = decodeURIComponent(new URL(req.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  // Resolve inside the root, and refuse anything that escapes it. `..` never leaves docs/.
  const target = new URL("." + path, root);
  if (!target.pathname.startsWith(root.pathname)) return new Response("forbidden", { status: 403 });
  try {
    const file = await Deno.open(target, { read: true });
    if ((await file.stat()).isDirectory) {
      file.close();
      return Response.redirect(new URL(req.url + "/"), 301);
    }
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return new Response(file.readable, {
      headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
});

console.log(`docs at http://127.0.0.1:${port}/  (playground: /playground/, after \`deno task bundle-browser\`)`);
