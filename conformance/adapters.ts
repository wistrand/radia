// The list of adapters every conformance suite runs against. Both embedded adapters ship in
// M0. The standalone Postgres adapter runs too when RADIA_PG_URL points at a reachable server
// (CI / local Postgres); without it, the pg rows are skipped so the suite stays runnable with
// zero setup. Each pg adapter gets an ephemeral, uniquely-named schema (created on init,
// dropped on close) so tests are isolated on a single shared server. No suite changes.

import { PGlite } from "@electric-sql/pglite";
import { PgliteAdapter } from "../src/storage/pglite.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import { PostgresAdapter } from "../src/storage/postgres.ts";
import { newUlid } from "../src/core/ids.ts";
import type { AdapterFactory } from "./harness.ts";

// RADIA_CONF_ADAPTERS=postgres (comma list) runs ONLY the named adapters. This exists for the
// CI split: the pg job was re-running the whole embedded matrix the embedded job had already
// proved, which doubled the paid minutes for zero coverage. Unset, everything runs — the
// "every implementation in CI" invariant is carried by the PAIR of jobs, not by each alone.
const only = Deno.env.get("RADIA_CONF_ADAPTERS");
const wanted = (name: string) => !only || only.split(",").map((s) => s.trim()).includes(name);

export const adapters: AdapterFactory[] = [];

if (wanted("pglite")) {
  // ONE WASM Postgres for the whole process, isolated per test the same way the standalone
  // Postgres rows are: an ephemeral schema created on init and dropped on close. Booting a PGlite
  // per test cost ~300ms around single-digit ms of actual work, which is most of the conformance
  // run. Booted here rather than inside the first test so no single test wears the cost and the
  // test runner's resource sanitizer has nothing to attribute. Isolation is unchanged in the way
  // that matters (fresh tables per test); what a test no longer gets is a virgin *database*, so a
  // suite that needs one (anything asserting over a server-wide catalog) should construct its own
  // `PgliteAdapter()`, as `planner.test.ts` does.
  const sharedPglite = new PGlite();
  await sharedPglite.query("select 1"); // PGlite is lazy: force the boot out here
  adapters.push({
    name: "pglite",
    create: () =>
      new PgliteAdapter(undefined, {
        instance: sharedPglite,
        schema: `radia_conf_${newUlid()}`,
        ephemeral: true,
      }),
  });
}

if (wanted("sqlite")) {
  adapters.push({ name: "sqlite", create: () => new SqliteAdapter(":memory:") });
}

// Opt-in Postgres: set RADIA_PG_URL=postgres://user:pass@host:5432/db (see agent_docs/design-storage.md).
const pgUrl = Deno.env.get("RADIA_PG_URL");
if (pgUrl && wanted("postgres")) {
  adapters.push({
    name: "postgres",
    create: () => new PostgresAdapter(pgUrl, { schema: `radia_conf_${newUlid()}`, ephemeral: true }),
  });
}
