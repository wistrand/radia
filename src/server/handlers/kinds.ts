// Control-plane handler: register a kind's indexing contract. EXPERIMENTAL surface
// (x-stability) — shape may change until M1.

import type { Space } from "../../core/space.ts";
import type { IndexedPath, KindDef } from "../../core/kinds.ts";
import { RadiaError } from "../../core/errors.ts";
import { problem } from "../problem.ts";

export async function handleRegisterKind(space: Space, req: Request): Promise<Response> {
  let j: Record<string, unknown> | null;
  try {
    const parsed = await req.json();
    j = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    j = null;
  }
  if (!j) return problem(400, "invalid_body", "expected a JSON object");

  const def: KindDef = {
    kind: j.kind as string,
    indexedPaths: (j.indexedPaths ?? []) as IndexedPath[],
    sortablePaths: j.sortablePaths as string[] | undefined,
  };

  try {
    space.registerKind(def);
    return new Response(JSON.stringify({ kind: def.kind }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    if (e instanceof RadiaError) return problem(422, e.code, e.message);
    throw e;
  }
}
