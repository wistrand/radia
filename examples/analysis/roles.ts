// Who may do what. Five principals, none of them the person at the browser.
//
// A PERSON uploads and reads. They cannot write a `stage_result`, which is the property that makes
// a result mean something: it says a worker computed this from that input under that code, and if a
// person could write one the memo would be a claim rather than evidence.
//
// Scoped by `{owner}`, so two people on one space see their own datasets and each other's not at
// all. The pipeline kinds all carry `owner` for exactly this reason, and the host stamps it onto
// every output artifact from the claimed request (`outputMeta`), so a person's scope reaches the
// bytes a stage computed for them.
//
// THE STAGE AGENTS HOLD NO stage_request/stage_result GRANTS HERE. Both come from promotion pins
// (`deployStages`): take on requests naming the promoted digest, put on results naming it. That
// absence is the enforcement — an agent whose tier was rotated away can neither claim nor answer.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { opsGrantKey } from "../../sdk/ts/registry.ts";
import { BINDING, declareBinding, readBindings } from "../../extensions/ts/host.ts";
import { promote } from "../../extensions/ts/promotion.ts";
import { PIPELINE_TIER, STAGES, type StageName } from "./kinds.ts";

interface Grant {
  kind: string;
  operations: string[];
  pattern?: Record<string, unknown>;
}

/** The naming convention `liveCode` inverts: any stage's agent, shipped or deployed later. */
export const stageAgent = (stage: string) => `agent:analysis-${stage}`;

/** A stage agent's UNPINNED grants: the containers its outputs land in. The work itself (take the
 *  request, put the result) is granted only by the promotion pins. */
const STAGE_AGENT_GRANTS: Grant[] = [
  // Output capture: each run becomes a version of `stage-<name>-out`, and finding the version it
  // supersedes is a query.
  { kind: "workspace", operations: ["put", "query"] },
  // Reads the input (the host fetches it under THIS authority), writes the output files.
  { kind: "artifact", operations: ["put", "read_one"] },
];

/** The planner: reads everything it plans over, writes only requests. `artifact: query` is how an
 *  in-jail `outputDigest` resolves to the artifact id the next request names, and `binding: query`
 *  is where live code is discovered — the same records the host runs. */
const PLANNER_GRANTS: Grant[] = [
  { kind: "dataset", operations: ["query"] },
  { kind: "stage_def", operations: ["query"] }, // the pipeline's shape: what to walk
  { kind: BINDING, operations: ["query"] },
  { kind: "stage_result", operations: ["query"] },
  { kind: "stage_request", operations: ["put", "query"] },
  { kind: "artifact", operations: ["query"] },
];

/** The host's READER: infrastructure reads (which binding, which tree, which file bytes), never
 *  the agents' coordination. Its own identity so nothing launched holds the operator credential. */
const READER_GRANTS: Grant[] = [
  { kind: BINDING, operations: ["query"] },
  { kind: "workspace", operations: ["query"] },
  { kind: "artifact", operations: ["read_one"] },
  // The host wakes on requests landing; the watch is a read and authorized as one.
  { kind: "stage_request", operations: ["query"] },
];

/**
 * A person: uploads a dataset, reads their own pipeline.
 *
 * `stage_request: put` is deliberately ABSENT. Asking for work is the planner's job, and a person
 * who could ask directly could name any (input, code) pair and file the answer under it.
 */
export function userGrants(owner: string): Grant[] {
  const mine = { pattern: { owner } };
  return [
    { kind: "dataset", operations: ["put", "query"], ...mine },
    { kind: "stage_request", operations: ["query"], ...mine },
    { kind: "stage_result", operations: ["query"], ...mine },
    // Their own uploads and the outputs computed from them. Scoped by owner, which the HOST stamps
    // onto every output artifact from the claimed request (`outputMeta`), so the scope holds even
    // though an agent authored the bytes.
    { kind: "artifact", operations: ["put", "read_one", "query"], ...mine },
    // Reference data: which stages exist and what code is live. Unscoped because it is nobody's.
    { kind: "stage_def", operations: ["query"] },
    { kind: BINDING, operations: ["query"] },
    { kind: "kind_def", operations: ["query"] },
  ];
}

/**
 * Let a person read the console's AGGREGATES for their pipeline.
 *
 * Narrower than it used to be, and the reason is worth knowing before handing this out. This
 * pipeline's user grants are pattern-scoped on `{owner}` (`userGrants` above), so the PATTERN tier
 * (architecture-ops-tiers.md, built 2026-08-26 with this app as one of the three that drove it)
 * already opens the per-record half of the ops plane without any power at all: record detail,
 * lineage, children and the console's whole GRAPH tab work for an ordinary pipeline user. Verified
 * endpoint by endpoint, not assumed.
 *
 * What still needs `observe` is the aggregates: `ops/stats`, `ops/events` and the diagnostics
 * counts, so the console's Feed, Space map and Overview numbers. Those push to SQL, where the
 * pre-filter is a sound OVER-approximation, so counting there would report more rows than the
 * caller may see; pattern-scoped kinds are left out and NAMED instead. A caller without this power
 * gets an honest, explained partial view rather than a refusal.
 *
 * Still a real widening, because `observe` remains unscoped: right for a single-user or demo space,
 * wrong for a shared one, where it lets any pipeline user read every other person's records. Do not
 * reach for it to make the Graph work; that already works.
 */
export async function grantObserve(admin: RadiaClient, owner: string): Promise<void> {
  const power = { principal: owner, operations: ["observe"] };
  // Content-keyed like every ops_grant, so re-running the launcher writes nothing.
  await admin.put({ kind: "ops_grant", body: power }, opsGrantKey(power));
}

export interface Bootstrapped {
  /** Definition token per stage agent, held by the host out of band. */
  agentTokens: Record<StageName, string>;
  readerToken: string;
  plannerToken: string;
}

/** Operator setup: the agent identities the fleet runs as. */
export async function bootstrap(admin: RadiaClient): Promise<Bootstrapped> {
  await declareBinding(admin);
  const agentTokens = {} as Record<StageName, string>;
  for (const stage of STAGES) {
    const agent = stageAgent(stage);
    const def = await admin.createAgentDefinition(agent, STAGE_AGENT_GRANTS.map((g) => ({ principal: agent, ...g })));
    agentTokens[stage] = def.definitionToken;
  }
  const reader = await admin.createAgentDefinition(
    "agent:analysis-reader",
    READER_GRANTS.map((g) => ({ principal: "agent:analysis-reader", ...g })),
  );
  const planner = await admin.createAgentDefinition(
    "agent:analysis-planner",
    PLANNER_GRANTS.map((g) => ({ principal: "agent:analysis-planner", ...g })),
  );
  return { agentTokens, readerToken: reader.definitionToken, plannerToken: planner.definitionToken };
}

/**
 * Operator deployment: the two locks per stage, plus the advertisement the planner still reads.
 *
 * Promotion pins BOTH sides on `{workspace: digest, tier}` — `take` on the request (only the
 * promoted tree's work may be claimed) and `put` on the result (a result cannot lie about which
 * code produced it). The binding names the same digest for the host; the host refuses a pairing
 * where the two disagree (`digest_mismatch`). Re-promotion of an unchanged digest is a no-op at
 * the grant layer (content-keyed), and the binding write is skipped when it already says this.
 * The binding is also what the PLANNER reads for live code (`liveCode`), so deploying is the whole
 * of making a stage exist: no advertisement, nothing to keep in sync with the enforcement.
 */
export async function deployStages(admin: RadiaClient, digests: Record<StageName, string>): Promise<void> {
  const bindings = await readBindings(admin);
  for (const [i, stage] of STAGES.entries()) {
    const agent = stageAgent(stage);
    const digest = digests[stage];
    // The shape entry. Content-keyed on (stage, index), latest wins, indexes gapped by 10 so a
    // stage deployed later can land between two shipped ones.
    await admin.put(
      { kind: "stage_def", body: { stage, index: (i + 1) * 10 } },
      `stage-def:${stage}:${(i + 1) * 10}`,
    );
    await promote(admin, {
      digest,
      tier: PIPELINE_TIER,
      kind: "stage_request",
      pins: [{ principal: agent, operations: ["take"] }],
    });
    await promote(admin, {
      digest,
      tier: PIPELINE_TIER,
      kind: "stage_result",
      pins: [{ principal: agent, operations: ["put"] }],
    });
    const have = bindings.find((b) => b.agent === agent);
    if (have?.workspaceDigest !== digest || have?.outputWorkspace !== `stage-${stage}-out`) {
      await admin.put({
        kind: BINDING,
        body: {
          agent,
          workspaceDigest: digest,
          entrypoint: `${stage}/main.ts`,
          // The request names its input; the host fetches it under the AGENT's authority to
          // `input/data`, which is the path the harness reads.
          inputs: [{ field: "inputArtifact", path: "data" }],
          outputWorkspace: `stage-${stage}-out`,
          // The output belongs to the person whose request it was, not to the agent: this is what
          // keeps the {owner} scope working now that an agent authors the bytes.
          outputMeta: ["owner", "dataset"],
        },
      });
    }
  }
}

/** Operator action: let this person use the pipeline. Idempotent. */
export async function grantUser(admin: RadiaClient, owner: string): Promise<void> {
  for (const g of userGrants(owner)) await admin.grant(owner, g.kind, g.operations, g.pattern);
}
