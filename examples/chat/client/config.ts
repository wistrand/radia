// Everything the chat reads from its environment, in one place.
//
// The rule these obey: this file is SETUP — which space, which models serve which tier, which
// directories are readable. It never decides per-turn behaviour. Which tier answers a turn, which
// tool runs, how records relate: those are discovered from the substrate or delegated to a worker
// (CLAUDE.md, "discover, don't hardcode").

import { arg } from "../util.ts";
import type { Role } from "../space/roles.ts";

/** Same port as `deno task dev` by default, so a console you already have open shows this run. */
export const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
export const port = new URL(url).port || "7788";

export const role: Role = (arg("--role") ?? Deno.env.get("RADIA_CHAT_ROLE")) === "user" ? "user" : "admin";

/** Where a chat-spawned space keeps its data. A space with no `--db` is IN-MEMORY, so without this
 *  every restart lost the conversation, the saved procedures and the artifacts — the thread lives
 *  on the space, which only helps if the space outlives the process. Blobs land beside it. */
export const spaceDb = Deno.env.get("RADIA_CHAT_DB") ?? ".radia-chat-space.db";

/** Reattach to an existing conversation instead of starting one: a conversation id, or `last` for
 *  the most recent. Empty = start fresh. */
export const resume = arg("--conversation") ?? Deno.env.get("RADIA_CHAT_RESUME") ?? "";

/** Three capability/cost tiers, cheap → capable in insertion order (the order sets escalation
 *  rank). Add one here and a new model is live: the router discovers it from the `model` records
 *  its worker advertises, and nothing in this client changes. */
export const TIERS: Record<string, string> = {
  fast: Deno.env.get("RADIA_CHAT_MODEL_FAST") ?? "openai/gpt-4o-mini",
  balanced: Deno.env.get("RADIA_CHAT_MODEL_BALANCED") ?? "anthropic/claude-sonnet-5",
  deep: Deno.env.get("RADIA_CHAT_MODEL_DEEP") ?? "anthropic/claude-opus-5",
};

/** The router classifies each turn with this cheap model — as an `llm_call` served by the fleet,
 *  so the router never holds the API key. */
export const CLASSIFY_MODEL = Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";

/** Not a tier: it serves the `generate_image` tool and advertises `modalities:["image"]`, so text
 *  routing never dispatches a conversation turn to it. */
export const IMAGE_MODEL = Deno.env.get("RADIA_CHAT_IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";

/** How long a model-written program may run. Short on purpose: it is also the bound on how long a
 *  runaway allocation can hold host memory (tools/exec-sandbox.ts explains why the heap flag is not enough). */
export const EXEC_TIMEOUT_MS = Deno.env.get("RADIA_CHAT_EXEC_TIMEOUT_MS") ?? "5000";

/** Where generated artifacts are also written locally, if set. */
export const IMAGE_DIR = Deno.env.get("RADIA_CHAT_IMAGE_DIR");

export const apiKey = Deno.env.get("OPENROUTER_API_KEY");

/** Resolve directories to real paths before they become permission grants: a symlink must not be
 *  able to smuggle a grant somewhere else. */
async function realRoots(raw: string, label: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of raw.split(/[:,]/).filter(Boolean)) {
    try {
      out.push(await Deno.realPath(d));
    } catch {
      console.error(`${label}: not found, skipping: ${d}`);
    }
  }
  return out;
}

/** What the FILE TOOLS may read (`read_file`, `search_files`, …). */
export const toolRoots = await realRoots(Deno.env.get("RADIA_CHAT_DIRS") ?? "examples/chat/sandbox", "RADIA_CHAT_DIRS");

/** What EXECUTED CODE may read. Off by default, and deliberately a separate setting: a tool
 *  returns one file per call in the open, while a program can walk a tree and fold it into one
 *  line of output, so widening the tools must not silently widen the sandbox. */
export const execRoots = await realRoots(Deno.env.get("RADIA_CHAT_EXEC_DIRS") ?? "", "RADIA_CHAT_EXEC_DIRS");
