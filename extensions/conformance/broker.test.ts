// The broker's contract (agent_docs/architecture-workspace-agents.md phase 5).
//
//   deno task test:extensions
//
// NORMATIVE, like `treeDigestOf` and the git object encoding, and for the same reason: this is
// the boundary between model-written code and an agent's authority, so another implementation
// has to behave exactly this way or the two are not comparable.
//
// The cases are the three properties the phase claims plus the one that makes them worth
// claiming: that the jail cannot simply go around the broker. That last one is the escape probe,
// the shape `sandbox.ts` already uses, and it is the reason the line about real protected
// data waits for this phase rather than the one before it.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { RadiaClient, type RadiaRecord } from "../../sdk/ts/client.ts";
import { BROKER_API, brokeredInvoker, declareBrokerSandbox, dryRunEntrypoint, labelsForJail } from "../ts/broker.ts";
import { BINDING, declareBinding, treeCache, type TreeCache, WorkspaceHost } from "../ts/host.ts";
import { declareExecRequest, EXEC_REQUEST, promote } from "../ts/promotion.ts";
import { materialize, readWorkspace, sha256Hex, treeDigestOf, writeWorkspace } from "../ts/workspace.ts";
import { declareSandbox } from "../ts/sandbox-registry.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7823;
const url = `http://127.0.0.1:${PORT}`;

interface Ctx {
  operator: RadiaClient;
  /** This test's own hosted agent: the space is shared, so every test runs a different one. */
  agent: string;
  /** Stand up an agent bound to a one-file workspace, and return a host that runs it brokered. */
  hostFor: (
    entry: string,
    opts?: {
      labels?: string[];
      stamp?: Record<string, unknown>;
      cache?: TreeCache;
      sandbox?: Record<string, unknown>;
      timeoutMs?: number;
      outputWorkspace?: string;
    },
  ) => Promise<WorkspaceHost>;
  /** Another request at the digest currently bound: a second claim for the same code. */
  freshRequest: () => Promise<void>;
  /** Promote and bind DIFFERENT code, then queue a request for it. */
  rebind: (entry: string) => Promise<void>;
}

const operator = await bootSpace(PORT);
await declareExecRequest(operator);
await declareBinding(operator);
await operator.registerKind({ kind: "note", indexedPaths: [{ path: "tag", type: "keyword" }, { path: "compartment", type: "keyword" }] });
await operator.registerKind({ kind: "exec_result", indexedPaths: [{ path: "tag", type: "keyword" }] });
await operator.registerKind({
  kind: "ranked",
  indexedPaths: [{ path: "score", type: "number" }],
  sortablePaths: ["score"],
  claimable: false,
});
await operator.registerKind({
  kind: "workspace",
  indexedPaths: [{ path: "name", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "treeDigest", type: "keyword" }, { path: "basedOn", type: "keyword" }],
  claimable: false,
});

async function withSpace<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  // Per-test namespace on the shared space: a fresh agent and tier mean a later test's host can
  // never claim an earlier test's nacked or abandoned request, and workspace names never fork.
  const AGENT = uniq("agent:worker");
  const TIER = uniq("prod");
  let n = 0;
  let current = "";
  /** Promote the code, bind the agent to it, and queue one request. Shared by `hostFor` and
   *  `rebind`, because a promotion that forgot either lock is a different test than these. */
  let sandboxPattern: Record<string, unknown> | undefined;
  let file = "main.ts";
  let outputWorkspace: string | undefined;
  const install = async (entry: string): Promise<string> => {
    const ws = await writeWorkspace(operator, { name: uniq("ws"), owner: "human:alice", files: { [file]: entry } });
    await promote(operator, { digest: ws.treeDigest, tier: TIER, pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.put({
      kind: BINDING,
      body: {
        agent: AGENT,
        workspaceDigest: ws.treeDigest,
        entrypoint: file,
        ...(sandboxPattern ? { sandboxPattern } : {}),
        ...(outputWorkspace ? { outputWorkspace } : {}),
      },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: ws.treeDigest, tier: TIER, job: "j" } });
    current = ws.treeDigest;
    return ws.treeDigest;
  };
  return await fn({
    operator,
    agent: AGENT,
    hostFor: async (entry, o = {}) => {
      const { definitionToken } = await operator.createAgentDefinition(AGENT, []);
      await operator.grant(AGENT, "exec_result", ["put"]);
      await operator.grant(AGENT, "note", ["put"]);
      if (o.outputWorkspace) {
        outputWorkspace = o.outputWorkspace;
        await operator.grant(AGENT, "workspace", ["put", "query"]);
        await operator.grant(AGENT, "artifact", ["put", "query"]);
      }
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
      await operator.put({ kind: EXEC_REQUEST, body: { workspace: current, tier: TIER, job: `j${++n}` } });
    },
    rebind: async (entry) => {
      await install(entry);
    },
  });
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

    const results = await operator.queryNewest<{ tried: Record<string, string> }>({ kind: "exec_result" }, 5);
    const tried = results[0].body.tried;
    // Matched as a PERMISSION denial rather than as any throw, so a typo cannot read as
    // containment, and against both spellings Deno has used (`PermissionDenied` became
    // `NotCapable`), so the contract survives a runtime upgrade.
    const denied = /NotCapable|PermissionDenied/;
    for (const [route, outcome] of Object.entries(tried)) {
      assert(denied.test(outcome), `the jail reached the space through ${route}: ${outcome}`);
    }
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "via-broker" } }, 5)).length, 1, "the broker is the way that works");
  });
});

Deno.test("[broker] a brokered write is the AGENT's, and carries the claimed record as a parent", async () => {
  await withSpace(async ({ operator, hostFor, agent }) => {
    const host = await hostFor(`
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "from-jail" } });
        return { kind: "exec_result", body: { tag: "ok" } };
      };
    `);
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);

    const notes = await operator.queryNewest({ kind: "note", match: { tag: "from-jail" } }, 5);
    assertEquals(notes.length, 1);
    const perms = await operator.permissions(notes[0].runtimeMeta.createdBy) as { subject: string };
    assertEquals(perms.subject, agent, "a proposal is performed under the AGENT, never the host");
    // Lineage the code never mentioned. A direct put omitting parents is how taint is lost, so
    // the broker prepends the claimed record whatever the entrypoint says.
    const requests = await operator.queryNewest({ kind: EXEC_REQUEST }, 5);
    assertEquals(notes[0].runtimeMeta.parentIds, [requests[0].id]);
  });
});

Deno.test("[broker] read_one answers with the record or null, the shape that name has everywhere", async () => {
  await withSpace(async ({ operator, hostFor, agent }) => {
    // `read_one` is its own coordination verb with its own grant; the harness grants `note: put`.
    await operator.grant(agent, "note", ["read_one"]);
    await operator.put({ kind: "note", body: { tag: "findme" } });
    // The entrypoint reports the SHAPE it was handed, so the assertion is about the frame format
    // rather than about what the query found. It used to be a one-element array (or an empty one),
    // which no other caller of `readOne` gets, on a surface broker.ts declares NORMATIVE.
    const host = await hostFor(`
      export default async (record, space) => {
        const hit = await space.readOne({ kind: "note", match: { tag: "findme" } });
        const miss = await space.readOne({ kind: "note", match: { tag: "nothing-here" } });
        return {
          kind: "exec_result",
          body: {
            hitIsArray: Array.isArray(hit),
            hitTag: hit && hit.body ? hit.body.tag : null,
            missIsNull: miss === null,
          },
        };
      };
    `);
    assertEquals((await host.tick()).map((o) => o.status), ["acked"]);
    const out = (await operator.queryNewest<{ hitIsArray: boolean; hitTag: string | null; missIsNull: boolean }>({ kind: "exec_result" }, 5))[0];
    const body = out.body;
    assertEquals(body.hitIsArray, false, "a record, not a one-element array");
    assertEquals(body.hitTag, "findme");
    assertEquals(body.missIsNull, true, "and null when nothing matched, never an empty array");
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

    const notes = await operator.queryNewest<{ compartment: string }>({ kind: "note" }, 5);
    assertEquals(notes[0].body.compartment, "alpha", "the host's stamp wins over the body");
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
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "once" } }, 5)).length, 1);

    // The nack backs the record off, so wait for it and let the same attempt happen again.
    await new Promise((r) => setTimeout(r, 5200));
    const second = await host.tick();
    assertEquals(second.map((o) => o.status), ["failed"], "the entrypoint fails the same way");
    assertEquals(
      (await operator.queryOldest({ kind: "note", match: { tag: "once" } }, 5)).length,
      1,
      "the retry's write is a replay, not a second record",
    );
  });
});

/**
 * A reader that stands in for a space having a bad moment.
 *
 * `treeCache` only ever calls two methods on its reader, so a stub is the whole surface: the
 * manifest query and the per-file artifact fetch. `failures` counts down, which is what makes the
 * failure TRANSIENT and therefore what a retry is entitled to recover from.
 */
async function flakyReader(
  opts: { failQuery?: number; failArtifact?: number } = {},
): Promise<{ reader: RadiaClient; builds: () => number }> {
  let queryLeft = opts.failQuery ?? 0;
  let artifactLeft = opts.failArtifact ?? 0;
  let builds = 0;
  // A REAL manifest, not a shape that looks like one: `materialize` re-hashes every artifact it
  // fetches and refuses a manifest whose entry claims a digest the bytes do not have. A stub with
  // no `digest` fails there instead of where the case is aiming, which is a test that goes red for
  // its own reason and proves nothing about the code under it.
  const content = new TextEncoder().encode("export default async () => null;\n");
  const digest = await sha256Hex(content);
  const manifest = {
    name: "flaky",
    files: [{ path: "main.ts", artifactId: "a1", digest, size: content.byteLength, mode: "100644" }],
  };
  const reader = {
    // deno-lint-ignore no-explicit-any
    queryNewest: (_pattern: unknown, _n: number): Promise<any[]> => {
      builds++;
      if (queryLeft-- > 0) return Promise.reject(new Error("connection reset"));
      return treeDigestOf(manifest.files as never).then((treeDigest) => [{ body: { ...manifest, treeDigest } }]);
    },
    getArtifact: (_id: string): Promise<Uint8Array> => {
      if (artifactLeft-- > 0) return Promise.reject(new Error("artifact read failed"));
      return Promise.resolve(content);
    },
  } as unknown as RadiaClient;
  return { reader, builds: () => builds };
}

Deno.test("[broker] a failed materialisation is not cached, so the next claim retries it", async () => {
  // The cache stores a PROMISE, which is what lets concurrent claims for one digest share a single
  // materialisation. It therefore also stores a REJECTION unless something removes it, and a
  // rejected entry is served to every later caller for that digest. Nothing rescues it: a hit bumps
  // `used`, so the poisoned entry is the most recently used and never the LRU victim, and the host
  // reads the rejection as transient and nacks with a 5s backoff. One artifact read failing turned
  // into a permanent nack loop for that agent until the process restarted.
  const dir = await Deno.makeTempDir({ prefix: "radia-treecache-" });
  try {
    const { reader, builds } = await flakyReader({ failQuery: 1 });
    const cache = treeCache(reader, { dir });

    await assertRejects(() => cache.root("d"), Error, "connection reset");
    // The claim under test. Without the self-eviction this rejects again with the SAME error, and
    // `builds()` stays at 1 because nothing ever called the reader a second time.
    const root = await cache.root("d");
    assert(root.startsWith(dir), `expected a tree under ${dir}, got ${root}`);
    assertEquals(builds(), 2, "the second call must rebuild, not replay the first failure");
    assertEquals(cache.stats.hits, 0, "a failed entry must not answer as a hit");
    await cache.clear();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("[broker] a failed materialisation leaves no tree behind", async () => {
  // `build` creates the directory and THEN fetches into it, so a failure part way through leaves a
  // partial tree that neither eviction nor `clear` can reach: both walk the promise, and a rejected
  // promise resolves to nothing to remove. Under the retry loop above that is one leaked directory
  // per attempt, which is a disk filling up because a disk filled up.
  const dir = await Deno.makeTempDir({ prefix: "radia-treecache-" });
  try {
    const { reader } = await flakyReader({ failArtifact: 1 });
    const cache = treeCache(reader, { dir });

    await assertRejects(() => cache.root("d"), Error, "artifact read failed");
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      [],
      "the half-materialised tree outlived the failure that produced it",
    );
    // And the digest is still usable afterwards, which is the pair of properties together.
    const root = await cache.root("d");
    assert(root.startsWith(dir));
    await cache.clear();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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
    const results = await operator.queryNewest<{ tag: string }>({ kind: "exec_result" }, 5);
    assertEquals(results[0].body.tag, "v2", "a warm cache must never serve stale code");
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
    await withSpace(async ({ operator, hostFor, agent }) => {
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
      const results = await operator.queryNewest<{ tag: string; tried: Record<string, string> }>({ kind: "exec_result" }, 5);
      assertEquals(results[0].body.tag, "py:j", "the Python entrypoint's return value is the result");

      // The escape probe AGAIN, for this backend. bwrap is safe by PRESENCE (`--unshare-all`),
      // the Deno jail by absence, so the Deno probe proves nothing here: a new runner inherits
      // the plan's rule, never its conclusion.
      const tried = results[0].body.tried;
      assertEquals(tried.net, "URLError", `a bubblewrap jail must not reach the space: ${tried.net}`);

      // …and the brokered write went through as the AGENT, exactly as it does from JavaScript.
      const notes = await operator.queryNewest<{ tag: string }>({ kind: "note", match: { tag: "from-python" } }, 5);
      assertEquals(notes[0].body.tag, "from-python");
      const perms = await operator.permissions(notes[0].runtimeMeta.createdBy) as { subject: string };
      assertEquals(perms.subject, agent);
    });
  },
});

Deno.test("[broker] an entrypoint that writes WITHOUT a newline does not break the channel", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The MCP-stdio failure, kept as a contract after the fix that made it structural. A partial
    // write immediately before a call used to prepend itself to the frame, which then no longer
    // started its line: the call was read as chatter, the jail blocked, and the run died at the
    // timeout blaming the wrong thing. Frames travel on their own pipe now, so stdout cannot reach
    // them at all. The case stays because a future transport must not reintroduce the sharing.
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
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "after-partial-write" } }, 5)).length, 1, "the brokered call must go through");
    const results = await operator.queryNewest<{ tag: string }>({ kind: "exec_result" }, 5);
    assertEquals(results[0].body.tag, "survived", "…and the result frame too");
  });
});

Deno.test("[broker] an entrypoint that floods stdout is ABSORBED, not fatal", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // This used to kill the run, because stdout carried the protocol and an unbounded flood was
    // the host's problem. It is diagnostics now: drained to a bounded tail, so a chatty entrypoint
    // costs memory that does not grow and still delivers its result.
    const host = await hostFor(`
      export default async (record, space) => {
        const enc = new TextEncoder(), line = "x".repeat(64 * 1024) + "\\n";
        for (let i = 0; i < 200; i++) await Deno.stdout.write(enc.encode(line));
        await space.put({ kind: "note", body: { tag: "after-flood" } });
        return { kind: "exec_result", body: { tag: "survived" } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "after-flood" } }, 5)).length, 1, "12MB of chatter, and the call still lands");
  });
});

Deno.test("[broker] a frame too big for the CHANNEL is refused", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The cap moved with the protocol. The pipe is the one stream the host must still buffer, so an
    // oversized frame is refused before it is parsed or performed, rather than growing until the
    // machine complains. Reached the only way jailed code can: an enormous body on a real call.
    const host = await hostFor(`
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "flood-blob", blob: "x".repeat(5 * 1024 * 1024) } });
        return { kind: "exec_result", body: { tag: "unreachable" } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["failed"], JSON.stringify(outcomes));
    assertStringIncludes((outcomes[0] as { error: string }).error, "wrote more than");
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "flood-blob" } }, 5)).length, 0, "and it never became a record");
    // The work is not lost: a flood is a failure like any other, so it nacks and can be retried.
    const env = await operator.queryEnvelopes({ state: "available", limit: 500 });
    assert(
      env.some((r) => r.record?.kind === EXEC_REQUEST),
      `the request goes back for another attempt (page held: ${JSON.stringify(env.map((r) => r.record?.kind))})`,
    );
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

Deno.test("[broker] a DRY RUN rehearses the real thing and writes nothing", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // Same entrypoint, run twice: once as a rehearsal, once for real. The rehearsal has to show
    // what the real one WOULD write, including the parts the code never said, or a reviewer
    // reading it is checking a different thing than the one that will run.
    const entry = `
      export default async (record, space) => {
        await space.put({ kind: "note", body: { tag: "dry-note" } });
        return { kind: "exec_result", body: { tag: "job:" + record.body.job } };
      };
    `;
    const host = await hostFor(entry, { stamp: { compartment: "trial" }, labels: ["file"] });

    // The tree the host would run, materialised the same way.
    const ws = await operator.queryNewest<any>({ kind: "workspace" }, 1);
    const root = await Deno.makeTempDir({ prefix: "dry-" });
    try {
      // deno-lint-ignore no-explicit-any
      await materialize(operator, ws[0].body, root);
      const record = { id: "01TESTRECORD", kind: EXEC_REQUEST, body: { job: "rehearsal" } } as unknown as RadiaRecord;

      const dry = await dryRunEntrypoint({
        root,
        entrypoint: "main.ts",
        record,
        stamp: { compartment: "trial" },
        labels: ["file"],
      });

      assertEquals(dry.result.kind, "exec_result");
      assertEquals((dry.result.body as { tag: string }).tag, "job:rehearsal");
      assertEquals(dry.proposals.length, 1);
      const p = dry.proposals[0];
      assertEquals(p.kind, "note");
      // The host's contributions, present in the rehearsal because they are the point.
      assertEquals((p.body as { compartment?: string }).compartment, "trial", "the stamp the code never wrote");
      assertEquals(p.parentIds, ["01TESTRECORD"], "the claimed record, which the code cannot omit");
      assertEquals(p.taint, ["file"], "the jail's labels, which the code cannot withhold");
      assertEquals(p.idempotencyKey, "broker:01TESTRECORD:1", "the default key: one code per record");

      // …and with a `keyScope`, the CODE's identity joins it. A host that runs varying code
      // against one record (the playground's textarea) must contribute that identity, or its
      // second run sends a different body under the same key and is refused. The dry run mirrors
      // the real performer here, so this is the same string a live write would carry.
      const scoped = await dryRunEntrypoint({
        root,
        entrypoint: "main.ts",
        record,
        stamp: { compartment: "trial" },
        labels: ["file"],
        keyScope: "sha-1234ab",
      });
      assertEquals(scoped.proposals[0].idempotencyKey, "broker:01TESTRECORD:sha-1234ab:1");

      // NOTHING was written. This is the assertion the whole feature rests on.
      assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "dry-note" } }, 10)).length, 0, "a dry run must not write");
      assertEquals((await operator.queryOldest({ kind: "exec_result", match: { tag: "job:j" } }, 10)).length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }

    // …and the real claim, for the same code, does write, with the same shape.
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
    const notes = await operator.queryNewest<{ compartment?: string }>({ kind: "note", match: { tag: "dry-note" } }, 10);
    assertEquals(notes.length, 1);
    assertEquals(notes[0].body.compartment, "trial");
  });
});

Deno.test("[broker] a dry run rehearses the transform on caller-supplied sample inputs", async () => {
  // The host materialises real inputs under the agent's authority; a dry run holds no credential,
  // so the SAMPLE comes from the caller and lands the same way (`input/<path>` in the cwd). This
  // is what lets a data-processing entrypoint be rehearsed before anyone grants it the real data.
  const root = await Deno.makeTempDir({ prefix: "radia-dry-in-" });
  try {
    await Deno.writeTextFile(
      `${root}/main.ts`,
      `export default async () => {
        const csv = await Deno.readTextFile("input/sample.csv");
        return { kind: "exec_result", body: { rows: csv.trim().split("\\n").length - 1 } };
      };\n`,
    );
    const record = { id: "01DRYINPUT", kind: EXEC_REQUEST, body: {} } as unknown as RadiaRecord;
    const dry = await dryRunEntrypoint({
      root,
      entrypoint: "main.ts",
      record,
      inputFiles: { "sample.csv": "h\n1\n2\n" },
    });
    assertEquals((dry.result.body as { rows: number }).rows, 2, "the transform ran over the sample");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("[broker] a dry run refuses reads rather than borrowing a credential", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The rehearsal has no principal of its own. Answering a query from whatever client is nearby
    // would hand jailed code that principal's reach, which is the failure the broker exists to
    // prevent, reintroduced by the thing meant to test it.
    await hostFor(`
      export default async (record, space) => {
        let err = "none";
        try { await space.query({ kind: "note" }); } catch (e) { err = e.message; }
        return { kind: "exec_result", body: { err } };
      };
    `);
    const ws = await operator.queryNewest<any>({ kind: "workspace" }, 1);
    const root = await Deno.makeTempDir({ prefix: "dry-read-" });
    try {
      // deno-lint-ignore no-explicit-any
      await materialize(operator, ws[0].body, root);
      const dry = await dryRunEntrypoint({
        root,
        entrypoint: "main.ts",
        record: { id: "01TESTRECORD", kind: EXEC_REQUEST, body: {} } as unknown as RadiaRecord,
      });
      assertStringIncludes((dry.result.body as { err: string }).err, "does not read the space");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("[broker] a brokered run writes FILES to its output tree and records to the space", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // The two halves of what a run produces, and they travel differently on purpose: coordination
    // goes through the broker as records, bytes go to the output tree as files. Neither is base64
    // in the other, which is the invariant (bytes never travel inside a record) holding at the one
    // place a jailed program could break it.
    const host = await hostFor(
      `export default async (record, space) => {
        await space.put({ kind: "note", body: { via: "broker" } });
        await Deno.writeFile("out.bin", new Uint8Array([0, 1, 2, 253, 254, 255]));
        return { kind: "exec_result", body: { tag: "both" } };
      };\n`,
      { outputWorkspace: "brokered-out" },
    );
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));

    const notes = await operator.queryNewest<{ via: string }>({ kind: "note" }, 10);
    assertEquals(notes[0].body.via, "broker");

    const out = await readWorkspace(operator, "brokered-out");
    assertEquals(out!.files.map((f) => f.path), ["out.bin"]);
    const dir = await Deno.makeTempDir({ prefix: "radia-check-" });
    try {
      await materialize(operator, out!, dir);
      // The exact bytes: 0x00 and 0xff are what a line-oriented channel would have mangled.
      assertEquals(await Deno.readFile(`${dir}/out.bin`), new Uint8Array([0, 1, 2, 253, 254, 255]));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("[broker] a put made with POSITIONAL arguments is told the signature", async () => {
  await withSpace(async ({ operator, hostFor }) => {
    // What a model actually wrote: `space.put("result", out)`. The old refusal was "put needs a
    // kind", which names the field the host wanted and not the mistake the code made, and the
    // signature is the one part of the contract that cannot be seen from inside the jail.
    const host = await hostFor(`
      export default async (record, space) => {
        try {
          await space.put("note", { tag: "positional" });
          return { kind: "exec_result", body: { tag: "ACCEPTED" } };
        } catch (e) {
          return { kind: "exec_result", body: { tag: e.message } };
        }
      };
    `);
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));
    const results = await operator.queryNewest<{ tag: string }>({ kind: "exec_result" }, 5);
    const tag = results[0].body.tag;
    assertStringIncludes(tag, "space.put({kind, body})");
    assertStringIncludes(tag, "Positional arguments");
    assertEquals((await operator.queryOldest({ kind: "note", match: { tag: "positional" } }, 5)).length, 0, "and nothing was written");
  });
});

Deno.test("[broker] a query proposal honours the pattern's own order_by", async () => {
  // The broker RELAYS a pattern written by jailed code, so `order_by` is data here, not something
  // the host chooses. A directional read cannot be combined with it (the space refuses), so a host
  // that hard-codes a direction turns every ordered query from the jail into an error. That is
  // exactly what happened when the SDK's `query(p, n)` was split into `queryOldest`/`queryNewest`
  // and this relay was rewritten mechanically: nothing here covered order_by, so nothing failed.
  await withSpace(async ({ operator, hostFor, agent }) => {
    for (const score of [3, 1, 2]) await operator.put({ kind: "ranked", body: { score } });
    await operator.grant(agent, "ranked", ["query"]);
    const host = await hostFor(`
      export default async (record, space) => {
        const top = await space.query({ kind: "ranked", orderBy: [{ path: "score", dir: "desc" }] }, 2);
        const plain = await space.query({ kind: "ranked" }, 2);
        return { kind: "exec_result", body: { tag: "ordered", top: top.map((r) => r.body.score), plain: plain.length } };
      };
    `);
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
    const body = (await operator.queryNewest({ kind: "exec_result", match: { tag: "ordered" } }, 1))[0]
      .body as { top: number[]; plain: number };
    assertEquals(body.top, [3, 2], "the jail's own order_by must decide the order");
    assertEquals(body.plain, 2, "…and a pattern without one still reads normally");
  });
});

Deno.test("[broker] the declared API is the API the shim binds, in both languages", async () => {
  // The one interface inside the jail that an author cannot discover by trying: a refused broker
  // call is invisible to the trace and to the space, so a wrong guess is silent. One measured run
  // shipped five candidate patterns and five candidate result shapes and tried each until one
  // worked (agent_docs/research-agent-sessions.md). `BROKER_API` is the answer as DATA, and this is
  // what stops it becoming a lie: the names it advertises must be the names the shim actually
  // binds, in the JS shim and in the Python one.
  const src = await Deno.readTextFile(new URL("../ts/broker.ts", import.meta.url));
  const advertised = BROKER_API.calls.map((c) => c.call.replace(/^space\.(\w+).*/, "$1"));
  assertEquals(advertised, ["query", "readOne", "put"], "the advertised call list changed shape");
  for (const name of advertised) {
    // The JS shim builds `space` as an object literal; the Python one binds the same names.
    assert(new RegExp(`\\b${name}:\\s*\\(`).test(src), `the JS shim does not bind space.${name}`);
    const py = name === "readOne" ? "read_one|readOne" : name;
    assert(new RegExp(`(${py})`).test(src), `the Python shim does not bind ${name}`);
  }
  // The PATTERN SHAPE is the part that was guessed wrong, so it is stated rather than implied.
  assertStringIncludes(BROKER_API.calls[0].description, "{kind, match}");
  assert(BROKER_API.returns?.includes("RESULT record"), "nothing says what a return value becomes");
  assert((BROKER_API.absent ?? []).length > 0, "what is NOT reachable must be stated, not omitted");
});

Deno.test("[broker] a host DECLARES what its code may call, so the API is a record like the jail", async () => {
  // WITH A NETWORK TARGET, which is what makes the declaration probed rather than asserted: the
  // space's own address, because a probe with nothing to dial cannot tell an isolated jail from an
  // offline machine. `sandbox.ts`'s own suite proves the probe CATCHES a false claim; this proves
  // the host runs it, and an empty list is the only result that may be published without a warning.
  const { id, refusedBecause } = await declareBrokerSandbox(operator, {
    name: uniq("brokered"),
    networkTarget: new URL(operator.base).host,
  });
  assertEquals(refusedBecause, [], `the jail does not hold what the record claims: ${JSON.stringify(refusedBecause)}`);
  const rec = await operator.getRecord(id);
  const body = rec!.body as { api?: typeof BROKER_API; network?: boolean; processes?: boolean };
  assertEquals(body.network, false);
  assertEquals(body.processes, false);
  // The whole point: the calls are IN the record a caller already queries to learn what running
  // code can reach, rather than in prose only a model reading this file would find.
  assertEquals(body.api?.calls.length, BROKER_API.calls.length);
  assertStringIncludes(JSON.stringify(body.api), "{kind, match}");
});

Deno.test("[broker] a traversing entrypoint is refused before any boot is written", async () => {
  // `runBrokered` takes the entrypoint verbatim, from a binding or a dry-run caller, and the same
  // guard as the unbrokered invoker's applies: module loading is not bounded by the jail's read
  // permissions, so a `..` would import code from outside the tree wherever no confiner runs.
  const record = { id: "01TRAVERSE", kind: EXEC_REQUEST, body: {} } as unknown as RadiaRecord;
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => dryRunEntrypoint({ root, entrypoint: "../evil.ts", record }),
      Error,
      "is not allowed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
