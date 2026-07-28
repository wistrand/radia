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
import { makeHandler } from "../src/server/http.ts";
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
