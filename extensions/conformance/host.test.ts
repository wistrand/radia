// The workspace-agent host contract (agent_docs/architecture-workspace-agents.md phase 4).
//
//   deno task test:extensions
//
// The question this phase exists to answer is whether a GENERIC host can run someone else's code
// as that someone, so the cases are about IDENTITY and about the two locks, not about execution:
//
//   - everything the work produces is attributed to the hosted AGENT, never to the host, even
//     when one host serves several agents;
//   - a binding whose agent holds no matching grant claims nothing;
//   - a granted digest with no binding runs nothing;
//   - a binding and a grant that DISAGREE about the digest run nothing, which is the case the
//     plan did not predict and building it found.
//
// A stub invoker carries the identity cases, because how the code runs is independent of whose
// identity it runs under and a real jail per case would buy nothing. The last test uses the real
// one, so the default is not a promise.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { BINDING, declareBinding, type Outcome, sandboxInvoker, WorkspaceHost } from "../ts/host.ts";
import { brokeredInvoker } from "../ts/broker.ts";
import { declareExecRequest, EXEC_REQUEST, promote } from "../ts/promotion.ts";
import { materialize, readWorkspace, writeWorkspace } from "../ts/workspace.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7821;
const url = `http://127.0.0.1:${PORT}`;
const D1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const D2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

interface Ctx {
  operator: RadiaClient;
  /** A definition token for `agent`, which is all a host is ever given. */
  credential: (agent: string) => Promise<string>;
}

const operatorClient = await bootSpace(PORT);
await declareExecRequest(operatorClient);
await declareBinding(operatorClient);
await operatorClient.registerKind({ kind: "exec_result", indexedPaths: [{ path: "tag", type: "keyword" }] });
// Extends the reserved declaration ({digest, mediaType}); reserved kinds may grow, never shrink.
await operatorClient.registerKind({
  kind: "artifact",
  indexedPaths: [{ path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }, { path: "owner", type: "keyword" }],
  claimable: false,
});
await operatorClient.registerKind({
  kind: "workspace",
  indexedPaths: [{ path: "name", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "treeDigest", type: "keyword" }, { path: "basedOn", type: "keyword" }],
  claimable: false,
});

async function withSpace<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return await fn({
    operator: operatorClient,
    credential: async (agent) => (await operatorClient.createAgentDefinition(agent, [])).definitionToken,
  });
}

const bind = (operator: RadiaClient, agent: string, digest: string, entrypoint = "main.ts") =>
  operator.put({ kind: BINDING, body: { agent, workspaceDigest: digest, entrypoint } });

/** The stub: proves the host wired the claim to the entrypoint, and nothing about execution. */
const echo = (tag: string) => () => Promise.resolve({ kind: "exec_result", body: { tag } });

Deno.test("[host] one host, several agents, and everything is attributed to the AGENT", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Two agents hosted by ONE process. If the host claimed as itself, both would be
    // indistinguishable in the log and it would need the union of their grants.
    const TIER = uniq("prod"), TAG = uniq("done");
    const credentials = { "agent:alpha": await credential("agent:alpha"), "agent:beta": await credential("agent:beta") };
    await promote(operator, {
      digest: D1,
      tier: TIER,
      pins: [{ principal: "agent:alpha", operations: ["take"] }, { principal: "agent:beta", operations: ["take"] }],
    });
    await operator.grant("agent:alpha", "exec_result", ["put"]);
    await operator.grant("agent:beta", "exec_result", ["put"]);
    await bind(operator, "agent:alpha", D1);
    await bind(operator, "agent:beta", D1);
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "one" } });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "two" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo(TAG) });
    const outcomes = await host.tick();
    assertEquals(outcomes.filter((o) => o.status === "acked").length, 2, "both hosted agents claimed and settled");

    // The property: the RESULT is authored by the agent's run, and its delegation chain names the
    // agent. Nothing here mentions the host, which holds no identity of its own in the space.
    const results = await operator.queryNewest({ kind: "exec_result", match: { tag: TAG } }, 10);
    assertEquals(results.length, 2);
    const authors = await Promise.all(results.map(async (r) => {
      const perms = await operator.permissions(r.runtimeMeta.createdBy) as { subject: string };
      return perms.subject;
    }));
    assertEquals([...authors].sort(), ["agent:alpha", "agent:beta"], "results are authored by the AGENTS, not by one host principal");
    for (const r of results) {
      const chain = r.runtimeMeta.delegationContext?.chain ?? [];
      assert(chain.length === 1 && chain[0].startsWith("agent:"), `delegation must name the agent, got ${JSON.stringify(chain)}`);
    }
  });
});

Deno.test("[host] a binding with no matching grant claims nothing, and says so", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Lock one present, lock two absent: the agent is bound to code and holds no grant. The host
    // must report the refusal rather than dying, because an inert pairing is the design working.
    const TIER = uniq("prod");
    const credentials = { "agent:ungranted": await credential("agent:ungranted") };
    await bind(operator, "agent:ungranted", D1);
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo("nope") });
    assertEquals(await host.tick(), [{ agent: "agent:ungranted", status: "refused", reason: "forbidden" }]);
    // The work is untouched: still available for whoever is actually allowed to claim it.
    const left = await operator.queryEnvelopes({ state: "available", limit: 50 });
    assert(left.some((r) => r.record?.kind === EXEC_REQUEST), "the request must still be claimable");
  });
});

Deno.test("[host] a granted digest with no binding runs nothing", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Lock two present, lock one absent. The agent could claim, but nothing tells the host what
    // code to run, so the host does not act for it at all.
    const TIER = uniq("prod");
    const credentials = { "agent:unbound": await credential("agent:unbound") };
    await promote(operator, { digest: D1, tier: TIER, pins: [{ principal: "agent:unbound", operations: ["take"] }] });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo("nope") });
    assertEquals(await host.tick(), [], "no binding, no work");

    // …and a binding written later makes exactly the same space run. Defining an agent is a put.
    await bind(operator, "agent:unbound", D1);
    await operator.grant("agent:unbound", "exec_result", ["put"]);
    const after = await host.tick();
    assertEquals(after.map((o) => o.status), ["acked"]);
  });
});

Deno.test("[host] a binding and a grant that DISAGREE about the digest run nothing", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Both locks present, pointing at different code. The plan predicted the two inert cases and
    // not this one: the agent may claim D1's work while the binding says run D2, so executing
    // would run code the requester never asked for. The host refuses and releases the claim.
    const TIER = uniq("prod"), TAG = uniq("must-not-run");
    const credentials = { "agent:drifted": await credential("agent:drifted") };
    await promote(operator, { digest: D1, tier: TIER, pins: [{ principal: "agent:drifted", operations: ["take"] }] });
    await bind(operator, "agent:drifted", D2);
    await operator.grant("agent:drifted", "exec_result", ["put"]);
    const { id } = await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo(TAG) });
    assertEquals(await host.tick(), [{ agent: "agent:drifted", status: "digest_mismatch", wanted: D1, bound: D2, recordId: id }]);
    assertEquals((await operator.queryOldest({ kind: "exec_result", match: { tag: TAG } }, 10)).length, 0, "nothing may be produced from mismatched code");
    // Released, not consumed and not dead-lettered: a correctly bound host can still take it.
    const env = await operator.queryEnvelopes({ state: "available", limit: 50 });
    assert(env.some((r) => r.record?.id === id), "the claim must go back");
  });
});

Deno.test("[host] the default invoker runs the workspace's entrypoint in the jail", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The default is not a promise: a real tree, materialised, executed read-only with no network,
    // and its return value acked by the agent.
    const ws = await writeWorkspace(operator, {
      name: "adder",
      owner: "human:alice",
      files: {
        "main.ts": "export default (record) => ({ kind: 'exec_result', body: { tag: 'ran:' + record.body.job } });\n",
      },
    });
    const digest = ws.treeDigest;
    const credentials = { "agent:runner": await credential("agent:runner") };
    await promote(operator, { digest, tier: "prod", pins: [{ principal: "agent:runner", operations: ["take"] }] });
    await operator.grant("agent:runner", "exec_result", ["put"]);
    await bind(operator, "agent:runner", digest);
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: "prod", job: "seven" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const outcomes = await host.tick();
    assertEquals(outcomes.map((o) => o.status), ["acked"], JSON.stringify(outcomes));
    const results = await operator.queryNewest<{ tag: string }>({ kind: "exec_result" }, 10);
    assertEquals(results[0].body.tag, "ran:seven", "the entrypoint's return value is the result");
  });
});

Deno.test("[host] a run's OUTPUT FILES land in a workspace, binary included", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Why files rather than a payload in the result body: bytes never travel inside a record, and a
    // file is binary, named, versioned and erasable for free. The entrypoint writes to its CWD and
    // needs to know nothing about workspaces.
    const ws = await writeWorkspace(operator, {
      name: "plotter",
      owner: "human:alice",
      files: {
        "main.ts": `export default async (record) => {
          await Deno.writeFile("chart.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
          await Deno.writeTextFile("notes.txt", "job " + record.body.job);
          return { kind: "exec_result", body: { tag: "wrote" } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { "agent:plotter": await credential("agent:plotter") };
    await promote(operator, { digest, tier: "prod", pins: [{ principal: "agent:plotter", operations: ["take"] }] });
    await operator.grant("agent:plotter", "exec_result", ["put"]);
    // `query` as well as `put`: capturing a version means finding the one it is based on.
    await operator.grant("agent:plotter", "workspace", ["put", "query"]);
    await operator.grant("agent:plotter", "artifact", ["put", "query"]);
    await operator.put({
      kind: BINDING,
      body: { agent: "agent:plotter", workspaceDigest: digest, entrypoint: "main.ts", outputWorkspace: "plotter-out" },
    });
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: "prod", job: "nine" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));
    const outputId = (outcome as { outputId?: string }).outputId;
    assert(outputId, "the acked outcome names the version it produced");

    const out = await readWorkspace(operator, "plotter-out");
    assertEquals(out?.id, outputId);
    assertEquals(out?.files.map((f) => f.path).sort(), ["chart.png", "notes.txt"]);
    // The BYTES, not just the name: an output path that reads back as something else is the whole
    // failure this feature exists to avoid.
    const dir = await Deno.makeTempDir({ prefix: "radia-check-" });
    try {
      await materialize(operator, out!, dir);
      assertEquals(await Deno.readFile(`${dir}/chart.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      assertEquals(await Deno.readTextFile(`${dir}/notes.txt`), "job nine");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
    // Lineage, so "what did this request produce" is a query and not a naming convention.
    const kids = await operator.getChildren(req.id);
    assert(kids.some((k) => k.id === outputId), "the output version hangs off the claimed request");
    // Attribution: the AGENT wrote it, not the host.
    assertEquals(out!.owner, "agent:plotter");
  });
});

Deno.test("[host] the CODE tree stays read-only, even with an output tree open", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The separation is the point of a second tree: the code tree is shared between concurrent
    // claims and pinned by the digest promotion rotates, so a run that could write into it would
    // race its neighbours and change the identity the pin refers to.
    const ws = await writeWorkspace(operator, {
      name: "vandal",
      owner: "human:alice",
      files: {
        "main.ts": `export default async () => {
          const here = new URL(".", import.meta.url).pathname;
          let reached = false;
          try { await Deno.writeTextFile(here + "main.ts", "OWNED"); reached = true; } catch { /* expected */ }
          return { kind: "exec_result", body: { tag: reached ? "WROTE-ITS-OWN-CODE" : "refused" } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { "agent:vandal": await credential("agent:vandal") };
    await promote(operator, { digest, tier: "prod", pins: [{ principal: "agent:vandal", operations: ["take"] }] });
    await operator.grant("agent:vandal", "exec_result", ["put"]);
    // `query` as well as `put`: capturing a version means finding the one it is based on.
    await operator.grant("agent:vandal", "workspace", ["put", "query"]);
    await operator.grant("agent:vandal", "artifact", ["put", "query"]);
    await operator.put({
      kind: BINDING,
      body: { agent: "agent:vandal", workspaceDigest: digest, entrypoint: "main.ts", outputWorkspace: "vandal-out" },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: "prod", job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));
    const results = await operator.queryNewest<{ tag: string }>({ kind: "exec_result" }, 10);
    assertEquals(results[0].body.tag, "refused");
    // And the tree it ran from is untouched on disk, not merely un-rewritten in the space.
    assertEquals((await readWorkspace(operator, "vandal"))!.treeDigest, digest);
  });
});

Deno.test("[host] a declared input is materialised into the cwd, excluded from capture, and a data parent of the result", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The plan's one extension-tier prerequisite (architecture-analysis-workspace-agents.md gap 1): broker
    // frames carry no bytes and the jail has no net, so the HOST fetches the claimed record's
    // declared input under the AGENT's authority and lays it at `input/<path>` in the cwd. Three
    // properties in one run: the bytes arrive, capture does not re-store them as output, and the
    // artifact's classification flows into the result through lineage the code never mentions.
    const AGENT = "agent:" + uniq("stage"), TIER = uniq("prod"), TAG = uniq("counted");
    const art = await operator.putArtifact(new TextEncoder().encode("h\n1\n2\n3\n"), {
      mediaType: "text/csv",
      taint: ["file"],
    });
    const ws = await writeWorkspace(operator, {
      name: uniq("counter"),
      owner: "human:alice",
      files: {
        "main.ts": `export default async (record) => {
          const csv = await Deno.readTextFile("input/data.csv");
          await Deno.writeTextFile("rows.txt", String(csv.trim().split("\\n").length - 1));
          return { kind: "exec_result", body: { tag: ${JSON.stringify(TAG)}, got: csv } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { [AGENT]: await credential(AGENT) };
    await promote(operator, { digest, tier: TIER, pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.grant(AGENT, "exec_result", ["put"]);
    await operator.grant(AGENT, "workspace", ["put", "query"]);
    // `read_one` is what the input fetch needs, and it is the AGENT's grant that decides: the
    // host's reader never touches the bytes.
    await operator.grant(AGENT, "artifact", ["put", "query", "read_one"]);
    const OUT = uniq("counter-out");
    await operator.put({
      kind: BINDING,
      body: {
        agent: AGENT,
        workspaceDigest: digest,
        entrypoint: "main.ts",
        outputWorkspace: OUT,
        inputs: [{ field: "inputArtifact", path: "data.csv" }],
      },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: TIER, inputArtifact: art.id } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));
    const resultId = (outcome as { resultId?: string }).resultId!;

    const results = await operator.queryOldest<{ got: string }>({ kind: "exec_result", match: { tag: TAG } }, 10);
    assertEquals(results.length, 1);
    assertEquals(results[0].body.got, "h\n1\n2\n3\n", "the artifact's bytes, read from input/data.csv");
    // Capture excluded `input/`: the output version holds the run's file and never the request's data.
    const out = await readWorkspace(operator, OUT);
    assertEquals(out?.files.map((f) => f.path), ["rows.txt"], "the input must not be re-stored as output");
    // The artifact is a DATA PARENT of the result, so its classification flowed without the code
    // (or the entrypoint's author) saying so.
    assert(results[0].runtimeMeta.parentIds.includes(art.id), "the input artifact must be a parent of the result");
    assert(results[0].runtimeMeta.taint.includes("file"), "the input's classification must flow into the result");
    assertEquals(results[0].id, resultId);
  });
});

Deno.test("[host] outputMeta stamps captured artifacts from the claimed record", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The output belongs to the request that asked for it, not to the agent that computed it: a
    // person's {owner}-scoped artifact grant must reach bytes a worker produced FOR them. The stamp
    // is host-side, from the claimed record, so the code cannot claim the work was for someone else.
    const AGENT = "agent:" + uniq("stamper"), TIER = uniq("prod"), PERSON = "human:" + uniq("carol");
    const ws = await writeWorkspace(operator, {
      name: uniq("stamper"),
      owner: "human:alice",
      files: {
        "main.ts": `export default async (record) => {
          await Deno.writeTextFile("result.txt", "for " + record.body.owner);
          return { kind: "exec_result", body: { tag: "stamped" } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { [AGENT]: await credential(AGENT) };
    await promote(operator, { digest, tier: TIER, pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.grant(AGENT, "exec_result", ["put"]);
    await operator.grant(AGENT, "workspace", ["put", "query"]);
    await operator.grant(AGENT, "artifact", ["put", "query"]);
    const OUT = uniq("stamper-out");
    await operator.put({
      kind: BINDING,
      body: { agent: AGENT, workspaceDigest: digest, entrypoint: "main.ts", outputWorkspace: OUT, outputMeta: ["owner"] },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: TIER, owner: PERSON } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));

    // The captured file's artifact carries the REQUEST's owner, winning over the capture default
    // (the agent), so an {owner}-scoped grant reaches it.
    const found = await operator.queryNewest<{ workspace?: string }>({ kind: "artifact", match: { owner: PERSON } }, 10);
    const out = found.find((r) => r.body.workspace === OUT);
    assert(out, `no captured artifact carries owner=${PERSON}: ${JSON.stringify(found.map((r) => r.body))}`);
  });
});

Deno.test("[host] inputs without an output tree get a read-only cwd", async () => {
  await withSpace(async ({ operator, credential }) => {
    // A stage that answers in its result body needs bytes and no writable path. The input dir is
    // the cwd so `input/<field>` resolves the same as with an output tree, and it stays read-only:
    // no output workspace means no write capability, inputs or not.
    const AGENT = "agent:" + uniq("reader"), TIER = uniq("prod"), TAG = uniq("readonly");
    const art = await operator.putArtifact(new TextEncoder().encode("payload-bytes"), {});
    const ws = await writeWorkspace(operator, {
      name: uniq("readonly"),
      owner: "human:alice",
      files: {
        "main.ts": `export default async () => {
          const got = await Deno.readTextFile("input/src");
          let wrote = false;
          try { await Deno.writeTextFile("leak.txt", "x"); wrote = true; } catch { /* expected */ }
          return { kind: "exec_result", body: { tag: ${JSON.stringify(TAG)}, got, wrote } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { [AGENT]: await credential(AGENT) };
    await promote(operator, { digest, tier: TIER, pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.grant(AGENT, "exec_result", ["put"]);
    await operator.grant(AGENT, "artifact", ["read_one"]);
    await operator.put({
      kind: BINDING,
      // No `path`: the field name is the default, so the file lands at input/src.
      body: { agent: AGENT, workspaceDigest: digest, entrypoint: "main.ts", inputs: [{ field: "src" }] },
    });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: TIER, src: art.id } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "acked", JSON.stringify(outcome));
    const [r] = await operator.queryOldest<{ got: string; wrote: boolean }>({ kind: "exec_result", match: { tag: TAG } }, 10);
    assertEquals(r.body.got, "payload-bytes");
    assertEquals(r.body.wrote, false, "an inputs-only run holds no writable path");
    assert(r.runtimeMeta.parentIds.includes(art.id), "lineage holds on this posture too");
  });
});

Deno.test("[host] a request missing its declared input field fails, and the work goes back", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The binding declares what the code needs; a request that does not carry it cannot run. The
    // failure is an attempt (nack), not a loss, and the error names the field so the requester's
    // bug reads as the requester's bug.
    const AGENT = "agent:" + uniq("starved"), TIER = uniq("prod");
    const credentials = { [AGENT]: await credential(AGENT) };
    await promote(operator, { digest: D1, tier: TIER, pins: [{ principal: AGENT, operations: ["take"] }] });
    await operator.grant(AGENT, "exec_result", ["put"]);
    await operator.grant(AGENT, "artifact", ["read_one"]);
    await operator.put({
      kind: BINDING,
      body: { agent: AGENT, workspaceDigest: D1, entrypoint: "main.ts", inputs: [{ field: "inputArtifact" }] },
    });
    const { id } = await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo("must-not-run") });
    const [outcome] = await host.tick();
    assertEquals(outcome.status, "failed", JSON.stringify(outcome));
    assert((outcome as { error: string }).error.includes("inputArtifact"), "the error must name the missing field");
    assertEquals((outcome as { recordId: string }).recordId, id);
  });
});

Deno.test("[host] each version is THAT run's outputs, and a run that writes nothing makes none", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Replace, not accumulate: the directory starts empty every run, so version N answers "what did
    // run N produce" and the chain carries the history. An accumulating tree would answer neither
    // question well, and nothing prunes it.
    const ws = await writeWorkspace(operator, {
      name: "stepper",
      owner: "human:alice",
      files: {
        "main.ts": `export default async (record) => {
          const job = record.body.job;
          if (job !== "none") await Deno.writeTextFile(job + ".txt", job);
          return { kind: "exec_result", body: { tag: job } };
        };\n`,
      },
    });
    const digest = ws.treeDigest;
    const credentials = { "agent:stepper": await credential("agent:stepper") };
    await promote(operator, { digest, tier: "prod", pins: [{ principal: "agent:stepper", operations: ["take"] }] });
    await operator.grant("agent:stepper", "exec_result", ["put"]);
    await operator.grant("agent:stepper", "workspace", ["put", "query"]);
    await operator.grant("agent:stepper", "artifact", ["put", "query"]);
    await operator.put({
      kind: BINDING,
      body: { agent: "agent:stepper", workspaceDigest: digest, entrypoint: "main.ts", outputWorkspace: "stepper-out" },
    });
    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });

    const run = async (job: string) => {
      await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier: "prod", job } });
      const [o] = await host.tick();
      assertEquals(o.status, "acked", JSON.stringify(o));
      return o as { outputId?: string };
    };

    const first = await run("alpha");
    assertEquals((await readWorkspace(operator, "stepper-out"))!.files.map((f) => f.path), ["alpha.txt"]);
    const second = await run("beta");
    const after = await readWorkspace(operator, "stepper-out");
    assertEquals(after!.files.map((f) => f.path), ["beta.txt"], "alpha's output is history, not content");
    assertEquals(after!.basedOn, first.outputId, "and the chain still reaches it");

    const third = await run("none");
    assertEquals(third.outputId, undefined, "no files written, so no version and no empty record");
    assertEquals((await readWorkspace(operator, "stepper-out"))!.id, second.outputId);
  });
});

Deno.test("[host] a refusal a retry cannot fix is reported as permanent and not claimed again", async () => {
  await withSpace(async ({ operator, credential }) => {
    // MEASURED, and the reason this exists: a result body outside the agent's put grant was
    // re-claimed six times over thirty seconds and then dead-lettered, with the cause only ever in
    // the host's stderr, so the deploy step that submitted it timed out with nothing to show
    // (agent_docs/research-agent-sessions.md). A body and a grant are both fixed at the moment of
    // the refusal; the retry the runtime offers cannot change either.
    // A kind and an agent NOBODY ELSE HERE touches: the space is shared between these cases and
    // grants are additive, so a sibling granting `exec_result: put` to `agent:runner` would hand
    // this test the success it exists to rule out.
    const kind = uniq("refused_result").replace(/[^a-z_0-9]/g, "_");
    const agent = uniq("agent:refuser");
    await operator.registerKind({ kind, indexedPaths: [{ path: "tag", type: "keyword" }] });
    const digest = (await writeWorkspace(operator, {
      name: uniq("refused"),
      owner: "human:alice",
      files: { "main.ts": `export default () => ({ kind: ${JSON.stringify(kind)}, body: { tag: 'x' } });\n` },
    })).treeDigest;
    const credentials = { [agent]: await credential(agent) };
    const tier = uniq("prod");
    await promote(operator, { digest, tier, pins: [{ principal: agent, operations: ["take"] }] });
    // Deliberately NO put grant on that kind: the entrypoint runs and the ack is refused.
    await bind(operator, agent, digest);
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    // BY RECORD ID, because the space is shared with the other cases here and a tick claims
    // whatever `exec_request` is available: an assertion over the whole outcome list would pass or
    // fail on somebody else's leftovers.
    const mine = (os: Outcome[]) => os.filter((o) => (o as { recordId?: string }).recordId === req.id);
    let first: Outcome[] = [];
    for (let i = 0; i < 5 && first.length === 0; i++) first = mine(await host.tick());
    assertEquals(first.map((o) => o.status), ["failed"], JSON.stringify(first));
    assertEquals((first[0] as { permanent?: true }).permanent, true, "an authorization refusal is permanent");

    // The SECOND tick is the point: the record is claimable again, and this host releases it rather
    // than spending another of its attempts on the same answer.
    const second = mine(await host.tick());
    assertEquals(second, [], `a permanently refused record must not be re-run: ${JSON.stringify(second)}`);
    const state = await operator.getRecord(req.id);
    assert(state, "the request must still exist rather than having been dead-lettered by the retries");
  });
});

Deno.test("[host] an output tree the host cannot label refuses once, and says whose record it is", async () => {
  await withSpace(async ({ operator, credential }) => {
    // `auditCompartment` reports an UNSCOPED `workspace` grant as a door out of a compartment, so
    // somebody will scope one. This is what happens then, and it is worth a case because the
    // refusal names a `put` grant while the code it would send you to never writes a workspace and,
    // brokered, could not. Scoped by `owner` because the kind declares that path here; a
    // compartment label is the same refusal under the same rule.
    const agent = uniq("agent:unlabelled");
    const digest = (await writeWorkspace(operator, {
      name: uniq("outrefused"),
      owner: "human:alice",
      files: { "main.ts": `export default () => ({ kind: "exec_result", body: { tag: "x" } });\n` },
    })).treeDigest;
    const credentials = { [agent]: await credential(agent) };
    const tier = uniq("prod");
    await promote(operator, { digest, tier, pins: [{ principal: agent, operations: ["take"] }] });
    await operator.grant(agent, "exec_result", ["put"]);
    // The whole setup: a workspace grant this agent's OWN output tree falls outside of.
    await operator.grant(agent, "workspace", ["put", "query"], { owner: "human:alice" });
    const out = uniq("out-tree");
    await operator.put({ kind: BINDING, body: { agent, workspaceDigest: digest, entrypoint: "main.ts", outputWorkspace: out } });
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const mine = (os: Outcome[]) => os.filter((o) => (o as { recordId?: string }).recordId === req.id);
    let first: Outcome[] = [];
    for (let i = 0; i < 5 && first.length === 0; i++) first = mine(await host.tick());
    assertEquals(first.map((o) => o.status), ["failed"], JSON.stringify(first));
    // PERMANENCE FIRST. The explanation is appended to the refusal in place precisely so `status`
    // survives it: a rethrown plain Error reads as retryable and spends the attempt budget on an
    // answer that cannot change.
    assertEquals((first[0] as { permanent?: true }).permanent, true, "a scope refusal must stay permanent");
    const error = (first[0] as { error: string }).error;
    assertStringIncludes(error, "outside the pattern scope");
    assertStringIncludes(error, out);
    assertStringIncludes(error, "not your code");
  });
});

Deno.test("[host] code reaches the space only when its BINDING asked to be brokered", async () => {
  await withSpace(async ({ operator, credential }) => {
    // LEAST PRIVILEGE FOR MODEL-WRITTEN CODE, and the inversion of what used to happen: the
    // channel was on for every hosted agent, bounded only by that agent's grants, which is the
    // same shape as an unscoped artifact grant being a door out of a compartment. Measured before
    // inverting it: the only production consumer never called `space` at all.
    //
    // The entrypoint REPORTS what it was handed rather than trying to use it, so the assertion is
    // about the second argument existing and not about any particular call succeeding.
    const kind = uniq("reach_result").replace(/[^a-z_0-9]/g, "_");
    await operator.registerKind({ kind, indexedPaths: [{ path: "tag", type: "keyword" }] });
    const digest = (await writeWorkspace(operator, {
      name: uniq("reach"),
      owner: "human:alice",
      files: {
        // TOUCHES a property rather than testing the shape: the stand-in an unasked binding gets is
        // an object too, and answers every property with the instruction. Presence is not the
        // question; usability is.
        "main.ts": `export default (record, space) => { let tag = "no-space"; ` +
          `try { if (typeof space.query === "function") tag = "has-space"; } catch { tag = "no-space"; } ` +
          `return { kind: ${JSON.stringify(kind)}, body: { tag } }; };\n`,
      },
    })).treeDigest;

    const run = async (agent: string, brokered: boolean) => {
      const tier = uniq("prod");
      await promote(operator, { digest, tier, pins: [{ principal: agent, operations: ["take"] }] });
      await operator.grant(agent, kind, ["put"]);
      await operator.put({ kind: BINDING, body: { agent, workspaceDigest: digest, entrypoint: "main.ts", ...(brokered ? { brokered } : {}) } });
      const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier } });
      // The dispatch `radia host` performs, stated here so the contract is the BEHAVIOUR rather
      // than one surface's flag parsing.
      const plain = sandboxInvoker(operator), broker = brokeredInvoker(operator);
      const host = new WorkspaceHost({
        base: url,
        credentials: { [agent]: await credential(agent) },
        reader: operator,
        invoke: (ctx) => (ctx.binding.brokered ? broker : plain)(ctx),
      });
      for (let i = 0; i < 5; i++) {
        const mine = (await host.tick()).filter((o) => (o as { recordId?: string }).recordId === req.id);
        if (mine.length) {
          assertEquals(mine[0].status, "acked", JSON.stringify(mine));
          break;
        }
      }
      return (await operator.queryNewest<{ tag: string }>({ kind }, 1))[0].body.tag;
    };

    assertEquals(await run(uniq("agent:plain"), false), "no-space", "an unasked binding must get no channel");
    // …and the thing it gets instead SAYS SO. Code written before space access became opt-in calls
    // `space.query(...)`, and "Cannot read properties of undefined" names neither the cause nor the
    // fix, which is the whole failure mode of a silent default change.
    const explainer = uniq("agent:explainer");
    const tier = uniq("prod");
    const bad = (await writeWorkspace(operator, {
      name: uniq("legacy"),
      owner: "human:alice",
      files: { "main.ts": `export default async (record, space) => ({ kind: ${JSON.stringify(kind)}, body: { tag: String(await space.query({})) } });\n` },
    })).treeDigest;
    await promote(operator, { digest: bad, tier, pins: [{ principal: explainer, operations: ["take"] }] });
    await operator.grant(explainer, kind, ["put"]);
    await operator.put({ kind: BINDING, body: { agent: explainer, workspaceDigest: bad, entrypoint: "main.ts" } });
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: bad, tier } });
    const host = new WorkspaceHost({
      base: url,
      credentials: { [explainer]: await credential(explainer) },
      reader: operator,
      invoke: sandboxInvoker(operator),
    });
    let failure = "";
    for (let i = 0; i < 5 && !failure; i++) {
      const mine = (await host.tick()).filter((o) => (o as { recordId?: string }).recordId === req.id);
      if (mine.length) failure = (mine[0] as { error?: string }).error ?? "";
    }
    assertStringIncludes(failure, "not brokered");
    assertStringIncludes(failure, "--brokered");
    assertEquals(await run(uniq("agent:asked"), true), "has-space", "asking is what opens it");
  });
});

Deno.test("[host] the RESULT body carries the binding's stamp, so a compartment is not the code's to remember", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The path everything uses, and the one that was unstamped: a brokered `space.put` got the
    // host's fields and the RETURNED value did not, so a program that omitted the compartment had
    // every ack refused as outside the put grant's pattern, retried, and dead-lettered after the
    // code had finished, where no author could see it (agent_docs/research-agent-sessions.md).
    const kind = uniq("stamped_result").replace(/[^a-z_0-9]/g, "_");
    await operator.registerKind({
      kind,
      indexedPaths: [{ path: "tag", type: "keyword" }, { path: "team", type: "keyword" }],
    });
    const agent = uniq("agent:stamper"), tier = uniq("prod");
    const digest = (await writeWorkspace(operator, {
      name: uniq("stamping"),
      owner: "human:alice",
      // Returns NO `team`: the whole point is that the code does not know its compartment.
      files: { "main.ts": `export default () => ({ kind: ${JSON.stringify(kind)}, body: { tag: "x" } });\n` },
    })).treeDigest;
    await promote(operator, { digest, tier, pins: [{ principal: agent, operations: ["take"] }] });
    // The grant is PATTERN-SCOPED, so an unstamped body is genuinely refused rather than merely
    // missing a field: without the stamp this case fails as the real one did.
    await operator.grant(agent, kind, ["put"], { team: "alpha" });
    await operator.put({
      kind: BINDING,
      body: { agent, workspaceDigest: digest, entrypoint: "main.ts", outputMeta: ["team"] },
    });
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: digest, tier, team: "alpha" } });

    const host = new WorkspaceHost({
      base: url,
      credentials: { [agent]: await credential(agent) },
      reader: operator,
      invoke: sandboxInvoker(operator),
    });
    let done: Outcome[] = [];
    for (let i = 0; i < 5 && done.length === 0; i++) {
      done = (await host.tick()).filter((o) => (o as { recordId?: string }).recordId === req.id);
    }
    assertEquals(done.map((o) => o.status), ["acked"], JSON.stringify(done));
    const result = (await operator.queryNewest<{ tag: string; team?: string }>({ kind }, 1))[0];
    assertEquals(result.body.team, "alpha", "the host stamps what the binding declared, from the claimed record");
  });
});

Deno.test("[host] a binding whose entrypoint traverses out of the tree is refused, before materialisation", async () => {
  await withSpace(async ({ operator, credential }) => {
    // A binding's entrypoint never meets `validateEntrypoint` (that runs on workspace write
    // paths, for the manifest's default), and module loading is not bounded by the jail's read
    // permissions, so the invoker must refuse it by name. The digest has NO manifest on purpose:
    // failing with "no workspace manifest" instead of this message means the check ran after the
    // materialisation it exists to precede.
    const TIER = uniq("prod");
    const credentials = { "agent:traverser": await credential("agent:traverser") };
    await promote(operator, { digest: D1, tier: TIER, pins: [{ principal: "agent:traverser", operations: ["take"] }] });
    await bind(operator, "agent:traverser", D1, "../evil.ts");
    const req = await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: TIER, job: "escape" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: sandboxInvoker(operator) });
    const outcomes = (await host.tick()).filter((o) => (o as { recordId?: string }).recordId === req.id);
    assertEquals(outcomes.map((o) => o.status), ["failed"], JSON.stringify(outcomes));
    assertStringIncludes((outcomes[0] as { error?: string }).error ?? "", "is not allowed");
  });
});
