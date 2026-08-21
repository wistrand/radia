// The HTTP boundary.
//
// Everything else under `test/` tests the Space and the storage ports. Nothing tested the
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
import { RadiaError } from "../src/core/errors.ts";
import { rawExec } from "./conformance/suites/integrity.ts";

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

/** The error CODE a call raised, or undefined if it succeeded. */
async function denied(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof RadiaError ? e.code : `unexpected: ${e}`;
  }
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

    // The favicon too: browsers probe /favicon.ico unprompted, so in required mode every console
    // load fired a 401 into the network log — noise wearing an error's clothes. It is an icon; it
    // carries nothing.
    for (const path of ["/favicon.ico", "/favicon.svg"]) {
      const icon = await handler(get(path));
      assertEquals(icon.status, 200, path);
      assertEquals(icon.headers.get("content-type"), "image/svg+xml");
      const body = await icon.text();
      // Byte-equal to the docs site's mark, so the browser tab and the published site cannot
      // drift into two different logos nobody decided on.
      const site = (await Deno.readTextFile(new URL("../docs/favicon.svg", import.meta.url))).trim();
      assertEquals(body, site, `${path} must serve the same mark as docs/favicon.svg`);
    }
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

Deno.test("http: gc is the interrupt half of the ops plane, and a scoped principal never reaches it", async () => {
  // The most consequential boundary the plane has: /v0/ops/gc DELETES records. It is deliberately
  // absent from READ_ONLY_OPS, and this pins that absence — that regex is exactly the kind of
  // thing a refactor widens, and until this test nothing would have failed if a self-scoped
  // session gained deletion. The principal here HOLDS a self-scoped grant, so the read half of the
  // plane is open to it; a no-grant principal (shut out of everything) would prove nothing about
  // the read/interrupt split.
  const { space, handler, close } = await newHandler();
  try {
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["put", "query"], scope: { createdBy: "self" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };

    // A record that IS sweepable, so a leak would be observable as deletion, not as a no-op.
    space.registerKind({ kind: "note", indexedPaths: [], claimable: false });
    const { id } = await space.put({ kind: "note", body: {}, retentionUntil: "2020-01-01T00:00:00.000Z" });

    // The split, both halves: the read half answers this principal, the interrupt half refuses it.
    assertEquals((await handler(get("/v0/ops/stats", auth))).status, 200, "the READ half is open to a self scope");
    const refused = await handler(post("/v0/ops/gc", {}, auth));
    assertEquals(refused.status, 403, "gc is operator-only: a scoped principal must never delete");
    assert(await space.getRecord(id), "and nothing was deleted by the refused call");

    // Unauthenticated under --auth required: 401, before any handler runs.
    const { handler: strict, close: closeStrict } = await newHandler({ authRequired: true });
    assertEquals((await strict(post("/v0/ops/gc", {}))).status, 401);
    await closeStrict();

    // The operator sweeps, and the response carries every field the contract promises.
    const ok = await handler(post("/v0/ops/gc", {}));
    assertEquals(ok.status, 200);
    const body = await ok.json();
    assertEquals(body.swept, 1);
    assertEquals(body.idempotency, 0);
    assert(body.compaction, "compaction rides the same verb by default");
    assertEquals(await space.getRecord(id), null);
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
      // Mining scans the whole space by kind, so it is the read verb with the widest reach: a
      // signature is an abstraction, but the exemplar ids it hands back are not.
      { verb: "flows", run: () => handler(get("/v0/ops/flows", auth)) },
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

Deno.test("http: mined flows are mined over the caller's OWN records, ids included", async () => {
  // The guard table above cannot catch a leak here, because a flow report carries no bodies: the
  // thing that escapes is the EXEMPLAR ID, which is a pointer to a record and reads as harmless.
  // Mining also scans by kind rather than by request, which makes it the widest read on the plane.
  const { space, handler, close } = await newHandler();
  try {
    const foreign = await space.put({ kind: "task", body: { tag: "operator-owned" } });
    await space.put({ kind: "task", body: { tag: "second" }, parentIds: [foreign.id] });

    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "task", operations: ["put", "query"], scope: { createdBy: "self" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };
    const own = await (await handler(post("/v0/records", { kind: "task", body: { mine: true } }, auth))).json();
    await (await handler(post("/v0/records", { kind: "task", body: { mine: 2 }, parentIds: [own.id] }, auth))).json();

    const scoped = await (await handler(get("/v0/ops/flows", auth))).json();
    const ids = scoped.flows.flatMap((f: { exemplars: string[] }) => f.exemplars);
    assertEquals(ids, [own.id], "a scoped miner may only ever point at its own records");
    assertEquals(scoped.scanned.records, 2, "and may only ever have READ its own");

    const operator = await (await handler(get("/v0/ops/flows"))).json();
    assertEquals(operator.scanned.records, 4, "the operator mines the whole space");
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
    await space.put({ kind: "task", body: { tag: "dirty" }, taint: ["file"] });

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
    await space.put({ kind: "task", body: { tag: "dirty" }, taint: ["file"] });
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
    const refused = await (await handler(post("/v0/takes", { pattern: { kind: "task" }, allowTaint: [] }, {
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

      // The one pre-auth route with a body: its parser sees anonymous input by design.
      { path: "/v0/sessions/oidc", body: {}, about: "no id_token at all" },
      { path: "/v0/sessions/oidc", body: { id_token: 7 }, about: "id_token not a string" },
      { path: "/v0/sessions/oidc", body: { id_token: "" }, about: "id_token empty" },
      { path: "/v0/sessions/oidc", body: [], about: "body an array" },
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

Deno.test("http: an unrecognized taint label is REFUSED, not ignored", async () => {
  const { handler, close } = await newHandler();
  try {
    // The direction reversed when taint became labels, deliberately. With a boolean, anything but
    // `true` was silently ignored and the record came back unclassified — which reads as fail-safe
    // and is not: a caller that mistyped its raise believed it had restricted a record that was in
    // fact unrestricted. With a vocabulary, an unknown label is a 4xx, so a mistyped restriction is
    // a failed request rather than a silent absence of one.
    for (const taint of [["yes"], ["FILE"], ["file ", "nope"], "file"]) {
      const res = await handler(post("/v0/records", { kind: "task", body: { tag: "t" }, taint }));
      assert(res.status >= 400 && res.status < 500, `taint: ${JSON.stringify(taint)} must be refused, got ${res.status}`);
      await res.body?.cancel();
    }
    // Absent stays absent: raising nothing is not an error.
    const none = await handler(post("/v0/records", { kind: "task", body: { tag: "t" } }));
    assertEquals(none.status, 201);
    const noneRec = await (await handler(get(`/v0/ops/records/${(await none.json()).id}`))).json();
    assertEquals(noneRec.runtimeMeta?.taint, []);
    const raised = await handler(post("/v0/records", { kind: "task", body: { tag: "t" }, taint: ["file"] }));
    const { id } = await raised.json();
    const record = await (await handler(get(`/v0/ops/records/${id}`))).json();
    assertEquals(record.runtimeMeta?.taint, ["file"], "a recognized label is carried through");
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
  // Immutability is the space's core property; erasure is a real requirement (a subject
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

// ---------------------------------------------------------------------------
// Reachability (audit package Q). Each of these was BUILT and could not be invoked, which is a
// distinct failure from a bug: the unit tests passed while nothing exercised the design. So each
// case drives the OUTERMOST surface — the same request a client sends — rather than `Space`.
// ---------------------------------------------------------------------------

Deno.test("http: declassify clears the NAMED labels, not always everything", async () => {
  const { space, handler, close } = await newHandler();
  try {
    const { id } = await space.put({ kind: "task", body: { tag: "t" }, taint: ["file", "net"] });

    // Per-label has been in `Space.declassify` and in the SPEC all along; the handler ignored the
    // body and cleared everything, so the design had no caller and the documented behaviour was
    // unreachable.
    const res = await handler(post(`/v0/ops/records/${id}/declassify`, { labels: ["file"] }));
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.cleared, ["file"]);
    assertEquals(out.remaining, ["net"], "the label nobody reviewed still stands");
    assertEquals((await space.getRecord(out.id))!.runtimeMeta.taint, ["net"]);

    // No body still means "all of them", which is what a caller naming nothing means.
    const all = await handler(post(`/v0/ops/records/${out.id}/declassify`, {}));
    assertEquals((await all.json()).remaining, []);

    // A label outside the closed vocabulary is a 400, not a 500 from inside the core.
    const bad = await handler(post(`/v0/ops/records/${id}/declassify`, { labels: ["nonsense"] }));
    assertEquals(bad.status, 400);
    await drain(bad);
  } finally {
    await close();
  }
});

Deno.test("http: a pattern-scoped artifact put grant can be satisfied by an app field", async () => {
  const { space, handler, close } = await newHandler({ authRequired: true });
  try {
    // The grant check ran against `{mediaType}` alone, before `x-radia-meta` was parsed, so a
    // grant scoped to an app field (the shape the chat uses for `conversationId`) matched a body
    // that structurally could not carry the field. Fail-closed, and unusable.
    // The app field has to be an INDEXED path for a pattern to compile against it, so the kind is
    // extended exactly as the chat extends it — a reserved kind may be extended, never shrunk, and
    // a redeclaration REPLACES rather than merges, so the runtime's own paths are repeated.
    space.registerKind({
      kind: "artifact",
      indexedPaths: [
        { path: "digest", type: "keyword" },
        { path: "mediaType", type: "keyword" },
        { path: "conversationId", type: "keyword" },
      ],
      claimable: false,
    });
    const { definitionToken } = await space.createAgentDefinition("agent:w", [
      { principal: "agent:w", kind: "artifact", operations: ["put"], pattern: { conversationId: "c1" } },
    ]);
    const { runToken } = await space.mintRun(definitionToken);
    const auth = { authorization: `Bearer ${runToken}` };

    const write = (meta?: string) =>
      handler(
        new Request("http://t/v0/artifacts", {
          method: "POST",
          headers: { "content-type": "text/plain", ...auth, ...(meta ? { "x-radia-meta": meta } : {}) },
          body: "hello",
        }),
      );

    const inside = await write(JSON.stringify({ conversationId: "c1" }));
    assertEquals(inside.status, 201, "an artifact carrying the scoped field is accepted");
    await drain(inside);

    const outside = await write(JSON.stringify({ conversationId: "c2" }));
    assertEquals(outside.status, 403, "…and another conversation's is still refused");
    await drain(outside);

    const bare = await write(undefined);
    assertEquals(bare.status, 403, "…as is one with no field at all");
    await drain(bare);
  } finally {
    await close();
  }
});

Deno.test("http: a grant may not carry a scope key nothing enforces", async () => {
  const { space, close } = await newHandler();
  try {
    // `leaseOwner: "self"` validated and narrowed nothing: `authorScope` restricts only when every
    // applicable grant says `createdBy: "self"`, so a grant carrying this one read as UNRESTRICTED.
    // An operator wrote a narrowing scope and got no narrowing, in the widening direction. Refused
    // until it is enforced, which needs an envelope filter every read verb applies.
    const err = await denied(() =>
      space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "task", operations: ["query"], scope: { leaseOwner: "self" } },
      })
    );
    assertEquals(err, "invalid_grant");
    // The scope key that IS enforced still works, so this is a refusal and not a retreat.
    assert(
      await space.put({
        kind: "grant",
        body: { principal: "agent:w", kind: "task", operations: ["query"], scope: { createdBy: "self" } },
      }),
    );
  } finally {
    await close();
  }
});

Deno.test("http: an undecidable pattern over a large kind is a 429, not a stalled space", async () => {
  // The limit a caller cannot see in its own request: the pattern is small and well-formed, and
  // what it exceeds is the WORK it causes (`bench/deployment.ts`: 13.6s at a million records, in a
  // process that serves nobody else meanwhile). 429 rather than 413 because narrowing or paging is
  // a retry the caller can actually make, and because the same pattern is fine on a smaller kind.
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter, { maxScanRows: 20 });
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }, { path: "tags", type: "array" }] });
  const handler = makeHandler(space, "<html>console</html>", false);
  try {
    for (let i = 0; i < 60; i++) await space.put({ kind: "task", body: { tag: "t", tags: ["a"] } });

    const res = await handler(post("/v0/records/query", { kind: "task", match: { tags: { $each: "zz" } } }));
    assertEquals(res.status, 429);
    const body = await res.json();
    assertEquals(body.type, "about:radia/scan_budget_exceeded");
    assert(String(body.detail).includes("20"), `the message must name the budget: ${body.detail}`);

    // The pushable half of the same shape stays a 200, which is what makes this a budget on
    // undecidable work rather than a cap on how large a kind may be.
    const ok = await handler(post("/v0/records/query", { kind: "task", match: { tags: { $any: "a" } }, limit: 5 }));
    assertEquals(ok.status, 200);
  } finally {
    await adapter.close();
  }
});

// ---------------------------------------------------------------------------
// Event-log truncation at the boundary: the watch 410 and the ops annotation.
// The truncated state is planted (the M2 sweep is not built); what these pin is
// the boundary contract that must already hold when it lands.
// ---------------------------------------------------------------------------

Deno.test("http: a stale watch cursor is 410 cursor_expired; the sentinel clamps, because the SDKs recover with it", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const handler = makeHandler(space, "<html>console</html>", false);
  try {
    for (const tag of ["a", "b", "c", "d", "e"]) await space.put({ kind: "task", body: { tag } });
    await space.sealEvents();
    const seals = await adapter.getSeals(-1, 100);
    const anchor = seals[2];
    // What the sweep leaves: events and seals below the horizon gone, the anchor seal kept.
    await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
    await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

    const { watchId } = await (await handler(post("/v0/watches", { kind: "task" }))).json();

    // An explicit cursor below the horizon is refused, with the horizon in the body, so a real
    // client can catch up by query before it reconnects.
    const stale = await handler(get(`/v0/watches/${watchId}/events`, { "Last-Event-ID": seals[0].cursor }));
    assertEquals(stale.status, 410);
    const body = await stale.json();
    assertEquals(body.type, "about:radia/cursor_expired");
    assertEquals(body.horizon, anchor.cursor);
    assertEquals(body.swept, anchor.idx + 1);

    // The sentinel is how both SDKs RECOVER from that 410 (reset to "0", reconnect immediately),
    // so refusing it would hot-loop every shipped client. It connects, clamped to the retained log.
    const zero = await handler(get(`/v0/watches/${watchId}/events`, { "Last-Event-ID": "0" }));
    assertEquals(zero.status, 200, "the sentinel must never 410");
    await zero.body?.cancel();
    // Resuming exactly at the horizon is gap-free and must also connect.
    const atHorizon = await handler(get(`/v0/watches/${watchId}/events`, { "Last-Event-ID": anchor.cursor }));
    assertEquals(atHorizon.status, 200);
    await atHorizon.body?.cancel();
    // A cancelled stream's loop may still be parked on waitForEvents; one mutation wakes and ends
    // it, so no keepalive timer outlives the test.
    await space.put({ kind: "task", body: { tag: "wake" } });
  } finally {
    await adapter.close();
  }
});

Deno.test("http: an ops events read below the horizon says where the log begins", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const handler = makeHandler(space, "<html>console</html>", false);
  try {
    for (const tag of ["a", "b", "c", "d"]) await space.put({ kind: "task", body: { tag } });
    await space.sealEvents();
    const seals = await adapter.getSeals(-1, 100);
    const anchor = seals[1];
    await rawExec(adapter, "delete from events where seq <= ?", [anchor.seq]);
    await rawExec(adapter, "delete from event_seal where idx < ?", [anchor.idx]);

    // From zero the read mechanically starts at the oldest retained event (the clamp is free);
    // the annotation is what keeps that from reading as "the whole log". No 410 here, ever: a
    // unified refusal would permanently break every from-zero ops read on the first sweep.
    const zero = await (await handler(get("/v0/ops/events"))).json();
    assertEquals(zero.logBeginsAfter, anchor.cursor);
    assertEquals(zero.sweptBefore, anchor.idx + 1);
    assert(zero.events.length > 0, "retained events must still be served");
    assert(zero.events.every((e: { seq: number }) => e.seq > anchor.seq));

    // From at-or-above the horizon the page is complete, so there is nothing to annotate.
    const clean = await (await handler(get(`/v0/ops/events?after=${anchor.cursor}`))).json();
    assertEquals(clean.logBeginsAfter, undefined);
    assertEquals(clean.sweptBefore, undefined);
  } finally {
    await adapter.close();
  }
});

// ---------------------------------------------------------------------------
// Ops tiers (architecture-ops-tiers.md): powers as ops_grant records, the three-way gate.
// The matrix below is the plan's plants: each power reaches exactly its verbs and
// none of its neighbours', and nothing below the full tier holds the identity
// root (grant/ops_grant writes) or the coordination bypass.
// ---------------------------------------------------------------------------

Deno.test("http: each ops power opens exactly its verbs; none confers the identity root or the bypass", async () => {
  const { space, handler, close } = await newHandler({ authRequired: true });
  const status = async (p: Promise<Response>) => {
    const r = await p;
    await drain(r);
    return r.status;
  };
  try {
    const bearer = async (agent: string, powers?: string[]) => {
      const { definitionToken } = await space.createAgentDefinition(agent, []);
      const { runToken } = await space.mintRun(definitionToken);
      if (powers) await space.put({ kind: "ops_grant", body: { principal: agent, operations: powers } });
      return { authorization: `Bearer ${runToken}` };
    };
    const obs = await bearer("agent:obs", ["observe"]);
    const med = await bearer("agent:med", ["remediate"]);
    const dcl = await bearer("agent:dcl", ["declassify"]);
    const prg = await bearer("agent:prg", ["purge"]);
    const swp = await bearer("agent:swp", ["sweep"]);

    // observe opens every READ unscoped, including the ones the self-scope tier never reaches.
    for (const path of ["/v0/ops/stats", "/v0/ops/events", "/v0/ops/diagnostics", "/v0/ops/integrity", "/v0/ops/erasures", "/v0/ops/digest", "/v0/ops/flows"]) {
      assertEquals(await status(handler(get(path, obs))), 200, `observe must open ${path}`);
    }
    // …and ANOTHER principal's permissions, which self-scope never could.
    assertEquals(await status(handler(get("/v0/ops/permissions?principal=agent:med", obs))), 200);

    // A dry gc is a read; a live one demands `sweep`, refused by name.
    assertEquals(await status(handler(post("/v0/ops/gc", { dryRun: true }, obs))), 200);
    const liveDenied = await handler(post("/v0/ops/gc", {}, obs));
    assertEquals(liveDenied.status, 403);
    assert((await liveDenied.json()).detail.includes("sweep"), "the refusal must name the missing power");
    assertEquals(await status(handler(post("/v0/ops/gc", {}, swp))), 200);
    // The rewrap rides the same split, and its refusal must name the same power. 400 rather than
    // 200 from `swp` here because this space has no blob key: the gate passed, the store said there
    // is nothing sealed to re-seal, and that distinction is the point of checking the status.
    assertEquals(await status(handler(post("/v0/ops/rewrap", { dryRun: true }, obs))), 400);
    const rewrapDenied = await handler(post("/v0/ops/rewrap", {}, obs));
    assertEquals(rewrapDenied.status, 403);
    assert((await rewrapDenied.json()).detail.includes("sweep"), "the refusal must name the missing power");
    assertEquals(await status(handler(post("/v0/ops/rewrap", {}, swp))), 400, "the gate opens; the store has no key");
    assertEquals(await status(handler(post("/v0/ops/rewrap", {}, med))), 403, "a neighbour's power must not open it");
    // A write power opens no reads.
    assertEquals(await status(handler(get("/v0/ops/stats", swp))), 403);
    assertEquals(await status(handler(get("/v0/ops/stats", med))), 403);

    // The write half, each verb by its own power and not a neighbour's.
    const denied = await handler(post("/v0/ops/remediate", { action: "reclaim", state: "leased", expired: true }, obs));
    assertEquals(denied.status, 403);
    assert((await denied.json()).detail.includes("remediate"));
    assertEquals(await status(handler(post("/v0/ops/remediate", { action: "reclaim", state: "leased", expired: true }, med))), 200);

    const tainted = await space.put({ kind: "task", body: { tag: "t" }, taint: ["file"] });
    assertEquals(await status(handler(post(`/v0/ops/records/${tainted.id}/declassify`, { labels: ["file"] }, prg))), 403, "purge must not declassify");
    assertEquals(await status(handler(post(`/v0/ops/records/${tainted.id}/declassify`, { labels: ["file"] }, dcl))), 200);

    const art = await space.putArtifact(new TextEncoder().encode("doomed"), { mediaType: "text/plain" });
    assertEquals(await status(handler(post(`/v0/ops/records/${art.id}/shred`, {}, dcl))), 403, "declassify must not shred");
    assertEquals(await status(handler(post(`/v0/ops/records/${art.id}/shred`, {}, prg))), 200);

    const rec = await space.put({ kind: "task", body: { tag: "r" } });
    assertEquals(await status(handler(post(`/v0/ops/records/${rec.id}/reclaim`, {}, obs))), 403);

    // No identity root below full: a power holder cannot write authorization records…
    assertEquals(await status(handler(post("/v0/records", { kind: "ops_grant", body: { principal: "agent:prg", operations: ["observe"] } }, prg))), 403);
    assertEquals(await status(handler(post("/v0/records", { kind: "grant", body: { principal: "agent:obs", kind: "task", operations: ["query"] } }, obs))), 403);
    // …and no coordination bypass: ungranted put/query stay refused whatever powers are held.
    assertEquals(await status(handler(post("/v0/records", { kind: "task", body: { tag: "x" } }, obs))), 403);
    assertEquals(await status(handler(post("/v0/records/query", { kind: "task" }, obs))), 403);

    // Promise == enforcement: the self report carries exactly what the gate resolved.
    const perm = await (await handler(get("/v0/ops/permissions?principal=agent:med", med))).json();
    assertEquals(perm.opsPowers, ["remediate"]);

    // A retirement closes on the NEXT request: resolution is per request, never cached.
    await space.put({ kind: "ops_grant", body: { principal: "agent:obs", operations: ["observe"], retired: true } });
    assertEquals(await status(handler(get("/v0/ops/stats", obs))), 403);
  } finally {
    await close();
  }
});

Deno.test("records: read-one answers with the OLDEST match, and a newest-first query with the newest", async () => {
  // The distinction `RadiaClient.readNewest` exists for, pinned at the boundary rather than in the
  // SDK, because the SDK method is a one-liner over these two endpoints and it is the ENDPOINTS'
  // behaviour that surprises people.
  //
  // Three records that all match one pattern is the shape of every registry, every versioned
  // record, and any key material a later write extends. `read-one` returning the first ever
  // written is correct and is almost never what the caller wanted; it cost this codebase a bug
  // where an enrolled machine was told it had no key while the record granting it sat one row
  // later (agent_docs/research-app-lessons.md).
  const { handler, close } = await newHandler();
  try {
    const ids: string[] = [];
    for (const v of ["first", "second", "third"]) {
      const r = await handler(post("/v0/records", { kind: "task", body: { tag: "t", v } }));
      ids.push((await r.json()).id);
    }

    const oldest = await (await handler(post("/v0/records/read-one", { kind: "task", match: { tag: "t" } }))).json();
    assertEquals(oldest.id, ids[0], "read-one is the oldest match");
    assertEquals(oldest.body.v, "first");

    const newest = await (await handler(
      post("/v0/records/query", { kind: "task", match: { tag: "t" }, limit: 1, dir: "desc" }),
    )).json();
    assertEquals(newest.records[0].id, ids[2], "a newest-first query is the newest");
    assertEquals(newest.records[0].body.v, "third");

    // And they genuinely differ, which is the whole point: a caller that swapped one for the other
    // by accident would read a stale record with no error anywhere.
    assert(oldest.id !== newest.records[0].id);
  } finally {
    await close();
  }
});

Deno.test("http: health says WHICH space this is, and whether it survives a restart", async () => {
  // "Where did my records go" was answerable from the startup log and nowhere else: a restart on
  // the same port answers 200 either way, and `storage` reads `pglite` whether the data is on disk
  // or in memory (plan-startup-ergonomics.md item 6). Public on purpose: the reconnecting client
  // is the one that needs it, and it has not signed in yet.
  const a = await newHandler();
  const b = await newHandler();
  try {
    const unstamped = await (await a.handler(get("/v0/health"))).json();
    assert(typeof unstamped.instance === "string" && unstamped.instance.length > 0, "health must name the running space");
    assertEquals(unstamped.startedAt, undefined, "an unstamped space must not invent a start time");
    assertEquals(unstamped.persistent, undefined, "…nor guess at persistence it was never told");

    a.space.persistent = true;
    await a.space.markStarted();
    const stamped = await (await a.handler(get("/v0/health"))).json();
    assertEquals(stamped.persistent, true);
    assert(stamped.startedAt <= stamped.now, `startedAt must come from the DB clock, not a second one: ${stamped.startedAt} > ${stamped.now}`);
    assertEquals(stamped.instance, unstamped.instance, "the instance id must not change under a live space");

    // Two spaces are two instances: this is the whole point of the field.
    const other = await (await b.handler(get("/v0/health"))).json();
    assert(other.instance !== stamped.instance, "a second space reported the first one's identity");
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test("http: diagnostics reports the compaction backlog, not only the retention one", async () => {
  // `radia doctor` said "19 sweepable" where `radia gc` said 19 sweepable PLUS 181 superseded
  // registry entries on the same space (plan-startup-ergonomics.md item 7). Both numbers are real
  // and they mean different things, so the report carried the small one and a person acted on it.
  const { space, handler, close } = await newHandler();
  try {
    space.registerKind({ kind: "cap", indexedPaths: [{ path: "tool", type: "keyword" }], claimable: false, contentKey: ["tool"] });
    await space.put({ kind: "cap", body: { tool: "search", v: 1 } });
    await space.put({ kind: "cap", body: { tool: "search", v: 2 } });
    await space.put({ kind: "cap", body: { tool: "search", v: 3 } }); // two superseded

    const d = await (await handler(get("/v0/ops/diagnostics"))).json();
    assertEquals(d.compactable?.superseded, 2, "the superseded registry entries are missing from the report");
    assertEquals(d.compactable?.byKind?.cap, 2, "…or no longer say which registry they are in");
    // The gc verb is the number this must agree with: the report exists to stop them diverging.
    const gc = await (await handler(post("/v0/ops/gc", { dryRun: true }))).json();
    assertEquals(d.compactable.superseded, gc.compaction?.superseded, "doctor and gc disagree about the backlog");
    // Never folded into `sweepable`: a retention policy and a registry keeping its newest entry are
    // different things, and summing them hides which one a retention setting governs.
    assertEquals(d.sweepable?.eligible, 0, "compaction leaked into the retention count");
  } finally {
    await close();
  }
});
