// Running untrusted code in a permissionless subprocess.
//
// An EXTENSION: the runtime executes nothing, and a sandbox is meaningless inside one
// application, so it sits beside the workspace convention rather than in either neighbour (see
// extensions/README.md). Phase 5 of plan-workspaces.md puts a `sandbox` RECORD on top of this;
// what is here is only the mechanism.
//
// It imports NOTHING, including for the SandboxSpec and the probe below. That is the property
// worth keeping: the jail is Deno's permission flags, so there is no policy to get wrong and
// nothing to keep in sync with the runtime. Publishing a spec as a record needs a client, so that
// lives next door in sandbox-registry.ts rather than here.
//
// The sandbox: run model-written JavaScript with nothing.
//
// A fresh `deno` subprocess with (by default) ZERO permissions: no `--allow-net`, `--allow-read`,
// `--allow-env`, `--allow-run`, nothing. Every capability check inside it therefore fails. The program
// arrives on stdin (`deno run -`), which is also why no file needs to be readable. The only thing
// that crosses back is bytes on stdout/stderr.
//
// READ access to explicit roots is the one grantable capability (`readRoots`), because "look at
// this data" is a common, useful request and is a different risk from "change it" or "send it
// somewhere": with no network and no write, a program that reads can only return what it read
// through the output the user is already shown. Net, write, env and run remain denied always.
//
// Why a subprocess and not a Worker: hostile code should not share a heap with the thing holding
// a run token. Why not the tool-worker (`workers/tools.ts`): spawning needs `--allow-run`, which that
// process deliberately lacks, and it holds a credential this code must never reach.
//
// What this IS: a boundary against accidents and ordinary malice, meaning exfiltration, snooping,
// clobbering, runaway loops. What it is NOT: a hard boundary against a V8 or Deno 0-day. For a
// local example that is proportionate; anything multi-tenant or internet-facing wants OS-level
// isolation (container, gVisor, Firecracker) around this same worker.
//
// Known gaps, stated rather than papered over (all measured, not assumed):
//   - No CPU bound. A `while(true)` spins one core until the timeout fires.
//   - Memory is bounded only for V8's OLD SPACE. `--max-old-space-size` kills an ordinary
//     object-allocation loop in ~0.3s ("Reached heap limit", exit 133), but a TypedArray's backing
//     store is external to that heap, so `while(true) a.push(new Uint8Array(1e7))` is bounded by
//     the TIMEOUT, not the flag; it can chew host RAM for the whole window. Keep the timeout
//     short, and use `ulimit -v` or a container for anything beyond local single-user use.
//   - `Date.now()` / `Math.random()` work, so executions are not reproducible (re-execution, not
//     replay; see design-observability).
//   - Output is capped; a program that prints forever gets truncated, not obeyed.

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryMb?: number;
  /** Absolute paths the program may READ. Empty (the default) means no filesystem at all. Granting
   *  a root grants everything under it, so this is an operator decision made at launch, never
   *  something the model can widen per call. */
  readRoots?: string[];
  /** Paths denied even inside a granted root. `--deny-read` beats `--allow-read` in Deno, so this
   *  is a hard exclusion, not a convention. */
  denyRead?: string[];
  /** Working directory for the child. Set when running against a materialised tree so the program
   *  is IN it: relative reads resolve the way they would in a checkout, and nothing has to tell the
   *  program a temp path it could not otherwise know. */
  cwd?: string;
  /** Absolute paths the program may WRITE. Empty (the default) means it cannot write at all, which
   *  is the posture every run had until workspaces: the only reason to grant this is a tree whose
   *  changes are about to be captured, and it should name that tree and nothing else. */
  writeRoots?: string[];
}

export interface RunResult {
  ok: boolean; // exited 0, in time, without being killed
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

const DEFAULTS = { timeoutMs: 5_000, maxOutputBytes: 64 * 1024, memoryMb: 128 };
/** Probes run once at boot and get longer than ordinary work: a cold interpreter under a fresh
 *  namespace is measurably slower than a warm one, and a probe that times out now REFUSES the
 *  sandbox rather than passing it, so a tight bound turns a slow machine into a broken fleet. */
const PROBE_TIMEOUT_MS = 30_000;

/** Read a stream up to a byte cap, then stop reading (the writer gets EPIPE, which is the point:
 *  a program that prints forever is truncated rather than allowed to exhaust this process). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        chunks.push(value.subarray(0, Math.max(0, cap - total)));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // the child was killed mid-write; whatever we already have is the output
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  // Strip ANSI: Deno colours its error output, and those escapes would otherwise land verbatim in
  // a record and then in the model's context, where they are noise it has to reason around.
  const text = new TextDecoder().decode(joined).replace(/\x1b\[[0-9;]*m/g, "");
  return { text, truncated };
}

/**
 * The jail's flags, in ONE place.
 *
 * `runCode` runs a program from stdin (`entry: "-"`); the BROKER runs one from a file, because it
 * needs stdin free as a response channel. That is the only difference between them, and a second
 * copy of these flags would be a second security boundary to keep in step: the same reasoning
 * `drive` below is shared for.
 *
 * READ is the one capability that can be granted, and only to explicit roots. Write is granted
 * only when a caller names a directory. NET, ENV, RUN, FFI and SYS are denied whatever any caller
 * passes, which is what makes a brokered channel the only way out of the jail.
 */
export function jailArgs(opts: RunOptions, memoryMb: number, entry: string): string[] {
  const readRoots = opts.readRoots ?? [];
  const denyRead = opts.denyRead ?? [];
  return [
    "run",
    "--no-prompt", // a denied permission fails; it never waits for a human that isn't there
    "--no-remote", // `import("https://…")` cannot even be attempted
    "--quiet",
    ...(entry === "-" ? ["--ext=js"] : []), // stdin has no filename, so the dialect must be stated
    `--v8-flags=--max-old-space-size=${memoryMb}`,
    ...(readRoots.length ? [`--allow-read=${readRoots.join(",")}`] : []),
    ...(opts.writeRoots?.length ? [`--allow-write=${opts.writeRoots.join(",")}`] : []),
    ...(denyRead.length ? [`--deny-read=${denyRead.join(",")}`] : []),
    entry,
  ];
}

function spawnDeno(entry: string, opts: RunOptions, memoryMb: number): Deno.ChildProcess {
  // The RUNNING runtime, by absolute path, not the name `deno` resolved against the PATH this
  // command itself invents (`/usr/bin:/bin` below). Two reasons, and CI found the first: on a
  // machine where Deno is installed anywhere else — a GitHub runner puts it in the tool cache —
  // the lookup simply fails with "entity not found", and the jail is unreachable rather than
  // insecure, which is the confusing way round. The second is the one to keep: a jail must not
  // resolve its own interpreter through a search path, or the flags below are enforced by
  // whichever binary that path happens to find.
  return new Deno.Command(Deno.execPath(), {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    args: jailArgs(opts, memoryMb, entry),

    // Nothing else is granted: net, env, run, ffi and sys are all denied, and so is write unless
    // the caller named a workspace directory above.
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // Deno itself needs a home for its module cache; nothing else is inherited, and the child
    // cannot read even this without --allow-env.
    clearEnv: true,
    env: { HOME: Deno.env.get("HOME") ?? "/tmp", PATH: "/usr/bin:/bin" },
  }).spawn();
}

export async function runCode(source: string, opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes, memoryMb } = { ...DEFAULTS, ...opts };
  const started = Date.now();
  // `-`: the program comes from stdin, so no file needs to be readable.
  return await drive(spawnDeno("-", opts, memoryMb), source, timeoutMs, maxOutputBytes, started);
}

/**
 * Run a FILE, rather than a program on stdin.
 *
 * The difference is not stylistic. A file has an extension, so `.ts` is TypeScript and no
 * `--ext=js` has to be guessed for it: the stdin path must state one dialect for every program,
 * which is why a type annotation in a stdin program is a syntax error while the modules it imports
 * may be TypeScript. A file also leaves stdin free, which is what a brokered channel needs.
 *
 * `cwd` decides what the entry's relative imports resolve against; pass the tree root.
 */
export async function runEntry(entry: string, opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes, memoryMb } = { ...DEFAULTS, ...opts };
  const started = Date.now();
  return await drive(spawnDeno(entry, opts, memoryMb), null, timeoutMs, maxOutputBytes, started);
}

/** Spawn a jailer, feed it a program on stdin, capture capped output. Shared by every backend so
 *  the timeout, the kill and the output cap cannot drift between them. */
async function spawnCaptured(
  bin: string,
  args: string[],
  source: string | null,
  timeoutMs: number,
  maxOutputBytes: number,
  cwd?: string,
): Promise<RunResult> {
  const started = Date.now();
  const child = new Deno.Command(bin, {
    args,
    ...(cwd ? { cwd } : {}),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
  }).spawn();
  return await drive(child, source, timeoutMs, maxOutputBytes, started);
}

/** The half every backend shares: write the program, kill on timeout, read both streams capped. */
async function drive(
  child: Deno.ChildProcess,
  /** The program, or null when the jail runs a FILE: stdin is then closed rather than left open,
   *  since a program that reads it would otherwise wait for input nobody is going to send. */
  source: string | null,
  timeoutMs: number,
  maxOutputBytes: number,
  started: number,
): Promise<RunResult> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);

  try {
    const w = child.stdin.getWriter();
    if (source !== null) await w.write(new TextEncoder().encode(source));
    await w.close();
  } catch { /* child exited before reading its program */ }

  const [out, err] = await Promise.all([
    readCapped(child.stdout, maxOutputBytes),
    readCapped(child.stderr, maxOutputBytes),
  ]);
  const status = await child.status;
  clearTimeout(timer);

  return {
    ok: status.success && !timedOut,
    stdout: out.text,
    stderr: err.text,
    exitCode: status.code,
    timedOut,
    truncated: out.truncated || err.truncated,
    ms: Date.now() - started,
  };
}

// ── What this jail CLAIMS, and proving it ────────────────────────────────────────────────────────

/**
 * A description of an execution environment: what a policy can bar, stated as data.
 *
 * The point is that these are the fields a GRANT can scope on and a `check` can reference, not
 * prose in a tool description. A record that says `network: false` is matchable; a sentence saying
 * so is only readable, and only by a model.
 *
 * The vocabulary stays small and boolean where a Deno jail is boolean. OCI's names are the right
 * borrow once a container backend lands (namespaces, mounts, rlimits, readonlyPaths, seccomp), but
 * forcing them onto a permission model that has no namespaces would be a translation nobody asked
 * for. See agent_docs/design-execution.md.
 */
export interface SandboxSpec {
  name: string;
  language: string;
  /** How the jail is built. The one thing a reader must not have to infer. */
  /** How the jail is built, and the field a reader must not have to infer. The two differ in a way
   *  that matters more than the name: `deno-permissions` is safe by ABSENCE (forget every flag and
   *  you get the safe answer), while `bubblewrap` is safe by PRESENCE (forget `--unshare-net` and
   *  the jail is silently open). That flip is why every backend is probed before it is served. */
  isolation: "deno-permissions" | "bubblewrap";
  network: boolean;
  /** Absolute paths the program may read; empty means no filesystem at all. See `importsConfined`
   *  before believing that: on the Deno backend it bounds file APIS and not module loading. */
  readonlyPaths: string[];
  /**
   * Whether `readonlyPaths` also bounds MODULE LOADING, not only the file APIs.
   *
   * FALSE for `deno-permissions`, measured rather than assumed: inside that jail
   * `import("file:///anywhere.json", { with: { type: "json" } })` returns the file, past the
   * `--allow-read` roots AND past `--deny-read`, while `Deno.readTextFileSync` on the same path is
   * refused. Any `.ts`/`.js` module can likewise be imported, which reads its exports and RUNS its
   * top-level code. Non-module text does not leak (the parse fails without echoing the file), but
   * every JSON secret the process user can read does.
   *
   * There is no Deno flag for it: `--allow-import` gates remote hosts only. A mount namespace is
   * the only thing that closes it, so `bubblewrap` has this true and the permission jail does not.
   * Absent means UNCONFINED, because a security property that was never stated must not read as a
   * guarantee.
   */
  importsConfined?: boolean;
  /** Absolute paths it may write; empty means it cannot write. */
  writablePaths: string[];
  processes: boolean;
  env: boolean;
  memoryMb: number;
  timeoutMsMax: number;
  runtime: string;
}

/**
 * A bubblewrap jail: namespaces instead of permission flags, so it can run ANY interpreter.
 *
 * Measured before choosing it, and the numbers are not the ones a latency table suggests. bwrap
 * starts in ~13 ms against the Deno runner's ~35 ms, so it is the fast path. It is also far weaker
 * on filesystem, and inherently so rather than by misconfiguration: making `python3` reachable means
 * binding the host's `/usr`, and the jail then sees ~4 200 binaries where the Deno jail sees
 * nothing. That is a real trade, not a bug, which is exactly why the spec must state the roots it
 * actually got rather than the ones intended.
 */
export interface BwrapOptions extends RunOptions {
  /** The interpreter, and the paths that have to be visible for it to exist. */
  command: string[];
  bind?: string[];
  /** Namespace flags. Overridable ONLY so a test can build a deliberately weakened jail and prove
   *  the probe catches it; production callers take the default, which unshares everything. A jail
   *  whose isolation is a flag somebody can omit is the entire reason the probe exists. */
  unshare?: string[];
}

const BWRAP_BASE = [
  "--unshare-all", // net, pid, ipc, uts, cgroup: the flag whose absence opens the jail silently
  "--die-with-parent",
  "--new-session", // no controlling terminal, so the child cannot push input back into ours
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
];

/** Run under bubblewrap. Same contract as `runCode`: source on stdin, output captured and capped. */
/**
 * The bubblewrap jail's arguments, in ONE place, for the same reason `jailArgs` exists: `runBwrap`
 * feeds a program through stdin, the BROKER cannot (stdin is its response channel) and runs one
 * from a file instead. A second copy of these binds would be a second security boundary, and this
 * backend is the one that is safe by PRESENCE: forget `--unshare-net` and the jail is silently
 * open, which is exactly what a drifted copy would do.
 */
export function bwrapArgs(opts: BwrapOptions): string[] {
  const binds = (opts.bind ?? ["/usr", "/lib", "/lib64", "/bin", "/etc/alternatives"])
    .flatMap((b) => ["--ro-bind-try", b, b]);
  const roots = (opts.readRoots ?? []).flatMap((r) => ["--ro-bind-try", r, r]);
  const writable = (opts.writeRoots ?? []).flatMap((r) => ["--bind-try", r, r]);
  const base = opts.unshare ? [...opts.unshare, ...BWRAP_BASE.slice(1)] : BWRAP_BASE;
  const args = [...base, ...binds, ...roots, ...writable];
  if (opts.cwd) args.push("--chdir", opts.cwd);
  args.push("--", ...opts.command);
  return args;
}

export async function runBwrap(source: string | null, opts: BwrapOptions): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes } = { ...DEFAULTS, ...opts };
  return await spawnCaptured("bwrap", bwrapArgs(opts), source, timeoutMs, maxOutputBytes, opts.cwd);
}

/** The jail `runBwrap` builds, described honestly: the binds a program needs to exist ARE its
 *  readable filesystem, and a spec that omitted them would be the prose problem with extra steps. */
export function bwrapSandbox(
  opts: BwrapOptions & { name?: string; language?: string },
): SandboxSpec {
  const { timeoutMs, memoryMb } = { ...DEFAULTS, ...opts };
  return {
    name: opts.name ?? "bwrap",
    // A mount namespace bounds every read, module loading included: an unbound path does not exist
    // to open. Measured against the same canary the probe uses.
    importsConfined: true,
    language: opts.language ?? "unknown",
    isolation: "bubblewrap",
    network: false,
    readonlyPaths: [...(opts.bind ?? ["/usr", "/lib", "/lib64", "/bin"]), ...(opts.readRoots ?? [])],
    // The EPHEMERAL root and /tmp are writable, and saying otherwise was a lie the probe caught on
    // its first run. bwrap's root is a tmpfs: a program can create files there, they reach nothing
    // outside the jail, and they vanish with the process. That is meaningfully different from the
    // Deno jail, which cannot write at all, and the difference belongs in the record rather than in
    // somebody's memory.
    writablePaths: ["/", "/tmp", ...(opts.writeRoots ?? [])],
    processes: true, // a namespace jail does not stop fork/exec the way a permission model does
    env: true,
    memoryMb,
    timeoutMsMax: timeoutMs,
    runtime: opts.command.join(" "),
  };
}

/** The jail `runCode` actually builds, for a given configuration. */
export function denoSandbox(opts: RunOptions & { name?: string } = {}): SandboxSpec {
  const { timeoutMs, memoryMb } = { ...DEFAULTS, ...opts };
  return {
    name: opts.name ?? "deno",
    // MEASURED, not assumed: `import(…, {with:{type:"json"}})` reaches any JSON the process user
    // can read, past the roots and past `--deny-read`. Saying so is the point of the field.
    importsConfined: false,
    language: "javascript",
    isolation: "deno-permissions",
    network: false,
    readonlyPaths: opts.readRoots ?? [],
    writablePaths: opts.writeRoots ?? [],
    processes: false,
    env: false,
    memoryMb,
    timeoutMsMax: timeoutMs,
    runtime: `deno ${Deno.version.deno}`,
  };
}

/** One thing a probe tried, and whether the jail held. */
export interface ProbeResult {
  claim: string;
  held: boolean;
  detail?: string;
}

/**
 * Try to break out of the jail, and report per claim.
 *
 * A description nobody tested is a more convincing version of an unenforced sentence, which is the
 * failure this whole record shape exists to avoid: structured data LOOKS authoritative. So a runner
 * proves each claim before advertising it, at boot, once.
 *
 * The escape attempts are deliberately the ones a real program would make, and each is inverted:
 * the probe passes when the operation FAILS. A probe that cannot break out is the evidence; a probe
 * that succeeds means the record is lying and nothing should serve it.
 */
export async function probeSandbox(
  spec: SandboxSpec,
  opts: RunOptions & { bwrap?: BwrapOptions; networkTarget?: string } = {},
): Promise<ProbeResult[]> {
  // The escape attempts, once per backend, because a probe written in the wrong language proves
  // nothing. Each is a real operation, and each PASSES only when it fails inside the jail.
  const host = (opts.networkTarget ?? "").split(":")[0];
  const port = (opts.networkTarget ?? "").split(":")[1];
  const js = {
    network: `await fetch("http://${opts.networkTarget}/")`,
    processes: `new Deno.Command("echo").outputSync()`,
    env: `Deno.env.get("HOME")`,
    filesystem: `Deno.readTextFileSync("/etc/hostname")`,
    writable: `Deno.writeTextFileSync("/tmp/radia-probe-should-not-exist", "escaped")`,
    // The one a permission flag cannot answer. Filled in per run: the canary is written outside
    // every root, so reaching it proves module loading is not bounded by them.
    imports: `await import("file://__CANARY__", { with: { type: "json" } })`,
  };
  const py = {
    network: `import socket; socket.create_connection(("${host}",${port}),timeout=2)`,
    processes: `import subprocess; subprocess.run(["echo"],check=True)`,
    env: `import os; assert os.environ["HOME"]`,
    filesystem: `open("/etc/hostname").read()`,
    writable: `open("/radia-probe-should-not-exist","w").write("escaped")`,
    // Python reaches a module through an ordinary file read, so an unbound path that ALREADY exists
    // is the evidence and nothing has to be created. That matters: a worker often holds exactly one
    // writable directory, and a prober that needs a temp file cannot run there.
    imports: `open("/etc/hostname").read()`,
  };
  const bwrap = spec.isolation === "bubblewrap";
  const src = bwrap ? py : js;
  const wrap = (body: string) =>
    bwrap
      ? `try:\n    ${body}\n    print("ESCAPED")\nexcept Exception:\n    print("held")\n`
      : `try { ${body}; console.log("ESCAPED") } catch { console.log("held") }`;

  const attempts: { claim: keyof typeof js; onlyIf: boolean }[] = [
    { claim: "network", onlyIf: !spec.network },
    { claim: "processes", onlyIf: !spec.processes },
    { claim: "env", onlyIf: !spec.env },
    // A jail with roots can read SOMETHING by design, so the claim under test is narrower: it must
    // not reach a path nobody granted. `/etc/hostname` is outside every root these backends bind.
    { claim: "filesystem", onlyIf: !spec.readonlyPaths.some((p) => p === "/etc" || p === "/") },
    // Only meaningful when the spec claims NO write. A jail with an ephemeral writable root claims
    // one, so there is nothing to disprove; the claim is then carried by the record for a policy to
    // read, not by a probe.
    { claim: "writable", onlyIf: spec.writablePaths.length === 0 },
    // Only when the spec CLAIMS imports are bounded. The permission jail says they are not, and a
    // stated weakness needs no disproof; what must never pass unchallenged is a record claiming a
    // confinement the backend cannot deliver.
    { claim: "imports", onlyIf: spec.importsConfined === true },
  ];

  // The JS probe needs a real JSON file outside every root: importing a path that does NOT exist
  // fails for the wrong reason and would report "held" from a jail that is wide open. Nothing
  // portable guarantees one, so it is created. Only for the JS backend, and only when confinement
  // is claimed: the bwrap probe uses `/etc/hostname`, which exists already, because a worker
  // confined to a single writable directory cannot make a temp file at all.
  let canary: string | undefined;
  let canaryDir: string | undefined;
  let canaryProblem: string | undefined;
  if (!bwrap && attempts.some((a) => a.claim === "imports" && a.onlyIf)) {
    try {
      canaryDir = await Deno.makeTempDir({ prefix: "radia-canary-" });
      canary = `${canaryDir}/canary.json`;
      await Deno.writeTextFile(canary, JSON.stringify({ reached: true }));
    } catch (e) {
      // Unverified is a FAILED claim, never a pass: the same rule the network probe follows.
      canaryProblem = `the probe could not write its canary (${(e as Error).message}), so ` +
        `'imports are confined' could not be tested; give this process a writable directory`;
    }
  }

  const out: ProbeResult[] = [];
  try {
  for (const a of attempts) {
    if (!a.onlyIf) continue; // nothing claimed, nothing to disprove

    // THE NETWORK CLAIM NEEDS A TARGET THAT IS KNOWN TO BE LISTENING, and the caller supplies it.
    //
    // This used to connect to `1.1.1.1:53`, which made the verdict depend on the public internet:
    // on a machine that was offline, slow or behind an egress filter the connect failed, the probe
    // reported "held", and a jail with NO network isolation passed its own verification. Opening a
    // listener here was the obvious repair and is the wrong one — a worker is granted `--allow-net`
    // for the space's address and nothing else, so a prober that listens cannot run inside the very
    // process that needs to probe.
    //
    // So: no target, no verdict. Unverified is a FAILED claim, never a pass. The space's own address
    // is the natural argument — every worker can already reach it, and it is always listening.
    if (a.claim === "network" && !opts.networkTarget) {
      out.push({
        claim: "network",
        held: false,
        detail: "no networkTarget was supplied, so 'no network' could not be tested; pass a " +
          "host:port this process can already reach (the space's own address will do)",
      });
      continue;
    }

    if (a.claim === "imports" && canaryProblem) {
      out.push({ claim: "imports", held: false, detail: canaryProblem });
      continue;
    }
    const program = wrap(src[a.claim].replace("__CANARY__", canary ?? "/nonexistent"));
    const r = bwrap
      ? await runBwrap(program, {
        command: ["python3", "-"],
        ...(opts.bwrap ?? {}),
        timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      })
      : await runCode(program, { ...opts, timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS });

    // THREE outcomes, and reading them as two was a fail-open bug. A denied operation is caught and
    // reports "held"; an escape reports "ESCAPED"; and a probe that never finished — a cold
    // interpreter past its timeout, a crash, an interpreter that is not there — reports NEITHER, and
    // `!stdout.includes("ESCAPED")` counted that as the jail holding. So an unverifiable jail passed
    // its own verification, which is the single direction this mechanism exists to prevent. It
    // surfaced as an intermittent conformance failure rather than as an alarm, which is how a
    // fail-open default usually announces itself.
    const escaped = r.stdout.includes("ESCAPED");
    const held = r.stdout.includes("held");
    if (!escaped && !held) {
      out.push({
        claim: a.claim,
        held: false,
        detail: `the probe did not complete (${r.timedOut ? "timed out" : `exit ${r.exitCode}`}), so the ` +
          `claim is unverified rather than proven${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""}`,
      });
      continue;
    }
    out.push({ claim: a.claim, held: !escaped, ...(escaped ? { detail: "the operation succeeded inside the jail" } : {}) });
  }
  return out;
  } finally {
    if (canaryDir) await Deno.remove(canaryDir, { recursive: true }).catch(() => {});
  }
}
