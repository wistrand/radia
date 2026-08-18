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
  /**
   * Wrap the jail in a filesystem CONFINER.
   *
   * The permission model still runs the code and still denies net, env, run, ffi and write. This
   * bounds only what the process can SEE, which is the one channel permissions do not cover:
   * module loading ignores `--allow-read` and `--deny-read` entirely
   * (plan-jail-confinement.md). A mount namespace closes it by making the file absent rather than
   * forbidden.
   *
   * Filesystem ONLY, deliberately: net is left to Deno's flags, so the confiner never passes
   * `--unshare-net`. That is the flag which fails on hosted CI, and leaving it out keeps "no
   * network" safe-by-absence instead of moving it to safe-by-presence.
   */
  confine?: "bubblewrap" | "sandbox-exec";
  /**
   * Where a CONFINED jail keeps Deno's own caches.
   *
   * Not an optimisation. Deno writes its global caches whatever `--no-remote` says, and a
   * read-bounding confiner leaves them WRITABLE BUT UNREADABLE, which corrupts the SQLite databases
   * for the whole machine: `SQLITE_IOERR` 522 on every later `deno`, and Deno's recovery deletes
   * the main db without the `-wal`/`-shm` siblings, so it never heals. Recovery is deleting the
   * full triples by hand. This happened on a real Mac while verifying the profile.
   *
   * So a confined jail always gets a cache directory it can BOTH read and write, private to the
   * caller and never the host's. Absent, one is made per process; if even that is impossible the
   * cache is disabled, which is safe and noisy rather than silent and destructive.
   */
  cacheDir?: string;
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
    // A JAIL MUST NOT READ CONFIGURATION WRITTEN BY ITS PRISONER. The child's cwd is the
    // materialised tree, which is model-written, and Deno discovers `deno.json` from cwd: measured,
    // a workspace shipping one had its import map honoured inside the jail. Neither file has a
    // legitimate use here (there is no network to fetch from and no npm), so both discoveries are
    // off. The visible cost is that an import map inside a workspace stops working, loudly.
    "--no-config",
    "--no-lock",
    // `npm:` was already unreachable, but ACCIDENTALLY: it failed on an env permission
    // (`TF_BUILD`) before it ever tried to resolve, which is a block that disappears the day Deno
    // stops reading that variable. The runner's own tool description has always promised "no npm";
    // this is that promise enforced rather than observed. `jsr:` is already covered by --no-remote.
    "--no-npm",
    "--quiet",
    ...(entry === "-" ? ["--ext=js"] : []), // stdin has no filename, so the dialect must be stated
    `--v8-flags=--max-old-space-size=${memoryMb}`,
    ...(readRoots.length ? [`--allow-read=${readRoots.join(",")}`] : []),
    ...(opts.writeRoots?.length ? [`--allow-write=${opts.writeRoots.join(",")}`] : []),
    ...(denyRead.length ? [`--deny-read=${denyRead.join(",")}`] : []),
    entry,
  ];
}

/**
 * The macOS filesystem confiner: a Seatbelt profile that denies reads and allows back what Deno
 * itself needs plus the roots the caller granted.
 *
 * VERIFIED on macOS 26.4.1 with Deno 2.9.5 (arm64): the module-loading hole reproduces there, this
 * closes it, and workspace-relative imports keep working. ~6ms (bare jail 10.3ms median, confined
 * 16.0ms). See plan-jail-confinement.md phase 4 for the session that produced it.
 *
 * Four things that are not obvious and were each hit while verifying:
 *
 *   - `(import "dyld-support.sb")` IS THE LOAD-BEARING LINE. A naive deny-reads profile SIGABRTs
 *     every binary, because dyld's bootstrap (libignition) needs `file-read*` on the literal `/`
 *     and `file-map-executable` on the cryptex graft points. Apple revs that file with the OS, so
 *     importing it by name puts the version-sensitive part on their side. It is labelled Apple
 *     System Private Interface; the alternative, hardcoding cryptex paths, already broke once
 *     during the verification.
 *   - PATHS MUST BE RESOLVED. The sandbox matches on vnodes and `/tmp` is a symlink to
 *     `/private/tmp`, so an un-realpath'd workspace path silently matches nothing and the jail
 *     denies the tree it was supposed to allow.
 *   - `(allow file-read-metadata)` globally is what makes the rest work, and it LEAKS EXISTENCE
 *     everywhere. That is why `confiner` is an enum rather than a boolean: this hides contents, a
 *     mount namespace hides the file. A policy that needs the stronger one binds `bubblewrap`.
 *   - `DENO_DIR` is not needed under `--no-remote`; only the binary's own directory is.
 *
 * Debugging note for whoever changes this: SBPL `(trace …)` is dead on modern macOS. Iterate
 * through the crash reports in `~/Library/Logs/DiagnosticReports`.
 */
export function sandboxExecProfile(opts: { readRoots?: string[]; denoDir: string; cwd?: string; cacheDir?: string }): string {
  // A path is interpolated into a quoted SBPL string, so anything that could close that string is
  // refused rather than escaped: no legitimate jail root contains one, and a profile that parses
  // differently than it reads is the worst possible failure here.
  const clean = (p: string) => {
    if (/["\\\n]/.test(p)) throw new Error(`path cannot go in a sandbox profile: ${JSON.stringify(p)}`);
    return p;
  };
  // Resolved, per the trap above. A path that cannot be resolved is kept as given: it is either
  // absent (so it grants nothing) or unreadable by this process, and failing the whole jail over
  // it would be worse than a root that matches nothing.
  const resolve = (p: string) => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  // The cache directory is READ-ALLOWED as well as written (writes ride `(allow default)`). Allowing
  // only writes is what corrupts it, so the two must not be split.
  const roots = [...new Set(
    [opts.denoDir, ...(opts.readRoots ?? []), ...(opts.cwd ? [opts.cwd] : []), ...(opts.cacheDir ? [opts.cacheDir] : [])].map(resolve),
  )];
  return [
    "(version 1)",
    // Net, env, run and write are denied by Deno's own flags, so this profile only has to bound
    // reads. Confining one axis is the whole design: see `RunOptions.confine`.
    "(allow default)",
    "(deny file-read*)",
    '(import "dyld-support.sb")',
    "(allow file-read-metadata)",
    "(allow file-read*",
    ...['/usr/lib', '/usr/share', '/System', '/dev', ...roots].map((p) => `  (subpath "${clean(p)}")`),
    ")",
  ].join("\n");
}

/**
 * A cache directory a CONFINED jail may both read and write, or undefined if none can be made.
 *
 * Per process, not per run: the cache is the point, and remaking it every call would throw away
 * the compile it exists to keep. Never the host's, because a confined jail corrupts a cache it can
 * write and cannot read (see `RunOptions.cacheDir`).
 *
 * Returning undefined is a real outcome, not a failure to handle later: a worker holding write
 * access to exactly one directory cannot make a temp dir anywhere else, and the caller then runs
 * with the cache disabled rather than with a corrupting one.
 */
let processCacheDir: string | null | undefined;
function jailCacheDir(given?: string): string | undefined {
  if (given) return given;
  if (processCacheDir === undefined) {
    try {
      processCacheDir = Deno.makeTempDirSync({ prefix: "radia-jail-cache-" });
    } catch {
      processCacheDir = null; // no writable temp: run without a cache rather than against the host's
    }
  }
  return processCacheDir ?? undefined;
}

function spawnDeno(entry: string, opts: RunOptions, memoryMb: number): Deno.ChildProcess {
  // The RUNNING runtime, by absolute path, not the name `deno` resolved against the PATH this
  // command itself invents (`/usr/bin:/bin` below). Two reasons, and CI found the first: on a
  // machine where Deno is installed anywhere else — a GitHub runner puts it in the tool cache —
  // the lookup simply fails with "entity not found", and the jail is unreachable rather than
  // insecure, which is the confusing way round. The second is the one to keep: a jail must not
  // resolve its own interpreter through a search path, or the flags below are enforced by
  // whichever binary that path happens to find.
  const args = jailArgs(opts, memoryMb, entry);
  const denoDir = Deno.execPath().slice(0, Deno.execPath().lastIndexOf("/")) || "/usr/bin";
  const cacheDir = opts.confine ? jailCacheDir(opts.cacheDir) : undefined;
  if (opts.confine === "sandbox-exec") {
    // The jail, unchanged, under a Seatbelt profile. `-p` takes the profile as one argument, so
    // nothing goes through a shell.
    //
    // A cwd is NOT optional here the way it is for the other backends: the child inherits this
    // process's cwd otherwise, that directory is outside the profile's read roots, and Deno then
    // dies at startup on getcwd ("could not read current working directory") before any code runs.
    // That is exactly how the probe failed on the first real Mac boot: every claim reported
    // unverified and the worker silently fell back to the unconfined jail. The Deno binary's own
    // directory is the one path the profile always grants.
    return new Deno.Command("/usr/bin/sandbox-exec", {
      cwd: opts.cwd ?? denoDir,
      args: [
        "-p",
        sandboxExecProfile({ readRoots: opts.readRoots, denoDir, cwd: opts.cwd, cacheDir }),
        Deno.execPath(),
        ...args,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      // DENO_DIR explicitly, never a HOME-derived path: `$HOME/Library/Caches/deno` would be
      // outside the read allowlist and writes ride `(allow default)`, which is exactly the
      // asymmetry that corrupts. With no cache dir the variable points nowhere usable and Deno
      // falls back to memory, which is slower and safe.
      env: { HOME: "/tmp", PATH: "/usr/bin:/bin", ...(cacheDir ? { DENO_DIR: cacheDir } : {}) },
    }).spawn();
  }
  if (opts.confine === "bubblewrap") {
    // The jail, unchanged, inside a mount namespace. Deno's own directory has to be bound or the
    // interpreter is not there to start; everything else the program may read is already in
    // `readRoots`, and anything not bound simply does not exist.
    return new Deno.Command("bwrap", {
      args: bwrapArgs({
        command: [Deno.execPath(), ...args],
        readRoots: [...(opts.readRoots ?? []), denoDir],
        ...(opts.writeRoots?.length ? { writeRoots: opts.writeRoots } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        // Everything except net, which Deno already denies. Unsharing net is what breaks on hosted
        // CI, and it would buy nothing here.
        unshare: ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup"],
      }),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      // Inside the namespace `/tmp` is a fresh tmpfs, so this cache is private to the run and
      // vanishes with it. Named explicitly rather than left to HOME so the guarantee is visible.
      env: { HOME: "/tmp", PATH: "/usr/bin:/bin", DENO_DIR: "/tmp/deno-cache" },
    }).spawn();
  }
  return new Deno.Command(Deno.execPath(), {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    args,

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
  isolation: "deno-permissions" | "bubblewrap" | "sandbox-exec" | "web-worker";
  network: boolean;
  /**
   * BROWSER ORIGIN STORAGE (IndexedDB, Cache, OPFS), which is a different axis from the
   * filesystem and exists because a browser jail has no filesystem and a very reachable database.
   *
   * `false` means an opaque origin refuses it, PROVED by the probe rather than configured: a
   * blob-URL worker inherits its creator's origin, so a page-created one can open the space's own
   * IndexedDB. Absent means the axis does not apply (no browser) or was never established, and
   * never that it is closed — the same reading `importsConfined` takes.
   */
  storage?: boolean;
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
  /**
   * What bounds the filesystem, which is a DIFFERENT question from `isolation`.
   *
   * `isolation` says which permission model runs the code; this says what stops it seeing files,
   * and the two are independent: a Deno jail confined by a mount namespace is `deno-permissions`
   * plus `bubblewrap`. Keeping them apart is what lets the permission model stay safe-by-absence
   * while the filesystem gets a boundary it cannot express.
   *
   * The confiners are not equivalent, and a policy that cares should bind THIS rather than
   * `importsConfined`: a mount namespace hides a file entirely, while a macOS SBPL profile hides
   * its contents and still leaks existence through metadata.
   */
  confiner?: "none" | "bubblewrap" | "sandbox-exec";
  /** Absolute paths it may write; empty means it cannot write. */
  writablePaths: string[];
  processes: boolean;
  env: boolean;
  /** The heap cap, in MB. `0` means UNBOUNDED and is stated rather than omitted: no browser
   *  exposes a per-worker limit, so the web backend cannot bound this axis and says so. */
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
    confiner: "bubblewrap",
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
  const confined = opts.confine === "bubblewrap" || opts.confine === "sandbox-exec";
  return {
    name: opts.name ?? (confined ? "deno-confined" : "deno"),
    // MEASURED, not assumed: unconfined, `import(…, {with:{type:"json"}})` reaches any JSON the
    // process user can read, past the roots and past `--deny-read`. A mount namespace closes it,
    // which is the whole reason `confine` exists.
    importsConfined: confined,
    confiner: opts.confine ?? "none",
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
/**
 * The confiner worth TRYING on this host, or none.
 *
 * A guess by platform, not a verdict: whether it works is what the probe answers, and a caller
 * that gets this wrong falls back rather than failing. Linux gets bubblewrap (which may not be
 * installed or permitted), macOS gets Seatbelt (built in since forever). Windows has no equivalent
 * worth the dependency, so the honest answer there is an unconfined jail that says so, and WSL2 is
 * the supported path: it reports `linux`, so it takes the bubblewrap branch with nothing added.
 */
export function defaultConfiner(): "bubblewrap" | "sandbox-exec" | undefined {
  if (Deno.build.os === "darwin") return "sandbox-exec";
  if (Deno.build.os === "linux") return "bubblewrap";
  return undefined;
}

/** Where a macOS Python usually lives. Read AND exec are granted here, because the framework
 *  interpreter re-execs itself; anything outside stays unreachable. */
const MACOS_PYTHON_ROOTS = ["/Library/Developer/CommandLineTools", "/opt/homebrew", "/usr/local"];

/**
 * A Seatbelt profile for PYTHON, which is a different shape from the one for Deno and has to be.
 *
 * The Deno profile opens `(allow default)` and denies reads, which is safe ONLY because Deno's own
 * flags already deny net, env, run, ffi and write. Python has no permission model, so the same shape
 * would leave everything nobody thought to name (mach lookups, sysctl, IPC, ptrace) allowed. This
 * one opens `(deny default)` and grants upward, which also means NETWORK IS DENIED FOR FREE: there
 * is no `(deny network*)` line because nothing allows it.
 *
 * The operation list is the part worth stealing rather than rediscovering, and it was: mindsdb's
 * vsbox enumerates what CPython needs to boot under deny-default (process-fork, signal, sysctl-read,
 * mach-lookup/register, the POSIX shm quartet). Their threat model is a venv's filesystem rather
 * than untrusted code, so their `(allow network-outbound)` is exactly what is NOT copied.
 *
 * MEASURED on macOS 26.4.1 with CommandLineTools python 3.9.6: it starts, imports the stdlib, reads
 * its tree and runs an entrypoint, while a path outside the tree, the network, `subprocess` and
 * writes outside are all refused. Four things that are not obvious:
 *
 *   - `(import "dyld-support.sb")` is load-bearing. Without it, scoping the reads at all kills the
 *     process before Python starts, and SILENTLY: under `(deny default)` even the error path is
 *     denied, so a broken profile produces no output and no exit code worth reading.
 *   - The interpreter must be RESOLVED. `/usr/bin/python3` is the xcrun shim, which needs
 *     `$TMPDIR/xcrun_db` and dies first; and the resolved path is inside a framework that RE-EXECS
 *     itself through `Resources/Python.app`, which is why exec is allowed for the python roots
 *     rather than for one literal binary.
 *   - `cwd` must be inside a readable root. `sys.path[0]` is `''`, meaning the cwd, and Python stats
 *     it on every import: a cwd outside the allowlist fails every import with a bare
 *     `PermissionError` naming nothing.
 *   - `file-map-executable` is NOT needed, though the first attempt carried it. Loading C extensions
 *     works without it once the cwd is right; it was covering for that bug.
 */
export function seatbeltPythonProfile(
  opts: { readRoots?: string[]; writeRoots?: string[]; cwd?: string; pythonRoots?: string[] },
): string {
  const quote = (p: string) => {
    if (/["\\\n]/.test(p)) throw new Error(`path cannot go in a sandbox profile: ${JSON.stringify(p)}`);
    return p;
  };
  const resolve = (p: string) => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  const pythonRoots = (opts.pythonRoots ?? MACOS_PYTHON_ROOTS).map(resolve);
  const reads = [...new Set([
    "/usr/lib",
    "/usr/share",
    "/System",
    "/dev",
    ...pythonRoots,
    ...(opts.readRoots ?? []).map(resolve),
    ...(opts.cwd ? [resolve(opts.cwd)] : []),
  ])];
  const writes = [...new Set((opts.writeRoots ?? []).map(resolve))];
  return [
    "(version 1)",
    // Everything not named below is refused, network included.
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process-fork)",
    "(allow process-info*)",
    // Scoped to the python installs: the framework re-execs itself, and nothing else may be started.
    `(allow process-exec ${pythonRoots.map((p) => `(subpath "${quote(p)}")`).join(" ")})`,
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow ipc-posix-shm-read-data)",
    "(allow ipc-posix-shm-write-data)",
    "(allow ipc-posix-shm-read-metadata)",
    "(allow ipc-posix-shm-write-create)",
    // Metadata everywhere, for the path resolution every import performs. It leaks EXISTENCE, which
    // is the same limitation the Deno profile carries and the reason `confiner` is an enum.
    "(allow file-read-metadata)",
    `(allow file-read* ${reads.map((p) => `(subpath "${quote(p)}")`).join(" ")})`,
    ...(writes.length ? [`(allow file-write* ${writes.map((p) => `(subpath "${quote(p)}")`).join(" ")})`] : []),
  ].join("\n");
}

/** Run a program under `sandbox-exec`. `source` is fed on stdin when the command reads it. */
export async function runSeatbelt(
  source: string | null,
  opts: RunOptions & { command: string[]; pythonRoots?: string[] },
): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes } = { ...DEFAULTS, ...opts };
  const profile = seatbeltPythonProfile(opts);
  return await spawnCaptured("/usr/bin/sandbox-exec", ["-p", profile, ...opts.command], source, timeoutMs, maxOutputBytes, opts.cwd);
}

/** The interpreter a Seatbelt jail must actually run: `/usr/bin/python3` is the xcrun shim, which
 *  needs a temp file the profile denies. Resolved once, because it is a filesystem walk. */
let resolvedPython: string | null | undefined;
export function macosPython(): string | undefined {
  if (resolvedPython === undefined) {
    try {
      const out = new Deno.Command("/usr/bin/python3", {
        args: ["-c", "import sys,os;print(os.path.realpath(sys.executable))"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      resolvedPython = out.success ? new TextDecoder().decode(out.stdout).trim() : null;
    } catch {
      resolvedPython = null;
    }
  }
  return resolvedPython ?? undefined;
}

/** A Python jail on macOS: Seatbelt IS the isolation here, because Python brings no permission
 *  model of its own for it to sit under. */
export function seatbeltPythonSandbox(
  opts: RunOptions & { name?: string; interpreter?: string } = {},
): SandboxSpec {
  const { timeoutMs, memoryMb } = { ...DEFAULTS, ...opts };
  return {
    name: opts.name ?? "python-seatbelt",
    language: "python",
    isolation: "sandbox-exec",
    importsConfined: true,
    confiner: "sandbox-exec",
    network: false,
    readonlyPaths: [...MACOS_PYTHON_ROOTS, "/usr/lib", "/usr/share", "/System", ...(opts.readRoots ?? [])],
    writablePaths: opts.writeRoots ?? [],
    processes: false,
    env: false,
    memoryMb,
    timeoutMsMax: timeoutMs,
    runtime: opts.interpreter ?? macosPython() ?? "python3",
  };
}

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
  opts: RunOptions & {
    bwrap?: BwrapOptions;
    networkTarget?: string;
    /** Where the import probe may write its canary. The system temp directory by default, which a
     *  caller confined to one writable directory does not have: a worker holding
     *  `--allow-write=<workspace root>` cannot create one anywhere else, and the claim then reports
     *  UNVERIFIED rather than passing. Must be OUTSIDE the jail's read roots, or a confined jail
     *  would be able to read it and fail its own probe. */
    scratchDir?: string;
  } = {},
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
  // THE LANGUAGE OF THE PROBE FOLLOWS THE SPEC'S LANGUAGE, and the SPAWN follows its backend. These
  // used to be one decision (`isolation === "bubblewrap"` meant Python), which was the
  // backend/language conflation design-execution.md warns about and which held only while every
  // bubblewrap jail happened to run Python. A Deno jail confined by a mount namespace is the first
  // spec where they differ: probing it in Python would run no probe at all and report a jail as
  // verified.
  const bwrap = spec.isolation === "bubblewrap";
  // The language, with the BACKEND's default when the spec does not name one: a bubblewrap jail
  // runs `spec.runtime` (python3 unless told otherwise), so a spec left at `language: "unknown"`
  // still gets Python probes and keeps working. What changed is that an explicit language WINS, so
  // a JavaScript jail is probed in JavaScript wherever it runs. Probing it in the other language is
  // not a wrong answer, it is NO answer: the program is a syntax error, the probe never completes,
  // and the claim reports unverified.
  const seatbeltPython = spec.isolation === "sandbox-exec" && spec.language === "python";
  const python = spec.language === "python" || (bwrap && spec.language !== "javascript");
  const src = python ? py : js;
  const wrap = (body: string) =>
    python
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
  if (!python && attempts.some((a) => a.claim === "imports" && a.onlyIf)) {
    try {
      canaryDir = await Deno.makeTempDir({ dir: opts.scratchDir || undefined, prefix: "radia-canary-" });
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
    const r = seatbeltPython
      // The third backend: Seatbelt IS the isolation, so the probe runs Python under the same
      // profile the runner would build rather than under a jail that merely resembles it.
      ? await runSeatbelt(program, {
        ...opts,
        command: [spec.runtime || "python3", "-"],
        timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      })
      : bwrap
      ? await runBwrap(program, {
        command: [spec.runtime || "python3", "-"],
        ...(opts.bwrap ?? {}),
        timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      })
      // `confine` carried from the SPEC, so the probe runs in the jail the record describes rather
      // than in an unconfined one that would pass for it.
      : await runCode(program, {
        ...opts,
        ...(spec.confiner === "bubblewrap" || spec.confiner === "sandbox-exec" ? { confine: spec.confiner } : {}),
        timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      });

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
