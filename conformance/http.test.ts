// The HTTP boundary.
//
// Everything else under `conformance/` tests the Space and the storage ports. Nothing tested the
// layer in front of them, and that is where several rules with security consequences live:
// authentication (a bad token must not become the operator), the artifact allowlist (attacker bytes
// on the origin that serves an operator token), and shape validation (a wrong-typed field must be
// a 400, not a 500 raised deep inside matching). Those rules cannot be reached from a Space test,
// since there is no request, and binding a real port to reach them buys flakes, not coverage. So
// this drives `makeHandler` directly: a function from Request to Response, no socket, no ports.
//
// The wire-shape section is the one to extend. The bugs it guards were found by fuzzing every
// field of every endpoint with wrong types ONCE, by hand, and the fuzzer was never checked in, so
// every endpoint added since has had no such check at all. It is a table now: add a row when you
// add a field.

import { assert, assertEquals } from "@std/assert";
import { makeArtifactHandler, makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";

type Handler = (req: Request) => Promise<Response>;

async function newHandler(
  opts: { authRequired?: boolean } = {},
): Promise<{ space: Space; handler: Handler; close: () => Promise<void> }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  return {
    space,
    handler: makeHandler(space, "<html>console</html>", opts.authRequired ?? false),
    close: () => adapter.close(),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://t${path}`, { headers });
}

/** Drain a response so an unread body never leaks a resource into the next test. */
async function drain(res: Response): Promise<void> {
  await res.body?.cancel();
}

// ---------------------------------------------------------------------------
// Artifact bytes: what a browser is allowed to RENDER from the space's origin.
// ---------------------------------------------------------------------------

Deno.test("http: only non-scriptable media renders inline; everything else downloads", async () => {
  const { space, handler, close } = await newHandler();
  try {
    // The allowlist is the security boundary, so the cases that must NOT be inline are named
    // individually rather than covered by a "not an image" rule: each is a format someone has
    // reasonably argued should render, and each is scriptable on the origin that serves the
    // console's operator token.
    const cases: Array<{ mediaType: string; disposition: "inline" | "attachment" }> = [
      { mediaType: "image/png", disposition: "inline" },
      { mediaType: "image/jpeg", disposition: "inline" },
      { mediaType: "audio/mpeg", disposition: "inline" },
      { mediaType: "video/mp4", disposition: "inline" },
      { mediaType: "text/html", disposition: "attachment" }, // the original XSS
      { mediaType: "image/svg+xml", disposition: "attachment" }, // scriptable, and matches `image/*`
      { mediaType: "application/pdf", disposition: "attachment" }, // scriptable in some viewers
      { mediaType: "text/plain", disposition: "attachment" }, // sniffable to markup
      { mediaType: "application/xhtml+xml", disposition: "attachment" },
    ];
    for (const c of cases) {
      const { id } = await space.putArtifact(new TextEncoder().encode("<script>alert(1)</script>"), {
        mediaType: c.mediaType,
      });
      const res = await handler(get(`/v0/artifacts/${id}`));
      assertEquals(res.status, 200);
      const disp = res.headers.get("content-disposition") ?? "";
      assertEquals(disp.split(";")[0], c.disposition, `${c.mediaType} must be ${c.disposition}`);
      // The backstops, on every artifact regardless of type: no MIME sniffing (which could turn a
      // downloaded type back into markup) and a CSP under which nothing loads or executes.
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      assertEquals(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      await drain(res);
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Authentication: the only channel, and its failure modes.
// ---------------------------------------------------------------------------

Deno.test("artifact origin: renders scriptable content the main origin refuses, and exposes nothing else", async () => {
  // The main origin cannot render HTML: it shares a document origin with the console, so a
  // generated page could read the console's storage. A second PORT is a second origin, and the
  // isolated handler is reachable only by capability, so no credential is ever presented to the
  // place untrusted content runs.
  const { space, close } = await newHandler();
  const bytes = makeArtifactHandler(space);
  try {
    const html = new TextEncoder().encode("<!doctype html><script>1</script>");
    const { id } = await space.putArtifact(html, { mediaType: "text/html", filename: "p.html" });
    const cap = space.mintDownloadCapability(id).capability;

    const rendered = await bytes(get(`/v0/artifacts/${id}?capability=${cap}`));
    assertEquals(rendered.status, 200);
    assertEquals(rendered.headers.get("content-disposition")?.split(";")[0], "inline", "HTML renders here");
    const csp = rendered.headers.get("content-security-policy") ?? "";
    assert(csp.includes("sandbox allow-scripts"), `opaque origin, scripts allowed: ${csp}`);
    assert(!csp.includes("allow-same-origin"), "never allow-same-origin: that undoes the isolation");
    assert(csp.includes("default-src 'none'"), "connect-src falls back to none, so fetch is denied");
    await drain(rendered);

    // Nothing but bytes-by-capability is reachable from the origin that runs untrusted scripts.
    for (const path of ["/v0/ops/stats", "/v0/health", "/", "/v0/records/query"]) {
      const res = await bytes(get(path));
      assertEquals(res.status, 404, `${path} must not exist on the artifact origin`);
      await drain(res);
    }
    // …and a bearer token buys nothing here, so there is no credential to steal.
    const noCap = await bytes(get(`/v0/artifacts/${id}`, { authorization: "Bearer anything" }));
    assertEquals(noCap.status, 403, "capability or nothing");
    await drain(noCap);

    // THE SHORT FORM, which is the URL anybody is actually handed. The capability already names one
    // record, so the id in the path and the `?capability=` spelling were ~70 characters of nothing
    // in a link a person is shown, pastes, and sometimes reads aloud.
    const short = await bytes(get(`/v0/a/${cap}`));
    assertEquals(short.status, 200, "the short capability form opens the same artifact");
    assertEquals(short.headers.get("content-disposition")?.split(";")[0], "inline");
    await drain(short);

    // It is the same authorization, not a weaker one: unknown capabilities are refused, and the
    // form carries no id to substitute, so there is nothing to tamper with except the token itself.
    for (const bad of ["nope", "", "AAAAAAAAAAAAAAAAAAAAAA"]) {
      const res = await bytes(get(`/v0/a/${bad}`));
      assert(res.status === 403 || res.status === 404, `/v0/a/${bad} must not open anything (got ${res.status})`);
      await drain(res);
    }

    // The token itself is short enough to be worth pinning: 16 bytes as base64url.
    assertEquals(cap.length, 22, "capability should be 22 base64url characters");
    assert(/^[A-Za-z0-9_-]{22}$/.test(cap), `capability must be URL-safe with no padding: ${cap}`);

    // A capability opens ONE artifact. The short form must not become a way to reach another.
    const other = await space.putArtifact(new TextEncoder().encode("other"), { mediaType: "text/plain" });
    assertEquals(space.resolveDownloadCapability(cap), id, "resolves to the artifact it was minted for");
    assert(space.resolveDownloadCapability(cap) !== other.id, "and to no other");
  } finally {
    await close();
  }
});

Deno.test("http: a bad bearer token is 401 and never falls through to the operator", async () => {
  const { handler, close } = await newHandler();
  try {
    // Open mode: NO header is the operator, by design, so local dev stays open.
    const open = await handler(get("/v0/health"));
    assertEquals(open.status, 200);
    assertEquals((await open.json()).principal, "human:local");

    // A PRESENTED token is a claim to be someone. Failing it open (the shape of the bug this
    // guards) would silently upgrade every garbage token to full operator rights. Note this holds
    // on `/v0/health` too, which is otherwise PUBLIC: "public" means no credential is needed, not
    // that a bad one is ignored, and health is the endpoint a client calls to ask whether its
    // token still works.
    for (const bad of ["nonsense", "0".repeat(48), "run:01ABC", "def-token-shaped"]) {
      const res = await handler(get("/v0/health", { authorization: `Bearer ${bad}` }));
      assertEquals(res.status, 401, `token '${bad}' must be rejected`);
      const body = await res.json();
      assert(String(body.type ?? "").includes("invalid_token"), `expected invalid_token, got ${body.type}`);
      assert(body.principal === undefined, "a rejected request must not report a principal");
    }
  } finally {
    await close();
  }
});

Deno.test("http: a definition token does not authorize coordination", async () => {
  const { space, handler, close } = await newHandler();
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["put", "query"] },
    ]);
    // A definition token mints runs; it is not a coordination principal. Accepting it here would
    // hand an agent's long-lived bootstrap credential the powers of a short-lived run token.
    const res = await handler(post("/v0/records/query", { kind: "task" }, {
      authorization: `Bearer ${definitionToken}`,
    }));
    assertEquals(res.status, 401);
    assertEquals((await res.json()).type, "about:radia/invalid_token");

    // …but it still works on the one route that reads definition tokens.
    const minted = await handler(post("/v0/agent-runs", {}, { authorization: `Bearer ${definitionToken}` }));
    assertEquals(minted.status, 201);
    const { runToken } = await minted.json();
    const ok = await handler(post("/v0/records/query", { kind: "task" }, {
      authorization: `Bearer ${runToken}`,
    }));
    assertEquals(ok.status, 200);
  } finally {
    await close();
  }
});

Deno.test("http: the provisioned operator token authorizes coordination, and cannot mint a run", async () => {
  const { space, handler, close } = await newHandler({ authRequired: true });
  try {
    // This is the credential `radia dev` writes for the CLI and the MCP adapter. Presenting it has
    // to WORK: a provisioned credential that 401s is worse than no credential at all, because in
    // required mode the no-header shortcut is gone and there is nothing else to fall back to.
    const auth = { authorization: `Bearer ${await space.mintOperatorToken()}` };
    assertEquals((await handler(get("/v0/health", auth))).status, 200);
    const stats = await handler(get("/v0/ops/stats", auth));
    assertEquals(stats.status, 200, "the operator reaches the ops plane");
    await drain(stats);
    const put = await handler(post("/v0/records", { kind: "task", body: { tag: "a" } }, auth));
    assertEquals(put.status, 201, "the operator may coordinate, not just observe");
    await drain(put);

    // It is not a definition token. It already authorizes everything directly, so minting from it
    // would only convert a leaked operator credential into a durable one.
    const minted = await handler(post("/v0/agent-runs", {}, auth));
    assertEquals(minted.status, 401, "an operator token must not mint a run");
    await drain(minted);
  } finally {
    await close();
  }
});

Deno.test("http: a stopped run's token stops authenticating, on any instance", async () => {
  const { space, handler, close } = await newHandler();
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["query"] },
    ]);
    const { run, runToken } = await space.mintRun(definitionToken);
    assertEquals((await handler(get("/v0/health", { authorization: `Bearer ${runToken}` }))).status, 200);

    await space.stopRun(run);
    const after = await handler(get("/v0/health", { authorization: `Bearer ${runToken}` }));
    assertEquals(after.status, 401, "a stopped run must not authenticate");
    assertEquals((await after.json()).type, "about:radia/run_stopped");
  } finally {
    await close();
  }
});

Deno.test("http: --auth required closes the no-header shortcut but keeps the console bootstrappable", async () => {
  const { handler, close } = await newHandler({ authRequired: true });
  try {
    const denied = await handler(post("/v0/records", { kind: "task", body: { tag: "a" } }));
    assertEquals(denied.status, 401);
    assertEquals((await denied.json()).type, "about:radia/auth_required");

    // Two routes stay public or the console cannot load itself to authenticate at all.
    assertEquals((await handler(get("/v0/health"))).status, 200);
    const page = await handler(get("/"));
    assertEquals(page.status, 200);
    await drain(page);
  } finally {
    await close();
  }
});

Deno.test("http: a principal may read its OWN permissions, and only its own", async () => {
  const { space, handler, close } = await newHandler();
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["query"] },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };

    // Note this principal has NO self-scoped grant, so the ops plane is shut to it entirely, and
    // that is precisely the caller that needs to ask what it may do. Gating this behind the plane
    // left an agent unable to tell an approved grant from a pending one.
    const own = await handler(get("/v0/ops/permissions?principal=agent:w", auth));
    assertEquals(own.status, 200);
    const view = await own.json();
    assert(view.kinds.some((k: { kind: string }) => k.kind === "task"), "its own grants are reported");

    // A run token asking about its own AGENT is asking about itself: grants flow down the chain.
    assertEquals((await handler(get("/v0/ops/permissions?principal=agent:w", auth))).status, 200);

    // Anyone else's authorization stays an operator question.
    const other = await handler(get("/v0/ops/permissions?principal=agent:elsewhere", auth));
    assertEquals(other.status, 403, "reading another principal's permissions is refused");

    // The rest of the ops plane is still shut to a principal with no self scope.
    assertEquals((await handler(get("/v0/ops/stats", auth))).status, 403);

    // …and the operator can still ask about anyone.
    assertEquals((await handler(get("/v0/ops/permissions?principal=agent:elsewhere"))).status, 200);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Wire shapes: a cast is a promise to the type checker, not a check.
// ---------------------------------------------------------------------------

Deno.test("http: a self-scoped grant narrows EVERY read verb, not just query", async () => {
  // One row per verb that returns record data. Scope was applied per handler, so the verbs that
  // forgot it (take, lineage, graph, the artifact reads) served other principals' records while
  // `query` correctly served none. Add a row when a read verb is added; a verb with no row here is
  // a verb nobody checked.
  const { space, handler, close } = await newHandler();
  try {
    space.registerKind({ kind: "secret", indexedPaths: [] });
    const secret = await space.put({ kind: "secret", body: { payload: "TOP-SECRET" } });
    await space.put({ kind: "task", body: { tag: "operator-owned" } });

    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      {
        principal: "agent:w",
        kind: "task",
        operations: ["put", "query", "read_one", "take"],
        scope: { createdBy: "self" },
      },
      { principal: "agent:w", kind: "secret", operations: ["put"], scope: { createdBy: "self" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };

    // Its own record, naming the operator's secret as a data parent. `put` never checks that a
    // parent is readable, so this is the lever a scoped principal has on foreign lineage.
    const own = await (await handler(
      post("/v0/records", { kind: "secret", body: { mine: true }, parentIds: [secret.id] }, auth),
    )).json();

    const verbs: { verb: string; run: () => Promise<Response> }[] = [
      { verb: "query", run: () => handler(post("/v0/records/query", { kind: "task" }, auth)) },
      { verb: "read_one", run: () => handler(post("/v0/records/read-one", { kind: "task" }, auth)) },
      { verb: "take", run: () => handler(post("/v0/takes", { pattern: { kind: "task" } }, auth)) },
      { verb: "lineage", run: () => handler(get(`/v0/ops/records/${own.id}/lineage`, auth)) },
      { verb: "children", run: () => handler(get(`/v0/ops/records/${secret.id}/children`, auth)) },
      { verb: "graph", run: () => handler(get(`/v0/ops/records/${own.id}/graph`, auth)) },
      { verb: "get record", run: () => handler(get(`/v0/ops/records/${secret.id}`, auth)) },
    ];
    for (const { verb, run } of verbs) {
      const res = await run();
      const text = await res.text();
      assert(
        !text.includes("TOP-SECRET") && !text.includes("operator-owned"),
        `${verb} leaked a foreign record to a self-scoped principal: ${text.slice(0, 200)}`,
      );
    }

    // A watch is reached by id alone, and ids are monotonic ULIDs, so the id is not the secret.
    const { definitionToken: other } = await space.createAgentDefinition("agent:b", [
      { principal: "agent:b", kind: "task", operations: ["query"] },
    ]);
    const { runToken: otherToken } = await space.mintRun(other);
    const { watchId } = await (await handler(post("/v0/watches", { kind: "task" }, auth))).json();
    const stolen = await handler(get(`/v0/watches/${watchId}/events`, { authorization: `Bearer ${otherToken}` }));
    assertEquals(stolen.status, 404, "a watch must not be attachable by a principal that did not create it");
    await drain(stolen);
  } finally {
    await close();
  }
});

Deno.test("http: a grant can BAR a principal from claiming tainted work, and it cannot opt out", async () => {
  // `requireUntainted` on a take is the worker's own flag, so containment used to depend on every
  // claimant volunteering it: omit the flag and tainted work arrives normally. That is a
  // convention, not a control. `scope: {taint: "none"}` moves the barrier to the side that assigns
  // authority, where an operator can impose it.
  const { space, handler, close } = await newHandler();
  try {
    await space.put({ kind: "task", body: { tag: "clean" } });
    await space.put({ kind: "task", body: { tag: "dirty" }, taint: true });

    const barred = await space.createAgentDefinition("agent:barred", [
      { principal: "agent:barred", kind: "task", operations: ["take"], scope: { taint: "none" } },
    ]);
    const { runToken: barredToken } = await space.mintRun(barred.definitionToken);

    // It never asks for the barrier, and still cannot reach the tainted record.
    const first = await (await handler(post("/v0/takes", { pattern: { kind: "task" } }, {
      authorization: `Bearer ${barredToken}`,
    }))).json();
    assertEquals(first.record.body.tag, "clean", "the untainted record is claimable");
    const second = await (await handler(post("/v0/takes", { pattern: { kind: "task" } }, {
      authorization: `Bearer ${barredToken}`,
    }))).json();
    assertEquals(second, null, "the tainted record is barred by the grant, not by the caller's flag");

    // A principal WITHOUT the barrier still claims it: the barrier is a property of the grant.
    const open = await space.createAgentDefinition("agent:open", [
      { principal: "agent:open", kind: "task", operations: ["take"] },
    ]);
    const { runToken: openToken } = await space.mintRun(open.definitionToken);
    const got = await (await handler(post("/v0/takes", { pattern: { kind: "task" } }, {
      authorization: `Bearer ${openToken}`,
    }))).json();
    assertEquals(got.record.body.tag, "dirty", "an unbarred grant still reaches tainted work");
  } finally {
    await close();
  }
});

Deno.test("http: an unbarred grant beside a barred one lifts the barrier (grants union)", async () => {
  // Grants UNION, so one grant without the barrier already permits tainted work. Enforcing the
  // barrier anyway would deny something that was granted. Same rule `authorScope` uses.
  const { space, handler, close } = await newHandler();
  try {
    await space.put({ kind: "task", body: { tag: "dirty" }, taint: true });
    const mixed = await space.createAgentDefinition("agent:mixed", [
      { principal: "agent:mixed", kind: "task", operations: ["take"], scope: { taint: "none" } },
      { principal: "agent:mixed", kind: "task", operations: ["take"], pattern: { tag: "dirty" } },
    ]);
    const { runToken } = await space.mintRun(mixed.definitionToken);
    const got = await (await handler(post("/v0/takes", { pattern: { kind: "task" } }, {
      authorization: `Bearer ${runToken}`,
    }))).json();
    assertEquals(got?.record?.body?.tag, "dirty", "a grant without the barrier permits tainted work");

    // …and the worker can still impose it on itself, voluntarily.
    await space.nack(got.lease, { backoffSeconds: 0 });
    const refused = await (await handler(post("/v0/takes", { pattern: { kind: "task" }, requireUntainted: true }, {
      authorization: `Bearer ${runToken}`,
    }))).json();
    assertEquals(refused, null, "a worker may always be more careful than its grants require");
  } finally {
    await close();
  }
});

Deno.test("http: explain names the traps a correct-looking query walked into", async () => {
  // Every note here answers a case where the request SUCCEEDED, so an error cannot carry the
  // warning and a doc arrives too late. The notes must never change the result.
  const { space, handler, close } = await newHandler();
  try {
    space.registerKind({ kind: "note", indexedPaths: [{ path: "topic", type: "keyword" }], claimable: false });
    for (let i = 0; i < 3; i++) await space.put({ kind: "note", body: { topic: "t" } });

    const full = await (await handler(post("/v0/records/query", { kind: "note", limit: 2, explain: true }))).json();
    assertEquals(full.records.length, 2);
    const joined = (full.explain as string[]).join(" | ");
    assert(joined.includes("PAGE"), `a full page must be called a page: ${joined}`);
    assert(joined.includes("OLDEST"), `the default order must be named: ${joined}`);
    assert(joined.includes("claimable:false"), `reference kinds must be named: ${joined}`);

    // An undeclared kind can only ever return nothing, and says which kinds exist.
    const missing = await (await handler(post("/v0/records/query", { kind: "nope", explain: true }))).json();
    assert((missing.explain as string[]).join(" ").includes("no kind 'nope' is declared"));
    assert((missing.explain as string[]).join(" ").includes("note"), "it lists what IS declared");

    // Without the flag the response is byte-identical to before.
    const plain = await (await handler(post("/v0/records/query", { kind: "note", limit: 2 }))).json();
    assertEquals(plain.explain, undefined, "explain is opt-in and never changes the result");
    assertEquals(plain.records.length, 2);
  } finally {
    await close();
  }
});

Deno.test("http: the digest orients an investigator, and scopes the part that is cross-principal", async () => {
  const { space, handler, close } = await newHandler();
  try {
    space.registerKind({ kind: "note", indexedPaths: [{ path: "topic", type: "keyword" }], claimable: false });
    await space.put({ kind: "note", body: { topic: "t" } });

    const d = await (await handler(get("/v0/ops/digest"))).json();
    assertEquals(d.api, "v0");
    assertEquals(d.complete, true, "a digest that truncated would be worse than none");
    assert(d.kinds.some((k: { kind: string; claimable: boolean }) => k.kind === "note" && k.claimable === false));
    assert(d.kinds.some((k: { kind: string; reserved: boolean }) => k.kind === "grant" && k.reserved), "reserved kinds are named");
    assert(d.counts.some((c: { kind: string }) => c.kind === "note"), "counts come from the space, not a guess");

    // The interest list is the routing table, so a scoped caller sees only its own.
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "note", operations: ["query"], scope: { createdBy: "self" } },
      { principal: "agent:w", kind: "interest", operations: ["put", "query"] },
    ]);
    const { run, runToken } = await space.mintRun(definitionToken);
    await space.put({ kind: "interest", body: { kind: "note" } }, undefined, run);
    await space.put({ kind: "interest", body: { kind: "note", match: { topic: "other" } } });

    // Grouped as one edge per (kind, agent): the operator's two interests come from two different
    // authors, so they stay two rows.
    const operator = await (await handler(get("/v0/ops/digest"))).json();
    assertEquals(operator.interests.length, 2, "the operator sees the whole routing table");
    assert(operator.interests.every((e: { patterns: number }) => e.patterns >= 1));

    const scoped = await (await handler(get("/v0/ops/digest", { authorization: `Bearer ${runToken}` }))).json();
    assertEquals(scoped.interests.length, 1, "a scoped caller sees only its own interest");
    assertEquals(scoped.interests[0].agent, "agent:w", "the edge names the agent, not the run");
    assertEquals(scoped.interests[0].runs, 1);
    // …and it is TOLD the list is partial, so an empty one is never read as an idle fleet.
    assertEquals(scoped.interestsWithheld, 1);
    assert(String(scoped.interestsNote).includes("does NOT mean nothing is listening"));
  } finally {
    await close();
  }
});

Deno.test("http: thread returns the whole story in causal order, from the root down", async () => {
  const { space, handler, close } = await newHandler();
  try {
    // job -> task -> result, asked from the MIDDLE of the chain: the verb has to walk up to the
    // root and back down, which is the composition callers get wrong by walking one direction.
    const job = (await space.put({ kind: "task", body: { tag: "job" } })).id;
    const task = (await space.put({ kind: "task", body: { tag: "task" }, parentIds: [job] })).id;
    const result = (await space.put({ kind: "task", body: { tag: "result" }, parentIds: [task] })).id;

    const t = await (await handler(get(`/v0/ops/records/${task}/thread`))).json();
    assertEquals(t.root, job, "the story starts at the lineage root, not at the record asked for");
    assertEquals(t.records.map((r: { id: string }) => r.id), [job, task, result], "causal order");
    assertEquals(t.truncated, false);
    assertEquals(t.note, undefined);

    assertEquals((await handler(get("/v0/ops/records/01000000000000000000000000/thread"))).status, 404);
  } finally {
    await close();
  }
});

Deno.test("http: a wrong-typed field is a 400 at the boundary, never a 500 from inside", async () => {
  const { handler, close } = await newHandler();
  try {
    // Each row is a field that USED to be cast straight out of the JSON and blow up somewhere
    // deep: in matching, in the adapter, in ULID parsing. The assertion is deliberately weak on
    // the code and strict on the class: any 4xx is a boundary that held, a 5xx is one that did not.
    const cases: Array<{ path: string; body: unknown; about: string }> = [
      { path: "/v0/records", body: { kind: "task", body: { tag: "a" }, parentIds: 42 }, about: "parentIds not an array" },
      { path: "/v0/records", body: { kind: "task", body: { tag: "a" }, parentIds: [7] }, about: "parent id not a string" },
      { path: "/v0/records", body: { kind: "task", body: { tag: "a" }, deadlineAt: {} }, about: "deadlineAt not a string" },
      { path: "/v0/records", body: { kind: "task", body: { tag: "a" }, retentionUntil: "soon" }, about: "retentionUntil not a date" },
      { path: "/v0/records", body: { kind: "task", body: { tag: "a" }, clientMeta: [] }, about: "clientMeta an array" },
      { path: "/v0/records", body: { kind: 5, body: {} }, about: "kind not a string" },
      { path: "/v0/records", body: { body: { tag: "a" } }, about: "kind missing" },

      // NOTE the wire shapes differ per endpoint, and that is the frozen contract rather than a
      // slip: query/read-one/watches take the pattern FLATTENED at the top level, `takes` nests
      // it under `pattern`. Copying a row to another endpoint without checking which shape it
      // uses tests nothing. The handler reads a field that was never there and rejects it for
      // the wrong reason.
      { path: "/v0/records/query", body: { kind: "task", match: 3 }, about: "match not an object" },
      { path: "/v0/records/query", body: { kind: "task", match: [] }, about: "match an array" },
      { path: "/v0/records/query", body: { kind: "task", orderBy: "tag" }, about: "orderBy a string" },
      { path: "/v0/records/query", body: { kind: "task", after: 7 }, about: "after not a record id" },
      { path: "/v0/records/query", body: { kind: "task", dir: "sideways" }, about: "dir neither asc nor desc" },
      { path: "/v0/records/query", body: { kind: 5 }, about: "kind not a string" },
      { path: "/v0/records/query", body: { kind: "task", match: { tag: { $bogus: 1 } } }, about: "unknown operator" },
      { path: "/v0/records/query", body: { kind: "task", match: { tag: { $regex: "a" } } }, about: "$regex is never a pattern" },
      { path: "/v0/records/read-one", body: {}, about: "no pattern at all" },
      { path: "/v0/records/read-one", body: { kind: "task", match: [] }, about: "match an array" },

      { path: "/v0/takes", body: {}, about: "no selector at all" },
      { path: "/v0/takes", body: { pattern: [] }, about: "pattern an array" },
      { path: "/v0/takes", body: { pattern: {} }, about: "pattern with no kind" },
      { path: "/v0/takes", body: { recordId: 5 }, about: "recordId not a string" },
      { path: "/v0/leases/ack", body: {}, about: "no lease at all" },
      { path: "/v0/leases/ack", body: { leaseId: 1, epoch: 1 }, about: "leaseId not a string" },
      { path: "/v0/leases/ack", body: { leaseId: "x", epoch: "1" }, about: "epoch not a number" },
      { path: "/v0/leases/ack", body: { leaseId: "x", epoch: 1, result: [] }, about: "result an array" },
      { path: "/v0/leases/renew", body: { leaseId: "x", epoch: 1, leaseSeconds: {} }, about: "leaseSeconds an object" },
      { path: "/v0/leases/nack", body: { leaseId: "x", epoch: 1, backoffSeconds: [] }, about: "backoffSeconds an array" },
      { path: "/v0/watches", body: { kind: 7 }, about: "watch kind not a string" },
      { path: "/v0/watches", body: {}, about: "watch with no pattern" },
    ];
    for (const c of cases) {
      const res = await handler(post(c.path, c.body));
      assert(res.status >= 400 && res.status < 500, `${c.path} (${c.about}) answered ${res.status}, expected 4xx`);
      // …and it must be parseable: the SDK does JSON.parse on the body, so a plain-text 500 shows
      // up as "Unexpected token 'I'" and hides whatever actually went wrong.
      assert(
        (res.headers.get("content-type") ?? "").includes("json"),
        `${c.path} (${c.about}) answered ${res.headers.get("content-type")}, not JSON`,
      );
      await res.json();
    }
  } finally {
    await close();
  }
});

Deno.test("http: a body of any JSON type is accepted, and does not poison the reads after it", async () => {
  const { handler, close } = await newHandler();
  try {
    // The wire contract puts NO constraint on `body` (`body: {}`, only `kind` required), so these
    // are legal records, not malformed requests, which is why they belong here rather than in the
    // 400 table above. What must hold is that a body the matcher cannot destructure does not break
    // the queries that run over the same kind afterwards: the failure mode was a 500 from inside
    // matching, reached by a record someone else wrote.
    for (const body of [null, [], 42, "text", true]) {
      const res = await handler(post("/v0/records", { kind: "task", body }));
      assertEquals(res.status, 201, `body ${JSON.stringify(body)} is legal per the contract`);
      await res.json();
    }
    await handler(post("/v0/records", { kind: "task", body: { tag: "real" } }));

    const q = await handler(post("/v0/records/query", { kind: "task", match: { tag: "real" } }));
    assertEquals(q.status, 200);
    const { records } = await q.json();
    assertEquals(records.length, 1, "the odd bodies neither match nor break the match");

    // A match against a path no body has is an empty answer, not an error.
    const none = await handler(post("/v0/records/query", { kind: "task", match: { tag: "absent" } }));
    assertEquals(none.status, 200);
    assertEquals((await none.json()).records.length, 0);
  } finally {
    await close();
  }
});

Deno.test("http: a wrong-typed BOUND falls back to its default rather than failing the request", async () => {
  const { handler, close } = await newHandler();
  try {
    // Deliberate asymmetry, recorded here so the next reader does not "fix" it into a 400: a
    // malformed field that changes WHICH records are involved is rejected, while a malformed
    // field that only sizes the answer (limit, leaseSeconds, backoffSeconds) falls back to its
    // default. The first silently answers a different question; the second cannot.
    await handler(post("/v0/records", { kind: "task", body: { tag: "a" } }));
    const q = await handler(post("/v0/records/query", { kind: "task", limit: "ten" }));
    assertEquals(q.status, 200, "a bad limit uses the default limit");
    assert((await q.json()).records.length >= 1);

    const t = await handler(post("/v0/takes", { pattern: { kind: "task" }, leaseSeconds: "60" }));
    assertEquals(t.status, 200, "a bad leaseSeconds uses the default lease");
    await t.json();
  } finally {
    await close();
  }
});

Deno.test("http: a non-boolean `taint` cannot raise taint", async () => {
  const { handler, close } = await newHandler();
  try {
    // `taint` is the one authoritative field a client may RAISE, and the mapping is `=== true`,
    // so anything else is simply absent rather than a 400. That is the fail-SAFE direction, and
    // this pins it: the risk to guard is a truthy-looking value being read as "raise", never a
    // rejected request.
    for (const taint of ["yes", 1, {}, "true"]) {
      const res = await handler(post("/v0/records", { kind: "task", body: { tag: "t" }, taint }));
      assertEquals(res.status, 201);
      const { id } = await res.json();
      const record = await (await handler(get(`/v0/ops/records/${id}`))).json();
      assertEquals(record.runtimeMeta?.taint ?? false, false, `taint: ${JSON.stringify(taint)} must not raise`);
    }
    const raised = await handler(post("/v0/records", { kind: "task", body: { tag: "t" }, taint: true }));
    const { id } = await raised.json();
    const record = await (await handler(get(`/v0/ops/records/${id}`))).json();
    assertEquals(record.runtimeMeta?.taint, true, "a real boolean still raises it");
  } finally {
    await close();
  }
});

Deno.test("http: a malformed request body is a 400, not a crash", async () => {
  const { handler, close } = await newHandler();
  try {
    for (const raw of ["not json", "", "[1,2,3]", '"a string"', "null"]) {
      const res = await handler(
        new Request("http://t/v0/records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );
      assert(res.status >= 400 && res.status < 500, `body ${JSON.stringify(raw)} answered ${res.status}`);
      await res.json();
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// A filtered feed must stay pageable.
// ---------------------------------------------------------------------------

Deno.test("http: a scoped caller can page PAST a run of events it cannot see", async () => {
  const { space, handler, close } = await newHandler();
  try {
    // Another agent fills the log first. This is the shape that broke: the scoped caller's own
    // events sit behind a wall of foreign ones, and a page that filters instead of scanning
    // returns empty, which every caller reads as "end of log".
    for (let i = 0; i < 60; i++) await space.put({ kind: "task", body: { tag: `theirs${i}` } });

    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["put", "query"], scope: { createdBy: "self" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const mine = await handler(post("/v0/records", { kind: "task", body: { tag: "mine" } }, {
      authorization: `Bearer ${runToken}`,
    }));
    assertEquals(mine.status, 201);

    // Page with a small limit so the caller MUST advance across the foreign run to reach its own.
    const seen: string[] = [];
    let after = "0";
    for (let page = 0; page < 20; page++) {
      const res = await handler(get(`/v0/ops/events?after=${encodeURIComponent(after)}&limit=5`, {
        authorization: `Bearer ${runToken}`,
      }));
      assertEquals(res.status, 200);
      const body = await res.json();
      for (const e of body.events) seen.push(e.recordId);
      if (!body.nextAfter || body.nextAfter === after) break;
      after = body.nextAfter;
    }
    assert(seen.length > 0, "the caller reached its own events instead of stopping at the first empty page");

    // And the answer says it is narrowed. An empty or short scoped page with no stated scope is
    // how a caller concludes the space is empty.
    const one = await handler(get("/v0/ops/events?limit=5", { authorization: `Bearer ${runToken}` }));
    const body = await one.json();
    assert(body.scope, "a scoped response must describe its scope");
  } finally {
    await close();
  }
});

Deno.test("http: a run renews itself with its own token, and an expired one cannot", async () => {
  const { space, handler, close } = await newHandler({ authRequired: true });
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w");
    const { run, runToken } = await space.mintRun(definitionToken);

    // Its OWN token. A definition token is deliberately not accepted: it can mint a fresh run
    // whenever it likes, so letting it renew adds nothing and widens what a long-lived credential
    // reaches.
    const ok = await handler(post(`/v0/agent-runs/${run}/renew`, {}, { authorization: `Bearer ${runToken}` }));
    assertEquals(ok.status, 200);
    const body = await ok.json();
    assertEquals(body.run, run);
    assert(Date.parse(body.expiresAt) > Date.now(), "renewal must move expiry into the future");
    assert(Date.parse(body.maxLifetimeAt) >= Date.parse(body.expiresAt), "the ceiling bounds the window");

    // Another run's token cannot renew this one: renewal is not a verb you hold, it is one you hold
    // FOR something.
    const other = await space.mintRun((await space.createAgentDefinition("agent:x")).definitionToken);
    const foreign = await handler(post(`/v0/agent-runs/${run}/renew`, {}, { authorization: `Bearer ${other.runToken}` }));
    assertEquals(foreign.status, 403, "one run must not extend another's session");
    await foreign.body?.cancel();

    // An EXPIRED token cannot renew itself: `resolveAuth` rejects it first. That is the property
    // that stops renewal from being a long-lived token in disguise, and it is why a client renews
    // at half-life rather than waiting for a failure.
    const dying = new Space((space as unknown as { storage: never }).storage, { runTokenSeconds: -1 });
    const d = await dying.createAgentDefinition("agent:z");
    const { run: deadRun, runToken: deadToken } = await dying.mintRun(d.definitionToken);
    const dead = await handler(post(`/v0/agent-runs/${deadRun}/renew`, {}, { authorization: `Bearer ${deadToken}` }));
    assertEquals(dead.status, 401, "an expired token must re-authenticate, not renew");
    await dead.body?.cancel();

    // A stopped run is a CLOSED door, so 409 rather than a retryable error: a renewing client gives
    // up and re-authenticates instead of spinning.
    await space.stopRun(run);
    const stopped = await handler(post(`/v0/agent-runs/${run}/renew`, {}, { authorization: `Bearer ${runToken}` }));
    assertEquals(stopped.status, 401, "a stopped run's token no longer authenticates at all");
    await stopped.body?.cancel();
  } finally {
    await close();
  }
});

Deno.test("http: erasure destroys the payload and keeps the record", async () => {
  // Immutability is the substrate's core property; erasure is a real requirement (a subject
  // exercising a right, a secret written by accident). This is the carve-out, and its shape is the
  // point: what dies is the PAYLOAD. The record, its id, its lineage and the event log survive, and
  // the content address stays valid because the digest is over plaintext. A plain delete would take
  // the evidence that anything was ever there.
  const { space, handler, close } = await newHandler();
  try {
    const { id } = await space.putArtifact(new TextEncoder().encode("secret"), { mediaType: "text/plain" });
    const before = await handler(get(`/v0/artifacts/${id}`));
    assertEquals(before.status, 200);
    await drain(before);

    const res = await handler(post(`/v0/ops/records/${id}/shred`, { reason: "erasure request" }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.references, 1);

    // 410, not 404: "erased" and "never existed" must not be the same answer, or an auditor cannot
    // tell a destroyed record from a typo'd id.
    const after = await handler(get(`/v0/artifacts/${id}`));
    assertEquals(after.status, 410, "a shredded artifact is Gone, not Not Found");
    const problem = await after.json();
    assert(String(problem.detail).includes("erasure request"), "the reason survives, so the WHY is auditable");

    const missing = await handler(get(`/v0/artifacts/01AAAAAAAAAAAAAAAAAAAAAAAA`));
    assertEquals(missing.status, 404, "an id that never named anything stays 404");
    await drain(missing);

    // What must survive: the record, its body (so the digest is still there), and the shred marker.
    const rec = await space.getRecord(id);
    assert(rec, "the record itself must not be deleted");
    assertEquals((rec?.body as { digest: string }).digest, body.digest);
    const marker = await space.shredOf(body.digest);
    assert(marker, "the erasure is itself a record");
    assertEquals(marker?.reason, "erasure request");
  } finally {
    await close();
  }
});

Deno.test("http: erasing SHARED content refuses until the caller says it means it", async () => {
  // The store is content-addressed, so identical payloads are ONE blob that several artifact
  // records reference. Erasing by content erases it for all of them: right semantics, sharp edge
  // (two people who uploaded the same file). Fail closed and make the caller assert it.
  const { space, handler, close } = await newHandler();
  try {
    const bytes = new TextEncoder().encode("the same bytes");
    const a = await space.putArtifact(bytes, { mediaType: "text/plain", appFields: { owner: "human:alice" } });
    const b = await space.putArtifact(bytes, { mediaType: "text/plain", appFields: { owner: "human:bob" } });
    assertEquals(a.digest, b.digest, "identical bytes dedupe to one blob");

    const refused = await handler(post(`/v0/ops/records/${a.id}/shred`, {}));
    assertEquals(refused.status, 409, "a shared payload must not be erased by accident");
    const p = await refused.json();
    assertEquals(p.title, "shared_payload");
    // …and nothing was destroyed by the refusal.
    const still = await handler(get(`/v0/artifacts/${b.id}`));
    assertEquals(still.status, 200, "a refused erasure must not have erased anything");
    await drain(still);

    const done = await handler(post(`/v0/ops/records/${a.id}/shred`, { acknowledgeShared: true }));
    assertEquals(done.status, 200);
    assertEquals((await done.json()).references, 2);
    // BOTH lose it, which is what "by content" means and why the guard exists.
    const gone = await handler(get(`/v0/artifacts/${b.id}`));
    assertEquals(gone.status, 410, "erasure is by content: the other record's bytes are gone too");
    await drain(gone);
  } finally {
    await close();
  }
});

Deno.test("http: a shred marker cannot be forged by a participant", async () => {
  // A forged marker would make live bytes look destroyed, which is the one lie this record exists
  // to prevent. `shred` is write-protected like grant and signal.
  const { space, close } = await newHandler();
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "shred", operations: ["put"] },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const r = await space.resolveToken(runToken);
    assert(r.ok && r.kind === "run");
    let refused = "wrote it";
    try {
      await space.authorize(r.ok && r.kind === "run" ? r.principal : "", "put", "shred");
    } catch (e) {
      refused = (e as Error).message;
    }
    assert(refused !== "wrote it", "a grant must not be enough to write a shred marker");
    assert(/operator/.test(refused), refused);
  } finally {
    await close();
  }
});
