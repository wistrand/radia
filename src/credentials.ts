// Auto-provisioned local credentials (Phase 7). `radia dev` mints a real operator token at
// startup and writes it here; the CLI and the MCP adapter read it. The point is that a local
// developer gets the SAME API shape as production — an `Authorization: Bearer <token>` on every
// request — instead of a "no tokens locally" special case that then breaks on first deploy.
//
// The no-header operator default in `--auth open` still exists for curl and the browser console,
// but nothing radia ships relies on it: the CLI and MCP adapter always present a token.
//
// The file is per-user, 0600, and keyed by base URL so several spaces can run side by side.
// Tokens are server-lifetime (operator tokens are not persisted as records — see
// `CredentialStore`), so the entry is rewritten on every `radia dev` start and removed on a
// clean shutdown. A stale entry simply fails to resolve, which is a 401, not a silent downgrade.

import { dirname, join } from "@std/path";
import { env, mkdirp, readTextFile, removeFile, restrictToOwner, writeTextFile } from "./platform.ts";

export interface StoredCredential {
  token: string;
  mintedAt: string;
  /** Informational: which storage the space was running on when this was written. */
  storage?: string;
}

type CredentialFile = Record<string, StoredCredential>;

/**
 * Per-user credential file. Honors `RADIA_CREDENTIALS` (explicit override), then the platform
 * convention: `$XDG_STATE_HOME/radia`, `%APPDATA%\radia`, else `~/.radia`.
 */
export function credentialsPath(): string {
  const explicit = env("RADIA_CREDENTIALS");
  if (explicit) return explicit;
  const xdg = env("XDG_STATE_HOME");
  if (xdg) return join(xdg, "radia", "credentials.json");
  const appData = env("APPDATA");
  if (appData) return join(appData, "radia", "credentials.json");
  const home = env("HOME") ?? env("USERPROFILE");
  if (home) return join(home, ".radia", "credentials.json");
  return join(".", ".radia-credentials.json");
}

function read(path: string): CredentialFile {
  const text = readTextFile(path);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CredentialFile : {};
  } catch {
    return {}; // corrupt: start clean rather than fail the command
  }
}

/** Normalize a base URL to a stable key ("http://127.0.0.1:7788", no trailing slash). */
export function baseKey(base: string): string {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** Write (or replace) the credential for a base URL. Best-effort: a read-only home directory
 *  must not stop the server from booting, so failures are reported, not thrown. */
export function saveCredential(base: string, cred: StoredCredential): { path: string; ok: boolean; error?: string } {
  const path = credentialsPath();
  try {
    mkdirp(dirname(path));
    const all = read(path);
    all[baseKey(base)] = cred;
    writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
    restrictToOwner(path);
    return { path, ok: true };
  } catch (e) {
    return { path, ok: false, error: (e as Error).message };
  }
}

/** Drop a base URL's credential (clean shutdown), removing the file once it is empty. */
export function clearCredential(base: string): void {
  const path = credentialsPath();
  try {
    const all = read(path);
    delete all[baseKey(base)];
    if (Object.keys(all).length === 0) removeFile(path);
    else writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
  } catch { /* nothing to clean up */ }
}

/**
 * Resolve the token a client should present, in precedence order:
 *   1. `RADIA_TOKEN` — explicit, wins (CI, a scoped run token, a remote space).
 *   2. the stored credential for this base URL — what `radia dev` provisioned.
 *   3. none — the caller falls back to the no-header operator default of an open local space.
 */
export function resolveToken(base: string): string | undefined {
  const explicit = env("RADIA_TOKEN");
  if (explicit) return explicit;
  return read(credentialsPath())[baseKey(base)]?.token;
}

/** Default base URL for clients: `RADIA_URL`, else the `radia dev` default. */
export function defaultBase(): string {
  return env("RADIA_URL") ?? "http://127.0.0.1:7788";
}
