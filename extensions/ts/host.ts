// A generic host that runs a workspace's code AS the agent that workspace belongs to.
//
// agent_docs/architecture-workspace-agents.md phase 4. An agent stops being a deployed process and
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
import {
  captureWorkspace,
  commitWorkspace,
  materialize,
  readWorkspace,
  validatePath,
  type WorkspaceManifest,
  writeWorkspace,
} from "./workspace.ts";
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
  /**
   * The PROPERTIES this code needs from its jail, matched against `sandbox` records:
   * `{language: "python", network: false}`. Never an interpreter name, per
   * design-execution.md: a policy binds the property that matters rather than a language
   * standing in for it. Resolved by `resolveSandbox` (broker.ts), which refuses rather than
   * guessing when nothing declared satisfies it. Absent means the Deno jail, which is the
   * posture with no external dependency.
   */
  sandboxPattern?: Record<string, unknown>;
  /**
   * Artifact BYTES the run needs on disk before it starts, fetched by the host because no other
   * path exists: broker frames never carry bytes and the jail has no net.
   *
   * Each entry names a body FIELD on the claimed record holding an artifact record id, and the
   * host materialises those bytes at `input/<path>` (default `input/<field>`) in the run's cwd
   * before invoking. The fetch runs under the AGENT's client, never the host's reader: a body
   * field is a CLAIM (plan-encryption.md phase 0 rule), so the agent's own grants decide whether
   * the read happens, and the artifact becomes a data parent of the result, so taint flows.
   * The `input` directory is never captured as output.
   */
  inputs?: { field: string; path?: string }[];
  /**
   * The workspace a run's OUTPUT FILES land in, and the only way an entrypoint gets a writable path.
   *
   * A run writes to a different tree than it runs from. The tree it runs from is this binding's
   * code: shared between concurrent claims (`treeCache`) and pinned by the digest promotion
   * rotates, so writing into it would race a neighbour and change the identity the pin refers to.
   * Absent means NO writable path at all, which is the posture with no capability to reason about.
   *
   * Each run is a VERSION, not an accumulation: the tree is captured from an empty directory, so
   * version N holds run N's outputs and the chain holds the history. Bytes are files here rather
   * than a payload in the result body, per the invariant: artifact bytes never travel inside a
   * record, and a file is binary, named, versioned and erasable for free.
   */
  outputWorkspace?: string;
}

/**
 * The result marker this invoker's boot program prints on stdout.
 *
 * The LAST marker in the codebase, and it survives for a reason the broker's did not: this invoker
 * is ONE-WAY. It sends nothing to the child and reads one value at the end, so the failure the
 * broker's pipe channel exists to prevent (a partial write swallowing a frame, then a deadlock
 * waiting on a reply that can never come) has no reply to wait on here. The worst case is a
 * corrupted result line, reported as "produced no result". Printable and versioned so a person can
 * read it in a diagnostic and say it out loud; `\x01radia:` was neither.
 */
export const RESULT_MARK = "RADIA-RESULT/1:";

export const BINDING = "binding";

/** Where materialised inputs land, relative to the run's cwd, in every language and every jail.
 *  One fixed directory rather than free paths, so output capture can exclude it wholesale. */
export const INPUT_DIR = "input";

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

/**
 * Materialised trees, keyed by digest.
 *
 * Per-claim materialise-and-jail pays for a manifest read plus one artifact fetch per file, every
 * time, for bytes that cannot have changed. Content addressing makes the fix provably safe rather
 * than merely likely: a warm entry CANNOT be stale, because different code is a different digest
 * and would be a different key.
 *
 * WHAT THIS DOES NOT CACHE, and must not: the PROCESS. That argument covers code, not state, and a
 * jail reused between claims carries globals, open handles and whatever the last run left in
 * memory from one record to the next. A pool of live interpreters is a different proposition with
 * a different safety case, and it does not get to borrow this one.
 */
export interface TreeCache {
  /** The materialised root for a digest, fetched once. Concurrent callers share one
   *  materialisation rather than racing to write the same files. */
  root(digest: string): Promise<string>;
  readonly stats: { hits: number; misses: number };
  clear(): Promise<void>;
}

export function treeCache(reader: RadiaClient, opts: { max?: number; dir?: string } = {}): TreeCache {
  const max = opts.max ?? 4; // a tier runs one digest; this covers a rotation, a rollback and a spare
  const entries = new Map<string, { root: Promise<string>; used: number }>();
  const stats = { hits: 0, misses: 0 };
  let clock = 0;
  const build = async (digest: string): Promise<string> => {
    const rows = await reader.query({ kind: "workspace", match: { treeDigest: digest } }, 1, { dir: "desc" });
    if (rows.length === 0) throw new Error(`no workspace manifest for ${digest}`);
    const root = await Deno.makeTempDir({ prefix: "radia-tree-", ...(opts.dir ? { dir: opts.dir } : {}) });
    // deno-lint-ignore no-explicit-any
    await materialize(reader, rows[0].body as any, root);
    return root;
  };
  return {
    stats,
    root(digest: string): Promise<string> {
      const hit = entries.get(digest);
      if (hit) {
        stats.hits++;
        hit.used = ++clock;
        return hit.root;
      }
      stats.misses++;
      // The PROMISE is cached, not the path: two claims for one digest arriving together would
      // otherwise both materialise into different directories, and the loser's would leak.
      const root = build(digest);
      entries.set(digest, { root, used: ++clock });
      while (entries.size > max) {
        const oldest = [...entries.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        entries.delete(oldest[0]);
        oldest[1].root.then((r) => Deno.remove(r, { recursive: true })).catch(() => {});
      }
      return root;
    },
    async clear(): Promise<void> {
      const roots = [...entries.values()].map((e) => e.root);
      entries.clear();
      for (const r of roots) await r.then((p) => Deno.remove(p, { recursive: true })).catch(() => {});
    },
  };
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
  /** An empty directory the run may WRITE to, when the binding named an output workspace. The
   *  invoker's job is to make it the jail's only writable path; the host captures it afterwards. */
  outDir?: string;
  /** A READ-ONLY directory holding the materialised inputs, when the binding declared inputs but
   *  no output workspace. It becomes the cwd so `input/<path>` resolves the same way in both
   *  postures; with an output tree the inputs live inside `outDir` instead and this is unset. */
  inputDir?: string;
  /** The artifact records behind the materialised inputs. An invoker that writes on the run's
   *  behalf adds them as PARENTS, the same forced-lineage rule as the claimed record: what the
   *  code read flows into what it wrote whether it says so or not. */
  inputIds?: string[];
}

/** How the entrypoint is run. Pluggable because the identity properties above are independent of
 *  it, and because phase 5 replaces the default with the brokered one. */
export type Invoker = (ctx: InvokeContext) => Promise<{ kind: string; body: unknown }>;

export type Outcome =
  | { agent: string; status: "idle" }
  | { agent: string; status: "refused"; reason: string }
  | { agent: string; status: "digest_mismatch"; wanted: string; bound: string; recordId: string }
  | { agent: string; status: "acked"; recordId: string; resultId?: string; outputId?: string }
  | { agent: string; status: "failed"; recordId: string; error: string };

/**
 * Store what the run wrote, as the next version of the binding's output workspace.
 *
 * BEFORE the ack: a run whose outputs could not be stored has not finished, so it nacks and retries
 * under the at-least-once contract the entrypoint already lives under. Diffed against an EMPTY file
 * list rather than the previous version, which is what makes a version this run's outputs instead of
 * an accumulation nothing prunes. Written with the AGENT's client, and carrying the claimed record
 * as a parent, so `children(request)` answers "what bytes did this produce".
 */
async function captureOutput(
  client: RadiaClient,
  name: string,
  owner: string,
  dir: string,
  cause: string,
): Promise<string | undefined> {
  let prev = await readWorkspace(client, name);
  if (!prev) {
    // An empty v0 so the versions below it have a predecessor to be based on. One record, once per
    // output workspace, and honest: before the first run there were no outputs.
    const created = await writeWorkspace(client, { name, owner, files: {} });
    prev = { id: created.id, name, owner, treeDigest: created.treeDigest, files: [] };
  }
  // `input/` is the REQUEST's data, materialised by the host, so it is never this run's output:
  // capturing it would store every input a second time, attributed to the wrong producer.
  const captured = await captureWorkspace(client, { ...prev, files: [], ignore: [...(prev.ignore ?? []), INPUT_DIR] }, dir);
  const committed = await commitWorkspace(client, prev, captured, { parentIds: [cause] });
  return committed?.id;
}

/**
 * Fetch the claimed record's declared inputs into `<dir>/input/`, and return the artifact ids.
 *
 * Under the AGENT's client, deliberately: the record body names the artifact, and a body is a
 * claim, so the agent's own grants decide whether the read happens. A request naming an artifact
 * its handler may not read fails HERE, as a permission error, instead of smuggling bytes past the
 * grant table under the host's broader authority.
 */
async function materializeInputs(
  client: RadiaClient,
  specs: NonNullable<Binding["inputs"]>,
  record: RadiaRecord,
  dir: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    const value = (record.body as Record<string, unknown>)[spec.field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`input field '${spec.field}' on the claimed record is ${JSON.stringify(value ?? null)}, not an artifact record id`);
    }
    const rel = spec.path ?? spec.field;
    validatePath(rel);
    const bytes = await client.getArtifact(value);
    const target = `${dir}/${INPUT_DIR}/${rel}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(target, bytes);
    ids.push(value);
  }
  return ids;
}

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
  /** Where output directories are made. Needed when the host itself runs confined: the default is
   *  the system temp dir, which a confined process cannot write. Empty string means the default,
   *  never the empty PATH (`makeTempDir({dir: ""})` throws). */
  outRoot?: string;
}

/**
 * Materialise the tree and run the entrypoint in the Deno jail, with the record interpolated.
 *
 * Read-only, no network, cwd inside the tree. The entrypoint cannot reach the space: it returns a
 * value, and the host writes it under the agent's identity.
 */
export function sandboxInvoker(reader: RadiaClient, opts: { timeoutMs?: number; cache?: TreeCache } = {}): Invoker {
  const cache = opts.cache ?? treeCache(reader);
  return async (ctx) => {
    const root = await cache.root(ctx.binding.workspaceDigest);
    {
      const boot = `const record = ${JSON.stringify(ctx.record)};\n` +
        // ABSOLUTE, not `./`: a program fed on stdin resolves a relative import against the CWD,
        // and the cwd is the output tree whenever there is one.
        `const mod = await import(${JSON.stringify(`file://${root}/${ctx.binding.entrypoint}`)});\n` +
        `const out = await mod.default(record);\n` +
        `console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(out ?? null));\n`;
      const run = await runCode(boot, {
        // The OUTPUT tree is the working directory when there is one, so `writeFile("chart.png")`
        // lands in it with nothing passed to the entrypoint and nothing language-specific; a run
        // with only inputs gets the input dir as cwd instead, so `input/<path>` reads the same
        // either way. The code tree is reached by absolute path (`import.meta.dirname`), which is
        // how a module should find its own data anyway.
        cwd: ctx.outDir ?? ctx.inputDir ?? root,
        readRoots: [root, ...(ctx.outDir ? [ctx.outDir] : []), ...(ctx.inputDir ? [ctx.inputDir] : [])],
        // Writable, and `root` never is: see `Binding.outputWorkspace`.
        ...(ctx.outDir ? { writeRoots: [ctx.outDir] } : {}),
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
      // The TAIL of stderr: the useful line of a stack trace is its last, and a program that
      // logged before it died pushes the cause off the front.
      if (!run.ok) throw new Error(`entrypoint failed (exit ${run.exitCode}): ${run.stderr.slice(-400)}`);
      // A marker, not "the last line": an entrypoint that logs is normal, and picking its chatter
      // as the result is the kind of bug that only shows up on the day something logs.
      const line = run.stdout.split("\n").find((l) => l.startsWith(RESULT_MARK));
      if (!line) throw new Error("entrypoint produced no result");
      return JSON.parse(line.slice(RESULT_MARK.length)) as { kind: string; body: unknown };
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
      // Made before the run and EMPTY, which is what makes each version that run's outputs.
      const outDir = binding.outputWorkspace
        ? await Deno.makeTempDir({ dir: this.#opts.outRoot || undefined, prefix: "radia-out-" })
        : undefined;
      // Declared inputs need a cwd even when no output tree was asked for; read-only in the jail.
      const inputDir = !outDir && binding.inputs?.length
        ? await Deno.makeTempDir({ dir: this.#opts.outRoot || undefined, prefix: "radia-in-" })
        : undefined;
      try {
        const inputIds = binding.inputs?.length
          ? await materializeInputs(client, binding.inputs, claimed.record, (outDir ?? inputDir)!)
          : [];
        const result = await invoke({
          binding,
          record: claimed.record,
          client,
          ...(outDir ? { outDir } : {}),
          ...(inputDir ? { inputDir } : {}),
          ...(inputIds.length ? { inputIds } : {}),
        });
        const outputId = outDir
          ? await captureOutput(client, binding.outputWorkspace!, binding.agent, outDir, claimed.record.id)
          : undefined;
        // The inputs become DATA PARENTS of the result, so their classification flows into it and
        // "what produced this" is a lineage answer rather than a body field to trust.
        const acked = await client.ack(claimed.lease, inputIds.length ? { ...result, parentIds: inputIds } : result);
        out.push({
          agent: binding.agent,
          status: "acked",
          recordId: claimed.record.id,
          ...(acked.status === "ok" && acked.resultId ? { resultId: acked.resultId } : {}),
          ...(outputId ? { outputId } : {}),
        });
      } catch (e) {
        // The work goes back with an attempt against it rather than being lost or held to lease
        // expiry: at-least-once is the contract, and a crashed entrypoint is exactly the retry
        // case it exists for.
        await client.nack(claimed.lease, { backoffSeconds: 5 }).catch(() => {});
        // Roomy enough to carry a diagnosis the invoker already bounded. At 300 it silently ate
        // the stderr tail the broker had gone to the trouble of keeping: two caps, opposite ends,
        // and the cause lost between them.
        out.push({ agent: binding.agent, status: "failed", recordId: claimed.record.id, error: String(e).slice(0, 1200) });
      } finally {
        if (outDir) await Deno.remove(outDir, { recursive: true }).catch(() => {});
        if (inputDir) await Deno.remove(inputDir, { recursive: true }).catch(() => {});
      }
    }
    return out;
  }
}
