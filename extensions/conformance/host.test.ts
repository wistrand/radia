// The workspace-agent host contract (agent_docs/architecture-workspace-agents.md phase 4).
//
//   deno task extensions
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

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { BINDING, declareBinding, sandboxInvoker, WorkspaceHost } from "../ts/host.ts";
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
    const results = await operator.query({ kind: "exec_result", match: { tag: TAG } }, 10, { dir: "desc" });
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
    assertEquals((await operator.query({ kind: "exec_result", match: { tag: TAG } }, 10)).length, 0, "nothing may be produced from mismatched code");
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
    const results = await operator.query({ kind: "exec_result" }, 10, { dir: "desc" });
    assertEquals((results[0].body as { tag: string }).tag, "ran:seven", "the entrypoint's return value is the result");
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
    const results = await operator.query({ kind: "exec_result" }, 10, { dir: "desc" });
    assertEquals((results[0].body as { tag: string }).tag, "refused");
    // And the tree it ran from is untouched on disk, not merely un-rewritten in the space.
    assertEquals((await readWorkspace(operator, "vandal"))!.treeDigest, digest);
  });
});

Deno.test("[host] a declared input is materialised into the cwd, excluded from capture, and a data parent of the result", async () => {
  await withSpace(async ({ operator, credential }) => {
    // The plan's one substrate-tier prerequisite (plan-analysis-workspace-agents.md gap 1): broker
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

    const results = await operator.query({ kind: "exec_result", match: { tag: TAG } }, 10);
    assertEquals(results.length, 1);
    assertEquals((results[0].body as { got: string }).got, "h\n1\n2\n3\n", "the artifact's bytes, read from input/data.csv");
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
    const [r] = await operator.query({ kind: "exec_result", match: { tag: TAG } }, 10);
    assertEquals((r.body as { got: string }).got, "payload-bytes");
    assertEquals((r.body as { wrote: boolean }).wrote, false, "an inputs-only run holds no writable path");
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
