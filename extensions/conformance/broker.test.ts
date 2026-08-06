// The broker's contract (agent_docs/architecture-workspace-agents.md phase 5).
//
//   deno task extensions
//
// NORMATIVE, like `treeDigestOf` and the git object encoding, and for the same reason: this is
// the boundary between model-written code and an agent's authority, so another implementation
// has to behave exactly this way or the two are not comparable.
//
// The cases are the three properties the phase claims plus the one that makes them worth
// claiming: that the jail cannot simply go around the broker. That last one is the escape probe,
// the shape `sandbox.ts` already uses, and it is the reason the line about real protected
// data waits for this phase rather than the one before it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { brokeredInvoker, labelsForJail } from "../ts/broker.ts";
import { BINDING, declareBinding, treeCache, type TreeCache, WorkspaceHost } from "../ts/host.ts";
import { declareExecRequest, EXEC_REQUEST, promote } from "../ts/promotion.ts";
import { writeWorkspace } from "../ts/workspace.ts";
import { declareSandbox } from "../ts/sandbox-registry.ts";

const PORT = 7823;
const url = `http://127.0.0.1:${PORT}`;
const AGENT = "agent:worker";

interface Ctx {
  operator: RadiaClient;
  /** Stand up an agent bound to a one-file workspace, and return a host that runs it brokered. */
  hostFor: (
    entry: string,
    opts?: {
      labels?: string[];
      stamp?: Record<string, unknown>;
      cache?: TreeCache;
      sandbox?: Record<string, unknown>;
      timeoutMs?: number;
    },
  ) => Promise<WorkspaceHost>;
  /** Another request at the digest currently bound: a second claim for the same code. */
  freshRequest: () => Promise<void>;
  /** Promote and bind DIFFERENT code, then queue a request for it. */
  rebind: (entry: string) => Promise<void>;
}

async function withSpace<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const operator = new RadiaClient(url, { token: operatorToken(url) });
  await declareExecRequest(operator);
  await declareBinding(operator);
  await operator.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }, { path: "compartment", type: "keyword" }] });
  await operator.registerKind({ kind: "exec_result", indexedPaths: [{ path: "tag", type: "keyword" }] });
  await operator.registerKind({
    kind: "workspace",
    indexedPaths: [{ path: "name", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "treeDigest", type: "keyword" }, { path: "basedOn", type: "keyword" }],
    claimable: false,
  });
  let n = 0;
  let current = "";
  /** Promote the code, bind the agent to it, and queue one request. Shared by `hostFor` and
   *  `rebind`, because a promotion that forgot either lock is a different test than these. */
  let sandboxPattern: Record<string, unknown> | undefined;
  let file = "main.ts";
  const install = async (entry: string): Promise<string> => {
    const ws = await writeWorkspace(operator, { name: `ws${++n}`, owner: "human:alice", files: { [file]: entry } });
    await promote(operator, { digest: ws.treeDigest, tier: "prod", pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.put({
      kind: BINDING,
      body: { agent: AGENT, workspaceDigest: ws.treeDigest, entrypoint: file, ...(sandboxPattern ? { sandboxPattern } : {}) },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: ws.treeDigest, tier: "prod", job: "j" } });
    current = ws.treeDigest;
    return ws.treeDigest;
  };
  try {
    return await fn({
      operator,
      hostFor: async (entry, o = {}) => {
        const { definitionToken } = await operator.createAgentDefinition(AGENT, []);
        await operator.grant(AGENT, "exec_result", ["put"]);
        await operator.grant(AGENT, "note", ["put"]);
        if (o.sandbox) {
          sandboxPattern = o.sandbox;
          file = "main.py";
        }
        await install(entry);
        return new WorkspaceHost({
          base: url,
          credentials: { [AGENT]: definitionToken },
          reader: operator,
          invoke: brokeredInvoker(operator, o),
        });
      },
      freshRequest: async () => {
        await operator.put({ kind: EXEC_REQUEST, body: { workspace: current, tier: "prod", job: `j${++n}` } });
      },
      rebind: async (entry) => {
        await install(entry);
      },
    });
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
}

Deno.test("[broker] the jail cannot reach the space, so the broker is the only way out", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The escape probe. The space is on localhost and the entrypoint knows the URL; what it does
    // not have is `--allow-net`, `--allow-env` or `--allow-run`, so every direct route fails
    // before it reaches a socket. If this case ever passes with `reachable: true`, the phase's
    // whole claim is void and containment is back to being the runner's discipline.
    const host = await hostFor(`
      export default async (record, space) => {
        const tried = {};
        try { await fetch(${JSON.stringify(url)} + "/v0/health"); tried.fetch = "reached"; }
        catch (e) { tried.fetch = e.constructor.name; }
        try { tried.env = Deno.env.get("RADIA_TOKEN") ?? "absent"; }
        catch (e) { tried.env = e.constructor.name; }
        try { await Deno.readTextFile(Deno.env.get("HOME") + "/.radia/credentials.json"); tried.creds = "read"; }
        catch (e) { tried.creds = e.constructor.name; }
        try { new Deno.Command("curl").spawn(); tried.run = "spawned"; }
        catch (e) { tried.run = e.constructor.name; }
        // …and the broker, which is the one thing that DOES work.
        await space.put({ kind: "note", body: { tag: "via-broker" } });
        return { kind: "exec_result", body: { tag: "probe", tried } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));

    const results = await operator.query({ kind: "exec_result" }, 5, { dir: "desc" });
    const tried = (results[0].body as { tried: Record<string, string> }).tried;
    // Matched as a PERMISSION denial rather than as any throw, so a typo cannot read as
    // containment, and against both spellings Deno has used (`PermissionDenied` became
    // `NotCapable`), so the contract survives a runtime upgrade.
    const denied = /NotCapable|PermissionDenied/;
    for (const [route, outcome] of Object.entries(tried)) {
      assert(denied.test(outcome), `the jail reached the space through ${route}: ${outcome}`);
    }
    assertEquals((await operator.query({ kind: "note" }, 5)).length, 1, "the broker is the way that works");
  });
});

Deno.test("[broker] a brokered write is the AGENT's, and carries the claimed record as a parent", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    const host = await hostFor(`
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "from-jail" } });
        return { kind: "exec_result", body: { tag: "ok" } };
      };
    `);
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);

    const notes = await operator.query({ kind: "note" }, 5, { dir: "desc" });
    assertEquals(notes.length, 1);
    const perms = await operator.permissions(notes[0].runtimeMeta.createdBy) as { subject: string };
    assertEquals(perms.subject, AGENT, "a proposal is performed under the AGENT, never the host");
    // Lineage the code never mentioned. A direct put omitting parents is how taint is lost, so
    // the broker prepends the claimed record whatever the entrypoint says.
    const requests = await operator.query({ kind: EXEC_REQUEST }, 5, { dir: "desc" });
    assertEquals(notes[0].runtimeMeta.parentIds, [requests[0].id]);
  });
});

Deno.test("[broker] the code cannot lie about what it touched, or write outside its compartment", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The entrypoint declares no labels and names another compartment. Both are host decisions,
    // taken from the jail's declared powers, so what the code says is irrelevant.
    const host = await hostFor(
      `
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "sneaky", compartment: "public" }, taint: [] });
        return { kind: "exec_result", body: { tag: "ok" } };
      };
    `,
      { labels: labelsForJail({ readRoots: ["/some/host/path"] }), stamp: { compartment: "alpha" } },
    );
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);

    const notes = await operator.query({ kind: "note" }, 5, { dir: "desc" });
    assertEquals((notes[0].body as { compartment: string }).compartment, "alpha", "the host's stamp wins over the body");
    // `file` is the host's stamp. `foreign` is the RUNTIME's, and it is here only because the
    // broker forced the claimed record as a parent: the output is derived from a record another
    // principal wrote, which is exactly what that label means. Forcing lineage does not only
    // preserve labels, it lets the space compute its own.
    assertEquals(notes[0].runtimeMeta.taint, ["file", "foreign"]);
  });
});

Deno.test("[broker] a retried attempt's writes dedupe, so at-least-once does not double", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The entrypoint fails AFTER writing, which is exactly the shape at-least-once delivery
    // produces: the work is nacked, claimed again, and the write happens a second time. Keys
    // derived from (claimed record, output ordinal) make the second one a replay.
    const host = await hostFor(`
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "once" } });
        if (!record.body.retry) throw new Error("boom after writing");
        return { kind: "exec_result", body: { tag: "ok" } };
      };
    `);
    const first = await host.tick();
    assertEquals(first.map((o) => o.status), ["failed"], JSON.stringify(first));
    assertEquals((await operator.query({ kind: "note" }, 5)).length, 1);

    // The nack backs the record off, so wait for it and let the same attempt happen again.
    await new Promise((r) => setTimeout(r, 5200));
    const second = await host.tick();
    assertEquals(second.map((o) => o.status), ["failed"], "the entrypoint fails the same way");
    assertEquals(
      (await operator.query({ kind: "note" }, 5)).length,
      1,
      "the retry's write is a replay, not a second record",
    );
  });
});

Deno.test("[broker] a warm tree is reused, and a new digest is never served from a warm one", async () => {
  await withSpace(async ({ operator, hostFor, freshRequest, rebind }) => {
    // Phase 6. The warm entry is keyed by DIGEST, which is what makes the optimisation provably
    // safe rather than merely likely: there is no way for a cache hit to serve code that changed,
    // because changed code is a different key.
    const cache = treeCache(operator);
    const host = await hostFor(
      `export default async (record, space) => ({ kind: "exec_result", body: { tag: "v1" } });`,
      { cache },
    );

    const coldStart = performance.now();
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);
    const cold = performance.now() - coldStart;
    assertEquals(cache.stats, { hits: 0, misses: 1 });

    await freshRequest();
    const warmStart = performance.now();
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);
    const warm = performance.now() - warmStart;
    assertEquals(cache.stats, { hits: 1, misses: 1 }, "the second claim on one digest re-materialises nothing");
    console.log(`  tree cache: cold ${cold.toFixed(0)}ms, warm ${warm.toFixed(0)}ms`);

    // The correctness claim, stated as the thing that would break it: promote different code and
    // the SAME host must run the new version, because the digest is part of the key.
    await rebind(`export default async (record, space) => ({ kind: "exec_result", body: { tag: "v2" } });`);
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);
    assertEquals(cache.stats, { hits: 1, misses: 2 }, "a new digest is a new entry, never a warm one");
    const results = await operator.query({ kind: "exec_result" }, 5, { dir: "desc" });
    assertEquals((results[0].body as { tag: string }).tag, "v2", "a warm cache must never serve stale code");
    await cache.clear();
  });
});

/** bwrap and python3 are environment, not code: where they are missing the case skips, the same
 *  posture the git round-trip and the sandbox suite take. */
const hasBwrap = await which("bwrap");
const hasPython = await which("python3");

async function which(bin: string): Promise<boolean> {
  try {
    const r = await new Deno.Command("sh", { args: ["-c", `command -v ${bin}`], stdout: "null", stderr: "null" }).output();
    return r.success;
  } catch {
    return false;
  }
}

Deno.test({
  name: "[broker] a PYTHON entrypoint speaks the same frames, jailed by bubblewrap",
  ignore: !hasBwrap || !hasPython,
  fn: async () => {
    await withSpace(async ({ operator, hostFor }) => {
      // The protocol is the contract and the shim is one language's way of speaking it, so a
      // Python worker is not a second broker: the host side never learns which language asked.
      // The jail is chosen by the sandbox RECORD's isolation, independently of the language.
      await declareSandbox(operator, {
        name: "py-sealed",
        language: "python",
        isolation: "bubblewrap",
        network: false,
        readonlyPaths: [],
        writablePaths: [],
        processes: false,
        env: false,
        memoryMb: 256,
        timeoutMsMax: 15_000,
        runtime: "python3",
      });
      const host = await hostFor(
        [
          "import json, urllib.request",
          "def main(record, space):",
          "    tried = {}",
          "    try:",
          `        urllib.request.urlopen(${JSON.stringify(url)} + "/v0/health", timeout=2); tried["net"] = "reached"`,
          '    except Exception as e: tried["net"] = type(e).__name__',
          '    space.put({"kind": "note", "body": {"tag": "from-python"}})',
          '    return {"kind": "exec_result", "body": {"tag": "py:" + record["body"]["job"], "tried": tried}}',
          "",
        ].join("\n"),
        { sandbox: { language: "python", network: false } },
      );

      const outcomes = await host.tick();
      assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
      const results = await operator.query({ kind: "exec_result" }, 5, { dir: "desc" });
      assertEquals((results[0].body as { tag: string }).tag, "py:j", "the Python entrypoint's return value is the result");

      // The escape probe AGAIN, for this backend. bwrap is safe by PRESENCE (`--unshare-all`),
      // the Deno jail by absence, so the Deno probe proves nothing here: a new runner inherits
      // the plan's rule, never its conclusion.
      const tried = (results[0].body as { tried: Record<string, string> }).tried;
      assertEquals(tried.net, "URLError", `a bubblewrap jail must not reach the space: ${tried.net}`);

      // …and the brokered write went through as the AGENT, exactly as it does from JavaScript.
      const notes = await operator.query({ kind: "note" }, 5, { dir: "desc" });
      assertEquals((notes[0].body as { tag: string }).tag, "from-python");
      const perms = await operator.permissions(notes[0].runtimeMeta.createdBy) as { subject: string };
      assertEquals(perms.subject, AGENT);
    });
  },
});

Deno.test("[broker] an entrypoint that writes WITHOUT a newline does not break the channel", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The MCP-stdio failure, as a contract. A partial write immediately before a call used to
    // prepend itself to the frame, which then no longer started its line: the call was read as
    // chatter, the jail blocked on stdin, and the run died at the timeout blaming the wrong
    // thing. Every frame now carries a leading newline, so ordinary output cannot swallow one.
    const host = await hostFor(`
      export default async (record, space) => {
        const enc = new TextEncoder();
        await Deno.stdout.write(enc.encode("progress with no newline..."));
        await space.put({ kind: "note", body: { tag: "after-partial-write" } });
        await Deno.stdout.write(enc.encode("...more, still no newline"));
        return { kind: "exec_result", body: { tag: "survived" } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
    assertEquals((await operator.query({ kind: "note" }, 5)).length, 1, "the brokered call must go through");
    const results = await operator.query({ kind: "exec_result" }, 5, { dir: "desc" });
    assertEquals((results[0].body as { tag: string }).tag, "survived", "…and the result frame too");
  });
});

Deno.test("[broker] an entrypoint that floods stdout is killed, and does not take the host with it", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // Untrusted code printing in a loop is a containment question of a different kind from the
    // escape probe: it does not leave the jail, it exhausts the process reading it. The host
    // caps what it will buffer and says so, rather than growing until the machine complains.
    const host = await hostFor(`
      export default async (record, space) => {
        const enc = new TextEncoder(), line = "x".repeat(64 * 1024) + "\\n";
        for (;;) await Deno.stdout.write(enc.encode(line));
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"]);
    const failed = outcomes[0] as { error: string };
    assertStringIncludes(failed.error, "wrote more than");
    // The work is not lost: a flood is a failure like any other, so it nacks and can be retried.
    const env = await operator.queryEnvelopes({ state: "available", limit: 50 });
    assert(env.some((r) => r.record?.kind === EXEC_REQUEST), "the request goes back for another attempt");
  });
});

Deno.test("[broker] a crash names itself: stderr and the exit code reach the failure", async () => {
  await withSpace(async ({ hostFor }) => {
    // An entrypoint that throws produces no result frame, and the ONLY explanation of why is on
    // stderr. Dropping it left "produced no result" as the whole diagnosis, which says that
    // something went wrong and nothing about what.
    const host = await hostFor(`
      export default async (record, space) => {
        console.error("BOOM: the entrypoint's own explanation");
        throw new Error("deliberate");
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"]);
    const failed = outcomes[0] as { error: string };
    assertStringIncludes(failed.error, "BOOM: the entrypoint's own explanation");
    assertStringIncludes(failed.error, "exit code");
  });
});

Deno.test("[broker] a timeout carries stderr too, since that is where the cause usually is", async () => {
  await withSpace(async ({ hostFor }) => {
    // The path most in need of a diagnosis had none: a hung entrypoint reported only the clock.
    const host = await hostFor(
      `
      export default async (record, space) => {
        console.error("waiting on something that never arrives");
        // A timer, not a promise nobody resolves: Deno detects THAT and exits 1, which is a
        // different failure than the hang this case is about.
        await new Promise((r) => setTimeout(r, 60_000));
      };
    `,
      { timeoutMs: 1500 },
    );
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"]);
    const failed = outcomes[0] as { error: string };
    assertStringIncludes(failed.error, "timed out");
    assertStringIncludes(failed.error, "waiting on something that never arrives");
  });
});

Deno.test("[broker] a result followed by a failing exit is a failure, not a clean ack", async () => {
  await withSpace(async ({ hostFor }) => {
    // The result frame is the entrypoint's declared output, but code that then exits non-zero has
    // contradicted itself, and acking is the worse reading of the two. Retry is safe: the writes
    // it already made replay on their ordinal key.
    const host = await hostFor(`
      export default async (record, space) => {
        // A timer, so the exit lands AFTER the shim has written the result frame. A microtask
        // runs before it, which is a different case: no result at all.
        setTimeout(() => { console.error("teardown failed"); Deno.exit(9); }, 50);
        return { kind: "exec_result", body: { tag: "emitted" } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"], JSON.stringify(outcomes));
    const failed = outcomes[0] as { error: string };
    assertStringIncludes(failed.error, "delivered a result then failed");
    assertStringIncludes(failed.error, "exit code 9");
  });
});

Deno.test("[broker] an entrypoint that floods STDERR is capped too", async () => {
  await withSpace(async ({ hostFor }) => {
    // The stdout cap is worth nothing while the other stream is unbounded, and stderr is the one
    // the host buffers by design. Draining must continue past the cap: stop reading and the child
    // blocks on a full pipe instead of dying, which is what this case would catch. The cap itself
    // is a memory bound and not observable from out here; what is observable is that 12MB of
    // chatter does not bury the cause, because the host keeps the TAIL.
    const host = await hostFor(`
      export default async (record, space) => {
        const enc = new TextEncoder(), line = "e".repeat(64 * 1024) + "\\n";
        for (let i = 0; i < 200; i++) await Deno.stderr.write(enc.encode(line));
        throw new Error("done flooding");
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"]);
    const failed = outcomes[0] as { error: string };
    assertStringIncludes(failed.error, "done flooding");
  });
});
