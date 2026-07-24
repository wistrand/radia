// Remediation tools — turn the chatbot from an inspector into an operator. These are
// control-plane operations that bypass lease fencing (you're fixing another worker's stuck
// record, so you don't hold its lease), so they're privileged: with real auth they'd be
// grant-gated to a human/supervisor. Pair them with space_doctor: find what's stuck, then
// fix it, in conversation.

import type { RadiaClient } from "../../sdk/ts/client.ts";
import type { Tool } from "./tools.ts";
import type { ToolDef } from "./openrouter.ts";

export function makeRemediateTools(client: RadiaClient): Record<string, Tool> {
  return {
    space_reclaim: (a) => client.admin("reclaim", String(a.recordId ?? "")),
    space_dead_letter: (a) => client.admin("dead-letter", String(a.recordId ?? "")),
    space_requeue: (a) => client.admin("requeue", String(a.recordId ?? "")),
  };
}

export const REMEDIATE_SCHEMAS: ToolDef[] = [
  { type: "function", function: { name: "space_reclaim", description: "Un-stick an EXPIRED lease: force the record back to available (attempt +1) so a worker can re-take it. No effect on a valid (unexpired) lease. Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_dead_letter", description: "Give up on a record: force it to dead_letter (from available or leased). Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
  { type: "function", function: { name: "space_requeue", description: "Retry a dead-lettered record: force it back to available. Returns {applied}.", parameters: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"] } } },
];
