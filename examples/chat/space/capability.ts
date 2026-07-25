// Publishing a tool so agents can DISCOVER it.
//
// A worker advertises what it serves as a `capability` record; the chat watches those records to
// build its tool list, so adding a worker adds a tool with no code or prompt change anywhere else.
//
// The write is content-keyed, like `kind_def` declarations: the SAME definition dedups across
// restarts, a CHANGED one becomes a successor record (latest per tool wins on discovery) — never a
// 409. The key must be header-safe, because an `Idempotency-Key` is a ByteString and tool
// descriptions carry Unicode (…, →) that would break the fetch header. So the definition is
// HASHED into the key rather than embedded in it.

import type { RadiaClient } from "../../../sdk/ts/client.ts";
import type { ToolDef } from "../provider/openrouter.ts";

async function defHash(def: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(def)));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Advertise one tool. Safe to call on every startup. */
export async function publishCapability(client: RadiaClient, def: ToolDef): Promise<void> {
  const tool = def.function.name;
  await client.put({ kind: "capability", body: { tool, def } }, `capability:${tool}:${await defHash(def)}`);
}
