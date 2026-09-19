// What produced a number: printed as a header by every bench entry point, so a table pasted into
// bench/README.md or an issue says which commit, runtime, machine and database it came from.
//
// Best effort, field by field. A field the process has no permission for, or a platform that does
// not expose it, prints `?` rather than failing the run: a bench that refuses to start over a
// missing CPU model loses the measurement to save the label.

import { DatabaseSync } from "node:sqlite";
import { cpus } from "node:os";

async function git(...args: string[]): Promise<string | undefined> {
  try {
    const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : undefined;
  } catch {
    return undefined;
  }
}

function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Through `node:os` (`--allow-sys=cpus`): Deno 2 treats `/proc/cpuinfo` as a privileged path
 *  that only `--allow-all` may read. */
function cpuModel(): string | undefined {
  return attempt(() => cpus()[0]?.model?.trim());
}

/** Commit, runtime, OS and machine, one `key: value` per line. */
export async function benchEnv(): Promise<string[]> {
  const commit = await git("rev-parse", "--short", "HEAD");
  // Uncommitted changes are exactly what a before/after comparison measures, so say so rather than
  // letting the table claim a commit it did not run.
  const dirty = commit ? ((await git("status", "--porcelain", "--untracked-files=no")) ? " (+uncommitted changes)" : "") : "";
  const mem = attempt(() => Deno.systemMemoryInfo().total);
  return [
    `commit:  ${commit ?? "?"}${dirty}`,
    `deno:    ${Deno.version.deno} (v8 ${Deno.version.v8}, ts ${Deno.version.typescript})`,
    `os:      ${Deno.build.os} ${attempt(() => Deno.osRelease()) ?? "?"} ${Deno.build.arch}`,
    `cpu:     ${cpuModel() ?? "?"} x ${navigator.hardwareConcurrency}`,
    `memory:  ${mem ? `${(mem / 2 ** 30).toFixed(1)} GiB` : "?"}`,
  ];
}

/** The SQLite library `node:sqlite` is linked against. */
export function sqliteVersion(): string {
  const db = new DatabaseSync(":memory:");
  try {
    return (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
  } finally {
    db.close();
  }
}

/** A Postgres-dialect adapter's server version and the settings that decide what a write costs.
 *  Reaches the adapter's protected `sql` handle, which is a bench's privilege and nobody else's. */
export async function postgresSettings(adapter: unknown): Promise<string> {
  const sql = (adapter as { sql: { query<R>(q: string): Promise<{ rows: R[] }> } }).sql;
  const r = (await sql.query<Record<string, string>>(
    "select current_setting('server_version') as version, current_setting('fsync') as fsync, " +
      "current_setting('synchronous_commit') as sync, current_setting('shared_buffers') as buffers",
  )).rows[0];
  return `postgres ${r.version}, fsync=${r.fsync}, synchronous_commit=${r.sync}, shared_buffers=${r.buffers}`;
}
