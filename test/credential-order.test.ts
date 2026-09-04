// The current state of a credential is the newest record by the DATABASE CLOCK, never by id.
//
// An id is a ULID minted by whichever instance wrote the record. Two instances with skewed clocks
// can hand a stop a smaller id than the run it stops, and "newest by id" then resolves a stopped
// token as live: the same shape as the three security incidents in plan-bounded-reads.md's census.
// `created_at` is the DB clock; `newer` (sdk/ts/registry.ts) reads it first.

import { assertEquals } from "@std/assert";
import { type IdentityHost, newestByHash } from "../src/core/identity.ts";

Deno.test("identity: a stop with an older id but a later clock is the credential's current state", async () => {
  const mint = {
    id: "01B0000000000000000000000B",
    kind: "agent_run",
    body: { run: "run:x", status: "active" },
    runtimeMeta: { createdAt: "2026-09-04T10:00:00.000Z" },
  };
  const stop = {
    id: "01A0000000000000000000000A", // sorts BEFORE the mint: the writing instance's clock ran behind
    kind: "agent_run",
    body: { run: "run:x", status: "stopped" },
    runtimeMeta: { createdAt: "2026-09-04T10:00:05.000Z" }, // but the database saw it later
  };
  const asked: unknown[] = [];
  const host = {
    query: (pattern: unknown, limit: number, page: unknown) => {
      asked.push({ pattern, limit, page });
      return Promise.resolve([mint, stop]); // id-descending, as the storage answers `dir: desc`
    },
  } as unknown as IdentityHost;
  const body = await newestByHash(host, "agent_run", "h") as { status: string };
  assertEquals(body.status, "stopped");
  // Still one NARROW read of one hash, a handful of rows, never a projection over a page.
  assertEquals(asked.length, 1);
  assertEquals((asked[0] as { pattern: { match: { tokenHash: string } } }).pattern.match.tokenHash, "h");
});
