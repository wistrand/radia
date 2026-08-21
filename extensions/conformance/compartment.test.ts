// The compartment AUDIT contract (agent_docs/architecture-workspace-agents.md phase 3).
//
//   deno task test:extensions
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
//
// The space is shared across this file's tests, so each test audits its OWN inside kind with its
// own principals: the audit walks the whole grant registry, and a fixed principal name would make
// one test's crosser appear in the next test's answer.

import { assert, assertEquals } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { auditCompartment, unexpectedCrossers } from "../ts/compartment.ts";
import { bootSpace, uniq } from "./space.ts";

const PORT = 7833;

const shared = await bootSpace(PORT);
await shared.registerKind({ kind: "public_summary", indexedPaths: [{ path: "tag", type: "keyword" }] });
await shared.registerKind({
  kind: "artifact",
  indexedPaths: [{ path: "compartment", type: "keyword" }, { path: "digest", type: "keyword" }, { path: "mediaType", type: "keyword" }],
  claimable: false,
});

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  return await fn(shared);
}

/** This test's own inside kind, so its audit sees only its own principals. */
async function insideKind(c: RadiaClient): Promise<string> {
  const kind = uniq("finding");
  await c.registerKind({ kind, indexedPaths: [{ path: "compartment", type: "keyword" }] });
  return kind;
}

Deno.test("[compartment] a member is not a crosser; a principal granted both sides is", async () => {
  await withSpace(async (c) => {
    const finding = await insideKind(c);
    const analyst = uniq("agent:analyst"), exporter = uniq("agent:exporter"), publisher = uniq("agent:publisher");
    // A member: reads and writes INSIDE only. This is the shape every analysis agent has, and it
    // must never appear in the audit, or the audit is noise and gets ignored.
    await c.grant(analyst, finding, ["query", "take", "put"], { compartment: "alpha" });
    // The exporter: reads inside, writes outside. Its whole job is crossing.
    await c.grant(exporter, finding, ["query"], { compartment: "alpha" });
    await c.grant(exporter, "public_summary", ["put"]);
    // A principal that only writes outside is not a crosser either: it has nothing to carry.
    await c.grant(publisher, "public_summary", ["put"]);

    const audit = await auditCompartment(c, { inside: [finding] });
    assertEquals(audit.crossers.map((x) => x.principal), [exporter]);
    assertEquals(audit.crossers[0].reads, [finding]);
    assertEquals(audit.crossers[0].writes, ["public_summary"]);

    // The checklist form: the exporter is expected, so a clean space reports nothing.
    assertEquals(await unexpectedCrossers(c, { inside: [finding], expected: [exporter] }), []);
    // …and the finding that matters is a SECOND crosser nobody meant to create.
    await c.grant(analyst, "public_summary", ["put"]);
    const unexpected = await unexpectedCrossers(c, { inside: [finding], expected: [exporter] });
    assertEquals(unexpected.map((x) => x.principal), [analyst]);
  });
});

Deno.test("[compartment] a RETIRED grant stops making a principal a crosser", async () => {
  await withSpace(async (c) => {
    const finding = await insideKind(c);
    const analyst = uniq("agent:analyst");
    await c.grant(analyst, finding, ["query"], { compartment: "alpha" });
    await c.grant(analyst, "public_summary", ["put"]);
    assertEquals((await auditCompartment(c, { inside: [finding] })).crossers.map((x) => x.principal), [analyst]);

    // Withdrawal is a successor carrying `retired: true`, and the audit must read the REGISTRY
    // rather than the records: the retirement does not delete anything, so a raw scan still sees
    // the grant and would report a crossing that no longer exists.
    const rows = await c.query({ kind: "grant", match: { principal: analyst, kind: "public_summary" } }, 10, { dir: "desc" });
    assertEquals(rows.length, 1);
    await c.put({ kind: "grant", body: { ...(rows[0].body as object), retired: true } }, `grant-retire:${rows[0].id}`);

    assertEquals((await auditCompartment(c, { inside: [finding] })).crossers, [], "a revoked crossing must stop being reported");
  });
});

Deno.test("[compartment] an artifact grant with no compartment pattern is reported: the kind cannot be partitioned", async () => {
  await withSpace(async (c) => {
    const finding = await insideKind(c);
    const analyst = uniq("agent:analyst"), careful = uniq("agent:careful");
    // `artifact` is reserved, so a compartment cannot get its own artifact kind and must scope by
    // pattern. This grant forgot, and it reaches every artifact record in the space, and through
    // them the bytes. The plan calls it the most likely real-world leak.
    await c.grant(analyst, "artifact", ["query"]);
    await c.grant(careful, "artifact", ["query", "put"], { compartment: "alpha" });

    const audit = await auditCompartment(c, { inside: [finding] });
    assertEquals(audit.unscopedArtifact.map((x) => x.principal), [analyst]);
    assertEquals(audit.unscopedArtifact[0].operations, ["query"]);
    assert(audit.caveats.some((s) => s.includes("artifact grants without")), "the answer must say what an unscoped grant reaches");
  });
});

Deno.test("[compartment] ops powers are reported, because observe reads every body and is no grant", async () => {
  await withSpace(async (c) => {
    const finding = await insideKind(c);
    const analyst = uniq("agent:analyst"), watcher = uniq("agent:watcher"), reviewer = uniq("agent:reviewer");
    await c.grant(analyst, finding, ["query"], { compartment: "alpha" });
    await c.put({ kind: "ops_grant", body: { principal: watcher, operations: ["observe"] } });
    await c.put({ kind: "ops_grant", body: { principal: reviewer, operations: ["declassify"] } });

    const audit = await auditCompartment(c, { inside: [finding] });
    // `agent:local-observer` is not a fixture: EVERY space provisions it, and it holds `observe`
    // for the MCP adapter and the CLI's read verbs. So a real space starts with a principal that
    // reads every body in every compartment, which is exactly the rule the plan states as D7
    // ("never grant observe inside the protected domain, including the default credential") and
    // exactly the finding an operator would otherwise meet the hard way. The audit's job is to
    // put it on the first line of the answer rather than in a doc.
    const mine = audit.opsPowers.filter((p) => p.principal === "agent:local-observer" || p.principal === watcher || p.principal === reviewer);
    assertEquals(mine, [
      { principal: "agent:local-observer", powers: ["observe"] },
      { principal: reviewer, powers: ["declassify"] },
      { principal: watcher, powers: ["observe"] },
    ]);
    // A power holder is not a "crosser" by grants, which is exactly why it has to be reported
    // separately: neither door is visible in the grant registry.
    assertEquals(audit.crossers, []);
    assert(audit.caveats.some((s) => s.includes(watcher) && s.includes("every record BODY")));
    assert(audit.caveats.some((s) => s.includes(reviewer) && s.includes("declassify")));
    // And the standing caveat: an operator is invisible here whatever the records say.
    assert(audit.caveats.some((s) => s.includes("privileged principals bypass grants")));
  });
});
