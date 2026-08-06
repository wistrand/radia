// The workspace-agent host contract (agent_docs/plan-workspace-agents.md phase 4).
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
import { operatorToken } from "../../examples/operator.ts";
import { BINDING, declareBinding, sandboxInvoker, WorkspaceHost } from "../ts/host.ts";
import { declareExecRequest, EXEC_REQUEST, promote } from "../ts/promotion.ts";
import { writeWorkspace } from "../ts/workspace.ts";

const PORT = 7821;
const url = `http://127.0.0.1:${PORT}`;
const D1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const D2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

interface Ctx {
  operator: RadiaClient;
  /** A definition token for `agent`, which is all a host is ever given. */
  credential: (agent: string) => Promise<string>;
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
  await operator.registerKind({ kind: "exec_result", indexedPaths: [{ path: "tag", type: "keyword" }] });
  await operator.registerKind({
    kind: "workspace",
    indexedPaths: [{ path: "name", type: "keyword" }, { path: "owner", type: "keyword" }, { path: "treeDigest", type: "keyword" }, { path: "basedOn", type: "keyword" }],
    claimable: false,
  });
  try {
    return await fn({
      operator,
      credential: async (agent) => (await operator.createAgentDefinition(agent, [])).definitionToken,
    });
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
}

const bind = (operator: RadiaClient, agent: string, digest: string, entrypoint = "main.ts") =>
  operator.put({ kind: BINDING, body: { agent, workspaceDigest: digest, entrypoint } });

/** The stub: proves the host wired the claim to the entrypoint, and nothing about execution. */
const echo = (tag: string) => () => Promise.resolve({ kind: "exec_result", body: { tag } });

Deno.test("[host] one host, several agents, and everything is attributed to the AGENT", async () => {
  await withSpace(async ({ operator, credential }) => {
    // Two agents hosted by ONE process. If the host claimed as itself, both would be
    // indistinguishable in the log and it would need the union of their grants.
    const credentials = { "agent:alpha": await credential("agent:alpha"), "agent:beta": await credential("agent:beta") };
    await promote(operator, {
      digest: D1,
      tier: "prod",
      pins: [{ principal: "agent:alpha", operations: ["take"] }, { principal: "agent:beta", operations: ["take"] }],
    });
    await operator.grant("agent:alpha", "exec_result", ["put"]);
    await operator.grant("agent:beta", "exec_result", ["put"]);
    await bind(operator, "agent:alpha", D1);
    await bind(operator, "agent:beta", D1);
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: "prod", job: "one" } });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: "prod", job: "two" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo("done") });
    const outcomes = await host.tick();
    assertEquals(outcomes.filter((o) => o.status === "acked").length, 2, "both hosted agents claimed and settled");

    // The property: the RESULT is authored by the agent's run, and its delegation chain names the
    // agent. Nothing here mentions the host, which holds no identity of its own in the space.
    const results = await operator.query({ kind: "exec_result" }, 10, { dir: "desc" });
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
    const credentials = { "agent:ungranted": await credential("agent:ungranted") };
    await bind(operator, "agent:ungranted", D1);
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: "prod", job: "x" } });

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
    const credentials = { "agent:unbound": await credential("agent:unbound") };
    await promote(operator, { digest: D1, tier: "prod", pins: [{ principal: "agent:unbound", operations: ["take"] }] });
    await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: "prod", job: "x" } });

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
    const credentials = { "agent:drifted": await credential("agent:drifted") };
    await promote(operator, { digest: D1, tier: "prod", pins: [{ principal: "agent:drifted", operations: ["take"] }] });
    await bind(operator, "agent:drifted", D2);
    await operator.grant("agent:drifted", "exec_result", ["put"]);
    const { id } = await operator.put({ kind: EXEC_REQUEST, body: { workspace: D1, tier: "prod", job: "x" } });

    const host = new WorkspaceHost({ base: url, credentials, reader: operator, invoke: echo("must not run") });
    assertEquals(await host.tick(), [{ agent: "agent:drifted", status: "digest_mismatch", wanted: D1, bound: D2, recordId: id }]);
    assertEquals((await operator.query({ kind: "exec_result" }, 10)).length, 0, "nothing may be produced from mismatched code");
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
