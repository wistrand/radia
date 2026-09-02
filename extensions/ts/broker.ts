// The broker: how jailed code participates in the space without ever holding a credential.
//
// agent_docs/architecture-workspace-agents.md phase 5, and the phase the one hard line waited on:
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
//      DYNAMIC READS flow the same way (`InvokeContext.observed`): a `read_one` answer becomes a
//      forced parent of every later write and of the result, and the union of labels on anything
//      answered — query pages included — is raised on them. A page's ROWS are labels, not parents:
//      the label set is closed and bounded where a 500-row parent list is neither, and the barrier
//      (what `scope.taint` enforces) is the half that must not leak.
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
import { bwrapArgs, denoRuntime, denoSandbox, jailArgs, type ProbeResult, type RunOptions, type SandboxApi, type SandboxSpec } from "./sandbox.ts";
import { declareSandbox, listSandboxes, verifySandbox } from "./sandbox-registry.ts";
import { INPUT_DIR, type InvokeContext, type Invoker, outputStamp, treeCache, type TreeCache } from "./host.ts";
import { validatePath } from "./workspace.ts";

// The channel: a PRIVATE pipe pair, not stdout.
//
// The host makes two FIFOs in a control directory and passes their paths to the shim: the run
// writes requests to `req`, reads replies from `resp`, and a frame is one line of JSON. That is the
// whole format. There is no marker, no leading newline and no interleaving rule, because nothing
// else writes to these pipes.
//
// IT USED TO BE STDOUT, and the framing rules that needed were the cost. An entrypoint that logs is
// NORMAL, so protocol shared a stream with chatter: output lacking a trailing newline
// (`print(..., end="")`, a progress bar) prepended itself to the next frame, which no longer started
// its line, was read as chatter, and left the jail blocked on an answer that never came until a
// timeout naming the wrong cause. Three rules held that off (a long printable marker starting the
// line, a leading newline before every frame, a mid-line marker diagnosed as corruption) and all
// three were things another implementation had to get exactly right on a NORMATIVE surface.
//
// A dedicated fd was the honest ideal and was declined because `Command` exposes no portable extra
// one. That reasoning missed the filesystem: a FIFO is the extra fd, reached by path. It costs NO
// new capability, which is the property that decided it over a unix socket. Measured: Deno gates
// unix sockets behind `--allow-net` (scopable to one path, but the jail's no-network posture is
// proved by that flag's ABSENCE, and safe-by-absence is worth more than a narrow allow), while a
// FIFO needs only read and write on one directory, which a run with an output tree already has.
//
// Deadlock, which is what a pipe gets wrong: opening a FIFO blocks until the other end opens. The
// host opens BOTH ends of BOTH pipes (`read: true, write: true`, i.e. O_RDWR) before spawning, which
// never blocks, so the child's opens never block either. The cost is that the host never sees EOF,
// so the read loop ends on the RESULT frame, or on the child exiting plus a quiet window.
//
// STDOUT AND STDERR ARE NOW ONLY DIAGNOSTICS, which is what people use them as anyway. A flood is
// absorbed rather than fatal: both are drained to a bounded tail.
//
// THE CHANNEL IS UNTRUSTED and nothing depends on it being otherwise. Jailed code can write a forged
// frame and gains nothing by it: the compartment stamp, the labels, the forced parent, the
// idempotency key and the agent's own grants are applied HOST-side, so a forged call is exactly as
// constrained as a legitimate one.

/** Frames the host will read from one run before giving up. Untrusted code can write in a loop, and
 *  the pipe is the one place that still costs the host memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Diagnostic output kept per stream. The TAIL, because the useful line of a stack trace is the
 *  last one. Draining continues past the cap: stop reading and the child blocks on a full pipe. */
const MAX_STDERR_BYTES = 64 * 1024;

/** How long a child that already delivered its result may take to exit on its own. Long enough
 *  for an interpreter's teardown, short enough not to be felt. Its own exit code is worth waiting
 *  for: a kill only erases the code of a process still running (verified). */
const EXIT_GRACE_MS = 250;

/** One diagnostic stream, bounded and never rejecting. A rejection here would replace a real
 *  diagnosis with a stream error, and both streams are now only ever diagnostics. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
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

/** Everything a shim writes to `req`: a call, or the one terminal frame. `op` is the discriminator,
 *  so a reader switches on one field and "the run is done" is not a separate shape to parse. */
export type Frame = BrokerCall | { op: "result"; value: { kind: string; body: unknown } | null };

/** What the host does with a frame. The seam a dry run replaces. */
export type Performer = (
  call: BrokerCall,
  ctx: InvokeContext,
  opts: BrokerOptions,
  nextOrdinal: () => number,
) => Promise<BrokerReply>;

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
  run?: Pick<RunOptions, "readRoots" | "writeRoots" | "denyRead" | "memoryMb" | "confine">;
  timeoutMs?: number;
  /** What a frame DOES. Defaults to performing it as the agent; a dry run swaps in a recorder, so a
   *  rehearsal and a real claim differ in this one function and in nothing else. */
  perform?: Performer;
  /** Where the generated boot program is written. The system temp directory by default, which is
   *  right for a standalone host and wrong for a caller confined to one writable directory: the
   *  chat's exec worker holds write access to its workspace root and nowhere else. */
  bootRoot?: string;
  /** Materialised trees, shared across claims and keyed by digest (phase 6). Safe because a warm
   *  entry cannot be stale: different code is a different digest. Pass one cache to a whole host
   *  so every agent on the same digest shares the fetch. */
  cache?: TreeCache;
  /**
   * What else, besides the claimed record, identifies this run's writes.
   *
   * A brokered write is keyed `broker:<record id>:<ordinal>`, which assumes ONE CODE PER RECORD —
   * true for `WorkspaceHost`, where the binding pins a digest, and false for any host that can run
   * different code against the same record. There the second run sends a different body under the
   * same key and the space answers `idempotency_conflict`, correctly: the key promised the write
   * was the same work. The playground hit exactly that, because its code is a textarea.
   *
   * So a host that varies the code passes the CODE'S IDENTITY here (a digest, a hash) and the key
   * becomes `broker:<record id>:<scope>:<ordinal>`. Effectively-once is then per (record, code),
   * which is what it always meant. Absent leaves every existing key byte-identical.
   */
  keyScope?: string;
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
 * The frames are the contract; the shim is one language's way of speaking them. That split is the
 * whole reason the frame format is the normative surface and this file is not: a Python worker is
 * a shim, not a second broker, and the host side (perform as the agent, stamp, force the parent,
 * derive the key) never learns which language asked.
 *
 * The two pipe paths a shim talks over. Absolute, inside a directory the jail can read and write.
 */
export interface Channel {
  /** Requests, child to host. */
  req: string;
  /** Replies, host to child. */
  resp: string;
}

export interface Runtime {
  /** Matches `SandboxSpec.language`, which is how a sandbox RECORD selects this shim. */
  language: string;
  bootFile: string;
  /** `entrypoint` is an absolute path inside the materialised tree. */
  boot(entrypoint: string, record: RadiaRecord, chan: Channel): string;
}

/**
 * What a brokered entrypoint may call, as data, so it can be DECLARED rather than described.
 *
 * Kept beside `jsBoot` because that function is the only thing that makes it true: the `space`
 * object it builds is this list, and `extensions/conformance/broker.test.ts` asserts the two agree.
 * The Python shim binds the same three names.
 *
 * THE PATTERN SHAPE IS THE PART WORTH STATING. A model that has been driving the MCP surface knows
 * `space_query` as `{kind, match}` passed as separate arguments, and guesses a flat object here;
 * the wire refuses it. That guess cost one real run five candidate patterns and five candidate
 * result shapes, tried in order (agent_docs/research-agent-sessions.md).
 */
export const BROKER_API: SandboxApi = {
  entrypoint: "export default async function (record, space) { … }",
  calls: [
    {
      call: "space.query(pattern, limit) -> record[]",
      description:
        "Read records. `pattern` is ONE object, {kind, match}, e.g. {kind: 'note', match: {topic: 'x'}}; " +
        "`match` is nested, not spread. Returns the records themselves, an array. Classification " +
        "labels on anything returned are raised on everything you write afterwards.",
    },
    {
      call: "space.readOne(pattern) -> record | null",
      description:
        "The single best match, same pattern shape. What it returns becomes a data PARENT of " +
        "everything you write afterwards, labels included: what you read flows into what you write.",
    },
    {
      call: "space.put({kind, body}) -> {id}",
      description:
        "Write a record. The host stamps the labels, the compartment and the claimed record as a " +
        "parent, so those are not yours to set and cannot be forged here.",
    },
  ],
  returns: "Whatever the entrypoint returns becomes the RESULT record: {kind, body}. Return it rather than putting it, or the answer is not fenced.",
  absent: ["fetch and any network", "the filesystem beyond the run's own directory", "process spawning", "environment variables", "console output anybody reads"],
};

/** The program the jail actually runs. Generated, never materialised into the tree: the tree is
 *  content-addressed and adding a file to it would change the digest that identifies the code,
 *  and since phase 6 that directory is shared between claims. */
function jsBoot(entrypoint: string, record: RadiaRecord, chan: Channel): string {
  return `
const enc = new TextEncoder(), dec = new TextDecoder();
// Neither open blocks: the host holds both ends of both pipes before this process starts.
const req = await Deno.open(${JSON.stringify(chan.req)}, { write: true });
const resp = await Deno.open(${JSON.stringify(chan.resp)}, { read: true });
const rbuf = new Uint8Array(65536);
let buf = "";
async function nextLine() {
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return line; }
    const n = await resp.read(rbuf);
    if (n === null) throw new Error("broker channel closed");
    buf += dec.decode(rbuf.subarray(0, n), { stream: true });
  }
}
async function send(msg) { await req.write(enc.encode(JSON.stringify(msg) + "\\n")); }
let seq = 0;
async function call(op, args) {
  const id = ++seq;
  await send({ id, op, args });
  const reply = JSON.parse(await nextLine());
  if (!reply.ok) throw new Error(reply.error ?? "broker refused");
  return reply.result;
}
const space = {
  put: (r) => call("put", r),
  query: (pattern, limit) => call("query", { pattern, limit }),
  readOne: (pattern) => call("read_one", { pattern }),
};
const record = ${JSON.stringify(record)};
const mod = await import(${JSON.stringify(`file://${entrypoint}`)});
const out = await mod.default(record, space);
await send({ op: "result", value: out ?? null });
`;
}

/** The same frames from Python. A worker in any language is this file plus a spawn, which is what
 *  "the protocol is the contract" has to mean if it means anything. */
function pyBoot(entrypoint: string, record: RadiaRecord, chan: Channel): string {
  return `
import json, importlib.util

# Neither open blocks: the host holds both ends of both pipes before this process starts.
_req = open(${JSON.stringify(chan.req)}, "w")
_resp = open(${JSON.stringify(chan.resp)}, "r")

def _send(msg):
    _req.write(json.dumps(msg) + "\\n")
    _req.flush()

_seq = 0
def _call(op, args):
    global _seq
    _seq += 1
    _send({"id": _seq, "op": op, "args": args})
    reply = json.loads(_resp.readline())
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
_send({"op": "result", "value": mod.main(record, _Space())})
`;
}

/** The shipped shims. A new language is an entry here plus a sandbox record that names it. */
export const RUNTIMES: Record<string, Runtime> = {
  javascript: { language: "javascript", bootFile: "boot.mjs", boot: jsBoot },
  python: { language: "python", bootFile: "boot.py", boot: pyBoot },
};

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

/**
 * Refuse a jail this process cannot build, rather than downgrading to one it can.
 *
 * A `web-worker` spec is served in a BROWSER (extensions/ts/sandbox-web.ts), where an opaque
 * origin and a CSP are the boundary. This host builds a Deno or bwrap process, so running that
 * code here would execute it under the wrong guarantees while the record still advertised the
 * browser's. Same reading as the host's `digest_mismatch`: two halves that disagree are a refusal,
 * never a best effort. One function, two call sites (the invoker and `runBrokered`), because the
 * dry run reaches only the second.
 */
function assertHostCanRun(spec: SandboxSpec | null): void {
  if (spec?.isolation !== "web-worker") return;
  throw new Error(
    `sandbox '${spec.name}' is isolation 'web-worker' and cannot run on this host: it is served ` +
      `in a browser by extensions/ts/sandbox-web.ts, whose guarantees this process does not have`,
  );
}

/**
 * Declare what a brokered host runs and what its code may call, as a `sandbox` record.
 *
 * WRITTEN BY THE HOST rather than by an operator, which is the same shape `declareExecJail` already
 * takes: the process that builds the jail is the one that knows what it built. `verifySandbox`
 * stays the check on that claim, and the split in `sandbox-registry.ts` still holds for anything a
 * host cannot prove about itself.
 *
 * It exists so the API is DISCOVERABLE. Everything else about a jail was already a record a caller
 * could query; the three calls its code may make were in no record, no kind usage and no tool
 * description, so the only way to learn them was to guess.
 */
export async function declareBrokerSandbox(
  client: RadiaClient,
  opts: {
    name?: string;
    timeoutMs?: number;
    networkTarget?: string;
    /** The confiner the host will run brokered claims under, so the record declares (and the probe
     *  tests) the jail that actually serves. Only bubblewrap: the broker has no Seatbelt spawn. */
    confine?: "bubblewrap";
    /** Probe results the CALLER already measured for this same jail construction, in this process
     *  (`selectJavascriptJail` builds and probes exactly the jail `confine` names, roots empty).
     *  Passing them skips a second identical probe pass, which was half of `radia host`'s startup
     *  cost. EVIDENCE, not trust: pass only results from probing the same confine on this host,
     *  never an empty array to silence the check. */
    probed?: ProbeResult[];
  } = {},
): Promise<{ id: string; refusedBecause: ProbeResult[] }> {
  const spec: SandboxSpec = {
    ...denoSandbox({
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.confine ? { confine: opts.confine } : {}),
      name: opts.name ?? "brokered-host",
    }),
    // The roots are PER CLAIM (a boot dir, a control dir, the tree, maybe an output dir), so the
    // declaration states the ones a caller can reason about rather than inventing a fixed list.
    readonlyPaths: [],
    writablePaths: [],
    api: BROKER_API,
  };
  // PROBED BEFORE IT IS PUBLISHED, which is the rule this registry exists for: "a declaration
  // nobody tested is a more convincing version of an unenforced sentence" (sandbox-registry.ts).
  // The first version of this function published `network: false` and `processes: false` on a jail
  // nothing had tried, in the one subsystem whose whole doctrine is verify-before-serve.
  //
  // The space's own address is the network probe's target, because a probe with nothing to dial
  // cannot tell an isolated jail from an offline machine. Failures are RETURNED rather than thrown:
  // the caller decides whether an unproven jail is worth serving, exactly as `selectJavascriptJail`
  // hands `refusedBecause` back to its launcher.
  const refusedBecause = opts.probed ??
    (opts.networkTarget
      ? await verifySandbox(spec, {
        networkTarget: opts.networkTarget,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
      : []);
  const { id } = await declareSandbox(client, spec);
  return { id, refusedBecause };
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
    // The jail is resolved BEFORE the tree is materialised: a refusable pairing should cost one
    // registry read, not a manifest plus an artifact fetch per file.
    const spec = await resolveSandbox(reader, ctx.binding.sandboxPattern);
    assertHostCanRun(spec);
    const root = await cache.root(ctx.binding.workspaceDigest);
    // ONE STAMP, DERIVED FROM THE BINDING, so a proposal and the returned result carry the same
    // fields. It used to be the caller's to supply and `radia host` supplied none, so the
    // compartment label the host is supposed to guarantee reached neither path
    // (agent_docs/research-agent-sessions.md). A caller-supplied stamp still wins, which is what
    // lets a test build one by hand.
    const stamp = { ...outputStamp(ctx.binding, ctx.record), ...(opts.stamp ?? {}) };
    return await runBrokered(root, ctx.binding.entrypoint, spec, ctx, {
      ...opts,
      ...(Object.keys(stamp).length ? { stamp } : {}),
    });
  };
}

/**
 * Two named pipes.
 *
 * There is no Deno API for this, so it is coreutils, and that is the channel's ONE cost: a host
 * that brokers needs `--allow-run` to cover `mkfifo` as well as its interpreter. Paid on the HOST
 * side deliberately. The alternative was a unix socket, which costs the CHILD `--allow-net`, and
 * the jail's no-network posture is proved by that flag's absence: a capability on the untrusted
 * side is worth more than one on the trusted side. Found the hard way, by a worker launched
 * `--allow-run=deno` failing with nothing to read, which is why this names the flag.
 */
async function mkfifo(...paths: string[]): Promise<void> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command("mkfifo", { args: paths, stderr: "piped" }).output();
  } catch (e) {
    throw new Error(
      `the broker could not create its channel: ${e instanceof Error ? e.message : e}. ` +
        "A host that brokers needs --allow-run to include mkfifo.",
    );
  }
  if (!out.success) {
    throw new Error(`mkfifo failed (is this a POSIX host?): ${new TextDecoder().decode(out.stderr).trim()}`);
  }
}

/**
 * Spawn the jail over a materialised tree and serve its frames.
 *
 * The ONE place the backend is chosen and the boot is written, shared by a real claim and by a DRY
 * RUN. Sharing it is the point: a rehearsal that spawned its own way would be testing something
 * other than what a host does, which is the whole reason a dry run exists.
 */
async function runBrokered(
  root: string,
  entrypoint: string,
  spec: SandboxSpec | null,
  ctx: InvokeContext,
  opts: BrokerOptions,
): Promise<{ kind: string; body: unknown; parentIds?: string[]; taint?: string[] }> {
  {
    assertHostCanRun(spec); // also reached by `dryRunEntrypoint`, which the invoker above bypasses
    // A binding's entrypoint arrives verbatim from `radia bind`; `validateEntrypoint` runs only on
    // workspace WRITE paths, for the manifest's own default. Module loading is not bounded by the
    // jail's read permissions (architecture-jail-confinement.md), so a `..` here would import code
    // from outside the tree wherever no confiner runs.
    validatePath(entrypoint);
    const runtime = RUNTIMES[spec?.language ?? "javascript"];
    if (!runtime) throw new Error(`no broker shim for language '${spec?.language}': add one to RUNTIMES`);
    // The boot program is PER RECORD (it carries the claimed record), so it cannot live in the
    // tree: that directory is shared between claims and two of them would clobber each other's.
    // Its own directory, added to the read roots, and removed after the run.
    const bootDir = await Deno.makeTempDir({ dir: opts.bootRoot || undefined, prefix: "radia-boot-" });
    const bootPath = `${bootDir}/${runtime.bootFile}`;
    // The control directory is SEPARATE from both the boot directory (which stays read-only) and the
    // output tree (whose walk would try to store a FIFO as a file). It holds two pipes and nothing
    // else, which is the whole write surface the channel costs.
    const ctlDir = await Deno.makeTempDir({ dir: opts.bootRoot || undefined, prefix: "radia-ctl-" });
    const chan: Channel = { req: `${ctlDir}/req`, resp: `${ctlDir}/resp` };
    let pipes: { req: Deno.FsFile; resp: Deno.FsFile } | undefined;
    try {
      await mkfifo(chan.req, chan.resp);
      // O_RDWR on BOTH, before the spawn: opening a FIFO otherwise blocks until the other end opens,
      // so the host would hang HERE, before spawning anything and ahead of any run timeout. Verified
      // by planting it, and the plant hangs every case in the suite rather than one. Holding a write
      // end also means the host never sees EOF, which `serve` handles with a quiet window.
      pipes = {
        req: await Deno.open(chan.req, { read: true, write: true }),
        resp: await Deno.open(chan.resp, { read: true, write: true }),
      };
      await Deno.writeTextFile(bootPath, runtime.boot(`${root}/${entrypoint}`, ctx.record, chan));
      const readRoots = [root, bootDir, ctlDir, ...(ctx.outDir ? [ctx.outDir] : []), ...(ctx.inputDir ? [ctx.inputDir] : []), ...(opts.run?.readRoots ?? []), ...(spec?.readonlyPaths ?? [])];
      // The OUTPUT tree, per claim, and the only writable path an entrypoint gets. Never `root`:
      // that directory is the agent's CODE, shared between concurrent claims and pinned by the
      // digest the grant promotes, so a run writing into it races its neighbours and changes the
      // identity the pin refers to. Absent unless the binding asked for one (host.ts).
      const writeRoots = [ctlDir, ...(opts.run?.writeRoots ?? []), ...(ctx.outDir ? [ctx.outDir] : [])];
      // The output tree is the CWD when there is one, so saving a file is `open("chart.png", "wb")`
      // in any language, with nothing added to the entrypoint signature; an inputs-only run gets
      // its read-only input dir instead, so `input/<path>` resolves the same way in both postures.
      // The boot program imports the entrypoint by absolute path, so nothing here depends on the
      // cwd being the code tree.
      const cwd = ctx.outDir ?? ctx.inputDir ?? root;
      // The BACKEND is chosen by the sandbox's declared isolation, never by the language: the two
      // are independent, and conflating them is how "python means bubblewrap" becomes a rule
      // nobody wrote down. Both spawns leave stdin free, which is what the broker needs and what
      // `runCode`/`runBwrap` cannot give it.
      //
      // A Deno spec's CONFINER is delivered or the pairing is refused, never downgraded: the
      // web-worker rule (`assertHostCanRun`) applied to the confiner axis. Without this, a binding
      // resolved to the `deno-confined` record ran in the PLAIN jail while the record went on
      // advertising `importsConfined: true`, and module loading is not bounded by the jail's read
      // permissions, so that one silent loss opens the host's own files to a dynamic import.
      const confine = spec?.confiner && spec.confiner !== "none" ? spec.confiner : opts.run?.confine;
      if (confine === "sandbox-exec") {
        // UNBUILT, not impossible: the ingredients for a Seatbelt spawn exist (`sandboxExecProfile`
        // is exported, `jailArgs` covers the FIFO control dir's write root, writes ride the
        // profile's `(allow default)` gated by Deno's own flags), so the branch is ~20 lines
        // mirroring the bwrap one below. It is missing because macOS confinement ships only
        // VERIFIED ON A REAL MAC (architecture-jail-confinement.md: the probe failed its first
        // real Mac boot on a getcwd trap only hardware surfaces, and FIFOs under a profile are
        // that kind of detail). Until then brokered bindings on a Mac run the plain jail and SAY
        // so; write the branch under the boot probe, never ahead of it.
        throw new Error(
          `sandbox '${spec?.name ?? "(host option)"}' needs the sandbox-exec confiner and this broker has no ` +
            "Seatbelt spawn: refusing rather than running unconfined. Declare a bubblewrap-confined " +
            "sandbox, or relax the binding to one whose claims this host can deliver.",
        );
      }
      const confined = spec?.isolation === "bubblewrap" || confine === "bubblewrap";
      if (spec?.importsConfined && !confined) {
        throw new Error(
          `sandbox '${spec.name}' claims importsConfined with no confiner this broker can build: ` +
            "refusing rather than running unconfined under a record that says otherwise.",
        );
      }
      const child = spec?.isolation === "bubblewrap"
        ? new Deno.Command("bwrap", {
          args: bwrapArgs({
            command: [spec.runtime || "python3", bootPath],
            readRoots,
            writeRoots,
            cwd,
            ...(spec.network ? { unshare: ["--unshare-pid", "--unshare-ipc", "--unshare-uts"] } : {}),
          }),
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
          env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
        }).spawn()
        : confine === "bubblewrap"
        // The jail inside a mount namespace, for the reason `RunOptions.confine` states: the
        // permission model does not bound module loading, and this is the code path that runs
        // model-written entrypoints against real data. Reached by the record's own `confiner` as
        // well as the host option, so a `deno-confined` binding gets what its record declares.
        ? new Deno.Command("bwrap", {
          args: bwrapArgs({
            command: [denoRuntime(), ...jailArgs({ ...opts.run, readRoots, writeRoots }, opts.run?.memoryMb ?? 256, bootPath)],
            readRoots: [...readRoots, denoRuntime().slice(0, denoRuntime().lastIndexOf("/")) || "/usr/bin"],
            ...(writeRoots.length ? { writeRoots } : {}),
            cwd,
            unshare: ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup"],
          }),
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
          env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
        }).spawn()
        : new Deno.Command(denoRuntime(), {
          cwd,
          args: jailArgs({ ...opts.run, readRoots, writeRoots }, opts.run?.memoryMb ?? 256, bootPath),
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
          env: { HOME: Deno.env.get("HOME") ?? "/tmp", PATH: "/usr/bin:/bin" },
        }).spawn();
      const result = await serve(child, pipes, ctx, opts);
      // The RESULT rides the same rule as the brokered writes: the run's dynamic reads become the
      // ack's parents beside the materialised inputs (the host merges; the server adds the claimed
      // record itself) and the observed labels ride as a raise.
      const seen = ctx.observed;
      if (!seen || (seen.ids.length === 0 && seen.labels.length === 0)) return result;
      return {
        ...result,
        ...(seen.ids.length ? { parentIds: seen.ids } : {}),
        ...(seen.labels.length ? { taint: seen.labels } : {}),
      };
    } finally {
      pipes?.req.close();
      pipes?.resp.close();
      await Deno.remove(bootDir, { recursive: true }).catch(() => {});
      await Deno.remove(ctlDir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Keep BOTH ENDS of a diagnostic, because which end carries the message depends on the language.
 *
 * A tail-only clip was the first answer and it is right for Python, where the exception message is
 * the LAST line of a traceback. It is wrong for JavaScript, where `error: Uncaught ...` is the FIRST
 * line and the frames below it are the part nobody needs: 600 characters of `file:///tmp/...`
 * stack pushed the real cause off the front, and the failure read as an exit code with no reason.
 * That is the same shape as the bug where two caps at opposite ends lost the cause between them.
 * The two ends are sized for what each has to catch, not split evenly: the head only needs a first
 * line, the tail needs a message that sits ABOVE a stack (an even split starved it and dropped the
 * cause of a flood).
 */
function clip(text: string, head = 300, tail = 700): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

/** How long the host keeps reading a quiet pipe after the child has exited. The host holds a write
 *  end, so there is no EOF to wait for: a window with nothing arriving is the drained signal. Only
 *  ever paid on the failure path, since a run that delivered a result stops at the frame. */
const DRAIN_QUIET_MS = 50;

/** The host side of the channel: read frames, perform them as the agent, answer, and collect the
 *  entrypoint's return value. */
async function serve(
  child: Deno.ChildProcess,
  pipes: { req: Deno.FsFile; resp: Deno.FsFile },
  ctx: InvokeContext,
  opts: BrokerOptions,
): Promise<{ kind: string; body: unknown }> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  // Both streams are diagnostics now, so both are absorbed rather than parsed: a flood costs a
  // bounded tail instead of killing the run, and neither can corrupt the channel.
  const stderr = drainStream(child.stderr);
  const stdout = drainStream(child.stdout);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, opts.timeoutMs ?? 15_000);

  const exited = child.status.then((st) => st).catch(() => undefined);
  const rbuf = new Uint8Array(64 * 1024);
  let buf = "";
  let bytes = 0;
  let result: { kind: string; body: unknown } | undefined;
  let ordinal = 0;
  let failure: string | undefined;
  let status: Deno.CommandStatus | undefined;
  try {
    outer: for (;;) {
      // The read never settles on an idle pipe, so it races a quiet window that only opens once the
      // child is gone. Read FIRST in the array: with both already settled, a frame still in the
      // pipe wins over the window, which is what stops a result being dropped by a fast exit.
      const n = await Promise.race([
        pipes.req.read(rbuf),
        exited.then(() => new Promise<"drained">((r) => setTimeout(() => r("drained"), DRAIN_QUIET_MS))),
      ]);
      if (n === "drained" || n === null) break;
      bytes += n;
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = `the entrypoint wrote more than ${MAX_OUTPUT_BYTES} bytes of frames`;
        break;
      }
      buf += dec.decode(rbuf.subarray(0, n), { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line);
        } catch {
          // Nothing but the shim writes here, so this is a broken shim rather than interleaving,
          // and naming the line beats a parse offset inside it.
          failure = `malformed frame from the entrypoint: ${line.slice(0, 200)}`;
          break outer;
        }
        if (frame.op === "result") {
          result = frame.value ?? undefined;
          break outer;
        }
        const reply = await (opts.perform ?? perform)(frame, ctx, opts, () => ++ordinal);
        await pipes.resp.write(enc.encode(JSON.stringify(reply) + "\n"));
      }
    }
  } finally {
    clearTimeout(timer);
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
  }
  // Stderr goes on EVERY failure, not just the empty one. A traceback is the whole diagnosis and
  // it used to be dropped on exactly the paths that needed it: timeout, corruption, flood.
  const why = (await stderr).trim() || (await stdout).trim();
  const detail = why ? `: ${clip(why)}` : "";
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

/**
 * Why a put was refused, in terms of the CALL the code made rather than the field the host wanted.
 *
 * "put needs a kind" was the whole message, and a model that had written `space.put("result", out)`
 * got no hint that the problem was positional arguments. The signature is the thing to restate: it
 * is the one part of the contract a shim's author cannot see from inside the jail.
 */
function whyNotAPut(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `space.put takes ONE object, space.put({kind, body}), and received ${
      Array.isArray(args) ? "an array" : typeof args
    }. Positional arguments (space.put("kind", body)) are not the shape.`;
  }
  if (typeof (args as { kind?: unknown }).kind !== "string") {
    return "space.put({kind, body}) needs a string `kind`, which is what routes the record.";
  }
  return undefined;
}

/** The idempotency key for one brokered write: the claimed record, the code's identity when the
 *  host varies it (`keyScope`), and the ordinal. See `BrokerOptions.keyScope` for why the middle
 *  term exists and why it is optional. */
function brokerKey(ctx: InvokeContext, opts: BrokerOptions, ordinal: number): string {
  return `broker:${ctx.record.id}${opts.keyScope ? `:${opts.keyScope}` : ""}:${ordinal}`;
}

/**
 * One proposal, performed as the AGENT. Every host-side rule lives here, because this is the one
 * place the jail's output becomes a write.
 *
 * Exported as `brokerPerformer` for a SECOND TRANSPORT (the Web Worker backend, sandbox-web.ts):
 * the frames are the contract and the transport is not, so a new backend brings a shim and reuses
 * this. Reimplementing it per transport would fork the stamp, the forced parents, the labels and
 * the ordinal key — the half that makes any of it safe.
 */
async function perform(
  call: BrokerCall,
  ctx: InvokeContext,
  opts: BrokerOptions,
  nextOrdinal: () => number,
): Promise<BrokerReply> {
  try {
    if (call.op === "put") {
      const bad = whyNotAPut(call.args);
      if (bad) throw new Error(bad);
      const req = call.args as { kind: string; body?: unknown; parentIds?: unknown; taint?: unknown };
      const body = { ...(req.body as Record<string, unknown> ?? {}), ...(opts.stamp ?? {}) };
      const declared = Array.isArray(req.taint) ? req.taint.map(String) : [];
      // Lineage the code does not get to omit, labels it does not get to withhold. The materialised
      // inputs are forced alongside the claimed record, and so is everything the run has READ
      // through the broker so far (`ctx.observed`): what the code read flows into what it wrote.
      const forced = [...new Set([ctx.record.id, ...(ctx.inputIds ?? []), ...(ctx.observed?.ids ?? [])])];
      const parentIds = [...forced, ...(Array.isArray(req.parentIds) ? req.parentIds.map(String) : []).filter((p) => !forced.includes(p))];
      const taint = [...new Set([...declared, ...(opts.labels ?? []), ...(ctx.observed?.labels ?? [])])];
      const out = await ctx.client.put(
        { kind: req.kind, body, parentIds, ...(taint.length ? { taint } : {}) },
        brokerKey(ctx, opts, nextOrdinal()),
      );
      return { id: call.id, ok: true, result: out };
    }
    if (call.op === "query" || call.op === "read_one") {
      const { pattern, limit } = call.args as { pattern?: Record<string, unknown>; limit?: number };
      if (!pattern || typeof pattern.kind !== "string") throw new Error("query needs a pattern with a kind");
      // deno-lint-ignore no-explicit-any
      const p = pattern as any;
      // Every read is OBSERVED, so the write side can force what the code consumed into what it
      // writes (property 2 in the header). A `read_one` answer contributes its id AND its labels;
      // a query page contributes labels only, because parents name records consumed singly while
      // the label set is closed and bounded, and the barrier is the half that must not leak.
      const seen = (ctx.observed ??= { ids: [], labels: [] });
      const note = (rec: { id: string; runtimeMeta: { taint: string[] } }, withId: boolean) => {
        if (withId && !seen.ids.includes(rec.id)) seen.ids.push(rec.id);
        for (const l of rec.runtimeMeta.taint) if (!seen.labels.includes(l)) seen.labels.push(l);
      };
      // `read_one` answers with the RECORD or null, the same shape the SDK call of that name has.
      // It used to answer with a one-element array (or an empty one), so jailed code calling
      // `space.readOne` got back something no other caller of that name gets, on a surface this
      // file declares NORMATIVE (audit package W7).
      if (call.op !== "query") {
        const rec = (await ctx.client.readOne(p)) ?? null;
        if (rec) note(rec, true);
        return { id: call.id, ok: true, result: rec };
      }
      // The pattern is the JAIL's, so `order_by` is data. A directional read cannot be combined
      // with it, so honour the pattern's own order when it has one rather than refusing the call.
      const n = Math.min(Number(limit) || 50, 500);
      const rows = p.orderBy?.length ? await ctx.client.queryOrdered(p, n) : await ctx.client.queryOldest(p, n);
      for (const r of rows) note(r, false);
      return { id: call.id, ok: true, result: rows };
    }
    throw new Error(`unsupported op '${call.op}': the broker serves put, query and read_one`);
  } catch (e) {
    // A refusal is DATA, so the entrypoint sees a normal error and the run continues. The host
    // never dies on the jail's behalf, and a 403 reads as a 403 rather than as a crash.
    return { id: call.id, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
}

export { perform as brokerPerformer };

// ── the dry run: the same rehearsal a host would give, writing nothing ───────────────────────────

/** One write the entrypoint proposed, with every host-side rule already applied. */
export interface Proposal {
  ordinal: number;
  kind: string;
  body: Record<string, unknown>;
  /** Including the claimed record, which the code does not get to omit. */
  parentIds: string[];
  /** Including the labels the JAIL implies, which the code does not get to withhold. */
  taint: string[];
  /** The key the real performer would have used, so "would this replay?" is answerable. */
  idempotencyKey: string;
}

/**
 * A performer that writes NOTHING and records what would have been written.
 *
 * It applies the host's rules first (stamp, labels, the forced parent, the ordinal key), because a
 * rehearsal that showed only what the code SAID would hide the half that makes the real thing safe:
 * the compartment stamp and the claimed record as a parent are exactly what a reviewer is checking.
 *
 * Reads are REFUSED rather than served. A dry run has no credential of its own, and answering a
 * query from whatever client happened to be nearby would hand jailed code that principal's reach.
 */
export function recordingPerformer(into: Proposal[]): Performer {
  return (call, ctx, opts, nextOrdinal) => {
    if (call.op === "put") {
      const bad = whyNotAPut(call.args);
      if (bad) return Promise.resolve({ id: call.id, ok: false, error: bad });
      const req = call.args as { kind: string; body?: unknown; parentIds?: unknown; taint?: unknown };
      const ordinal = nextOrdinal();
      // The same forced-flow expressions as `perform`, so a rehearsal cannot show laxer lineage
      // than a real run. `observed` stays empty here because a dry run refuses reads.
      const forced = [...new Set([ctx.record.id, ...(ctx.inputIds ?? []), ...(ctx.observed?.ids ?? [])])];
      const proposal: Proposal = {
        ordinal,
        kind: req.kind,
        body: { ...(req.body as Record<string, unknown> ?? {}), ...(opts.stamp ?? {}) },
        parentIds: [...forced, ...(Array.isArray(req.parentIds) ? req.parentIds.map(String) : []).filter((p) => !forced.includes(p))],
        taint: [...new Set([...(Array.isArray(req.taint) ? req.taint.map(String) : []), ...(opts.labels ?? []), ...(ctx.observed?.labels ?? [])])],
        idempotencyKey: brokerKey(ctx, opts, ordinal),
      };
      into.push(proposal);
      // A recognisably fake id. Code that stores one and looks it up later should fail in the
      // rehearsal rather than appear to work and then fail for real.
      return Promise.resolve({ id: call.id, ok: true, result: { id: `dry-run:${ordinal}`, dryRun: true } });
    }
    return Promise.resolve({
      id: call.id,
      ok: false,
      error: `a dry run does not read the space, so '${call.op}' is refused here; it will work when this runs as the agent`,
    });
  };
}

/**
 * Run a tree's entrypoint the way a HOST would, and write nothing.
 *
 * The point is fidelity on the parts that are easy to get wrong: the same shim, the same frames,
 * the same jail, the same host-side rules. What comes back is the entrypoint's declared result plus
 * the transcript of everything it would have written, which is the evidence a promotion review
 * wants before anything is bound.
 *
 * The caller materialises the tree, because it usually has one already; taking a digest here would
 * fetch a second copy.
 */
export async function dryRunEntrypoint(
  opts: BrokerOptions & {
    root: string;
    entrypoint: string;
    record: RadiaRecord;
    spec?: SandboxSpec | null;
    /**
     * Sample inputs for the rehearsal, path -> contents, landing at `input/<path>` in a WRITABLE
     * rehearsal cwd: the same layout a host with an output tree gives a real run, so an entrypoint
     * that writes its output beside its input rehearses unchanged. CALLER-SUPPLIED bytes, never
     * fetched: a dry run holds no credential, and the whole point of rehearsing a data-processing
     * entrypoint is exercising its transform without touching the data it will be granted later.
     * Files it writes land in the temp dir and are removed with it; "writes nothing" is about the
     * space.
     */
    inputFiles?: Record<string, string | Uint8Array>;
  },
): Promise<{ result: { kind: string; body: unknown }; proposals: Proposal[] }> {
  const proposals: Proposal[] = [];
  // Provably unused rather than merely unused: a dry run holds no credential, and anything that
  // reaches for one fails loudly here instead of quietly borrowing the caller's.
  const client = new Proxy({} as RadiaClient, {
    get(_t, prop) {
      throw new Error(`a dry run has no space access (tried to use client.${String(prop)})`);
    },
  });
  let runDir: string | undefined;
  if (opts.inputFiles && Object.keys(opts.inputFiles).length > 0) {
    runDir = await Deno.makeTempDir({ dir: opts.bootRoot || undefined, prefix: "radia-rehearse-" });
    for (const [rel, contents] of Object.entries(opts.inputFiles)) {
      validatePath(rel);
      const target = `${runDir}/${INPUT_DIR}/${rel}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(target, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
    }
  }
  const ctx: InvokeContext = {
    binding: { agent: "dry-run", workspaceDigest: "", entrypoint: opts.entrypoint },
    record: opts.record,
    client,
    // As outDir, deliberately: a host materialises real inputs INTO the writable output tree, so
    // the rehearsal wearing the same shape is what lets the same code run in both.
    ...(runDir ? { outDir: runDir } : {}),
  };
  try {
    const result = await runBrokered(opts.root, opts.entrypoint, opts.spec ?? null, ctx, {
      ...opts,
      perform: recordingPerformer(proposals),
    });
    return { result, proposals };
  } finally {
    if (runDir) await Deno.remove(runDir, { recursive: true }).catch(() => {});
  }
}
