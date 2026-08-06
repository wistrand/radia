// The broker: how jailed code participates in the space without ever holding a credential.
//
// agent_docs/plan-workspace-agents.md phase 5, and the phase the plan's one hard line waits on:
// until this exists, containment is the runner's discipline, because a jailed process that can
// reach the API acts as whatever credential it can read.
//
// THE SHAPE. The entrypoint runs with no network, no env and no run permission, so it cannot
// reach the space at all. What it gets instead is a `space` object whose methods write PROPOSALS
// to stdout; the host reads them, performs them under the AGENT's run token, and writes the
// answers back on stdin. The same division the MCP adapter already makes for a model, applied to
// code: the credential and the lease stay outside the thing that cannot be trusted with them.
//
// THREE PROPERTIES FOLLOW, and they are the reason this is not a convenience wrapper:
//
//   1. THE CODE CANNOT LIE ABOUT WHAT IT TOUCHED. The host knows the jail's declared powers, so
//      it raises the labels (`file`, `net`) and stamps the compartment field on everything the
//      entrypoint emits. The writer never gets to say, so an attestation becomes a property of
//      the execution boundary.
//   2. IT CANNOT LAUNDER LINEAGE EITHER. A direct put omitting `parent_ids` is the documented way
//      taint is lost; every brokered put gets the CLAIMED RECORD prepended as a parent, so the
//      classification of the work flows into whatever the code writes whether it says so or not.
//   3. EFFECTIVELY-ONCE, BY CONSTRUCTION. With no egress but the broker, the host derives each
//      put's idempotency key from `(claimed record id, output ordinal)`, so a retried attempt's
//      writes dedupe instead of doubling. Bounded by `idempotencyRetentionSeconds`, not forever.
//
// NORMATIVE. This crosses the project's biggest trust boundary (model-written code against agent
// authority), so the frame format below is a contract with an implementation, not an
// implementation detail: another binding must speak exactly this or the two are not comparable.
// `extensions/conformance/broker.test.ts` is the contract, including the escape probe.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { jailArgs, type RunOptions } from "./sandbox.ts";
import { type InvokeContext, type Invoker, treeCache, type TreeCache } from "./host.ts";

/** Frames are prefixed on stdout, because an entrypoint that logs is normal and its chatter must
 *  never be parsed as protocol. Everything unprefixed is the program's own output. */
export const BROKER_MARK = "broker:";
export const RESULT_MARK = "result:";

/** Jail to host. `id` correlates the answer; ops outside the list below are refused. */
export interface BrokerCall {
  id: number;
  op: "put" | "query" | "read_one";
  args: Record<string, unknown>;
}

/** Host to jail, one line of JSON per call. */
export interface BrokerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrokerOptions {
  /** Labels the host raises on everything the entrypoint emits, derived from the jail's declared
   *  powers rather than from anything the code says. */
  labels?: string[];
  /** Body fields stamped onto every emitted record. The host WINS over the code: this is how a
   *  compartment field gets on the output of something that never mentions it. */
  stamp?: Record<string, unknown>;
  /** Extra jail permissions. Net is never grantable here: the whole point is that the only way
   *  out is the broker. */
  run?: Pick<RunOptions, "readRoots" | "writeRoots" | "denyRead" | "memoryMb">;
  timeoutMs?: number;
  /** Materialised trees, shared across claims and keyed by digest (phase 6). Safe because a warm
   *  entry cannot be stale: different code is a different digest. Pass one cache to a whole host
   *  so every agent on the same digest shares the fetch. */
  cache?: TreeCache;
}

/** The labels a jail's declared powers imply, so the host stamps them instead of trusting a
 *  claim. Read roots beyond the materialised tree mean the code saw the host's filesystem. */
export function labelsForJail(opts: { readRoots?: string[]; net?: boolean } = {}): string[] {
  const labels: string[] = [];
  if ((opts.readRoots ?? []).length > 0) labels.push("file");
  if (opts.net) labels.push("net");
  return labels;
}

/** The program the jail actually runs. Generated, never materialised into the tree: the tree is
 *  content-addressed and adding a file to it would change the digest that identifies the code,
 *  and since phase 6 that directory is shared between claims. `entrypoint` is an absolute path. */
function bootSource(entrypoint: string, record: RadiaRecord): string {
  return `
const enc = new TextEncoder(), dec = new TextDecoder();
const reader = Deno.stdin.readable.getReader();
let buf = "";
async function nextLine() {
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return line; }
    const { value, done } = await reader.read();
    if (done) throw new Error("broker channel closed");
    buf += dec.decode(value, { stream: true });
  }
}
let seq = 0;
async function call(op, args) {
  const id = ++seq;
  await Deno.stdout.write(enc.encode(${JSON.stringify(BROKER_MARK)} + JSON.stringify({ id, op, args }) + "\\n"));
  const reply = JSON.parse(await nextLine());
  if (!reply.ok) throw new Error(reply.error ?? "broker refused");
  return reply.result;
}
const space = {
  put: (req) => call("put", req),
  query: (pattern, limit) => call("query", { pattern, limit }),
  readOne: (pattern) => call("read_one", { pattern }),
};
const record = ${JSON.stringify(record)};
const mod = await import(${JSON.stringify(`file://${entrypoint}`)});
const out = await mod.default(record, space);
await Deno.stdout.write(enc.encode(${JSON.stringify(RESULT_MARK)} + JSON.stringify(out ?? null) + "\\n"));
`;
}

/**
 * An invoker that materialises the tree, runs the entrypoint jailed, and serves its proposals
 * under the agent's own identity.
 *
 * Replaces `sandboxInvoker` from phase 4: same isolation, plus a way for the code to participate
 * without a credential.
 */
export function brokeredInvoker(reader: RadiaClient, opts: BrokerOptions = {}): Invoker {
  const cache = opts.cache ?? treeCache(reader);
  return async (ctx: InvokeContext) => {
    const root = await cache.root(ctx.binding.workspaceDigest);
    // The boot program is PER RECORD (it carries the claimed record), so it cannot live in the
    // tree: that directory is now shared between claims and two of them would clobber each
    // other's. Its own directory, added to the read roots, and removed after the run.
    const bootDir = await Deno.makeTempDir({ prefix: "radia-boot-" });
    const bootPath = `${bootDir}/boot.mjs`;
    try {
      await Deno.writeTextFile(bootPath, bootSource(`${root}/${ctx.binding.entrypoint}`, ctx.record));
      const readRoots = [root, bootDir, ...(opts.run?.readRoots ?? [])];
      const child = new Deno.Command(Deno.execPath(), {
        cwd: root,
        args: jailArgs({ ...opts.run, readRoots }, opts.run?.memoryMb ?? 256, bootPath),
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
        env: { HOME: Deno.env.get("HOME") ?? "/tmp", PATH: "/usr/bin:/bin" },
      }).spawn();
      return await serve(child, ctx, opts);
    } finally {
      await Deno.remove(bootDir, { recursive: true }).catch(() => {});
    }
  };
}

/** The host side of the channel: read frames, perform them as the agent, answer, and collect the
 *  entrypoint's return value. */
async function serve(
  child: Deno.ChildProcess,
  ctx: InvokeContext,
  opts: BrokerOptions,
): Promise<{ kind: string; body: unknown }> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();
  const stderr: Promise<string> = new Response(child.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, opts.timeoutMs ?? 15_000);

  let buf = "";
  let result: { kind: string; body: unknown } | undefined;
  let ordinal = 0;
  const chatter: string[] = [];
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith(BROKER_MARK)) {
          const call = JSON.parse(line.slice(BROKER_MARK.length)) as BrokerCall;
          const reply = await perform(call, ctx, opts, () => ++ordinal);
          await writer.write(enc.encode(JSON.stringify(reply) + "\n"));
        } else if (line.startsWith(RESULT_MARK)) {
          result = JSON.parse(line.slice(RESULT_MARK.length));
          break outer;
        } else if (line.length > 0) {
          if (chatter.length < 50) chatter.push(line);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    await writer.close().catch(() => {});
    reader.cancel().catch(() => {});
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
    await child.status.catch(() => {});
  }
  if (timedOut) throw new Error(`entrypoint timed out after ${opts.timeoutMs ?? 15_000}ms`);
  if (!result) throw new Error(`entrypoint produced no result: ${(await stderr).slice(0, 400) || chatter.join(" | ").slice(0, 400)}`);
  return result;
}

/** One proposal, performed as the AGENT. Every host-side rule lives here, because this is the one
 *  place the jail's output becomes a write. */
async function perform(
  call: BrokerCall,
  ctx: InvokeContext,
  opts: BrokerOptions,
  nextOrdinal: () => number,
): Promise<BrokerReply> {
  try {
    if (call.op === "put") {
      const req = call.args as { kind?: unknown; body?: unknown; parentIds?: unknown; taint?: unknown };
      if (typeof req.kind !== "string") throw new Error("put needs a kind");
      const body = { ...(req.body as Record<string, unknown> ?? {}), ...(opts.stamp ?? {}) };
      const declared = Array.isArray(req.taint) ? req.taint.map(String) : [];
      // Lineage the code does not get to omit, labels it does not get to withhold.
      const parentIds = [ctx.record.id, ...(Array.isArray(req.parentIds) ? req.parentIds.map(String) : []).filter((p) => p !== ctx.record.id)];
      const taint = [...new Set([...declared, ...(opts.labels ?? [])])];
      const out = await ctx.client.put(
        { kind: req.kind, body, parentIds, ...(taint.length ? { taint } : {}) },
        `broker:${ctx.record.id}:${nextOrdinal()}`,
      );
      return { id: call.id, ok: true, result: out };
    }
    if (call.op === "query" || call.op === "read_one") {
      const { pattern, limit } = call.args as { pattern?: Record<string, unknown>; limit?: number };
      if (!pattern || typeof pattern.kind !== "string") throw new Error("query needs a pattern with a kind");
      // deno-lint-ignore no-explicit-any
      const p = pattern as any;
      const rows = call.op === "query" ? await ctx.client.query(p, Math.min(Number(limit) || 50, 500)) : [await ctx.client.readOne(p)];
      return { id: call.id, ok: true, result: rows.filter(Boolean) };
    }
    throw new Error(`unsupported op '${call.op}': the broker serves put, query and read_one`);
  } catch (e) {
    // A refusal is DATA, so the entrypoint sees a normal error and the run continues. The host
    // never dies on the jail's behalf, and a 403 reads as a 403 rather than as a crash.
    return { id: call.id, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
}
