// `radia` entry point. Dispatches to `dev` (embedded space + console), `mcp` (stdio adapter),
// or a CLI verb over the public API. This is the ONLY module in `src/` that terminates the
// process: everything below it returns a status or throws `UsageError`, so nothing is
// untestable or able to kill a caller mid-operation. Platform access goes through `host.ts`.

import { PgliteAdapter } from "./storage/pglite.ts";
import { SqliteAdapter } from "./storage/sqlite.ts";
import { PostgresAdapter } from "./storage/postgres.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { openBlobs } from "./storage/blobspec.ts";
import { BlobCipher, loadKek } from "./storage/crypto.ts";
import { loadSealKey } from "./core/seal.ts";
import { Space } from "./core/space.ts";
import { startServer } from "./server/http.ts";
import { clearCredential, OBSERVER_PRINCIPAL, provisionObserver, saveCredential } from "./credentials.ts";
import { runCli } from "./surfaces/cli.ts";
import { runMcp } from "./surfaces/mcp/server.ts";
import { flag, optionalFlag } from "./flags.ts";
import { defaultBlobDir, defaultDbPath, defaultKekPath, defaultSealPath, ensureParent, radiaDir } from "./paths.ts";
import { args as argv, env, exit, onShutdown, UsageError } from "./platform.ts";

const USAGE = `radia <command>

  dev [--port <n>] [--host <addr>] [--storage pglite|sqlite|postgres] [--db [path|url]]
      [--blobs <dir|memory|s3://bucket/prefix>[,<read-only origin>…]]
      [--blob-kek [file]] [--seal-key [file]] [--auth required|open]
      [--artifact-port <n>] [--max-scan-rows <n>] [--event-retention <seconds>]
      [--oidc-issuer <url> --oidc-audience <client-id>]
      Run an embedded space + web console. Everything it writes goes under ./.radia
      (RADIA_DIR moves it); bare --db and --blob-kek take their defaults from there.
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
  //
  // `--db` with no value means "persist, you pick where", which is `.radia/` (see src/paths.ts).
  // That is the shape most people want and the one that used to require knowing a path convention
  // nothing documented, so everyone invented their own and the project root filled up.
  const dbFlag = optionalFlag(args, "--db");
  const dbPath = dbFlag === "" ? defaultDbPath(backend) : dbFlag;
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

  // Make the parent exist before anything tries to write into it. Neither SQLite nor the KEK writer
  // creates one, and the resulting error names the file rather than the missing directory.
  if (backend !== "postgres" && dbPath) ensureParent(dbPath);

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
  const where = backend === "postgres" ? "shared server" : (dbPath ? `persisted at ${dbPath}` : "in-memory (--db to persist)");
  console.log(`radia dev: storage=${storage.name} (${where})`);
  // Artifact BYTES live beside the data they belong to: a directory next to --db (or wherever
  // --blobs says), and in memory otherwise, since an ephemeral space must not leave blobs behind on
  // disk. `--blobs` is what a postgres deployment uses, since its --db is a connection URL with no
  // local home, and a horizontal one needs a store every instance shares (`s3://…`; see
  // storage/blobspec.ts for the spec and design-storage.md for why a local directory is not one).
  const blobSpec = flag(args, "--blobs") ??
    (backend === "postgres" ? undefined : (dbPath ? defaultBlobDir(dbPath) : undefined));
  // Encryption at rest is OPT-IN and only as strong as where the key lives: `RADIA_BLOB_KEK`
  // (base64, 32 bytes) is the real deployment path; `--blob-kek <file>` generates one on first use
  // for local work. A key file inside the blob directory protects nothing against someone who
  // copies the directory, so say so rather than implying otherwise.
  // `--blob-kek` with no path generates one at the default location, so turning encryption on does
  // not also require choosing where the key lives (and putting it somewhere it should not be).
  const kekFlag = optionalFlag(args, "--blob-kek");
  const kekPath = kekFlag === "" ? defaultKekPath() : kekFlag;
  if (kekPath) ensureParent(kekPath);
  const kek = loadKek({ env: env("RADIA_BLOB_KEK"), file: kekPath, retiredEnv: env("RADIA_BLOB_KEK_RETIRED") });
  // Retired keys READ, never write. Rotation is otherwise a migration rather than a config
  // change: a blob's storage name is HMAC(KEK, digest), so a new key renames every payload and
  // a sweep that cannot recognise the old names would delete what it cannot see.
  const cipher = kek ? await BlobCipher.fromKey(kek.key, kek.retired) : undefined;
  const blobs = openBlobs(blobSpec, cipher);
  console.log(`radia dev: blobs=${blobs.name}${blobSpec ? ` (${blobSpec})` : " (in-memory)"}${kek ? ` (encrypted, KEK from ${kek.source})` : ""}`);
  // One line naming the whole on-disk footprint, so "where did this write?" never needs archaeology.
  if (dbPath || blobSpec || kek) console.log(`radia dev: runtime dir=${radiaDir()}`);
  // The one resource limit a deployment genuinely has to tune, and the first `SpaceContext` value
  // this entry point passes at all: it bounds the rows ONE read may push through the oracle when
  // the pre-filter could not decide the pattern (`storage/pushdown.ts`). Measured at 5.5M records,
  // the default refuses such a query in ~2.5s (`bench/deployment.ts`).
  //
  // Both directions are real. Raise it for a space whose operators legitimately run a big
  // undecidable scan and would rather wait; lower it on a small machine, or where no read should
  // ever cost that much. `0` means unbounded, which is the pre-budget behaviour and is offered
  // because a benchmark or a migration sometimes wants exactly that — it is not a setting to run a
  // shared space on.
  const scanFlag = flag(args, "--max-scan-rows");
  const maxScanRows = scanFlag === undefined ? undefined : Number(scanFlag);
  if (maxScanRows !== undefined && (!Number.isInteger(maxScanRows) || maxScanRows < 0)) {
    throw new UsageError(`--max-scan-rows must be a non-negative whole number (0 = unbounded), got '${scanFlag}'`);
  }
  // Event-log retention is OPT-IN: absent, the log is never truncated and the evidence promise
  // stays unqualified. Weeks, not hours (plan-gc.md phase 3): the window must dwarf any watch
  // reconnect gap, since a client sleeping past it gets a 410 and must re-sync by query.
  const evFlag = flag(args, "--event-retention");
  const eventRetentionSeconds = evFlag === undefined ? undefined : Number(evFlag);
  if (eventRetentionSeconds !== undefined && (!Number.isInteger(eventRetentionSeconds) || eventRetentionSeconds < 0)) {
    throw new UsageError(`--event-retention must be a non-negative whole number of seconds, got '${evFlag}'`);
  }
  // OIDC is OPT-IN and takes both halves: the issuer says who signs, the audience says which
  // client the token was minted for (`aud` — the client id for plain OIDC, an API identifier on
  // Auth0-style setups). One without the other verifies nothing, so it is a usage error.
  const oidcIssuer = flag(args, "--oidc-issuer");
  const oidcAudience = flag(args, "--oidc-audience");
  if ((oidcIssuer === undefined) !== (oidcAudience === undefined)) {
    throw new UsageError("--oidc-issuer and --oidc-audience must be given together");
  }
  const space = new Space(storage, {
    ...(maxScanRows === undefined ? {} : { maxScanRows }),
    ...(eventRetentionSeconds === undefined ? {} : { eventRetentionSeconds }),
    ...(oidcIssuer && oidcAudience ? { oidc: { issuer: oidcIssuer, audience: oidcAudience } } : {}),
  }, blobs);
  if (oidcIssuer && oidcAudience) {
    console.log(`radia dev: OIDC sign-in enabled (issuer ${oidcIssuer}, audience ${oidcAudience})`);
  }
  if (eventRetentionSeconds !== undefined) {
    console.log(`radia dev: event-log retention ${eventRetentionSeconds}s (gc truncates the sealed log to this window)`);
  }
  if (maxScanRows !== undefined) {
    console.log(
      `radia dev: scan budget ${maxScanRows === 0 ? "DISABLED: one undecidable pattern can walk a whole kind" : `${maxScanRows} rows per read`}`,
    );
  }
  // The event chain is signed under a key that does NOT live in the database, which is the whole
  // difference between "detects corruption" and "detects a rewrite": an attacker who can edit rows
  // can recompute every hash, and cannot forge the seals over them. Same shape as the blob KEK, and
  // ON by default for a persisted space, because a chain nobody enabled protects nothing.
  const sealFlag = optionalFlag(args, "--seal-key");
  const sealPath = sealFlag === "" ? defaultSealPath() : (sealFlag ?? (dbPath ? defaultSealPath() : undefined));
  if (sealPath) ensureParent(sealPath);
  space.sealKey = await loadSealKey({ env: env("RADIA_SEAL_KEY"), file: sealPath, retiredEnv: env("RADIA_SEAL_KEY_RETIRED") });
  if (space.sealKey) console.log(`radia dev: event chain signed (key from ${space.sealKey.source})`);
  await space.loadKinds(); // restore persisted kind declarations
  const operatorToken = await space.mintOperatorToken(); // for the CLI, the MCP adapter and curl
  const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  // Shut down on a signal instead of being killed mid-flight, so the cleanup below actually runs.
  // Without this, Ctrl-C or SIGTERM leaves a dead token on disk and the next CLI call 401s with
  // no explanation.
  const stopping = new AbortController();
  const unlisten = onShutdown(() => stopping.abort());

  try {
    const { finished } = startServer({ port, space, host, authRequired, artifactPort, signal: stopping.signal });
    // Bind succeeded (`Deno.serve` throws synchronously on a taken port), so only NOW touch the
    // shared credential file: a second dev aimed at an occupied base used to overwrite the running
    // space's operator entry before losing the port race, then delete it in the finally below.
    // Auto-provision: write the token where the CLI and MCP adapter look, so local tools present a
    // real Bearer token like any production client instead of relying on the no-header shortcut.
    const saved = saveCredential(base, { token: operatorToken, mintedAt: new Date().toISOString(), storage: storage.name });
    if (saved.ok) console.log(`radia dev: operator credential provisioned at ${saved.path} (destructive radia verbs use it)`);
    else console.log(`radia dev: could not write ${saved.path} (${saved.error}). Set RADIA_TOKEN to use the CLI`);
    // The OBSERVER credential (architecture-ops-tiers.md phase 5): an `agent:local-observer` definition
    // holding the `observe` ops power. The MCP adapter and read-only CLI verbs prefer it, so a
    // model harness inspects the space without holding the operator bit; coordination through MCP
    // 403s until an operator grants kinds. The DEFINITION token is what lands on disk (mint-only,
    // revocable via `radia revoke agent:local-observer`), reused across restarts. The power is
    // assigned at mint and never re-put on reuse; see `provisionObserver` for why a re-put would
    // eventually resurrect a retired power.
    try {
      const r = await provisionObserver(space, base, storage.name);
      console.log(`radia dev: observer credential ${r.created ? "provisioned" : "reused"} (${OBSERVER_PRINCIPAL}: ops reads only; radia mcp defaults to it)`);
    } catch (e) {
      console.log(`radia dev: could not provision the observer credential (${(e as Error).message}); radia mcp will fall back to the operator token`);
    }
    // The console requires a credential in EVERY mode, not only `--auth required`, so print one
    // unconditionally. The console and `curl` both need this; the CLI and MCP adapter read the
    // file above instead.
    console.log(`radia dev: operator token (console sign-in, curl): ${operatorToken}`);
    if (!authRequired) {
      console.log(`radia dev: --auth open. A request with no Authorization header is the OPERATOR.`);
    }
    await finished;
  } finally {
    unlisten();
    // The token dies with the process (operator tokens are never persisted as records), so leaving
    // it on disk would only mislead the next CLI invocation into a 401. Conditional on the entry
    // still being OURS: another dev on this base may have replaced it since.
    clearCredential(base, operatorToken);
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
