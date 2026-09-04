# Architecture: confining the filesystem, per platform

> Status: BUILT and package T is CLOSED. Phases 1, 3 and 4 shipped 2026-08-06; 2 REJECTED; 5 is a
> posture. Phase 4's macOS run EXECUTED later the same day on a real Mac (macOS 26.4.1, Deno 2.9.5,
> arm64): the full `deno task test:extensions` suite passed, darwin-gated case included, with the
> machine's own Deno cache verified untouched afterwards. Still never run in this repo's CI, which
> is the one residual and is a coverage gap rather than an open defect. Renamed from
> `plan-jail-confinement.md` on 2026-08-30, under the lifecycle rule in CLAUDE.md, because the
> `plan-` name read as unfinished work to every external reviewer: the phase
> numbers are kept because source files cite them. The defect it closed is package T in
> [plan-audit-remediation.md](plan-audit-remediation.md).
>
> **The jail is one backend, not the mechanism.** A sandbox is a RECORD
> ([design-execution.md](design-execution.md)), so the confinement property lives on the record
> (`SandboxSpec.importsConfined`) rather than in a language's name: `denoSandbox` carries false,
> `bwrapSandbox` carries true, and `probeSandbox` breaks out of any spec claiming a confinement it
> does not have. Adding a backend is a record and a probe, not a redesign. Read that before reading
> this as "the Deno jail is the isolation story".
>
> Everything below marked "measured" was run against the real jail on Linux, except phase 4:
> `sandbox-exec` was verified on a real Mac 2026-08-06 (macOS 26.4.1, Deno 2.9.5, arm64). Read
> [design-execution.md](design-execution.md) first: the language question is an isolation question,
> and this is the isolation half.

## Contents
- The one hole, and why that simplifies the fix
- What was measured
- A second finding: the jail obeys its prisoner's config
- The shape: a confiner is not a runtime
- Phases
- Open questions

## The one hole, and why that simplifies the fix

The Deno jail already denies net, env, run, ffi and write. MODULE LOADING is the only channel its
read permission does not cover (neither `--allow-read` nor `--deny-read` gates it, measured in
[plan-executors.md](plan-executors.md)), so the missing piece is filesystem confinement and nothing else.
That is what makes this compositional: keep the permission jail exactly as it is, and add a
filesystem boundary underneath it, chosen per platform. The alternative reading, "replace the Deno
jail with bubblewrap", is both bigger and wrong, because it throws away a permission model that is
safe by ABSENCE and replaces it with one that is safe by presence.

## What was measured

**Filesystem-only bubblewrap is sufficient, and cheaper than the jail we ship.**

| variant | import blocked | time |
|-------------------------------------------|-----|-------|
| `--unshare-all` (today's `bwrapArgs`)      | yes | 65ms  |
| mount namespace only, net left alone       | yes | 34ms  |
| plus `--unshare-pid/ipc/uts/cgroup`        | yes | 32ms  |

Dropping `--unshare-net` matters beyond the 30ms: that is the flag that fails on hosted CI
(`bwrap: loopback: Failed RTM_NEWADDR`, gotchas.md), so the confining variant is likely to run
where today's bubblewrap backend cannot. Net stays denied by Deno's own flags, which is the
safe-by-absence direction rather than the safe-by-presence one.

**The vector is decided by EXTENSION, not by content.**

| file    | content         | `import(…, { with: { type: "json" } })` |
|---------|-----------------|------------------------------------------|
| `a.json`| JSON            | REACHED                                   |
| `b.key` | identical JSON  | refused: "Expected a Json module"         |
| `c.txt` | base64 text     | refused                                   |
| `e.bin` | raw bytes       | refused                                   |

Deno will not parse a non-`.json` file as JSON however it is asked. This BOUNDS the vector, which
is why it is recorded: the hole reaches JSON and code, not arbitrary bytes, so a non-module secret
is unreadable through it today.

It is NOT a mitigation, and was rejected as one (phase 2 below). The bound is a property of Deno's
file-type resolution rather than of the jail, so it holds until an upstream release decides
otherwise, and nothing would tell us when that happened.

## A second finding: the jail obeys its prisoner's config

The jail's cwd is the model-written tree, and Deno discovers `deno.json` from cwd. A workspace that
ships one gets its import map honoured:

```
as shipped         MAP HONOURED {"kek":"KEY"}
with --no-config   map not used: Import "sneaky" not a dependency
```

A sandbox must never take configuration from the code it is sandboxing. This is independent of
module loading, cheaper to fix than any of it, and closed by one flag on every platform.

## The shape: a confiner is not a runtime

`SandboxSpec.isolation` currently conflates two questions: which permission model runs the code, and
what bounds its filesystem. They are independent, and the fix needs them apart:

```ts
isolation: "deno-permissions"                       // what RUNS the code, unchanged
confiner: "none" | "bubblewrap" | "sandbox-exec"    // what BOUNDS the filesystem
importsConfined                                     // derived from the confiner, still probed
```

Selection follows the rule this codebase already uses: a runner publishes only what PROBES clean,
and the record names which jail a result was reached in. So a machine with a confiner serves the
confined sandbox, a machine without it serves the unconfined one and says so, and a policy can bind
`importsConfined: true` when it cares. That is the fallback posture rather than refusing to run
JavaScript at all, because refusing breaks macOS and CI today for a hole that has existed all along.

One trap for whoever builds it: `probeSandbox` picks its probe LANGUAGE from `isolation`
(bubblewrap implies Python), which is the backend/language conflation design-execution.md warns
about. A bubblewrap-confined DENO jail is the first spec where the two differ, so the probe has to
learn the difference before it can verify one.

## Phases

Ordered cheapest first. Phase 1 is worth doing whatever happens to the rest; phase 2 is kept as a
REJECTED option, because it reads like an obvious cheap win and is not.

**1. BUILT (2026-08-06): the jail stops reading its prisoner's configuration.** `--no-config`,
`--no-lock` and `--no-npm` in `jailArgs`, so every Deno spawn gets them (`runCode`, `runEntry`, the
broker). Guarded by "the jail does not read configuration written by its prisoner" in
`extensions/conformance/workspace.test.ts`, which drives a real tree-local `deno.json` and also
asserts the flag list, since a refactor is how one of these goes missing. Plant: removing the flags
restores `MAP HONOURED`.
`--no-npm` was not in the original phase and earned its way in: `npm:` was already unreachable, but
ACCIDENTALLY, failing on an env permission (`TF_BUILD`) before it ever tried to resolve. That is a
block that disappears the day Deno stops reading that variable, and the runner's tool description
has always promised "no npm". `jsr:` was already covered by `--no-remote`.
The cost, such as it is: an import map inside a workspace stops working, loudly ("Import X not a
dependency"). Nothing in the jail can fetch anything, so a map there had no legitimate use.

**2. REJECTED (2026-08-06): renaming Radia's own secrets off `.json`.** Proposed when macOS had no
confiner and this looked like the only portable protection. Two reasons it is not worth doing now
that phases 3 and 4 are both real:

- **It is not a guarantee, it is an upstream behaviour.** The protection is Deno declining to parse
  a non-`.json` file as JSON. That is a file-type heuristic, not a boundary: a release that adds
  content sniffing, or a second runtime with a different table, removes the protection silently and
  no probe here would notice. A security property nothing can verify is one nobody should rely on.
- **The cost is permanent and the benefit was temporary.** The KEK and the credentials file are read
  by name from the CLI, the MCP adapter and the Python SDK, so this is a compatibility shim (read
  the old name, write the new one) that outlives the problem it was working around.

It also never protected the operator's OTHER json (browser `logins.json`, assorted
`~/.config/**/*.json`), so it narrowed our blast radius without closing the hole. A confiner closes
it for every file at once, which is the thing to build.

**The residual, stated rather than discovered later:** on native Windows there is no confiner, so
this space's own secrets stay reachable there. Renaming would have hidden ours and left every other
JSON on that machine readable, which is a better-looking report rather than a safer jail. The honest
answers are the record saying `importsConfined: false`, and running under WSL2 instead (phase 5),
where the Linux confiner applies unchanged.

**3. BUILT (2026-08-06): filesystem-only bubblewrap on Linux.** `RunOptions.confine` wraps the
unchanged permission jail in a mount namespace (`sandbox.ts`), `SandboxSpec.confiner` records which
one bounds it, and the chat PREFERS the confined jail, falling back with the record naming what
actually ran. The broker takes it through `BrokerOptions.run.confine`, so a workspace agent's
entrypoint is confined on the same terms.
The probe trap is cleared: language now follows `spec.language`, spawn follows the backend, and an
unnamed language still defaults to the backend's runtime so existing bubblewrap specs keep their
Python probes. An existing guard caught the first attempt at that rule, which had turned
`language: "unknown"` into a JavaScript probe fed to a Python interpreter.
Three cases in `extensions/conformance/workspace.test.ts` (the confiner holds while net stays denied
by Deno's flags; a confined jail is probed in JavaScript and every claim holds; the records differ
and say which confiner), plus two in `smoke-runners.ts` asserting the chat serves the confined jail
and that the fallback does not pretend to be one.

**What building it taught, and it is the third time this session:** a component that needs a
temporary file cannot assume the system temp directory. The import probe writes a canary, the chat's
exec worker holds `--allow-write=<workspace root>` and nothing else, so the probe could not write,
correctly reported the claim UNVERIFIED, and confinement silently never happened. The failure was
right and the cause was invisible; `probeSandbox` takes a `scratchDir` now. The same shape produced
`bootRoot` in the broker and the empty-`--workspace-root` bug in `openTree`.

**4. BUILT (2026-08-06), and NOT executed by its author.** `sandboxExecProfile` builds the profile,
`RunOptions.confine: "sandbox-exec"` runs the jail under it, and `defaultConfiner()` picks by
platform so the chat reaches for Seatbelt on macOS and bubblewrap on Linux. Everything below was
verified by hand on a Mac first; the code is that verification transcribed.
**VERIFIED BY ITS OWN GUARD on a real Mac (2026-08-07, macOS 26.4.1 arm64):** "on macOS, the
Seatbelt profile actually closes the import hole" passes in 28ms. Until then only a hand-run session
had exercised it and the guard had never executed anywhere.

**The implementer was on Linux and could not run it.** So the tests split deliberately: the profile
BUILDER is a pure function checked on every platform (the dyld import is present, paths are
resolved through a real symlink, a path that could close an SBPL string is REFUSED rather than
escaped), while the case that actually runs a confined jail is gated on `Deno.build.os === "darwin"`
and skips elsewhere. The builder is where a regression would land; the run is where the guarantee
is, and only a Mac can report it. Three plants proved the pure cases (drop the dyld import, drop the
realpath, accept an injecting path).

**A Mac has now reported it (2026-08-06, same day).** `deno task test:extensions` on macOS 26.4.1: 109
passed, 0 failed, the darwin-gated case included ("the Seatbelt profile actually closes the import
hole", 28ms). The `HOME: "/tmp"` in `spawnDeno` also held up: jailed runs put Deno's own cache
churn under `/tmp/Library/Caches/deno` and the machine's real `~/Library/Caches/deno` was verified
untouched, which matters because the by-hand verification had corrupted it (see the trap below).

VERIFIED on a real Mac (macOS 26.4.1, Deno 2.9.5, arm64): the
module-loading hole reproduces there, and a filesystem-only SBPL profile closes it while
workspace-relative imports keep working. Overhead is ~6ms (bare jail 10.3ms median, confined
16.0ms). The "fiddly and version-sensitive" part has an Apple-maintained answer: a naive
deny-by-default-reads profile SIGABRTs every binary, because dyld's bootstrap (libignition) needs
`file-read*` on the literal `/` and `file-map-executable` on the cryptex graft points, and
`(import "dyld-support.sb")` supplies exactly that, revved by Apple with the OS. The working shape:

```scheme
(version 1)
(allow default)                     ; net/env/run/write stay denied by Deno's flags
(deny file-read*)
(import "dyld-support.sb")          ; dyld/libignition bootstrap, Apple-maintained
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System")
  (subpath "<deno binary dir>")
  (subpath "<workspace, realpath'd>")
  (subpath "/dev"))
```

Traps for the implementer, all hit during verification:
- Profile paths must be RESOLVED paths: the sandbox matches on vnodes, `/tmp` is a symlink to
  `/private/tmp`, so an un-realpath'd workspace path silently misses.
- `dyld-support.sb` is labeled Apple System Private Interface; importing it by name is still the
  right call, since the hardcoded-cryptex-paths alternative already broke during this test.
- The global `(allow file-read-metadata)` leaks file EXISTENCE everywhere. Acceptable, but weaker
  than bwrap's mount namespace, which hides everything; the sandbox record must say so.
- SBPL `(trace ...)` is dead on modern macOS; iterate via the crash reports in
  `~/Library/Logs/DiagnosticReports` instead.
- `DENO_DIR` is not needed under `--no-remote`; only the binary's own directory is.
- A confined child MUST get a cwd inside the profile's roots. It inherits the spawner's cwd
  otherwise, and Deno dies at startup on getcwd before any code runs; every probe then reports
  unverified and the worker silently falls back to the unconfined jail, which is how the first
  real exec-worker boot on a Mac ran unconfined while the conformance case (which passes a cwd)
  stayed green. `spawnDeno` now defaults the cwd to the Deno binary's directory.
- A cwd is NOT optional under `sandbox-exec`, unlike the other two backends. Guarded by "a confined
  jail with NO cwd still starts", macOS-gated, so it reports on a Mac rather than in CI: the failure
  is a jail that never starts, every probe claim then reads UNVERIFIED, and the worker falls back
  silently.
- `materialize` must write to the root it was GIVEN, never the resolved one: a caller's
  `--allow-write=<root>` names the literal path, and on macOS every temp dir sits behind a symlink.
  This broke every workspace run there, confined or not. Guarded by "materialising writes to the
  root it was GIVEN", which runs a real subprocess under that grant and FAILS ON LINUX TOO, because
  Deno checks the literal path on both platforms. A macOS-discovered bug with a cross-platform
  guard, which is the shape to aim for.
- The same symlink bites the CHILD's relative paths: the kernel reports the cwd RESOLVED, so a
  jailed `Deno.writeFile("out.bin")` in an output-tree cwd resolves to `/private/var/…` while
  `--allow-write` named `/var/…`, and was denied on a real Mac (2026-09-02, the broker
  verification). `jailArgs` therefore grants every root in BOTH spellings, `denyRead` included,
  because a deny naming one spelling leaves the file readable through the other.
- The profile above bounds READS ONLY, so a jailed Deno still WRITES its global caches
  (`~/Library/Caches/deno/*_cache_v2`, written regardless of `--no-remote`), and
  writable-but-unreadable SQLite corrupts them for the whole machine (`SQLITE_IOERR_SHORT_READ`
  522 on every later `deno` invocation; Deno's own recovery deletes the main db but not the
  `-wal`/`-shm` siblings, so it never heals). Happened during the by-hand verification, which
  inherited the real `$HOME`; recovery is deleting the full db triples. The built code avoids it
  by construction (`clearEnv` + `HOME: "/tmp"` in `spawnDeno` moves the churn to
  `/tmp/Library/Caches/deno`), so this trap now binds anyone running the profile by hand or
  changing that env line, not the shipped path.
  FIXED in the implementation: `RunOptions.cacheDir` gives a confined jail a directory it can BOTH
  read and write (the chat puts it under its workspace root), the Seatbelt profile read-allows it,
  and the bubblewrap jail points `DENO_DIR` inside its own tmpfs. With no writable directory
  available the cache is disabled rather than pointed at the host's, which is slower and safe.
  Guarded by "a confined jail's cache is READABLE as well as writable, or it corrupts".

**PYTHON RUNS EVERYWHERE THERE IS A CONFINER (was Linux-only until 2026-08-07).** `run_python` is
served where its jail PROBES CLEAN: bubblewrap on Linux, a Seatbelt profile on macOS. On a host with
neither, the language is ABSENT rather than broken, which is what the capability-name design is for.

Phase 4 does not carry over, and the reason is the whole point of the confiner/runtime split. The
Deno profile is `(allow default)` plus `(deny file-read*)`, and that is safe ONLY because Deno's
flags already deny net, env, run, ffi and write: the profile had one job, closing the single channel
the permission model missed. Python has no permission model, so the same profile around `python3` is
an interpreter with `(allow default)` — full network, full spawn, full write. A macOS Python jail
would need `(deny default)` with an explicit allowlist across reads, writes, network, process-exec,
mach lookups and sysctls: a different kind of profile, in exactly the territory where one reads
correctly and is not. On Linux bwrap covers every axis with one flag set, which is the asymmetry.

**MEASURED 2026-08-07 on macOS 26.4.1 (arm64, CLT python 3.9.6), and the prediction was half right.**
A strict profile DOES confine Python: it starts, imports the stdlib, reads its own tree and runs an
entrypoint, while a path outside the tree, the network, `subprocess` and writes outside are all
refused. So "not feasible" is not the reason to keep Python on Linux; the reason is what it took.

Five traps, none of them guessable, all hit in one session:

- `/usr/bin/python3` IS THE XCRUN SHIM, not the interpreter, and it needs `$TMPDIR/xcrun_db`, which
  a read-bounding profile denies: every run dies before Python starts. A runner must resolve to the
  real interpreter (`os.path.realpath(sys.executable)`).
- Paths must be RESOLVED, the same trap as phase 4's, hit again by the same author who wrote it down.
- `file-map-executable` is needed on the framework, SEPARATELY from `file-read*`, or every C
  extension in the stdlib fails to import.
- The framework interpreter RE-EXECS ITSELF through `Resources/Python.app`, so `(deny process-exec*)`
  kills startup. Exec has to be allowed for the framework subpath, which also means the confinement
  against spawning is "nothing outside this framework" rather than "nothing".
- `sys.path[0]` is `''`, meaning the CWD, which Python stats on every import. A cwd outside the
  allowlist fails every import with a bare `PermissionError`. Same class as phase 4's cwd bug.

Also measured: `(deny file-write*)` blocks writing INSIDE the tree too, so a write-back run would
need its own allow. And the paths above are specific to CLT's framework layout; a Homebrew
`python3.12` is the same shape with different paths, unverified.

**DECISION REVERSED, and BUILT (2026-08-07). Python runs on macOS, confined.**
`seatbeltPythonProfile` + `runSeatbelt` + `seatbeltPythonSandbox` in `extensions/ts/sandbox.ts`; the
chat picks the jail by platform and probes it like any other. Verified on the Mac: the confinement
case passes, and the whole matrix holds (it reads its tree and imports the stdlib, while a path
outside, the network, `subprocess` and outside writes are all refused).

What changed the answer was reading prior art (mindsdb/vsbox) instead of grinding the profile out.
The structural lesson is the one worth keeping, because the first attempt had it backwards:

**A Python profile must `(deny default)`; the Deno one must not.** `(allow default)` plus targeted
denies is right for Deno ONLY because its flags already deny net, env, run, ffi and write, leaving
the profile one job. Carrying that shape to Python passes every axis anyone thinks to test and
leaves the rest (mach lookups, sysctl, IPC, ptrace) open. Deny-default also means the network is
refused with NO line saying so, which is why the guard asserts the ABSENCE of an allow.

Taken from vsbox: the operation list CPython needs to boot under deny-default (`process-fork`,
`signal`, `sysctl-read`, `mach-lookup`/`register`, the POSIX shm quartet). NOT taken: their
`(allow network-outbound)`, since their threat model is a venv's filesystem rather than untrusted
code; their venv wrapper; and their `sys.addaudithook` guard, which their own README says C
extensions bypass, making it the same non-boundary as a textual ban on `import`.

Of the five traps predicted earlier, four were real and one was not: `file-map-executable` turned out
to be UNNECESSARY, and had been covering for the cwd bug. vsbox omits it, which is how the
discrepancy got noticed. The `(trace)` being dead matters more under deny-default than anywhere
else, because a broken profile then denies its own error path: the failure is empty output and an
exit code worth nothing.

**5. Windows: WSL2 is the supported path, and native Windows says it is unconfined.**

WSL2 is not a new platform to support. It IS Linux: Deno reports `Deno.build.os === "linux"`, so
`defaultConfiner()` already returns `bubblewrap`, the probe already verifies it, and the record
already says `confiner: "bubblewrap"`. There is nothing to build, which is the whole reason to
prefer it over a Windows-native confiner: AppContainer or a restricted token would need a helper
binary, and that is a dependency this project would rather not carry for one platform.

NOT VERIFIED. Nobody has run it, which is exactly where macOS stood before someone did, and that
run turned up two bugs that "should work" had not predicted. One `deno task test:extensions` under WSL2
settles it. The failure mode is safe either way: the confined cases skip, the worker prints
UNCONFINED at boot, and the record says `importsConfined: false`, so a WSL2 that cannot run
bubblewrap is reported rather than assumed. WSL**1** has no real kernel and degrades down the same
path.
One nuance worth stating, because it decides which answer you get: it is the LINUX `deno` inside
WSL that reports `linux`. Running `deno.exe` from a WSL shell is still Windows, and still
unconfined.

**Native Windows keeps the honest posture**: no confiner, `importsConfined: false`, and the boot
line says so. Declaring WSL2 the supported path changes the RECOMMENDATION, not the behaviour: a
native Windows host still runs code, still runs it unconfined, and its own secrets stay reachable
from the jail (see the residual under phase 2). Saying "only WSL2 is supported" is not a mechanism,
and a doc that implied otherwise would be the same class of claim as a sandbox record that overstates
its jail.

That distinction is what package T's closure rests on, so keep the two halves apart. The SUPPORT
POLICY is why it is no longer an open defect: native Windows is not a platform this project ships
for (`scripts/build-release.sh` builds four targets and none of them is Windows), and an unsupported
platform cannot hold a package open. The MECHANISM is unchanged and is stated by the record and the
boot line, not by the ledger. If native Windows ever becomes supported, the package reopens and the
work is a confiner for it, not a rewording here.

**BUILT (2026-08-07), and NOT a Windows question: `--require-confinement`.** The exec worker refuses
to serve at all when no confiner holds. The temptation was to special-case Windows, but the same gap
exists on a Linux box with no bubblewrap and on a Mac whose profile fails; Windows is only the
platform where the answer is always no. This is the enforcement half that makes `importsConfined`
actionable.
Default OFF, because an unconfined jail is what every host had until the confiners existed and
turning it off silently would break working setups. Forwarded by `fleet.ts` from
`RADIA_CHAT_REQUIRE_CONFINEMENT`, so it is the operator's call and the worker is the only thing that
has to find out whether a confiner actually holds.
`radia host` carries the same flag since 2026-09-02 and goes one step further: it TRIES the
confiner by default (`selectJavascriptJail`), so the fallback to the plain jail is the loud
exception rather than the silent posture the deployment surface shipped with.

`--require-confinement` refuses EVERYTHING rather than declining one tool: a procedure is code
execution too, so serving those while withholding `run_javascript` would honour the letter of the
flag and none of its intent. Guarded in `smoke-runners.ts`, with the failing condition made
honestly (a worker launched `--allow-run=deno` cannot spawn `bwrap`, so nothing can confine however
capable the host is). The guard is BOUNDED on purpose: the regression it exists for is a flag that
is read and never acted on, and that shape leaves the worker RUNNING, so waiting on it would hang
the suite rather than fail it. Planted, it fails in 20s saying "the flag was read and ignored".

**BUILT (2026-09-02), verified on the Mac it waited for: the broker's Seatbelt spawn.**
`runBrokered` grew both macOS branches: the Deno jail under `sandboxExecProfile` (the shared
per-process `jailCacheDir` in both the profile and `DENO_DIR`; the cwd is always set here, so the
getcwd trap cannot bite) and Python under `seatbeltPythonProfile` (`isolation: "sandbox-exec"`:
Seatbelt IS the isolation there). The FIFO pair needs nothing new: a FIFO is only
file-read/file-write and the control dir rides the same root lists as under bwrap. Off macOS a
`sandbox-exec` spec is still refused, never downgraded. Shipped under this plan's own rule: the
darwin-gated "Seatbelt confiner is DELIVERED" case was proven RED against a weakened profile (deny
dropped, canary REACHED) before it passed, the brokered-Python case runs beside it, `radia host`
now hands Seatbelt to brokered bindings (its "no Seatbelt spawn" warning and refusal are deleted),
and `deno task test:extensions` passes whole on macOS 26.4.1 (arm64, Deno 2.9.5). Verifying
surfaced two pre-existing defects, both fixed cross-platform: the literal-spelling permission
grants (the `jailArgs` bullet in phase 4's trap list) and the plain invoker's tail-only stderr
clip, which dropped "not brokered" under the Mac's longer stack frames (`clip` now lives in
`sandbox.ts` and both invokers share it).

## Open questions

1. **Does filesystem-only bwrap work on the CI runner? ANSWERED YES (2026-08-07).** On
   `ubuntu-24.04`, hosted, the confined cases RAN rather than skipped and passed: the confined jail
   closes the import hole (59ms), it is probed in JavaScript, and its cache lands where it was told.
   READ THE CAVEAT before citing this as "filesystem-only is more portable than the full jail". CI
   relaxes `kernel.apparmor_restrict_unprivileged_userns` first, and with that relaxation the FULL
   `--unshare-all` also works (the boot check passes). So this run measures "the confined jail works
   in CI" and does NOT isolate filesystem-only from full: the portability argument for dropping
   `--unshare-net` rests on the earlier failure and on reasoning, not on this run. A runner without
   the relaxation would settle it.
2. **ANSWERED (2026-08-06): `sandbox-exec` works.** Verified on macOS 26.4.1; see phase 4 for the
   profile, the measurement and the traps. The maintainability worry is largely retired by
   `(import "dyld-support.sb")`, which moves the version-sensitive part onto Apple.
3. **Should a confined jail be REQUIRED for anything?** Nothing requires it today. The natural first
   customer is the compartment story: a grant could bind `importsConfined: true` for work over
   protected data, which is a policy question for
   [architecture-workspace-agents.md](architecture-workspace-agents.md) rather than for this plan.
