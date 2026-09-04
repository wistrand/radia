// Auto-provisioned local credentials (Phase 7). `radia dev` mints a real operator token at
// startup and writes it here; the CLI and the MCP adapter read it. The point is that a local
// developer gets the SAME API shape as production (an `Authorization: Bearer <token>` on every
// request) instead of a "no tokens locally" special case that then breaks on first deploy.
//
// The no-header operator default in `--auth open` still exists for curl and the browser console,
// but nothing radia ships relies on it: the CLI and MCP adapter always present a token.
//
// The file is per-user, 0600, and keyed by base URL so several spaces can run side by side.
// Tokens are server-lifetime (see `CredentialStore`: operator tokens are not persisted as
// records), so the entry is rewritten on every `radia dev` start and removed on a
// clean shutdown. A stale entry simply fails to resolve, which is a 401, not a silent downgrade.

import { dirname, join } from "@std/path";
import { env, mkdirp, readTextFile, removeFile, renameFile, restrictToOwner, withFileLockSync, writeTextFile } from "./platform.ts";
import { OPS_GRANT } from "../sdk/ts/wire.ts";
import { opsGrantKey } from "../sdk/ts/registry.ts";

export interface StoredCredential {
  token: string;
  mintedAt: string;
  /**
   * The DURABLE half, when there is one. A definition token cannot read or write anything (the
   * space refuses it for coordination); it can only mint a run token. So it is the piece worth
   * keeping on disk, and the piece that stops a person re-authenticating by hand every 15 minutes.
   *
   * Absent for `radia dev`'s operator credential, which is minted in memory at startup and dies
   * with the process, so it has nothing durable to store.
   */
  definitionToken?: string;
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
  return writeEntry(baseKey(base), cred);
}

/**
 * One entry of the credential file, replaced in place. Owner-only on the way out: the file holds
 * every credential this machine has for every space it talks to.
 *
 * LOCKED AND ATOMIC, because this file is written by every space that starts and read by every
 * verb, and a plain read-modify-write lost a laptop's operator credential: several spaces booting
 * at once each read the file, one of them read it half-written, `read` answered `{}` for the torn
 * JSON, and that writer put back a file holding its own entry and nothing else. So the whole
 * read-modify-write runs under an exclusive lock on a sibling `.lock` file, the new contents land
 * by rename so no reader ever sees a partial file, and a file that EXISTS but does not parse is
 * refused rather than replaced: "start clean" is a fine answer to a missing file and a
 * catastrophic one to a damaged file holding every other credential.
 */
function writeEntry(key: string, cred: StoredCredential): { path: string; ok: boolean; error?: string } {
  const path = credentialsPath();
  try {
    mkdirp(dirname(path));
    withFileLockSync(`${path}.lock`, () => {
      const text = readTextFile(path);
      let all: CredentialFile = {};
      if (text !== undefined && text.trim() !== "") {
        try {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          all = parsed as CredentialFile;
        } catch {
          throw new Error(`${path} exists but is not valid JSON; refusing to overwrite the other credentials in it. Move it aside to start over.`);
        }
      }
      all[key] = cred;
      const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
      writeTextFile(tmp, JSON.stringify(all, null, 2) + "\n");
      restrictToOwner(tmp);
      renameFile(tmp, path);
    });
    return { path, ok: true };
  } catch (e) {
    return { path, ok: false, error: (e as Error).message };
  }
}

// ---- pruning: the file grows, and nothing owned it ----
//
// Measured after four days of local work: 23KB, 57 entries, 43 distinct ports, 43 of them
// `#observer` definition tokens for spaces that no longer exist (plan-startup-ergonomics.md item
// 5). Entries are keyed by base URL, so an ephemeral-port space can never reuse one, and a clean
// shutdown removes only the operator entry.
//
// PRUNING IS NEVER A SIDE EFFECT of writing an entry, and never age alone: see `stale`.
//
// WHAT MAY BE DROPPED is the whole design: an operator or `#observer` entry is AUTO-PROVISIONED and
// regenerable by restarting `radia dev`, so losing one costs a restart. A `#login` durable half and
// a content key are neither: the first is a person's session and the second is the only copy of key
// material that opens their conversations. Those are never pruned, whatever their age.

/** How long an auto-provisioned entry survives without being rewritten. */
export const CREDENTIAL_STALE_DAYS = 14;

export type CredentialKind = "operator" | "observer" | "login" | "content-key" | "session";

/** Which identity an entry holds, from its key suffix. */
export function credentialKind(key: string): CredentialKind {
  if (key.endsWith(OBSERVER)) return "observer";
  if (key.includes(SESSION)) return "session";
  if (key.endsWith(LOGIN)) return "login";
  if (key.includes(CONTENT_KEY)) return "content-key";
  return "operator";
}

/**
 * A CANDIDATE for pruning: prunable kind, and old enough that nothing has rewritten it. An
 * unparseable `mintedAt` is not evidence of age, so it keeps the entry.
 *
 * Age alone is NOT permission to delete. An entry is rewritten only when a space STARTS, so a dev
 * that has been up for a month looks exactly like one that died a month ago, and deleting the
 * former leaves every operator verb answering 401 with nothing to point at. So this names
 * candidates and the caller checks whether anything still answers there (`radia credentials
 * --prune`), which is also why pruning is never a side effect of an unrelated write.
 */
function stale(key: string, cred: StoredCredential, nowMs: number): boolean {
  const kind = credentialKind(key);
  if (kind !== "operator" && kind !== "observer" && kind !== "session") return false;
  const at = Date.parse(cred?.mintedAt ?? "");
  return Number.isFinite(at) && nowMs - at > CREDENTIAL_STALE_DAYS * 86_400_000;
}

/** Every entry, for `radia credentials`. The token itself never leaves this module. */
export function listCredentials(): { key: string; kind: CredentialKind; mintedAt: string; durable: boolean; storage?: string; stale: boolean }[] {
  const all = read(credentialsPath());
  const nowMs = Date.now();
  return Object.entries(all).map(([key, cred]) => ({
    key,
    kind: credentialKind(key),
    mintedAt: cred?.mintedAt ?? "",
    durable: !!cred?.definitionToken,
    ...(cred?.storage ? { storage: cred.storage } : {}),
    stale: stale(key, cred, nowMs),
  }));
}

/** Delete these entries. The caller decides which, since only it can tell a dead space from a
 *  long-running one. Returns how many were actually there. */
export function removeCredentials(keys: string[]): { path: string; removed: number } {
  const path = credentialsPath();
  const all = read(path);
  let removed = 0;
  for (const key of keys) {
    if (key in all) {
      delete all[key];
      removed++;
    }
  }
  if (removed === 0) return { path, removed };
  try {
    if (Object.keys(all).length === 0) removeFile(path);
    else {
      writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
      restrictToOwner(path);
    }
  } catch { /* read-only home: reported as nothing removed rather than a crash */ }
  return { path, removed };
}

/** Drop a base URL's credential (clean shutdown), removing the file once it is empty.
 *  `onlyIfToken` makes the delete conditional on the entry still being the caller's own write:
 *  two dev processes aimed at one base share this file, and the loser of a port race must not
 *  take the running space's credential down with it. */
export function clearCredential(base: string, onlyIfToken?: string): void {
  const path = credentialsPath();
  try {
    const all = read(path);
    const key = baseKey(base);
    if (onlyIfToken !== undefined && all[key]?.token !== onlyIfToken) return;
    delete all[key];
    if (Object.keys(all).length === 0) removeFile(path);
    else writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
  } catch { /* nothing to clean up */ }
}

/**
 * Resolve the token a client should present, in precedence order:
 *   1. `RADIA_TOKEN`: explicit, wins (CI, a scoped run token, a remote space).
 *   2. the stored credential for this base URL, which `radia dev` provisioned.
 *   3. none, so the caller falls back to the no-header operator default of an open local space.
 */
export function resolveToken(base: string): string | undefined {
  const explicit = env("RADIA_TOKEN");
  if (explicit) return explicit;
  return read(credentialsPath())[baseKey(base)]?.token;
}

/**
 * The durable half for this base URL, if one was stored. `RADIA_DEFINITION_TOKEN` overrides, for
 * the same reasons `RADIA_TOKEN` does: CI, a remote space, a credential that never touches disk.
 *
 * Handed to `RadiaClient` alongside the run token so a client whose short credential lapses mints
 * another instead of ending the session. An explicit `RADIA_TOKEN` does NOT suppress it: the two
 * answer different questions, and a run token supplied by hand still expires in 15 minutes.
 */
export function resolveDefinitionToken(base: string): string | undefined {
  // `||`, not `??`: an EMPTY variable is an absent one. Wrapper scripts and harness configs set
  // every variable they know about, empty ones included, and `??` keeps `""` and hands it over as
  // a credential, so the stored one below is never consulted and every request 401s.
  return env("RADIA_DEFINITION_TOKEN") || read(credentialsPath())[baseKey(base)]?.definitionToken;
}

// ---- a person's login, kept apart from the operator's credential ----
//
// TWO IDENTITIES, ONE FILE. `radia dev` provisions an OPERATOR credential under the base URL, and
// `radia login` authenticates a PERSON against the same space. Storing both under one key means the
// second overwrites the first, and the CLI's operator verbs, the chat's bootstrap and the MCP
// adapter all start acting as whoever logged in last. So a login lives under its own suffix, the
// operator entry is untouched, and nothing reads a login unless it asked for one.

const LOGIN = "#login";

/** The most recent `radia login` for this space, if there was one. */
export function storedLogin(base: string): (StoredCredential & { principal?: string }) | undefined {
  return read(credentialsPath())[baseKey(base) + LOGIN];
}

/** Record a person's session: the run token they can paste, and the durable half that mints the
 *  next one. Last login wins, which is what a person means by logging in again. */
export function saveLogin(
  base: string,
  cred: StoredCredential & { principal: string },
): { path: string; ok: boolean; error?: string } {
  return writeEntry(baseKey(base) + LOGIN, cred);
}

// ---- a named SESSION's run, so restarting a session keeps its principal ----
//
// A run IS the principal that lands in `created_by`, so "the same agent session across restarts"
// means the same RUN across restarts. Nothing in a harness identifies a session portably, so the
// name is supplied (`radia mcp --session <name>`) rather than derived, and this is where it is
// remembered. Keyed per (space, name), so two sessions of one agent are two entries.
//
// PRUNABLE, like the operator and observer entries: a run can always be minted again from the
// definition token, and a run cannot outlive its 12h ceiling anyway, so an entry old enough to be
// swept names a run that stopped working long before.

const SESSION = "#session:";

/** The run a named session last held on this space, if it is still remembered. */
export function storedSession(base: string, name: string): StoredCredential | undefined {
  return read(credentialsPath())[baseKey(base) + SESSION + name];
}

/** Remember a named session's run, so the next start of that session is the same principal. */
export function saveSession(
  base: string,
  name: string,
  cred: StoredCredential,
): { path: string; ok: boolean; error?: string } {
  return writeEntry(baseKey(base) + SESSION + name, cred);
}

// ---- the observer credential, the safe default for the MCP adapter ----
//
// A third identity in the file (architecture-ops-tiers.md phase 5): `radia dev` provisions an
// `agent:local-observer` definition holding the `observe` ops power and nothing else. The MCP
// adapter prefers it, so the model behind a harness inspects the space and cannot write grants,
// coordinate ungranted, or destroy anything. What is stored is the DEFINITION token: mint-only,
// safe on disk, and revocable with `radia revoke agent:local-observer`, which the operator
// credential above never was.

const OBSERVER = "#observer";

/** The observer identity `radia dev` provisions. One well-known name, so an operator can
 *  `radia revoke agent:local-observer` or `radia permissions agent:local-observer` without
 *  looking anything up. */
export const OBSERVER_PRINCIPAL = "agent:local-observer";

/** The observer credential `radia dev` provisioned for this space, if any. */
export function storedObserver(base: string): StoredCredential | undefined {
  return read(credentialsPath())[baseKey(base) + OBSERVER];
}

/** Drop it, for a space that cannot come back: an in-memory `radia dev` is gone at shutdown, and
 *  its entry names a base URL nothing will ever answer on again. A PERSISTED space keeps its entry,
 *  because the identity record is still in its database and the next start reuses both. */
export function clearObserver(base: string): void {
  const path = credentialsPath();
  try {
    const all = read(path);
    delete all[baseKey(base) + OBSERVER];
    if (Object.keys(all).length === 0) removeFile(path);
    else writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
  } catch { /* nothing to clean up */ }
}

/** Record the observer credential (the definition token is the piece that matters). */
export function saveObserver(base: string, cred: StoredCredential): { path: string; ok: boolean; error?: string } {
  return writeEntry(baseKey(base) + OBSERVER, cred);
}

// ---- an app's per-person content key ----
//
// A slot, not a feature: key material an APP wraps its own payloads with (the chat's per-person
// conversation wrap, agent_docs/plan-encryption.md). The runtime never reads it and holds no copy;
// what this file contributes is the one place that already knows the per-user path, creates the
// directory and sets 0600.
//
// Keyed by (base URL, principal) and kept OUT of the `#login` entry on purpose. A login is replaced
// wholesale on every `radia login` — last login wins — so a key stored inside it would be destroyed
// by re-authenticating, and the loss is silent: the fleet wrap still opens every conversation, so
// nothing fails, and the person half quietly stops existing.

const CONTENT_KEY = "#enckey:";

/** An app's content key for this person on this space, if one was stored. */
export function storedContentKey(base: string, principal: string): string | undefined {
  const entry = read(credentialsPath())[baseKey(base) + CONTENT_KEY + principal];
  return entry?.token || undefined;
}

/** Store (or rotate) it. Rotating leaves every existing wrap under the old key unreadable BY THIS
 *  PERSON, which is why an app rotates deliberately rather than on a schedule. */
export function saveContentKey(base: string, principal: string, key: string): { path: string; ok: boolean; error?: string } {
  return writeEntry(baseKey(base) + CONTENT_KEY + principal, { token: key, mintedAt: new Date().toISOString() });
}

/** What provisioning needs from the space: structural on purpose, so this file imports no
 *  runtime value from `src/core` and the surfaces that import IT stay clean under the layering
 *  rule. `Space` satisfies it as-is. */
interface ObserverHost {
  resolveToken(token: string): Promise<{ ok: boolean }>;
  createAgentDefinition(
    agent: string,
    // Narrowed to the one operation the observer's metadata grants use, so `Space`'s
    // GrantDef-typed method stays a structural supertype under strict function types.
    grants: { principal: string; kind: string; operations: "query"[] }[],
  ): Promise<{ definitionToken: string }>;
  put(req: { kind: string; body: unknown }, idempotencyKey?: string): Promise<unknown>;
}

/**
 * Ensure the observer credential exists: an `agent:local-observer` definition whose token lands
 * under `#observer` (mint-only, revocable), with the `observe` ops power assigned ONCE, at mint.
 *
 * The power is deliberately NOT re-assigned on a boot that reuses the stored definition. The
 * content-key idempotency that makes a re-put safe only lasts `idempotencyRetentionSeconds`;
 * past it a boot's re-put is a FRESH record that outranks a `retired: true` tombstone, so an
 * operator's deliberate retirement of the observer's power would silently un-happen on the next
 * restart (the resurrection class; see gotchas.md "Content-key idempotency dedupes for a
 * window"). Assign-at-mint means a retirement stands until an explicit
 * `radia revoke agent:local-observer` plus a restart re-creates the identity.
 */
export async function provisionObserver(
  space: ObserverHost,
  base: string,
  storageName?: string,
): Promise<{ created: boolean; saved?: { path: string; ok: boolean; error?: string } }> {
  const stored = storedObserver(base);
  const alive = stored?.definitionToken !== undefined &&
    (await space.resolveToken(stored.definitionToken)).ok;
  if (alive) return { created: false };
  // Beside the power, two narrow METADATA reads observability genuinely needs, assigned at mint
  // like the power itself: `agent_run` is what resolves a run principal to its agent (the string
  // never carries the name; the OTLP exporter's services were raw run ids without this), and
  // `kind_def` is what says which kinds are reference data. Reads only, no record bodies beyond
  // those two registries, and a retirement of either stands the same way the power's does.
  const { definitionToken } = await space.createAgentDefinition(OBSERVER_PRINCIPAL, [
    { principal: OBSERVER_PRINCIPAL, kind: "agent_run", operations: ["query"] },
    { principal: OBSERVER_PRINCIPAL, kind: "kind_def", operations: ["query"] },
  ]);
  const power = { principal: OBSERVER_PRINCIPAL, operations: ["observe"] };
  await space.put({ kind: OPS_GRANT, body: power }, opsGrantKey(power));
  const saved = saveObserver(base, {
    token: "",
    mintedAt: new Date().toISOString(),
    definitionToken,
    ...(storageName ? { storage: storageName } : {}),
  });
  return { created: true, saved };
}

/** Default base URL for clients: `RADIA_URL`, else the `radia dev` default. */
export function defaultBase(): string {
  return env("RADIA_URL") ?? "http://127.0.0.1:7788";
}
