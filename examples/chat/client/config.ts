// Everything the chat reads from its environment, in one place.
//
// The rule these obey: this file is SETUP, meaning which space, which models serve which tier,
// which directories are readable. It never decides per-turn behaviour. Which tier answers a turn, which
// tool runs, how records relate: those are discovered from the substrate or delegated to a worker
// (CLAUDE.md, "discover, don't hardcode").

import { arg } from "../util.ts";
import { resolveToken } from "../../../src/credentials.ts";

/** Same port as `deno task dev` by default, so a console you already have open shows this run. */
export const url = Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
export const port = new URL(url).port || "7788";

/**
 * The session credential, minted for a PERSON: `radia login human:alice`. REQUIRED.
 *
 * There is no default and no fallback. The chat used to run as a shared `agent:chat-user`, or as
 * the operator, on a request that carried no credential at all: the space's open-mode no-header
 * shortcut answered as `human:local` and everything worked. That is a convenience with no upper
 * bound on what it authorizes, and it made the identity of a session a property of how the process
 * was launched rather than of who is using it. Requiring a token means the answer to "who is this"
 * is always a credential the space issued, never an absence.
 */
export const loginToken = arg("--token") ?? Deno.env.get("RADIA_CHAT_TOKEN");

/**
 * The OPERATOR credential the launcher bootstraps with: registering kinds, minting the worker run
 * tokens, and approving grant requests are all privileged. REQUIRED, for the same reason.
 *
 * `radia dev` writes one to the per-user credential file, which is where this reads it from unless
 * `RADIA_TOKEN` overrides. Separate from `loginToken` on purpose: the person at the keyboard is not
 * the operator, and conflating them is how a scoped session ends up holding the control plane.
 */
export function operatorToken(): string | undefined {
  // A FUNCTION, not a constant: when the chat brings its own space up, `radia dev` writes the
  // credential file during startup, so a value captured at import time would always be undefined.
  return arg("--operator-token") ?? Deno.env.get("RADIA_TOKEN") ?? resolveToken(url);
}

/**
 * What the session may READ: its own identity's records, or only this conversation's.
 *
 * Both are real postures, and which is right depends on the space rather than the code:
 *
 *   identity (default): everything this identity produced, across ALL its conversations. Your own
 *     history, including the results and artifacts workers made for it. Operator-role sessions,
 *     worker internals and other agents stay invisible.
 *   conversation: this conversation only, whoever produced the record. The strict posture; the cost
 *     is that a session cannot see your earlier threads.
 *
 * WHICH IDENTITY that is depends on `loginToken`. Without one every session is the same
 * `agent:chat-user`, so identity scope cannot separate two people sharing a space and only
 * `conversation` keeps them apart. With one, the identity is the person, and `identity` scope
 * separates them while still showing each their own history.
 */
export const scopeMode: "identity" | "conversation" =
  (arg("--scope") ?? Deno.env.get("RADIA_CHAT_SCOPE")) === "conversation" ? "conversation" : "identity";

/** Where a chat-spawned space keeps its data: under the one runtime directory (`RADIA_DIR`, default
 *  `.radia`), beside everything else a space writes. A space with no `--db` is IN-MEMORY, so
 *  without this every restart lost the conversation, the saved procedures and the artifacts. The
 *  thread lives on the space, which only helps if the space outlives the process. Blobs land
 *  beside it, at `<db>-blobs`. */
export const spaceDb = Deno.env.get("RADIA_CHAT_DB") ?? `${Deno.env.get("RADIA_DIR") ?? ".radia"}/chat.db`;

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

/** The router classifies each turn with this cheap model, as an `llm_call` served by the fleet,
 *  so the router never holds the API key. */
export const CLASSIFY_MODEL = Deno.env.get("RADIA_CHAT_CLASSIFY_MODEL") ?? "google/gemini-2.5-flash-lite";

/** Not a tier: it serves the `generate_image` tool and advertises `modalities:["image"]`, so text
 *  routing never dispatches a conversation turn to it. */
export const IMAGE_MODEL = Deno.env.get("RADIA_CHAT_IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";

/** Reads images rather than drawing them: serves `analyze_image`. Also not a text tier. */
export const VISION_MODEL = Deno.env.get("RADIA_CHAT_VISION_MODEL") ?? "google/gemini-2.5-flash-lite";

/** What that model accepts as input, which is a property OF THE MODEL and therefore setup, not
 *  behaviour. The worker announces this set in the tool's description, refuses anything outside it,
 *  and puts it on the `model` record, so a swap to a model with a different set is one edit here and
 *  the advertisement, the refusal and the description all follow. The default is Gemini's list,
 *  which includes PDF: the Flash models take a document as native input rather than as extracted
 *  text, so pages arrive with their layout intact. */
export const VISION_MEDIA_TYPES = (Deno.env.get("RADIA_CHAT_VISION_TYPES") ??
  "image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf")
  .split(",").map((t) => t.trim()).filter(Boolean);

/** How long a model-written program may run. Short on purpose: it is also the bound on how long a
 *  runaway allocation can hold host memory (extensions/ts/sandbox.ts explains why the heap flag is not enough). */
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
