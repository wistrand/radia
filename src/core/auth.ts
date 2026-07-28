// Bootstrap-chain credentials: agent-definition tokens (mint runs) and short-lived run tokens
// (do coordination).
//
// Resolution is authoritative per request: the space is asked, every time. Never rebuild an
// in-memory INDEX from `agent_definition`/`agent_run` records at startup — the cache-over-records
// shape the kind registry uses. It fails OPEN, invisibly, twice over: the rebuild reads a bounded
// page of an unbounded log, so on a busy space a STOPPED run's token still resolves after a
// restart; and a `stopRun` that consults the cache first silently does nothing for a run the cache
// never saw.
//
// What is memoized here is one IMMUTABLE fact — which agent a run instantiates, which cannot change
// once the run exists — plus operator tokens, which are process-lifetime by design and never
// records.
//
// The distinction is the whole design: cache what cannot change, never cache what can be revoked.
// A stopped run, an expired token and a withdrawn grant must all be discovered, not remembered.
//
// Plaintext tokens are returned once at mint and never stored; only their sha256 hash is kept, so a
// leaked record body (or DB) does not yield a usable token.

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

export type ResolvedToken =
  | { ok: true; kind: "def"; agent: string }
  | { ok: true; kind: "run"; principal: string; agent: string }
  | { ok: false; reason: "invalid_token" | "token_expired" | "run_stopped" };

/**
 * What this process may remember about credentials.
 *
 * Deliberately tiny. Operator tokens are minted per server lifetime and are not records at all (the
 * bundled console needs one before any agent exists). The run → agent memo holds an immutable fact
 * and saves a lookup on the authorization path; nothing here can keep a revoked credential alive,
 * because no revocable state is stored.
 */
export class CredentialStore {
  #operatorHashes = new Set<string>();
  #agentByRun = new Map<string, string>();

  /** Register an operator token hash (resolves to the privileged `human:local`). */
  addOperator(hash: string): void {
    this.#operatorHashes.add(hash);
  }

  isOperator(hash: string): boolean {
    return this.#operatorHashes.has(hash);
  }

  /** Remember which agent a run instantiates. Immutable for the life of the run, so caching it
   *  cannot make a stale authorization decision — only save a query. */
  rememberRun(run: string, agent: string): void {
    this.#agentByRun.set(run, agent);
  }

  agentForRun(run: string): string | undefined {
    return this.#agentByRun.get(run);
  }
}
