// Bootstrap-chain credentials: agent-definition tokens (mint runs) and short-lived run tokens
// (do coordination).
//
// Resolution is authoritative per request: the space is asked, every time. Never rebuild an
// in-memory INDEX from `agent_definition`/`agent_run` records at startup (the cache-over-records
// shape the kind registry uses). It fails OPEN, invisibly, twice over: the rebuild reads a bounded
// page of an unbounded log, so on a busy space a STOPPED run's token still resolves after a
// restart; and a `stopRun` that consults the cache first silently does nothing for a run the cache
// never saw.
//
// What is memoized here is one IMMUTABLE fact (which agent a run instantiates, which cannot change
// once the run exists), plus operator tokens, which are process-lifetime by design and never
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
  // The local operator: authorizes coordination directly as the space's own principal. Distinct
  // from `def` because a definition token authorizes only ONE thing (minting a run) while an
  // operator token authorizes everything and can mint nothing.
  | { ok: true; kind: "operator"; principal: string }
  | { ok: true; kind: "def"; agent: string }
  | { ok: true; kind: "run"; principal: string; agent: string }
  | {
    ok: false;
    /** `definition_revoked` is distinct from `invalid_token` on purpose: the holder of a revoked
     *  definition needs to learn that the credential WAS real and is now dead, not that it was
     *  never valid, or the first thing they do is assume a transport problem and retry. */
    reason: "invalid_token" | "token_expired" | "run_stopped" | "definition_revoked";
  };

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
  #runs = new Map<string, RunFacts>();

  /** Register an operator token hash. It resolves to the space's own principal (privileged), not
   *  to `human:local`, which is the named operator a PERSON can hold. */
  addOperator(hash: string): void {
    this.#operatorHashes.add(hash);
  }

  isOperator(hash: string): boolean {
    return this.#operatorHashes.has(hash);
  }

  /** Remember which agent a run instantiates, and whether it is DELEGATED. Both are immutable for
   *  the life of the run, so caching them cannot make a stale authorization decision; it only saves
   *  a query. Always pass what you know: an entry recorded WITHOUT a delegation asserts there is
   *  none, and `Space.grantsOf` believes it. */
  rememberRun(run: string, agent: string, delegation?: Delegation): void {
    this.#runs.set(run, delegation ? { agent, delegation } : { agent });
  }

  agentForRun(run: string): string | undefined {
    return this.#runs.get(run)?.agent;
  }

  /** What is known about a run, or `undefined` when this process has never resolved it. Distinct
   *  from `agentForRun` returning a value with no delegation: absence means UNKNOWN and the caller
   *  must read the record, while a present entry with no `delegation` means "not delegated". */
  runFacts(run: string): RunFacts | undefined {
    return this.#runs.get(run);
  }
}

/** What a delegated run may do, materialized at mint. Held on the `agent_run` body and memoized
 *  here; see agent_docs/plan-delegation.md. */
export interface Delegation {
  /** The principal whose reach this run is bounded by. */
  actingFor: string;
  /** `grants(worker) INTERSECT grants(actingFor)`, computed once. This run's ENTIRE authority: no
   *  grant record is ever read for it. */
  grants: DelegatedGrant[];
}

/** One entry of a delegated run's authority. The `GrantDef` shape minus `principal`, which is the
 *  run itself. Structural rather than an import, so `auth.ts` stays a leaf. */
export interface DelegatedGrant {
  kind: string;
  operations: string[];
  pattern?: Record<string, unknown>;
  scope?: Record<string, string>;
}

interface RunFacts {
  agent: string;
  delegation?: Delegation;
}
