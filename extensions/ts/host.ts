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
  /** Module path inside the tree, default-exporting `(record) => result`, or `(record, space)`
   *  when `brokered` asks for the channel. */
  entrypoint: string;
  /**
   * Whether this code may reach the space at all, through the broker.
   *
   * DEFAULT FALSE, which is least privilege applied to model-written code: an entrypoint that only
   * computes gets `(record)` and no way to read or write anything, and a run that needs the space
   * says so where the operator deploying it can see the request. It used to be on for everyone,
   * bounded only by the agent's grants, which is the same shape as an unscoped artifact grant
   * being a door out of a compartment.
   *
   * Measured before inverting it: the only production consumer of the brokered host (the analysis
   * pipeline's three stages) never touches `space` — its inputs arrive as files the host fetched
   * and its output is the returned value — so it was paying for a channel it never used, including
   * the `mkfifo` run permission behind it (agent_docs/research-agent-sessions.md).
   */
  brokered?: boolean;
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
   * Body FIELDS copied from the claimed record onto every captured output artifact's meta,
   * winning over the capture defaults on a shared key. `["owner", "dataset"]` is the data-pipeline
   * shape: the output belongs to the request that asked for it, not to the agent that computed it,
   * so a person's `{owner}`-scoped artifact grant reaches the bytes a worker produced for them.
   * Stamped HOST-side from the claimed record, where the code cannot lie about it. Non-scalar
   * values are skipped: artifact meta is scalars.
   */
  outputMeta?: string[];
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
  return [...latest.values()].map((r) => r.body);
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
    const rows = await reader.queryNewest<any>({ kind: "workspace", match: { treeDigest: digest } }, 1);
    if (rows.length === 0) throw new Error(`no workspace manifest for ${digest}`);
    const root = await Deno.makeTempDir({ prefix: "radia-tree-", ...(opts.dir ? { dir: opts.dir } : {}) });
    try {
      // deno-lint-ignore no-explicit-any
      await materialize(reader, rows[0].body, root);
    } catch (e) {
      // The directory exists from here on, and a rejected promise is never walked by the eviction
      // or `clear` paths below, so a failure part way through a fetch would leak the partial tree
      // with nothing left holding its name. One failed materialisation per retry, every few
      // seconds, is a disk filling up because a disk filled up.
      await Deno.remove(root, { recursive: true }).catch(() => {});
      throw e;
    }
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
      // A FAILED build must not be remembered. Caching the promise is what makes concurrent claims
      // share one materialisation, and it also caches a REJECTION: one transient artifact read or
      // a server blip would otherwise be served to every later caller for that digest. LRU does not
      // save it, because a hit bumps `used`, so the poisoned entry is the most recently used one
      // and never the eviction victim; in the deployment this is written for (`max` covers a
      // rotation, a rollback and a spare, with one digest hot) nothing evicts it at all. The host
      // treats the rejection as transient and nacks with a 5s backoff, so the effect was a
      // permanent nack loop for that agent until the process restarted.
      //
      // Compared by IDENTITY, never by key alone: by the time this runs, a later miss may already
      // have replaced the entry with a fresh build, and deleting by key would evict a healthy
      // materialisation because an older attempt failed.
      root.catch(() => {
        if (entries.get(digest)?.root === root) entries.delete(digest);
      });
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
  /** A directory the run may WRITE to, when the binding named an output workspace: empty apart
   *  from the materialised inputs, which capture excludes. The invoker's job is to make it the
   *  jail's only writable path; the host captures it afterwards. */
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
  /** `permanent` means a retry cannot change the answer (an authorization refusal), so this host
   *  will not claim that record again. The distinction an operator acts on is "it will never work"
   *  against "try it again", and both used to print the same line. */
  | { agent: string; status: "failed"; recordId: string; error: string; permanent?: true };

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
  artifactMeta?: Record<string, string | number | boolean | null>,
): Promise<string | undefined> {
  let prev = await readWorkspace(client, name);
  if (!prev) {
    // An empty v0 so the versions below it have a predecessor to be based on. One record, once per
    // output workspace, and honest: before the first run there were no outputs.
    //
    // POINT AWAY FROM THE CODE on a refusal. This is the one record a host writes with no stamp on
    // it, so a pattern-scoped `workspace` grant refuses it with a message about a put grant, and
    // the operator goes looking at an entrypoint that never wrote a workspace and, brokered, could
    // not have. Augmented IN PLACE rather than rethrown: `permanent()` reads `status`, and a plain
    // Error would lose it and turn one clean refusal into a retry to a dead-letter.
    const created = await writeWorkspace(client, { name, owner, files: {} }).catch((e) => {
      const err = e as { status?: number; message?: string };
      if (err?.status === 403 && typeof err.message === "string") {
        err.message = `${err.message}. ${JSON.stringify(name)} is this binding's output tree and the HOST wrote ` +
          `that record, not your code: a tree is shared by every run of the binding, so there is nothing per-run ` +
          `to label it with, the way outputMeta labels the result and the captured artifacts. This agent needs a ` +
          `workspace put grant that is not pattern-scoped, or the binding needs no outputWorkspace.`;
      }
      throw e;
    });
    prev = { id: created.id, name, owner, treeDigest: created.treeDigest, files: [] };
  }
  // `input/` is the REQUEST's data, materialised by the host, so it is never this run's output:
  // capturing it would store every input a second time, attributed to the wrong producer.
  const captured = await captureWorkspace(
    client,
    { ...prev, files: [], ignore: [...(prev.ignore ?? []), INPUT_DIR] },
    dir,
    artifactMeta ? { artifactMeta } : {},
  );
  const committed = await commitWorkspace(client, prev, captured, { parentIds: [cause] });
  return committed?.id;
}

/**
 * The `outputMeta` stamp: the named body fields of the claimed record, scalars only.
 *
 * EVERYTHING A RUN EMITS, not only its output artifacts. It reaches three destinations because a
 * run has three ways out and they must not have three different rules: the captured artifacts, the
 * records the code proposes through a broker, and the value the entrypoint RETURNS. That last one
 * was unstamped, which is the one path everything actually uses: two programs returned a body with
 * no compartment label, every ack was refused as outside the put grant's pattern, the host retried
 * to a dead-letter, and no model ever saw the error because it happens after the code has finished
 * (agent_docs/research-agent-sessions.md).
 *
 * Exported so a broker derives the same stamp from the same binding rather than being handed one.
 */
export function outputStamp(binding: Binding, record: RadiaRecord): Record<string, string | number | boolean | null> | undefined {
  if (!binding.outputMeta?.length) return undefined;
  const body = record.body as Record<string, unknown>;
  const stamp: Record<string, string | number | boolean | null> = {};
  for (const field of binding.outputMeta) {
    const v = body[field];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stamp[field] = v as string | number | boolean | null;
    }
  }
  return Object.keys(stamp).length ? stamp : undefined;
}

/**
 * Whether a failure will still be a failure on redelivery.
 *
 * AUTHORIZATION ONLY, deliberately narrow: a body refused for scope and a grant are both fixed at
 * the moment of the refusal, so the retry the runtime offers cannot change either. Everything else
 * (a crash, a timeout, a network blip) keeps the retry it was designed for, because over-reporting
 * "permanent" turns a transient fault into work that silently stops.
 *
 * THE STATUS IS THE WHOLE TEST, and the two attempts before it are worth stating so nobody adds a
 * third. Every refusal that reaches here is a `RadiaClientError` from the SDK, which carries
 * `status`; a fallback on `.title` was written first and could never fire, because the wire's
 * RFC 9457 `title` is stored as `code`, and a fallback on the message could not fire either. A
 * branch that cannot fire is worse than no branch: it reads as a safety net and is a comment.
 *
 * Unrecognised means RETRYABLE, which is the safe direction: over-reporting "permanent" turns a
 * transient fault into work that silently stops.
 */
function permanent(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 401 || status === 403;
}

/** Merge the stamp into a result's BODY, leaving `kind` and everything else alone. A result with no
 *  body is left as it is: there is nothing to label, and inventing one would put a record into the
 *  space that the entrypoint did not ask for. */
function stampResult<T extends { kind: string; body?: unknown }>(
  result: T,
  stamp: Record<string, string | number | boolean | null> | undefined,
): T {
  if (!stamp || !result?.body || typeof result.body !== "object" || Array.isArray(result.body)) return result;
  return { ...result, body: { ...(result.body as Record<string, unknown>), ...stamp } };
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
    // A binding's entrypoint arrives verbatim from `radia bind`; `validateEntrypoint` runs only on
    // workspace WRITE paths, for the manifest's own default. Module loading is not bounded by the
    // jail's read permissions (architecture-jail-confinement.md), so refuse traversal before it
    // becomes an import, and before paying for a materialisation.
    validatePath(ctx.binding.entrypoint);
    const root = await cache.root(ctx.binding.workspaceDigest);
    {
      // A SECOND ARGUMENT THAT EXPLAINS ITSELF. Space access is opt-in (`Binding.brokered`), and
      // code written before that inversion calls `space.query(...)` on `undefined`, which fails as
      // "Cannot read properties of undefined" and names neither the cause nor the fix. Every
      // property answers with the instruction instead, so the first line of the failure is the
      // sentence somebody needs.
      const denied = `new Proxy({}, { get(_t, prop) { throw new Error(` +
        `"this binding is not brokered, so the entrypoint has no space access: tried space." + String(prop) + ` +
        `". Add it with \`radia bind <agent> --brokered\` if this code needs to read or write the space."); } })`;
      const boot = `const record = ${JSON.stringify(ctx.record)};\n` +
        `const space = ${denied};\n` +
        // ABSOLUTE, not `./`: a program fed on stdin resolves a relative import against the CWD,
        // and the cwd is the output tree whenever there is one.
        `const mod = await import(${JSON.stringify(`file://${root}/${ctx.binding.entrypoint}`)});\n` +
        `const out = await mod.default(record, space);\n` +
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
  /**
   * Records this host has proved it cannot settle. Per PROCESS and never persisted: a restart is
   * the operator's way of saying "try again", and a grant may have changed by then.
   *
   * BOUNDED, because a host runs for weeks and an unbounded set keyed by caller-supplied ids is a
   * leak with a slow fuse. Oldest first: the recent refusals are the ones a retry would hit again,
   * and forgetting an old one costs one wasted attempt rather than a loop.
   */
  #unclaimable = new Set<string>();
  #remember(id: string): void {
    this.#unclaimable.add(id);
    while (this.#unclaimable.size > 1000) {
      const oldest = this.#unclaimable.values().next().value;
      if (oldest === undefined) break;
      this.#unclaimable.delete(oldest);
    }
  }
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
        // A record this host has already proved it cannot settle is released rather than re-run:
        // claiming it again would cost another attempt for the same refusal. Released, never
        // nacked, so the attempt count stays where it was and another host with different grants
        // still gets its turn.
        if (claimed && this.#unclaimable.has(claimed.record.id)) {
          await client.release(claimed.lease).catch(() => {});
          continue;
        }
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
          ? await captureOutput(client, binding.outputWorkspace!, binding.agent, outDir, claimed.record.id, outputStamp(binding, claimed.record))
          : undefined;
        // The inputs become DATA PARENTS of the result, so their classification flows into it and
        // "what produced this" is a lineage answer rather than a body field to trust.
        // THE HOST WINS OVER THE CODE, on this path as on the brokered one. A returned body that
        // omits the compartment gets it; one that names another team is overwritten rather than
        // refused, which is the same rule the broker states and the reason the code cannot lie
        // about what it touched.
        const stamped = stampResult(result, outputStamp(binding, claimed.record));
        const acked = await client.ack(claimed.lease, inputIds.length ? { ...stamped, parentIds: inputIds } : stamped);
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
        //
        // EXCEPT WHEN A RETRY CANNOT HELP. An authorization refusal is a property of the body and
        // the grant, and neither changes on redelivery: measured, one refused ack was re-claimed
        // six times over thirty seconds and then dead-lettered, with the reason only ever in this
        // process's stderr. So this host stops claiming that record and says so once. The request
        // stays `available`, which `radia doctor` reports as work sitting far longer than usual,
        // rather than consuming the attempt budget on the way to a dead-letter nobody can explain.
        if (permanent(e)) this.#remember(claimed.record.id);
        await client.nack(claimed.lease, { backoffSeconds: permanent(e) ? 0 : 5 }).catch(() => {});
        // Roomy enough to carry a diagnosis the invoker already bounded. At 300 it silently ate
        // the stderr tail the broker had gone to the trouble of keeping: two caps, opposite ends,
        // and the cause lost between them.
        out.push({
          agent: binding.agent,
          status: "failed",
          recordId: claimed.record.id,
          error: String(e).slice(0, 1200),
          ...(permanent(e) ? { permanent: true as const } : {}),
        });
      } finally {
        if (outDir) await Deno.remove(outDir, { recursive: true }).catch(() => {});
        if (inputDir) await Deno.remove(inputDir, { recursive: true }).catch(() => {});
      }
    }
    return out;
  }
}
