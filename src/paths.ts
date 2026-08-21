// Where a space keeps its runtime state on disk. One directory, `.radia/`, and one module that
// says so.
//
// These paths used to be string literals at each call site, which is how they ended up as four
// separate top-level entries in a project: `.radia-blobs/`, `.radia-kek.json`,
// `.radia-chat-space.db` and `.radia-chat-space.db-blobs/`. Nothing decided that; each was named
// where it was needed and the set was never looked at as a whole.
//
// The rule now: anything a running space WRITES goes under `.radia/`, so one directory is the whole
// footprint. Deleting it resets local state and leaves nothing behind. `RADIA_DIR` moves it.
//
// NOT here: the per-user credential file (`src/credentials.ts`). That is keyed by base URL and
// shared by every space a user runs, so it belongs to the user (`~/.radia/credentials.json`), not to
// a project directory. Two things called `.radia` is a little unfortunate; the alternative is a
// credential that vanishes when you `rm -rf` a checkout, which is worse.

import { dirname, join } from "@std/path";
import { env, mkdirp } from "./platform.ts";

/** The project-local runtime directory. `RADIA_DIR` overrides; otherwise `./.radia`. */
export function radiaDir(): string {
  return env("RADIA_DIR") ?? ".radia";
}

/** Default embedded-storage path: a file for sqlite, a data directory for pglite. */
export function defaultDbPath(backend: string): string {
  return join(radiaDir(), backend === "sqlite" ? "space.db" : "space-pg");
}

/**
 * Default artifact-blob directory.
 *
 * Beside the data it belongs to when there is a local database (`<db>-blobs`), which keeps a space's
 * bytes and its records together even when someone points `--db` outside `.radia/`. Postgres has no
 * local home for them, so they land in the runtime directory.
 */
export function defaultBlobDir(dbPath: string | undefined): string {
  return dbPath ? `${dbPath}-blobs` : join(radiaDir(), "blobs");
}

/**
 * Default space KEK file, when `--blob-kek` is passed with no path.
 *
 * A SIBLING of the blob directory, never inside it: the key decrypts every blob, so copying the
 * blobs alone must not carry it along. That property is why this is not simply `<blobs>/kek.json`.
 */
export function defaultKekPath(): string {
  return join(radiaDir(), "kek.json");
}

/**
 * Default event-chain signing key, when `--seal-key` is passed with no path.
 *
 * Beside the database, never inside it. That is the entire mechanism: a copied or restored database
 * does not carry the key, so a chain rebuilt from it cannot be signed and the forgery shows up as a
 * bad signature rather than as a chain that verifies perfectly.
 */
export function defaultSealPath(): string {
  return join(radiaDir(), "seal.json");
}

/**
 * The single-writer lock for a local database, a sibling of it like the blob directory.
 *
 * Beside the DATABASE rather than in the runtime directory, because the resource two processes
 * fight over is the database files: `--db` can point anywhere, and two spaces sharing a runtime
 * directory but not a database are fine.
 */
export function lockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

/**
 * Create the directory a path will be written into.
 *
 * SQLite will not create a missing parent, and neither will the KEK writer: pointing `--db` at
 * `.radia/space.db` before anything had made `.radia/` failed with "unable to open database file",
 * which reads as a permissions or corruption problem rather than a missing directory. Callers own
 * this rather than the getters above, because creating a directory is a side effect and a path
 * lookup should not have one.
 */
export function ensureParent(path: string): void {
  mkdirp(dirname(path));
}
