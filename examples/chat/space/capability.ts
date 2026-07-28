// Publishing a tool so agents can DISCOVER it.
//
// A worker advertises what it serves as a `capability` record; the chat watches those records to
// build its tool list, so adding a worker adds a tool with no code or prompt change anywhere else.
//
// The write is content-keyed, like `kind_def` declarations: the SAME definition dedups across
// restarts, a CHANGED one becomes a successor record (latest per tool wins on discovery), never a
// 409. The key must be header-safe, because an `Idempotency-Key` is a ByteString and tool
// descriptions carry Unicode (…, →) that would break the fetch header. So the definition is
// HASHED into the key rather than embedded in it.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { ToolDef } from "../provider/openrouter.ts";

async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Advertise one tool. Safe to call on every startup, and now actually cheap to.
 *
 * The content key does NOT make this idempotent across restarts, which is the trap: an
 * idempotency key is scoped `(principal, operation, key)`, and a worker's principal is a fresh
 * `run:<ulid>` every launch. So the same unchanged definition wrote a NEW record on every start,
 * and a long-lived space grew by the whole fleet's tool count per restart, until discovery's
 * bounded page no longer reached the newest tool. Read first, and write only on a real change.
 */
export async function publishCapability(client: RadiaClient, def: ToolDef): Promise<void> {
  const tool = def.function.name;
  const hash = await defHash(def);
  try {
    // Newest first: the current advertisement is the latest record, not the earliest.
    const existing = await client.query({ kind: "capability", match: { tool } }, 1, { dir: "desc" });
    const current = existing[0]?.body as { def?: ToolDef } | undefined;
    if (current?.def && await defHash(current.def) === hash) return; // unchanged: nothing to say
  } catch {
    // No grant to read capabilities (or an older server): fall through and publish.
  }
  await client.put({ kind: "capability", body: { tool, def } }, `capability:${tool}:${hash}`);
}
