// `radia` CLI entry. M0 ships one command: `dev` — an embedded, single-process space.
// Storage backend selectable via --storage (default: pglite); both embedded adapters are
// wired so the dev space can run on either.

import { PgliteAdapter } from "./storage/pglite.ts";
import { SqliteAdapter } from "./storage/sqlite.ts";
import { PostgresAdapter } from "./storage/postgres.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { Space } from "./core/space.ts";
import { startServer } from "./server/http.ts";
import { clearCredential, saveCredential } from "./credentials.ts";
import { runCli } from "./cli.ts";
import { runMcp } from "./mcp/server.ts";

const USAGE = `radia <command>

  dev [--port <n>] [--host <addr>] [--storage pglite|sqlite|postgres] [--db <path|url>] [--auth open|required]
      Run an embedded space + web console.
  mcp [--url <base>]
      Serve the space to an MCP-capable harness over stdio.
  <cli command>
      health | stats | doctor | kinds | put | query | get | take | ack | nack | release
      | events | watch | lineage | children     (run \`radia help\` for details)`;

async function dev(args: string[]): Promise<void> {
  const port = Number(flag(args, "--port") ?? "7788");
  // Loopback by default: the no-header operator default is only safe locally. --host 0.0.0.0 exposes.
  const host = flag(args, "--host") ?? "127.0.0.1";
  const backend = flag(args, "--storage") ?? "pglite";
  // --db persists to disk: a file for sqlite, a data directory for pglite. Omit = in-memory.
  // For --storage postgres, --db is the connection URL (or set RADIA_PG_URL).
  const dbPath = flag(args, "--db");
  const authMode = flag(args, "--auth") ?? "open";
  if (authMode !== "open" && authMode !== "required") {
    console.error(`unknown --auth: ${authMode} (expected open|required)`);
    Deno.exit(2);
  }
  const authRequired = authMode === "required";

  let storage: StorageAdapter;
  if (backend === "pglite") storage = new PgliteAdapter(dbPath);
  else if (backend === "sqlite") storage = new SqliteAdapter(dbPath); // undefined -> :memory:
  else if (backend === "postgres") {
    const url = dbPath ?? Deno.env.get("RADIA_PG_URL");
    if (!url) {
      console.error("--storage postgres needs a connection URL: --db postgres://… or RADIA_PG_URL");
      Deno.exit(2);
    }
    storage = new PostgresAdapter(url);
  } else {
    console.error(`unknown --storage: ${backend} (expected pglite|sqlite|postgres)`);
    Deno.exit(2);
  }

  await storage.init();
  const where = backend === "postgres" ? "shared server" : (dbPath ? `persisted at ${dbPath}` : "in-memory");
  console.log(`radia dev: storage=${storage.name} (${where})`);
  const space = new Space(storage);
  await space.loadKinds(); // restore persisted kind declarations
  await space.loadCredentials(); // rebuild the credential index from agent_definition/agent_run records
  const operatorToken = await space.mintOperatorToken(); // the bundled console authenticates with this
  // Auto-provision: write the token where the CLI and MCP adapter look, so local tools present a
  // real Bearer token like any production client instead of relying on the no-header shortcut.
  const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const saved = saveCredential(base, { token: operatorToken, mintedAt: new Date().toISOString(), storage: storage.name });
  if (saved.ok) console.log(`radia dev: operator credential provisioned at ${saved.path} (radia <cmd> and radia mcp use it)`);
  else console.log(`radia dev: could not write ${saved.path} (${saved.error}) — set RADIA_TOKEN to use the CLI`);
  if (authRequired) {
    // In required mode the no-header shortcut is gone, so hand the operator a credential for curl.
    // (The bundled console still bootstraps: GET / stays public and carries this token baked in.)
    console.log(`radia dev: --auth required — operator credential: Authorization: Bearer ${operatorToken}`);
  }
  // Shut down on a signal instead of being killed mid-flight, so the cleanup below actually runs.
  // Without this, Ctrl-C or SIGTERM leaves a dead token on disk and the next CLI call 401s with
  // no explanation. SIGTERM is not available on Windows; SIGINT is.
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const sig of signals) Deno.addSignalListener(sig, stop);

  try {
    const { finished } = startServer({ port, space, host, authRequired, operatorToken, signal: stopping.signal });
    await finished;
  } finally {
    for (const sig of signals) Deno.removeSignalListener(sig, stop);
    // The token dies with the process (operator tokens are never persisted as records), so leaving
    // it on disk would only mislead the next CLI invocation into a 401.
    clearCredential(base);
    await storage.close();
  }
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
  case "mcp":
    await runMcp(rest);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    // Everything else is a CLI verb over the public API. Unknown verbs exit non-zero from there.
    Deno.exit(await runCli(cmd, rest));
}
