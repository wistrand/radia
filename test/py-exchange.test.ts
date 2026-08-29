// The Python SDK re-authenticating itself: the durable half of a credential exchanged for the short
// half whenever the short one stops working. `test/exchange.test.ts` is the same contract in
// TypeScript, and until 2026-08-29 it had no Python twin, so a Python `agent_loop` ended at the
// 12-hour run ceiling with nothing able to mint another run. `sdk/README.md` named it as the one
// real parity gap.
//
// A REAL SPACE behind a real socket, driven by a real python3, for the reason the TS twin gives: the
// thing under test is the client's own retry across paths that do NOT share a code path (`_req`,
// the two artifact calls, and the SSE stream), and a stubbed transport would test a mock's idea of
// a 401.
//
// Skips without python3, exactly as `py-parity.test.ts` does. `docker/py-parity/` is the run that
// cannot silently skip.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { makeHandler } from "../src/server/http.ts";
import { Space } from "../src/core/space.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";

const pyDir = fromFileUrl(new URL("../sdk/py", import.meta.url));

const hasPython = await (async () => {
  try {
    return (await new Deno.Command("python3", { args: ["--version"], stdout: "null", stderr: "null" }).output()).success;
  } catch {
    return false;
  }
})();

async function py(script: string): Promise<string> {
  const out = await new Deno.Command("python3", { args: ["-c", script], stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

/** A space on a real port with one definition that may work with tasks and artifacts. `mints`
 *  counts run creations, which is how "exchanged once, not per call" is checked. */
async function newSpace() {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.init();
  const space = new Space(adapter);
  space.registerKind({ kind: "task", indexedPaths: [{ path: "tag", type: "keyword" }] });
  const handler = makeHandler(space, "<html>console</html>", true);
  let mints = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    if (req.method === "POST" && new URL(req.url).pathname === "/v0/agent-runs") mints++;
    return handler(req);
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const { definitionToken } = await space.createAgentDefinition("agent:w", [
    { principal: "agent:w", kind: "task", operations: ["put", "query", "read_one", "take"] },
    { principal: "agent:w", kind: "artifact", operations: ["put", "query", "read_one"] },
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

const preamble = (dir: string, base: string, def: string) =>
  [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    "from radia import RadiaClient, RadiaError",
    // token="" means "send nothing", so this client starts with ONLY the durable half and every
    // call below has to have minted its own run.
    `c = RadiaClient(${JSON.stringify(base)}, token="", definition_token=${JSON.stringify(def)})`,
  ].join("\n");

Deno.test({
  name: "py exchange: a client holding only the durable half mints a run and works",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        'r = c.put({"kind": "task", "body": {"tag": "a"}})',
        'print(json.dumps({"id": bool(r.get("id")), "run": bool(c.run), "token": bool(c.token)}))',
      ].join("\n"));
      assertEquals(JSON.parse(out), { id: true, run: true, token: true });
      assertEquals(s.mints(), 1, "one call, one mint");
      assertEquals((await s.space.query({ kind: "task" }, 10)).length, 1);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  name: "py exchange: a stopped run is exchanged out, ONCE, and the session continues",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      // `ensure_credential` mints run 1; the space then stops it, which is what expiry looks like
      // to a client. Every call after that must recover through the durable half.
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        "c.ensure_credential()",
        'print(json.dumps({"first": c.run, "token": c.token}))',
      ].join("\n"));
      const { first, token } = JSON.parse(out) as { first: string; token: string };
      await s.space.stopRun(first);

      // A SECOND process, resuming with the token it stored, which is now dead. The token can only
      // come from the client that minted it: a run token is stored as a hash, so nothing on the
      // space side can hand it back, which is the property being relied on here.
      const after = await py([
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
        "from radia import RadiaClient",
        `c = RadiaClient(${JSON.stringify(s.base)}, token=${JSON.stringify(token)}, definition_token=${
          JSON.stringify(s.definitionToken)
        })`,
        'a = c.put({"kind": "task", "body": {"tag": "b"}})',
        'b = c.put({"kind": "task", "body": {"tag": "c"}})',
        'print(json.dumps({"ok": bool(a.get("id") and b.get("id")), "run": c.run}))',
      ].join("\n"));
      const r = JSON.parse(after);
      assert(r.ok, "the session continued after the run was stopped");
      assert(r.run !== first, "it is acting as a NEW run");
      assertEquals((await s.space.query({ kind: "task" }, 10)).length, 2);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  name: "py exchange: many threads on an expired token mint ONE run, not one each",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      // Ten threads start with no token at all, so all ten need the same exchange at once. Without
      // the lock each appends its own `agent_run` record and nine are discarded.
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        "import threading",
        "errs = []",
        "def go(i):",
        "    try:",
        '        c.put({"kind": "task", "body": {"tag": "t%d" % i}})',
        "    except Exception as e:",
        "        errs.append(str(e))",
        "ts = [threading.Thread(target=go, args=(i,)) for i in range(10)]",
        "[t.start() for t in ts]",
        "[t.join() for t in ts]",
        'print(json.dumps({"errs": errs, "run": c.run}))',
      ].join("\n"));
      assertEquals(JSON.parse(out).errs, []);
      assertEquals(s.mints(), 1, "ten concurrent callers, one mint");
      assertEquals((await s.space.query({ kind: "task" }, 20)).length, 10);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  name: "py exchange: a 403 is never retried, because a grant is not a credential",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      // `note` is a kind this definition holds no grant on. Exchanging would spend a mint and hide
      // the real answer, so the client must raise the 403 as it is.
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        "c.ensure_credential()",
        "try:",
        '    c.put({"kind": "note", "body": {"x": 1}})',
        '    print(json.dumps({"raised": None}))',
        "except RadiaError as e:",
        '    print(json.dumps({"raised": e.status}))',
      ].join("\n"));
      assertEquals(JSON.parse(out).raised, 403);
      assertEquals(s.mints(), 1, "the 403 must not spend a second mint");
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  name: "py exchange: keep_alive mints a new run at the ceiling instead of giving up",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      // The renewal heartbeat used to end the session here: `on_lost` fired and the thread
      // returned, which is correct for a client holding only the short half and wrong for one
      // holding the durable half. The run is stopped under the heartbeat's feet, so its next
      // renew is the 409 that used to be terminal.
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        "import threading, time",
        "c.ensure_credential()",
        "first = c.run",
        "lost = []",
        "stop = threading.Event()",
        "c.stop_run(first)",
        "t = c.keep_alive(stop, on_lost=lambda why: lost.append(why))",
        // The heartbeat's first renew is immediate, so a short wait covers it without a sleep that
        // scales with the poll: what is asserted is the STATE it reached, not how fast.
        "for _ in range(50):",
        "    if c.run != first:",
        "        break",
        "    time.sleep(0.05)",
        "stop.set()",
        'r = c.put({"kind": "task", "body": {"tag": "after"}})',
        'print(json.dumps({"lost": lost, "moved": c.run != first, "wrote": bool(r.get("id"))}))',
      ].join("\n"));
      const r = JSON.parse(out);
      assertEquals(r.lost, [], "a client with the durable half must not report the session lost");
      assert(r.moved, "the heartbeat minted a new run");
      assert(r.wrote, "and the session kept working");
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  name: "py exchange: the artifact paths recover too, and they do not share a code path with _req",
  ignore: !hasPython,
  fn: async () => {
    const s = await newSpace();
    try {
      const out = await py([
        preamble(pyDir, s.base, s.definitionToken),
        // No `ensure_credential`: put_artifact is the FIRST call, so the retry has to mint from
        // inside the artifact path rather than from `_req`.
        'a = c.put_artifact(b"hello bytes", "text/plain")',
        'got = c.get_artifact(a["id"])',
        'print(json.dumps({"round_trip": got.decode() == "hello bytes", "run": bool(c.run)}))',
      ].join("\n"));
      assertEquals(JSON.parse(out), { round_trip: true, run: true });
      assertEquals(s.mints(), 1);
    } finally {
      await s.close();
    }
  },
});
