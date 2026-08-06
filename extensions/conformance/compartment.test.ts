// The compartment AUDIT contract (agent_docs/architecture-workspace-agents.md phase 3).
//
//   deno task extensions
//
// Phase 1 proved the runtime enforces the boundary: a member cannot write outside, a principal
// granted both sides can. This suite is the other half, and the half a rule needs to survive
// contact with a real space: FINDING the principals who hold both, plus the two doors that are
// not grants at all (`observe` reads every body, `declassify` clears labels) and the one kind
// that cannot be partitioned (`artifact` is reserved, so it is scoped by pattern or not at all).
//
// The case that matters most is the retired grant. An audit that read grant records without
// projecting the registry would keep reporting a crossing that was revoked months ago, and an
// audit nobody believes is worse than none: it gets ignored, and then it is not there for the one
// finding that was real.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { auditCompartment, unexpectedCrossers } from "../ts/compartment.ts";

const PORT = 7819;
const url = `http://127.0.0.1:${PORT}`;
const INSIDE = ["finding"];

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
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
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind({ kind: "finding", indexedPaths: [{ path: "compartment", type: "keyword" }] });
  await c.registerKind({ kind: "public_summary", indexedPaths: [{ path: "tag", type: "keyword" }] });
  await c.registerKind({
    kind: "artifact",
    indexedPaths: [{ path: "compartment", type: "keyword" }, { path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }],
    claimable: false,
  });
  try {
    return await fn(c);
  } finally {
    space.kill("SIGTERM");
    await space.status;
  }
}

Deno.test("[compartment] a member is not a crosser; a principal granted both sides is", async () => {
  await withSpace(async (c) => {
    // A member: reads and writes INSIDE only. This is the shape every analysis agent has, and it
    // must never appear in the audit, or the audit is noise and gets ignored.
    await c.grant("agent:analyst", "finding", ["query", "take", "put"], { compartment: "alpha" });
    // The exporter: reads inside, writes outside. Its whole job is crossing.
    await c.grant("agent:exporter", "finding", ["query"], { compartment: "alpha" });
    await c.grant("agent:exporter", "public_summary", ["put"]);
    // A principal that only writes outside is not a crosser either: it has nothing to carry.
    await c.grant("agent:publisher", "public_summary", ["put"]);

    const audit = await auditCompartment(c, { inside: INSIDE });
    assertEquals(audit.crossers.map((x) => x.principal), ["agent:exporter"]);
    assertEquals(audit.crossers[0].reads, ["finding"]);
    assertEquals(audit.crossers[0].writes, ["public_summary"]);

    // The checklist form: the exporter is expected, so a clean space reports nothing.
    assertEquals(await unexpectedCrossers(c, { inside: INSIDE, expected: ["agent:exporter"] }), []);
    // …and the finding that matters is a SECOND crosser nobody meant to create.
    await c.grant("agent:analyst", "public_summary", ["put"]);
    const unexpected = await unexpectedCrossers(c, { inside: INSIDE, expected: ["agent:exporter"] });
    assertEquals(unexpected.map((x) => x.principal), ["agent:analyst"]);
  });
});

Deno.test("[compartment] a RETIRED grant stops making a principal a crosser", async () => {
  await withSpace(async (c) => {
    await c.grant("agent:analyst", "finding", ["query"], { compartment: "alpha" });
    await c.grant("agent:analyst", "public_summary", ["put"]);
    assertEquals((await auditCompartment(c, { inside: INSIDE })).crossers.map((x) => x.principal), ["agent:analyst"]);

    // Withdrawal is a successor carrying `retired: true`, and the audit must read the REGISTRY
    // rather than the records: the retirement does not delete anything, so a raw scan still sees
    // the grant and would report a crossing that no longer exists.
    const rows = await c.query({ kind: "grant", match: { principal: "agent:analyst", kind: "public_summary" } }, 10, { dir: "desc" });
    assertEquals(rows.length, 1);
    await c.put({ kind: "grant", body: { ...(rows[0].body as object), retired: true } }, `grant-retire:${rows[0].id}`);

    assertEquals((await auditCompartment(c, { inside: INSIDE })).crossers, [], "a revoked crossing must stop being reported");
  });
});

Deno.test("[compartment] an artifact grant with no compartment pattern is reported: the kind cannot be partitioned", async () => {
  await withSpace(async (c) => {
    // `artifact` is reserved, so a compartment cannot get its own artifact kind and must scope by
    // pattern. This grant forgot, and it reaches every artifact record in the space, and through
    // them the bytes. The plan calls it the most likely real-world leak.
    await c.grant("agent:analyst", "artifact", ["query"]);
    await c.grant("agent:careful", "artifact", ["query", "put"], { compartment: "alpha" });

    const audit = await auditCompartment(c, { inside: INSIDE });
    assertEquals(audit.unscopedArtifact.map((x) => x.principal), ["agent:analyst"]);
    assertEquals(audit.unscopedArtifact[0].operations, ["query"]);
    assert(audit.caveats.some((s) => s.includes("artifact grants without")), "the answer must say what an unscoped grant reaches");
  });
});

Deno.test("[compartment] ops powers are reported, because observe reads every body and is no grant", async () => {
  await withSpace(async (c) => {
    await c.grant("agent:analyst", "finding", ["query"], { compartment: "alpha" });
    await c.put({ kind: "ops_grant", body: { principal: "agent:watcher", operations: ["observe"] } });
    await c.put({ kind: "ops_grant", body: { principal: "agent:reviewer", operations: ["declassify"] } });

    const audit = await auditCompartment(c, { inside: INSIDE });
    // `agent:local-observer` is not a fixture: EVERY space provisions it, and it holds `observe`
    // for the MCP adapter and the CLI's read verbs. So a real space starts with a principal that
    // reads every body in every compartment, which is exactly the rule the plan states as D7
    // ("never grant observe inside the protected domain, including the default credential") and
    // exactly the finding an operator would otherwise meet the hard way. The audit's job is to
    // put it on the first line of the answer rather than in a doc.
    assertEquals(audit.opsPowers, [
      { principal: "agent:local-observer", powers: ["observe"] },
      { principal: "agent:reviewer", powers: ["declassify"] },
      { principal: "agent:watcher", powers: ["observe"] },
    ]);
    // A power holder is not a "crosser" by grants, which is exactly why it has to be reported
    // separately: neither door is visible in the grant registry.
    assertEquals(audit.crossers, []);
    assert(audit.caveats.some((s) => s.includes("agent:watcher") && s.includes("every record BODY")));
    assert(audit.caveats.some((s) => s.includes("agent:reviewer") && s.includes("declassify")));
    // And the standing caveat: an operator is invisible here whatever the records say.
    assert(audit.caveats.some((s) => s.includes("privileged principals bypass grants")));
  });
});
