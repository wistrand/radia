// `radia` CLI entry. M0 ships one command: `dev` — an embedded, single-process space.
// Storage backend selectable via --storage (default: pglite); both embedded adapters are
// wired so the dev space can run on either.

import { PgliteAdapter } from "./storage/pglite.ts";
import { SqliteAdapter } from "./storage/sqlite.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { Space } from "./core/space.ts";
import { startServer } from "./server/http.ts";

const USAGE = `radia dev [--port <n>] [--storage pglite|sqlite] [--db <path>]`;

async function dev(args: string[]): Promise<void> {
  const port = Number(flag(args, "--port") ?? "7788");
  const backend = flag(args, "--storage") ?? "pglite";
  // --db persists to disk: a file for sqlite, a data directory for pglite. Omit = in-memory.
  const dbPath = flag(args, "--db");

  let storage: StorageAdapter;
  if (backend === "pglite") storage = new PgliteAdapter(dbPath);
  else if (backend === "sqlite") storage = new SqliteAdapter(dbPath); // undefined -> :memory:
  else {
    console.error(`unknown --storage: ${backend} (expected pglite|sqlite)`);
    Deno.exit(2);
  }

  await storage.init();
  console.log(`radia dev: storage=${storage.name} (${dbPath ? `persisted at ${dbPath}` : "in-memory"})`);
  const space = new Space(storage);
  await space.loadKinds(); // restore persisted kind declarations
  await space.loadCredentials(); // rebuild the credential index from agent_definition/agent_run records
  const { finished } = startServer({ port, space });
  await finished;
  await storage.close();
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const [cmd, ...rest] = Deno.args;
switch (cmd) {
  case "dev":
    await dev(rest);
    break;
  default:
    console.error(`usage: ${USAGE}`);
    Deno.exit(1);
}
