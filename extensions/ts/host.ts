// A generic host that runs a workspace's code AS the agent that workspace belongs to.
//
// agent_docs/plan-workspace-agents.md phase 4. An agent stops being a deployed process and
// becomes three records: an `agent_definition` (identity and grants, unchanged), a BINDING naming
// the code, and whatever it writes. This file is the one process, and it is a CLIENT like
// `git-serve`, not runtime: it composes `/v0` and the runtime knows nothing about it.
//
// THE IDENTITY RULE, which is the whole design and the reason this is not a dispatcher:
// the host holds definition tokens for the agents it hosts (setup, the same category as the chat
// launcher spawning its fleet), mints each agent's run, and CLAIMS UNDER THAT RUN. So
// `created_by`, `lease_owner` and `delegation_context` are the agent's, and one host serving ten
// agents needs none of their authority. The alternative, claiming as itself and dispatching
// internally, needs the union of every hosted agent's grants (a mini-operator) and flattens all
// provenance into one principal.
//
// TWO LOCKS, AND THEY MUST AGREE. The binding says which code runs; the pattern-scoped grant says
// which requests may be claimed (extensions/ts/promotion.ts). Either alone is inert: a binding
// whose agent holds no grant claims nothing, a granted digest with no binding runs nothing. What
// the plan did not say, and building it showed, is that they can both be present and DISAGREE: a
// binding at digest B while the grant pins A means the agent claims A's work and the host would
// run B's code, which is the hijack the two locks exist to prevent, wearing the shape of a
// misconfiguration. So the host refuses that pairing and releases the claim (`digest_mismatch`).
//
// The entrypoint here is a pure function of the claimed record: it returns the result body and
// has no way to reach the space. Everything an entrypoint needs beyond that is the BROKER
// (phase 5), which is also what makes the isolation structural rather than a property of this
// file's discipline.

import type { KindDef, Lease, RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { RadiaClient as Client, RadiaClientError } from "../../sdk/ts/client.ts";
import { activeByKey } from "../../sdk/ts/registry.ts";
import { materialize } from "./workspace.ts";
import { runCode } from "./sandbox.ts";
import { EXEC_REQUEST } from "./promotion.ts";

/** What code an agent runs. A latest-wins registry entry keyed by `agent`. */
export interface Binding {
  agent: string;
  /** The tree digest to materialise. Cutover is per claim; work already leased finishes under the
   *  digest it was claimed with. */
  workspaceDigest: string;
  /** Module path inside the tree, default-exporting `(record) => result`. */
  entrypoint: string;
  /** Which sandbox the tree runs in. Reserved for the runner selection design-execution.md
   *  describes; the default invoker below uses the Deno jail. */
  sandboxPattern?: Record<string, unknown>;
}

export const BINDING = "binding";

/**
 * The kind. NO `contentKey`, deliberately: compaction only touches keyed kinds, so a binding's
 * history is never swept, which is what an escalation root's audit trail needs (D3). Membership
 * is operator-only by grant ABSENCE first; before anything prod-tier depends on it, it joins
 * `WRITE_PROTECTED_KINDS`, because grant absence is a policy and write protection is a guard.
 */
export const BINDING_KIND: KindDef = {
  kind: BINDING,
  indexedPaths: [{ path: "agent", type: "keyword" }, { path: "workspaceDigest", type: "keyword" }],
  claimable: false,
};

export async function declareBinding(client: RadiaClient): Promise<void> {
  await client.registerKind(BINDING_KIND);
}

/** Every live binding, latest-wins per agent, retirements dropped. Paged to exhaustion: a bounded
 *  read here would run yesterday's code and report success. */
export async function readBindings(client: RadiaClient): Promise<Binding[]> {
  const rows = await client.queryAll({ kind: BINDING });
  const latest = activeByKey<Binding>(rows, (b) => (typeof b?.agent === "string" ? b.agent : undefined));
  return [...latest.values()].map((r) => r.body as unknown as Binding);
}

export interface InvokeContext {
  binding: Binding;
  /** The claimed request. An entrypoint sees this and nothing else. */
  record: RadiaRecord;
  /** The AGENT's client, never the host's. An invoker that performs work on the entrypoint's
   *  behalf (the broker, phase 5) does it through this, so a proposal from inside the jail is
   *  attributed exactly like the ack: to the agent, under the agent's grants. */
  client: RadiaClient;
  /** The materialised tree, when the invoker was given one. */
  root?: string;
}

/** How the entrypoint is run. Pluggable because the identity properties above are independent of
 *  it, and because phase 5 replaces the default with the brokered one. */
export type Invoker = (ctx: InvokeContext) => Promise<{ kind: string; body: unknown }>;

export type Outcome =
  | { agent: string; status: "idle" }
  | { agent: string; status: "refused"; reason: string }
  | { agent: string; status: "digest_mismatch"; wanted: string; bound: string; recordId: string }
  | { agent: string; status: "acked"; recordId: string; resultId?: string }
  | { agent: string; status: "failed"; recordId: string; error: string };

export interface HostOptions {
  base: string;
  /** Definition token per agent. Held by the host out of band, which is setup rather than
   *  authority: a definition token can mint a run and cannot read, write or claim. */
  credentials: Record<string, string>;
  /** Reads bindings and workspaces. Infrastructure reads, not the agent's: the host fetches the
   *  CODE, the agent does the coordination. */
  reader: RadiaClient;
  requestKind?: string;
  invoke?: Invoker;
  leaseSeconds?: number;
}

/**
 * Materialise the tree and run the entrypoint in the Deno jail, with the record interpolated.
 *
 * Read-only, no network, cwd inside the tree. The entrypoint cannot reach the space: it returns a
 * value, and the host writes it under the agent's identity.
 */
export function sandboxInvoker(reader: RadiaClient, opts: { timeoutMs?: number } = {}): Invoker {
  return async (ctx) => {
    const rows = await reader.query({ kind: "workspace", match: { treeDigest: ctx.binding.workspaceDigest } }, 1, { dir: "desc" });
    if (rows.length === 0) throw new Error(`no workspace manifest for ${ctx.binding.workspaceDigest}`);
    const root = await Deno.makeTempDir({ prefix: "radia-host-" });
    try {
      // deno-lint-ignore no-explicit-any
      await materialize(reader, rows[0].body as any, root);
      const boot = `const record = ${JSON.stringify(ctx.record)};\n` +
        `const mod = await import(${JSON.stringify(`./${ctx.binding.entrypoint}`)});\n` +
        `const out = await mod.default(record);\n` +
        `console.log("\\u0001radia:" + JSON.stringify(out ?? null));\n`;
      const run = await runCode(boot, { cwd: root, readRoots: [root], timeoutMs: opts.timeoutMs ?? 10_000 });
      if (!run.ok) throw new Error(`entrypoint failed (exit ${run.exitCode}): ${run.stderr.slice(0, 400)}`);
      // A marker, not "the last line": an entrypoint that logs is normal, and picking its chatter
      // as the result is the kind of bug that only shows up on the day something logs.
      const line = run.stdout.split("\n").find((l) => l.startsWith("radia:"));
      if (!line) throw new Error("entrypoint produced no result");
      return JSON.parse(line.slice("radia:".length)) as { kind: string; body: unknown };
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  };
}

/**
 * One host, any number of hosted agents.
 *
 * Stateless between ticks apart from the run tokens it caches: a restart re-mints and continues,
 * and a binding that changed digest takes effect on the next claim.
 */
export class WorkspaceHost {
  #clients = new Map<string, RadiaClient>();
  #opts: HostOptions;

  constructor(opts: HostOptions) {
    this.#opts = opts;
  }

  /** The agent's own client: a run minted from its definition token, so everything it does is
   *  attributed to it. The SDK re-mints on expiry, so a long-lived host needs no renewal loop. */
  #as(agent: string): RadiaClient {
    let c = this.#clients.get(agent);
    if (!c) {
      c = new Client(this.#opts.base, { definitionToken: this.#opts.credentials[agent] });
      this.#clients.set(agent, c);
    }
    return c;
  }

  /** One claim-run-settle cycle per hosted binding. Returns what happened, per agent, because a
   *  host that swallows a refusal is indistinguishable from an idle space. */
  async tick(): Promise<Outcome[]> {
    const requestKind = this.#opts.requestKind ?? EXEC_REQUEST;
    const invoke = this.#opts.invoke ?? sandboxInvoker(this.#opts.reader);
    const out: Outcome[] = [];
    for (const binding of await readBindings(this.#opts.reader)) {
      if (!this.#opts.credentials[binding.agent]) continue; // not ours to host
      const client = this.#as(binding.agent);
      let claimed: { record: RadiaRecord; lease: Lease } | null;
      try {
        claimed = await client.take({ pattern: { kind: requestKind } }, { leaseSeconds: this.#opts.leaseSeconds ?? 60 });
      } catch (e) {
        // A binding whose agent holds no matching grant claims NOTHING, and says so rather than
        // dying: one lock without the other is inert by design, not an error in the fleet.
        out.push({ agent: binding.agent, status: "refused", reason: e instanceof RadiaClientError ? e.code ?? String(e.status) : String(e) });
        continue;
      }
      if (!claimed) {
        out.push({ agent: binding.agent, status: "idle" });
        continue;
      }
      const wanted = (claimed.record.body as { workspace?: unknown }).workspace;
      if (typeof wanted === "string" && wanted !== binding.workspaceDigest) {
        // Both locks present and disagreeing. Running would execute code the requester did not
        // ask for, so the claim goes back for a correctly bound host and the mismatch is named.
        await client.release(claimed.lease).catch(() => {});
        out.push({ agent: binding.agent, status: "digest_mismatch", wanted, bound: binding.workspaceDigest, recordId: claimed.record.id });
        continue;
      }
      try {
        const result = await invoke({ binding, record: claimed.record, client });
        const acked = await client.ack(claimed.lease, result);
        out.push({
          agent: binding.agent,
          status: "acked",
          recordId: claimed.record.id,
          ...(acked.status === "ok" && acked.resultId ? { resultId: acked.resultId } : {}),
        });
      } catch (e) {
        // The work goes back with an attempt against it rather than being lost or held to lease
        // expiry: at-least-once is the contract, and a crashed entrypoint is exactly the retry
        // case it exists for.
        await client.nack(claimed.lease, { backoffSeconds: 5 }).catch(() => {});
        out.push({ agent: binding.agent, status: "failed", recordId: claimed.record.id, error: String(e).slice(0, 300) });
      }
    }
    return out;
  }
}
