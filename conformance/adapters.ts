// The list of adapters every conformance suite runs against. Both embedded adapters ship in
// M0. The standalone Postgres adapter runs too when RADIA_PG_URL points at a reachable server
// (CI / local Postgres); without it, the pg rows are skipped so the suite stays runnable with
// zero setup. Each pg adapter gets an ephemeral, uniquely-named schema (created on init,
// dropped on close) so tests are isolated on a single shared server. No suite changes.

import { PgliteAdapter } from "../src/storage/pglite.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { PostgresAdapter } from "../src/storage/postgres.ts";
import { newUlid } from "../src/core/ids.ts";
import type { AdapterFactory } from "./harness.ts";

export const adapters: AdapterFactory[] = [
  { name: "pglite", create: () => new PgliteAdapter() }, // in-memory
  { name: "sqlite", create: () => new SqliteAdapter(":memory:") },
];

// Opt-in Postgres: set RADIA_PG_URL=postgres://user:pass@host:5432/db (see agent_docs/design-storage.md).
const pgUrl = Deno.env.get("RADIA_PG_URL");
if (pgUrl) {
  adapters.push({
    name: "postgres",
    create: () => new PostgresAdapter(pgUrl, { schema: `radia_conf_${newUlid()}`, ephemeral: true }),
  });
}
