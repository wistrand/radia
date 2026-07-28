// `radia` entry point. Dispatches to `dev` (embedded space + console), `mcp` (stdio adapter),
// or a CLI verb over the public API. This is the ONLY module in `src/` that terminates the
// process: everything below it returns a status or throws `UsageError`, so nothing is
// untestable or able to kill a caller mid-operation. Platform access goes through `host.ts`.

import { PgliteAdapter } from "./storage/pglite.ts";
import { SqliteAdapter } from "./storage/sqlite.ts";
import { PostgresAdapter } from "./storage/postgres.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { FileBlobStore, MemoryBlobStore } from "./storage/blobs.ts";
import { BlobCipher, loadKek } from "./storage/crypto.ts";
import { Space } from "./core/space.ts";
import { startServer } from "./server/http.ts";
import { clearCredential, saveCredential } from "./credentials.ts";
import { runCli } from "./cli.ts";
import { runMcp } from "./mcp/server.ts";
import { flag } from "./flags.ts";
import { args as argv, env, exit, onShutdown, UsageError } from "./platform.ts";

const USAGE = `radia <command>

  dev [--port <n>] [--host <addr>] [--storage pglite|sqlite|postgres] [--db <path|url>]
      [--blobs <dir>] [--blob-kek <file>] [--auth required|open] [--artifact-port <n>]
      Run an embedded space + web console.
  mcp [--url <base>]
      Serve the space to an MCP-capable harness over stdio.
  <cli command>
      Everything else is a verb over the public /v0 API. Those verbs are listed below.`;

async function dev(args: string[]): Promise<void> {
  const port = Number(flag(args, "--port") ?? "7788");
  // Loopback by default: the no-header operator default is only safe locally. --host 0.0.0.0 exposes.
  const host = flag(args, "--host") ?? "127.0.0.1";
  const backend = flag(args, "--storage") ?? "pglite";
  // --db persists to disk: a file for sqlite, a data directory for pglite. Omit = in-memory.
  // For --storage postgres, --db is the connection URL (or set RADIA_PG_URL).
  const dbPath = flag(args, "--db");
  // Artifact bytes get their own ORIGIN (see startServer): a second port is a different origin to
  // a browser, so generated content cannot reach the console. `--artifact-port 0` disables it and
  // artifacts stay downloads from the main origin.
  const artifactPortArg = flag(args, "--artifact-port");
  const artifactPort = artifactPortArg === "0" ? undefined : Number(artifactPortArg ?? String(port + 1));
  if (artifactPort !== undefined && !Number.isFinite(artifactPort)) {
    throw new UsageError(`--artifact-port must be a number (or 0 to disable), got '${artifactPortArg}'`);
  }
  // REQUIRED by default. The open-mode no-header shortcut resolves a credential-less request to
  // `human:local`, the operator: the largest authority a space has, handed out for typing nothing.
  // Defaulting to it meant every space started life fully open and stayed that way unless someone
  // knew the flag. `--auth open` is still there for a throwaway local space and for `curl`, but it
  // is now a decision someone makes rather than the state they land in.
  const authMode = flag(args, "--auth") ?? "required";
  if (authMode !== "open" && authMode !== "required") {
    throw new UsageError(`unknown --auth: ${authMode} (expected open|required)`);
  }
  const authRequired = authMode === "required";

  let storage: StorageAdapter;
  if (backend === "pglite") storage = new PgliteAdapter(dbPath);
  else if (backend === "sqlite") storage = new SqliteAdapter(dbPath); // undefined -> :memory:
  else if (backend === "postgres") {
    const url = dbPath ?? env("RADIA_PG_URL");
    if (!url) {
      throw new UsageError("--storage postgres needs a connection URL: --db postgres://… or RADIA_PG_URL");
    }
    storage = new PostgresAdapter(url);
  } else {
    throw new UsageError(`unknown --storage: ${backend} (expected pglite|sqlite|postgres)`);
  }

  await storage.init();
  const where = backend === "postgres" ? "shared server" : (dbPath ? `persisted at ${dbPath}` : "in-memory");
  console.log(`radia dev: storage=${storage.name} (${where})`);
  // Artifact BYTES live beside the data they belong to: a directory next to --db (or --blobs), and
  // in memory otherwise, since an ephemeral space must not leave blobs behind on disk. `--blobs` is what
  // a postgres deployment uses, since its --db is a connection URL with no local home.
  const blobDir = flag(args, "--blobs") ?? (backend !== "postgres" && dbPath ? `${dbPath}-blobs` : undefined);
  // Encryption at rest is OPT-IN and only as strong as where the key lives: `RADIA_BLOB_KEK`
  // (base64, 32 bytes) is the real deployment path; `--blob-kek <file>` generates one on first use
  // for local work. A key file inside the blob directory protects nothing against someone who
  // copies the directory, so say so rather than implying otherwise.
  const kek = loadKek({ env: env("RADIA_BLOB_KEK"), file: flag(args, "--blob-kek") });
  const cipher = kek ? await BlobCipher.fromKey(kek.key) : undefined;
  const blobs = blobDir ? new FileBlobStore(blobDir, cipher) : new MemoryBlobStore(cipher);
  console.log(`radia dev: blobs=${blobs.name}${blobDir ? ` (${blobDir})` : " (in-memory)"}${kek ? ` (encrypted, KEK from ${kek.source})` : ""}`);
  const space = new Space(storage, {}, blobs);
  await space.loadKinds(); // restore persisted kind declarations
  const operatorToken = await space.mintOperatorToken(); // for the CLI, the MCP adapter and curl
  // Auto-provision: write the token where the CLI and MCP adapter look, so local tools present a
  // real Bearer token like any production client instead of relying on the no-header shortcut.
  const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const saved = saveCredential(base, { token: operatorToken, mintedAt: new Date().toISOString(), storage: storage.name });
  if (saved.ok) console.log(`radia dev: operator credential provisioned at ${saved.path} (radia <cmd> and radia mcp use it)`);
  else console.log(`radia dev: could not write ${saved.path} (${saved.error}). Set RADIA_TOKEN to use the CLI`);
  // The console requires a credential in EVERY mode, not only `--auth required`, so print one
  // unconditionally. It used to be shown only in required mode, which left the operator hunting
  // for a token the sign-in screen asks for.
  // The console and `curl` both need this; the CLI and MCP adapter read the file above instead.
  console.log(`radia dev: operator token (console sign-in, curl): ${operatorToken}`);
  if (!authRequired) {
    console.log(`radia dev: --auth open. A request with no Authorization header is the OPERATOR.`);
  }
  // Shut down on a signal instead of being killed mid-flight, so the cleanup below actually runs.
  // Without this, Ctrl-C or SIGTERM leaves a dead token on disk and the next CLI call 401s with
  // no explanation.
  const stopping = new AbortController();
  const unlisten = onShutdown(() => stopping.abort());

  try {
    const { finished } = startServer({ port, space, host, authRequired, artifactPort, signal: stopping.signal });
    await finished;
  } finally {
    unlisten();
    // The token dies with the process (operator tokens are never persisted as records), so leaving
    // it on disk would only mislead the next CLI invocation into a 401.
    clearCredential(base);
    await storage.close();
  }
}

/** Dispatch one command, returning its exit code. Kept separate from the exit below so the whole
 *  entry point is callable from a test or an embedding process without terminating it. */
async function main(argsIn: string[]): Promise<number> {
  const [cmd, ...rest] = argsIn;
  try {
    switch (cmd) {
      case "dev":
        await dev(rest);
        return 0;
      case "mcp":
        await runMcp(rest);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        // Print BOTH: the launcher's commands and the CLI verbs. Stopping at USAGE leaves the
        // CLI's own help (the only place the verbs and their flags are documented) unreachable
        // behind a pointer back to this text.
        console.log(USAGE);
        console.log("");
        return await runCli("help", rest);
      default:
        // Everything else is a CLI verb over the public API.
        return await runCli(cmd, rest);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

exit(await main(argv()));
