// A client that re-authenticates itself: the durable half of a credential, exchanged for the short
// half whenever the short one stops working.
//
// WHY THIS EXISTS. A run token lives 15 minutes and renews until a 12-hour ceiling, after which
// every consumer here was finished: the chat printed "mint a new one and restart", the CLI failed,
// a browser tab went dead, and `git` never had a way to renew at all. `renewRun` is a LIVENESS
// protocol — it needs a process awake and scheduled before its window closes — so it cannot help a
// laptop that slept through the window, a fresh CLI process, or anything that only replays a stored
// secret.
//
// The mechanism was already built and unused. An `agent_definition` record has no expiry, and
// `POST /v0/agent-runs` takes its token and mints a fresh run. Crucially the space REFUSES that
// token for anything else ("a definition token does not authorize coordination; mint a run first"),
// which is what makes it safe to keep on disk: it cannot read, write or claim. It can only mint.
//
// A real socket, like `loop.test.ts` and for the same reason: the thing under test is the client's
// own retry, including the SSE path that does not go through `req`, and a stubbed `fetch` would
// test a mock's idea of a 401.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { RadiaClient, RadiaClientError } from "../sdk/ts/client.ts";
import { resolveDefinitionToken, resolveToken, saveCredential, saveLogin, storedLogin } from "../src/credentials.ts";

/** A space behind a real port, with one definition that can `put` and `query` tasks. `count` says
 *  how many runs have been minted, which is how "exchanged once, not per call" is checked. */
async function newSpace(intercept?: (req: Request) => Response | undefined) {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const handler = makeHandler(space, "<html>console</html>", true);
  let mints = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    if (req.method === "POST" && new URL(req.url).pathname === "/v0/agent-runs") mints++;
    return intercept?.(req) ?? handler(req);
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const { definitionToken } = await space.createAgentDefinition("agent:w", [
    { principal: "agent:w", kind: "task", operations: ["put", "query", "read_one", "take"] },
  ]);
  return {
    space,
    base,
    definitionToken,
    mints: () => mints,
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

Deno.test("[exchange] a client with only the durable half mints its own session", async () => {
  const s = await newSpace();
  try {
    // No run token at all. Before this the caller had to mint one itself and hand it over.
    const client = new RadiaClient(s.base, { definitionToken: s.definitionToken });
    const { id } = await client.put({ kind: "task", body: { tag: "a" } });
    assert(id, "the put should have gone through a freshly minted run");
    assertEquals(s.mints(), 1, "one exchange, not one per call");
    await client.put({ kind: "task", body: { tag: "b" } });
    assertEquals(s.mints(), 1, "a working token is reused");
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] an expired token is replaced, and the call succeeds", async () => {
  const s = await newSpace();
  try {
    // A run that is already dead: exactly the state a process wakes up in after sleeping through
    // its renewal window, which no amount of scheduling can prevent.
    const { run, runToken } = await s.space.mintRun(s.definitionToken);
    await s.space.stopRun(run);
    const dead = new RadiaClient(s.base, { token: runToken });
    await assertRejects(() => dead.put({ kind: "task", body: { tag: "x" } }), RadiaClientError);

    const client = new RadiaClient(s.base, { token: runToken, definitionToken: s.definitionToken });
    const { id } = await client.put({ kind: "task", body: { tag: "x" } });
    assert(id, "the dead token should have been swapped for a live one");
    assertEquals(s.mints(), 1);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] the token a launcher hands to a child is the LIVE one", async () => {
  // The bug this pins, seen in a real session: the chat starts with a stored login whose run token
  // lapsed hours ago, recovers in memory through its definition token, and then launches its tools
  // worker with the value it read off disk. The worker holds no durable half by design, so every
  // `space_*` call answered `token_expired` for the whole session and nothing could fix it.
  //
  // A recovered client therefore has to be able to say which token it is actually using, and the
  // answer has to work somewhere else: a child process is a different client, not a copy of this one.
  const s = await newSpace();
  try {
    const { run, runToken } = await s.space.mintRun(s.definitionToken);
    await s.space.stopRun(run); // the stored half is dead before the parent even starts
    const parent = new RadiaClient(s.base, { token: runToken, definitionToken: s.definitionToken });
    assertEquals(parent.bearerToken, runToken, "before any call it still holds what it was built with");

    await parent.put({ kind: "task", body: { tag: "recovered" } });
    assert(parent.bearerToken, "a recovered client must expose a token");
    assert(parent.bearerToken !== runToken, "and it must not still be the dead one");

    // The child: a plain client with no way back to the durable half, exactly like the tools worker.
    const child = new RadiaClient(s.base, { token: parent.bearerToken });
    const found = await child.query({ kind: "task", match: { tag: "recovered" } }, 5);
    assertEquals(found.length, 1, "the handed-over token has to work in a process that cannot mint");

    // And the stale one still does not, which is what makes the assertion above mean something.
    const stale = new RadiaClient(s.base, { token: runToken });
    await assertRejects(() => stale.query({ kind: "task" }, 1), RadiaClientError);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] a forbidden call is NOT retried", async () => {
  const s = await newSpace();
  try {
    // The distinction that matters most. A 403 says the principal may not do this; the credential is
    // perfectly good. Retrying spends a mint, hides the real answer, and never succeeds.
    const client = new RadiaClient(s.base, { definitionToken: s.definitionToken });
    await client.put({ kind: "task", body: { tag: "a" } }); // one mint, to get a session
    const before = s.mints();
    await assertRejects(
      () => client.put({ kind: "signal", body: {} }), // reserved: operator-only
      RadiaClientError,
    );
    assertEquals(s.mints(), before, "a grant problem must not spend an exchange");
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] concurrent calls share ONE exchange", async () => {
  const s = await newSpace();
  try {
    // A fleet waking together, or a client with several requests in flight when the token lapses.
    // Without a shared in-flight promise each one mints its own run, and every `agent_runs` POST is
    // a record: a burst of them, all but the last discarded.
    const { run, runToken } = await s.space.mintRun(s.definitionToken);
    await s.space.stopRun(run);
    const client = new RadiaClient(s.base, { token: runToken, definitionToken: s.definitionToken });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.put({ kind: "task", body: { tag: `c${i}` } })),
    );
    assertEquals(results.filter((r) => r.id).length, 8, "every call should have succeeded");
    assertEquals(s.mints(), 1, `8 concurrent calls minted ${s.mints()} runs`);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] without the durable half nothing changes", async () => {
  const s = await newSpace();
  try {
    // The old behaviour has to survive exactly: a client given only a run token must still fail when
    // it expires, rather than acquiring a way to renew itself out of nowhere.
    const { run, runToken } = await s.space.mintRun(s.definitionToken);
    await s.space.stopRun(run);
    const client = new RadiaClient(s.base, { token: runToken });
    await assertRejects(() => client.put({ kind: "task", body: { tag: "x" } }), RadiaClientError);
    assertEquals(s.mints(), 0);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] a revoked definition cannot mint, so the client stops", async () => {
  const s = await newSpace();
  try {
    // The off switch. Revocation is what pays for a durable credential, and it has to be immediate:
    // credentials resolve from records per request, uncached, so the next exchange fails.
    const client = new RadiaClient(s.base, { definitionToken: s.definitionToken });
    await client.put({ kind: "task", body: { tag: "a" } });
    await s.space.revokeDefinition("agent:w");
    const { run } = await s.space.mintRun(s.definitionToken).catch(() => ({ run: "" }));
    assertEquals(run, "", "a revoked definition must not mint");
    // And the client's own session is over as soon as its short token is: it cannot get another.
    const stopped = new RadiaClient(s.base, { token: "0".repeat(48), definitionToken: s.definitionToken });
    await assertRejects(() => stopped.put({ kind: "task", body: { tag: "b" } }), RadiaClientError);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] the watch stream re-authenticates, once", async () => {
  // The SSE connect is a raw `fetch` that never passes through `req`, so the exchange has to be
  // wired there separately. It is also the LONGEST-lived request a client makes, which means it
  // meets expiry before anything else does. This is precisely where a credential fix gets
  // forgotten: the stream did not carry `Authorization` at all once, and every connect 401'd into a
  // silent poll fallback that looked like an idle space.
  // ONE 401, which is what an expiry looks like: the next connect carries the new token and works.
  // Rejecting for a window instead would fail the retry too, and the client spends its one shot
  // immediately rather than backing off — deliberately, since a second refusal is a real one.
  let rejections = 0;
  const s = await newSpace((req) => {
    if (rejections === 0 && new URL(req.url).pathname.endsWith("/events")) {
      rejections++;
      return new Response("expired", { status: 401 });
    }
    return undefined;
  });
  try {
    const client = new RadiaClient(s.base, { definitionToken: s.definitionToken });
    const stop = new AbortController();
    const seen: string[] = [];
    const running = (async () => {
      for await (const w of client.watch({ kind: "task" }, stop.signal)) seen.push(w.recordId);
    })().catch(() => {});
    // Let the first connect fail, the exchange happen and the stream re-open.
    await new Promise((r) => setTimeout(r, 300));
    await client.put({ kind: "task", body: { tag: "w" } });
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await running;
    assert(seen.length > 0, "the watch should have delivered a wakeup after re-authenticating");
    // Two mints: the one that opened the watch, and the one the 401 triggered.
    assertEquals(s.mints(), 2, `expected one exchange for the stream, saw ${s.mints()} mints total`);
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] a person's login does not overwrite the operator credential", () => {
  // TWO IDENTITIES, ONE FILE. `radia dev` provisions an operator credential for a space and
  // `radia login` authenticates a person against the same space. Keying both by base URL means the
  // login replaces the operator entry, and the CLI's remediation verbs, the chat's bootstrap and
  // the MCP adapter all silently start acting as whoever logged in last. Caught while writing this,
  // one edit before it shipped.
  const dir = Deno.makeTempDirSync({ prefix: "radia-creds-" });
  const previous = Deno.env.get("RADIA_CREDENTIALS");
  Deno.env.set("RADIA_CREDENTIALS", `${dir}/credentials.json`);
  // `resolveToken`/`resolveDefinitionToken` read the environment too, so clear the overrides that
  // would otherwise answer before the file does.
  const priorToken = Deno.env.get("RADIA_TOKEN");
  const priorDef = Deno.env.get("RADIA_DEFINITION_TOKEN");
  Deno.env.delete("RADIA_TOKEN");
  Deno.env.delete("RADIA_DEFINITION_TOKEN");
  try {
    const base = "http://127.0.0.1:7788";
    saveCredential(base, { token: "operator-token", mintedAt: new Date(0).toISOString() });
    saveLogin(base, { principal: "human:alice", token: "alice-run", definitionToken: "alice-def", mintedAt: new Date(0).toISOString() });

    assertEquals(resolveToken(base), "operator-token", "the operator credential must survive a login");
    assertEquals(storedLogin(base)?.token, "alice-run");
    assertEquals(storedLogin(base)?.definitionToken, "alice-def");
    assertEquals(storedLogin(base)?.principal, "human:alice");
    // And the operator entry has no durable half, because there is none: it is minted in memory at
    // startup and dies with the process.
    assertEquals(resolveDefinitionToken(base), undefined);

    // Logging in again replaces the login and still leaves the operator alone.
    saveLogin(base, { principal: "human:bob", token: "bob-run", definitionToken: "bob-def", mintedAt: new Date(0).toISOString() });
    assertEquals(storedLogin(base)?.principal, "human:bob");
    assertEquals(resolveToken(base), "operator-token");
  } finally {
    if (previous === undefined) Deno.env.delete("RADIA_CREDENTIALS");
    else Deno.env.set("RADIA_CREDENTIALS", previous);
    if (priorToken !== undefined) Deno.env.set("RADIA_TOKEN", priorToken);
    if (priorDef !== undefined) Deno.env.set("RADIA_DEFINITION_TOKEN", priorDef);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("[exchange] a definition token still cannot act on its own", async () => {
  const s = await newSpace();
  try {
    // The property the whole design rests on, checked from the client's side rather than assumed.
    // If a definition token could read or write, keeping one on disk would be strictly worse than
    // keeping a run token there.
    const asDefinition = new RadiaClient(s.base, { token: s.definitionToken });
    await assertRejects(
      () => asDefinition.put({ kind: "task", body: { tag: "a" } }),
      RadiaClientError,
      "mint a run first",
    );
  } finally {
    await s.close();
  }
});

Deno.test("[exchange] an idempotency key survives a re-mint: the scope is the AGENT, not the run", async () => {
  const s = await newSpace();
  try {
    // The retry that NEEDS the stored row is exactly the one arriving under a fresh run: a worker
    // restart, or an expiry the SDK answers by exchanging the durable half again. Scoped to the
    // run, the row never matched and the "dedupe" only covered retries inside one process's
    // lifetime (audit Package U; it is how 39 tools once became 1,498 capability records).
    const first = await s.space.mintRun(s.definitionToken);
    const a = new RadiaClient(s.base, { token: first.runToken });
    const { id } = await a.put({ kind: "task", body: { tag: "once" } }, "job:42");

    const second = await s.space.mintRun(s.definitionToken);
    assert(first.run !== second.run, "two mints are two distinct run principals");
    const b = new RadiaClient(s.base, { token: second.runToken });
    const { id: again } = await b.put({ kind: "task", body: { tag: "once" } }, "job:42");
    assertEquals(again, id, "the second run's retry replays the first run's write");

    // A DIFFERENT agent using the same key is its own scope, not a collision: the widening stops
    // at the agent, or one principal's key could pin another's record.
    const other = await s.space.createAgentDefinition("agent:v", [
      { principal: "agent:v", kind: "task", operations: ["put"] },
    ]);
    const c = new RadiaClient(s.base, { definitionToken: other.definitionToken });
    const { id: theirs } = await c.put({ kind: "task", body: { tag: "once" } }, "job:42");
    assert(theirs !== id, "another agent's identical key writes its own record");
  } finally {
    await s.close();
  }
});
