// The list of adapters every conformance suite runs against. Both embedded adapters ship
// in M0; the Postgres adapter (M1) is added here with no change to any suite.

import { PgliteAdapter } from "../src/storage/pglite.ts";
import { SqliteAdapter } from "../src/storage/sqlite.ts";
import type { AdapterFactory } from "./harness.ts";

export const adapters: AdapterFactory[] = [
  { name: "pglite", create: () => new PgliteAdapter() }, // in-memory
  { name: "sqlite", create: () => new SqliteAdapter(":memory:") },
];
