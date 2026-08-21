// Single-writer enforcement for a local database.
//
// PGlite is a single-writer WASM Postgres with no locking of its own: two `radia dev` processes on
// one data directory both start, serve private copies of the data, both report a healthy chain at
// different heads, and the last to exit wins the files. Tamper evidence cannot catch it, because
// each process's own chain is internally consistent. SQLite locks its file and so degrades to
// errors rather than divergence, but it takes the same lock here: "two spaces, one directory" is
// refused in one place, whatever the backend's own behaviour is.
//
// The lock is an OS advisory lock (`platform.lockFile`), not a pid file, because the kernel
// releases it when the holder dies: a SIGKILLed space leaves nothing stale to clean up or to
// second-guess. The file's CONTENT is only for the message the loser prints.

import { lockFile, pid, readTextFile, writeTextFile } from "./platform.ts";
import { lockPath } from "./paths.ts";

/** What the holder writes for whoever comes second. Advisory: a person reads it, nothing acts on it. */
export interface LockHolder {
  pid: number;
  base?: string;
  startedAt: string;
}

export type LockResult =
  | { ok: true; release(): void }
  | { ok: false; heldBy?: LockHolder };

/**
 * Take the exclusive start lock for `dbPath`, or report who holds it.
 *
 * `release()` closes the descriptor and deliberately leaves the FILE behind: unlinking it would let
 * a waiting process lock an inode nobody else can see, which is the one way to get two holders.
 * The stale content is harmless, since a holder overwrites it on the way in.
 */
export async function acquireDbLock(dbPath: string, base?: string, waitMs = 400): Promise<LockResult> {
  const path = lockPath(dbPath);
  const held = await lockFile(path, waitMs);
  if (!held) return { ok: false, heldBy: readHolder(path) };
  const holder: LockHolder = { pid: pid(), ...(base ? { base } : {}), startedAt: new Date().toISOString() };
  try {
    writeTextFile(path, JSON.stringify(holder));
  } catch { /* the lock is what protects the data; its label is a convenience */ }
  return { ok: true, release: held.release };
}

/** The holder's own description, or undefined when it is unwritten, truncated or half-written. */
export function readHolder(path: string): LockHolder | undefined {
  const text = readTextFile(path);
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as LockHolder;
    return typeof j?.pid === "number" ? j : undefined;
  } catch {
    return undefined;
  }
}

/** The refusal a person reads, naming the holder, the shared thing, and both ways out. */
export function lockRefusal(dbPath: string, heldBy?: LockHolder): string {
  const who = heldBy
    ? `pid ${heldBy.pid}${heldBy.base ? `, serving ${heldBy.base}` : ""}, started ${heldBy.startedAt}`
    : "another process";
  return `${dbPath} is already open by a running space (${who}). Two spaces on one database ` +
    `diverge silently rather than sharing it: stop that one, or start this one on a different ` +
    `--db (omit --db for an in-memory space).`;
}
