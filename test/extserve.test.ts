// The extension HTTP binding (src/surfaces/extserve.ts, agent_docs/plan-extension-http.md), held
// to the direct TS API it claims to bind. Every case runs an operation through ONE side and
// verifies it through the OTHER, because a binding that only round-trips through itself can fork
// from the implementation and keep passing: the records in the space are the shared truth, so a
// publish over HTTP must be a retirement the TS projection sees, and a beat from the TS scheduler
// must appear in the HTTP liveness view.
//
// A real socket for the SPACE (the facade's clients are RadiaClients, and a stubbed fetch would
// test a mock's idea of `/v0`), but the FACADE itself is driven as the pure function it is: no
// second port, and the Python case below is the one that binds one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { RadiaClient } from "../sdk/ts/client.ts";
import { bearerClientFor, extHandler } from "../src/surfaces/extserve.ts";
import { readWorkspace, treeDigestOf, type WorkspaceFile, writeWorkspace } from "../extensions/ts/workspace.ts";
import { type CapabilityBody, liveCapabilities, publishCapability, type ToolDef } from "../extensions/ts/capability.ts";
import { beatPresence, livePresence, presenceSpec } from "../extensions/ts/presence.ts";
import { pinnedDigests } from "../extensions/ts/promotion.ts";

async function newSpace() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  const handler = makeHandler(space, "<html>console</html>", true);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler);
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const operator = await space.mintOperatorToken();
  const ext = extHandler(bearerClientFor(base));
  /** One facade request, driven as a function. Returns parsed JSON plus the raw response. */
  const call = async (method: string, path: string, body?: unknown, token: string | null = operator) => {
    const res = await ext(
      new Request(`http://ext.local${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text; // file bytes come back raw
    }
    return { status: res.status, body: parsed as any, headers: res.headers };
  };
  const direct = new RadiaClient(base, operator);
  return {
    space,
    base,
    ext,
    operator,
    call,
    direct,
    close: async () => {
      await server.shutdown();
      await adapter.close();
    },
  };
}

const toolDef = (name: string, description: string): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object" } },
});

Deno.test("[extserve] a workspace written through the binding is the direct API's workspace, and back", async () => {
  const s = await newSpace();
  try {
    assertEquals((await s.call("POST", "/ext/workspace/v1/declare")).status, 200);

    // HTTP writes, TS reads: same manifest, same digest.
    const w = await s.call("POST", "/ext/workspace/v1/workspaces", {
      name: "w",
      files: { "a.txt": "one\n", "lib/b.txt": "two\n" },
      entrypoint: "a.txt",
    });
    assertEquals(w.status, 200);
    const head = await readWorkspace(s.direct, "w");
    assertEquals(head?.treeDigest, w.body.treeDigest);
    assertEquals(head?.entrypoint, "a.txt");

    // The digest endpoint reproduces the normative hash from the manifest alone.
    const files = (w.body.files as WorkspaceFile[]).map((f) => ({ path: f.path, mode: f.mode, digest: f.digest }));
    const d = await s.call("POST", "/ext/workspace/v1/digest", { files });
    assertEquals(d.body.treeDigest, w.body.treeDigest);
    assertEquals(d.body.treeDigest, await treeDigestOf(w.body.files));

    // An identical re-write dedupes rather than appending a version (the extension's own contract).
    const again = await s.call("POST", "/ext/workspace/v1/workspaces", {
      name: "w",
      files: { "a.txt": "one\n", "lib/b.txt": "two\n" },
      entrypoint: "a.txt",
    });
    assertEquals(again.body.deduped, true);

    // TS writes, HTTP reads: the listing, the head and the bytes.
    await writeWorkspace(s.direct, { name: "w2", owner: "t", files: { "c.txt": "three" } });
    const one = await s.call("GET", "/ext/workspace/v1/workspaces/w2");
    assertEquals(one.status, 200);
    const file = await s.call("GET", "/ext/workspace/v1/workspaces/w2/files/c.txt");
    assertEquals(file.body, "three");
    // The main-origin paint rule: text downloads, and never sniffs.
    assertStringIncludes(file.headers.get("content-disposition") ?? "", "attachment");
    assertEquals(file.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] capability states cross the boundary: publish, supersede, retire, revive", async () => {
  const s = await newSpace();
  try {
    assertEquals((await s.call("POST", "/ext/capability/v1/declare")).status, 200);

    // NEW over HTTP, visible to the TS projection.
    await s.call("POST", "/ext/capability/v1/publish", { def: toolDef("t1", "one"), provider: "p" });
    const reg1 = await liveCapabilities(s.direct);
    const t1 = [...reg1.entries].filter((r) => (r.body as CapabilityBody).tool === "t1");
    assertEquals(t1.length, 1);
    assertEquals(t1[0].body.def?.function.description, "one");

    // CHANGED over HTTP: still one entry, superseded.
    await s.call("POST", "/ext/capability/v1/publish", { def: toolDef("t1", "two"), provider: "p" });
    const reg2 = await liveCapabilities(s.direct);
    const t1b = [...reg2.entries].filter((r) => (r.body as CapabilityBody).tool === "t1");
    assertEquals(t1b.length, 1);
    assertEquals(t1b[0].body.def?.function.description, "two");

    // RETIRED over HTTP: gone from the HTTP tool list.
    await s.call("POST", "/ext/capability/v1/retire", { tool: "t1", provider: "p" });
    const tools = await s.call("GET", "/ext/capability/v1/tools");
    assertEquals(tools.body.tools.length, 0);

    // REVIVED by the DIRECT implementation (the `:after:` anchor), visible over HTTP: the case
    // that catches a fork, since a binding that keyed its writes differently would replay here.
    await publishCapability(s.direct, toolDef("t1", "two"), "p");
    const tools2 = await s.call("GET", "/ext/capability/v1/tools");
    assertEquals(tools2.body.tools.map((t: { tool: string }) => t.tool), ["t1"]);
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] presence beats interleave across implementations, windowed", async () => {
  const s = await newSpace();
  try {
    // A wide window on purpose: the two-beats-one-record assert below would flake if the refresh
    // window boundary (ttl/3) fell between the beats, so the odds are shrunk from ms-in-20s to
    // ms-in-200s rather than tolerated.
    const spec = { kind: "pk", ttlMs: 600_000 };
    assertEquals((await s.call("POST", "/ext/presence/v1/declare", spec)).status, 200);

    // Two HTTP beats in one refresh window are ONE record: the window key replays, exactly as
    // `announcePresence`'s scheduler beats do.
    await s.call("POST", "/ext/presence/v1/beat", { ...spec, subject: "svc", instance: "i" });
    await s.call("POST", "/ext/presence/v1/beat", { ...spec, subject: "svc", instance: "i" });
    assertEquals((await s.direct.queryNewest({ kind: "pk" }, 10)).length, 1);

    // A TS beat lands in the HTTP liveness view beside the HTTP one.
    await beatPresence(s.direct, presenceSpec("pk", { ttlMs: spec.ttlMs }), { subject: "svc", instance: "j" });
    const live = await s.call("GET", `/ext/presence/v1/live?kind=pk&ttlMs=${spec.ttlMs}`);
    assertEquals((live.body.live.svc as string[]).sort(), ["i", "j"]);

    // An HTTP retirement is a tombstone the TS reader honours.
    await s.call("POST", "/ext/presence/v1/retire", { ...spec, subject: "svc", instance: "i" });
    const view = await livePresence(s.direct, presenceSpec("pk", { ttlMs: spec.ttlMs }));
    assertEquals([...(view.live.get("svc") ?? [])], ["j"]);
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] a seed enters the space and its result rides back, refusals named", async () => {
  const s = await newSpace();
  try {
    await s.direct.registerKind({ kind: "job", indexedPaths: [{ path: "t", type: "keyword" }], claimable: true });
    await s.direct.registerKind({ kind: "job_result", indexedPaths: [{ path: "t", type: "keyword" }] });

    const seed = await s.call("POST", "/ext/turn/v1/seed", { kind: "job", body: { t: "x" } });
    assertEquals(seed.status, 200);
    // The space answers (a worker's ack in real life), and the long-poll carries it back.
    await s.direct.put({ kind: "job_result", body: { t: "x", answer: 42 }, parentIds: [seed.body.seedId] });
    const got = await s.call("GET", `/ext/turn/v1/result?seed=${seed.body.seedId}&kind=job_result&timeoutMs=5000`);
    assertEquals(got.body.result.body.answer, 42);
    assert(got.body.result.runtimeMeta.parentIds.includes(seed.body.seedId));

    // A misspelled field is refused BY NAME, never dropped (plan-bounded-reads.md's class).
    const bad = await s.call("POST", "/ext/turn/v1/seed", { kind: "job", body: {}, idempotencyKey: "k" });
    assertEquals(bad.status, 400);
    assertStringIncludes(bad.body.detail, "'idempotencyKey'");

    // The other refusals hold at the edge: no token, an oversized body, malformed encoding.
    assertEquals((await s.call("POST", "/ext/turn/v1/seed", { kind: "job", body: {} }, null)).status, 401);
    const big = await s.ext(
      new Request("http://ext.local/ext/turn/v1/seed", {
        method: "POST",
        headers: { authorization: `Bearer ${s.operator}`, "content-length": String(64 * 1024 * 1024) },
        body: "{}",
      }),
    );
    assertEquals(big.status, 413);
    assertEquals((await s.call("GET", "/ext/workspace/v1/%zz")).status, 400);
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] promotion rotates through the binding and pins answer from the enforcement path, both ways", async () => {
  const s = await newSpace();
  try {
    assertEquals((await s.call("POST", "/ext/promotion/v1/declare")).status, 200);
    const pin = { principal: "agent:runner", operations: ["take"] };

    await s.call("POST", "/ext/promotion/v1/promote", { digest: "t1:aaa", tier: "prod", pins: [pin] });
    assertEquals(await pinnedDigests(s.direct, { principal: "agent:runner", tier: "prod" }), ["t1:aaa"]);

    await s.call("POST", "/ext/promotion/v1/promote", { digest: "t1:bbb", tier: "prod", pins: [pin] });
    const pins = await s.call("GET", "/ext/promotion/v1/pins?principal=agent%3Arunner&tier=prod");
    assertEquals(pins.body.digests, ["t1:bbb"]);

    // Rollback exercises the revive path: t1:aaa was retired by the promotion that replaced it.
    await s.call("POST", "/ext/promotion/v1/rollback", { digest: "t1:aaa", tier: "prod", pins: [pin] });
    assertEquals(await pinnedDigests(s.direct, { principal: "agent:runner", tier: "prod" }), ["t1:aaa"]);

    // A pin with a misspelled member is a refusal, not a wider grant.
    const bad = await s.call("POST", "/ext/promotion/v1/promote", {
      digest: "t1:ccc",
      tier: "prod",
      pins: [{ principal: "agent:runner", operation: ["take"] }],
    });
    assertEquals(bad.status, 400);
    assertStringIncludes(bad.body.detail, "'operation'");
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] bindings and the compartment boundary read through the binding", async () => {
  const s = await newSpace();
  try {
    assertEquals((await s.call("POST", "/ext/host/v1/declare")).status, 200);
    await s.direct.put({ kind: "binding", body: { agent: "agent:x", workspaceDigest: "t1:aaa", entrypoint: "main.ts" } });
    const all = await s.call("GET", "/ext/host/v1/bindings");
    assertEquals(all.body.bindings.map((b: { agent: string }) => b.agent), ["agent:x"]);
    assertEquals((await s.call("GET", "/ext/host/v1/bindings?agent=agent%3Ay")).body.bindings, []);

    // A principal reading inside and writing outside is a crosser, and the audit says so.
    await s.direct.grant("agent:x", "task", ["query"]);
    await s.direct.grant("agent:x", "out", ["put"]);
    const audit = await s.call("GET", "/ext/compartment/v1/audit?inside=task");
    assertEquals(audit.status, 200);
    assertEquals(audit.body.crossers.map((c: { principal: string }) => c.principal), ["agent:x"]);
    assert(Array.isArray(audit.body.caveats) && audit.body.caveats.length > 0);
  } finally {
    await s.close();
  }
});

Deno.test("[extserve] the co-hosted mount forwards its prefix, nothing else, and cannot shadow the contract", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  try {
    let forwarded = 0;
    const handler = makeHandler(space, "<html>console</html>", false, {
      prefix: "/ext/",
      handler: (req) => {
        forwarded++;
        return new Response(JSON.stringify({ mounted: new URL(req.url).pathname }), { status: 200 });
      },
    });
    // The prefix is the mounted handler's whole namespace, forwarded before any runtime dispatch.
    const hit = await handler(new Request("http://x/ext/anything/v1/here"));
    assertEquals((await hit.json()).mounted, "/ext/anything/v1/here");
    // Everything else stays the runtime's: its own routes answer, and a path that merely STARTS
    // like the prefix ("/extra") misses it.
    assertEquals((await handler(new Request("http://x/v0/health"))).status, 200);
    assertEquals((await handler(new Request("http://x/extra"))).status, 404);
    assertEquals(forwarded, 1);
    // A prefix that would shadow the frozen contract or the console's assets, or is not one
    // lowercase segment, refuses at CONSTRUCTION, before anything is served.
    for (const prefix of ["/v0/", "/ui/", "ext/", "/Ext/", "/two/segments/"]) {
      let threw = false;
      try {
        makeHandler(space, "", false, { prefix, handler: () => new Response() });
      } catch {
        threw = true;
      }
      assert(threw, `prefix '${prefix}' should be refused`);
    }
  } finally {
    await adapter.close();
  }
});

const hasPython = await (async () => {
  try {
    const out = await new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return out.success;
  } catch {
    return false; // no interpreter, or no --allow-run: the wrapper cannot be checked here
  }
})();

Deno.test({
  name: "[extserve] the Python wrapper drives the binding over a real socket",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    // The one case that binds a facade SOCKET, because the wrapper's transport is the thing under
    // test: urllib against the same handler every other case drives as a function.
    const facade = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, s.ext);
    try {
      const script = `
import json, sys
sys.path.insert(0, sys.argv[3])
from radia_ext import RadiaExt, RadiaExtError

ext = RadiaExt(sys.argv[1], sys.argv[2])
assert ext.health()["ok"] is True
ext.workspace_declare()
w = ext.write_workspace("pyapp", files={"main.py": "print(1)\\n", "logo.bin": b"\\x00\\x01"}, entrypoint="main.py")
assert ext.read_file("pyapp", "logo.bin") == b"\\x00\\x01"
files = [{"path": f["path"], "mode": f["mode"], "digest": f["digest"]} for f in w["files"]]
assert ext.tree_digest(files) == w["treeDigest"]
ext.presence_declare("pypk", ttl_ms=60000)
ext.beat("pypk", "svc", "py1", ttl_ms=60000)
assert ext.live_presence("pypk", ttl_ms=60000)["live"]["svc"] == ["py1"]
seed = ext.seed("pyjob", {"t": "x"})
assert seed["seedId"]
try:
    ext.read_workspace("no-such-tree")
    raise AssertionError("expected a 404")
except RadiaExtError as e:
    assert e.status == 404
print("PY_OK", w["treeDigest"])
`;
      await s.direct.registerKind({ kind: "pyjob", indexedPaths: [{ path: "t", type: "keyword" }], claimable: true });
      const base = `http://127.0.0.1:${(facade.addr as Deno.NetAddr).port}`;
      // The sdk path rides argv, derived from THIS file: `sys.path` from the CWD made the case
      // pass only when the test ran from the repo root.
      const sdkPy = new URL("../sdk/py", import.meta.url).pathname;
      const child = await new Deno.Command("python3", {
        args: ["-c", script, base, s.operator, sdkPy],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(child.stdout);
      if (!child.success) throw new Error(new TextDecoder().decode(child.stderr));
      assertStringIncludes(stdout, "PY_OK t1:");
      // What Python wrote, the direct TS API reads: the same interop bar as every other case.
      const head = await readWorkspace(s.direct, "pyapp");
      assertStringIncludes(stdout, head!.treeDigest);
    } finally {
      await facade.shutdown();
      await s.close();
    }
  },
});

Deno.test("[extserve] a caller discovers its own pattern scopes, through the definition-token relay", async () => {
  const s = await newSpace();
  try {
    const { definitionToken } = await s.space.createAgentDefinition("agent:scoped", []);
    await s.direct.grant("agent:scoped", "task", ["put"], { team: "alpha" });

    // The DEFINITION token is the credential: the facade's client exchanges it on the space's
    // first refusal, which is the relay path an app in another language will actually use.
    const scopes = await s.call("GET", "/ext/permissions/v1/scopes", undefined, definitionToken);
    assertEquals(scopes.status, 200);
    assertEquals(scopes.body.subject, "agent:scoped");
    const task = scopes.body.scopes.find((x: { kind: string }) => x.kind === "task");
    assertEquals(task.patterns, [{ team: "alpha" }]);
    // Discovery, never a fill: the response says choosing is the caller's.
    assertStringIncludes(scopes.body.note, "caller's choice");
  } finally {
    await s.close();
  }
});
