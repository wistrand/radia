// The stale-authorization rounds, shared by `bench/authprobe.ts` and the cluster benchmark
// (agent_docs/plan-cluster-bench.md). One round, through instances chosen by the round number:
//
//   grant through A, probe everywhere: a denial is a STALE DENIAL (lag, not misauthorization)
//   revoke through B, probe everywhere: a success is a STALE GRANT (a violation)
//   mint a run through A, stop it through B, present it everywhere: a success is a STALE CREDENTIAL
//
// Revoke and re-grant alternate on ONE grant identity, the registry race `writeOrder` closes
// (gotchas.md). Every probe runs for `windowMs` after the write is acknowledged, all instances at
// once, so a count is a count of contradicting answers, not of timing flakes.

import { RadiaClient, RadiaClientError } from "../../sdk/ts/client.ts";

export interface Window {
  attempts: number;
  /** Attempts whose outcome contradicts the acknowledged write. */
  stale: number;
  /** 5xx and network failures: not an authorization decision, so never counted as one. */
  errors: number;
  /** Milliseconds after the acknowledgement of the latest stale observation, or -1 for none. */
  lastStaleMs: number;
}

export interface AuthTotals {
  staleGrant: Window;
  staleCredential: Window;
  staleDenial: Window;
}

type Outcome = "ok" | "denied" | "unauthenticated" | "error";

const empty = (): Window => ({ attempts: 0, stale: 0, errors: 0, lastStaleMs: -1 });

function add(into: Window, w: Window): void {
  into.attempts += w.attempts;
  into.stale += w.stale;
  into.errors += w.errors;
  into.lastStaleMs = Math.max(into.lastStaleMs, w.lastStaleMs);
}

async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    if (e instanceof RadiaClientError) return e.status === 403 ? "denied" : e.status === 401 ? "unauthenticated" : "error";
    return "error";
  }
}

export const AUTHPROBE_KIND = "bench_authprobe";

/**
 * Rounds per agent. Every round writes two grant records on one identity, and the runtime caps a
 * never-compacted grant history at 256 per (principal, kind) (`too_many_grants`), so a long run
 * moves to a fresh agent before it gets there.
 */
const ROUNDS_PER_AGENT = 100;

interface Identity {
  agent: string;
  definitionToken: string;
  /** The agent's run, one client per instance. Grants attach to the agent, so one run serves every
   *  round of the grant probe. */
  agents: RadiaClient[];
  rounds: number;
  /** The last grant write the space ACKNOWLEDGED for this identity, which is what its final state
   *  must be. A failover to a standby that never received it undoes it silently. */
  last?: "grant" | "revoke";
}

export class AuthRounds {
  readonly totals: AuthTotals = { staleGrant: empty(), staleCredential: empty(), staleDenial: empty() };
  rounds = 0;
  readonly #identities: Identity[] = [];
  /** Run tokens whose stop was acknowledged. */
  readonly #stopped: string[] = [];

  private constructor(
    private readonly admins: RadiaClient[],
    private readonly urls: string[],
    private id: Identity,
    private readonly windowMs: number,
  ) {
    this.#identities.push(id);
  }

  /**
   * One fresh agent per call, so a second run never inherits the first one's grant history.
   * `admins[i]` must hold an operator token valid on `urls[i]`: operator tokens live in the serving
   * process's memory, so one instance's is unknown to the next.
   */
  static async create(admins: RadiaClient[], urls: string[], opts: { windowMs: number }): Promise<AuthRounds> {
    return new AuthRounds(admins, urls, await AuthRounds.#identity(admins, urls), opts.windowMs);
  }

  /** A new agent and run, through the first instance that answers. */
  static async #identity(admins: RadiaClient[], urls: string[]): Promise<Identity> {
    const agent = `agent:authprobe-${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
    let last: unknown;
    for (const admin of admins) {
      try {
        const { definitionToken } = await admin.createAgentDefinition(agent, []);
        const run = await admin.createRun(definitionToken);
        return { agent, definitionToken, agents: urls.map((u) => new RadiaClient(u, run.runToken)), rounds: 0 };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  /** Probe every instance back to back for the window after an acknowledged write, all instances in
   *  parallel. `expect` is the only outcome consistent with that write. */
  async #probe(fn: (i: number) => Promise<unknown>, expect: Outcome): Promise<Window> {
    const w = empty();
    const t0 = performance.now();
    await Promise.all(this.urls.map(async (_, i) => {
      while (performance.now() - t0 < this.windowMs) {
        const o = await outcome(() => fn(i));
        w.attempts++;
        if (o === "error") w.errors++;
        else if (o !== expect) {
          w.stale++;
          w.lastStaleMs = Math.max(w.lastStaleMs, performance.now() - t0);
        }
      }
    }));
    return w;
  }

  /** Round `r`. The writer and revoker rotate with `r`, so every ordered pair of instances is used. */
  async round(r: number): Promise<void> {
    if (this.id.rounds >= ROUNDS_PER_AGENT) {
      this.id = await AuthRounds.#identity(this.admins, this.urls);
      this.#identities.push(this.id);
    }
    const { agent, definitionToken, agents } = this.id;
    const writer = this.admins[r % this.admins.length];
    const revoker = this.admins[(r + 1) % this.admins.length];
    const grant = { principal: agent, kind: AUTHPROBE_KIND, operations: ["query"] };
    const query = (i: number) => agents[i].queryNewest({ kind: AUTHPROBE_KIND }, 1);

    // A fresh idempotency key per write: the grant identity is the same every round (that is the
    // race under test), and a content key would replay the round-one write instead of appending.
    await writer.put({ kind: "grant", body: grant }, `authprobe:${agent}:grant:${r}`);
    this.id.last = "grant";
    add(this.totals.staleDenial, await this.#probe(query, "ok"));

    await revoker.put({ kind: "grant", body: { ...grant, retired: true } }, `authprobe:${agent}:revoke:${r}`);
    this.id.last = "revoke";
    add(this.totals.staleGrant, await this.#probe(query, "denied"));

    const victim = await writer.createRun(definitionToken);
    const holders = this.urls.map((u) => new RadiaClient(u, victim.runToken));
    await revoker.stopRun(victim.run);
    this.#stopped.push(victim.runToken);
    add(this.totals.staleCredential, await this.#probe((i) => holders[i].health(), "unauthenticated"));
    this.rounds++;
    this.id.rounds++;
  }

  /**
   * The END state against what was acknowledged, through every instance: an identity whose last
   * acknowledged write was a revocation must be denied, and a run whose stop was acknowledged must
   * not authenticate. The windowed probes above only look 200ms past each write; a failover to a
   * standby that never received a write undoes it much later, which only this sees.
   */
  async finalCheck(): Promise<{ resurrectedGrants: number; resurrectedRuns: number; identities: number; runs: number }> {
    let resurrectedGrants = 0, resurrectedRuns = 0;
    const revoked = this.#identities.filter((id) => id.last === "revoke");
    for (const id of revoked) {
      for (let i = 0; i < this.urls.length; i++) {
        if (await outcome(() => id.agents[i].queryNewest({ kind: AUTHPROBE_KIND }, 1)) === "ok") resurrectedGrants++;
      }
    }
    for (const [k, token] of this.#stopped.entries()) {
      const c = new RadiaClient(this.urls[k % this.urls.length], token);
      if (await outcome(() => c.health()) === "ok") resurrectedRuns++;
    }
    return { resurrectedGrants, resurrectedRuns, identities: revoked.length, runs: this.#stopped.length };
  }

  /** Stale grants plus stale credentials: the counts that are misauthorization. */
  violations(): number {
    return this.totals.staleGrant.stale + this.totals.staleCredential.stale;
  }

  verdict(): string {
    const v = this.violations();
    return `${v === 0 ? "no" : v} authorization violation${v === 1 ? "" : "s"} ` +
      "(stale grant + stale credential). Stale denials are lag, not misauthorization. ERRORS are\n" +
      "neither: a 5xx or a network failure is not an authorization decision, so it is counted apart.";
  }

  table(): string {
    const rows: [string, Window][] = [
      ["stale grant (after revoke)", this.totals.staleGrant],
      ["stale credential (after stop)", this.totals.staleCredential],
      ["stale denial (after grant)", this.totals.staleDenial],
    ];
    const head = ["PROBE", "ATTEMPTS", "STALE", "ERRORS", "LAST STALE"];
    const body = rows.map(([name, w]) => [name, String(w.attempts), String(w.stale), String(w.errors), w.lastStaleMs < 0 ? "-" : `${w.lastStaleMs.toFixed(0)}ms`]);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join("  ");
    return [line(head), widths.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n");
  }
}
