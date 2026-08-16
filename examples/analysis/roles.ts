// Who may do what. Three principals, none of them the person at the browser.
//
// A PERSON uploads and reads. They cannot write a `stage_result`, which is the property that makes
// a result mean something: it says a worker computed this from that input under that code, and if a
// person could write one the memo would be a claim rather than evidence.
//
// Scoped by `{owner}`, so two people on one space see their own datasets and each other's not at
// all. The pipeline kinds all carry `owner` for exactly this reason.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import { opsGrantKey } from "../../sdk/ts/registry.ts";

interface Grant {
  kind: string;
  operations: string[];
  pattern?: Record<string, unknown>;
}

/** A stage worker: claims its own requests, writes results and its own advertisement. */
const WORKER_GRANTS: Grant[] = [
  { kind: "interest", operations: ["put", "query"] }, // agentLoop declares what it listens for
  { kind: "stage_request", operations: ["take"] },
  { kind: "stage_result", operations: ["put"] },
  { kind: "stage_code", operations: ["put", "query"] },
  // Reads the input, writes the output. Unscoped: one worker serves everybody's datasets, and the
  // request it claimed is what says which artifact to read.
  { kind: "artifact", operations: ["put", "read_one"] },
];

/** The planner: reads everything it plans over, writes only requests. */
const PLANNER_GRANTS: Grant[] = [
  { kind: "dataset", operations: ["query"] },
  { kind: "stage_code", operations: ["query"] },
  { kind: "stage_result", operations: ["query"] },
  { kind: "stage_request", operations: ["put", "query"] },
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
    // Their own uploads and the outputs computed from them. Scoped by owner, which the worker
    // stamps onto every artifact it writes from their request.
    { kind: "artifact", operations: ["put", "read_one", "query"], ...mine },
    // Reference data: which stages exist and what code is live. Unscoped because it is nobody's.
    { kind: "stage_code", operations: ["query"] },
    { kind: "kind_def", operations: ["query"] },
  ];
}

/**
 * Let a person INSPECT their pipeline in the console.
 *
 * Separate from `grantUser`, and opt-in, because it is a real widening: the console's Graph, Feed
 * and Events views are the ops plane, and the only power that opens them for reading is `observe` —
 * which opens EVERY read, unscoped. There is no "observe my own records" tier that fits here: the
 * self-scope tier needs every grant to say `createdBy: "self"`, and this pipeline's results are
 * written by WORKERS, so that scope would hide exactly what a person wants to look at.
 *
 * Right for a single-user or demo space. Wrong for a shared one, where it lets any pipeline user
 * read every other person's records.
 */
export async function grantObserve(admin: RadiaClient, owner: string): Promise<void> {
  const power = { principal: owner, operations: ["observe"] };
  // Content-keyed like every ops_grant, so re-running the launcher writes nothing.
  await admin.put({ kind: "ops_grant", body: power }, opsGrantKey(power));
}

export interface Bootstrapped {
  workerToken: string;
  plannerToken: string;
}

/** Operator setup: the two agent identities the fleet runs as. */
export async function bootstrap(admin: RadiaClient): Promise<Bootstrapped> {
  const worker = await admin.createAgentDefinition(
    "agent:analysis-worker",
    WORKER_GRANTS.map((g) => ({ principal: "agent:analysis-worker", ...g })),
  );
  const planner = await admin.createAgentDefinition(
    "agent:analysis-planner",
    PLANNER_GRANTS.map((g) => ({ principal: "agent:analysis-planner", ...g })),
  );
  return { workerToken: worker.definitionToken, plannerToken: planner.definitionToken };
}

/** Operator action: let this person use the pipeline. Idempotent. */
export async function grantUser(admin: RadiaClient, owner: string): Promise<void> {
  for (const g of userGrants(owner)) await admin.grant(owner, g.kind, g.operations, g.pattern);
}
