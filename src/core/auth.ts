// Bootstrap-chain credentials: agent-definition tokens (mint runs) and short-lived run tokens
// (do coordination). This is the fast, in-memory index that per-request auth consults — the
// SAME cache-over-records pattern as the kind registry: the durable source of truth is
// `agent_definition` / `agent_run` records (the token HASH lives in the record body — a hash is
// not a secret), and `Space.loadCredentials` rebuilds this index from them at startup.
//
// Plaintext tokens are returned once at mint and never stored; only their sha256 hash is kept,
// so a leaked record body (or DB) does not yield a usable token.

import { sha256Hex } from "./ids.ts";

/** A random bearer token plus its sha256 hash (only the hash is ever stored). */
export async function mintCredential(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { token, hash: await sha256Hex(token) };
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

interface DefCred {
  kind: "def";
  agent: string; // the agent:* principal this definition mints runs for
}

interface RunCred {
  kind: "run";
  principal: string; // run:* principal
  agent: string; // the agent definition it instantiates (grants flow from here)
  expiresAt: string; // ISO, DB clock at mint
  stopped: boolean;
}

export type ResolvedToken =
  | { ok: true; kind: "def"; agent: string }
  | { ok: true; kind: "run"; principal: string; agent: string }
  | { ok: false; reason: "invalid_token" | "token_expired" | "run_stopped" };

/** In-memory credential index (a cache over agent_definition/agent_run records). */
export class CredentialStore {
  #byHash = new Map<string, DefCred | RunCred>();
  #runByPrincipal = new Map<string, RunCred>();
  // Operator tokens resolve to `human:local` (privileged) and never expire — server-lifetime
  // bootstrap credentials for the bundled dev console, NOT persisted as records (like the
  // in-code meta-kinds). Cleared on rebuild; the server re-mints one at startup.
  #operatorHashes = new Set<string>();

  /** Reset run/definition creds (used before a rebuild from records). Operator tokens persist
   *  for the process lifetime and are re-seeded by the server, so they are not cleared here. */
  clear(): void {
    this.#byHash.clear();
    this.#runByPrincipal.clear();
  }

  /** Register an operator token hash (resolves to the privileged `human:local`). */
  addOperator(hash: string): void {
    this.#operatorHashes.add(hash);
  }

  addDefinition(hash: string, agent: string): void {
    this.#byHash.set(hash, { kind: "def", agent });
  }

  addRun(hash: string, principal: string, agent: string, expiresAt: string, stopped = false): void {
    const cred: RunCred = { kind: "run", principal, agent, expiresAt, stopped };
    this.#byHash.set(hash, cred);
    this.#runByPrincipal.set(principal, cred);
  }

  stopRun(principal: string): boolean {
    const cred = this.#runByPrincipal.get(principal);
    if (!cred) return false;
    cred.stopped = true;
    return true;
  }

  /** The agent definition a run instantiates (grants flow from it), or undefined. */
  agentForRun(principal: string): string | undefined {
    return this.#runByPrincipal.get(principal)?.agent;
  }

  runExists(principal: string): boolean {
    return this.#runByPrincipal.has(principal);
  }

  /** Resolve a presented bearer token against the index. `now` is the DB clock (for expiry). */
  async resolve(token: string, now: string): Promise<ResolvedToken> {
    const hash = await sha256Hex(token);
    // Operator token (bundled console): the privileged local operator, no expiry.
    if (this.#operatorHashes.has(hash)) return { ok: true, kind: "run", principal: "human:local", agent: "human:local" };
    const cred = this.#byHash.get(hash);
    if (!cred) return { ok: false, reason: "invalid_token" };
    if (cred.kind === "def") return { ok: true, kind: "def", agent: cred.agent };
    if (cred.stopped) return { ok: false, reason: "run_stopped" };
    if (cred.expiresAt <= now) return { ok: false, reason: "token_expired" };
    return { ok: true, kind: "run", principal: cred.principal, agent: cred.agent };
  }
}
