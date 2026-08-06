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
//
// ANY LANGUAGE, ANY BACKEND, and the two are INDEPENDENT. A language contributes a shim (a boot
// program that speaks the frames: `RUNTIMES` ships JavaScript and Python, each about thirty
// lines) and nothing else, because the host side never learns which language asked. The jail is
// chosen separately, from the `sandbox` RECORD a binding's `sandboxPattern` resolves to: the Deno
// jail is safe by ABSENCE of flags, bubblewrap by PRESENCE of them and runs any interpreter.
// Conflating the two is how "python means bubblewrap" becomes a rule nobody wrote down.
// EVERY BACKEND NEEDS ITS OWN ESCAPE PROBE. The Deno probe proves nothing about bwrap, whose
// `--unshare-all` is one forgotten flag away from an open jail; the contract runs one per backend
// and each was proved against a planted regression.

import type { RadiaClient, RadiaRecord } from "../../sdk/ts/client.ts";
import { bwrapArgs, jailArgs, type RunOptions, type SandboxSpec } from "./sandbox.ts";
import { listSandboxes } from "./sandbox-registry.ts";
import { type InvokeContext, type Invoker, treeCache, type TreeCache } from "./host.ts";

/**
 * Frame markers, and why they look like this.
 *
 * An entrypoint that logs is NORMAL, so its chatter shares stdout with the protocol and must never
 * be parsed as protocol. Three things keep them apart, and two were added after a plain word
 * prefix was shown to fail:
 *
 *   - A CONTROL CHARACTER leads the marker. Ordinary logging does not emit `\x01`, so a collision
 *     is not something a program does by accident.
 *   - Every frame is written with a LEADING NEWLINE. Without it, output lacking a trailing newline
 *     (`print(..., end="")`, a progress bar, any library that flushes mid-line) prepends itself to
 *     the frame, which then no longer starts its line and is read as chatter. The call is never
 *     answered, the jail blocks on stdin, and the run dies at the timeout naming the wrong cause.
 *     That is the MCP-stdio failure, reproduced against this code before it was fixed.
 *   - A marker found MID-LINE is definite corruption rather than something to ignore: it can only
 *     mean the streams interleaved, and saying so instantly beats a mystery timeout.
 *
 * A dedicated file descriptor would end the sharing entirely and is the honest ideal. Not taken:
 * Deno's `Command` exposes no portable extra fd, so it would have to be per backend, which puts
 * the transport back inside the per-language shim that the frame format exists to keep it out of.
 *
 * THE CHANNEL IS UNTRUSTED and nothing depends on it being otherwise. Jailed code can print a
 * forged frame and gains nothing by it: the compartment stamp, the labels, the forced parent, the
 * idempotency key and the agent's own grants are applied HOST-side, so a forged call is exactly as
 * constrained as a legitimate one.
 */
export const BROKER_MARK = "broker:";
export const RESULT_MARK = "result:";

/** The control character both markers begin with. Its presence anywhere OTHER than the start of a
 *  line is the interleaving signal, since nothing else on stdout has a reason to emit it. */
const MARK = "\x01";

/** Jail output the host will buffer before killing the run. Untrusted code that prints in a loop
 *  must not take the host with it, which `runCode` caps for the same reason. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Stderr kept for diagnostics. The TAIL, because the useful line of a stack trace is the last
 *  one, and a cap because the flood protection on stdout is worth nothing if the other stream is
 *  unbounded. Draining continues past the cap: stop reading and the child blocks on a full pipe. */
const MAX_STDERR_BYTES = 64 * 1024;

/** How long a child that already delivered its result may take to exit on its own. Long enough
 *  for an interpreter's teardown, short enough not to be felt. Its own exit code is worth waiting
 *  for: a kill only erases the code of a process still running (verified). */
const EXIT_GRACE_MS = 250;

/** Stderr, bounded and never rejecting. Reached only on paths that are already failing, so a
 *  rejection here would replace a real diagnosis with a stream error. */
async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text = (text + dec.decode(value, { stream: true })).slice(-MAX_STDERR_BYTES);
    }
  } catch { /* the child was killed mid-write; keep what arrived */ }
  return text;
}

/** What the OS said about the exit, in words. A signal is usually the host's own SIGKILL, so it is
 *  named rather than dressed up as the program's choice. */
function describeExit(status: Deno.CommandStatus | undefined): string {
  if (!status) return "exit status unavailable";
  if (status.signal) return `killed by ${status.signal}`;
  return `exit code ${status.code}`;
}

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

/**
 * A language's half of the protocol.
 *
 * The frames are the contract; the shim is one language's way of speaking them. That split is the
 * whole reason the frame format is the normative surface and this file is not: a Python worker is
 * a shim, not a second broker, and the host side (perform as the agent, stamp, force the parent,
 * derive the key) never learns which language asked.
 */
export interface Runtime {
  /** Matches `SandboxSpec.language`, which is how a sandbox RECORD selects this shim. */
  language: string;
  bootFile: string;
  /** `entrypoint` is an absolute path inside the materialised tree. */
  boot(entrypoint: string, record: RadiaRecord): string;
}

/** The program the jail actually runs. Generated, never materialised into the tree: the tree is
 *  content-addressed and adding a file to it would change the digest that identifies the code,
 *  and since phase 6 that directory is shared between claims. */
function jsBoot(entrypoint: string, record: RadiaRecord): string {
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
  await Deno.stdout.write(enc.encode("\\n" + ${JSON.stringify(BROKER_MARK)} + JSON.stringify({ id, op, args }) + "\\n"));
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
await Deno.stdout.write(enc.encode("\\n" + ${JSON.stringify(RESULT_MARK)} + JSON.stringify(out ?? null) + "\\n"));
`;
}

/** The same frames from Python. A worker in any language is this file plus a spawn, which is what
 *  "the protocol is the contract" has to mean if it means anything. */
function pyBoot(entrypoint: string, record: RadiaRecord): string {
  return `
import json, sys, importlib.util

_seq = 0
def _call(op, args):
    global _seq
    _seq += 1
    sys.stdout.write("\\n" + ${JSON.stringify(BROKER_MARK)} + json.dumps({"id": _seq, "op": op, "args": args}) + "\\n")
    sys.stdout.flush()
    reply = json.loads(sys.stdin.readline())
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error") or "broker refused")
    return reply.get("result")

class _Space:
    def put(self, req): return _call("put", req)
    def query(self, pattern, limit=None): return _call("query", {"pattern": pattern, "limit": limit})
    def read_one(self, pattern): return _call("read_one", {"pattern": pattern})

record = json.loads(${JSON.stringify(JSON.stringify(record))})
spec = importlib.util.spec_from_file_location("entrypoint", ${JSON.stringify(entrypoint)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = mod.main(record, _Space())
sys.stdout.write("\\n" + ${JSON.stringify(RESULT_MARK)} + json.dumps(out) + "\\n")
sys.stdout.flush()
`;
}

/** The shipped shims. A new language is an entry here plus a sandbox record that names it. */
export const RUNTIMES: Record<string, Runtime> = {
  javascript: { language: "javascript", bootFile: "boot.mjs", boot: jsBoot },
  python: { language: "python", bootFile: "boot.py", boot: pyBoot },
};

/**
 * An invoker that materialises the tree, runs the entrypoint jailed, and serves its proposals
 * under the agent's own identity.
 *
 * Replaces `sandboxInvoker` from phase 4: same isolation, plus a way for the code to participate
 * without a credential.
 */
/**
 * Which jail runs this binding, resolved from `sandbox` RECORDS.
 *
 * A binding states the PROPERTIES it needs (`{language: "python", network: false}`), not an
 * interpreter, which is design-execution.md's rule: a policy binds the property that matters
 * rather than a language name standing in for it. The host picks a declared sandbox satisfying
 * every field. No pattern means the Deno jail, which is the posture with no dependencies.
 */
export async function resolveSandbox(
  reader: RadiaClient,
  pattern?: Record<string, unknown>,
): Promise<SandboxSpec | null> {
  if (!pattern || Object.keys(pattern).length === 0) return null;
  const specs = await listSandboxes(reader);
  const match = specs.find((s) =>
    Object.entries(pattern).every(([k, v]) => JSON.stringify((s as unknown as Record<string, unknown>)[k]) === JSON.stringify(v))
  );
  if (!match) {
    throw new Error(`no declared sandbox satisfies ${JSON.stringify(pattern)}; declare one or relax the binding`);
  }
  return match;
}

export function brokeredInvoker(reader: RadiaClient, opts: BrokerOptions = {}): Invoker {
  const cache = opts.cache ?? treeCache(reader);
  return async (ctx: InvokeContext) => {
    const root = await cache.root(ctx.binding.workspaceDigest);
    const spec = await resolveSandbox(reader, ctx.binding.sandboxPattern);
    const runtime = RUNTIMES[spec?.language ?? "javascript"];
    if (!runtime) throw new Error(`no broker shim for language '${spec?.language}': add one to RUNTIMES`);
    // The boot program is PER RECORD (it carries the claimed record), so it cannot live in the
    // tree: that directory is shared between claims and two of them would clobber each other's.
    // Its own directory, added to the read roots, and removed after the run.
    const bootDir = await Deno.makeTempDir({ prefix: "radia-boot-" });
    const bootPath = `${bootDir}/${runtime.bootFile}`;
    try {
      await Deno.writeTextFile(bootPath, runtime.boot(`${root}/${ctx.binding.entrypoint}`, ctx.record));
      const readRoots = [root, bootDir, ...(opts.run?.readRoots ?? []), ...(spec?.readonlyPaths ?? [])];
      // The BACKEND is chosen by the sandbox's declared isolation, never by the language: the two
      // are independent, and conflating them is how "python means bubblewrap" becomes a rule
      // nobody wrote down. Both spawns leave stdin free, which is what the broker needs and what
      // `runCode`/`runBwrap` cannot give it.
      const child = spec?.isolation === "bubblewrap"
        ? new Deno.Command("bwrap", {
          args: bwrapArgs({
            command: [spec.runtime || "python3", bootPath],
            readRoots,
            writeRoots: opts.run?.writeRoots,
            cwd: root,
            ...(spec.network ? { unshare: ["--unshare-pid", "--unshare-ipc", "--unshare-uts"] } : {}),
          }),
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
          env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
        }).spawn()
        : new Deno.Command(Deno.execPath(), {
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
  const stderr = drainStderr(child.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, opts.timeoutMs ?? 15_000);

  let buf = "";
  let bytes = 0;
  let result: { kind: string; body: unknown } | undefined;
  let ordinal = 0;
  let failure: string | undefined;
  let status: Deno.CommandStatus | undefined;
  const chatter: string[] = [];
  /** A frame's payload, or a failure naming the frame rather than a parse offset inside it. */
  const parse = <T>(line: string, mark: string): T | undefined => {
    try {
      return JSON.parse(line.slice(mark.length)) as T;
    } catch {
      failure = `malformed frame from the entrypoint: ${line.slice(0, 200)}`;
      return undefined;
    }
  };
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = `the entrypoint wrote more than ${MAX_OUTPUT_BYTES} bytes to stdout`;
        break;
      }
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith(BROKER_MARK)) {
          const call = parse<BrokerCall>(line, BROKER_MARK);
          if (!call) break outer;
          const reply = await perform(call, ctx, opts, () => ++ordinal);
          await writer.write(enc.encode(JSON.stringify(reply) + "\n"));
        } else if (line.startsWith(RESULT_MARK)) {
          result = parse<{ kind: string; body: unknown }>(line, RESULT_MARK);
          break outer;
        } else if (line.includes(MARK)) {
          // A marker that is not at the start of its line can only mean the entrypoint's own
          // output interleaved with a frame. Diagnosed here rather than left to the timeout,
          // which would blame the wrong thing fifteen seconds later.
          failure = "the entrypoint's stdout interleaved with the broker channel " +
            `(a write with no trailing newline, just before a call): ${line.slice(0, 200)}`;
          break outer;
        } else if (line.length > 0) {
          if (chatter.length < 50) chatter.push(line);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    await writer.close().catch(() => {});
    // Keep draining stdout while the child winds down. Cancelling here instead would break its
    // pipe, and a runtime that logs one line after the result (Python raises BrokenPipeError)
    // would exit non-zero for a fault the host caused.
    const rest = (async () => {
      for (;;) if ((await reader.read()).done) return;
    })().catch(() => {});
    status = await Promise.race([
      child.status,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), result ? EXIT_GRACE_MS : 0)),
    ]);
    if (!status) {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      status = await child.status.catch(() => undefined);
    }
    await rest;
    reader.cancel().catch(() => {});
  }
  // Stderr goes on EVERY failure, not just the empty one. A traceback is the whole diagnosis and
  // it used to be dropped on exactly the paths that needed it: timeout, corruption, flood.
  const why = (await stderr).trim() || chatter.join(" | ");
  const detail = why ? `: ${why.slice(-600)}` : "";
  // A channel failure is reported BEFORE the timeout, because a corrupted channel usually causes
  // one: the jail waits on an answer that can never come. Naming the cause is the whole point.
  if (failure) throw new Error(failure + detail);
  if (timedOut) throw new Error(`entrypoint timed out after ${opts.timeoutMs ?? 15_000}ms${detail}`);
  if (!result) throw new Error(`entrypoint produced no result (${describeExit(status)})${detail}`);
  // A result AND a failing exit is the code contradicting itself, and acking it silently is the
  // worse reading: the entrypoint ran teardown that did not survive. Retry is safe here, since
  // every brokered write it already made replays on its ordinal key.
  if (status && !status.success) {
    throw new Error(`entrypoint delivered a result then failed (${describeExit(status)})${detail}`);
  }
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
