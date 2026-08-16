// Delegated runs (agent_docs/plan-delegation.md): act with my own capability, under my caller's
// reach. What is guarded here, in order of how badly it fails when wrong:
//
//   1. the two `authorize` shortcuts that return `null` before reading any grant. An attenuated
//      run of a privileged or supervisor agent would be unattenuated in practice, so the MINT
//      refuses both (phase 0). Each of these was proved red by removing the refusal.
//   2. the fail-OPEN: if the runtime cannot tell a run is delegated it falls through to
//      `grantSubject`, which answers with the WORKER's agent. A cold memo, a renewal that drops
//      the fields, and a malformed body all have to fail closed instead.
//   3. that the intersection is a SUBSET of the worker's authority on every axis.
//
// Sqlite in memory, `makeHandler` for the wire half, the `Space` API directly for the rest.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DELEGABLE_PREFIX, delegablePrincipal, intersectGrants, Space } from "../src/core/space.ts";
import { RadiaError } from "../src/core/errors.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { makeHandler } from "../src/server/http.ts";
import type { GrantDef } from "../src/core/kinds.ts";

const NOTE = {
  kind: "note",
  indexedPaths: [{ path: "owner", type: "keyword" as const }, { path: "topic", type: "keyword" as const }],
};
const MEMO = { kind: "memo", indexedPaths: [{ path: "owner", type: "keyword" as const }] };

async function newSpace() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter, {} as never);
  await space.loadKinds();
  await space.put({ kind: "kind_def", body: NOTE });
  await space.put({ kind: "kind_def", body: MEMO });
  return { space, adapter, close: () => adapter.close() };
}

/** An agent with grants, and a live run of it. */
async function agentRun(space: Space, agent: string, grants: GrantDef[]) {
  const { definitionToken } = await space.createAgentDefinition(agent, grants);
  const { run, runToken } = await space.mintRun(definitionToken);
  return { agent, run, runToken, definitionToken };
}

const grant = (principal: string, kind: string, operations: string[], pattern?: Record<string, unknown>): GrantDef =>
  ({ principal, kind, operations, ...(pattern ? { pattern } : {}) }) as GrantDef;

// --- phase 0: the two shortcuts ------------------------------------------------------------

Deno.test("delegation: a privileged worker cannot mint a delegated run at all", async () => {
  const t = await newSpace();
  try {
    // `human:local` is the default operator. It holds no definition (that is refused too), so the
    // principal is presented directly, which is exactly the shape `authorize` short-circuits on.
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put", "query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const e = await assertRejects(() => t.space.mintDelegatedRun("human:local", id), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "would not be attenuated");
  } finally {
    t.close();
  }
});

Deno.test("delegation: the SUPERVISOR cannot mint one either, because its carve-out ignores attenuation", async () => {
  const t = await newSpace();
  try {
    // Mintable since ops-tiers phase 5, which is precisely why this needs its own refusal: an
    // attenuated supervisor run would still reach the `grant`/`signal` carve-out in `authorize`,
    // which keys on the AGENT and returns `null` before any grant is read.
    const sup = await agentRun(t.space, "agent:supervisor", [grant("agent:supervisor", "note", ["query"])]);
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put", "query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const e = await assertRejects(() => t.space.mintDelegatedRun(sup.run, id), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "supervisor");
  } finally {
    t.close();
  }
});

Deno.test("delegation: a privileged CALLER is refused, because there is no grant set to narrow to", async () => {
  const t = await newSpace();
  try {
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["put", "query"])]);
    // Written by the operator, so the record's caller resolves to a privileged principal.
    const { id } = await t.space.put({ kind: "note", body: { owner: "op", topic: "x" } });
    const e = await assertRejects(() => t.space.mintDelegatedRun(worker.run, id), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "no grant set to narrow to");
  } finally {
    t.close();
  }
});

// --- the intersection ------------------------------------------------------------------------

Deno.test("delegation: the delegated run is a SUBSET on every axis (op, pattern, kind)", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [
      grant("human:alice", "note", ["put", "query"], { owner: "alice" }),
      grant("human:alice", "memo", ["query"]), // the worker has no `memo` grant: drops out
    ]);
    const worker = await agentRun(t.space, "agent:w", [
      grant("agent:w", "note", ["query", "read_one"]), // unscoped, and `read_one` alice lacks
    ]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    assertEquals(d.actingFor, "human:alice");
    assertEquals(d.agent, "agent:w", "delegation narrows authority, it does not change identity");

    const perms = await t.space.effectivePermissions(d.run);
    assertEquals(perms.actingFor, "human:alice");
    assertEquals(perms.kinds.map((k) => k.kind), ["note"], "a kind only one side holds is absent");
    assertEquals(perms.kinds[0].operations, ["query"], "`read_one` is the worker's alone; `put` is alice's alone");
    // The caller's pattern binds even though the worker's grant carried none.
    assertEquals(perms.kinds[0].patterns, [{ owner: "alice" }]);
    assertEquals(await t.space.authorize(d.run, "query", "note"), [{ owner: "alice" }]);
    await assertRejects(() => t.space.authorize(d.run, "read_one", "note"), RadiaError);
    await assertRejects(() => t.space.authorize(d.run, "query", "memo"), RadiaError);
  } finally {
    t.close();
  }
});

Deno.test("delegation: two patterns intersect rather than union, and stay flat", () => {
  // Flat merge where the keys allow it: the result is stored and then AND-ed into every request,
  // so nesting here compounds against the compiler's depth limit.
  const out = intersectGrants(
    [grant("agent:w", "note", ["query"], { topic: "t1" })],
    [grant("human:alice", "note", ["query"], { owner: "alice" })],
  );
  assertEquals(out, [{ kind: "note", operations: ["query"], pattern: { topic: "t1", owner: "alice" } }]);

  // Same key, different value: no flat merge exists, so `$and` and let the compiler decide.
  const conflict = intersectGrants(
    [grant("agent:w", "note", ["query"], { owner: "bob" })],
    [grant("human:alice", "note", ["query"], { owner: "alice" })],
  );
  assertEquals(conflict[0].pattern, { $and: [{ owner: "bob" }, { owner: "alice" }] });

  // A disjunction on each side is a cross product, which is where the mint's ceiling comes from.
  const cross = intersectGrants(
    [grant("agent:w", "note", ["query"], { topic: "a" }), grant("agent:w", "note", ["query"], { topic: "b" })],
    [grant("human:alice", "note", ["query"], { owner: "x" }), grant("human:alice", "note", ["query"], { owner: "y" })],
  );
  assertEquals(cross.length, 4);
});

Deno.test("delegation: a self-scoped grant is DROPPED rather than carried to a different author", () => {
  // "Self" is relative to the holder, and a delegated run's writer is the worker, so materializing
  // it would invert the caller's intent. Dropping is fail-closed: the run simply cannot use it.
  const out = intersectGrants(
    [grant("agent:w", "note", ["query"])],
    [{ ...grant("human:alice", "note", ["query"]), scope: { createdBy: "self" } } as GrantDef],
  );
  assertEquals(out, []);
});

Deno.test("delegation: a taint barrier composes as the NARROWER of the two sides", () => {
  const out = intersectGrants(
    [{ ...grant("agent:w", "note", ["take"]), scope: { taint: "file,net" } } as GrantDef],
    [{ ...grant("human:alice", "note", ["take"]), scope: { taint: "file" } } as GrantDef],
  );
  assertEquals(out[0].scope, { taint: "file" });
  // One side stating none yields to the side that does; two disjoint allowlists leave nothing.
  assertEquals(
    intersectGrants(
      [grant("agent:w", "note", ["take"])],
      [{ ...grant("human:alice", "note", ["take"]), scope: { taint: "none" } } as GrantDef],
    )[0].scope,
    { taint: "none" },
  );
});

Deno.test("delegation: no shared grant is refused at the MINT, not handed back as a useless token", async () => {
  const t = await newSpace();
  try {
    // They share the KIND (which is what lets the worker read the record at all) and no OPERATION
    // on it, which is the interesting empty case: a kind in common is not authority in common.
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const e = await assertRejects(() => t.space.mintDelegatedRun(worker.run, id), RadiaError);
    assertEquals(e.code, "empty_delegation");
  } finally {
    t.close();
  }
});

// --- resolving the caller ----------------------------------------------------------------------

Deno.test("delegation: the caller resolves THROUGH the run, so a relaying worker does not become the caller", async () => {
  const t = await newSpace();
  try {
    // The chat's actual topology: alice writes, a RELAY worker reacts and writes the record a
    // second worker claims. Resolving from that record's author would name the relay, whose grants
    // share nothing with the second worker; resolving from `body.owner` would trust a body field.
    const alice = await agentRun(t.space, "human:alice", [
      grant("human:alice", "note", ["put", "query"], { owner: "alice" }),
      grant("human:alice", "memo", ["query"], { owner: "alice" }),
    ]);
    const relay = await agentRun(t.space, "agent:relay", [grant("agent:relay", "note", ["put", "query"])]);
    const worker = await agentRun(t.space, "agent:w", [
      grant("agent:w", "note", ["query"]), // enough to READ the record it is handed
      grant("agent:w", "memo", ["query", "read_one"]),
    ]);

    const seed = await t.space.put({ kind: "note", body: { owner: "alice", topic: "seed" } }, undefined, alice.run);
    const relayDelegated = await t.space.mintDelegatedRun(relay.run, seed.id);
    assertEquals(relayDelegated.actingFor, "human:alice");
    // The relay emits the next link UNDER its delegated run, which is the whole point: the record
    // now carries a resolvable caller for whoever picks it up.
    const link = await t.space.put({ kind: "note", body: { owner: "alice", topic: "link" } }, undefined, relayDelegated.run);

    const wd = await t.space.mintDelegatedRun(worker.run, link.id);
    assertEquals(wd.actingFor, "human:alice", "one hop, no walk: actingFor holds a resolved principal");
    const perms = await t.space.effectivePermissions(wd.run);
    assert(
      perms.kinds.every((k) => JSON.stringify(k.patterns) === JSON.stringify([{ owner: "alice" }])),
      "every kind is bound by the PERSON's pattern, two workers down the chain",
    );

    // Without the relay's delegated run, the same record names the RELAY as its caller: this is
    // the finding the shape exists for. `body.owner` still says "alice" and is ignored.
    const bare = await t.space.put({ kind: "note", body: { owner: "alice", topic: "bare" } }, undefined, relay.run);
    const bareDelegated = await t.space.mintDelegatedRun(worker.run, bare.id);
    assertEquals(bareDelegated.actingFor, "agent:relay");
    assertEquals(
      (await t.space.effectivePermissions(bareDelegated.run)).kinds.map((k) => k.kind),
      ["note"],
      "bounded by the relay's grants, which hold no memo: the caller was NOT recovered",
    );
  } finally {
    t.close();
  }
});

Deno.test("delegation: a delegated run may not delegate again", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put", "query"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    const e = await assertRejects(() => t.space.mintDelegatedRun(d.run, id), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "may not delegate again");
  } finally {
    t.close();
  }
});

// --- the fail-open --------------------------------------------------------------------------

Deno.test("delegation: a COLD memo re-reads the run rather than falling back to the worker's grants", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query", "read_one"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);

    // A SECOND Space over the same database: no memo at all, which is what `ack` sees when it
    // authorizes a lease owner minted by another instance or before a restart.
    const cold = new Space(t.adapter, {} as never);
    await cold.loadKinds();
    assertEquals(await cold.authorize(d.run, "query", "note"), [{ owner: "alice" }], "attenuation survives a cold memo");
    await assertRejects(
      () => cold.authorize(d.run, "read_one", "note"),
      RadiaError,
      "no 'read_one' grant",
    );
  } finally {
    t.close();
  }
});

Deno.test("delegation: RENEWING a delegated run keeps its attenuation", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query", "read_one"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    await t.space.renewRun(d.run);

    // Presented as a TOKEN, on a space with no memo. This is the path the copy exists for:
    // `resolveCredential` looks up the newest record for a token HASH and never folds successors,
    // so a renewal that dropped the fields resolves the run as an ordinary one holding the
    // worker's full grants. Asserting through `authorize(run)` instead passes either way, because
    // that path reaches `runRecord`, which folds.
    const cold = new Space(t.adapter, {} as never);
    await cold.loadKinds();
    const handler = makeHandler(cold, "<html>c</html>", true);
    const res = await handler(
      new Request("http://t/v0/ops/permissions?principal=" + encodeURIComponent(d.run), {
        headers: { "Authorization": `Bearer ${d.runToken}` },
      }),
    );
    assertEquals(res.status, 200, await res.clone().text());
    const perms = await res.json();
    assertEquals(perms.actingFor, "human:alice", "the renewed token still resolves as delegated");
    assertEquals(perms.kinds.map((k: { kind: string }) => k.kind), ["note"]);
    assertEquals(perms.kinds[0].operations, ["query"], "still the intersection, not the worker's own grants");
  } finally {
    t.close();
  }
});

Deno.test("delegation: the token resolves over the wire with the attenuation applied", async () => {
  const t = await newSpace();
  try {
    const handler = makeHandler(t.space, "<html>c</html>", true);
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query", "read_one"])]);
    const seed = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    await t.space.put({ kind: "note", body: { owner: "bob", topic: "x" } }, undefined, "run:other");

    const res = await handler(
      new Request("http://t/v0/agent-runs/delegated", {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": `Bearer ${worker.runToken}` },
        body: JSON.stringify({ for: seed.id }),
      }),
    );
    assertEquals(res.status, 201, await res.clone().text());
    const mint = await res.json();
    assertEquals(mint.actingFor, "human:alice");

    const q = await handler(
      new Request("http://t/v0/records/query", {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": `Bearer ${mint.runToken}` },
        body: JSON.stringify({ kind: "note" }),
      }),
    );
    assertEquals(q.status, 200);
    const rows = (await q.json()).records as { body: { owner: string } }[];
    assert(rows.length > 0, "the delegated run can read");
    assert(rows.every((r) => r.body.owner === "alice"), "and only inside the caller's pattern");
  } finally {
    t.close();
  }
});

// --- what a delegated run must never reach ------------------------------------------------------

Deno.test("delegation: a delegated run holds NO ops powers, whatever its worker holds", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    await t.space.put({ kind: "ops_grant", body: { principal: "agent:w", operations: ["observe"] } });
    assert((await t.space.opsPowers(worker.run)).has("observe"), "the worker itself observes");

    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    // `ops_grant` is keyed by principal and resolved through `grantSubject`, which answers with the
    // WORKER's agent. Without an explicit refusal the delegated run reads the whole space.
    assertEquals([...await t.space.opsPowers(d.run)], []);
    assertEquals((await t.space.effectivePermissions(d.run)).opsPowers, []);
  } finally {
    t.close();
  }
});

Deno.test("delegation: a delegated run may not write authorization kinds", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    const e = await assertRejects(() => t.space.authorize(d.run, "put", "grant"), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "delegated run may not write");
  } finally {
    t.close();
  }
});

Deno.test("delegation: write-side scoping binds too, so a delegated put stays inside the caller's pattern", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put", "query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["put", "query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "seed" } }, undefined, alice.run);
    const d = await t.space.mintDelegatedRun(worker.run, id);
    // Through the HANDLER, because write-side scoping is enforced there (`bodyMatchesGrant` against
    // the `put` constraint), which is the path a real worker takes.
    const handler = makeHandler(t.space, "<html>c</html>", true);
    const write = (owner: string) =>
      handler(
        new Request("http://t/v0/records", {
          method: "POST",
          headers: { "content-type": "application/json", "Authorization": `Bearer ${d.runToken}` },
          body: JSON.stringify({ kind: "note", body: { owner, topic: "t" } }),
        }),
      );
    assertEquals((await write("alice")).status, 201);
    const refused = await write("bob");
    assertEquals(refused.status, 403, await refused.clone().text());
  } finally {
    t.close();
  }
});

// --- phase 3: delegable grants ------------------------------------------------------------------

Deno.test("delegable: the worker's OWN token cannot use a delegable grant, but its delegated run can", async () => {
  const t = await newSpace();
  try {
    // The shape phase 4 puts EXEC_GRANTS into: the worker holds no `note` authority of its own, so
    // it cannot read a caller's records as itself. Narrowing alone would have emptied the
    // intersection too; the delegable grant is what keeps delegation possible after the narrowing.
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["take"])]);
    await t.space.put({ kind: "grant", body: grant(delegablePrincipal("agent:w"), "note", ["query"]) });

    await assertRejects(() => t.space.authorize(worker.run, "query", "note"), RadiaError, "no 'query' grant");
    const seed = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);

    // A delegable grant raises entitlement to a LEASE: the mint now yields authority the worker
    // cannot exercise alone, so seeing the record is no longer enough.
    const noLease = await assertRejects(() => t.space.mintDelegatedRun(worker.run, seed.id), RadiaError);
    assertEquals(noLease.code, "forbidden");
    assertStringIncludes(noLease.message, "delegable grants, which need one");

    const claimed = await t.space.take({ pattern: { kind: "note" } }, { leaseSeconds: 60 }, worker.run);
    assert(claimed, "the worker claims the record it serves");
    const d = await t.space.mintDelegatedRun(worker.run, claimed.record.id);
    assertEquals(await t.space.authorize(d.run, "query", "note"), [{ owner: "alice" }]);
  } finally {
    t.close();
  }
});

Deno.test("delegable: no credential can ever authenticate as a `delegable:` principal", async () => {
  const t = await newSpace();
  try {
    // The whole mechanism rests on this. A definition is the only way to get a token for a named
    // principal, and it refuses anything that is not `agent:`/`human:`.
    const e = await assertRejects(
      () => t.space.createAgentDefinition(delegablePrincipal("agent:w"), []),
      RadiaError,
    );
    assertEquals(e.code, "invalid_principal");
    // And `grantSubject` never produces the prefix, so no run resolves to it either.
    assertEquals(t.space.grantSubject("run:nope"), "run:nope");
    assert(!t.space.grantSubject("agent:w").startsWith(DELEGABLE_PREFIX));
  } finally {
    t.close();
  }
});

Deno.test("delegable: the worker's permissions REPORT it, separately from what its token can do", async () => {
  const t = await newSpace();
  try {
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["take"])]);
    await t.space.put({ kind: "grant", body: grant(delegablePrincipal("agent:w"), "memo", ["query", "read_one"]) });
    const perms = await t.space.effectivePermissions(worker.run);
    assertEquals(perms.kinds.map((k) => k.kind), ["note"], "the delegable kind is NOT in what the token can do");
    assertEquals(perms.delegable, [{ kind: "memo", operations: ["query", "read_one"] }]);
  } finally {
    t.close();
  }
});

// --- growth: a mint per call would accumulate permanent records ---------------------------------

Deno.test("delegation: an unchanged delegation REUSES its run instead of appending a record", async () => {
  const t = await newSpace();
  try {
    const handler = makeHandler(t.space, "<html>c</html>", true);
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"], { owner: "alice" })]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query", "read_one"])]);
    const seed = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const mint = async () => {
      const res = await handler(
        new Request("http://t/v0/agent-runs/delegated", {
          method: "POST",
          headers: { "content-type": "application/json", "Authorization": `Bearer ${worker.runToken}` },
          body: JSON.stringify({ for: seed.id }),
        }),
      );
      assertEquals(res.status, 201, await res.clone().text());
      return await res.json() as { run: string; runToken: string };
    };

    const first = await mint();
    const runsAfterFirst = (await t.space.query({ kind: "agent_run", match: { actingFor: "human:alice" } }, 100)).length;
    for (let i = 0; i < 5; i++) {
      const again = await mint();
      assertEquals(again.run, first.run, "the same delegation resolves to the same run");
      assertEquals(again.runToken, first.runToken, "and hands back the same token, derived rather than stored");
    }
    assertEquals(
      (await t.space.query({ kind: "agent_run", match: { actingFor: "human:alice" } }, 100)).length,
      runsAfterFirst,
      "five further mints wrote NO new records; a per-call mint is permanent growth in a kind GC never sweeps",
    );

    // A CHANGED intersection must not mutate the run in place: `CredentialStore` memoizes a run's
    // authority precisely because it cannot change. A different grant set derives a different
    // token, so it becomes a different run.
    await t.space.put({ kind: "grant", body: grant("human:alice", "memo", ["query"]) });
    await t.space.put({ kind: "grant", body: grant("agent:w", "memo", ["query"]) });
    const widened = await mint();
    assert(widened.run !== first.run, "a changed grant set is a NEW run, never an edit of the old one");
    const before = await t.space.effectivePermissions(first.run);
    assertEquals(before.kinds.map((k) => k.kind), ["note"], "and the old run's authority is untouched");
  } finally {
    t.close();
  }
});

Deno.test("delegation: reuse never revives a STOPPED run, so the cascade holds", async () => {
  const t = await newSpace();
  try {
    const handler = makeHandler(t.space, "<html>c</html>", true);
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    const seed = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const mint = () =>
      handler(
        new Request("http://t/v0/agent-runs/delegated", {
          method: "POST",
          headers: { "content-type": "application/json", "Authorization": `Bearer ${worker.runToken}` },
          body: JSON.stringify({ for: seed.id }),
        }),
      );
    const first = await (await mint()).json() as { run: string };
    await t.space.stopRun(first.run);
    const again = await mint();
    assertEquals(again.status, 422, await again.clone().text());
    assertStringIncludes(await again.text(), "run_stopped");
  } finally {
    t.close();
  }
});

// --- the refusal a guessing caller actually reads -----------------------------------------------

Deno.test("authorize: a refusal SAYS when the kind does not exist, without changing the status", async () => {
  const t = await newSpace();
  try {
    const handler = makeHandler(t.space, "<html>c</html>", true);
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"])]);

    // A DECLARED kind it holds nothing on: the plain refusal, unchanged.
    const declared = await assertRejects(() => t.space.authorize(alice.run, "put", "memo"), RadiaError);
    assertEquals(declared.code, "forbidden");
    assertStringIncludes(declared.message, "has no 'put' grant for kind 'memo'");
    assert(!declared.message.includes("is declared"), "a real kind must not be reported as missing");

    // A kind nobody ever declared. Authorization runs BEFORE pattern compilation, so this is the
    // only thing the caller is ever told — and "you lack a grant" sends it looking for permission
    // that would not help. A live session burned two calls on exactly this.
    const invented = await assertRejects(() => t.space.authorize(alice.run, "query", "file"), RadiaError);
    assertEquals(invented.code, "forbidden", "still a refusal, and still 403: the wire contract does not move");
    assertStringIncludes(invented.message, "not a declared kind on this space");
    // The remedy must be sayable through any surface. A CLI verb is not: the reader that hits this
    // is a model holding tools, and `src/core` naming `radia kinds` would be it reaching into a
    // surface's vocabulary for a reader that cannot use it.
    assertStringIncludes(invented.message, "kind_def");
    assert(!invented.message.includes("radia "), "the substrate must not prescribe a CLI command");

    // Over the wire, so the status is pinned rather than inferred from the code.
    const res = await handler(
      new Request("http://t/v0/records/query", {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": `Bearer ${alice.runToken}` },
        body: JSON.stringify({ kind: "file" }),
      }),
    );
    assertEquals(res.status, 403);
    assertStringIncludes(await res.text(), "not a declared kind on this space");
  } finally {
    t.close();
  }
});

// --- phase 2: enumerate and revoke -------------------------------------------------------------

Deno.test("delegation: runs are ENUMERABLE by caller, which is what makes a cascade possible", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["query"])]);
    const bob = await agentRun(t.space, "human:bob", [grant("human:bob", "note", ["query"])]);
    const w1 = await agentRun(t.space, "agent:w1", [grant("agent:w1", "note", ["query"])]);
    const w2 = await agentRun(t.space, "agent:w2", [grant("agent:w2", "note", ["query"])]);
    const aliceRec = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const bobRec = await t.space.put({ kind: "note", body: { owner: "bob", topic: "x" } }, undefined, bob.run);
    const d1 = await t.space.mintDelegatedRun(w1.run, aliceRec.id);
    const d2 = await t.space.mintDelegatedRun(w2.run, aliceRec.id);
    await t.space.mintDelegatedRun(w1.run, bobRec.id);

    // Indexed, so this is one query rather than a scan: `actingFor` is a declared path on
    // `agent_run`. Two DIFFERENT workers' runs come back, which is the point — the caller is the
    // axis a deprovisioning cascade needs, and the worker is not.
    const rows = await t.space.query({ kind: "agent_run", match: { actingFor: "human:alice" } }, 100);
    const runs = new Set(rows.map((r) => (r.body as { run: string }).run));
    assertEquals(runs, new Set([d1.run, d2.run]));

    // Revoking the DEFINITION deliberately leaves runs alive, which is why the cascade exists.
    await t.space.revokeDefinition("human:alice");
    assertEquals(await t.space.authorize(d1.run, "query", "note"), null, "still live after the definition died");
    for (const r of runs) await t.space.stopRun(r);
    const cold = new Space(t.adapter, {} as never);
    await cold.loadKinds();
    const res = await makeHandler(cold, "<html>c</html>", true)(
      new Request("http://t/v0/records/query", {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": `Bearer ${d1.runToken}` },
        body: JSON.stringify({ kind: "note" }),
      }),
    );
    assertEquals(res.status, 401, "a stopped delegated run resolves no further");
  } finally {
    t.close();
  }
});

Deno.test("delegation: offboarding needs BOTH run classes, not just the delegated ones", async () => {
  const t = await newSpace();
  try {
    // The shape `radia runs --for` has to cover. A person acts through two kinds of credential and
    // they live under different fields, so a query for one silently leaves the other working:
    //   OWN        agent_run{agent: X}      — from `radia login` or SSO
    //   DELEGATED  agent_run{actingFor: X}  — minted by a worker on their behalf
    // The verb shipped matching only the second, so the documented offboarding command left the
    // person's own session alive for up to the run ceiling.
    const leaver = await agentRun(t.space, "human:leaver", [grant("human:leaver", "note", ["put", "query"])]);
    const worker = await agentRun(t.space, "agent:w", [grant("agent:w", "note", ["query"])]);
    const seed = await t.space.put({ kind: "note", body: { owner: "leaver", topic: "x" } }, undefined, leaver.run);
    const delegated = await t.space.mintDelegatedRun(worker.run, seed.id);

    const byActingFor = await t.space.query({ kind: "agent_run", match: { actingFor: "human:leaver" } }, 50);
    const byAgent = await t.space.query({ kind: "agent_run", match: { agent: "human:leaver" } }, 50);
    const runsIn = (rows: { body: unknown }[]) => new Set(rows.map((r) => (r.body as { run: string }).run));
    assertEquals(runsIn(byActingFor), new Set([delegated.run]), "actingFor finds ONLY the delegated run");
    assertEquals(runsIn(byAgent), new Set([leaver.run]), "…and the person's own session is under `agent`, not `actingFor`");

    // Stopping only what `actingFor` matched leaves them able to act. This is the regression.
    await t.space.stopRun(delegated.run);
    assertEquals(
      await t.space.authorize(leaver.run, "put", "note"),
      null,
      "stopping the delegated run alone leaves their own session working — offboarding must cover both",
    );

    // Both classes stopped is what actually ends it, and `stopRun` is per-run, so the verb has to
    // gather them itself.
    await t.space.stopRun(leaver.run);
    const cold = new Space(t.adapter, {} as never);
    await cold.loadKinds();
    const res = await makeHandler(cold, "<html>c</html>", true)(
      new Request("http://t/v0/records/query", {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": `Bearer ${leaver.runToken}` },
        body: JSON.stringify({ kind: "note" }),
      }),
    );
    assertEquals(res.status, 401, "with both classes stopped, their credential resolves no further");
  } finally {
    t.close();
  }
});

Deno.test("delegation: entitlement is a lease OR read access, never neither", async () => {
  const t = await newSpace();
  try {
    const alice = await agentRun(t.space, "human:alice", [grant("human:alice", "note", ["put", "query"])]);
    // Holds `query` on `memo` and nothing at all on `note`: it can neither read the record nor
    // hold a lease on it, so naming it is refused before any caller is resolved.
    const stranger = await agentRun(t.space, "agent:stranger", [grant("agent:stranger", "memo", ["query"])]);
    const { id } = await t.space.put({ kind: "note", body: { owner: "alice", topic: "x" } }, undefined, alice.run);
    const e = await assertRejects(() => t.space.mintDelegatedRun(stranger.run, id), RadiaError);
    assertEquals(e.code, "forbidden");
    assertStringIncludes(e.message, "neither holds a lease");
  } finally {
    t.close();
  }
});
